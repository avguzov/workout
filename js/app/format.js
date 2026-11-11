// Pure formatting helpers for the screens. No DOM, no clock.

export const EFFORT_LABELS = {
  two_plus_left: '2 or more left',
  hard_clean: 'Hard but clean',
  barely: 'Barely made it',
};
export const EFFORT_ORDER = ['two_plus_left', 'hard_clean', 'barely'];
// Button labels on the effort screen, short enough for three in one row at 375 px.
export const EFFORT_SHORT = {
  two_plus_left: '2+ left',
  hard_clean: 'Hard, clean',
  barely: 'Barely',
};

const DAY_LABELS = { push: 'Push', hinge: 'Hinge', pull: 'Pull' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// One plain line per recommendation basis value in the engine README.
export const BASIS_TEXT = {
  first_time: 'First time, starting weight',
  step_down: 'Last round came up more than 2 short, so one step lighter',
  short_repeat: 'Last round came up short and nothing lighter fits, so the same again',
  weight_up: '2 or more left last time, so one step heavier',
  top_weight_reps: '2 or more left at your heaviest weight, so more reps',
  top_weight_variation: 'Heaviest weight at the top of the range, so try the harder variation',
  top_weight_hold: 'Heaviest weight at the top of the range with no harder variation, so hold here',
  add_reps: 'Clean last time, so a few more reps',
  add_time: 'Clean last time, so a little more time',
  hold_max: 'Already at the top of the range, so hold',
  max_variation: 'At the top of the range, so try the harder variation',
  max_hold: 'At the top of the range with no harder variation, so hold',
  repeat: 'Same weight and target as last time',
};
// first_time for bodyweight and timed movements.
export const BASIS_FIRST_TIME_BODYWEIGHT = 'First time, starting target';

export function dayLabel(dayType) {
  return DAY_LABELS[dayType] || String(dayType || '');
}

// 2880 -> "2,880"; 12.5 -> "12.5"; at most one decimal.
export function formatNumber(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '0';
  const r = Math.round(n * 10) / 10;
  const neg = r < 0;
  const abs = Math.abs(r);
  const whole = Math.floor(abs);
  const frac = Math.round((abs - whole) * 10);
  const digits = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + digits + (frac ? '.' + frac : '');
}

export function formatWeight(w) {
  return w == null ? 'Bodyweight' : formatNumber(w) + ' lb';
}

export function unitWord(unit, value) {
  if (unit === 'seconds') return 'sec';
  return value === 1 ? 'rep' : 'reps';
}

// (10, 'reps', false) -> "10 reps"; (8, 'reps', true) -> "8 reps per side"; (40, 'seconds') -> "40 sec"
export function formatValue(value, unit, perSide) {
  return formatNumber(value) + ' ' + unitWord(unit, value) + (perSide ? ' per side' : '');
}

export function formatTarget(target) {
  if (!target) return '';
  return formatValue(target.value, target.unit, target.per_side);
}

// The one load formatter. Always states the dumbbell count (load.dumbbells, at least 1 when a
// weight is set): "2 x 45 lb adjustable", "1 x 30 lb adjustable", "2 x 25 lb", "1 x 15 lb",
// "bodyweight". opts.short drops " adjustable" (the Confirm button).
export function formatLoad(load, opts) {
  if (!load || load.source === 'bodyweight' || load.weight_lb_per_dumbbell == null) return 'bodyweight';
  const n = load.dumbbells >= 1 ? load.dumbbells : 1;
  const base = n + ' x ' + formatWeight(load.weight_lb_per_dumbbell);
  return load.source === 'adjustable' && !(opts && opts.short) ? base + ' adjustable' : base;
}

// Target and planned load on one line: "8 reps per side, 2 x 45 lb adjustable", "6 reps, 2 x 25 lb",
// "10 reps, bodyweight", "60 sec, bodyweight"
export function formatPlan(target, load) {
  return formatTarget(target) + ', ' + formatLoad(load);
}

// Confirm button: "Confirm 8 reps, 2 x 45 lb", "Confirm 60 sec, bodyweight". Leaves out "per side"
// and "adjustable" so it stays on one line at 375 px; the weight is the entry's (it can be edited).
export function confirmLabel(entry, item) {
  const load = Object.assign({}, item.load, { weight_lb_per_dumbbell: entry.weight == null ? null : entry.weight });
  return 'Confirm ' + formatValue(entry.value, item.target.unit, false) + ', ' + formatLoad(load, { short: true });
}

// Confirmed-round chip: "10 @ 30", "10" (bodyweight), "60 sec", "30 sec @ 50" (timed with a weight)
export function chipText(round, unit) {
  const v = formatNumber(round.value) + (unit === 'seconds' ? ' sec' : '');
  return round.weight_lb_per_dumbbell == null ? v : v + ' @ ' + formatNumber(round.weight_lb_per_dumbbell);
}

// ISO -> "Nov 9" in local time.
export function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return MONTHS[d.getMonth()] + ' ' + d.getDate();
}

// Seconds -> "1:05" (rest clock). Negative counts as 0.
export function formatClock(sec) {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ':' + (r < 10 ? '0' : '') + r;
}

