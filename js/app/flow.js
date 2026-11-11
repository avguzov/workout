// Pure session operations for the app: plan (generate, reroll, length) and the workout flow
// (warm-up, rounds, rest, effort, finisher, complete, undo). Every function returns a new session
// and leaves its input alone. The caller passes `now` (ISO) and `seed`.
//
// App fields added to a Session: started_at, notes, ended_early, and while a workout runs,
// progress = { phase: 'warmup'|'round'|'rest'|'effort'|'finisher', block, round, item,
//              rest_ends_at, draft: null|{ value, weight } }
// `block` is an index into session.blocks, `round` and `item` are zero-based.

import {
  generateSession, reroll, trimToLength, validateSession, finisherOptions, nextDayType,
} from '../engine/index.js';

export function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function iso(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === 'number') return new Date(now).toISOString();
  return String(now);
}

// ------------------------------------------------------------------ plan

function check(library, doc, session) {
  return validateSession({ library, equipment: doc.equipment, sessions: doc.sessions, session });
}

// -> { session, violations }
export function createSession({ library, doc, seed, now }) {
  const session = generateSession({
    library,
    equipment: doc.equipment,
    sessions: doc.sessions,
    lengthMin: doc.settings.default_length_min,
    seed,
    now: iso(now),
    autoPickSwaps: doc.settings.auto_pick_swaps !== false,
  });
  return { session, violations: check(library, doc, session) };
}

// scope: { type: 'slot', block, slot } | { type: 'block', block } | { type: 'session' }
export function rerollSession({ library, doc, scope, now }) {
  const session = reroll({
    library, equipment: doc.equipment, sessions: doc.sessions, session: doc.current, scope, now: iso(now),
  });
  return { session, violations: check(library, doc, session) };
}

// Trim the same movements to a new length, then refresh the finisher's weight the way the
// generator does (a finisher that reuses the session setting can change when Block C goes).
export function changeLength({ library, doc, lengthMin }) {
  const session = trimToLength(library, doc.current, lengthMin);
  if (session.finisher) {
    const opt = finisherOptions(library, doc.equipment, session).find((o) => o.id === session.finisher.id);
    session.finisher = Object.assign({}, session.finisher, {
      weight_lb_per_dumbbell: opt && opt.ok ? opt.weight : null,
      setting_basis: opt && opt.ok ? opt.basis : null,
    });
  }
  return { session, violations: check(library, doc, session) };
}

// True when `current` no longer matches the history (for example the history changed).
export function isStale(library, doc) {
  const c = doc.current;
  if (!c) return true;
  if (c.started_at) return false;
  return c.day_type !== nextDayType(doc.sessions, library);
}

// ------------------------------------------------------------------ workout flow

export function isStarted(session) {
  return !!(session && session.started_at);
}

export function activeBlockIndexes(session) {
  const out = [];
  (session.blocks || []).forEach((b, i) => { if (b.rounds > 0 && !b.removed) out.push(i); });
  return out;
}

function nextActiveBlock(session, bi) {
  const list = activeBlockIndexes(session);
  for (const i of list) if (i > bi) return i;
  return -1;
}

export function prefill(session, bi, ii) {
  const it = session.blocks[bi].items[ii];
  return { value: it.target.value, weight: it.load ? it.load.weight_lb_per_dumbbell : null };
}

// Value and weight shown for the active round: the edited draft or the prefill.
export function currentEntry(session) {
  const p = session.progress;
  if (!p || p.phase !== 'round') return null;
  const base = prefill(session, p.block, p.item);
  return p.draft ? { value: p.draft.value, weight: p.draft.weight } : base;
}

export function startWorkout(session, now) {
  const s = clone(session);
  s.started_at = iso(now);
  s.progress = { phase: 'warmup', block: null, round: 0, item: 0, rest_ends_at: null, draft: null };
  return s;
}

function roundStart(session, bi) {
  return { phase: 'round', block: bi, round: 0, item: 0, rest_ends_at: null, draft: null };
}

export function finishWarmup(session) {
  const s = clone(session);
  const list = activeBlockIndexes(s);
  s.progress = list.length ? roundStart(s, list[0]) : afterBlocks(s);
  return s;
}

export function setDraft(session, draft) {
  const s = clone(session);
  if (!s.progress || s.progress.phase !== 'round') return s;
  s.progress.draft = { value: draft.value, weight: draft.weight == null ? null : draft.weight };
  return s;
}

// Confirm the active round with `entry` ({ value, weight }), or the draft or prefill when omitted.
export function confirmRound(session, entry, now) {
  const p = session.progress;
  if (!p || p.phase !== 'round') throw new Error('No round to confirm');
  const e = entry || currentEntry(session);
  const s = clone(session);
  const block = s.blocks[p.block];
  const it = block.items[p.item];
  if (!it.logged) it.logged = { rounds: [], effort: null };
  it.logged.rounds[p.round] = {
    value: e.value,
    weight_lb_per_dumbbell: e.weight == null ? null : e.weight,
  };
  it.logged.rounds = it.logged.rounds.slice(0, p.round + 1);
  if (p.item + 1 < block.items.length) {
    s.progress = { phase: 'round', block: p.block, round: p.round, item: p.item + 1, rest_ends_at: null, draft: null };
  } else if (p.round + 1 < block.rounds) {
    const ends = new Date(new Date(iso(now)).getTime() + (block.rest_sec || 0) * 1000).toISOString();
    s.progress = { phase: 'rest', block: p.block, round: p.round + 1, item: 0, rest_ends_at: ends, draft: null };
  } else {
    s.progress = { phase: 'effort', block: p.block, round: p.round, item: 0, rest_ends_at: null, draft: null };
  }
  return s;
}

