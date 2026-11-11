// Workout: warm-up, then one block at a time as a circuit (each round runs its movements in
// order, then rest), effort per movement after the block's last round, the finisher, Summary.

import { h, button } from '../dom.js';
import * as F from '../format.js';
import * as W from '../flow.js';
import { nextWeight, previousWeight } from '../../engine/index.js';
import { finisherCard } from './today.js';

let timer = null;

function stepFor(unit) {
  return unit === 'seconds' ? 5 : 1;
}

function itemWeighted(item) {
  return !!(item.load && item.load.source !== 'bodyweight' && item.load.weight_lb_per_dumbbell != null);
}

// Undo sits at the top right, away from Confirm, and only when the current block has a
// confirmed round to take back.
function head(ctx, s, eyebrow, title, data) {
  return h('header', { class: 'screen-head workout-head', data: data || null },
    h('div', { class: 'head-text' },
      h('p', { class: 'eyebrow' }, eyebrow),
      h('h1', null, title)),
    W.canUndo(s)
      ? button('Undo', 'undo', null, { class: 'btn small ghost undo-btn', 'aria-label': 'Undo last confirmed round' })
      : null);
}

function controls() {
  return h('div', { class: 'danger-zone' },
    button('End workout early', 'end-early', null, { class: 'btn ghost' }),
    button('Discard workout', 'discard', null, { class: 'btn ghost danger' }));
}

function confirmBar(ctx) {
  if (ctx.ui.confirm === 'end') {
    return h('div', { class: 'confirm', role: 'alertdialog', 'aria-label': 'End workout early' },
      h('p', null, 'End now? Confirmed rounds are saved and the rest stays unlogged.'),
      h('div', { class: 'bar-row' },
        button('Keep going', 'cancel-confirm', null, { class: 'btn' }),
        button('End workout', 'confirm-end', null, { class: 'btn primary' })));
  }
  return h('div', { class: 'confirm', role: 'alertdialog', 'aria-label': 'Discard workout' },
    h('p', null, 'Discard this workout? Nothing from it is saved.'),
    h('div', { class: 'bar-row' },
      button('Keep going', 'cancel-confirm', null, { class: 'btn' }),
      button('Discard', 'confirm-discard', null, { class: 'btn primary danger' })));
}

function loggedChips(block, item) {
  const rounds = (item.logged && item.logged.rounds) || [];
  const chips = [];
  for (let r = 0; r < block.rounds; r++) {
    const lr = rounds[r];
    if (lr) {
      chips.push(h('span', {
        class: 'chip done',
        data: { loggedRound: r, value: lr.value, weight: lr.weight_lb_per_dumbbell == null ? '' : lr.weight_lb_per_dumbbell },
      }, F.chipText(lr, item.target.unit)));
    } else {
      chips.push(h('span', { class: 'chip' }, '-'));
    }
  }
  return h('div', { class: 'chips', 'aria-label': 'Rounds' }, chips);
}

function circuitList(ctx, block, activeIndex, roundDone) {
  return h('ol', { class: 'circuit' }, block.items.map((it, ii) => {
    const mv = ctx.movement(it.movement_id);
    const state = ii === activeIndex ? 'active' : (ii < activeIndex || roundDone ? 'done' : 'next');
    return h('li', { class: 'circuit-item ' + state, data: { movementId: it.movement_id, item: ii } },
      h('div', { class: 'circuit-name' }, h('strong', null, mv ? mv.name : it.movement_id),
        h('span', { class: 'meta' }, F.formatPlan(it.target, it.load))),
      loggedChips(block, it));
  }));
}

function renderWarmup(ctx, s) {
  const wu = ctx.library.warm_up;
  const first = W.activeBlockIndexes(s)[0];
  const main = h('div', { class: 'screen workout', data: { screen: 'workout', phase: 'warmup' } },
    head(ctx, s, F.dayLabel(s.day_type) + ' day', 'Warm-up'),
    h('section', { class: 'card' },
      h('p', { class: 'meta' }, wu.rounds + ' rounds'),
      h('ul', { class: 'plain big' }, wu.movements.map((m) => h('li', null, m)))),
    controls());
  const label = first != null ? 'Start Block ' + s.blocks[first].block : 'Continue';
  return { main, bar: h('div', { class: 'bar-row' }, button(label, 'warmup-done', null, { class: 'btn primary' })) };
}

