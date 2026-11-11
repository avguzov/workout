import { test, equal, assert, deepEqual } from './harness.js';
import { library, profiles, loggedSession, clone } from './helpers.js';
import { recommend, lastPerformance, weightSource, availableWeights } from '../js/engine/index.js';

const full = profiles.full;
const fixedOnly = profiles.fixed_only;

function rec(id, equipment, sessions) {
  return recommend({ library, equipment, sessions: sessions || [], movementId: id });
}

function once(id, weight, target, values, effort, dayType) {
  return [loggedSession({ dayType: dayType || 'push', completedAt: '2026-02-01T08:00:00.000Z', items: [{ id, weight, target, values, effort }] })];
}

function check(r, basis, weight, target, label) {
  equal(r.basis, basis, (label || '') + ' basis');
  equal(r.weight_lb_per_dumbbell, weight, (label || '') + ' weight');
  equal(r.target_value, target, (label || '') + ' target');
}

test('recommend rule 1: first time uses the library default (DB Bench Press 45 x 8)', () => {
  const r = rec('db-bench-press', full);
  check(r, 'first_time', 45, 8);
  equal(r.last, null);
  check(rec('lateral-raise', full), 'first_time', 10, 12, 'lateral raise');
  check(rec('t-push-up', full), 'first_time', null, 8, 'bodyweight');
  check(rec('single-arm-floor-press', full), 'first_time', 30, 10, 'single-arm floor press');
});

test('recommend rule 1: mapped lighter than default targets max (bench 25 x 12 under fixed_only)', () => {
  check(rec('db-bench-press', fixedOnly), 'first_time', 25, 12);
  const odd = { adjustable: { present: false, min_lb: null, max_lb: null, step_lb: null }, fixed_pairs_lb: [30, 40], bench: { present: true, incline: true } };
  check(rec('lateral-raise', odd), 'first_time', 30, 12, 'lowest available when none below');
});

test('recommend rule 2: last round more than 2 short steps down one notch, same target', () => {
  check(rec('db-bench-press', full, once('db-bench-press', 45, 8, [8, 8, 8, 5], 'two_plus_left')), 'step_down', 40, 8);
  check(rec('skull-crusher', full, once('skull-crusher', 15, 12, [12, 12, 9], 'hard_clean')), 'step_down', 10, 12, 'fixed pair');
  // exactly 2 short is not a step down
  check(rec('db-bench-press', full, once('db-bench-press', 45, 8, [8, 8, 8, 6], 'hard_clean')), 'add_reps', 45, 9, '2 short');
  // nothing lighter: same weight, same target
  check(rec('db-thruster', fixedOnly, once('db-thruster', 10, 10, [10, 10, 10, 6], 'barely')), 'short_repeat', 10, 10, 'lightest');
});

test('recommend rule 3: adjustable notch 45 to 50 at the default target', () => {
  check(rec('db-bench-press', full, once('db-bench-press', 45, 10, [10, 10, 10, 10], 'two_plus_left')), 'weight_up', 50, 8);
});

test('recommend rule 3: fixed pair 15 to 20 (Skull Crusher)', () => {
  const r = rec('skull-crusher', full, once('skull-crusher', 15, 14, [14, 14, 14], 'two_plus_left'));
  check(r, 'weight_up', 20, 12);
  equal(weightSource(20, full), 'fixed');
});

test('recommend rule 3: fixed 25 to adjustable 30 under full (DB Thruster)', () => {
  const r = rec('db-thruster', full, once('db-thruster', 25, 10, [10, 10, 10, 10], 'two_plus_left'));
  check(r, 'weight_up', 30, 10);
  equal(weightSource(30, full), 'adjustable');
});

test('recommend rule 3: capped at 25 under fixed_only adds reps, then holds', () => {
  check(rec('db-thruster', fixedOnly, once('db-thruster', 25, 10, [10, 10, 10, 10], 'two_plus_left')), 'top_weight_reps', 25, 12);
  check(rec('db-thruster', fixedOnly, once('db-thruster', 25, 11, [11, 11, 11, 11], 'two_plus_left')), 'top_weight_reps', 25, 12, 'clamped to max');
  const held = rec('db-thruster', fixedOnly, once('db-thruster', 25, 12, [12, 12, 12, 12], 'two_plus_left'));
  check(held, 'top_weight_hold', 25, 12, 'no harder variation');
  equal(held.suggest_variation, null);
});

