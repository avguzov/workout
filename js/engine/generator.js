// Session generator: generateSession, reroll, nextDayType, plus the shared session rules
// (patterns, template order, finisher rules) that the validator reuses.
//
// Search: per block, enumerate every slot combination and every block adjustable setting;
// then pick one option per block minimising, in order:
//   [swaps (autoPickSwaps false only), forced repeats, off_target items,
//    distinct adjustable settings in the session, least-recently-done ranks slot by slot
//    (A1..C3, ties pre-broken by the seeded PRNG), adjusted items]
// Hard rules (roles, eligibility, no duplicates, one setting per block, available weights,
// two per-side items in Block A, six patterns) are never relaxed.

import { makeRng, toSeed, hashString } from './rng.js';
import {
  isEligible, availableWeights, fixedPairs, adjustableSettings, hasAdjustable, usesWeight,
  indexOfWeight, mapWeightDown, equipmentWeights, sameWeight,
} from './equipment.js';
import { recommend } from './recommend.js';
import { trimToLength } from './duration.js';

export const REQUIRED_PATTERNS = [
  { id: 'squat_or_lunge', any: ['squat', 'lunge'] },
  { id: 'hinge', any: ['hinge'] },
  { id: 'push', any: ['push'] },
  { id: 'pull', any: ['pull'] },
  { id: 'accessory', any: ['accessory'] },
  { id: 'core', any: ['core'] },
];
export const MAX_PER_SIDE_BLOCK_A = 2;
export const ADJUST_REP_SHIFT = 2;