function renderRound(ctx, s, p) {
  const block = s.blocks[p.block];
  const item = block.items[p.item];
  const mv = ctx.movement(item.movement_id);
  const entry = W.currentEntry(s);
  const pre = W.prefill(s, p.block, p.item);
  const weighted = itemWeighted(item);
  const eq = ctx.doc.equipment;
  const up = weighted && mv ? nextWeight(mv, eq, entry.weight) : null;
  const down = weighted && mv ? previousWeight(mv, eq, entry.weight) : null;
  const unit = item.target.unit;
  const edited = entry.value !== pre.value || entry.weight !== pre.weight;
  const main = h('div', {
    class: 'screen workout',
    data: { screen: 'workout', phase: 'round', blockIndex: p.block, block: block.block, round: p.round, item: p.item },
  },
  head(ctx, s, F.dayLabel(s.day_type) + ' day, Block ' + block.block, F.roundLabel(p.round, block.rounds)),
  h('section', {
    class: 'card active-card',
    data: { activeItem: p.item, movementId: item.movement_id, value: entry.value, weight: entry.weight == null ? '' : entry.weight, unit },
  },
  h('h2', null, mv ? mv.name : item.movement_id),
  h('p', { class: 'meta target-line' }, 'Target ' + F.formatPlan(item.target, item.load) + (edited ? ', edited' : '')),
  h('div', { class: 'stepper', role: 'group', 'aria-label': unit === 'seconds' ? 'Seconds' : 'Reps' },
    button('-', 'value-down', null, { class: 'btn step', 'aria-label': 'Less', disabled: entry.value <= 0 }),
    h('output', { class: 'step-value', data: { entryValue: entry.value } },
      h('span', { class: 'num' }, F.formatNumber(entry.value)),
      h('span', { class: 'unit' }, F.unitWord(unit, entry.value) + (item.target.per_side ? ' per side' : ''))),
    button('+', 'value-up', null, { class: 'btn step', 'aria-label': 'More' })),
  weighted ? h('div', { class: 'stepper', role: 'group', 'aria-label': 'Weight' },
    button('-', 'weight-down', null, { class: 'btn step', 'aria-label': 'Lighter', disabled: down == null }),
    h('output', { class: 'step-value', data: { entryWeight: entry.weight } },
      h('span', { class: 'num' }, F.formatNumber(entry.weight)),
      h('span', { class: 'unit' }, 'lb')),
    button('+', 'weight-up', null, { class: 'btn step', 'aria-label': 'Heavier', disabled: up == null })) : null),
  circuitList(ctx, block, p.item, false),
  controls());
  const bar = h('div', { class: 'bar-row' },
    button(F.confirmLabel(entry, item), 'confirm', null, { class: 'btn primary confirm-btn' }));
  return { main, bar };
}

function renderRest(ctx, s, p) {
  const block = s.blocks[p.block];
  const first = ctx.movement(block.items[0].movement_id);
  const remaining = W.restRemainingSec(s, ctx.now());
  const main = h('div', {
    class: 'screen workout',
    data: { screen: 'workout', phase: 'rest', blockIndex: p.block, block: block.block, round: p.round, item: 0 },
  },
  head(ctx, s, F.dayLabel(s.day_type) + ' day, Block ' + block.block, 'Rest'),
  h('section', { class: 'card rest-card' },
    h('p', { class: 'clock', data: { restEndsAt: p.rest_ends_at }, 'aria-live': 'off' }, F.formatClock(remaining)),
    h('p', { class: 'meta' }, 'Next: ' + F.roundLabel(p.round, block.rounds) + ', starting with ' + (first ? first.name : '')),
    button('+15 sec', 'rest-add', null, { class: 'btn' })),
  circuitList(ctx, block, -1, true),
  controls());
  return { main, bar: h('div', { class: 'bar-row' }, button('Skip rest', 'rest-skip', null, { class: 'btn primary' })) };
}

function renderEffort(ctx, s, p) {
  const block = s.blocks[p.block];
  const list = W.activeBlockIndexes(s);
  const next = list.find((i) => i > p.block);
  const label = next != null ? 'Start Block ' + s.blocks[next].block : (s.finisher ? 'Go to finisher' : 'Finish workout');
  const ready = W.effortsComplete(s);
  const main = h('div', {
    class: 'screen workout',
    data: { screen: 'workout', phase: 'effort', blockIndex: p.block, block: block.block, round: p.round },
  },
  head(ctx, s, F.dayLabel(s.day_type) + ' day', 'Block ' + block.block + ' done'),
  h('p', { class: 'lead' }, 'How did the last round of each one feel?'),
  block.items.map((it, ii) => {
    const mv = ctx.movement(it.movement_id);
    const chosen = it.logged ? it.logged.effort : null;
    return h('section', { class: 'card effort-card', data: { movementId: it.movement_id, item: ii, effort: chosen || '' } },
      h('h2', null, mv ? mv.name : it.movement_id),
      loggedChips(block, it),
      h('div', { class: 'effort-row', role: 'group', 'aria-label': 'Effort' }, F.EFFORT_ORDER.map((e) =>
        button(F.EFFORT_SHORT[e], 'effort', { item: ii, effort: e, movementId: it.movement_id },
          { class: 'btn effort-btn', 'aria-pressed': chosen === e ? 'true' : 'false' }))));
  }),
  controls());
  return {
    main,
    bar: h('div', { class: 'bar-row' }, button(label, 'effort-done', null, { class: 'btn primary', disabled: !ready })),
  };
}