test('recommend rule 3: 50 x 12 at the top weight suggests the harder variation', () => {
  const r = rec('db-bench-press', full, once('db-bench-press', 50, 12, [12, 12, 12, 12], 'two_plus_left'));
  check(r, 'top_weight_variation', 50, 12);
  deepEqual(r.suggest_variation, { id: 'single-arm-db-bench-press' });
  check(rec('db-bench-press', full, once('db-bench-press', 50, 8, [8, 8, 8, 8], 'two_plus_left')), 'top_weight_reps', 50, 10, 'add 2 first');
});

test('recommend rule 8: raising max_lb to 60 turns a capped lift into 55', () => {
  const raised = clone(full);
  raised.adjustable.max_lb = 60;
  const hist = once('db-bench-press', 50, 12, [12, 12, 12, 12], 'two_plus_left');
  check(rec('db-bench-press', raised, hist), 'weight_up', 55, 8);
  equal(weightSource(55, raised), 'adjustable');
});

test('recommend rule 4: hard_clean adds 1 under 10 or per side, otherwise 2, never above max', () => {
  check(rec('db-bench-press', full, once('db-bench-press', 45, 8, [8, 8, 8, 8], 'hard_clean')), 'add_reps', 45, 9, 'under 10');
  check(rec('goblet-squat', full, once('goblet-squat', 45, 10, [10, 10, 10, 10], 'hard_clean')), 'add_reps', 45, 12, '10 and over');
  check(rec('1-arm-db-row', full, once('1-arm-db-row', 45, 10, [10, 10, 10, 10], 'hard_clean')), 'add_reps', 45, 11, 'per side');
  check(rec('goblet-squat', full, once('goblet-squat', 45, 11, [11, 11, 11, 11], 'hard_clean')), 'add_reps', 45, 12, 'capped');
  check(rec('goblet-squat', full, once('goblet-squat', 45, 12, [12, 12, 12, 12], 'hard_clean')), 'hold_max', 45, 12, 'at max');
});

test('recommend rule 5: barely or no effort repeats weight and target', () => {
  check(rec('db-bench-press', full, once('db-bench-press', 45, 9, [9, 9, 9, 9], 'barely')), 'repeat', 45, 9);
  check(rec('db-bench-press', full, once('db-bench-press', 45, 9, [9, 9, 9, 9], null)), 'repeat', 45, 9, 'no effort');
});

test('recommend rule 6: Lateral Raise 10 x 12 builds to 20 reps, then moves to 15', () => {
  let sessions = [];
  const seen = [];
  for (let i = 0; i < 6; i++) {
    const r = rec('lateral-raise', full, sessions);
    seen.push(r.weight_lb_per_dumbbell + 'x' + r.target_value);
    const day = '2026-03-0' + (i + 1) + 'T08:00:00.000Z';
    sessions = sessions.concat([loggedSession({ dayType: 'push', completedAt: day, items: [{
      id: 'lateral-raise', weight: r.weight_lb_per_dumbbell, target: r.target_value,
      values: [r.target_value, r.target_value, r.target_value], effort: 'two_plus_left' }] })]);
  }
  deepEqual(seen, ['10x12', '10x14', '10x16', '10x18', '10x20', '15x12']);
  check(rec('lateral-raise', full, once('lateral-raise', 10, 12, [12, 12, 12], 'hard_clean')), 'add_reps', 10, 14, 'hard_clean +2');
});

test('recommend rule 7: bodyweight +2 / +1 capped at max, then the harder variation', () => {
  check(rec('t-push-up', full, once('t-push-up', null, 8, [8, 8, 8, 8], 'two_plus_left')), 'add_reps', null, 10);
  check(rec('t-push-up', full, once('t-push-up', null, 8, [8, 8, 8, 8], 'hard_clean')), 'add_reps', null, 9);
  check(rec('t-push-up', full, once('t-push-up', null, 15, [15, 15, 15, 15], 'two_plus_left')), 'add_reps', null, 16, 'capped');
  const dead = rec('dead-bug', full, once('dead-bug', null, 15, [15, 15, 15, 15], 'two_plus_left'));
  check(dead, 'max_variation', null, 15);
  deepEqual(dead.suggest_variation, { id: 'weighted-dead-bug' });
});