function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function cmpArr(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function addArr(a, b) {
  return a.map((x, i) => x + (b[i] || 0));
}

function toIso(now) {
  if (now == null) return null;
  const d = now instanceof Date ? now : new Date(now);
  return isNaN(d.getTime()) ? String(now) : d.toISOString();
}

// ---------------------------------------------------------------- shared session rules

export function activeItems(session) {
  const out = [];
  (session.blocks || []).forEach((b) => { if (b.rounds > 0) (b.items || []).forEach((it) => out.push(it)); });
  return out;
}

export function allItems(session) {
  const out = [];
  (session.blocks || []).forEach((b) => (b.items || []).forEach((it) => out.push(it)));
  return out;
}

export function sessionPatterns(library, session) {
  const byId = new Map(library.movements.map((m) => [m.id, m]));
  const set = new Set();
  allItems(session).forEach((it) => {
    const mv = byId.get(it.movement_id);
    if (mv) mv.patterns.forEach((p) => set.add(p));
  });
  return set;
}

export function missingPatterns(patternSet) {
  return REQUIRED_PATTERNS.filter((r) => !r.any.some((p) => patternSet.has(p))).map((r) => r.id);
}

export function dayTypeOrder(library) {
  const order = [];
  ((library && library.slot_templates) || []).forEach((t) => {
    if (order.indexOf(t.day_type) < 0) order.push(t.day_type);
  });
  return order.length ? order : ['push', 'hinge', 'pull'];
}

// Next day type after the last completed session's (push first). Calendar gaps do not matter.
export function nextDayType(sessions, library) {
  const order = dayTypeOrder(library);
  const last = sessions && sessions.length ? sessions[sessions.length - 1] : null;
  if (!last) return order[0];
  const i = order.indexOf(last.day_type);
  return order[(i + 1) % order.length];
}

export function lastOfDayType(sessions, dayType) {
  for (let i = (sessions || []).length - 1; i >= 0; i--) if (sessions[i].day_type === dayType) return sessions[i];
  return null;
}

// For a day type with two templates, the one not used by the last session of that day type.
export function pickTemplate(library, sessions, dayType) {
  const tpls = library.slot_templates.filter((t) => t.day_type === dayType);
  if (!tpls.length) throw new Error('No template for day type ' + dayType);
  if (tpls.length === 1) return tpls[0];
  const last = lastOfDayType(sessions, dayType);
  if (!last) return tpls[0];
  const i = tpls.findIndex((t) => t.id === last.template_id);
  return tpls[(i + 1) % tpls.length];
}

// Adjustable setting finisher C reuses: the heaviest setting of an active block; when no block
// used the adjustable, the heaviest weight in the session mapped down to an adjustable setting.
export function finisherSetting(equipment, session) {
  const adj = adjustableSettings(equipment);
  const settings = (session.blocks || [])
    .filter((b) => b.rounds > 0 && b.adjustable_setting_lb != null)
    .map((b) => b.adjustable_setting_lb);
  if (settings.length) return { weight: Math.max.apply(null, settings), basis: 'session_setting' };
  let heaviest = null;
  activeItems(session).forEach((it) => {
    const w = it.load ? it.load.weight_lb_per_dumbbell : null;
    if (w != null && (heaviest === null || w > heaviest)) heaviest = w;
  });
  return { weight: heaviest === null ? (adj.length ? adj[0] : null) : mapWeightDown(adj, heaviest), basis: 'heaviest_item' };
}

// Finisher rule check for every finisher of the session's day type.
// -> [{ id, finisher, ok, reason, weight, basis }]
export function finisherOptions(library, equipment, session) {
  const pats = sessionPatterns(library, session);
  return library.finishers.filter((f) => f.day_types.indexOf(session.day_type) >= 0).map((f) => {
    const base = { id: f.id, finisher: f, ok: false, reason: '', weight: null, basis: null };
    const excl = (f.excluded_when_session_has || []).find((p) => pats.has(p));
    if (excl) return Object.assign(base, { reason: 'session has a ' + excl + ' movement' });
    if (f.requires_adjustable || (f.load && f.load.uses_session_adjustable)) {
      if (!hasAdjustable(equipment)) return Object.assign(base, { reason: 'needs the adjustable pair' });
      const st = finisherSetting(equipment, session);
      return Object.assign(base, { ok: true, weight: st.weight, basis: st.basis });
    }
    if (!f.load || f.load.source === 'bodyweight' || f.load.weight_lb_per_dumbbell == null) {
      return Object.assign(base, { ok: true, weight: null, basis: 'bodyweight' });
    }
    const avail = equipmentWeights(equipment);
    const below = avail.filter((w) => w <= f.load.weight_lb_per_dumbbell + 1e-6);
    if (!below.length) return Object.assign(base, { reason: 'no weight at or below ' + f.load.weight_lb_per_dumbbell + ' lb' });
    const w = below[below.length - 1];
    return Object.assign(base, {
      ok: true, weight: w, basis: sameWeight(w, f.load.weight_lb_per_dumbbell) ? 'library_weight' : 'nearest_below',
    });
  });
}

// ---------------------------------------------------------------- context and candidates

function buildContext({ library, equipment, sessions, dayType, seedInt, autoPickSwaps }) {
  const rng = makeRng(seedInt);
  const byId = new Map(library.movements.map((m) => [m.id, m]));
  const lastDone = new Map();
  sessions.forEach((s, i) => activeItems(s).forEach((it) => lastDone.set(it.movement_id, i)));
  const lastSame = lastOfDayType(sessions, dayType);
  const repeatIds = new Set(lastSame ? activeItems(lastSame).map((it) => it.movement_id) : []);
  const tie = new Map();
  library.movements.forEach((m) => tie.set(m.id, rng()));
  const finTie = new Map();
  library.finishers.forEach((f) => finTie.set(f.id, rng()));
  return {
    library, equipment, sessions, dayType, byId, lastDone, repeatIds, tie, finTie,
    autoPickSwaps: autoPickSwaps !== false,
    fixed: fixedPairs(equipment),
    adj: adjustableSettings(equipment),
    placements: new Map(),
  };
}

// How a movement can be loaded: bodyweight, at a fixed pair, or on the adjustable.
function placement(ctx, mv) {
  if (ctx.placements.has(mv.id)) return ctx.placements.get(mv.id);
  const rec = recommend({ library: ctx.library, equipment: ctx.equipment, sessions: ctx.sessions, movement: mv });
  let pl;
  const W = rec.weight_lb_per_dumbbell;
  if (!usesWeight(mv) || W == null) {
    pl = { kind: usesWeight(mv) ? 'none' : 'bw', rec };
  } else if (indexOfWeight(ctx.fixed, W) >= 0) {
    pl = { kind: 'fixed', rec, W };
  } else {
    const avail = availableWeights(mv, ctx.equipment);
    const i = indexOfWeight(avail, W);
    const neighbors = [avail[i - 1], avail[i + 1]].filter((x) => x != null &&
      indexOfWeight(ctx.fixed, x) < 0 && indexOfWeight(ctx.adj, x) >= 0);
    const below = ctx.fixed.filter((f) => f < W);
    const offW = below.length ? below[below.length - 1] : (ctx.fixed.length ? ctx.fixed[0] : null);
    const offTarget = offW == null ? null : (offW < W ? mv.target.max : mv.target.min);
    const fixedNb = [avail[i - 1], avail[i + 1]].filter((x) => x != null && indexOfWeight(ctx.fixed, x) >= 0);
    pl = { kind: 'adj', rec, W, neighbors, offW, offTarget, fixedNb: fixedNb.length ? fixedNb[0] : null };
  }
  ctx.placements.set(mv.id, pl);
  return pl;
}

// Load and target for a candidate when its block runs the adjustable at S (null = unused).
function statusFor(mv, pl, S) {
  const rec = pl.rec;
  const t = mv.target;
  switch (pl.kind) {
    case 'bw':
      return { usesAdj: false, source: 'bodyweight', weight: null, target: rec.target_value, adjusted: null, off: false };
    case 'fixed':
      return { usesAdj: false, source: 'fixed', weight: pl.W, target: rec.target_value, adjusted: null, off: false };
    case 'adj': {
      if (S !== null && sameWeight(S, pl.W)) {
        return { usesAdj: true, source: 'adjustable', weight: pl.W, target: rec.target_value, adjusted: null, off: false };
      }
      if (S !== null && pl.neighbors.some((x) => sameWeight(x, S))) {
        const shift = S > pl.W ? -ADJUST_REP_SHIFT : ADJUST_REP_SHIFT;
        const target = Math.min(Math.max(rec.target_value + shift, t.min), t.max);
        return {
          usesAdj: true, source: 'adjustable', weight: S, target, off: false,
          adjusted: { reason: 'block_setting', recommended_weight_lb: pl.W, rep_shift: target - rec.target_value },
        };
      }
      // Before the last resort: a fixed pair exactly one step from the recommendation, 2-rep shift.
      if (pl.fixedNb !== null) {
        const shift = pl.fixedNb > pl.W ? -ADJUST_REP_SHIFT : ADJUST_REP_SHIFT;
        const target = Math.min(Math.max(rec.target_value + shift, t.min), t.max);
        return {
          usesAdj: false, source: 'fixed', weight: pl.fixedNb, target, off: false, fixedPair: true,
          adjusted: { reason: 'fixed_pair', recommended_weight_lb: pl.W, rep_shift: target - rec.target_value },
        };
      }
      if (pl.offW !== null) {
        return { usesAdj: false, source: 'fixed', weight: pl.offW, target: pl.offTarget, adjusted: null, off: true };
      }
      if (S !== null) {
        return { usesAdj: true, source: 'adjustable', weight: S, target: S < pl.W ? t.max : t.min, adjusted: null, off: true };
      }
      return null;
    }
    default:
      return null;
  }
}

function sinceDone(ctx, id) {
  return ctx.lastDone.has(id) ? ctx.sessions.length - 1 - ctx.lastDone.get(id) : Infinity;
}

// Candidates for one slot, least recently done first (never done counts as oldest), PRNG ties.
function slotChoices(ctx, roles, exclude, taken) {
  let mvs = ctx.library.movements.filter((m) => isEligible(m, roles, ctx.equipment));
  let excluded = [];
  if (exclude && exclude.size) {
    const rest = mvs.filter((m) => !exclude.has(m.id));
    if (rest.some((m) => !taken.has(m.id))) {
      excluded = mvs.filter((m) => exclude.has(m.id)).map((m) => m.id);
      mvs = rest;
    }
  }
  const cands = mvs.map((m) => {
    const pl = placement(ctx, m);
    return {
      fixed: false, id: m.id, mv: m, pl,
      perSide: !!m.target.per_side,
      rep: ctx.repeatIds.has(m.id) ? 1 : 0,
      sw: !ctx.autoPickSwaps && !m.in_draft_rotation ? 1 : 0,
      since: sinceDone(ctx, m.id),
      tie: ctx.tie.get(m.id),
      settingVals: pl.kind === 'adj' ? [pl.W].concat(pl.neighbors) : [],
      excluded,
    };
  }).filter((c) => c.pl.kind !== 'none');
  cands.sort((a, b) => (b.since - a.since) || (a.tie - b.tie));
  cands.forEach((c, i) => { c.rank = i; });
  return cands;
}

function fixedChoice(ctx, item) {
  const mv = ctx.byId.get(item.movement_id);
  const usesAdj = item.load && item.load.source === 'adjustable';
  return {
    fixed: true, id: item.movement_id, mv, item,
    perSide: !!(mv && mv.target.per_side), rep: 0, sw: 0, rank: 0, settingVals: [],
    fixedStatus: { usesAdj, weight: usesAdj ? item.load.weight_lb_per_dumbbell : null },
  };
}

// Every valid (combination, setting) option for a block, grouped by effective setting.
function blockOptionGroups(blockId, slotLists) {
  const n = slotLists.length;
  const combo = new Array(n);
  const groups = new Map();
  const used = new Set();
  const evalCombo = () => {
    const fixedAdj = combo.filter((c) => c.fixed && c.fixedStatus.usesAdj).map((c) => c.fixedStatus.weight);
    let settings;
    if (fixedAdj.length) {
      settings = [fixedAdj[0]];
    } else {
      settings = [null];
      combo.forEach((c) => c.settingVals.forEach((v) => {
        if (!settings.some((s) => s !== null && sameWeight(s, v))) settings.push(v);
      }));
    }
    let sw = 0;
    let rep = 0;
    combo.forEach((c) => { sw += c.sw; rep += c.rep; });
    for (const S of settings) {
      const statuses = [];
      let ok = true;
      let usesAdj = false;
      let off = 0;
      let adjN = 0;
      for (const c of combo) {
        let st;
        if (c.fixed) {
          st = c.fixedStatus;
        } else {
          st = statusFor(c.mv, c.pl, S);
          if (!st) { ok = false; break; }
          if (st.off) off += 1;
          if (st.fixedPair) off += 0.5; // priority 3: only when no movement or setting works
          if (st.adjusted) adjN += 1;
        }
        if (st.usesAdj) usesAdj = true;
        statuses.push(st);
      }
      if (!ok) continue;
      if (S !== null && !usesAdj) continue;
      const eff = usesAdj ? S : null;
      const key = eff === null ? 'null' : String(eff);
      if (!groups.has(key)) groups.set(key, { S: eff, list: [] });
      groups.get(key).list.push({
        combo: combo.slice(), statuses, S: eff, counts: [sw, rep, off],
        ranks: combo.map((c) => c.rank), adj: adjN, ids: combo.map((c) => c.id),
      });
    }
  };
  const walk = (k, perSide) => {
    if (k === n) { evalCombo(); return; }
    for (const c of slotLists[k]) {
      if (used.has(c.id)) continue;
      const ps = perSide + (c.perSide ? 1 : 0);
      if (blockId === 'A' && ps > MAX_PER_SIDE_BLOCK_A) continue;
      combo[k] = c;
      used.add(c.id);
      walk(k + 1, ps);
      used.delete(c.id);
    }
  };
  walk(0, 0);
  const cmpOpt = (a, b) => cmpArr(a.counts, b.counts) || cmpArr(a.ranks, b.ranks) || (a.adj - b.adj);
  groups.forEach((g) => g.list.sort(cmpOpt));
  return Array.from(groups.values());
}

// One option per block, lexicographic best; branch and bound over setting plans.
function searchSession(ctx, blockGroups) {
  if (blockGroups.some((g) => !g.length)) return null;
  const byId = ctx.byId;
  const patternsOk = (chosen) => {
    const set = new Set();
    chosen.forEach((o) => o.ids.forEach((id) => byId.get(id).patterns.forEach((p) => set.add(p))));
    return missingPatterns(set).length === 0;
  };
  let plans = [[]];
  blockGroups.forEach((gl) => {
    const next = [];
    plans.forEach((p) => gl.forEach((g) => next.push(p.concat([g]))));
    plans = next;
  });
  const info = plans.map((p) => {
    let counts = [0, 0, 0];
    p.forEach((g) => { counts = addArr(counts, g.list[0].counts); });
    // Priority 4 penalises settings beyond the first; a session with none is not preferred.
    const sc = Math.max(0, new Set(p.filter((g) => g.S !== null).map((g) => String(g.S))).size - 1);
    return { p, prefix: counts.concat([sc]), sc };
  });
  info.sort((a, b) => cmpArr(a.prefix, b.prefix));
  const totalSlots = blockGroups.reduce((s, gl) => s + gl[0].list[0].ranks.length, 0);
  const state = { best: null };
  for (const pi of info) {
    if (state.best && cmpArr(pi.prefix, state.best.key.slice(0, 4)) > 0) break;
    solvePlan(pi.p.map((g) => g.list), pi.sc, totalSlots, state, patternsOk);
  }
  return state.best;
}

function solvePlan(lists, sc, totalSlots, state, patternsOk) {
  const nb = lists.length;
  const suffix = new Array(nb + 1);
  suffix[nb] = [0, 0, 0];
  for (let i = nb - 1; i >= 0; i--) suffix[i] = addArr(suffix[i + 1], lists[i][0].counts);
  const chosen = new Array(nb);
  const used = new Set();
  const pad = (r) => r.concat(new Array(totalSlots - r.length).fill(0));
  const walk = (bi, counts, ranks) => {
    for (const o of lists[bi]) {
      if (o.ids.some((id) => used.has(id))) continue;
      const c2 = addArr(counts, o.counts);
      const r2 = ranks.concat(o.ranks);
      const lb = addArr(c2, suffix[bi + 1]).concat([sc], pad(r2), [0]);
      if (state.best && cmpArr(lb, state.best.key) >= 0) break;
      chosen[bi] = o;
      if (bi === nb - 1) {
        if (!patternsOk(chosen)) continue;
        const adjSum = chosen.reduce((s, x) => s + x.adj, 0);
        state.best = { key: c2.concat([sc], r2, [adjSum]), chosen: chosen.slice() };
        break;
      }
      o.ids.forEach((id) => used.add(id));
      walk(bi + 1, c2, r2);
      o.ids.forEach((id) => used.delete(id));
    }
  };
  walk(0, [0, 0, 0], []);
}

// ---------------------------------------------------------------- building the session

function buildItem(choice, slotIdx, st) {
  const mv = choice.mv;
  const rec = choice.pl.rec;
  const recommendation = {
    basis: rec.basis,
    weight_lb_per_dumbbell: rec.weight_lb_per_dumbbell,
    target_value: rec.target_value,
    suggest_variation: clone(rec.suggest_variation),
    last: clone(rec.last),
  };
  if (rec.remapped_from_lb !== undefined) recommendation.remapped_from_lb = rec.remapped_from_lb;
  return {
    movement_id: mv.id,
    slot: slotIdx,
    target: { unit: mv.target.unit, value: st.target, per_side: !!mv.target.per_side },
    load: { source: st.source, weight_lb_per_dumbbell: st.weight, dumbbells: mv.load.dumbbells },
    recommendation,
    adjusted: st.adjusted ? clone(st.adjusted) : null,
    forced_repeat: choice.rep === 1,
    off_target: !!st.off,
    swap: !mv.in_draft_rotation,
    reroll_excluded: choice.excluded ? choice.excluded.slice() : [],
    logged: null,
  };
}

function buildBlock(ctx, bt, option) {
  return {
    block: bt.block,
    rounds: bt.rounds,
    planned_rounds: bt.rounds,
    rest_sec: ctx.library.timing.rest_between_rounds_sec[bt.block],
    adjustable_setting_lb: option.S,
    removed: false,
    items: option.combo.map((c, si) => (c.fixed ? clone(c.item) : buildItem(c, si, option.statuses[si]))),
  };
}

function chooseFinisher(ctx, session) {
  const opts = finisherOptions(ctx.library, ctx.equipment, session).filter((o) => o.ok);
  const main = opts.filter((o) => !o.finisher.no_equipment_alternate);
  const pool = main.length ? main : opts;
  if (!pool.length) return null;
  const lastIdx = (id) => {
    for (let i = ctx.sessions.length - 1; i >= 0; i--) {
      const f = ctx.sessions[i].finisher;
      if (f && f.id === id) return i;
    }
    return -1;
  };
  pool.sort((a, b) => (lastIdx(a.id) - lastIdx(b.id)) || (ctx.finTie.get(a.id) - ctx.finTie.get(b.id)));
  return { id: pool[0].id, name: pool[0].finisher.name, weight_lb_per_dumbbell: null, setting_basis: null, done: null };
}

function finalize(ctx, session) {
  let s = trimToLength(ctx.library, session, session.length_min);
  if (s.finisher) {
    const opt = finisherOptions(ctx.library, ctx.equipment, s).find((o) => o.id === s.finisher.id);
    s.finisher = Object.assign({}, s.finisher, {
      weight_lb_per_dumbbell: opt && opt.ok ? opt.weight : null,
      setting_basis: opt && opt.ok ? opt.basis : null,
    });
  }
  return s;
}

// generateSession({ library, equipment, sessions, lengthMin, seed, now, dayType?, autoPickSwaps = true })
export function generateSession(params) {
  const { library, equipment, lengthMin, seed, now, dayType } = params;
  const sessions = params.sessions || [];
  const autoPickSwaps = params.autoPickSwaps !== false;
  const day = dayType || nextDayType(sessions, library);
  const template = pickTemplate(library, sessions, day);
  const seedInt = toSeed(seed);
  const ctx = buildContext({ library, equipment, sessions, dayType: day, seedInt, autoPickSwaps });
  const none = new Set();
  const groups = template.blocks.map((bt) =>
    blockOptionGroups(bt.block, bt.slots.map((slot) => slotChoices(ctx, slot.roles, null, none))));
  const best = searchSession(ctx, groups);
  if (!best) throw new Error('No valid ' + day + ' session for this equipment');
  const created = toIso(now);
  const session = {
    id: day + '-' + (created || 'session').replace(/[^0-9A-Za-z]/g, '') + '-' + seedInt.toString(36),
    seed,
    day_type: day,
    template_id: template.id,
    length_min: lengthMin,
    created_at: created,
    completed_at: null,
    auto_pick_swaps: autoPickSwaps,
    blocks: template.blocks.map((bt, bi) => buildBlock(ctx, bt, best.chosen[bi])),
    finisher: null,
    estimate_sec: 0,
    trims: [],
    over_length_sec: 0,
    rerolls: { count: 0, history: [] },
  };
  if (template.finisher) session.finisher = chooseFinisher(ctx, session);
  return finalize(ctx, session);
}

function scopeKey(scope) {
  if (scope.type === 'slot') return 'slot:' + scope.block + ':' + scope.slot;
  if (scope.type === 'block') return 'block:' + scope.block;
  return 'session';
}

// reroll({ library, equipment, sessions, session, scope, now }) re-picks only the scoped slots.
export function reroll({ library, equipment, sessions, session, scope, now }) {
  const history = sessions || [];
  const template = library.slot_templates.find((t) => t.id === session.template_id);
  if (!template) throw new Error('Unknown template ' + session.template_id);
  if (!scope || ['slot', 'block', 'session'].indexOf(scope.type) < 0) throw new Error('Bad reroll scope');
  const inScope = (bi, si) => {
    const letter = template.blocks[bi].block;
    if (scope.type === 'session') return true;
    if (scope.type === 'block') return letter === scope.block;
    return letter === scope.block && si === scope.slot;
  };
  const any = template.blocks.some((bt, bi) => bt.slots.some((s, si) => inScope(bi, si)));
  if (!any) throw new Error('Reroll scope matches no slot');
  const prev = session.rerolls && typeof session.rerolls.count === 'number'
    ? session.rerolls : { count: 0, history: [] };
  const count = prev.count + 1;
  const seedInt = hashString(String(session.seed) + '|reroll|' + count + '|' + scopeKey(scope));
  const ctx = buildContext({
    library, equipment, sessions: history, dayType: session.day_type, seedInt,
    autoPickSwaps: session.auto_pick_swaps !== false,
  });
  const taken = new Set();
  template.blocks.forEach((bt, bi) => bt.slots.forEach((s, si) => {
    if (!inScope(bi, si)) taken.add(session.blocks[bi].items[si].movement_id);
  }));
  const attempt = (useExclusions) => {
    const groups = template.blocks.map((bt, bi) => blockOptionGroups(bt.block, bt.slots.map((slot, si) => {
      const old = session.blocks[bi].items[si];
      if (!inScope(bi, si)) return [fixedChoice(ctx, old)];
      // An item placed by swapSlot also keeps the movement it replaced out (swapped_from).
      const excl = useExclusions ? new Set([old.movement_id].concat(old.swapped_from ? [old.swapped_from] : [])) : null;
      return slotChoices(ctx, slot.roles, excl, taken);
    })));
    return searchSession(ctx, groups);
  };
  const best = attempt(true) || attempt(false);
  if (!best) throw new Error('Reroll found no valid session');

  const next = clone(session);
  const changes = [];
  next.blocks = template.blocks.map((bt, bi) => {
    const touched = bt.slots.some((s, si) => inScope(bi, si));
    const oldBlock = session.blocks[bi];
    if (!touched) return clone(oldBlock);
    const b = buildBlock(ctx, bt, best.chosen[bi]);
    b.items.forEach((it, si) => {
      if (inScope(bi, si)) {
        changes.push({ block: bt.block, slot: si, from: oldBlock.items[si].movement_id, to: it.movement_id });
      }
    });
    return b;
  });
  const finFrom = session.finisher ? session.finisher.id : null;
  if (template.finisher) {
    const opts = finisherOptions(library, equipment, next);
    const current = next.finisher ? opts.find((o) => o.id === next.finisher.id) : null;
    const keep = scope.type !== 'session' && current && current.ok &&
      !(current.finisher.no_equipment_alternate && opts.some((o) => o.ok && !o.finisher.no_equipment_alternate));
    if (!keep) next.finisher = chooseFinisher(ctx, next);
  } else {
    next.finisher = null;
  }
  const out = finalize(ctx, next);
  out.rerolls = {
    count,
    history: (prev.history || []).concat([{
      at: toIso(now),
      scope: clone(scope),
      changes,
      finisher: { from: finFrom, to: out.finisher ? out.finisher.id : null },
    }]),
  };
  return out;
}

// Rebuild one slot with a chosen movement and every other slot kept, the way reroll rebuilds a
// slot scope: the block setting and the item's load re-searched, the finisher re-checked, trims
// re-applied. Used by swapSlot (swap.js), which adds the record. -> Session, or null when the
// movement cannot fill the slot in a valid block (not eligible, no load, patterns lost).
export function placeInSlot({ library, equipment, sessions, session, blockIndex, slotIndex, movementId, seedInt }) {
  const history = sessions || [];
  const template = library.slot_templates.find((t) => t.id === session.template_id);
  if (!template) throw new Error('Unknown template ' + session.template_id);
  const bt = template.blocks[blockIndex];
  if (!bt || !bt.slots[slotIndex]) return null;
  const ctx = buildContext({
    library, equipment, sessions: history, dayType: session.day_type, seedInt,
    autoPickSwaps: session.auto_pick_swaps !== false,
  });
  const none = new Set();
  const groups = template.blocks.map((b, bi) => blockOptionGroups(b.block, b.slots.map((slot, si) => {
    if (bi !== blockIndex || si !== slotIndex) return [fixedChoice(ctx, session.blocks[bi].items[si])];
    return slotChoices(ctx, slot.roles, null, none).filter((c) => c.id === movementId);
  })));
  const best = searchSession(ctx, groups);
  if (!best) return null;
  const next = clone(session);
  next.blocks[blockIndex] = buildBlock(ctx, bt, best.chosen[blockIndex]);
  if (template.finisher) {
    const opts = finisherOptions(library, equipment, next);
    const current = next.finisher ? opts.find((o) => o.id === next.finisher.id) : null;
    const keep = current && current.ok &&
      !(current.finisher.no_equipment_alternate && opts.some((o) => o.ok && !o.finisher.no_equipment_alternate));
    if (!keep) next.finisher = chooseFinisher(ctx, next);
  } else {
    next.finisher = null;
  }
  return finalize(ctx, next);
}
