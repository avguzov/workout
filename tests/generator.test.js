import { test, assert, equal, deepEqual, setReport } from './harness.js';
import { library, profiles, clone, runChain, simulateLog, dayIso, movement } from './helpers.js';
import {
  generateSession, reroll, validateSession, nextDayType, isEligible, slotAlternatives, makeRng,
} from '../js/engine/index.js';

const LENGTHS = [30, 40, 50, 60];
const PROFILE_IDS = ['full', 'no_bench', 'fixed_only'];

// ---------------------------------------------------------------- 5. generator matrix
const matrix = [];
const chains = {};
PROFILE_IDS.forEach((pid) => {
  LENGTHS.forEach((len) => {
    test('matrix: ' + pid + ' at ' + len + ' min, 25 sessions with 0 violations', () => {
      const { sessions, stats } = runChain({
        equipment: profiles[pid], lengthMin: len, count: 25, seedPrefix: 'matrix|' + pid + '|' + len,
      });
      chains[pid + '|' + len] = sessions;
      matrix.push({
        profile: pid, length_min: len, sessions: stats.sessions, violations: stats.violations,
        off_target: stats.off_target, forced_repeat: stats.forced_repeat, adjusted: stats.adjusted,
        over_length: stats.over_length, avg_min: stats.avg_min,
      });
      setReport('matrix', matrix);
      equal(stats.sessions, 25, 'sessions');
      equal(stats.violations, 0, 'violations ' + stats.messages.join(' | '));
      if (pid === 'full') equal(stats.off_target, 0, 'off_target under full');
    });
  });
});

test('matrix: 300 sessions in total, 0 violations', () => {
  const total = matrix.reduce((s, c) => s + c.sessions, 0);
  const v = matrix.reduce((s, c) => s + c.violations, 0);
  equal(total, 300, 'sessions');
  equal(v, 0, 'violations');
});

test('matrix: day types cycle push, hinge, pull and templates alternate', () => {
  const s = chains['full|60'];
  assert(s && s.length === 25, 'chain present');
  s.forEach((x, i) => equal(x.day_type, ['push', 'hinge', 'pull'][i % 3], 'session ' + i));
  equal(s[1].template_id, 'hinge-a');
  equal(s[4].template_id, 'hinge-b');
  equal(s[7].template_id, 'hinge-a');
  equal(s[2].template_id, 'pull-a');
  equal(s[5].template_id, 'pull-b');
  equal(nextDayType(s, library), 'hinge');
});

test('hard case: no_bench Single-Arm Floor Press at 30 lb runs in a valid block without off_target', () => {
  let found = 0;
  LENGTHS.forEach((len) => {
    const chain = chains['no_bench|' + len];
    chain.forEach((s) => s.blocks.forEach((b) => {
      const it = b.items.find((x) => x.movement_id === 'single-arm-floor-press' && x.recommendation.basis === 'first_time');
      if (!it) return;
      found += 1;
      assert(b.items.every((x) => !x.off_target), 'off_target next to Single-Arm Floor Press in ' + s.id);
      assert(it.load.weight_lb_per_dumbbell === 30 || (it.adjusted && it.load.weight_lb_per_dumbbell === 35), 'runs at 30 (or 35 adjusted)');
    }));
  });
  assert(found >= 1, 'Single-Arm Floor Press appeared at its first-time 30 lb');
  // and the press pool under no_bench is the three floor presses
  const pool = library.movements.filter((m) => isEligible(m, ['heavy_press'], profiles.no_bench)).map((m) => m.id).sort();
  deepEqual(pool, ['close-grip-db-floor-press', 'db-floor-press', 'single-arm-floor-press']);
});

test('no_bench pools: heavy press, triceps, and chest accessory each have at least 3 eligible movements', () => {
  const sizes = {};
  ['heavy_press', 'triceps', 'chest_accessory', 'overhead_press'].forEach((role) => {
    sizes[role] = library.movements.filter((m) => isEligible(m, [role], profiles.no_bench)).length;
  });
  ['heavy_press', 'triceps', 'chest_accessory'].forEach((role) => assert(sizes[role] >= 3, role + ' pool under no_bench is ' + sizes[role]));
  assert(sizes.overhead_press >= 4, 'overhead_press pool under no_bench is ' + sizes.overhead_press);
});