test('recommend rule 7: timed +10 / +5 sec capped at max', () => {
  check(rec('plank', full, once('plank', null, 60, [60, 60, 60], 'two_plus_left')), 'add_time', null, 70);
  check(rec('plank', full, once('plank', null, 60, [60, 60, 60], 'hard_clean')), 'add_time', null, 65);
  check(rec('plank', full, once('plank', null, 85, [85, 85, 85], 'two_plus_left')), 'add_time', null, 90, 'capped');
  check(rec('plank', full, once('plank', null, 90, [90, 90, 90], 'two_plus_left')), 'max_hold', null, 90, 'at max');
  check(rec('suitcase-carry', full, once('suitcase-carry', 50, 30, [30, 30, 30, 30], 'two_plus_left')), 'add_time', 50, 40, 'loaded timed keeps weight');
});

test('recommend rule 8: a weight no longer available is mapped down first', () => {
  const r = rec('db-bench-press', fixedOnly, once('db-bench-press', 45, 8, [8, 8, 8, 8], 'barely'));
  check(r, 'repeat', 25, 8);
  equal(r.remapped_from_lb, 45);
  check(rec('db-bench-press', fixedOnly, once('db-bench-press', 45, 8, [8, 8, 8, 8], 'two_plus_left')), 'top_weight_reps', 25, 10, 'then rules apply');
  assert(availableWeights(library.movements.find((m) => m.id === 'renegade-row'), full).join() === '10,15,20,25', 'fixed_only uses fixed pairs');
});

test('recommend: a lift logged on a pull day is found for a push day', () => {
  const pull = loggedSession({ dayType: 'pull', completedAt: '2026-02-03T08:00:00.000Z', items: [
    { id: 'db-bent-over-row', weight: 45, target: 10, values: [10, 10, 10, 10], effort: 'hard_clean' }] });
  const olderPush = loggedSession({ dayType: 'push', completedAt: '2026-02-01T08:00:00.000Z', items: [
    { id: 'db-bent-over-row', weight: 40, target: 10, values: [10, 10, 10, 10], effort: 'barely' }] });
  const hist = [olderPush, pull];
  const last = lastPerformance(hist, 'db-bent-over-row');
  equal(last.day_type, 'pull');
  equal(last.date, '2026-02-03T08:00:00.000Z');
  deepEqual(last.values_by_round, [10, 10, 10, 10]);
  equal(last.effort, 'hard_clean');
  check(rec('db-bent-over-row', full, hist), 'add_reps', 45, 12, 'push day uses the pull-day log');
});

test('recommend rule 9: basis names the rule that fired', () => {
  const names = new Set();
  names.add(rec('db-bench-press', full).basis);
  names.add(rec('db-bench-press', full, once('db-bench-press', 45, 8, [8, 8, 8, 4], 'hard_clean')).basis);
  names.add(rec('db-bench-press', full, once('db-bench-press', 45, 8, [8, 8, 8, 8], 'two_plus_left')).basis);
  names.add(rec('db-bench-press', full, once('db-bench-press', 45, 8, [8, 8, 8, 8], 'hard_clean')).basis);
  names.add(rec('db-bench-press', full, once('db-bench-press', 45, 8, [8, 8, 8, 8], 'barely')).basis);
  names.add(rec('db-bench-press', full, once('db-bench-press', 50, 10, [10, 10, 10, 10], 'two_plus_left')).basis);
  names.add(rec('db-bench-press', full, once('db-bench-press', 50, 12, [12, 12, 12, 12], 'two_plus_left')).basis);
  deepEqual(Array.from(names).sort(), ['add_reps', 'first_time', 'repeat', 'step_down', 'top_weight_reps', 'top_weight_variation', 'weight_up']);
});