// The most recent confirmed round in the current block as { round, item, entry }, or null.
// From a round it is the movement before (or the last movement of the round before); from rest
// and effort it is the last movement of the round just finished. Never reaches into an earlier
// block, whose efforts were already submitted.
function lastConfirmed(session) {
  const p = session && session.progress;
  if (!p || p.block == null) return null;
  const block = session.blocks[p.block];
  if (!block || !block.items.length) return null;
  const last = block.items.length - 1;
  let round;
  let item;
  if (p.phase === 'round') {
    if (p.item > 0) { round = p.round; item = p.item - 1; } else if (p.round > 0) { round = p.round - 1; item = last; } else return null;
  } else if (p.phase === 'rest') {
    if (!(p.round > 0)) return null;
    round = p.round - 1;
    item = last;
  } else if (p.phase === 'effort') {
    round = p.round;
    item = last;
  } else return null;
  const it = block.items[item];
  const lr = it && it.logged && Array.isArray(it.logged.rounds) ? it.logged.rounds[round] : null;
  return lr ? { round, item, entry: lr } : null;
}

export function canUndo(session) {
  return !!lastConfirmed(session);
}

// Revert the most recent confirmed round in the current block and return to that movement and
// round with the logged value and weight as the draft. From rest it cancels the rest; from effort
// it also clears the efforts picked for this block (they belong to the round being redone).
// Returns the session unchanged when there is nothing to undo.
export function undoRound(session) {
  const at = lastConfirmed(session);
  if (!at) return session;
  const s = clone(session);
  const p = s.progress;
  const block = s.blocks[p.block];
  if (p.phase === 'effort') block.items.forEach((x) => { if (x.logged) x.logged.effort = null; });
  const it = block.items[at.item];
  it.logged.rounds = it.logged.rounds.slice(0, at.round);
  if (!it.logged.rounds.length && !it.logged.effort) it.logged = null;
  s.progress = {
    phase: 'round', block: p.block, round: at.round, item: at.item, rest_ends_at: null,
    draft: { value: at.entry.value, weight: at.entry.weight_lb_per_dumbbell == null ? null : at.entry.weight_lb_per_dumbbell },
  };
  return s;
}

export function restRemainingSec(session, now) {
  const p = session.progress;
  if (!p || p.phase !== 'rest' || !p.rest_ends_at) return 0;
  return Math.max(0, (Date.parse(p.rest_ends_at) - new Date(iso(now)).getTime()) / 1000);
}

export function endRest(session) {
  const p = session.progress;
  if (!p || p.phase !== 'rest') return session;
  const s = clone(session);
  s.progress = { phase: 'round', block: p.block, round: p.round, item: 0, rest_ends_at: null, draft: null };
  return s;
}

// +sec on the rest clock; a clock that already ran out restarts from now.
export function addRest(session, sec, now) {
  const p = session.progress;
  if (!p || p.phase !== 'rest') return session;
  const s = clone(session);
  const base = Math.max(Date.parse(p.rest_ends_at) || 0, new Date(iso(now)).getTime());
  s.progress.rest_ends_at = new Date(base + sec * 1000).toISOString();
  return s;
}

export function setEffort(session, ii, effort) {
  const p = session.progress;
  if (!p || p.phase !== 'effort') throw new Error('Not asking for effort');
  const s = clone(session);
  const it = s.blocks[p.block].items[ii];
  if (!it.logged) it.logged = { rounds: [], effort: null };
  it.logged.effort = effort;
  return s;
}

export function effortsComplete(session) {
  const p = session.progress;
  if (!p || p.phase !== 'effort') return false;
  return session.blocks[p.block].items.every((it) => it.logged && it.logged.effort);
}

function afterBlocks(session) {
  if (session.finisher) return { phase: 'finisher', block: null, round: 0, item: 0, rest_ends_at: null, draft: null };
  return null;
}

// After the effort step: the next block, then the finisher. Returns the completed session
// when nothing is left (a day without a finisher).
export function finishEffort(session, now) {
  const p = session.progress;
  if (!p || p.phase !== 'effort') throw new Error('Not asking for effort');
  const s = clone(session);
  const next = nextActiveBlock(s, p.block);
  if (next >= 0) {
    s.progress = roundStart(s, next);
    return s;
  }
  const fin = afterBlocks(s);
  if (fin) {
    s.progress = fin;
    return s;
  }
  return completeSession(s, now);
}

export function finishFinisher(session, done, now) {
  const s = clone(session);
  if (s.finisher) s.finisher.done = !!done;
  return completeSession(s, now);
}

// Completed form: every item in an active block has `logged`; one with nothing confirmed gets
// { rounds: [], effort: null }, which counts 0 toward volume and which lastPerformance skips.
// Items in removed blocks keep logged: null. A finisher never reached counts as skipped.
export function completeSession(session, now, endedEarly) {
  const s = clone(session);
  s.blocks.forEach((b) => {
    if (!(b.rounds > 0) || b.removed) return;
    b.items.forEach((it) => {
      if (!it.logged) it.logged = { rounds: [], effort: null };
      if (!Array.isArray(it.logged.rounds)) it.logged.rounds = [];
      if (it.logged.effort === undefined) it.logged.effort = null;
    });
  });
  if (s.finisher && s.finisher.done == null) s.finisher.done = false;
  if (!s.started_at) s.started_at = iso(now);
  s.completed_at = iso(now);
  if (endedEarly) s.ended_early = true;
  delete s.progress;
  return s;
}

export function endEarly(session, now) {
  return completeSession(session, now, true);
}

export function confirmedRounds(session) {
  let n = 0;
  (session.blocks || []).forEach((b) => b.items.forEach((it) => {
    if (it.logged && Array.isArray(it.logged.rounds)) n += it.logged.rounds.length;
  }));
  return n;
}
