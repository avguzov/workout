// Shared test data and helpers: loads the library and fixtures, converts draft workouts to
// Session objects, simulates logging, and runs session chains.

import { generateSession, validateSession, makeRng } from '../js/engine/index.js';

async function load(path) {
  const url = new URL(path, import.meta.url);
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('could not load ' + url + ' (' + res.status + ')');
  return res.json();
}

export const library = await load('../data/library.json');
export const drafts = await load('./fixtures/draft_workouts.json');
export const profiles = await load('./fixtures/equipment_profiles.json');

export function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

export function movement(id) {
  const m = library.movements.find((x) => x.id === id);
  if (!m) throw new Error('no movement ' + id);
  return m;
}

// Draft workout fixture -> Session object
export function fixtureToSession(fx, lengthMin) {
  return {
    id: fx.id,
    seed: 0,
    day_type: fx.day_type,
    template_id: fx.template_id,
    length_min: lengthMin || 60,
    created_at: null,
    completed_at: null,
    auto_pick_swaps: true,
    blocks: fx.blocks.map((b) => ({
      block: b.block,
      rounds: b.rounds,
      planned_rounds: b.rounds,
      rest_sec: library.timing.rest_between_rounds_sec[b.block],
      adjustable_setting_lb: b.movements.some((m) => m.load.source === 'adjustable') ? fx.adjustable_setting_lb : null,
      removed: false,
      items: b.movements.map((m, i) => ({
        movement_id: m.id,
        slot: i,
        target: clone(m.target),
        load: clone(m.load),
        recommendation: null,
        adjusted: null,
        forced_repeat: false,
        off_target: false,
        logged: null,
      })),
    })),
    finisher: fx.finisher ? { id: fx.finisher, weight_lb_per_dumbbell: null, done: null } : null,
    estimate_sec: 0,
    trims: [],
    over_length_sec: 0,
    rerolls: { count: 0, history: [] },
  };
}

// Minimal completed session holding logged items, for recommendation tests.
// items: [{ id, weight, target, values, effort }]
export function loggedSession({ dayType, completedAt, items }) {
  return {
    id: 'log-' + completedAt,
    day_type: dayType || 'push',
    template_id: null,
    created_at: completedAt,
    completed_at: completedAt,
    blocks: [{
      block: 'A', rounds: (items[0].values || []).length, planned_rounds: 4,
      items: items.map((x, i) => {
        const mv = movement(x.id);
        return {
          movement_id: x.id,
          slot: i,
          target: { unit: mv.target.unit, value: x.target, per_side: mv.target.per_side },
          load: { source: x.weight == null ? 'bodyweight' : 'fixed', weight_lb_per_dumbbell: x.weight, dumbbells: mv.load.dumbbells },
          logged: {
            rounds: x.values.map((v) => ({ value: v, weight_lb_per_dumbbell: x.weight })),
            effort: x.effort === undefined ? null : x.effort,
          },
        };
      }),
    }],
    finisher: null,
  };
}

// Simulated logging: mostly at target, sometimes 3 short on the last round (reps only);
// effort about 40% two_plus_left, 40% hard_clean, 20% barely.
export function simulateLog(session, rng, completedAt) {
  const s = clone(session);
  s.blocks.forEach((b) => {
    if (!(b.rounds > 0)) return;
    b.items.forEach((it) => {
      const rounds = [];
      for (let r = 0; r < b.rounds; r++) {
        let v = it.target.value;
        if (r === b.rounds - 1 && it.target.unit === 'reps' && rng() < 0.15) v = Math.max(0, v - 3);
        rounds.push({ value: v, weight_lb_per_dumbbell: it.load.weight_lb_per_dumbbell });
      }
      const e = rng();
      it.logged = { rounds, effort: e < 0.4 ? 'two_plus_left' : e < 0.8 ? 'hard_clean' : 'barely' };
    });
  });
  if (s.finisher) s.finisher.done = true;
  s.completed_at = completedAt;
  return s;
}

export function dayIso(i) {
  return new Date(Date.UTC(2026, 0, 5 + i, 7, 0, 0)).toISOString();
}

// Generate, validate, log, and complete `count` consecutive sessions.
export function runChain({ lib, equipment, lengthMin, count, seedPrefix, autoPickSwaps, onSession }) {
  const L = lib || library;
  const sessions = [];
  const logRng = makeRng('log|' + seedPrefix);
  const stats = {
    sessions: 0, violations: 0, off_target: 0, forced_repeat: 0, adjusted: 0, over_length: 0,
    est_sec_total: 0, messages: [],
  };
  for (let i = 0; i < count; i++) {
    const s = generateSession({
      library: L, equipment, sessions, lengthMin, seed: seedPrefix + '|' + i, now: dayIso(i),
      autoPickSwaps: autoPickSwaps !== false,
    });
    const v = validateSession({ library: L, equipment, sessions, session: s });
    stats.sessions += 1;
    stats.violations += v.length;
    v.slice(0, 3).forEach((x) => { if (stats.messages.length < 6) stats.messages.push('#' + i + ' ' + x.rule + ': ' + x.message); });
    s.blocks.forEach((b) => b.items.forEach((it) => {
      if (it.off_target) stats.off_target += 1;
      if (it.forced_repeat) stats.forced_repeat += 1;
      if (it.adjusted) stats.adjusted += 1;
    }));
    if (s.over_length_sec > 0) stats.over_length += 1;
    stats.est_sec_total += s.estimate_sec;
    if (onSession) onSession(s, i, sessions.slice(), v);
    sessions.push(simulateLog(s, logRng, dayIso(i).replace('T07', 'T08')));
  }
  stats.avg_min = Math.round((stats.est_sec_total / Math.max(1, stats.sessions) / 60) * 10) / 10;
  return { sessions, stats };
}
