// Last performance lookup and next-time recommendation. Progress follows the movement,
// whichever day type or slot it was last logged in.

import { availableWeights, indexOfWeight, mapWeightDown, usesWeight } from './equipment.js';

export const EFFORTS = ['two_plus_left', 'hard_clean', 'barely'];

const EPS = 1e-6;

function isNum(v) {
  return typeof v === 'number' && isFinite(v);
}

function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

// Most recent logged appearance of a movement in `sessions` (chronological), or null.
export function lastPerformance(sessions, movementId) {
  if (!Array.isArray(sessions)) return null;
  for (let i = sessions.length - 1; i >= 0; i--) {
    const s = sessions[i];
    if (!s || !Array.isArray(s.blocks)) continue;
    for (const b of s.blocks) {
      for (const it of b.items || []) {
        if (it.movement_id !== movementId) continue;
        const lg = it.logged;
        if (!lg || !Array.isArray(lg.rounds) || !lg.rounds.length) continue;
        const lastRound = lg.rounds[lg.rounds.length - 1];
        const w = lastRound.weight_lb_per_dumbbell != null
          ? lastRound.weight_lb_per_dumbbell
          : (it.load ? it.load.weight_lb_per_dumbbell : null);
        return {
          date: s.completed_at || s.created_at || null,
          session_id: s.id || null,
          day_type: s.day_type || null,
          weight_lb_per_dumbbell: w == null ? null : w,
          target_value: it.target ? it.target.value : null,
          values_by_round: lg.rounds.map((r) => r.value),
          effort: lg.effort || null,
        };
      }
    }
  }
  return null;
}

// recommend({ library, equipment, sessions, movementId | movement }) -> recommendation
// basis values: first_time, step_down, short_repeat, weight_up, top_weight_reps,
// top_weight_variation, top_weight_hold, add_reps, add_time, hold_max, max_variation,
// max_hold, repeat
export function recommend({ library, equipment, sessions, movementId, movement }) {
  const mv = movement || library.movements.find((m) => m.id === movementId);
  if (!mv) throw new Error('Unknown movement: ' + movementId);
  const t = mv.target;
  const weighted = usesWeight(mv);
  const avail = weighted ? availableWeights(mv, equipment) : [];
  const last = lastPerformance(sessions, mv.id);
  const lastOut = clone(last);

  const out = (basis, weight, target, extra) => {
    const r = {
      basis,
      weight_lb_per_dumbbell: weighted ? (weight == null ? null : weight) : null,
      target_value: target,
      suggest_variation: null,
      last: lastOut,
    };
    if (extra) Object.keys(extra).forEach((k) => { r[k] = extra[k]; });
    return r;
  };

  // Rule 1: first time
  if (!last) {
    if (!weighted) return out('first_time', null, t.default);
    const w = mapWeightDown(avail, mv.load.default_weight_lb);
    const lighter = w !== null && isNum(mv.load.default_weight_lb) && w < mv.load.default_weight_lb - EPS;
    return out('first_time', w, lighter ? t.max : t.default);
  }

  let lastT = isNum(last.target_value) ? last.target_value : t.default;
  lastT = Math.min(Math.max(lastT, t.min), t.max);

  // Rule 8: last weight no longer available -> map it as in rule 1, then apply the rules
  let w0 = null;
  let extra = null;
  if (weighted) {
    const lw = last.weight_lb_per_dumbbell;
    if (indexOfWeight(avail, lw) >= 0) {
      w0 = avail[indexOfWeight(avail, lw)];
    } else {
      w0 = mapWeightDown(avail, isNum(lw) ? lw : mv.load.default_weight_lb);
      extra = { remapped_from_lb: isNum(lw) ? lw : null };
    }
  }
  const idx = weighted ? indexOfWeight(avail, w0) : -1;
  const lighterW = idx > 0 ? avail[idx - 1] : null;
  const heavierW = idx >= 0 && idx < avail.length - 1 ? avail[idx + 1] : null;

  const vals = last.values_by_round || [];
  const lastRound = vals.length ? vals[vals.length - 1] : null;

  // Rule 2: last round more than 2 reps short of that day's target
  if (t.unit === 'reps' && isNum(lastRound) && lastRound < lastT - 2) {
    if (weighted && lighterW !== null) return out('step_down', lighterW, lastT, extra);
    return out('short_repeat', w0, lastT, extra);
  }

  const effort = last.effort;
  const hv = mv.harder_variation || null;
  const variation = (prefix, w, target) => {
    const e = Object.assign({}, extra || {}, { suggest_variation: clone(hv) });
    return out(hv ? prefix + '_variation' : prefix + '_hold', w, target, e);
  };
  // Rule 4 increment: +1 when per side or under 10, otherwise +2; never above max
  const ruleFour = (w) => {
    if (lastT >= t.max) return out('hold_max', w, t.max, extra);
    const inc = (t.per_side || lastT < 10) ? 1 : 2;
    return out('add_reps', w, Math.min(lastT + inc, t.max), extra);
  };
  const repeat = () => out('repeat', w0, lastT, extra);

  switch (mv.progression) {
    case 'load':
      if (effort === 'two_plus_left') {
        if (heavierW !== null) return out('weight_up', heavierW, t.default, extra);
        if (lastT < t.max) return out('top_weight_reps', w0, Math.min(lastT + 2, t.max), extra);
        return variation('top_weight', w0, t.max);
      }
      if (effort === 'hard_clean') return ruleFour(w0);
      return repeat();
    case 'light':
      if (effort === 'two_plus_left') {
        if (lastT < t.max) return out('add_reps', w0, Math.min(lastT + 2, t.max), extra);
        if (heavierW !== null) return out('weight_up', heavierW, t.default, extra);
        return variation('top_weight', w0, t.max);
      }
      if (effort === 'hard_clean') return ruleFour(w0);
      return repeat();
    case 'bodyweight':
      if (effort === 'two_plus_left') {
        if (lastT < t.max) return out('add_reps', w0, Math.min(lastT + 2, t.max), extra);
        return variation('max', w0, t.max);
      }
      if (effort === 'hard_clean') {
        if (lastT >= t.max) return out('hold_max', w0, t.max, extra);
        return out('add_reps', w0, Math.min(lastT + 1, t.max), extra);
      }
      return repeat();
    case 'timed':
      if (effort === 'two_plus_left') {
        if (lastT < t.max) return out('add_time', w0, Math.min(lastT + 10, t.max), extra);
        return variation('max', w0, t.max);
      }
      if (effort === 'hard_clean') {
        if (lastT >= t.max) return out('hold_max', w0, t.max, extra);
        return out('add_time', w0, Math.min(lastT + 5, t.max), extra);
      }
      return repeat();
    default:
      return repeat();
  }
}
