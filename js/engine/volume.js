// Volume per item, block, and session (formula in data/README.md), plus the comparison
// with recent sessions of the same day type.
// Per item: weight x dumbbells x reps x (2 if per_side) x rounds. Bodyweight and timed count 0
// toward volume_lb; they are totalled separately as bodyweight_reps and timed_sec
// (per-side items count both sides). Logged rounds win over the plan when present.

function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

// itemVolume(item, plannedRounds) -> { movement_id, volume_lb, bodyweight_reps, timed_sec, rounds, basis }
export function itemVolume(item, plannedRounds) {
  const target = item.target || {};
  const load = item.load || {};
  const mult = target.per_side ? 2 : 1;
  const dumbbells = num(load.dumbbells);
  const bodyweight = load.source === 'bodyweight';
  const timed = target.unit === 'seconds';
  let rounds;
  let basis;
  if (item.logged && Array.isArray(item.logged.rounds)) {
    basis = 'logged';
    rounds = item.logged.rounds.map((r) => ({
      value: num(r.value),
      weight: r.weight_lb_per_dumbbell != null ? r.weight_lb_per_dumbbell : load.weight_lb_per_dumbbell,
    }));
  } else {
    basis = 'plan';
    rounds = [];
    for (let i = 0; i < num(plannedRounds); i++) {
      rounds.push({ value: num(target.value), weight: load.weight_lb_per_dumbbell });
    }
  }
  let volume = 0;
  let bwReps = 0;
  let timedSec = 0;
  rounds.forEach((r) => {
    if (timed) timedSec += r.value * mult;
    else if (bodyweight) bwReps += r.value * mult;
    else volume += num(r.weight) * dumbbells * r.value * mult;
  });
  return {
    movement_id: item.movement_id,
    volume_lb: volume,
    bodyweight_reps: bwReps,
    timed_sec: timedSec,
    rounds: rounds.length,
    basis,
  };
}

export function blockVolume(block) {
  const items = (block.items || []).map((it) => {
    const v = itemVolume(it, block.rounds);
    v.slot = it.slot;
    return v;
  });
  return {
    block: block.block,
    rounds: block.rounds,
    volume_lb: items.reduce((s, x) => s + x.volume_lb, 0),
    bodyweight_reps: items.reduce((s, x) => s + x.bodyweight_reps, 0),
    timed_sec: items.reduce((s, x) => s + x.timed_sec, 0),
    items,
  };
}

// sessionVolume(session) -> { volume_lb, bodyweight_reps, timed_sec, blocks: [...] }
// Warm-up and finisher are excluded.
export function sessionVolume(session) {
  const blocks = (session.blocks || []).map(blockVolume);
  return {
    session_id: session.id || null,
    volume_lb: blocks.reduce((s, b) => s + b.volume_lb, 0),
    bodyweight_reps: blocks.reduce((s, b) => s + b.bodyweight_reps, 0),
    timed_sec: blocks.reduce((s, b) => s + b.timed_sec, 0),
    blocks,
  };
}

// compareVolume(session, sessions, count = 3) -> null | comparison against the average of the
// last `count` completed sessions of the same day type (fewer when fewer exist).
export function compareVolume(session, sessions, count) {
  const n = count == null ? 3 : count;
  const pool = (sessions || []).filter((s) => s && s.completed_at && s.day_type === session.day_type &&
    s.id !== session.id);
  const recent = pool.slice(Math.max(0, pool.length - n));
  if (!recent.length) return null;
  const current = sessionVolume(session).volume_lb;
  const vols = recent.map((s) => sessionVolume(s).volume_lb);
  const avg = vols.reduce((a, b) => a + b, 0) / vols.length;
  return {
    day_type: session.day_type,
    volume_lb: current,
    average_lb: Math.round(avg * 10) / 10,
    sessions_compared: recent.length,
    compared_ids: recent.map((s) => s.id || null),
    delta_lb: Math.round((current - avg) * 10) / 10,
    delta_pct: avg > 0 ? Math.round(((current - avg) / avg) * 1000) / 10 : null,
  };
}
