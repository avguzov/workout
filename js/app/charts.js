// Small inline SVG charts, no library. Pure geometry (scales, bars, line paths, ticks) plus a DOM
// part that builds the SVG with createElementNS. Every chart has a viewBox and width 100%,
// role="img" with an aria-label that states the numbers, and colors only through CSS classes
// (.chart-*) that use the app's custom properties, so light and dark both work. No animation.
//
// Sizes are viewBox units. CHART_WIDTH 320 renders about 313 px wide inside a card at 375 px, so
// FONT_SIZE 13 renders at about 12.7 px.

import { formatNumber } from './format.js';

export const CHART_WIDTH = 320;
export const FONT_SIZE = 13;
export const POINT_RADIUS = 4;
const SVG_NS = 'http://www.w3.org/2000/svg';

const finite = (v) => typeof v === 'number' && isFinite(v);
const round1 = (v) => Math.round(v * 10) / 10;

// d0..d1 -> r0..r1. A zero-width domain maps everything to the middle of the range.
export function linearScale(d0, d1, r0, r1) {
  const span = d1 - d0;
  if (!finite(span) || span === 0) return () => (r0 + r1) / 2;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}

// Padded min to max range for a line: 12% of the span on each side, or a fixed pad when every
// value is equal (10% of the value, at least 1). Empty input gives 0..1.
export function paddedRange(values) {
  const vals = (values || []).filter(finite);
  if (!vals.length) return { min: 0, max: 0, lo: 0, hi: 1 };
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const pad = max > min ? (max - min) * 0.12 : Math.max(1, Math.abs(max) * 0.1);
  return { min, max, lo: min - pad, hi: max + pad };
}

// Bars from zero. values: numbers (non-finite and negative count as 0). opts.goal draws a goal
// line and reserves a right gutter for its label.
// -> { width, height, plot: { x0, x1, y0, y1 }, max, bars: [{ x, y, width, height, cx, value, labelY }],
//      goal: null | { value, y, x0, x1, labelX, labelY }, xLabels: [{ index, x, y, anchor }] }
export function barGeometry(values, opts) {
  const o = opts || {};
  const width = o.width || CHART_WIDTH;
  const height = o.height || 150;
  const goal = finite(o.goal) && o.goal > 0 ? o.goal : null;
  const vals = (values || []).map((v) => (finite(v) && v > 0 ? v : 0));
  const plot = { x0: 4, x1: width - (goal ? 58 : 4), y0: FONT_SIZE + 10, y1: height - (FONT_SIZE + 12) };
  const max = Math.max(1, goal || 0, ...vals);
  const y = linearScale(0, max, plot.y1, plot.y0);
  const n = vals.length;
  const band = n ? (plot.x1 - plot.x0) / n : 0;
  const bw = band * 0.62;
  const bars = vals.map((v, i) => {
    const x = plot.x0 + band * i + (band - bw) / 2;
    const top = round1(y(v));
    return { x: round1(x), y: top, width: round1(bw), height: round1(plot.y1 - top), cx: round1(x + bw / 2), value: v, labelY: round1(top - 5) };
  });
  const xLabels = [];
  const ly = height - 6;
  if (n === 1) xLabels.push({ index: 0, x: bars[0].cx, y: ly, anchor: 'middle' });
  else if (n > 1) {
    xLabels.push({ index: 0, x: bars[0].x, y: ly, anchor: 'start' });
    xLabels.push({ index: n - 1, x: round1(bars[n - 1].x + bars[n - 1].width), y: ly, anchor: 'end' });
  }
  const gy = goal ? round1(y(goal)) : null;
  return {
    width, height, plot, max, bars, xLabels,
    goal: goal ? { value: goal, y: gy, x0: plot.x0, x1: plot.x1, labelX: plot.x1 + 4, labelY: round1(gy + FONT_SIZE * 0.35) } : null,
  };
}

// Line with points over a padded min to max range, evenly spaced; one point sits in the middle.
// -> { width, height, plot, range: { min, max, lo, hi }, points: [{ x, y, value }], path,
//      ticks: [{ value, y, labelY }] (min and max, one when equal), xLabels: [{ index, x, y, anchor }] }
export function lineGeometry(values, opts) {
  const o = opts || {};
  const width = o.width || CHART_WIDTH;
  const height = o.height || 140;
  const vals = (values || []).map((v) => (finite(v) ? v : 0));
  const plot = { x0: 56, x1: width - 12, y0: 12, y1: height - (FONT_SIZE + 14) };
  const range = paddedRange(vals);
  const y = linearScale(range.lo, range.hi, plot.y1, plot.y0);
  const n = vals.length;
  const x = n > 1 ? linearScale(0, n - 1, plot.x0, plot.x1) : () => (plot.x0 + plot.x1) / 2;
  const points = vals.map((v, i) => ({ x: round1(x(i)), y: round1(y(v)), value: v }));
  const path = points.length > 1 ? 'M' + points.map((p) => p.x + ' ' + p.y).join(' L') : '';
  const ticks = [];
  if (n) {
    ticks.push({ value: range.max, y: round1(y(range.max)) });
    if (range.min !== range.max) ticks.push({ value: range.min, y: round1(y(range.min)) });
    ticks.forEach((t) => { t.labelY = round1(t.y + FONT_SIZE * 0.35); });
  }
  const xLabels = [];
  const ly = height - 6;
  if (n === 1) xLabels.push({ index: 0, x: points[0].x, y: ly, anchor: 'middle' });
  else if (n > 1) {
    xLabels.push({ index: 0, x: points[0].x - POINT_RADIUS, y: ly, anchor: 'start' });
    xLabels.push({ index: n - 1, x: points[n - 1].x + POINT_RADIUS, y: ly, anchor: 'end' });
  }
  return { width, height, plot, range, points, path, ticks, xLabels };
}

