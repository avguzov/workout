// Pure history statistics for the History and Progress screens. No DOM and no clock: the caller
// passes `now`. `sessions` is the stored completed history (chronological).

import { sessionVolume } from '../engine/index.js';

export const DAY_TYPES = ['push', 'hinge', 'pull'];

function toDate(now) {
  return now instanceof Date ? new Date(now.getTime()) : new Date(now);
}

// Local midnight of the Monday on or before `date`.
export function weekStart(date) {
  const d = toDate(date);
  const back = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
}

// Last `weeks` weeks ending with the week of `now`, oldest first, zero weeks included:
// [{ week_start: ISO of local Monday 00:00, count }]. Sessions are bucketed by `completed_at`;
// anything before the window or after the current week is left out.
export function weeklyCounts(sessions, now, weeks) {
  const n = weeks == null ? 8 : Math.max(0, Math.floor(weeks));
  const cur = weekStart(now);
  const starts = [];
  for (let i = n - 1; i >= -1; i--) {
    starts.push(new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() - 7 * i).getTime());
  }
  const out = [];
  for (let i = 0; i < n; i++) out.push({ week_start: new Date(starts[i]).toISOString(), count: 0 });
  (sessions || []).forEach((s) => {
    const t = s && s.completed_at ? Date.parse(s.completed_at) : NaN;
    if (!isFinite(t)) return;
    for (let i = 0; i < n; i++) {
      if (t >= starts[i] && t < starts[i + 1]) { out[i].count += 1; return; }
    }
  });
  return out;
}

// { push, hinge, pull }: [{ date, session_id, volume_lb }] in stored (chronological) order.
export function volumeByDayType(sessions) {
  const out = { push: [], hinge: [], pull: [] };
  (sessions || []).forEach((s) => {
    if (!s || !out[s.day_type]) return;
    out[s.day_type].push({ date: s.completed_at, session_id: s.id, volume_lb: sessionVolume(s).volume_lb });
  });
  return out;
}

function loggedRounds(item) {
  const rounds = item && item.logged && Array.isArray(item.logged.rounds) ? item.logged.rounds : [];
  return rounds.filter((r) => r && typeof r.value === 'number' && isFinite(r.value));
}

// The first item in a session for `movementId` with at least one logged round, or null.
function itemFor(session, movementId) {
  for (const b of session.blocks || []) {
    for (const it of b.items || []) {
      if (it && it.movement_id === movementId && loggedRounds(it).length) return it;
    }
  }
  return null;
}

// One entry per session where the movement has at least one logged round, chronological:
// { date, session_id, weight_lb_per_dumbbell (heaviest logged round, null for bodyweight), values,
//   best_value, unit, per_side, effort, load: the item load with the heaviest weight (formatLoad) }
export function movementHistory(sessions, movementId) {
  const out = [];
  (sessions || []).forEach((s) => {
    if (!s) return;
    const it = itemFor(s, movementId);
    if (!it) return;
    const rounds = loggedRounds(it);
    const weights = rounds.map((r) => r.weight_lb_per_dumbbell).filter((w) => typeof w === 'number' && isFinite(w));
    const weight = weights.length ? Math.max(...weights) : null;
    const values = rounds.map((r) => r.value);
    const target = it.target || {};
    const load = it.load || {};
    out.push({
      date: s.completed_at,
      session_id: s.id,
      weight_lb_per_dumbbell: weight,
      values,
      best_value: Math.max(...values),
      unit: target.unit === 'seconds' ? 'seconds' : 'reps',
      per_side: !!target.per_side,
      effort: (it.logged && it.logged.effort) || null,
      load: {
        source: weight == null ? 'bodyweight' : (load.source || 'fixed'),
        weight_lb_per_dumbbell: weight,
        dumbbells: load.dumbbells,
      },
    });
  });
  return out;
}

// Movements with at least one logged round: [{ movement_id, name, last_date }], most recent first
// (ties by name, then id). An id missing from the library uses the id as its name.
export function movementsWithHistory(sessions, library) {
  const names = new Map(((library && library.movements) || []).map((m) => [m.id, m.name]));
  const last = new Map();
  (sessions || []).forEach((s) => {
    if (!s) return;
    const t = Date.parse(s.completed_at);
    (s.blocks || []).forEach((b) => (b.items || []).forEach((it) => {
      if (!it || !it.movement_id || !loggedRounds(it).length) return;
      const prev = last.get(it.movement_id);
      if (!prev || (isFinite(t) && !(prev.t >= t))) last.set(it.movement_id, { t, date: s.completed_at });
    }));
  });
  const out = Array.from(last.entries()).map(([id, v]) => ({
    movement_id: id, name: names.get(id) || id, last_date: v.date, t: isFinite(v.t) ? v.t : -Infinity,
  }));
  out.sort((a, b) => (b.t - a.t) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.movement_id < b.movement_id ? -1 : 1));
  return out.map(({ movement_id, name, last_date }) => ({ movement_id, name, last_date }));
}
