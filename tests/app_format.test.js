// App formatting helpers: numbers, targets, loads, clocks, last-time lines, basis lines for every
// basis value, flags, estimate and comparison text. UI copy has no em dashes.

import { test, equal, assert, deepEqual } from './harness.js';
import { library } from './helpers.js';
import * as F from '../js/app/format.js';
import { durationSec, finisherStatus } from '../js/app/screens/summary.js';

const BASIS_VALUES = ['first_time', 'step_down', 'short_repeat', 'weight_up', 'top_weight_reps',
  'top_weight_variation', 'top_weight_hold', 'add_reps', 'add_time', 'hold_max', 'max_variation',
  'max_hold', 'repeat'];

const EM_DASH = /[—–]/;

test('format: numbers get thousands separators and at most one decimal', () => {
  equal(F.formatNumber(2880), '2,880');
  equal(F.formatNumber(1234567), '1,234,567');
  equal(F.formatNumber(12.5), '12.5');
  equal(F.formatNumber(12.04), '12');
  equal(F.formatNumber(0), '0');
  equal(F.formatNumber(-1500), '-1,500');
  equal(F.formatNumber(NaN), '0');
});

test('format: targets, values, and loads', () => {
  equal(F.formatTarget({ unit: 'reps', value: 8, per_side: false }), '8 reps');
  equal(F.formatTarget({ unit: 'reps', value: 10, per_side: true }), '10 reps per side');
  equal(F.formatTarget({ unit: 'seconds', value: 40, per_side: false }), '40 sec');
  equal(F.formatValue(1, 'reps'), '1 rep');
  equal(F.formatLoad({ source: 'adjustable', weight_lb_per_dumbbell: 25, dumbbells: 2 }), '2 x 25 lb adjustable');
  equal(F.formatLoad({ source: 'fixed', weight_lb_per_dumbbell: 20, dumbbells: 2 }), '2 x 20 lb');
  equal(F.formatLoad({ source: 'fixed', weight_lb_per_dumbbell: 15, dumbbells: 1 }), '1 x 15 lb');
  equal(F.formatLoad({ source: 'bodyweight', weight_lb_per_dumbbell: null, dumbbells: 0 }), 'bodyweight');
});

test('format: one load formatter states the dumbbell count on every planned-load line', () => {
  const reps = (value, perSide) => ({ unit: 'reps', value, per_side: !!perSide });
  // adjustable pair
  equal(F.formatPlan(reps(8, true), { source: 'adjustable', weight_lb_per_dumbbell: 45, dumbbells: 2 }), '8 reps per side, 2 x 45 lb adjustable');
  // adjustable single
  equal(F.formatPlan(reps(10, true), { source: 'adjustable', weight_lb_per_dumbbell: 30, dumbbells: 1 }), '10 reps per side, 1 x 30 lb adjustable');
  // fixed pair
  equal(F.formatPlan(reps(6), { source: 'fixed', weight_lb_per_dumbbell: 25, dumbbells: 2 }), '6 reps, 2 x 25 lb');
  // fixed single
  equal(F.formatPlan(reps(20), { source: 'fixed', weight_lb_per_dumbbell: 15, dumbbells: 1 }), '20 reps, 1 x 15 lb');
  // bodyweight reps
  equal(F.formatPlan(reps(10), { source: 'bodyweight', weight_lb_per_dumbbell: null, dumbbells: 0 }), '10 reps, bodyweight');
  // timed, bodyweight and with a weight
  equal(F.formatPlan({ unit: 'seconds', value: 60, per_side: false }, { source: 'bodyweight', weight_lb_per_dumbbell: null, dumbbells: 0 }), '60 sec, bodyweight');
  equal(F.formatPlan({ unit: 'seconds', value: 30, per_side: true }, { source: 'adjustable', weight_lb_per_dumbbell: 50, dumbbells: 1 }), '30 sec per side, 1 x 50 lb adjustable');
  // a weight with dumbbells: 0 in the library still reads as one dumbbell, never "0 x"
  equal(F.formatLoad({ source: 'fixed', weight_lb_per_dumbbell: 10, dumbbells: 0 }), '1 x 10 lb');
  // every library movement at its default load says a count or bodyweight
  library.movements.forEach((m) => {
    const line = F.formatLoad({ source: m.load.default_source, weight_lb_per_dumbbell: m.load.default_source === 'bodyweight' ? null : m.load.default_weight_lb, dumbbells: m.load.dumbbells });
    assert(/^(bodyweight|[12] x \d+(\.\d)? lb( adjustable)?)$/.test(line), m.id + ': ' + line);
  });
});

