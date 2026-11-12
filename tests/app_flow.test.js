// App session operations: generate, reroll, and length changes with app fields present, and the
// workout flow (rounds, rest, effort, finisher, end early) against the engine's volume and
// recommendation rules.

import { test, equal, assert, deepEqual } from './harness.js';
import { library, clone } from './helpers.js';
import { defaultDoc } from '../js/app/storage.js';
import * as W from '../js/app/flow.js';
import {
  validateSession, reroll, trimToLength, sessionVolume, lastPerformance, recommend, nextDayType,
} from '../js/engine/index.js';
import { swapCandidates } from '../js/engine/index.js';

const T0 = '2026-11-11T07:00:00.000Z';
const at = (sec) => new Date(Date.parse(T0) + sec * 1000).toISOString();

function freshDoc() {
  return defaultDoc(library);
}

function movementIds(s) {
  return s.blocks.map((b) => b.items.map((it) => it.movement_id).join(',')).join('|');
}

// Run a session from Start to its end, confirming every round as prefilled, and
// choosing `effort` for every movement. Returns the completed session.
function runFull(session, effort, finisherDone) {
  let s = W.startWorkout(session, at(0));
  s = W.finishWarmup(s);
  let t = 300;
  for (let guard = 0; guard < 500; guard++) {
    const p = s.progress;
    if (!p) break;
    t += 30;
    if (p.phase === 'round') s = W.confirmRound(s, null, at(t));
    else if (p.phase === 'rest') s = W.endRest(s);
    else if (p.phase === 'effort') {
      s.blocks[p.block].items.forEach((it, ii) => { s = W.setEffort(s, ii, effort); });
      s = W.finishEffort(s, at(t));
      if (s.completed_at) return s;
    } else if (p.phase === 'finisher') return W.finishFinisher(s, finisherDone !== false, at(t));
    else throw new Error('unexpected phase ' + p.phase);
  }
  return s;
}

test('flow: createSession gives a valid push session at the default 50 min; same seed, same session', () => {
  const doc = freshDoc();
  const a = W.createSession({ library, doc, seed: 777, now: T0 });
  deepEqual(a.violations, []);
  equal(a.session.day_type, 'push');
  equal(a.session.length_min, 50);
  const b = W.createSession({ library, doc, seed: 777, now: T0 });
  deepEqual(a.session, b.session);
});

test('flow: validateSession, reroll, and trimToLength tolerate app fields (started_at, notes, progress, ended_early)', () => {
  const doc = freshDoc();
  const s = W.createSession({ library, doc, seed: 4242, now: T0 }).session;
  const extra = Object.assign(clone(s), {
    started_at: T0, notes: 'felt good', ended_early: false,
    progress: { phase: 'warmup', block: null, round: 0, item: 0, rest_ends_at: null, draft: null },
  });
  deepEqual(validateSession({ library, equipment: doc.equipment, sessions: [], session: extra }), []);
  const r = reroll({ library, equipment: doc.equipment, sessions: [], session: extra, scope: { type: 'session' }, now: T0 });
  equal(r.notes, 'felt good', 'reroll keeps notes');
  equal(r.started_at, T0, 'reroll keeps started_at');
  deepEqual(validateSession({ library, equipment: doc.equipment, sessions: [], session: r }), []);
  const t = trimToLength(library, extra, 30);
  equal(t.notes, 'felt good', 'trim keeps notes');
  deepEqual(validateSession({ library, equipment: doc.equipment, sessions: [], session: t }), []);
});

test('flow: changeLength keeps the movements and stays valid at every length (10 seeds)', () => {
  const doc = freshDoc();
  for (let seed = 1; seed <= 10; seed++) {
    doc.current = W.createSession({ library, doc, seed, now: T0 }).session;
    const ids = movementIds(doc.current);
    [30, 40, 60, 50].forEach((len) => {
      const r = W.changeLength({ library, doc, lengthMin: len });
      deepEqual(r.violations, [], 'seed ' + seed + ' at ' + len + ' min');
      equal(movementIds(r.session), ids, 'movements unchanged');
      equal(r.session.length_min, len);
      doc.current = r.session;
    });
  }
});

test('flow: rerollSession on each scope returns a validated session', () => {
  const doc = freshDoc();
  doc.current = W.createSession({ library, doc, seed: 99, now: T0 }).session;
  [{ type: 'slot', block: 'A', slot: 0 }, { type: 'block', block: 'B' }, { type: 'session' }].forEach((scope) => {
    const r = W.rerollSession({ library, doc, scope, now: T0 });
    deepEqual(r.violations, [], JSON.stringify(scope));
    doc.current = r.session;
  });
  equal(doc.current.rerolls.count, 3);
});