function renderFinisher(ctx, s) {
  const main = h('div', { class: 'screen workout', data: { screen: 'workout', phase: 'finisher' } },
    head(ctx, s, F.dayLabel(s.day_type) + ' day', 'Finisher'),
    finisherCard(ctx.library, s.finisher, { nameOnly: true }),
    controls());
  const bar = h('div', { class: 'bar-row' },
    button('Skipped', 'finisher-skip', null, { class: 'btn' }),
    button('Done', 'finisher-done', null, { class: 'btn primary' }));
  return { main, bar };
}

export function render(ctx) {
  const s = ctx.doc.current;
  const p = s.progress;
  let view;
  if (p.phase === 'warmup') view = renderWarmup(ctx, s);
  else if (p.phase === 'round') view = renderRound(ctx, s, p);
  else if (p.phase === 'rest') view = renderRest(ctx, s, p);
  else if (p.phase === 'effort') view = renderEffort(ctx, s, p);
  else view = renderFinisher(ctx, s);
  if (ctx.ui.confirm) view.bar = confirmBar(ctx);
  return view;
}

export function mounted(ctx, root) {
  stopTimer();
  const s = ctx.doc.current;
  if (!s || !s.progress || s.progress.phase !== 'rest') return;
  const clock = root.querySelector('[data-rest-ends-at]');
  const tick = () => {
    const cur = ctx.doc.current;
    if (!cur || !cur.progress || cur.progress.phase !== 'rest') { stopTimer(); return; }
    const left = W.restRemainingSec(cur, ctx.now());
    if (clock) clock.textContent = F.formatClock(left);
    if (left <= 0) {
      stopTimer();
      ctx.commit((doc) => { doc.current = W.endRest(doc.current); });
    }
  };
  timer = setInterval(tick, 250);
}

export function unmount() {
  stopTimer();
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

function update(ctx, fn) {
  ctx.commit((doc) => { doc.current = fn(doc.current); });
}

function complete(ctx, session) {
  ctx.ui.confirm = null;
  ctx.commit((doc) => {
    doc.sessions.push(session);
    doc.current = null;
  }, { render: false });
  ctx.go('summary');
}

function stepDraft(ctx, change) {
  const s = ctx.doc.current;
  const p = s.progress;
  const item = s.blocks[p.block].items[p.item];
  const mv = ctx.movement(item.movement_id);
  const e = W.currentEntry(s);
  const next = { value: e.value, weight: e.weight };
  if (change === 'value-up') next.value = e.value + stepFor(item.target.unit);
  if (change === 'value-down') next.value = Math.max(0, e.value - stepFor(item.target.unit));
  if (change === 'weight-up' && e.weight != null) {
    const w = nextWeight(mv, ctx.doc.equipment, e.weight);
    if (w == null) return;
    next.weight = w;
  }
  if (change === 'weight-down' && e.weight != null) {
    const w = previousWeight(mv, ctx.doc.equipment, e.weight);
    if (w == null) return;
    next.weight = w;
  }
  update(ctx, (cur) => W.setDraft(cur, next));
}

export const actions = {
  'warmup-done'(ctx) {
    update(ctx, W.finishWarmup);
  },
  'value-up'(ctx) { stepDraft(ctx, 'value-up'); },
  'value-down'(ctx) { stepDraft(ctx, 'value-down'); },
  'weight-up'(ctx) { stepDraft(ctx, 'weight-up'); },
  'weight-down'(ctx) { stepDraft(ctx, 'weight-down'); },
  confirm(ctx) {
    update(ctx, (cur) => W.confirmRound(cur, null, ctx.now()));
  },
  'rest-skip'(ctx) {
    update(ctx, W.endRest);
  },
  'rest-add'(ctx) {
    update(ctx, (cur) => W.addRest(cur, 15, ctx.now()));
  },
  effort(ctx, data) {
    update(ctx, (cur) => W.setEffort(cur, Number(data.item), data.effort));
  },
  'effort-done'(ctx) {
    if (!W.effortsComplete(ctx.doc.current)) return;
    const next = W.finishEffort(ctx.doc.current, ctx.now());
    if (next.completed_at) complete(ctx, next);
    else update(ctx, () => next);
  },
  'finisher-done'(ctx) {
    complete(ctx, W.finishFinisher(ctx.doc.current, true, ctx.now()));
  },
  'finisher-skip'(ctx) {
    complete(ctx, W.finishFinisher(ctx.doc.current, false, ctx.now()));
  },
  undo(ctx) {
    if (!W.canUndo(ctx.doc.current)) return;
    ctx.ui.confirm = null;
    update(ctx, W.undoRound);
  },
  'end-early'(ctx) {
    ctx.ui.confirm = 'end';
    ctx.render();
  },
  discard(ctx) {
    ctx.ui.confirm = 'discard';
    ctx.render();
  },
  'cancel-confirm'(ctx) {
    ctx.ui.confirm = null;
    ctx.render();
  },
  'confirm-end'(ctx) {
    complete(ctx, W.endEarly(ctx.doc.current, ctx.now()));
  },
  'confirm-discard'(ctx) {
    ctx.ui.confirm = null;
    ctx.commit((doc) => { doc.current = null; }, { render: false });
    ctx.go('today');
  },
};