test('format: Confirm label is short and states the count; chips use @ so the weight is not read as a count', () => {
  const item = (unit, perSide, load) => ({ target: { unit, value: 8, per_side: perSide }, load });
  const adj = { source: 'adjustable', weight_lb_per_dumbbell: 45, dumbbells: 2 };
  equal(F.confirmLabel({ value: 8, weight: 45 }, item('reps', true, adj)), 'Confirm 8 reps, 2 x 45 lb');
  equal(F.confirmLabel({ value: 7, weight: 40 }, item('reps', false, adj)), 'Confirm 7 reps, 2 x 40 lb', 'edited weight');
  equal(F.confirmLabel({ value: 10, weight: 30 }, item('reps', true, { source: 'adjustable', weight_lb_per_dumbbell: 30, dumbbells: 1 })), 'Confirm 10 reps, 1 x 30 lb');
  equal(F.confirmLabel({ value: 6, weight: 25 }, item('reps', false, { source: 'fixed', weight_lb_per_dumbbell: 25, dumbbells: 2 })), 'Confirm 6 reps, 2 x 25 lb');
  equal(F.confirmLabel({ value: 10, weight: null }, item('reps', false, { source: 'bodyweight', weight_lb_per_dumbbell: null, dumbbells: 0 })), 'Confirm 10 reps, bodyweight');
  equal(F.confirmLabel({ value: 60, weight: null }, item('seconds', false, { source: 'bodyweight', weight_lb_per_dumbbell: null, dumbbells: 0 })), 'Confirm 60 sec, bodyweight');
  equal(F.chipText({ value: 10, weight_lb_per_dumbbell: 30 }, 'reps'), '10 @ 30');
  equal(F.chipText({ value: 12, weight_lb_per_dumbbell: null }, 'reps'), '12');
  equal(F.chipText({ value: 60, weight_lb_per_dumbbell: null }, 'seconds'), '60 sec');
  equal(F.chipText({ value: 30, weight_lb_per_dumbbell: 50 }, 'seconds'), '30 sec @ 50');
});

test('format: first-time line says weight for loaded movements and target for bodyweight and timed ones', () => {
  const loaded = library.movements.find((m) => m.load.default_source !== 'bodyweight' && m.target.unit === 'reps');
  const bw = library.movements.find((m) => m.load.default_source === 'bodyweight' && m.target.unit === 'reps');
  const timed = library.movements.find((m) => m.target.unit === 'seconds');
  equal(F.basisLine({ basis: 'first_time' }, loaded), 'First time, starting weight');
  equal(F.basisLine({ basis: 'first_time' }, bw), 'First time, starting target');
  equal(F.basisLine({ basis: 'first_time' }, timed), 'First time, starting target');
});

test('format: rest clock and durations', () => {
  equal(F.formatClock(65), '1:05');
  equal(F.formatClock(59.2), '1:00');
  equal(F.formatClock(0.4), '0:01');
  equal(F.formatClock(-3), '0:00');
  equal(F.formatDuration(45), '45 sec');
  equal(F.formatDuration(48 * 60 + 10), '48 min');
  equal(F.formatDuration(65 * 60), '1 h 5 min');
});

test('format: every engine basis value has a plain line without em dashes', () => {
  BASIS_VALUES.forEach((b) => {
    const line = F.basisLine({ basis: b }, library.movements[0]);
    assert(line && line.length > 10, 'missing line for ' + b);
    assert(!EM_DASH.test(line), 'em dash in ' + b);
  });
  deepEqual(Object.keys(F.BASIS_TEXT).sort(), BASIS_VALUES.slice().sort(), 'no extra or missing basis keys');
  const bw = library.movements.find((m) => m.load.default_source === 'bodyweight');
  equal(F.basisLine({ basis: 'first_time' }, bw), F.BASIS_FIRST_TIME_BODYWEIGHT);
});

