import { test, assert, equal } from './harness.js';
import { library, profiles, clone, simulateLog, dayIso, movement, runChain } from './helpers.js';
import {
  generateSession, validateSession, estimateSec, recommend, availableWeights, weightSource, makeRng,
} from '../js/engine/index.js';

const full = profiles.full;

function gen(sessions, opts) {
  const o = opts || {};
  return generateSession({
    library: o.library || library, equipment: o.equipment || full, sessions, lengthMin: o.lengthMin || 60,
    seed: o.seed || 'validator-negatives', now: dayIso(sessions.length), autoPickSwaps: o.autoPickSwaps,
  });
}

// push, hinge, pull, push history (all completed) for the cases that need one
const rng = makeRng('validator-log');
const history = [];
for (let i = 0; i < 3; i++) history.push(simulateLog(gen(history), rng, dayIso(i)));
const push1 = history[0];
const hinge1 = history[1];
const push2 = gen(history);

function rulesOf(session, sessions, equipment, lib) {
  return validateSession({ library: lib || library, equipment: equipment || full, sessions, session }).map((v) => v.rule);
}

function caught(rule, session, sessions, equipment, lib) {
  const rules = rulesOf(session, sessions, equipment, lib);
  assert(rules.indexOf(rule) >= 0, 'expected rule ' + rule + ', got [' + rules.join(', ') + ']');
}

function setMovement(item, id, equipment, sessions) {
  const mv = movement(id);
  const r = recommend({ library, equipment: equipment || full, sessions: sessions || [], movement: mv });
  item.movement_id = id;
  item.target = { unit: mv.target.unit, value: r.target_value, per_side: mv.target.per_side };
  item.load = { source: weightSource(r.weight_lb_per_dumbbell, equipment || full), weight_lb_per_dumbbell: r.weight_lb_per_dumbbell, dumbbells: mv.load.dumbbells };
  item.recommendation = { basis: r.basis, weight_lb_per_dumbbell: r.weight_lb_per_dumbbell, target_value: r.target_value, suggest_variation: null, last: r.last };
  item.adjusted = null;
  item.off_target = false;
  item.forced_repeat = false;
}

test('validator: unmodified generated sessions have no violations', () => {
  equal(rulesOf(push1, []).length, 0, 'push1: ' + rulesOf(push1, []).join(','));
  equal(rulesOf(hinge1, [push1]).length, 0, 'hinge1');
  equal(rulesOf(push2, history).length, 0, 'push2: ' + rulesOf(push2, history).join(','));
});

test('validator negative: day_type_order (push after push)', () => {
  caught('day_type_order', clone(push2), [push1]);
});

test('validator negative: structure (Block A planned for 3 rounds)', () => {
  const s = clone(push1);
  s.blocks[0].planned_rounds = 3;
  caught('structure', s, []);
});

test('validator negative: estimate (estimate_sec off by 60)', () => {
  const s = clone(push1);
  s.estimate_sec += 60;
  caught('estimate', s, []);
});

test('validator negative: trims (Block C trimmed while under length)', () => {
  const s = clone(push1);
  s.blocks[2].rounds = 2;
  s.trims = [{ step: 'block_c_2_rounds', block: 'C', from_rounds: 3, to_rounds: 2 }];
  s.estimate_sec = estimateSec(library, s);
  caught('trims', s, []);
});

test('validator negative: finisher_presence (push day without finisher)', () => {
  const s = clone(push1);
  s.finisher = null;
  s.estimate_sec = estimateSec(library, s);
  caught('finisher_presence', s, []);
  const h = clone(hinge1);
  h.finisher = { id: 'A', weight_lb_per_dumbbell: 25, done: null };
  caught('finisher_presence', h, [push1]);
});

test('validator negative: role_eligibility (bench press under no_bench, goblet squat as a press)', () => {
  const s = clone(push1);
  setMovement(s.blocks[0].items[0], 'db-bench-press');
  caught('role_eligibility', s, [], profiles.no_bench);
  const t = clone(push1);
  setMovement(t.blocks[0].items[0], 'goblet-squat');
  caught('role_eligibility', t, []);
});

test('validator negative: patterns (no core movement in the plan)', () => {
  const lib = clone(library);
  const coreItem = push1.blocks[2].items[2].movement_id;
  lib.movements.find((m) => m.id === coreItem).patterns = ['carry'];
  caught('patterns', clone(push1), [], full, lib);
});

test('validator negative: duplicate (same core movement in B and C)', () => {
  const s = clone(hinge1);
  const b3 = s.blocks[1].items[2];
  s.blocks[2].items[2] = Object.assign(clone(b3), { slot: 2 });
  caught('duplicate', s, [push1]);
});

test('validator negative: repeat (last push session movement, not forced)', () => {
  const s = clone(push2);
  setMovement(s.blocks[0].items[0], push1.blocks[0].items[0].movement_id, full, history);
  caught('repeat', s, history);
  const t = clone(push2);
  setMovement(t.blocks[0].items[0], push1.blocks[0].items[0].movement_id, full, history);
  t.blocks[0].items[0].forced_repeat = true;
  caught('repeat', t, history);
});

