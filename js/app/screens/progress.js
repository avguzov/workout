// Progress: sessions per week against a goal of 3, volume by day type, and one movement over
// time. The movement choice is ctx.ui.progressMovement (memory only); it defaults to the most
// recently performed movement.

import { h } from '../dom.js';
import * as F from '../format.js';
import { weeklyCounts, volumeByDayType, movementHistory, movementsWithHistory, DAY_TYPES } from '../stats.js';
import { barChart, lineChart, seriesText } from '../charts.js';

export const GOAL_PER_WEEK = 3;
export const WEEKS = 8;
export const VOLUME_POINTS = 12;
export const MOVEMENT_POINTS = 12;
export const MOVEMENT_ENTRIES = 6;

let shown = null; // movement id in the rendered select
let refocus = false; // put focus back on the select after a choice re-renders the screen

function section(title, key, ...children) {
  return h('section', { class: 'card progress-section', data: { section: key } }, h('h2', null, title), children);
}

function signed(n) {
  return (n > 0 ? '+' : '') + F.formatNumber(n) + ' lb';
}

function weekly(ctx, sessions) {
  const weeks = weeklyCounts(sessions, ctx.now(), WEEKS);
  const last = weeks.length - 1;
  const now = weeks[last].count;
  const headline = now <= GOAL_PER_WEEK ? now + ' of ' + GOAL_PER_WEEK + ' this week' : now + ' this week, goal ' + GOAL_PER_WEEK;
  const aria = 'Sessions per week for the last ' + WEEKS + ' weeks, from the week of ' + F.formatDate(weeks[0].week_start) +
    ' to this week: ' + seriesText(weeks.map((w) => F.formatNumber(w.count))) + '. Goal ' + GOAL_PER_WEEK + ' per week.';
  return section('Sessions per week', 'weekly',
    h('p', { class: 'chart-headline', data: { thisWeek: now } }, headline),
    h('div', { class: 'chart-block', data: { chart: 'weekly', weeks: WEEKS, goal: GOAL_PER_WEEK } },
      barChart(weeks.map((w, i) => ({
        value: w.count, label: F.formatDate(w.week_start), current: i === last, data: { weekStart: w.week_start, count: w.count },
      })), { ariaLabel: aria, goal: GOAL_PER_WEEK, goalLabel: 'Goal ' + GOAL_PER_WEEK })));
}

function volumeChart(dayType, all) {
  const label = F.dayLabel(dayType);
  const day = label.toLowerCase();
  const pts = all.slice(-VOLUME_POINTS);
  const root = { class: 'chart-block volume-block', data: { chart: 'volume', dayType, points: pts.length, sessions: all.length } };
  if (!pts.length) return h('div', root, h('h3', null, label), h('p', { class: 'note', data: { volumeEmpty: '' } }, 'No ' + day + ' sessions yet'));
  const latest = all[all.length - 1];
  const prev = all.length > 1 ? all[all.length - 2] : null;
  const change = prev ? signed(latest.volume_lb - prev.volume_lb) + ' from ' + F.formatDate(prev.date) : 'First ' + day + ' session';
  const aria = label + ' volume for the last ' + (pts.length === 1 ? 'session' : pts.length + ' sessions') + ': ' +
    seriesText(pts.map((p) => F.formatDate(p.date) + ' ' + F.formatNumber(p.volume_lb) + ' lb')) + '.';
  return h('div', root,
    h('div', { class: 'chart-title' },
      h('h3', null, label),
      h('p', { class: 'chart-headline' },
        h('span', { class: 'chart-big', data: { latestLb: latest.volume_lb } }, F.formatNumber(latest.volume_lb) + ' lb'),
        h('span', { class: 'chart-change', data: { changeLb: prev ? latest.volume_lb - prev.volume_lb : '' } }, change))),
    lineChart(pts.map((p) => ({ value: p.volume_lb, label: F.formatDate(p.date), data: { volumeLb: p.volume_lb, sessionId: p.session_id } })),
      { ariaLabel: aria }));
}

function volume(sessions) {
  const by = volumeByDayType(sessions);
  return section('Volume by day type', 'volume', DAY_TYPES.map((dt) => volumeChart(dt, by[dt])));
}

function unitText(unit, perSide, value) {
  return F.unitWord(unit, value) + (perSide ? ' per side' : '');
}

function roundsText(e) {
  return e.values.map(F.formatNumber).join(', ') + ' ' + unitText(e.unit, e.per_side, e.values.length === 1 ? e.values[0] : 2);
}

