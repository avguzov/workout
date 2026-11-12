// Movement swaps (js/engine/swap.js): the same-muscle-group relation over the library, and
// swapCandidates / swapSlot on chained generated sessions under the three test profiles.

import { test, assert, equal, deepEqual, setReport } from './harness.js';
import { library, profiles, clone, runChain } from './helpers.js';
import {
  swapCandidates, swapSlot, musclePeers, sameMuscleGroup, validateSession, slotAlternatives,
  isEligible, reroll,
} from '../js/engine/index.js';

const byId = new Map(library.movements.map((m) => [m.id, m]));
const has = (m, key, v) => m[key].indexOf(v) >= 0;

function ids(session) {
  return session.blocks.map((b) => b.items.map((it) => it.movement_id));
}

// ------------------------------------------------------------------ the relation

test('swap groups: every movement has a muscle_group and the peer relation is symmetric over the library', () => {
  const bad = [];
  library.movements.forEach((m) => {
    if (typeof m.muscle_group !== 'string' || !m.muscle_group) bad.push(m.id + ' has no muscle_group');
    musclePeers(library, m.id).forEach((p) => {
      if (musclePeers(library, p).indexOf(m.id) < 0) bad.push(m.id + ' -> ' + p + ' is not symmetric');
      if (!sameMuscleGroup(m, byId.get(p))) bad.push(m.id + ' -> ' + p + ' not the same group');
    });
    if (musclePeers(library, m.id).indexOf(m.id) >= 0) bad.push(m.id + ' lists itself');
  });
  equal(bad.length, 0, bad.slice(0, 4).join('; '));
});

test('swap groups: triceps never offer biceps, a push never offers a pull, a hinge never offers a squat or lunge, core stays core', () => {
  const bad = [];
  let pairs = 0;
  library.movements.forEach((a) => musclePeers(library, a.id).forEach((pid) => {
    const b = byId.get(pid);
    pairs += 1;
    const onlyRole = (m, r) => has(m, 'roles', r) && m.roles.length === 1;
    if (onlyRole(a, 'triceps') && has(b, 'roles', 'biceps')) bad.push(a.id + ' offers ' + b.id);
    const pushOnly = (m) => has(m, 'patterns', 'push') && !has(m, 'patterns', 'pull');
    if (pushOnly(a) && has(b, 'patterns', 'pull')) bad.push(a.id + ' (push) offers ' + b.id + ' (pull)');
    if (has(a, 'patterns', 'pull') && !has(a, 'patterns', 'push') && pushOnly(b)) bad.push(a.id + ' (pull) offers ' + b.id + ' (push)');
    const legs = (m) => has(m, 'patterns', 'squat') || has(m, 'patterns', 'lunge');
    if (has(a, 'patterns', 'hinge') && legs(b) && !has(b, 'patterns', 'hinge')) bad.push(a.id + ' (hinge) offers ' + b.id);
    if (legs(a) && !has(a, 'patterns', 'hinge') && has(b, 'patterns', 'hinge')) bad.push(a.id + ' offers ' + b.id + ' (hinge)');
    if (has(a, 'patterns', 'core') !== has(b, 'patterns', 'core')) bad.push(a.id + ' and ' + b.id + ' differ on core');
  }));
  assert(pairs > 0, 'no peer pairs at all');
  equal(bad.length, 0, bad.slice(0, 4).join('; '));
});

// ------------------------------------------------------------------ chained sessions

const CHAINS = [
  { pid: 'full', lengthMin: 50, count: 24 },
  { pid: 'no_bench', lengthMin: 60, count: 21 },
  { pid: 'fixed_only', lengthMin: 40, count: 18 },
];
const totals = {};