// Seconds -> "48 min" or "1 h 5 min"; under a minute -> "45 sec".
export function formatDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return s + ' sec';
  const min = Math.round(s / 60);
  if (min < 60) return min + ' min';
  return Math.floor(min / 60) + ' h ' + (min % 60) + ' min';
}

export function effortLabel(effort) {
  return EFFORT_LABELS[effort] || 'No effort logged';
}

// recommendation.last -> "Nov 9: 25 lb, 10, 10, 10, 8 reps, hard but clean"
export function formatLast(last, target) {
  if (!last) return '';
  const unit = target ? target.unit : 'reps';
  const parts = [];
  if (last.weight_lb_per_dumbbell != null) parts.push(formatWeight(last.weight_lb_per_dumbbell));
  const vals = (last.values_by_round || []).map(formatNumber).join(', ');
  parts.push(vals + ' ' + (unit === 'seconds' ? 'sec' : 'reps') + (target && target.per_side ? ' per side' : ''));
  parts.push(last.effort ? EFFORT_LABELS[last.effort].toLowerCase() : 'no effort logged');
  const date = last.date ? formatDate(last.date) : '';
  return (date ? date + ': ' : '') + parts.join(', ');
}

export function basisLine(recommendation, movement) {
  if (!recommendation) return '';
  const targetOnly = movement && ((movement.load && movement.load.default_source === 'bodyweight') ||
    (movement.target && movement.target.unit === 'seconds'));
  if (recommendation.basis === 'first_time' && targetOnly) {
    return BASIS_FIRST_TIME_BODYWEIGHT;
  }
  return BASIS_TEXT[recommendation.basis] || '';
}

function shiftText(shift, unit) {
  if (!shift) return 'same target';
  const word = unit === 'seconds' ? 'sec' : (Math.abs(shift) === 1 ? 'rep' : 'reps');
  return Math.abs(shift) + ' ' + (shift > 0 ? 'more' : 'fewer') + ' ' + word;
}

// Extra lines for an item: adjusted, forced_repeat, off_target, suggest_variation, remapped weight.
export function flagLines(item, library, dayType) {
  const out = [];
  const rec = item.recommendation || {};
  const unit = item.target ? item.target.unit : 'reps';
  if (rec.remapped_from_lb != null) {
    out.push('Last weight of ' + formatWeight(rec.remapped_from_lb) + ' is not in your equipment, so it maps to ' +
      formatWeight(rec.weight_lb_per_dumbbell));
  }
  if (item.adjusted) {
    const a = item.adjusted;
    const w = formatWeight(item.load ? item.load.weight_lb_per_dumbbell : null);
    const rw = formatWeight(a.recommended_weight_lb);
    if (a.reason === 'block_setting') {
      out.push('Runs at the block setting of ' + w + ' instead of ' + rw + ', so ' + shiftText(a.rep_shift, unit));
    } else {
      out.push('Runs on the ' + w + ' pair instead of ' + rw + ', so ' + shiftText(a.rep_shift, unit));
    }
  }
  if (item.off_target) {
    out.push('Nothing close to the recommended ' + formatWeight(rec.weight_lb_per_dumbbell) +
      ', so the nearest lighter pair at the top of the range');
  }
  if (item.forced_repeat) {
    out.push('Repeated from your last ' + dayLabel(dayType).toLowerCase() + ' day because nothing else fits this slot');
  }
  const v = rec.suggest_variation;
  if (v) {
    if (v.id) {
      const mv = library && library.movements.find((m) => m.id === v.id);
      out.push('Harder variation to try: ' + (mv ? mv.name : v.id));
    } else if (v.name) {
      out.push('Harder variation to try: ' + v.name + (v.how ? '. ' + v.how : ''));
    }
  }
  return out;
}

// Estimate line and an honest over-length note.
export function estimateText(session) {
  const est = 'Estimated ' + formatDuration(session.estimate_sec || 0);
  let over = null;
  if (session.over_length_sec > 0) {
    over = 'This runs about ' + formatDuration(session.over_length_sec) + ' over ' + session.length_min +
      ' min even after trimming.';
  }
  return { est, over };
}

// compareVolume result -> one plain sentence.
export function comparisonText(cmp, dayType) {
  const day = dayLabel(dayType).toLowerCase();
  if (!cmp) return 'First ' + day + ' session logged, so there is nothing to compare yet.';
  const ref = cmp.sessions_compared === 1
    ? 'your last ' + day + ' session'
    : 'the average of your last ' + cmp.sessions_compared + ' ' + day + ' sessions';
  const refVol = ' (' + formatNumber(cmp.average_lb) + ' lb)';
  if (cmp.delta_lb === 0) return 'Same volume as ' + ref + refVol + '.';
  const pct = cmp.delta_pct == null ? '' : ', ' + (cmp.delta_lb > 0 ? 'up ' : 'down ') + formatNumber(Math.abs(cmp.delta_pct)) + '%';
  return formatNumber(Math.abs(cmp.delta_lb)) + ' lb ' + (cmp.delta_lb > 0 ? 'more' : 'less') + ' than ' + ref + refVol + pct + '.';
}

// Zero-based round -> "Round 2 of 4"
export function roundLabel(round, rounds) {
  return 'Round ' + (round + 1) + ' of ' + rounds;
}
