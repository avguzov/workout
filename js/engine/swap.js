// Movement swaps: the owner replaces one movement of a generated session with another that works
// the same muscle group (equal library `muscle_group`), can fill the slot under the equipment, is
// not already in the session, and leaves the session with zero validator violations.
//
// swapCandidates({ library, equipment, sessions, session, blockIndex, slotIndex }) -> [movement_id]
// swapSlot({ library, equipment, sessions, session, blockIndex, slotIndex, movementId, now }) -> Session
// musclePeers(library, movementId) -> [movement_id];  sameMuscleGroup(movementA, movementB) -> bool

import { hashString } from './rng.js';
import { placeInSlot, activeItems } from './generator.js';
import { validateSession, slotAlternatives } from './validate.js';

function toIso(now) {
  if (now == null) return null;
  const d = now instanceof Date ? now : new Date(now);
  return isNaN(d.getTime()) ? String(now) : d.toISOString();
}

export function sameMuscleGroup(a, b) {
  return !!(a && b && a.muscle_group && a.muscle_group === b.muscle_group);
}

// Every other library movement in the same muscle group, in library order (no equipment filter).
export function musclePeers(library, movementId) {
  const mv = library.movements.find((m) => m.id === movementId);
  if (!mv) return [];
  return library.movements.filter((m) => m.id !== mv.id && sameMuscleGroup(m, mv)).map((m) => m.id);
}

function itemAt(session, blockIndex, slotIndex) {
  const b = session && session.blocks ? session.blocks[blockIndex] : null;
  return b && b.items ? b.items[slotIndex] || null : null;
}

// Same-group movements that can fill the slot and are not in the session. Starts from
// slotAlternatives with the slot's reroll_excluded cleared: an explicit pick may bring back a
// movement that a shuffle or an earlier swap took out of the slot.
function groupAlternatives({ library, equipment, session, blockIndex, slotIndex }) {
  const item = itemAt(session, blockIndex, slotIndex);
  if (!item) return [];
  const byId = new Map(library.movements.map((m) => [m.id, m]));
  const cur = byId.get(item.movement_id);
  if (!cur) return [];
  const view = Object.assign({}, session, {
    blocks: session.blocks.map((b, bi) => (bi !== blockIndex ? b : Object.assign({}, b, {
      items: b.items.map((it, si) => (si !== slotIndex ? it : Object.assign({}, it, { reroll_excluded: [] }))),
    }))),
  });
  return slotAlternatives({ library, equipment, session: view, blockIndex, slotIndex })
    .filter((id) => sameMuscleGroup(byId.get(id), cur));
}

// The session with movementId built into the slot and the swap recorded, or null.
function place({ library, equipment, sessions, session, blockIndex, slotIndex }, movementId, now) {
  const old = itemAt(session, blockIndex, slotIndex);
  const letter = session.blocks[blockIndex].block;
  const prev = session.rerolls && typeof session.rerolls.count === 'number'
    ? session.rerolls : { count: 0, history: [] };
  const count = prev.count + 1;
  const seedInt = hashString(String(session.seed) + '|swap|' + count + '|' + letter + ':' + slotIndex + ':' + movementId);
  const out = placeInSlot({ library, equipment, sessions, session, blockIndex, slotIndex, movementId, seedInt });
  if (!out) return null;
  const item = out.blocks[blockIndex].items[slotIndex];
  const excluded = [];
  (old.reroll_excluded || []).concat([old.movement_id]).forEach((id) => {
    if (id !== movementId && excluded.indexOf(id) < 0) excluded.push(id);
  });
  item.reroll_excluded = excluded;
  item.swapped_from = old.movement_id;
  out.rerolls = {
    count,
    history: (prev.history || []).concat([{
      at: toIso(now),
      scope: { type: 'swap', block: letter, slot: slotIndex },
      changes: [{ block: letter, slot: slotIndex, from: old.movement_id, to: movementId }],
      finisher: { from: session.finisher ? session.finisher.id : null, to: out.finisher ? out.finisher.id : null },
    }]),
  };
  return out;
}

function clean(params, out) {
  return !!out && validateSession({
    library: params.library, equipment: params.equipment, sessions: params.sessions || [], session: out,
  }).length === 0;
}

// Valid swaps for one slot, least recently done first (never done first), then by name.
export function swapCandidates(params) {
  const { library, sessions } = params;
  const history = sessions || [];
  const ids = groupAlternatives(params).filter((id) => clean(params, place(params, id, null)));
  const lastDone = new Map();
  history.forEach((s, i) => activeItems(s).forEach((it) => lastDone.set(it.movement_id, i)));
  const byId = new Map(library.movements.map((m) => [m.id, m]));
  const since = (id) => (lastDone.has(id) ? history.length - 1 - lastDone.get(id) : Infinity);
  return ids.slice().sort((a, b) => {
    const sa = since(a);
    const sb = since(b);
    if (sa !== sb) return sa > sb ? -1 : 1;
    const na = byId.get(a).name;
    const nb = byId.get(b).name;
    if (na !== nb) return na < nb ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

// The session with the slot's movement replaced by movementId. Throws unless movementId is one
// of swapCandidates for the slot.
export function swapSlot(params) {
  const { session, blockIndex, slotIndex, movementId, now } = params;
  const b = session && session.blocks ? session.blocks[blockIndex] : null;
  const where = (b ? b.block : '?') + (Number(slotIndex) + 1);
  if (groupAlternatives(params).indexOf(movementId) < 0) {
    throw new Error(movementId + ' is not a swap candidate for ' + where);
  }
  const out = place(params, movementId, now);
  if (!clean(params, out)) throw new Error(movementId + ' is not a swap candidate for ' + where);
  return out;
}