function movementCharts(name, hist) {
  const recent = hist.slice(-MOVEMENT_POINTS);
  const last = recent[recent.length - 1];
  const weighted = recent.filter((e) => e.weight_lb_per_dumbbell != null);
  const out = [];
  if (weighted.length) {
    out.push(h('div', { class: 'chart-block', data: { chart: 'movement-weight', points: weighted.length } },
      h('h3', null, 'Weight per dumbbell, lb'),
      lineChart(weighted.map((e) => ({
        value: e.weight_lb_per_dumbbell, label: F.formatDate(e.date), data: { value: e.weight_lb_per_dumbbell, sessionId: e.session_id },
      })), {
        ariaLabel: name + ', weight per dumbbell: ' +
          seriesText(weighted.map((e) => F.formatDate(e.date) + ' ' + F.formatWeight(e.weight_lb_per_dumbbell))) + '.',
      })));
  }
  const unit = unitText(last.unit, last.per_side, 2);
  out.push(h('div', { class: 'chart-block', data: { chart: 'movement-value', points: recent.length, unit: last.unit } },
    h('h3', null, 'Best round, ' + unit),
    lineChart(recent.map((e) => ({ value: e.best_value, label: F.formatDate(e.date), data: { value: e.best_value, sessionId: e.session_id } })), {
      ariaLabel: name + ', best round in ' + unit + ': ' +
        seriesText(recent.map((e) => F.formatDate(e.date) + ' ' + F.formatNumber(e.best_value))) + '.',
    })));
  return out;
}

function entryRow(e) {
  return h('li', {
    class: 'entry-row',
    data: { movementEntry: '', sessionId: e.session_id, weight: e.weight_lb_per_dumbbell == null ? '' : e.weight_lb_per_dumbbell, values: e.values.join(','), effort: e.effort || '' },
  },
  h('span', { class: 'entry-top' },
    h('span', { class: 'entry-date' }, F.formatDate(e.date)),
    h('span', { class: 'entry-effort' }, F.effortLabel(e.effort))),
  h('span', { class: 'history-facts' },
    h('span', { class: 'history-fact entry-load' }, F.formatLoad(e.load)),
    h('span', { class: 'history-fact entry-rounds' }, roundsText(e))));
}

function exercise(ctx, sessions) {
  const moves = movementsWithHistory(sessions, ctx.library);
  if (!moves.length) {
    shown = null;
    return section('Exercise', 'exercise', h('p', { class: 'note' }, 'No logged movements yet'));
  }
  const want = ctx.ui.progressMovement;
  const pick = moves.find((m) => m.movement_id === want) || moves[0];
  shown = pick.movement_id;
  const select = h('select', { id: 'progress-movement', class: 'progress-select', data: { field: 'progress-movement' } },
    moves.map((m) => h('option', { value: m.movement_id, selected: m.movement_id === pick.movement_id }, m.name)));
  select.value = pick.movement_id;
  const hist = movementHistory(sessions, pick.movement_id);
  return section('Exercise', 'exercise',
    h('label', { class: 'label', for: 'progress-movement' }, 'Movement'),
    select,
    h('div', { class: 'movement-detail', data: { movementId: pick.movement_id, entries: hist.length } },
      movementCharts(pick.name, hist),
      h('h3', null, 'Recent sessions'),
      h('ul', { class: 'entry-list' }, hist.slice(-MOVEMENT_ENTRIES).reverse().map(entryRow))));
}

export function render(ctx) {
  const sessions = ctx.doc.sessions;
  const head = h('header', { class: 'screen-head' }, h('h1', null, 'Progress'));
  if (!sessions.length) {
    shown = null;
    return {
      main: h('div', { class: 'screen progress', data: { screen: 'progress', sessions: 0 } },
        head, h('p', { class: 'note', data: { progressEmpty: '' } }, 'Log a workout to see progress')),
      bar: null,
    };
  }
  return {
    main: h('div', { class: 'screen progress', data: { screen: 'progress', sessions: sessions.length } },
      head, weekly(ctx, sessions), volume(sessions), exercise(ctx, sessions)),
    bar: null,
  };
}

function choose(ctx, value) {
  if (!value || value === shown) return;
  ctx.ui.progressMovement = value;
  refocus = true;
  ctx.render();
}

// Also listen for change: some browsers fire only change on a select. choose() ignores the repeat.
export function mounted(ctx, root) {
  const sel = root.querySelector('[data-field="progress-movement"]');
  if (!sel) { refocus = false; return; }
  sel.addEventListener('change', () => choose(ctx, sel.value));
  if (refocus) {
    refocus = false;
    try { sel.focus({ preventScroll: true }); } catch (e) { /* focus is a nicety */ }
  }
}

export const inputs = {
  'progress-movement'(ctx, value) {
    choose(ctx, value);
  },
};
