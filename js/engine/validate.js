// validateSession({ library, equipment, sessions, session }) -> [] | [{ rule, message }]
// Re-derives every rule from the library, equipment, and history. It does not trust the
// generator's bookkeeping fields (forced_repeat, adjusted, off_target, recommendation, trims).
//
// Rules: day_type_order, structure, estimate, trims, finisher_presence, role_eligibility,
// patterns, duplicate, repeat, per_side, adjustable_setting, weight_available,
// weight_fidelity, finisher_rules, swaps

import {
  isEligible, availableWeights, fixedPairs, adjustableSettings, usesWeight, indexOfWeight,
  weightSource, sameWeight,
} from './equipment.js';
import { recommend } from './recommend.js';
import { estimateSec, TRIM_STEPS, ALLOWED_LENGTHS } from './duration.js';
import {
  nextDayType, pickTemplate, lastOfDayType, activeItems, allItems, sessionPatterns, missingPatterns,
  finisherOptions, MAX_PER_SIDE_BLOCK_A, ADJUST_REP_SHIFT,
} from './generator.js';

function isNum(v) {
  return typeof v === 'number' && isFinite(v);
}

// Movements that could replace the item in (blockIndex, slotIndex) without breaking a hard rule:
// eligible for the slot, not used elsewhere in the session, Block A per-side limit kept, not
// the item itself or a movement the user rerolled out of this slot.
export function slotAlternatives({ library, equipment, session, blockIndex, slotIndex, exclude, inRotationOnly }) {
  const template = library.slot_templates.find((t) => t.id === session.template_id);
  if (!template) return [];
  const bt = template.blocks[blockIndex];
  const roles = bt.slots[slotIndex].roles;
  const block = session.blocks[blockIndex];
  const item = block.items[slotIndex];
  const byId = new Map(library.movements.map((m) => [m.id, m]));
  const elsewhere = new Set();
  session.blocks.forEach((b, bi) => b.items.forEach((it, si) => {
    if (!(bi === blockIndex && si === slotIndex)) elsewhere.add(it.movement_id);
  }));
  let perSideOthers = 0;
  block.items.forEach((it, si) => {
    const mv = byId.get(it.movement_id);
    if (si !== slotIndex && mv && mv.target.per_side) perSideOthers += 1;
  });
  const skip = new Set([item.movement_id].concat(item.reroll_excluded || []));
  const ex = exclude || new Set();
  return library.movements.filter((m) => isEligible(m, roles, equipment) &&
    !skip.has(m.id) && !elsewhere.has(m.id) && !ex.has(m.id) &&
    (!inRotationOnly || m.in_draft_rotation) &&
    (bt.block !== 'A' || perSideOthers + (m.target.per_side ? 1 : 0) <= MAX_PER_SIDE_BLOCK_A)
  ).map((m) => m.id);
}