// ---------------------------------------------------------------- 6. determinism and reroll
function baseChain(n) {
  const rng = makeRng('reroll-chain');
  const hist = [];
  for (let i = 0; i < n; i++) {
    hist.push(simulateLog(generateSession({ library, equipment: profiles.full, sessions: hist, lengthMin: 60, seed: 'rr|' + i, now: dayIso(i) }), rng, dayIso(i)));
  }
  return hist;
}
const rrHist = baseChain(3);
const rrArgs = { library, equipment: profiles.full, sessions: rrHist, lengthMin: 60, seed: 'determinism', now: dayIso(3) };

test('determinism: same inputs and seed give a deep-equal session', () => {
  const a = generateSession(rrArgs);
  const b = generateSession(Object.assign({}, rrArgs, { sessions: clone(rrHist) }));
  deepEqual(a, b);
  const c = generateSession(Object.assign({}, rrArgs, { seed: 'another seed' }));
  equal(c.day_type, a.day_type, 'seed does not change the day type');
});

function itemsOutside(session, pred) {
  const out = [];
  session.blocks.forEach((b) => b.items.forEach((it, si) => { if (!pred(b.block, si)) out.push(it); }));
  return out;
}

function checkReroll(scope, pred) {
  const before = generateSession(rrArgs);
  const after = reroll({ library, equipment: profiles.full, sessions: rrHist, session: before, scope, now: dayIso(3) });
  const v = validateSession({ library, equipment: profiles.full, sessions: rrHist, session: after });
  equal(v.length, 0, 'rerolled session validates: ' + v.map((x) => x.rule + ' ' + x.message).join(' | '));
  deepEqual(itemsOutside(after, pred), itemsOutside(before, pred), 'slots outside the scope untouched');
  let changed = 0;
  before.blocks.forEach((b, bi) => b.items.forEach((it, si) => {
    if (!pred(b.block, si)) return;
    const alts = slotAlternatives({ library, equipment: profiles.full, session: before, blockIndex: bi, slotIndex: si });
    const now = after.blocks[bi].items[si].movement_id;
    if (alts.length) {
      assert(now !== it.movement_id, 'slot ' + b.block + (si + 1) + ' should change (' + it.movement_id + ')');
      changed += 1;
    }
  }));
  equal(after.rerolls.count, 1, 'reroll count');
  equal(after.rerolls.history.length, 1, 'reroll history');
  deepEqual(after.rerolls.history[0].scope, scope, 'scope recorded');
  equal(after.rerolls.history[0].changes.length, before.blocks.reduce((s, b) => s + b.items.filter((x, si) => pred(b.block, si)).length, 0), 'one change entry per scoped slot');
  equal(after.id, before.id, 'id kept');
  equal(after.day_type, before.day_type);
  equal(after.template_id, before.template_id);
  // deterministic
  deepEqual(reroll({ library, equipment: profiles.full, sessions: rrHist, session: before, scope, now: dayIso(3) }), after, 'reroll is deterministic');
  return { before, after, changed };
}

test('reroll slot: only Block A slot 2 changes and the session still validates', () => {
  const r = checkReroll({ type: 'slot', block: 'A', slot: 1 }, (blk, si) => blk === 'A' && si === 1);
  equal(r.changed, 1);
});

test('reroll block: every Block B slot changes, nothing else does', () => {
  const r = checkReroll({ type: 'block', block: 'B' }, (blk) => blk === 'B');
  equal(r.changed, 3);
});

test('reroll session: all nine slots change and the session still validates', () => {
  const r = checkReroll({ type: 'session' }, () => true);
  equal(r.changed, 9);
});

