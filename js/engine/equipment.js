// Equipment rules: eligibility, available weights, weight source, and one-step moves.
// Every limit comes from the equipment profile; nothing about the user's gear is assumed.

const EPS = 1e-6;

function isNum(v) {
  return typeof v === 'number' && isFinite(v);
}

function roundW(v) {
  return Math.round(v * 1000) / 1000;
}

export function sameWeight(a, b) {
  return isNum(a) && isNum(b) && Math.abs(a - b) < EPS;
}

export function indexOfWeight(list, w) {
  if (!isNum(w)) return -1;
  for (let i = 0; i < list.length; i++) if (Math.abs(list[i] - w) < EPS) return i;
  return -1;
}

function sortUnique(list) {
  const out = [];
  list.slice().sort((a, b) => a - b).forEach((v) => {
    if (!out.length || Math.abs(out[out.length - 1] - v) >= EPS) out.push(v);
  });
  return out;
}

export function fixedPairs(equipment) {
  const raw = equipment && Array.isArray(equipment.fixed_pairs_lb) ? equipment.fixed_pairs_lb : [];
  return sortUnique(raw.filter(isNum).map(roundW));
}

export function hasAdjustable(equipment) {
  const a = equipment && equipment.adjustable;
  return !!(a && a.present && isNum(a.min_lb) && isNum(a.max_lb) && isNum(a.step_lb) &&
    a.step_lb > 0 && a.max_lb >= a.min_lb);
}

// Every adjustable setting from min_lb to max_lb in step_lb steps.
export function adjustableSettings(equipment) {
  if (!hasAdjustable(equipment)) return [];
  const a = equipment.adjustable;
  const n = Math.floor((a.max_lb - a.min_lb) / a.step_lb + EPS);
  const out = [];
  for (let i = 0; i <= n; i++) out.push(roundW(a.min_lb + i * a.step_lb));
  return out;
}

export function hasDumbbells(equipment) {
  return hasAdjustable(equipment) || fixedPairs(equipment).length > 0;
}

// Every weight the equipment can make (fixed pairs and adjustable settings).
export function equipmentWeights(equipment) {
  return sortUnique(fixedPairs(equipment).concat(adjustableSettings(equipment)));
}

// True when the movement is loaded with a dumbbell (bodyweight movements are not).
export function usesWeight(movement) {
  return movement.load.default_source !== 'bodyweight';
}

// Eligibility rule from data/README.md.
export function isEligible(movement, slotRoles, equipment) {
  if (!movement.roles.some((r) => slotRoles.indexOf(r) >= 0)) return false;
  const need = (movement.equipment && movement.equipment.bench) || 'none';
  const bench = (equipment && equipment.bench) || {};
  if ((need === 'flat' || need === 'incline') && !bench.present) return false;
  if (need === 'incline' && !bench.incline) return false;
  const needsDb = movement.load.dumbbells > 0 || movement.load.default_source !== 'bodyweight';
  if (needsDb && !hasDumbbells(equipment)) return false;
  if (movement.load.fixed_only && fixedPairs(equipment).length === 0) return false;
  return true;
}

// Sorted weights this movement can use: fixed pairs plus adjustable settings,
// fixed pairs only when the movement is fixed_only, none for bodyweight movements.
export function availableWeights(movement, equipment) {
  if (!usesWeight(movement)) return [];
  const fixed = fixedPairs(equipment);
  if (movement.load.fixed_only) return fixed;
  return sortUnique(fixed.concat(adjustableSettings(equipment)));
}

export function isWeightAvailable(movement, equipment, weight) {
  return indexOfWeight(availableWeights(movement, equipment), weight) >= 0;
}

// fixed when that weight exists as a fixed pair, otherwise adjustable.
export function weightSource(weight, equipment) {
  if (weight == null) return 'bodyweight';
  return indexOfWeight(fixedPairs(equipment), weight) >= 0 ? 'fixed' : 'adjustable';
}

// One step = one position in the movement's sorted available-weights list.
export function nextWeight(movement, equipment, weight) {
  const list = availableWeights(movement, equipment);
  for (let i = 0; i < list.length; i++) if (list[i] > weight + EPS) return list[i];
  return null;
}

export function previousWeight(movement, equipment, weight) {
  const list = availableWeights(movement, equipment);
  for (let i = list.length - 1; i >= 0; i--) if (list[i] < weight - EPS) return list[i];
  return null;
}

// Nearest weight at or below w; the lightest one when none is at or below.
export function mapWeightDown(list, w) {
  if (!list.length) return null;
  if (!isNum(w)) return list[0];
  let best = null;
  for (let i = 0; i < list.length; i++) if (list[i] <= w + EPS) best = list[i];
  return best !== null ? best : list[0];
}

export function mapToAvailable(movement, equipment, weight) {
  return mapWeightDown(availableWeights(movement, equipment), weight);
}

// Number of positions between two weights in the movement's list (Infinity if either is missing).
export function stepDistance(movement, equipment, a, b) {
  const list = availableWeights(movement, equipment);
  const i = indexOfWeight(list, a);
  const j = indexOfWeight(list, b);
  if (i < 0 || j < 0) return Infinity;
  return Math.abs(i - j);
}