test('flow: swapMovement swaps one slot to a candidate, validated and recorded; swapOptions lists the candidates with their items; non-candidates and started sessions throw', () => {
  const doc = freshDoc();
  doc.current = W.createSession({ library, doc, seed: 31, now: T0 }).session;
  let done = 0;
  doc.current.blocks.forEach((b, bi) => b.items.forEach((it, si) => {
    const params = { library, equipment: doc.equipment, sessions: doc.sessions, session: doc.current, blockIndex: bi, slotIndex: si };
    const cands = swapCandidates(params);
    const opts = W.swapOptions({ library, doc, block: b.block, slot: si });
    deepEqual(opts.map((o) => o.movementId), cands, b.block + si + ' options follow swapCandidates');
    if (!cands.length) return;
    const before = JSON.stringify(doc);
    const r = W.swapMovement({ library, doc, block: b.block, slot: String(si), movementId: cands[0], now: T0 });
    equal(JSON.stringify(doc), before, 'doc untouched');
    deepEqual(r.violations, [], b.block + si);
    equal(r.session.blocks[bi].items[si].movement_id, cands[0]);
    deepEqual(r.session.blocks[bi].items[si].target, opts[0].item.target, 'option item target is what the swap runs');
    deepEqual(r.session.blocks[bi].items[si].load, opts[0].item.load, 'option item load is what the swap runs');
    const rest = (s) => s.blocks.map((x, xi) => x.items.map((y, yi) => (xi === bi && yi === si ? '*' : y.movement_id)).join(',')).join('|');
    equal(rest(r.session), rest(doc.current), 'other slots unchanged');
    const rec = r.session.rerolls.history[r.session.rerolls.history.length - 1];
    deepEqual(rec.scope, { type: 'swap', block: b.block, slot: si });
    equal(r.session.rerolls.count, doc.current.rerolls.count + 1);
    let threw = false;
    try { W.swapMovement({ library, doc, block: b.block, slot: si, movementId: it.movement_id, now: T0 }); } catch (e) { threw = true; }
    assert(threw, 'swapping to the same movement throws');
    done += 1;
  }));
  assert(done > 0, 'no slot had a candidate');
  const started = clone(doc);
  started.current = W.startWorkout(started.current, T0);
  let threw = false;
  try { W.swapOptions({ library, doc: started, block: 'A', slot: 0 }); } catch (e) { threw = true; }
  assert(threw, 'a started session cannot be swapped');
});

test('flow: a full run logs every round of every active block, asks effort, and completes', () => {
  const doc = freshDoc();
  const s = W.createSession({ library, doc, seed: 31, now: T0 }).session;
  const done = runFull(s, 'hard_clean', true);
  assert(done.completed_at, 'completed');
  equal(done.progress, undefined, 'progress removed');
  equal(done.started_at, at(0));
  done.blocks.forEach((b) => {
    if (b.removed) { b.items.forEach((it) => equal(it.logged, null)); return; }
    b.items.forEach((it) => {
      equal(it.logged.rounds.length, b.rounds, it.movement_id + ' rounds');
      equal(it.logged.effort, 'hard_clean');
      it.logged.rounds.forEach((r) => {
        equal(r.value, it.target.value);
        equal(r.weight_lb_per_dumbbell, it.load.weight_lb_per_dumbbell);
      });
    });
  });
  if (done.finisher) equal(done.finisher.done, true);
  equal(sessionVolume(done).volume_lb, sessionVolume(s).volume_lb, 'logged as planned equals the plan volume');
  doc.sessions.push(done);
  equal(nextDayType(doc.sessions, library), 'hinge');
  const next = W.createSession({ library, doc, seed: 32, now: at(4000) });
  deepEqual(next.violations, []);
  equal(next.session.day_type, 'hinge');
});

test('flow: confirm order is a circuit; rest follows each round but the last; rest clock uses an end time', () => {
  const doc = freshDoc();
  let s = W.finishWarmup(W.startWorkout(W.createSession({ library, doc, seed: 5, now: T0 }).session, T0));
  const bi = s.progress.block;
  const block = s.blocks[bi];
  const seen = [];
  for (let i = 0; i < block.items.length; i++) {
    seen.push([s.progress.phase, s.progress.round, s.progress.item].join(':'));
    s = W.confirmRound(s, null, at(100));
  }
  deepEqual(seen, ['round:0:0', 'round:0:1', 'round:0:2']);
  equal(s.progress.phase, 'rest');
  equal(s.progress.round, 1);
  equal(s.progress.rest_ends_at, at(100 + block.rest_sec));
  equal(W.restRemainingSec(s, at(110)), block.rest_sec - 10);
  s = W.addRest(s, 15, at(110));
  equal(W.restRemainingSec(s, at(110)), block.rest_sec + 5);
  equal(W.restRemainingSec(s, at(100 + block.rest_sec + 60)), 0, 'never negative');
  s = W.endRest(s);
  deepEqual([s.progress.phase, s.progress.round, s.progress.item], ['round', 1, 0]);
});

