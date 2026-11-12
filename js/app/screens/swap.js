// Swap sheet on Today: replace one movement of the unstarted session with another that works the
// same muscle group, fits the equipment, and keeps the session valid. A bottom sheet in the demo
// sheet's style. Today owns the open state, ctx.ui.swap = { block, slot, demo? } (memory only);
// `demo` is the candidate whose Form sheet is showing over it.

import { h, button } from '../dom.js';
import * as F from '../format.js';
import { swapOptions } from '../flow.js';

function candidateRow(ctx, option) {
  const mv = ctx.movement(option.movementId);
  const name = mv ? mv.name : option.movementId;
  const it = option.item;
  const last = it.recommendation && it.recommendation.last ? it.recommendation.last : null;
  return h('li', { class: 'swap-row', data: { swapCandidate: '', movementId: option.movementId } },
    h('div', { class: 'swap-info' },
      h('h3', null, name),
      h('p', { class: 'swap-plan' }, F.formatPlan(it.target, it.load)),
      last ? h('p', { class: 'last', data: { last: '' } }, 'Last time ' + F.formatLast(last, it.target)) : null),
    h('div', { class: 'swap-btns' },
      button('Form', 'swap-demo', { movementId: option.movementId }, { class: 'btn small', 'aria-label': 'Form for ' + name }),
      button('Use', 'swap-pick', { movementId: option.movementId }, { class: 'btn small primary', 'aria-label': 'Swap to ' + name })));
}

// -> DOM node, or null when the slot does not exist in the current session.
export function swapSheet(ctx, state) {
  const s = ctx.doc.current;
  const block = s && state ? s.blocks.find((b) => b.block === state.block) : null;
  const item = block ? block.items[Number(state.slot)] : null;
  if (!item) return null;
  const mv = ctx.movement(item.movement_id);
  const name = mv ? mv.name : item.movement_id;
  let options = [];
  try {
    options = swapOptions({ library: ctx.library, doc: ctx.doc, block: state.block, slot: state.slot });
  } catch (e) {
    options = [];
  }
  return h('div', {
    class: 'demo-layer swap-layer',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Swap ' + name,
    data: { swapSheet: '', block: block.block, slot: item.slot },
  },
  h('div', { class: 'demo-backdrop', data: { action: 'swap-close' } }),
  h('div', { class: 'demo-panel swap-panel' },
    h('h2', { class: 'demo-title' }, 'Swap ' + name),
    options.length
      ? h('p', { class: 'meta swap-sub' }, 'Same muscle group, fits your equipment')
      : h('p', { class: 'note swap-empty', data: { swapEmpty: '' } }, 'No other movement fits this slot with your equipment'),
    options.length ? h('ul', { class: 'swap-list' }, options.map((o) => candidateRow(ctx, o))) : null,
    h('div', { class: 'demo-actions' }, button('Close', 'swap-close', null, { class: 'btn' }))));
}
