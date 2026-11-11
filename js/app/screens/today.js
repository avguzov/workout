// Today: next session, length picker, blocks with last-time numbers and recommendation notes,
// shuffle controls, and Start or Resume.

import { h, button } from '../dom.js';
import * as F from '../format.js';
import { isStarted, changeLength, rerollSession, startWorkout } from '../flow.js';
import { ALLOWED_LENGTHS } from '../../engine/index.js';

export function finisherWeight(library, finisher) {
  if (!finisher) return null;
  if (finisher.weight_lb_per_dumbbell != null) return finisher.weight_lb_per_dumbbell;
  const f = library.finishers.find((x) => x.id === finisher.id);
  return f && f.load && f.load.source !== 'bodyweight' ? f.load.weight_lb_per_dumbbell : null;
}

// opts.nameOnly titles the card with the finisher name alone (the Workout screen already says
// "Finisher" in its heading).
export function finisherCard(library, finisher, opts) {
  const f = library.finishers.find((x) => x.id === finisher.id) || { movements: [], rounds: 0, rest_sec: 0 };
  const w = finisherWeight(library, finisher);
  const meta = [f.rounds + ' rounds', f.rest_sec + ' sec rest'];
  if (w != null) {
    meta.push(F.formatLoad({ source: f.load ? f.load.source : 'fixed', dumbbells: f.load ? f.load.dumbbells : 1, weight_lb_per_dumbbell: w }));
  }
  const name = finisher.name || f.name;
  return h('section', { class: 'card finisher', data: { finisherId: finisher.id } },
    h('h2', null, opts && opts.nameOnly ? name : 'Finisher: ' + name),
    h('p', { class: 'meta' }, meta.join(', ')),
    h('ul', { class: 'plain' }, (f.movements || []).map((m) => h('li', null, m))),
    f.note ? h('p', { class: 'note' }, f.note) : null);
}

function itemRow(ctx, session, block, item, started) {
  const mv = ctx.movement(item.movement_id) || { name: item.movement_id, load: { default_source: 'fixed' } };
  const rec = item.recommendation || null;
  const last = rec && rec.last ? rec.last : null;
  const data = { movementId: item.movement_id, block: block.block, slot: item.slot };
  if (last) {
    data.lastDate = last.date || '';
    data.lastWeight = last.weight_lb_per_dumbbell == null ? '' : last.weight_lb_per_dumbbell;
    data.lastValues = (last.values_by_round || []).join(',');
    data.lastEffort = last.effort || '';
  }
  const flags = F.flagLines(item, ctx.library, session.day_type);
  return h('li', { class: 'item', data },
    h('div', { class: 'item-main' },
      h('h3', null, mv.name),
      h('p', { class: 'target' }, F.formatPlan(item.target, item.load)),
      last ? h('p', { class: 'last', data: { last: '' } }, 'Last time ' + F.formatLast(last, item.target)) : null,
      rec ? h('p', { class: 'basis', data: { basis: rec.basis } }, F.basisLine(rec, mv)) : null,
      flags.length ? h('ul', { class: 'flags' }, flags.map((t) => h('li', null, t))) : null),
    started ? null : button('Shuffle', 'reroll-slot', { block: block.block, slot: item.slot },
      { class: 'btn small ghost', 'aria-label': 'Shuffle ' + mv.name }));
}

function blockCard(ctx, session, block, started) {
  const rounds = block.rounds < block.planned_rounds
    ? block.rounds + ' of ' + block.planned_rounds + ' rounds'
    : block.rounds + ' rounds';
  return h('section', { class: 'card block', data: { block: block.block, rounds: block.rounds } },
    h('div', { class: 'block-head' },
      h('div', null,
        h('h2', null, 'Block ' + block.block),
        h('p', { class: 'meta' }, rounds + ', ' + block.rest_sec + ' sec rest'),
        block.adjustable_setting_lb != null
          ? h('p', { class: 'meta setting', data: { setting: block.adjustable_setting_lb } },
            'Set the adjustable to ' + F.formatWeight(block.adjustable_setting_lb))
          : null),
      started ? null : button('Shuffle block', 'reroll-block', { block: block.block }, { class: 'btn small ghost' })),
    h('ol', { class: 'items' }, block.items.map((it) => itemRow(ctx, session, block, it, started))));
}