test('flow: drafts edit value and weight before confirming; the confirmed round keeps the edit', () => {
  const doc = freshDoc();
  let s = W.finishWarmup(W.startWorkout(W.createSession({ library, doc, seed: 8, now: T0 }).session, T0));
  const p = s.progress;
  const pre = W.prefill(s, p.block, p.item);
  s = W.setDraft(s, { value: pre.value - 2, weight: pre.weight });
  deepEqual(W.currentEntry(s), { value: pre.value - 2, weight: pre.weight });
  s = W.confirmRound(s, null, at(60));
  const it = s.blocks[p.block].items[p.item];
  equal(it.logged.rounds[0].value, pre.value - 2);
  equal(s.progress.draft, null, 'draft cleared');
  deepEqual(W.currentEntry(s), W.prefill(s, p.block, p.item + 1), 'next round starts from the prefill');
});

test('flow: effort is required for every movement before moving on', () => {
  const doc = freshDoc();
  let s = W.finishWarmup(W.startWorkout(W.createSession({ library, doc, seed: 9, now: T0 }).session, T0));
  const bi = s.progress.block;
  while (s.progress.phase !== 'effort') {
    s = s.progress.phase === 'rest' ? W.endRest(s) : W.confirmRound(s, null, at(10));
  }
  equal(s.progress.block, bi);
  assert(!W.effortsComplete(s));
  s = W.setEffort(s, 0, 'barely');
  s = W.setEffort(s, 1, 'two_plus_left');
  assert(!W.effortsComplete(s));
  s = W.setEffort(s, 2, 'hard_clean');
  assert(W.effortsComplete(s));
  s = W.finishEffort(s, at(20));
  equal(s.progress.phase, 'round');
  assert(s.progress.block > bi, 'next block');
});

test('flow: End early keeps confirmed rounds; unlogged items are { rounds: [], effort: null }', () => {
  const doc = freshDoc();
  const plan = W.createSession({ library, doc, seed: 21, now: T0 }).session;
  let s = W.finishWarmup(W.startWorkout(plan, T0));
  // Block A round 1 fully, then the first movement of round 2
  for (let i = 0; i < 3; i++) s = W.confirmRound(s, null, at(10 + i));
  s = W.endRest(s);
  s = W.confirmRound(s, { value: 3, weight: s.blocks[0].items[0].load.weight_lb_per_dumbbell }, at(200));
  const ended = W.endEarly(s, at(300));
  equal(ended.ended_early, true);
  equal(ended.completed_at, at(300));
  const a = ended.blocks[0].items;
  equal(a[0].logged.rounds.length, 2);
  equal(a[1].logged.rounds.length, 1);
  equal(a[0].logged.effort, null);
  ended.blocks.slice(1).forEach((b) => {
    if (b.removed) return;
    b.items.forEach((it) => deepEqual(it.logged, { rounds: [], effort: null }, it.movement_id));
  });
  if (ended.finisher) equal(ended.finisher.done, false, 'finisher not reached counts as skipped');
  // Volume counts confirmed rounds only (the plan is not counted for unlogged items).
  const expected = a.reduce((sum, it) => sum + it.logged.rounds.reduce((x, r) =>
    x + (it.load.source === 'bodyweight' || it.target.unit === 'seconds' ? 0
      : (r.weight_lb_per_dumbbell || 0) * it.load.dumbbells * r.value * (it.target.per_side ? 2 : 1)), 0), 0);
  equal(sessionVolume(ended).volume_lb, expected);
  // lastPerformance: partial item reports its confirmed rounds; unlogged items are skipped.
  const hist = [ended];
  deepEqual(lastPerformance(hist, a[0].movement_id).values_by_round, [a[0].target.value, 3]);
  const unlogged = ended.blocks[1].items[0].movement_id;
  equal(lastPerformance(hist, unlogged), null, 'unlogged item has no last performance');
  const recA = recommend({ library, equipment: doc.equipment, sessions: hist, movementId: unlogged });
  const recNone = recommend({ library, equipment: doc.equipment, sessions: [], movementId: unlogged });
  deepEqual(recA, recNone, 'unlogged item recommends as if the session never had it');
  const short = recommend({ library, equipment: doc.equipment, sessions: hist, movementId: a[0].movement_id });
  assert(['step_down', 'short_repeat'].indexOf(short.basis) >= 0, 'short last round steps down, got ' + short.basis);
});

