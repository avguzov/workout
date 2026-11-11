import { test, equal, assert } from './harness.js';
import { drafts, fixtureToSession, clone } from './helpers.js';
import { sessionVolume, itemVolume, compareVolume } from '../js/engine/index.js';

drafts.forEach((fx) => {
  test('volume: ' + fx.id + ' equals ' + fx.expected_volume_lb, () => {
    equal(sessionVolume(fixtureToSession(fx)).volume_lb, fx.expected_volume_lb, fx.id);
  });
});

test('volume: w1d1 is 15,280 lb', () => {
  const fx = drafts.find((d) => d.id === 'w1d1');
  equal(sessionVolume(fixtureToSession(fx)).volume_lb, 15280);
});

test('volume: per-side multiplier and dumbbell count (1-Arm DB Row 45 x 10/side x 4 = 3,600)', () => {
  const s = fixtureToSession(drafts.find((d) => d.id === 'w1d1'));
  equal(itemVolume(s.blocks[0].items[1], 4).volume_lb, 3600);
  equal(itemVolume(s.blocks[0].items[0], 4).volume_lb, 2880, 'bench 45 x 2 x 8 x 4');
});

test('volume: logged rounds replace the plan', () => {
  const s = fixtureToSession(drafts.find((d) => d.id === 'w1d1'));
  const bench = s.blocks[0].items[0];
  bench.logged = {
    rounds: [8, 8, 8, 6].map((v) => ({ value: v, weight_lb_per_dumbbell: 45 })),
    effort: 'hard_clean',
  };
  const v = itemVolume(bench, 4);
  equal(v.basis, 'logged');
  equal(v.volume_lb, 45 * 2 * 30, 'bench logged');
  // mixed weights per round
  bench.logged.rounds = [{ value: 8, weight_lb_per_dumbbell: 50 }, { value: 8, weight_lb_per_dumbbell: 45 }];
  equal(itemVolume(bench, 4).volume_lb, 50 * 2 * 8 + 45 * 2 * 8, 'per-round weights');
  const total = sessionVolume(s).volume_lb;
  equal(total, 15280 - 2880 + 1520, 'session uses logged item');
});

test('volume: per-item and per-block sums add up', () => {
  drafts.forEach((fx) => {
    const v = sessionVolume(fixtureToSession(fx));
    let sum = 0;
    v.blocks.forEach((b) => {
      const items = b.items.reduce((a, x) => a + x.volume_lb, 0);
      equal(b.volume_lb, items, fx.id + ' block ' + b.block);
      sum += b.volume_lb;
    });
    equal(v.volume_lb, sum, fx.id + ' session');
    equal(v.blocks.length, 3);
  });
  const w1d1 = sessionVolume(fixtureToSession(drafts.find((d) => d.id === 'w1d1')));
  equal(w1d1.blocks[0].volume_lb, 2880 + 3600 + 1800, 'w1d1 block A');
  equal(w1d1.blocks[1].volume_lb, 3600 + 0 + 1600, 'w1d1 block B');
  equal(w1d1.blocks[2].volume_lb, 1080 + 720 + 0, 'w1d1 block C');
});

test('volume: bodyweight reps and timed seconds are separate totals', () => {
  const w1d1 = sessionVolume(fixtureToSession(drafts.find((d) => d.id === 'w1d1')));
  equal(w1d1.bodyweight_reps, 8 * 4, 'T-push-up 8 x 4');
  equal(w1d1.timed_sec, 60 * 3, 'plank 60 x 3');
  const w1d2 = sessionVolume(fixtureToSession(drafts.find((d) => d.id === 'w1d2')));
  equal(w1d2.bodyweight_reps, 10 * 4 + 10 * 2 * 4, 'decline push-up + dead bug per side');
  equal(w1d2.timed_sec, 30 * 2 * 3, 'side plank per side');
  // weighted dead bug moves no dumbbell: 0 lb, and it is not a bodyweight item
  const w2d2 = sessionVolume(fixtureToSession(drafts.find((d) => d.id === 'w2d2')));
  equal(w2d2.blocks[1].items[2].volume_lb, 0, 'weighted dead bug volume');
  equal(w2d2.blocks[1].items[2].bodyweight_reps, 0, 'weighted dead bug bodyweight reps');
  equal(w2d2.timed_sec, 30 * 2 * 4 + 30 * 3, 'suitcase carry per side + hollow hold');
});

test('volume: comparison with the last three sessions of the same day type', () => {
  const done = (fx, i) => {
    const s = fixtureToSession(fx);
    s.id = fx.id + '-' + i;
    s.completed_at = '2026-01-0' + (i + 1) + 'T08:00:00.000Z';
    return s;
  };
  const w1d1 = drafts.find((d) => d.id === 'w1d1');
  const w2d1 = drafts.find((d) => d.id === 'w2d1');
  const w1d2 = drafts.find((d) => d.id === 'w1d2');
  const current = fixtureToSession(w1d1);
  current.id = 'current';
  equal(compareVolume(current, []), null, 'no history');
  equal(compareVolume(current, [done(w1d2, 0)]), null, 'no push history');
  const two = compareVolume(current, [done(w1d1, 0), done(w1d2, 1), done(w2d1, 2)]);
  equal(two.sessions_compared, 2);
  equal(two.average_lb, (15280 + 18400) / 2);
  equal(two.delta_lb, 15280 - 16840);
  // four push sessions: only the last three count
  const heavy = clone(w2d1);
  const hist = [done(w1d1, 0), done(w1d1, 1), done(w2d1, 2), done(heavy, 3), done(w1d2, 4)];
  const three = compareVolume(current, hist);
  equal(three.sessions_compared, 3);
  equal(three.average_lb, Math.round(((15280 + 18400 + 18400) / 3) * 10) / 10);
  assert(three.compared_ids.indexOf('w1d1-0') < 0, 'oldest push session dropped');
});
