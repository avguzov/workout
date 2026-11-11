// Time estimate (formula in data/README.md) and trim-to-length.

// Trim order. Block A is never touched and the finisher stays.
export const TRIM_STEPS = [
  { id: 'block_c_2_rounds', block: 'C', rounds: 2 },
  { id: 'block_b_3_rounds', block: 'B', rounds: 3 },
  { id: 'block_b_2_rounds', block: 'B', rounds: 2 },
  { id: 'block_c_removed', block: 'C', rounds: 0 },
];

export const ALLOWED_LENGTHS = [30, 40, 50, 60];

const byIdCache = new WeakMap();

function movementMap(library) {
  let m = byIdCache.get(library);
  if (!m) {
    m = new Map();
    library.movements.forEach((x) => m.set(x.id, x));
    byIdCache.set(library, m);
  }
  return m;
}

// estimateSec(library, session) uses the session's current rounds, blocks, and finisher.
// A block with rounds 0 (removed) does not count.
export function estimateSec(library, session) {
  const tm = library.timing;
  const byId = movementMap(library);
  let total = tm.warm_up_sec;
  let active = 0;
  (session.blocks || []).forEach((b) => {
    const r = b.rounds;
    if (!(r > 0)) return;
    active += 1;
    let spr = 0;
    (b.items || []).forEach((it) => {
      const mv = byId.get(it.movement_id);
      spr += mv ? mv.seconds_per_round : 0;
    });
    total += r * (spr + 2 * tm.transition_sec) + (r - 1) * tm.rest_between_rounds_sec[b.block];
  });
  const fin = session.finisher ? library.finishers.find((f) => f.id === session.finisher.id) : null;
  const gaps = Math.max(0, active - 1) + (fin ? 1 : 0);
  total += tm.between_blocks_sec * gaps;
  if (fin) total += fin.est_seconds;
  return total;
}

export function estimateMin(library, session) {
  return Math.round((estimateSec(library, session) / 60) * 10) / 10;
}

// trimToLength(library, session, lengthMin) -> new session. Starts from planned rounds, then
// trims in TRIM_STEPS order while the estimate is over the length and stops as soon as it fits.
// Sessions are never lengthened past their planned rounds.
export function trimToLength(library, session, lengthMin) {
  const s = Object.assign({}, session);
  s.blocks = (session.blocks || []).map((b) => {
    const planned = b.planned_rounds != null ? b.planned_rounds : b.rounds;
    return Object.assign({}, b, { rounds: planned, removed: false });
  });
  const limit = lengthMin * 60;
  const trims = [];
  let est = estimateSec(library, s);
  for (const step of TRIM_STEPS) {
    if (est <= limit) break;
    const b = s.blocks.find((x) => x.block === step.block);
    if (!b || b.rounds <= step.rounds) continue;
    const before = est;
    const from = b.rounds;
    b.rounds = step.rounds;
    b.removed = step.rounds === 0;
    est = estimateSec(library, s);
    trims.push({
      step: step.id,
      block: step.block,
      from_rounds: from,
      to_rounds: step.rounds,
      estimate_sec_before: before,
      estimate_sec_after: est,
    });
  }
  s.length_min = lengthMin;
  s.trims = trims;
  s.estimate_sec = est;
  s.over_length_sec = est > limit ? est - limit : 0;
  return s;
}