test('flow: isStale is true when the stored session no longer matches the history, false once started', () => {
  const doc = freshDoc();
  doc.current = W.createSession({ library, doc, seed: 3, now: T0 }).session;
  equal(W.isStale(library, doc), false);
  doc.sessions.push(runFull(doc.current, 'hard_clean'));
  equal(W.isStale(library, doc), true, 'push already done, next is hinge');
  doc.current = W.startWorkout(doc.current, T0);
  equal(W.isStale(library, doc), false);
});

test('flow: a 30 min session skips a removed Block C', () => {
  const doc = freshDoc();
  doc.settings.default_length_min = 30;
  let found = false;
  for (let seed = 1; seed <= 6 && !found; seed++) {
    const s = W.createSession({ library, doc, seed, now: T0 }).session;
    const removed = s.blocks.findIndex((b) => b.removed);
    if (removed < 0) continue;
    found = true;
    assert(W.activeBlockIndexes(s).indexOf(removed) < 0);
    const done = runFull(s, 'barely');
    done.blocks[removed].items.forEach((it) => equal(it.logged, null));
  }
  assert(found, 'some 30 min session removes Block C');
});

// ------------------------------------------------------------------ undo

function started(seed) {
  const doc = freshDoc();
  return W.finishWarmup(W.startWorkout(W.createSession({ library, doc, seed, now: T0 }).session, T0));
}

function pos(s) {
  return [s.progress.phase, s.progress.block, s.progress.round, s.progress.item].join(':');
}

test('flow undo: mid-round, the last confirm is reverted and its value and weight come back as the draft', () => {
  let s = started(41);
  const bi = s.progress.block;
  const pre = W.prefill(s, bi, 0);
  s = W.setDraft(s, { value: pre.value + 1, weight: pre.weight });
  const before = clone(s);
  s = W.confirmRound(s, null, at(30));
  equal(pos(s), 'round:' + bi + ':0:1');
  assert(W.canUndo(s), 'can undo after a confirm');
  const u = W.undoRound(s);
  equal(pos(u), 'round:' + bi + ':0:0');
  deepEqual(u.progress.draft, { value: pre.value + 1, weight: pre.weight });
  deepEqual(W.currentEntry(u), { value: pre.value + 1, weight: pre.weight });
  deepEqual(u.blocks, before.blocks, 'logged rounds back to before the confirm');
  equal(u.progress.rest_ends_at, null);
  equal(s.progress.item, 1, 'input left alone');
  // confirming again logs the restored draft
  const again = W.confirmRound(u, null, at(40));
  deepEqual(again.blocks[bi].items[0].logged.rounds, [{ value: pre.value + 1, weight_lb_per_dumbbell: pre.weight }]);
  // undo from the first movement of round 2 goes to the last movement of round 1
  let r2 = s;
  while (!(r2.progress.phase === 'round' && r2.progress.round === 1)) {
    r2 = r2.progress.phase === 'rest' ? W.endRest(r2) : W.confirmRound(r2, null, at(50));
  }
  const last = s.blocks[bi].items.length - 1;
  equal(pos(W.undoRound(r2)), 'round:' + bi + ':0:' + last);
});

test('flow undo: from rest it cancels the rest and returns to the last movement of the round', () => {
  let s = started(42);
  const bi = s.progress.block;
  const n = s.blocks[bi].items.length;
  for (let i = 0; i < n - 1; i++) s = W.confirmRound(s, null, at(10 + i));
  const before = clone(s);
  s = W.confirmRound(s, { value: 5, weight: W.prefill(s, bi, n - 1).weight }, at(20));
  equal(s.progress.phase, 'rest');
  assert(W.canUndo(s));
  const u = W.undoRound(s);
  equal(pos(u), 'round:' + bi + ':0:' + (n - 1));
  equal(u.progress.rest_ends_at, null, 'rest cancelled');
  deepEqual(u.progress.draft, { value: 5, weight: W.prefill(s, bi, n - 1).weight });
  deepEqual(u.blocks, before.blocks);
  equal(W.restRemainingSec(u, at(21)), 0);
});

