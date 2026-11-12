// History statistics (js/app/stats.js): weekly counts with Monday weeks in local time, volume by
// day type, per-movement history, and the movements with history. Dates are built with local-time
// constructors so the tests pass in any timezone.

import { test, equal, assert, deepEqual } from './harness.js';
import { library, loggedSession, runChain, clone } from './helpers.js';
import { sessionVolume } from '../js/engine/index.js';
import { weeklyCounts, weekStart, volumeByDayType, movementHistory, movementsWithHistory } from '../js/app/stats.js';

const local = (...a) => new Date(...a).toISOString();
const done = (iso, dayType) => ({ id: 'w-' + iso, day_type: dayType || 'push', completed_at: iso, blocks: [] });

test('stats: weekStart is local Monday 00:00 for every day of the week', () => {
  const mon = new Date(2026, 10, 9).getTime();
  for (let d = 9; d <= 15; d++) {
    equal(weekStart(new Date(2026, 10, d, 23, 59, 59)).getTime(), mon, 'Nov ' + d);
  }
  equal(weekStart(new Date(2026, 10, 9, 0, 0, 0)).getTime(), mon, 'Monday at midnight');
  equal(weekStart(new Date(2026, 10, 8, 23, 59, 59)).getTime(), new Date(2026, 10, 2).getTime(), 'Sunday night is the week before');
});

test('stats: weeklyCounts gives exactly `weeks` entries, oldest first, zero weeks included', () => {
  const now = new Date(2026, 10, 11, 12, 0);
  const w = weeklyCounts([], now);
  equal(w.length, 8);
  w.forEach((x) => equal(x.count, 0));
  equal(new Date(w[0].week_start).getTime(), new Date(2026, 8, 21).getTime(), 'oldest week');
  equal(new Date(w[7].week_start).getTime(), new Date(2026, 10, 9).getTime(), 'this week');
  for (let i = 1; i < 8; i++) {
    const a = new Date(w[i - 1].week_start);
    const b = new Date(w[i].week_start);
    equal(b.getDay(), 1, 'Monday');
    equal(b.getHours(), 0, 'local midnight');
    assert(b > a, 'ascending');
  }
  equal(weeklyCounts([], now, 3).length, 3);
  equal(weeklyCounts([], now, 1).length, 1);
  deepEqual(weeklyCounts([], now, 0), []);
  equal(weeklyCounts([], now.toISOString(), 12).length, 12, 'ISO now');
});

test('stats: weeklyCounts buckets at the Monday boundary and leaves out sessions outside the window', () => {
  const now = new Date(2026, 10, 11, 12, 0);
  const sessions = [
    done(local(2026, 8, 20, 23, 59, 59)), // Sunday before the window
    done(local(2026, 8, 21, 0, 0, 0)), // first Monday of the window
    done(local(2026, 10, 2, 7, 0)),
    done(local(2026, 10, 8, 23, 59, 59)), // Sunday night: week of Nov 2
    done(local(2026, 10, 9, 0, 0, 0)), // Monday 00:00: this week
    done(local(2026, 10, 10, 18, 30)),
    done(local(2026, 10, 16, 0, 0, 0)), // next week: out
    { id: 'open', day_type: 'push', completed_at: null, blocks: [] },
    { id: 'bad', day_type: 'push', completed_at: 'not a date', blocks: [] },
  ];
  deepEqual(weeklyCounts(sessions, now).map((x) => x.count), [1, 0, 0, 0, 0, 0, 2, 2]);
  deepEqual(weeklyCounts(sessions, new Date(2026, 10, 9, 0, 0, 0)).map((x) => x.count), [1, 0, 0, 0, 0, 0, 2, 2], 'now at Monday midnight');
  deepEqual(weeklyCounts(sessions, new Date(2026, 10, 8, 23, 59, 59)).map((x) => x.count), [1, 1, 0, 0, 0, 0, 0, 2], 'now on Sunday night');
  deepEqual(weeklyCounts(sessions, now, 2).map((x) => x.count), [2, 2], 'two weeks');
});

test('stats: volumeByDayType equals sessionVolume for every session, in order', () => {
  const sessions = runChain({ equipment: library.default_equipment, lengthMin: 50, count: 7, seedPrefix: 'stats-volume' }).sessions;
  const by = volumeByDayType(sessions);
  deepEqual(Object.keys(by).sort(), ['hinge', 'pull', 'push']);
  let n = 0;
  ['push', 'hinge', 'pull'].forEach((dt) => {
    const want = sessions.filter((s) => s.day_type === dt);
    equal(by[dt].length, want.length, dt + ' count');
    by[dt].forEach((e, i) => {
      equal(e.session_id, want[i].id, dt + ' order');
      equal(e.date, want[i].completed_at, dt + ' date');
      equal(e.volume_lb, sessionVolume(want[i]).volume_lb, dt + ' volume');
      assert(e.volume_lb > 0, 'logged volume');
      n += 1;
    });
  });
  equal(n, sessions.length);
  deepEqual(volumeByDayType([]), { push: [], hinge: [], pull: [] });
});