// ["a", "b", "c"] -> "a, b, and c"; two -> "a and b".
export function seriesText(items) {
  const a = (items || []).filter((x) => x != null && x !== '');
  if (a.length < 3) return a.join(' and ');
  return a.slice(0, -1).join(', ') + ', and ' + a[a.length - 1];
}

// ---------------------------------------------------------------- DOM

function svgEl(tag, attrs, data) {
  const el = document.createElementNS(SVG_NS, tag);
  Object.keys(attrs || {}).forEach((k) => { if (attrs[k] != null) el.setAttribute(k, String(attrs[k])); });
  Object.keys(data || {}).forEach((k) => {
    if (data[k] != null) el.setAttribute('data-' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), String(data[k]));
  });
  return el;
}

function svgText(x, y, text, anchor, cls) {
  const t = svgEl('text', { x, y, 'text-anchor': anchor || 'middle', class: cls || 'chart-text', 'font-size': FONT_SIZE });
  t.textContent = text;
  return t;
}

function svgRoot(g, opts) {
  return svgEl('svg', {
    viewBox: '0 0 ' + g.width + ' ' + g.height, width: '100%', class: 'chart' + (opts.className ? ' ' + opts.className : ''),
    role: 'img', 'aria-label': opts.ariaLabel || '', preserveAspectRatio: 'xMidYMid meet', focusable: 'false',
  }, Object.assign({ chart: opts.chart }, opts.data || {}));
}

// items: [{ value, label (x label text, shown for the first and last bar), data }]
// opts: { chart, ariaLabel, goal, goalLabel, data, className }
export function barChart(items, opts) {
  const o = opts || {};
  const list = items || [];
  const g = barGeometry(list.map((d) => d.value), { goal: o.goal });
  const svg = svgRoot(g, o);
  svg.appendChild(svgEl('line', { x1: g.plot.x0, x2: g.plot.x1, y1: g.plot.y1, y2: g.plot.y1, class: 'chart-axis' }));
  g.bars.forEach((b, i) => {
    const d = list[i];
    svg.appendChild(svgEl('rect', { x: b.x, y: b.y, width: b.width, height: b.height, rx: b.height > 3 ? 3 : 0, class: 'chart-bar' + (d.current ? ' current' : '') }, d.data));
    svg.appendChild(svgText(b.cx, b.labelY, formatNumber(b.value), 'middle', 'chart-value'));
  });
  if (g.goal) {
    svg.appendChild(svgEl('line', { x1: g.goal.x0, x2: g.goal.x1, y1: g.goal.y, y2: g.goal.y, class: 'chart-goal' }));
    svg.appendChild(svgText(g.goal.labelX, g.goal.labelY, o.goalLabel || 'Goal ' + formatNumber(g.goal.value), 'start', 'chart-text'));
  }
  g.xLabels.forEach((l) => svg.appendChild(svgText(l.x, l.y, list[l.index].label || '', l.anchor, 'chart-text')));
  return svg;
}

// items: [{ value, label (x label text, shown for the first and last point), data }]
// opts: { chart, ariaLabel, data, className }
export function lineChart(items, opts) {
  const o = opts || {};
  const list = items || [];
  const g = lineGeometry(list.map((d) => d.value));
  const svg = svgRoot(g, o);
  g.ticks.forEach((t) => {
    svg.appendChild(svgEl('line', { x1: g.plot.x0, x2: g.plot.x1, y1: t.y, y2: t.y, class: 'chart-grid' }));
    svg.appendChild(svgText(g.plot.x0 - 8, t.labelY, formatNumber(t.value), 'end', 'chart-value'));
  });
  if (g.path) svg.appendChild(svgEl('path', { d: g.path, class: 'chart-line' }));
  g.points.forEach((p, i) => svg.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: POINT_RADIUS, class: 'chart-point' }, list[i].data)));
  g.xLabels.forEach((l) => svg.appendChild(svgText(l.x, l.y, list[l.index].label || '', l.anchor, 'chart-text')));
  return svg;
}