test('flow undo: from effort it returns to the last movement of the last round and clears the block efforts', () => {
  let s = started(43);
  const bi = s.progress.block;
  const block = s.blocks[bi];
  let before = null;
  while (s.progress.phase !== 'effort') {
    if (s.progress.phase === 'rest') { s = W.endRest(s); continue; }
    before = clone(s);
    s = W.confirmRound(s, null, at(10));
  }
  s = W.setEffort(s, 0, 'barely');
  assert(W.canUndo(s));
  const u = W.undoRound(s);
  equal(pos(u), 'round:' + bi + ':' + (block.rounds - 1) + ':' + (block.items.length - 1));
  deepEqual(u.blocks, before.blocks, 'same as before the last confirm, efforts cleared');
  u.blocks[bi].items.forEach((it) => equal(it.logged.effort, null));
  equal(u.blocks[bi].items[block.items.length - 1].logged.rounds.length, block.rounds - 1);
  // re-confirm lands on effort again with nothing picked
  const back = W.confirmRound(u, null, at(20));
  equal(back.progress.phase, 'effort');
  assert(!W.effortsComplete(back));
});

test('flow undo: repeated undo steps back one confirm at a time to the start of the block', () => {
  let s = started(44);
  const bi = s.progress.block;
  const start = clone(s);
  const trail = [];
  while (s.progress.phase !== 'effort') {
    if (s.progress.phase === 'rest') { s = W.endRest(s); continue; }
    trail.push(pos(s));
    s = W.confirmRound(s, null, at(10));
  }
  const total = s.blocks[bi].rounds * s.blocks[bi].items.length;
  equal(trail.length, total);
  let n = 0;
  while (W.canUndo(s)) {
    s = W.undoRound(s);
    n += 1;
    equal(pos(s), trail[trail.length - n], 'undo ' + n);
  }
  equal(n, total, 'every confirm in the block can be undone');
  equal(pos(s), 'round:' + bi + ':0:0');
  deepEqual(s.blocks, start.blocks, 'nothing logged after undoing the whole block');
});

test('flow undo: it never crosses into a block whose efforts were submitted', () => {
  let s = started(45);
  const a = s.progress.block;
  while (s.progress.block === a) {
    const p = s.progress;
    if (p.phase === 'rest') s = W.endRest(s);
    else if (p.phase === 'round') s = W.confirmRound(s, null, at(10));
    else {
      s.blocks[a].items.forEach((it, ii) => { s = W.setEffort(s, ii, 'hard_clean'); });
      s = W.finishEffort(s, at(20));
    }
  }
  const b = s.progress.block;
  assert(b > a, 'moved to the next block');
  equal(pos(s), 'round:' + b + ':0:0');
  assert(!W.canUndo(s), 'nothing to undo at the start of the next block');
  const same = W.undoRound(s);
  deepEqual(same, s, 'undo is a no-op');
  const blockA = clone(s.blocks[a]);
  s = W.confirmRound(s, null, at(30));
  s = W.undoRound(s);
  equal(pos(s), 'round:' + b + ':0:0');
  assert(!W.canUndo(s), 'stops at the start of the block');
  deepEqual(s.blocks[a], blockA, 'the submitted block is untouched');
});

test('flow undo: nothing to undo at the warm-up, the first movement, or the finisher', () => {
  const doc = freshDoc();
  const plan = W.createSession({ library, doc, seed: 46, now: T0 }).session;
  const warm = W.startWorkout(plan, T0);
  assert(!W.canUndo(warm), 'warm-up');
  deepEqual(W.undoRound(warm), warm);
  const first = W.finishWarmup(warm);
  assert(!W.canUndo(first), 'first movement of the first round');
  deepEqual(W.undoRound(first), first);
  const edited = W.setDraft(first, { value: 1, weight: W.currentEntry(first).weight });
  assert(!W.canUndo(edited), 'a draft edit is not a confirm');
  assert(!W.canUndo(plan), 'not started');
  // finisher: run every block, then check
  let s = first;
  for (let guard = 0; guard < 500 && s.progress && s.progress.phase !== 'finisher'; guard++) {
    const p = s.progress;
    if (p.phase === 'round') s = W.confirmRound(s, null, at(10));
    else if (p.phase === 'rest') s = W.endRest(s);
    else {
      s.blocks[p.block].items.forEach((it, ii) => { s = W.setEffort(s, ii, 'barely'); });
      s = W.finishEffort(s, at(20));
    }
  }
  assert(plan.finisher, 'seed 46 has a finisher');
  equal(s.progress.phase, 'finisher');
  {
    assert(!W.canUndo(s), 'finisher');
    deepEqual(W.undoRound(s), s);
  }
});