test('format: last-time line has date, weight, reps by round, and effort', () => {
  const last = { date: new Date(2026, 10, 9, 18, 0).toISOString(), weight_lb_per_dumbbell: 25, values_by_round: [10, 10, 10, 8], effort: 'hard_clean' };
  equal(F.formatLast(last, { unit: 'reps', per_side: false }), 'Nov 9: 25 lb, 10, 10, 10, 8 reps, hard but clean');
  const bw = { date: new Date(2026, 0, 2, 9, 0).toISOString(), weight_lb_per_dumbbell: null, values_by_round: [30, 30], effort: null };
  equal(F.formatLast(bw, { unit: 'seconds', per_side: true }), 'Jan 2: 30, 30 sec per side, no effort logged');
});

test('format: flag lines for adjusted, off_target, forced_repeat, suggest_variation, and a remapped weight', () => {
  const withId = library.movements.find((m) => m.harder_variation && m.harder_variation.id);
  const target = library.movements.find((m) => m.id === withId.harder_variation.id);
  const item = {
    target: { unit: 'reps', value: 10, per_side: false },
    load: { source: 'adjustable', weight_lb_per_dumbbell: 25, dumbbells: 2 },
    recommendation: { basis: 'top_weight_variation', weight_lb_per_dumbbell: 30, suggest_variation: { id: target.id }, remapped_from_lb: 27.5 },
    adjusted: { reason: 'block_setting', recommended_weight_lb: 30, rep_shift: 2 },
    forced_repeat: true,
    off_target: true,
  };
  const lines = F.flagLines(item, library, 'pull');
  equal(lines.length, 5);
  assert(lines[0].indexOf('27.5 lb') >= 0, lines[0]);
  equal(lines[1], 'Runs at the block setting of 25 lb instead of 30 lb, so 2 more reps');
  assert(lines[2].indexOf('30 lb') >= 0, lines[2]);
  equal(lines[3], 'Repeated from your last pull day because nothing else fits this slot');
  equal(lines[4], 'Harder variation to try: ' + target.name);
  item.adjusted = { reason: 'fixed_pair', recommended_weight_lb: 20, rep_shift: -2 };
  item.recommendation.suggest_variation = { name: 'Deficit version', how: 'Stand on a plate' };
  const l2 = F.flagLines(item, library, 'pull');
  equal(l2[1], 'Runs on the 25 lb pair instead of 20 lb, so 2 fewer reps');
  equal(l2[4], 'Harder variation to try: Deficit version. Stand on a plate');
  l2.concat(lines).forEach((l) => assert(!EM_DASH.test(l), 'em dash: ' + l));
});

test('format: estimate line notes over-length honestly', () => {
  deepEqual(F.estimateText({ estimate_sec: 2880, over_length_sec: 0, length_min: 50 }), { est: 'Estimated 48 min', over: null });
  equal(F.estimateText({ estimate_sec: 2040, over_length_sec: 240, length_min: 30 }).over,
    'This runs about 4 min over 30 min even after trimming.');
});

test('format: comparison text, with nothing to compare and with a comparison', () => {
  equal(F.comparisonText(null, 'hinge'), 'First hinge session logged, so there is nothing to compare yet.');
  equal(F.comparisonText({ sessions_compared: 3, average_lb: 2880, delta_lb: 120, delta_pct: 4.2 }, 'push'),
    '120 lb more than the average of your last 3 push sessions (2,880 lb), up 4.2%.');
  equal(F.comparisonText({ sessions_compared: 1, average_lb: 3000, delta_lb: -300, delta_pct: -10 }, 'pull'),
    '300 lb less than your last pull session (3,000 lb), down 10%.');
  equal(F.comparisonText({ sessions_compared: 2, average_lb: 1000, delta_lb: 0, delta_pct: 0 }, 'pull'),
    'Same volume as the average of your last 2 pull sessions (1,000 lb).');
});

test('format: effort labels and summary helpers', () => {
  deepEqual(F.EFFORT_ORDER, ['two_plus_left', 'hard_clean', 'barely']);
  deepEqual(F.EFFORT_ORDER.map((e) => F.EFFORT_SHORT[e]), ['2+ left', 'Hard, clean', 'Barely']);
  equal(F.effortLabel('barely'), 'Barely made it');
  equal(durationSec({ started_at: '2026-11-11T07:00:00.000Z', completed_at: '2026-11-11T07:48:30.000Z' }), 2910);
  equal(finisherStatus({ finisher: null }), 'none');
  equal(finisherStatus({ finisher: { done: true } }), 'done');
  equal(finisherStatus({ finisher: { done: false } }), 'skipped');
});