export function validateSession({ library, equipment, sessions, session }) {
  const history = sessions || [];
  const out = [];
  const add = (rule, message) => out.push({ rule, message });
  const byId = new Map(library.movements.map((m) => [m.id, m]));
  const tm = library.timing;

  // ---- day-type order and template alternation
  const expectedDay = nextDayType(history, library);
  if (session.day_type !== expectedDay) {
    add('day_type_order', 'day type is ' + session.day_type + ', expected ' + expectedDay);
  }
  const template = library.slot_templates.find((t) => t.id === session.template_id);
  if (!template) {
    add('structure', 'unknown template ' + session.template_id);
    return out;
  }
  if (template.day_type !== session.day_type) {
    add('structure', 'template ' + template.id + ' is for ' + template.day_type + ' days');
  } else {
    const expectedTpl = pickTemplate(library, history, session.day_type);
    if (expectedTpl.id !== template.id) {
      add('day_type_order', 'template is ' + template.id + ', expected ' + expectedTpl.id);
    }
  }

  // ---- structure: blocks A/B/C, three slots each, planned rounds from the template (4/4/3)
  const blocks = session.blocks || [];
  if (blocks.length !== template.blocks.length) {
    add('structure', 'session has ' + blocks.length + ' blocks, template has ' + template.blocks.length);
    return out;
  }
  let fatal = false;
  if (ALLOWED_LENGTHS.indexOf(session.length_min) < 0) {
    add('structure', 'length_min ' + session.length_min + ' is not one of ' + ALLOWED_LENGTHS.join(', '));
  }
  template.blocks.forEach((bt, bi) => {
    const b = blocks[bi];
    if (b.block !== bt.block) add('structure', 'block ' + bi + ' is ' + b.block + ', expected ' + bt.block);
    if (b.planned_rounds !== bt.rounds) {
      add('structure', 'block ' + bt.block + ' planned_rounds ' + b.planned_rounds + ', expected ' + bt.rounds);
    }
    if (!Number.isInteger(b.rounds) || b.rounds < 0 || b.rounds > bt.rounds) {
      add('structure', 'block ' + bt.block + ' rounds ' + b.rounds + ' outside 0 to ' + bt.rounds);
    }
    if (b.rest_sec !== tm.rest_between_rounds_sec[bt.block]) {
      add('structure', 'block ' + bt.block + ' rest_sec ' + b.rest_sec + ', expected ' + tm.rest_between_rounds_sec[bt.block]);
    }
    if (!Array.isArray(b.items) || b.items.length !== bt.slots.length) {
      add('structure', 'block ' + bt.block + ' has ' + (b.items || []).length + ' items, expected ' + bt.slots.length);
      fatal = true;
      return;
    }
    b.items.forEach((it, si) => {
      const mv = byId.get(it.movement_id);
      if (!mv) { add('structure', 'unknown movement ' + it.movement_id); fatal = true; return; }
      if (it.slot !== si) add('structure', it.movement_id + ' has slot ' + it.slot + ', expected ' + si);
      const t = it.target || {};
      if (t.unit !== mv.target.unit || !!t.per_side !== !!mv.target.per_side) {
        add('structure', it.movement_id + ' target unit or per_side does not match the library');
      }
      if (!isNum(t.value) || t.value < mv.target.min || t.value > mv.target.max) {
        add('structure', it.movement_id + ' target ' + t.value + ' outside ' + mv.target.min + ' to ' + mv.target.max);
      }
      if (!it.load || it.load.dumbbells !== mv.load.dumbbells) {
        add('structure', it.movement_id + ' dumbbells do not match the library');
      }
    });
  });
  if (fatal) return out;

  // ---- estimate and trims: replay the trim order from the planned rounds
  const est = estimateSec(library, session);
  if (session.estimate_sec !== est) add('estimate', 'estimate_sec ' + session.estimate_sec + ', expected ' + est);
  const limit = session.length_min * 60;
  const sim = { blocks: blocks.map((b) => ({ block: b.block, rounds: b.planned_rounds, items: b.items })), finisher: session.finisher };
  let simEst = estimateSec(library, sim);
  const expectedSteps = [];
  for (const step of TRIM_STEPS) {
    if (simEst <= limit) break;
    const b = sim.blocks.find((x) => x.block === step.block);
    if (!b || b.rounds <= step.rounds) continue;
    b.rounds = step.rounds;
    simEst = estimateSec(library, sim);
    expectedSteps.push(step.id);
  }
  const gotSteps = (session.trims || []).map((t) => t.step);
  if (gotSteps.join(',') !== expectedSteps.join(',')) {
    add('trims', 'trims [' + gotSteps.join(', ') + '], expected [' + expectedSteps.join(', ') + ']');
  }
  sim.blocks.forEach((sb, bi) => {
    if (blocks[bi].rounds !== sb.rounds) {
      add('trims', 'block ' + sb.block + ' runs ' + blocks[bi].rounds + ' rounds, the trim order gives ' + sb.rounds);
    }
  });
  const expOver = simEst > limit ? simEst - limit : 0;
  if (session.over_length_sec !== expOver) {
    add('trims', 'over_length_sec ' + session.over_length_sec + ', expected ' + expOver);
  }

  // ---- finisher presence
  if (template.finisher && !session.finisher) add('finisher_presence', session.day_type + ' day needs a finisher');
  if (!template.finisher && session.finisher) add('finisher_presence', session.day_type + ' day must not have a finisher');

  // ---- roles and eligibility
  template.blocks.forEach((bt, bi) => blocks[bi].items.forEach((it, si) => {
    const mv = byId.get(it.movement_id);
    const roles = bt.slots[si].roles;
    if (!mv.roles.some((r) => roles.indexOf(r) >= 0)) {
      add('role_eligibility', it.movement_id + ' cannot fill ' + bt.block + (si + 1) + ' (' + roles.join('/') + ')');
    } else if (!isEligible(mv, roles, equipment)) {
      add('role_eligibility', it.movement_id + ' is not eligible under this equipment');
    }
  }));

  // ---- six patterns in the untrimmed plan
  const missing = missingPatterns(sessionPatterns(library, session));
  if (missing.length) add('patterns', 'missing pattern(s): ' + missing.join(', '));

  // ---- duplicates
  const seen = new Set();
  allItems(session).forEach((it) => {
    if (seen.has(it.movement_id)) add('duplicate', it.movement_id + ' appears twice');
    seen.add(it.movement_id);
  });

  // ---- repeats from the last session of the same day type
  const lastSame = lastOfDayType(history, session.day_type);
  const repeatIds = new Set(lastSame ? activeItems(lastSame).map((it) => it.movement_id) : []);
  const autoSwaps = session.auto_pick_swaps !== false;
  blocks.forEach((b, bi) => b.items.forEach((it, si) => {
    const isRepeat = repeatIds.has(it.movement_id);
    const mv = byId.get(it.movement_id);
    if (isRepeat && !it.forced_repeat) {
      add('repeat', it.movement_id + ' was in the last ' + session.day_type + ' session and is not marked forced_repeat');
    } else if (!isRepeat && it.forced_repeat) {
      add('repeat', it.movement_id + ' is marked forced_repeat but was not in the last ' + session.day_type + ' session');
    } else if (isRepeat) {
      const alts = slotAlternatives({
        library, equipment, session, blockIndex: bi, slotIndex: si, exclude: repeatIds,
        inRotationOnly: !autoSwaps && mv.in_draft_rotation,
      });
      if (alts.length) add('repeat', it.movement_id + ' repeated although ' + alts[0] + ' was available');
    }
  }));

  // ---- swaps only when the in-rotation pool is empty (auto_pick_swaps false)
  if (!autoSwaps) {
    blocks.forEach((b, bi) => b.items.forEach((it, si) => {
      const mv = byId.get(it.movement_id);
      if (mv.in_draft_rotation) return;
      const alts = slotAlternatives({ library, equipment, session, blockIndex: bi, slotIndex: si, inRotationOnly: true });
      if (alts.length) add('swaps', it.movement_id + ' is a swap although ' + alts[0] + ' is in rotation');
    }));
  }

  // ---- per-side limit in Block A
  template.blocks.forEach((bt, bi) => {
    if (bt.block !== 'A') return;
    const n = blocks[bi].items.filter((it) => byId.get(it.movement_id).target.per_side).length;
    if (n > MAX_PER_SIDE_BLOCK_A) add('per_side', 'Block A has ' + n + ' per-side items');
  });

  // ---- one adjustable setting per block, matching every adjustable item
  const adjValues = adjustableSettings(equipment);
  blocks.forEach((b) => {
    const adjItems = b.items.filter((it) => it.load && it.load.source === 'adjustable');
    const ws = [];
    adjItems.forEach((it) => {
      if (!ws.some((w) => sameWeight(w, it.load.weight_lb_per_dumbbell))) ws.push(it.load.weight_lb_per_dumbbell);
    });
    if (ws.length > 1) add('adjustable_setting', 'Block ' + b.block + ' uses ' + ws.length + ' adjustable settings (' + ws.join(', ') + ')');
    if (adjItems.length && !sameWeight(b.adjustable_setting_lb, ws[0])) {
      add('adjustable_setting', 'Block ' + b.block + ' setting ' + b.adjustable_setting_lb + ' does not match its items (' + ws[0] + ')');
    }
    if (!adjItems.length && b.adjustable_setting_lb != null) {
      add('adjustable_setting', 'Block ' + b.block + ' has setting ' + b.adjustable_setting_lb + ' but no adjustable item');
    }
    if (b.adjustable_setting_lb != null && indexOfWeight(adjValues, b.adjustable_setting_lb) < 0) {
      add('adjustable_setting', 'Block ' + b.block + ' setting ' + b.adjustable_setting_lb + ' is not an adjustable setting');
    }
  });

  // ---- weights available, and each lift within one step of its recommendation
  const fixed = fixedPairs(equipment);
  blocks.forEach((b) => b.items.forEach((it) => {
    const mv = byId.get(it.movement_id);
    const w = it.load.weight_lb_per_dumbbell;
    if (!usesWeight(mv)) {
      if (it.load.source !== 'bodyweight' || w != null) add('weight_available', it.movement_id + ' is bodyweight but has a load');
    } else {
      const avail = availableWeights(mv, equipment);
      if (indexOfWeight(avail, w) < 0) {
        add('weight_available', it.movement_id + ' at ' + w + ' lb is not available');
      } else if (it.load.source !== weightSource(w, equipment)) {
        add('weight_available', it.movement_id + ' at ' + w + ' lb should be ' + weightSource(w, equipment) + ', not ' + it.load.source);
      }
    }
    const rec = recommend({ library, equipment, sessions: history, movement: mv });
    const rw = rec.weight_lb_per_dumbbell;
    const rt = rec.target_value;
    const t = mv.target;
    const val = it.target.value;
    const stored = it.recommendation;
    if (!stored || !(stored.weight_lb_per_dumbbell === rw || sameWeight(stored.weight_lb_per_dumbbell, rw)) || stored.target_value !== rt) {
      add('weight_fidelity', it.movement_id + ' stored recommendation does not match ' + rw + ' x ' + rt);
    }
    if (!usesWeight(mv)) {
      if (val !== rt) add('weight_fidelity', it.movement_id + ' target ' + val + ', recommended ' + rt);
      return;
    }
    if (it.off_target) {
      const below = fixed.filter((f) => f < rw);
      if (below.length) {
        if (!sameWeight(w, below[below.length - 1]) || val !== t.max) {
          add('weight_fidelity', it.movement_id + ' off_target should run ' + below[below.length - 1] + ' x ' + t.max);
        }
      } else if (val < t.min || val > t.max) {
        add('weight_fidelity', it.movement_id + ' off_target target out of range');
      }
      return;
    }
    if (sameWeight(w, rw)) {
      if (val !== rt) add('weight_fidelity', it.movement_id + ' target ' + val + ' at its recommended weight, expected ' + rt);
      if (it.adjusted) add('weight_fidelity', it.movement_id + ' is marked adjusted but runs its recommended weight');
      return;
    }
    const steps = stepDistanceIn(availableWeights(mv, equipment), w, rw);
    if (steps !== 1) {
      add('weight_fidelity', it.movement_id + ' runs ' + w + ' lb, ' + (isFinite(steps) ? steps : 'unknown') + ' steps from its recommended ' + rw + ' lb');
      return;
    }
    const shift = w > rw ? -ADJUST_REP_SHIFT : ADJUST_REP_SHIFT;
    const expected = Math.min(Math.max(rt + shift, t.min), t.max);
    if (val !== expected) {
      add('weight_fidelity', it.movement_id + ' at ' + w + ' lb (recommended ' + rw + ') should target ' + expected + ', not ' + val);
    }
    if (!it.adjusted || !sameWeight(it.adjusted.recommended_weight_lb, rw) || it.adjusted.rep_shift !== expected - rt) {
      add('weight_fidelity', it.movement_id + ' adjusted record is missing or wrong');
    }
  }));

  // ---- finisher rules
  if (session.finisher) {
    const f = library.finishers.find((x) => x.id === session.finisher.id);
    if (!f) {
      add('finisher_rules', 'unknown finisher ' + session.finisher.id);
    } else {
      const opts = finisherOptions(library, equipment, session);
      const mine = opts.find((o) => o.id === f.id);
      if (!mine) {
        add('finisher_rules', 'finisher ' + f.id + ' is not for ' + session.day_type + ' days');
      } else if (!mine.ok) {
        add('finisher_rules', 'finisher ' + f.id + ' not allowed: ' + mine.reason);
      } else {
        const w = session.finisher.weight_lb_per_dumbbell;
        if (!(w === mine.weight || sameWeight(w, mine.weight))) {
          add('finisher_rules', 'finisher ' + f.id + ' weight ' + w + ', expected ' + mine.weight);
        }
        if (f.no_equipment_alternate) {
          const other = opts.find((o) => o.ok && !o.finisher.no_equipment_alternate);
          if (other) add('finisher_rules', 'finisher ' + f.id + ' is a fallback but ' + other.id + ' is eligible');
        }
      }
    }
  }
  return out;
}

function stepDistanceIn(list, a, b) {
  const i = indexOfWeight(list, a);
  const j = indexOfWeight(list, b);
  if (i < 0 || j < 0) return Infinity;
  return Math.abs(i - j);
}
