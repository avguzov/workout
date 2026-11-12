// Summary of the last completed session: duration, volume and how it compares, bodyweight
// reps and timed seconds, finisher, notes, and Done.

import { h, button } from '../dom.js';
import * as F from '../format.js';
import { sessionVolume, compareVolume } from '../../engine/index.js';

export function durationSec(session) {
  const start = Date.parse(session.started_at || session.created_at);
  const end = Date.parse(session.completed_at);
  if (!isFinite(start) || !isFinite(end)) return 0;
  return Math.max(0, Math.round((end - start) / 1000));
}

export function finisherStatus(session) {
  if (!session.finisher) return 'none';
  return session.finisher.done ? 'done' : 'skipped';
}

export function stat(label, value, data) {
  return h('div', { class: 'stat', data }, h('span', { class: 'stat-label' }, label), h('span', { class: 'stat-value' }, value));
}

// Volume, its comparison, duration, and finisher status of `s`. `history` is the completed list
// to compare against (compareVolume leaves `s` itself out).
export function sessionFacts(s, history) {
  return { vol: sessionVolume(s), cmp: compareVolume(s, history), dur: durationSec(s), fin: finisherStatus(s) };
}

// Data attributes for a screen root that shows one session (Summary and the History detail).
export function factsData(s, facts) {
  return {
    sessionId: s.id, dayType: s.day_type, volumeLb: facts.vol.volume_lb, bodyweightReps: facts.vol.bodyweight_reps,
    timedSec: facts.vol.timed_sec, durationSec: facts.dur, finisher: facts.fin,
  };
}

// Duration, volume and the comparison, per-block volume, bodyweight reps, timed work, finisher.
export function statsCard(s, facts) {
  const { vol, cmp, dur, fin } = facts;
  return h('section', { class: 'card stats' },
    stat('Duration', F.formatDuration(dur)),
    stat('Volume', F.formatNumber(vol.volume_lb) + ' lb', { volume: '' }),
    h('p', { class: 'compare', data: { compared: cmp ? cmp.sessions_compared : 0 } }, F.comparisonText(cmp, s.day_type)),
    vol.blocks.filter((b) => b.rounds > 0).map((b) =>
      stat('Block ' + b.block, F.formatNumber(b.volume_lb) + ' lb', { blockVolume: b.volume_lb, block: b.block })),
    stat('Bodyweight reps', F.formatNumber(vol.bodyweight_reps)),
    stat('Timed work', F.formatNumber(vol.timed_sec) + ' sec'),
    s.finisher ? stat('Finisher', (s.finisher.name || s.finisher.id) + ', ' + fin) : null);
}

export function render(ctx) {
  const sessions = ctx.doc.sessions;
  const s = sessions[sessions.length - 1];
  const facts = sessionFacts(s, sessions);
  const main = h('div', {
    class: 'screen summary',
    data: Object.assign({ screen: 'summary' }, factsData(s, facts)),
  },
  h('header', { class: 'screen-head' },
    h('p', { class: 'eyebrow' }, s.ended_early ? 'Ended early' : 'Workout done'),
    h('h1', null, F.dayLabel(s.day_type) + ' day')),
  statsCard(s, facts),
  h('section', { class: 'card' },
    h('label', { class: 'label', for: 'notes' }, 'Notes'),
    h('textarea', { id: 'notes', rows: '4', data: { field: 'notes' }, placeholder: 'How it went, what to change next time' })),
  );
  main.querySelector('textarea').value = s.notes || '';
  const bar = h('div', { class: 'bar-row' }, button('Done', 'summary-done', null, { class: 'btn primary' }));
  return { main, bar };
}

export const actions = {
  'summary-done'(ctx) {
    ctx.go('today');
  },
};

// Notes save on every input without re-rendering, so the textarea keeps focus.
export const inputs = {
  notes(ctx, value) {
    ctx.commit((doc) => {
      const s = doc.sessions[doc.sessions.length - 1];
      if (s) s.notes = value;
    }, { render: false });
  },
};
