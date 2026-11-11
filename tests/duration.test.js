import { test, equal, assert, deepEqual } from './harness.js';
import { drafts, fixtureToSession, library } from './helpers.js';
import { estimateSec, estimateMin, trimToLength, TRIM_STEPS } from '../js/engine/index.js';

const expectedMin = { w1d1: 47.8, w1d2: 40.1, w1d3: 46.8, w2d1: 50.0, w2d2: 42.6, w2d3: 45.8 };

Object.keys(expectedMin).forEach((id) => {
  test('duration: ' + id + ' estimate is ' + expectedMin[id].toFixed(1) + ' min', () => {
    const s = fixtureToSession(drafts.find((d) => d.id === id));
    equal(estimateMin(library, s), expectedMin[id], id);
  });
});

const w1d1 = () => fixtureToSession(drafts.find((d) => d.id === 'w1d1'));

test('duration: no trim when the session fits (w1d1 at 50 min)', () => {
  const s = trimToLength(library, w1d1(), 50);
  equal(s.trims.length, 0);
  equal(s.estimate_sec, 2870);
  equal(s.over_length_sec, 0);
});

test('duration: trim step 1 only, Block C to 2 rounds (w1d1 at 45 min)', () => {
  const s = trimToLength(library, w1d1(), 45);
  deepEqual(s.trims.map((t) => t.step), ['block_c_2_rounds']);
  deepEqual(s.blocks.map((b) => b.rounds), [4, 4, 2]);
  equal(s.estimate_sec, 2685);
  assert(s.trims[0].estimate_sec_before > 2700, 'trimmed only while over');
});

test('duration: trim steps 1-2, Block B to 3 rounds (w1d1 at 43 min)', () => {
  const s = trimToLength(library, w1d1(), 43);
  deepEqual(s.trims.map((t) => t.step), ['block_c_2_rounds', 'block_b_3_rounds']);
  deepEqual(s.blocks.map((b) => b.rounds), [4, 3, 2]);
  equal(s.estimate_sec, 2510);
});

test('duration: trim steps 1-3, Block B to 2 rounds (w1d1 at 40 min)', () => {
  const s = trimToLength(library, w1d1(), 40);
  deepEqual(s.trims.map((t) => t.step), ['block_c_2_rounds', 'block_b_3_rounds', 'block_b_2_rounds']);
  deepEqual(s.blocks.map((b) => b.rounds), [4, 2, 2]);
  equal(s.estimate_sec, 2335);
  equal(s.over_length_sec, 0);
});

test('duration: trim steps 1-4, Block C removed, fits (w1d1 at 32 min)', () => {
  const s = trimToLength(library, w1d1(), 32);
  deepEqual(s.trims.map((t) => t.step), TRIM_STEPS.map((t) => t.id));
  deepEqual(s.blocks.map((b) => b.rounds), [4, 2, 0]);
  equal(s.blocks[2].removed, true);
  equal(s.estimate_sec, 1905);
  equal(s.over_length_sec, 0);
  equal(s.finisher.id, 'D', 'finisher stays');
  equal(s.blocks[0].rounds, 4, 'Block A untouched');
});

test('duration: over-length case sets over_length_sec (w1d1 at 30 min)', () => {
  const s = trimToLength(library, w1d1(), 30);
  equal(s.trims.length, 4);
  equal(s.estimate_sec, 1905);
  equal(s.over_length_sec, 105);
  equal(estimateSec(library, s), 1905);
});

test('duration: trimming never lengthens and restarts from planned rounds', () => {
  const s = trimToLength(library, w1d1(), 30);
  const back = trimToLength(library, s, 60);
  deepEqual(back.blocks.map((b) => b.rounds), [4, 4, 3]);
  equal(back.trims.length, 0);
  const hinge = trimToLength(library, fixtureToSession(drafts.find((d) => d.id === 'w1d2')), 30);
  assert(hinge.over_length_sec === 0, 'hinge day fits 30 min after trims');
  assert(hinge.blocks.every((b, i) => b.rounds <= [4, 4, 3][i]), 'never above planned');
});