test('reroll twice: second reroll is recorded and still validates', () => {
  const s0 = generateSession(rrArgs);
  const s1 = reroll({ library, equipment: profiles.full, sessions: rrHist, session: s0, scope: { type: 'slot', block: 'C', slot: 2 }, now: dayIso(3) });
  const s2 = reroll({ library, equipment: profiles.full, sessions: rrHist, session: s1, scope: { type: 'slot', block: 'C', slot: 2 }, now: dayIso(3) });
  equal(s2.rerolls.count, 2);
  assert(s2.blocks[2].items[2].movement_id !== s1.blocks[2].items[2].movement_id, 'changed again');
  equal(validateSession({ library, equipment: profiles.full, sessions: rrHist, session: s2 }).length, 0);
});

// ---------------------------------------------------------------- 7. coverage
test('coverage: 36 sessions under full at 60 min use every eligible movement', () => {
  const { sessions, stats } = runChain({ equipment: profiles.full, lengthMin: 60, count: 36, seedPrefix: 'coverage' });
  equal(stats.violations, 0, 'violations ' + stats.messages.join(' | '));
  const eligible = library.movements.filter((m) => library.slot_templates.some((t) => t.blocks.some((b) =>
    b.slots.some((s) => isEligible(m, s.roles, profiles.full))))).map((m) => m.id);
  const seen = new Map();
  sessions.forEach((s) => s.blocks.forEach((b) => { if (b.rounds > 0) b.items.forEach((it) => seen.set(it.movement_id, (seen.get(it.movement_id) || 0) + 1)); }));
  const missing = eligible.filter((id) => !seen.has(id));
  // Block A roles: appearances and mean gap (in sessions) per movement
  const aRoles = [];
  library.slot_templates.forEach((t) => t.blocks.filter((b) => b.block === 'A').forEach((b) =>
    b.slots.forEach((s) => s.roles.forEach((r) => { if (aRoles.indexOf(r) < 0) aRoles.push(r); }))));
  const roles = aRoles.map((role) => {
    const at = new Map();
    sessions.forEach((s, i) => {
      const t = library.slot_templates.find((x) => x.id === s.template_id);
      const bi = t.blocks.findIndex((b) => b.block === 'A');
      s.blocks[bi].items.forEach((it, si) => {
        if (t.blocks[bi].slots[si].roles.indexOf(role) < 0) return;
        if (!at.has(it.movement_id)) at.set(it.movement_id, []);
        at.get(it.movement_id).push(i);
      });
    });
    const pool = library.movements.filter((m) => m.roles.indexOf(role) >= 0 && isEligible(m, [role], profiles.full)).map((m) => m.id);
    const movements = pool.map((id) => {
      const idx = at.get(id) || [];
      let gap = null;
      if (idx.length > 1) gap = Math.round(((idx[idx.length - 1] - idx[0]) / (idx.length - 1)) * 10) / 10;
      return { id, count: idx.length, mean_gap: gap };
    }).sort((a, b) => b.count - a.count);
    return { role, movements };
  });
  setReport('coverage', {
    profile: 'full', length_min: 60, sessions: sessions.length,
    movements_eligible: eligible.length, movements_seen: eligible.length - missing.length, missing, roles,
  });
  equal(sessions.length, 36);
  deepEqual(missing, [], 'movements never picked');
});

// ---------------------------------------------------------------- 8. autoPickSwaps false
function swapsOnlyWhereEmpty(lib, equipment, sessions) {
  let swaps = 0;
  sessions.forEach((s) => s.blocks.forEach((b, bi) => b.items.forEach((it, si) => {
    const mv = lib.movements.find((m) => m.id === it.movement_id);
    if (mv.in_draft_rotation) return;
    swaps += 1;
    const alts = slotAlternatives({ library: lib, equipment, session: s, blockIndex: bi, slotIndex: si, inRotationOnly: true });
    assert(alts.length === 0, 'swap ' + it.movement_id + ' in ' + s.id + ' ' + b.block + (si + 1) + ' while ' + alts.join(',') + ' was free');
  })));
  return swaps;
}

