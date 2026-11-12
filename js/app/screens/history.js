// History: completed sessions newest first (#/history) and a read-only detail of one session
// (#/history/<session id>, ctx.route.id) built from Summary's stats card, plus each movement with
// its logged round chips and effort, the finisher, and the notes. The comparison uses only the
// sessions before the one shown.

import { h, button } from '../dom.js';
import * as F from '../format.js';
import { sessionVolume } from '../../engine/index.js';
import { durationSec, finisherStatus, sessionFacts, factsData, statsCard } from './summary.js';

function rowFacts(s) {
  const fin = finisherStatus(s);
  return [
    F.formatDuration(durationSec(s)),
    F.formatNumber(sessionVolume(s).volume_lb) + ' lb',
    fin === 'none' ? null : 'Finisher ' + fin,
  ].filter(Boolean);
}

function row(s) {
  const vol = sessionVolume(s);
  return h('li', null,
    h('a', {
      class: 'history-row', href: '#/history/' + encodeURIComponent(s.id),
      data: { historyRow: '', sessionId: s.id, dayType: s.day_type, volumeLb: vol.volume_lb, endedEarly: s.ended_early ? '1' : '0' },
    },
    h('span', { class: 'history-top' },
      h('span', { class: 'history-day' }, F.dayLabel(s.day_type)),
      h('span', { class: 'history-date' }, F.formatDate(s.completed_at))),
    h('span', { class: 'history-facts' },
      rowFacts(s).map((t) => h('span', { class: 'history-fact' }, t)),
      s.ended_early ? h('span', { class: 'tag warn', data: { endedEarlyTag: '' } }, 'Ended early') : null)));
}

function list(ctx) {
  const sessions = ctx.doc.sessions;
  const main = h('div', { class: 'screen history', data: { screen: 'history', sessions: sessions.length } },
    h('header', { class: 'screen-head' }, h('h1', null, 'History')),
    sessions.length
      ? h('ul', { class: 'history-list card' }, sessions.slice().reverse().map(row))
      : h('p', { class: 'note', data: { historyEmpty: '' } }, 'No workouts logged yet'));
  return { main, bar: null };
}

function itemRow(ctx, it) {
  const m = ctx.movement(it.movement_id);
  const unit = it.target ? it.target.unit : 'reps';
  const rounds = (it.logged && Array.isArray(it.logged.rounds) ? it.logged.rounds : []).filter(Boolean);
  return h('li', { class: 'detail-item', data: { historyItem: '', movementId: it.movement_id, rounds: rounds.length } },
    h('span', { class: 'detail-name' }, (m && m.name) || it.movement_id),
    h('span', { class: 'meta' }, F.formatPlan(it.target, it.load)),
    rounds.length
      ? h('span', { class: 'chips' }, rounds.map((r, ri) => h('span', {
        class: 'chip done', data: { loggedRound: ri, value: r.value, weight: r.weight_lb_per_dumbbell == null ? '' : r.weight_lb_per_dumbbell },
      }, F.chipText(r, unit))))
      : h('span', { class: 'meta' }, 'Not logged'),
    h('span', { class: 'detail-effort', data: { effort: (it.logged && it.logged.effort) || '' } }, F.effortLabel(it.logged && it.logged.effort)));
}

function detail(ctx, id) {
  const sessions = ctx.doc.sessions;
  const index = sessions.findIndex((x) => x.id === id);
  const s = sessions[index];
  const facts = sessionFacts(s, sessions.slice(0, index));
  const blocks = (s.blocks || []).filter((b) => b.rounds > 0 && !b.removed);
  const main = h('div', {
    class: 'screen history-detail',
    data: Object.assign({ screen: 'history-detail' }, factsData(s, facts), { endedEarly: s.ended_early ? '1' : '0' }),
  },
  h('header', { class: 'screen-head' },
    h('p', { class: 'eyebrow' }, F.formatDate(s.completed_at) + (s.ended_early ? ', ended early' : '')),
    h('h1', null, F.dayLabel(s.day_type) + ' day')),
  statsCard(s, facts),
  blocks.map((b) => h('section', { class: 'card', data: { block: b.block } },
    h('h2', null, 'Block ' + b.block),
    h('p', { class: 'meta' }, b.rounds === 1 ? '1 round' : b.rounds + ' rounds'),
    h('ul', { class: 'detail-items' }, b.items.map((it) => itemRow(ctx, it))))),
  h('section', { class: 'card' },
    h('h2', { class: 'label' }, 'Notes'),
    s.notes && s.notes.trim()
      ? h('p', { class: 'detail-notes', data: { notes: '' } }, s.notes)
      : h('p', { class: 'note', data: { notes: '' } }, 'No notes')));
  const bar = h('div', { class: 'bar-row' }, button('Back', 'history-back', null, { class: 'btn' }));
  return { main, bar };
}

export function render(ctx) {
  const id = ctx.route && ctx.route.id;
  if (id && ctx.doc.sessions.some((s) => s.id === id)) return detail(ctx, id);
  return list(ctx);
}

export const actions = {
  'history-back'(ctx) {
    ctx.go('history');
  },
};