test('validator negative: per_side (three per-side lifts in Block A)', () => {
  const s = clone(push1);
  setMovement(s.blocks[0].items[0], 'single-arm-db-bench-press');
  setMovement(s.blocks[0].items[1], '1-arm-db-row');
  setMovement(s.blocks[0].items[2], 'bulgarian-split-squat');
  caught('per_side', s, []);
});

test('validator negative: adjustable_setting (block setting does not match its items)', () => {
  const hasAdj = (x) => x.blocks.some((b) => b.items.some((it) => it.load.source === 'adjustable'));
  const pick = [[push1, []], [hinge1, [push1]], [history[2], history.slice(0, 2)], [push2, history]].find((p) => hasAdj(p[0]));
  assert(pick, 'a generated session uses the adjustable');
  const s = clone(pick[0]);
  const b = s.blocks.find((x) => x.items.some((it) => it.load.source === 'adjustable'));
  b.adjustable_setting_lb = b.adjustable_setting_lb === 35 ? 40 : 35;
  caught('adjustable_setting', s, pick[1]);
  const t = clone(pick[0]);
  const plain = t.blocks.find((x) => x.items.every((it) => it.load.source !== 'adjustable'));
  if (plain) {
    plain.adjustable_setting_lb = 45;
    caught('adjustable_setting', t, pick[1]);
  }
});

test('validator negative: weight_available (27 lb does not exist)', () => {
  const s = clone(push1);
  const it = s.blocks[1].items[2];
  it.load.weight_lb_per_dumbbell = 27;
  caught('weight_available', s, []);
});

test('validator negative: weight_fidelity (two steps light; one step light with reps cut)', () => {
  const s = clone(push1);
  const it = s.blocks[1].items[2];
  const mv = movement(it.movement_id);
  const avail = availableWeights(mv, full);
  const i = avail.indexOf(it.load.weight_lb_per_dumbbell);
  assert(i >= 2, 'biceps item has room to go two steps down');
  it.load.weight_lb_per_dumbbell = avail[i - 2];
  it.load.source = weightSource(avail[i - 2], full);
  caught('weight_fidelity', s, []);
  const t = clone(push1);
  const it2 = t.blocks[1].items[2];
  it2.load.weight_lb_per_dumbbell = avail[i - 1];
  it2.load.source = weightSource(avail[i - 1], full);
  it2.target.value = Math.max(mv.target.min, it2.target.value - 2);
  it2.adjusted = { reason: 'block_setting', recommended_weight_lb: avail[i], rep_shift: -2 };
  caught('weight_fidelity', t, []);
});

test('validator negative: finisher_rules (fallback B while others are eligible; wrong weight)', () => {
  const s = clone(push1);
  s.finisher = { id: 'B', weight_lb_per_dumbbell: null, done: null };
  s.estimate_sec = estimateSec(library, s);
  caught('finisher_rules', s, []);
  const t = clone(push1);
  t.finisher.weight_lb_per_dumbbell = 7;
  caught('finisher_rules', t, []);
});

test('validator negative: swaps (swap picked with autoPickSwaps off while in-rotation core is free)', () => {
  const base = gen([], { autoPickSwaps: false, seed: 'swaps-neg' });
  equal(rulesOf(base, []).length, 0, 'base: ' + rulesOf(base, []).join(','));
  const s = clone(base);
  setMovement(s.blocks[2].items[2], 'bear-hold');
  caught('swaps', s, []);
});

test('validator negative: weight_fidelity on a fixed_pair item (two steps off; shift in the wrong direction)', () => {
  let found = null;
  runChain({ equipment: full, lengthMin: 50, count: 21, seedPrefix: 'matrix|full|50', onSession: (s, i, hist) => {
    s.blocks.forEach((b, bi) => b.items.forEach((it, si) => {
      if (!found && it.adjusted && it.adjusted.reason === 'fixed_pair') found = { s, hist, bi, si };
    }));
  } });
  assert(found, 'the full / 50 min chain produces a fixed_pair item');
  equal(rulesOf(found.s, found.hist).length, 0, 'unmodified fixed_pair session validates');
  const it0 = found.s.blocks[found.bi].items[found.si];
  const avail = availableWeights(movement(it0.movement_id), full);
  const i = avail.indexOf(it0.load.weight_lb_per_dumbbell);
  const two = clone(found.s);
  const a = two.blocks[found.bi].items[found.si];
  a.load.weight_lb_per_dumbbell = avail[i - 1];
  a.load.source = weightSource(avail[i - 1], full);
  caught('weight_fidelity', two, found.hist);
  const wrong = clone(found.s);
  const b = wrong.blocks[found.bi].items[found.si];
  const mv = movement(b.movement_id);
  b.target.value = Math.max(mv.target.min, b.recommendation.target_value - 2);
  b.adjusted.rep_shift = b.target.value - b.recommendation.target_value;
  caught('weight_fidelity', wrong, found.hist);
});