test('autoPickSwaps false: no swaps while the in-rotation pool can fill the slot', () => {
  PROFILE_IDS.forEach((pid) => {
    const { sessions, stats } = runChain({ equipment: profiles[pid], lengthMin: 60, count: 12, seedPrefix: 'noswap|' + pid, autoPickSwaps: false });
    equal(stats.violations, 0, pid + ' violations ' + stats.messages.join(' | '));
    equal(swapsOnlyWhereEmpty(library, profiles[pid], sessions), 0, pid + ' swaps');
  });
  const on = runChain({ equipment: profiles.full, lengthMin: 60, count: 12, seedPrefix: 'noswap|full' });
  let swapsOn = 0;
  on.sessions.forEach((s) => s.blocks.forEach((b) => b.items.forEach((it) => { if (!movement(it.movement_id).in_draft_rotation) swapsOn += 1; })));
  assert(swapsOn > 0, 'with autoPickSwaps true the same chain does use swaps');
});

test('autoPickSwaps false: swaps fill a slot whose in-rotation pool is empty', () => {
  const lib = clone(library);
  // empty the no_bench in-rotation press pool; Single-Arm Floor Press is already a swap
  ['db-floor-press', 'close-grip-db-floor-press'].forEach((id) => { lib.movements.find((m) => m.id === id).in_draft_rotation = false; });
  const eq = profiles.no_bench;
  const { sessions, stats } = runChain({ lib, equipment: eq, lengthMin: 60, count: 9, seedPrefix: 'emptypool', autoPickSwaps: false });
  equal(stats.violations, 0, 'violations ' + stats.messages.join(' | '));
  const swaps = swapsOnlyWhereEmpty(lib, eq, sessions);
  assert(swaps >= 6, 'heavy_press slot filled by swaps (' + swaps + ')');
  sessions.forEach((s) => s.blocks.forEach((b) => b.items.forEach((it) => {
    const mv = lib.movements.find((m) => m.id === it.movement_id);
    if (!mv.in_draft_rotation) assert(mv.roles.indexOf('heavy_press') >= 0, 'only press slots use swaps, got ' + mv.id);
  })));
});

// The fixed_pair case was found in the 58-movement library. The five no-bench movements added
// 2026-11-11 give the solver enough options that no matrix chain needs a fixed_pair, so this case
// replays the same chain on that library.
const ADDED_2026_11 = ['standing-db-shoulder-press', 'standard-push-up', 'close-grip-db-floor-press', 'floor-skull-crusher', 'db-floor-fly'];
const lib58 = clone(library);
lib58.movements = lib58.movements.filter((m) => ADDED_2026_11.indexOf(m.id) < 0);

test('fixed_pair: full / 50 min session 20 (pull-a Block B, 58-movement library) runs the 30 lb curl on the 25 lb pair, target +2, not off_target', () => {
  equal(lib58.movements.length, 58, '58-movement library');
  const { sessions, stats } = runChain({ lib: lib58, equipment: profiles.full, lengthMin: 50, count: 21, seedPrefix: 'matrix|full|50' });
  equal(stats.violations, 0, 'violations ' + stats.messages.join(' | '));
  const s = sessions[20];
  equal(s.template_id, 'pull-a');
  const b = s.blocks[1];
  const it = b.items.find((x) => x.adjusted && x.adjusted.reason === 'fixed_pair');
  assert(it, 'Block B has a fixed_pair item: ' + b.items.map((x) => x.movement_id + '@' + x.load.weight_lb_per_dumbbell).join(', '));
  const mv = movement(it.movement_id);
  equal(it.recommendation.weight_lb_per_dumbbell, 30, 'recommended');
  equal(it.load.weight_lb_per_dumbbell, 25, 'runs on the fixed pair');
  equal(it.load.source, 'fixed');
  equal(it.target.value, Math.min(it.recommendation.target_value + 2, mv.target.max), 'target up by 2');
  equal(it.adjusted.rep_shift, it.target.value - it.recommendation.target_value);
  equal(it.adjusted.recommended_weight_lb, 30);
  equal(it.off_target, false);
  assert(b.items.every((x) => !x.off_target), 'no off_target in the block');
});