function checkChain({ pid, lengthMin, count }) {
  const equipment = profiles[pid];
  const problems = [];
  const st = { sessions: 0, slots: 0, slots_with_candidates: 0, candidates: 0, swaps: 0, finisher_changes: 0, rejected: 0, deterministic: 0, reroll_after_swap: 0 };
  const note = (msg) => { if (problems.length < 8) problems.push(msg); };
  runChain({
    equipment, lengthMin, count, seedPrefix: 'swap|' + pid,
    onSession(session, i, history, v) {
      st.sessions += 1;
      if (v.length) { note('#' + i + ' generated session has violations ' + JSON.stringify(v[0])); return; }
      const frozen = JSON.stringify(session);
      const template = library.slot_templates.find((t) => t.id === session.template_id);
      const inSession = new Set(ids(session).flat());
      session.blocks.forEach((block, bi) => block.items.forEach((item, si) => {
        st.slots += 1;
        const where = '#' + i + ' ' + block.block + (si + 1) + ' ' + item.movement_id;
        const base = { library, equipment, sessions: history, session, blockIndex: bi, slotIndex: si };
        const cands = swapCandidates(base);
        if (cands.length) st.slots_with_candidates += 1;
        st.candidates += cands.length;
        const cur = byId.get(item.movement_id);
        const roles = template.blocks[bi].slots[si].roles;
        cands.forEach((cid, k) => {
          const mv = byId.get(cid);
          if (!sameMuscleGroup(mv, cur) || musclePeers(library, cur.id).indexOf(cid) < 0) note(where + ': ' + cid + ' is not a group peer');
          if (!isEligible(mv, roles, equipment)) note(where + ': ' + cid + ' is not eligible');
          if (inSession.has(cid)) note(where + ': ' + cid + ' is already in the session');
          const out = swapSlot(Object.assign({ movementId: cid, now: '2026-11-11T07:00:00.000Z' }, base));
          st.swaps += 1;
          const vv = validateSession({ library, equipment, sessions: history, session: out });
          if (vv.length) note(where + ' -> ' + cid + ': ' + vv[0].rule + ': ' + vv[0].message);
          const before = ids(session);
          const after = ids(out);
          before.forEach((row, b2) => row.forEach((id, s2) => {
            const want = b2 === bi && s2 === si ? cid : id;
            if (after[b2][s2] !== want) note(where + ' -> ' + cid + ': slot ' + b2 + ':' + s2 + ' is ' + after[b2][s2] + ', want ' + want);
          }));
          if ((out.finisher && out.finisher.id) !== (session.finisher && session.finisher.id)) st.finisher_changes += 1;
          const it = out.blocks[bi].items[si];
          const rec = out.rerolls.history[out.rerolls.history.length - 1];
          if (out.rerolls.count !== (session.rerolls.count + 1) || rec.scope.type !== 'swap' || rec.scope.block !== block.block ||
            rec.scope.slot !== si || JSON.stringify(rec.changes) !== JSON.stringify([{ block: block.block, slot: si, from: item.movement_id, to: cid }])) {
            note(where + ' -> ' + cid + ': swap record ' + JSON.stringify(rec));
          }
          if (it.reroll_excluded.indexOf(item.movement_id) < 0 || it.swapped_from !== item.movement_id) note(where + ' -> ' + cid + ': replaced movement not recorded on the item');
          if (k === 0) {
            deepEqual(swapSlot(Object.assign({ movementId: cid, now: '2026-11-11T07:00:00.000Z' }, base)), out, where + ' swapSlot deterministic');
            deepEqual(swapCandidates(base), cands, where + ' swapCandidates deterministic');
            st.deterministic += 1;
            // A slot shuffle right after the swap does not bring the replaced movement straight back
            const rr = reroll({ library, equipment, sessions: history, session: out, scope: { type: 'slot', block: block.block, slot: si }, now: '2026-11-11T07:00:00.000Z' });
            st.reroll_after_swap += 1;
            if (rr.blocks[bi].items[si].movement_id === item.movement_id &&
              slotAlternatives({ library, equipment, session: out, blockIndex: bi, slotIndex: si }).length > 0) {
              note(where + ' -> ' + cid + ': a shuffle brought ' + item.movement_id + ' straight back');
            }
          }
        });
        // Non-candidates are rejected: the movement itself, an unknown id, an off-group or
        // in-session movement that could otherwise fill the slot
        const others = library.movements.filter((m) => cands.indexOf(m.id) < 0 && m.roles.some((r) => roles.indexOf(r) >= 0))
          .map((m) => m.id).slice(0, 4);
        [item.movement_id, 'no-such-movement'].concat(others).forEach((bad) => {
          let threw = false;
          try { swapSlot(Object.assign({ movementId: bad, now: null }, base)); } catch (e) { threw = /not a swap candidate/.test(e.message); }
          if (!threw) note(where + ': swapSlot accepted non-candidate ' + bad);
          else st.rejected += 1;
        });
      }));
      if (JSON.stringify(session) !== frozen) note('#' + i + ' input session was mutated');
    },
  });
  totals[pid] = st;
  setReport('swaps', totals);
  equal(problems.length, 0, problems.join(' | '));
  assert(st.sessions === count && st.slots === count * 9, 'slots checked ' + st.slots);
  assert(st.slots_with_candidates > 0 && st.swaps > 0, 'no swaps exercised under ' + pid);
}

CHAINS.forEach((c) => {
  test('swaps (' + c.pid + ', ' + c.count + ' chained sessions at ' + c.lengthMin + ' min): every candidate is an eligible group peer not in the session; each swap validates, changes only its slot, is recorded, and is deterministic; non-candidates are rejected', () => {
    checkChain(c);
  });
});

test('swaps: at least 60 sessions checked across full, no_bench, and fixed_only', () => {
  const n = Object.values(totals).reduce((s, t) => s + t.sessions, 0);
  assert(n >= 60, 'only ' + n + ' sessions');
  equal(Object.keys(totals).sort().join(','), 'fixed_only,full,no_bench');
});

test('swapCandidates: least recently done first, then by name', () => {
  const { sessions } = runChain({ equipment: profiles.full, lengthMin: 50, count: 9, seedPrefix: 'swap-order' });
  const history = sessions.slice(0, 8);
  const s = clone(sessions[8]);
  s.completed_at = null;
  let checked = 0;
  s.blocks.forEach((b, bi) => b.items.forEach((it, si) => {
    const cands = swapCandidates({ library, equipment: profiles.full, sessions: history, session: s, blockIndex: bi, slotIndex: si });
    const last = (id) => {
      for (let k = history.length - 1; k >= 0; k--) {
        if (history[k].blocks.some((x) => x.rounds > 0 && x.items.some((y) => y.movement_id === id))) return k;
      }
      return -1;
    };
    for (let k = 1; k < cands.length; k++) {
      const a = cands[k - 1];
      const c = cands[k];
      const ok = last(a) < last(c) || (last(a) === last(c) && byId.get(a).name <= byId.get(c).name);
      assert(ok, b.block + (si + 1) + ': ' + a + ' before ' + c);
      checked += 1;
    }
  }));
  assert(checked > 0, 'no ordered pairs to check');
});