function benchSessions() {
  const a = loggedSession({ dayType: 'push', completedAt: local(2026, 9, 1, 8), items: [
    { id: 'db-bench-press', weight: 40, target: 8, values: [8, 8, 7], effort: 'hard_clean' },
    { id: 't-push-up', weight: null, target: 10, values: [10, 9], effort: 'barely' },
  ] });
  a.blocks[0].items[0].logged.rounds[2].weight_lb_per_dumbbell = 45; // heaviest round wins
  const b = loggedSession({ dayType: 'push', completedAt: local(2026, 9, 8, 8), items: [
    { id: 'db-bench-press', weight: 45, target: 8, values: [8], effort: 'two_plus_left' },
    { id: 't-push-up', weight: null, target: 10, values: [], effort: null }, // unlogged: skipped
  ] });
  const c = loggedSession({ dayType: 'hinge', completedAt: local(2026, 9, 10, 8), items: [
    { id: 'plank', weight: null, target: 40, values: [40, 45], effort: null },
  ] });
  const d = clone(b);
  d.id = 'log-null';
  d.completed_at = local(2026, 9, 12, 8);
  d.blocks[0].items.forEach((it) => { it.logged = null; }); // never logged
  return [a, b, c, d];
}

test('stats: movementHistory gives heaviest weight, per-round values, and skips unlogged items', () => {
  const sessions = benchSessions();
  const bench = movementHistory(sessions, 'db-bench-press');
  equal(bench.length, 2);
  equal(bench[0].session_id, sessions[0].id);
  equal(bench[0].date, sessions[0].completed_at);
  equal(bench[0].weight_lb_per_dumbbell, 45);
  deepEqual(bench[0].values, [8, 8, 7]);
  equal(bench[0].best_value, 8);
  equal(bench[0].unit, 'reps');
  equal(bench[0].per_side, false);
  equal(bench[0].effort, 'hard_clean');
  deepEqual(bench[0].load, { source: 'fixed', weight_lb_per_dumbbell: 45, dumbbells: 2 });
  equal(bench[1].weight_lb_per_dumbbell, 45);
  deepEqual(bench[1].values, [8]);
  equal(bench[1].effort, 'two_plus_left');

  const push = movementHistory(sessions, 't-push-up');
  equal(push.length, 1, 'session with no logged rounds left out');
  equal(push[0].weight_lb_per_dumbbell, null, 'bodyweight');
  equal(push[0].load.source, 'bodyweight');
  deepEqual(push[0].values, [10, 9]);
  equal(push[0].best_value, 10);

  const plank = movementHistory(sessions, 'plank');
  equal(plank.length, 1);
  equal(plank[0].unit, 'seconds');
  equal(plank[0].best_value, 45);
  equal(plank[0].effort, null);
  deepEqual(movementHistory(sessions, 'no-such-movement'), []);
  deepEqual(movementHistory([], 'plank'), []);
});

test('stats: movementsWithHistory sorts by most recent and survives ids missing from the library', () => {
  const sessions = benchSessions();
  const odd = loggedSession({ dayType: 'pull', completedAt: local(2026, 9, 5, 8), items: [
    { id: 'db-bench-press', weight: 40, target: 8, values: [8], effort: 'hard_clean' },
  ] });
  odd.blocks[0].items[0].movement_id = 'imported-mystery';
  const all = sessions.slice(0, 1).concat([odd], sessions.slice(1));
  const list = movementsWithHistory(all, library);
  deepEqual(list.map((m) => m.movement_id), ['plank', 'db-bench-press', 'imported-mystery', 't-push-up']);
  equal(list[0].name, 'Plank');
  equal(list[0].last_date, sessions[2].completed_at);
  equal(list[1].last_date, sessions[1].completed_at, 'bench last logged Oct 8');
  equal(list[3].last_date, sessions[0].completed_at, 'push-up last logged Oct 1 (Oct 8 had no rounds)');
  const mystery = list.find((m) => m.movement_id === 'imported-mystery');
  equal(mystery.name, 'imported-mystery', 'id used as the name');
  deepEqual(movementsWithHistory([], library), []);
  equal(movementsWithHistory(all, null).length, 4, 'no library');
  equal(movementsWithHistory(all, { movements: [] })[0].name, 'plank');
});