export function render(ctx) {
  const ui = ctx.ui;
  if (ui.genError) {
    return {
      main: h('div', { class: 'screen today', data: { screen: 'today', error: '' } },
        h('h1', null, 'Could not build a session'),
        h('p', { class: 'note warn' }, ui.genError.message),
        ui.genError.violations && ui.genError.violations.length
          ? h('ul', { class: 'flags' }, ui.genError.violations.map((v) => h('li', null, v.rule + ': ' + v.message)))
          : null),
      bar: h('div', { class: 'bar-row' }, button('Try again', 'regenerate', null, { class: 'btn primary' })),
    };
  }
  const s = ctx.doc.current;
  const started = isStarted(s);
  const est = F.estimateText(s);
  const main = h('div', {
    class: 'screen today',
    data: {
      screen: 'today', dayType: s.day_type, sessionId: s.id, started: started ? '1' : '0',
      lengthMin: s.length_min, rerolls: s.rerolls ? s.rerolls.count : 0,
    },
  },
    h('header', { class: 'screen-head' },
      h('p', { class: 'eyebrow' }, 'Next session'),
      h('h1', null, F.dayLabel(s.day_type) + ' day'),
      h('p', { class: 'estimate', data: { estimateSec: s.estimate_sec } }, est.est),
      est.over ? h('p', { class: 'note warn', data: { overLengthSec: s.over_length_sec } }, est.over) : null,
      started ? h('p', { class: 'note' }, 'Workout in progress. Resume to pick up where you left off.') : null),
    ui.flash ? h('p', { class: 'flash ' + (ui.flash.kind || ''), role: 'status', data: { flash: ui.flash.kind || 'info' } }, ui.flash.text) : null,
    started ? null : h('section', { class: 'length' },
      h('h2', { class: 'label' }, 'Length'),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Session length' },
        ALLOWED_LENGTHS.map((m) => button(m + ' min', 'length', { length: m },
          { class: 'btn seg-btn', 'aria-pressed': s.length_min === m ? 'true' : 'false' })))),
    s.blocks.filter((b) => !b.removed && b.rounds > 0).map((b) => blockCard(ctx, s, b, started)),
    s.finisher ? finisherCard(ctx.library, s.finisher) : null,
    started ? null : h('div', { class: 'row-end' },
      button('Shuffle whole session', 'reroll-session', null, { class: 'btn ghost' })));
  const bar = h('div', { class: 'bar-row' }, started
    ? button('Resume', 'resume', null, { class: 'btn primary' })
    : button('Start', 'start', null, { class: 'btn primary' }));
  return { main, bar };
}

function applyPlan(ctx, result, failText) {
  if (result.violations.length) {
    ctx.ui.flash = {
      kind: 'error',
      text: failText + ' ' + result.violations.map((v) => v.rule + ': ' + v.message).join('. '),
    };
    ctx.render();
    return;
  }
  ctx.commit((doc) => { doc.current = result.session; });
}

function guarded(ctx, fn, failText) {
  try {
    applyPlan(ctx, fn(), failText);
  } catch (e) {
    ctx.ui.flash = { kind: 'error', text: failText + ' ' + String((e && e.message) || e) };
    ctx.render();
  }
}

export const actions = {
  length(ctx, data) {
    const lengthMin = Number(data.length);
    if (ctx.doc.current.length_min === lengthMin) return;
    guarded(ctx, () => changeLength({ library: ctx.library, doc: ctx.doc, lengthMin }),
      'That length would break the session rules, so the session is unchanged.');
  },
  'reroll-slot'(ctx, data) {
    guarded(ctx, () => rerollSession({
      library: ctx.library, doc: ctx.doc, now: ctx.now(), scope: { type: 'slot', block: data.block, slot: Number(data.slot) },
    }), 'Could not shuffle that movement, so the session is unchanged.');
  },
  'reroll-block'(ctx, data) {
    guarded(ctx, () => rerollSession({
      library: ctx.library, doc: ctx.doc, now: ctx.now(), scope: { type: 'block', block: data.block },
    }), 'Could not shuffle that block, so the session is unchanged.');
  },
  'reroll-session'(ctx) {
    guarded(ctx, () => rerollSession({
      library: ctx.library, doc: ctx.doc, now: ctx.now(), scope: { type: 'session' },
    }), 'Could not shuffle the session, so it is unchanged.');
  },
  start(ctx) {
    ctx.commit((doc) => { doc.current = startWorkout(doc.current, ctx.now()); }, { render: false });
    ctx.go('workout');
  },
  resume(ctx) {
    ctx.go('workout');
  },
  regenerate(ctx) {
    ctx.ui.genError = null;
    ctx.render();
  },
};
