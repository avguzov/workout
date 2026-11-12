// Chart geometry and SVG builders (js/app/charts.js): scale endpoints, bars from zero, a padded
// line range, and the edge cases (one point, all-equal values, empty input) never divide by zero
// or draw outside the viewBox.

import { test, equal, assert, deepEqual } from './harness.js';
import {
  linearScale, paddedRange, barGeometry, lineGeometry, seriesText, barChart, lineChart, CHART_WIDTH, FONT_SIZE, POINT_RADIUS,
} from '../js/app/charts.js';

const finite = (v) => typeof v === 'number' && isFinite(v);

function inside(g, label) {
  const nums = [];
  (g.bars || []).forEach((b) => nums.push(b.x, b.y, b.width, b.height, b.cx, b.labelY));
  (g.points || []).forEach((p) => nums.push(p.x, p.y));
  (g.ticks || []).forEach((t) => nums.push(t.y, t.labelY));
  (g.xLabels || []).forEach((l) => nums.push(l.x, l.y));
  if (g.goal) nums.push(g.goal.y, g.goal.labelX, g.goal.labelY);
  nums.forEach((n) => assert(finite(n), label + ': non-finite ' + n));
  (g.bars || []).forEach((b) => {
    assert(b.x >= 0 && b.x + b.width <= g.width + 0.01, label + ': bar x ' + b.x);
    assert(b.y >= 0 && b.y + b.height <= g.height + 0.01 && b.height >= 0, label + ': bar y ' + b.y + ' h ' + b.height);
    assert(b.labelY - FONT_SIZE >= 0, label + ': value label above the top');
  });
  (g.points || []).forEach((p) => {
    assert(p.x - POINT_RADIUS >= 0 && p.x + POINT_RADIUS <= g.width, label + ': point x ' + p.x);
    assert(p.y - POINT_RADIUS >= 0 && p.y + POINT_RADIUS <= g.height, label + ': point y ' + p.y);
    assert(p.y >= g.plot.y0 && p.y <= g.plot.y1, label + ': point inside the plot');
  });
  (g.xLabels || []).forEach((l) => assert(l.y <= g.height && l.y - FONT_SIZE >= 0 && l.x >= 0 && l.x <= g.width, label + ': x label'));
  if (g.path) assert(!/NaN|Infinity/.test(g.path), label + ': path ' + g.path);
}

test('charts: linearScale maps the domain endpoints to the range endpoints, and a flat domain to the middle', () => {
  const s = linearScale(0, 10, 100, 0);
  equal(s(0), 100);
  equal(s(10), 0);
  equal(s(5), 50);
  const t = linearScale(20, 60, 10, 210);
  equal(t(20), 10);
  equal(t(60), 210);
  const flat = linearScale(5, 5, 0, 100);
  equal(flat(5), 50);
  equal(flat(999), 50);
  equal(linearScale(NaN, 1, 0, 10)(0), 5);
});

test('charts: paddedRange pads min to max, and handles equal values and empty input', () => {
  deepEqual(paddedRange([100, 200]), { min: 100, max: 200, lo: 88, hi: 212 });
  const eq = paddedRange([300, 300, 300]);
  equal(eq.min, 300);
  equal(eq.max, 300);
  assert(eq.lo < 300 && eq.hi > 300, 'equal values get a pad');
  const zero = paddedRange([0]);
  assert(zero.hi - zero.lo > 0, 'zero gets a pad');
  deepEqual(paddedRange([]), { min: 0, max: 0, lo: 0, hi: 1 });
  deepEqual(paddedRange([NaN, 4]), { min: 4, max: 4, lo: 3, hi: 5 });
});

test('charts: bars start at zero, the tallest reaches the top, and the goal line sits at its value', () => {
  const g = barGeometry([0, 1, 3, 2, 0, 0, 4, 2], { goal: 3 });
  equal(g.width, CHART_WIDTH);
  equal(g.bars.length, 8);
  equal(g.max, 4);
  g.bars.forEach((b) => equal(Math.round((b.y + b.height) * 10) / 10, g.plot.y1, 'bar bottoms at the baseline'));
  equal(g.bars[0].height, 0, 'zero bar has no height');
  equal(g.bars[6].y, g.plot.y0, 'tallest bar reaches the top');
  equal(Math.round(g.bars[2].height * 10), Math.round(((g.plot.y1 - g.plot.y0) * 3 / 4) * 10), 'height proportional from zero');
  equal(g.goal.value, 3);
  assert(Math.abs(g.goal.y - g.bars[2].y) < 0.11, 'goal line at the top of a 3 bar');
  assert(g.goal.labelX + 6 * FONT_SIZE * 0.62 <= g.width, 'goal label fits the right gutter');
  for (let i = 1; i < 8; i++) assert(g.bars[i].x > g.bars[i - 1].x + g.bars[i - 1].width, 'bars do not overlap');
  deepEqual(g.xLabels.map((l) => [l.index, l.anchor]), [[0, 'start'], [7, 'end']]);
  inside(g, 'weekly');
  const low = barGeometry([0, 1, 0], { goal: 3 });
  equal(low.max, 3, 'the goal sets the top when every bar is below it');
  inside(low, 'below goal');
});

test('charts: bars with all zeros, one bar, and empty input stay finite and inside', () => {
  const zeros = barGeometry([0, 0, 0, 0, 0, 0, 0, 0], { goal: 3 });
  zeros.bars.forEach((b) => equal(b.height, 0));
  inside(zeros, 'zeros');
  const noGoal = barGeometry([0, 0]);
  equal(noGoal.max, 1, 'no division by zero without a goal');
  inside(noGoal, 'zeros without a goal');
  const one = barGeometry([2], { goal: 3 });
  equal(one.bars.length, 1);
  deepEqual(one.xLabels.map((l) => l.anchor), ['middle']);
  inside(one, 'one bar');
  const empty = barGeometry([], { goal: 3 });
  deepEqual(empty.bars, []);
  deepEqual(empty.xLabels, []);
  inside(empty, 'empty');
  inside(barGeometry(null), 'null');
  inside(barGeometry([NaN, -2, Infinity], { goal: 3 }), 'bad values');
});

test('charts: a line spans the plot, labels min and max, and builds its path', () => {
  const g = lineGeometry([1000, 1200, 900, 1500]);
  equal(g.points.length, 4);
  equal(g.points[0].x, g.plot.x0, 'first point at the left');
  equal(g.points[3].x, g.plot.x1, 'last point at the right');
  const top = g.points[3];
  const bottom = g.points[2];
  assert(top.y > g.plot.y0 && top.y < bottom.y && bottom.y < g.plot.y1, 'max above min, both padded inside');
  deepEqual(g.ticks.map((t) => t.value), [1500, 900]);
  equal(g.ticks[0].y, top.y);
  equal(g.ticks[1].y, bottom.y);
  assert(/^M[\d.]+ [\d.]+( L[\d.]+ [\d.]+){3}$/.test(g.path), 'path ' + g.path);
  deepEqual(g.xLabels.map((l) => [l.index, l.anchor]), [[0, 'start'], [3, 'end']]);
  inside(g, 'line');
});

test('charts: one point, all-equal values, and empty input never divide by zero or leave the viewBox', () => {
  const one = lineGeometry([1240]);
  equal(one.points.length, 1);
  equal(one.points[0].x, (one.plot.x0 + one.plot.x1) / 2, 'single point centred');
  equal(one.path, '', 'no line for one point');
  deepEqual(one.ticks.map((t) => t.value), [1240], 'one label');
  deepEqual(one.xLabels.map((l) => l.anchor), ['middle']);
  inside(one, 'one point');
  const eq = lineGeometry([500, 500, 500]);
  const ys = eq.points.map((p) => p.y);
  assert(ys.every((y) => y === ys[0]), 'flat line');
  equal(eq.ticks.length, 1, 'min equals max: one label');
  inside(eq, 'equal');
  const zeros = lineGeometry([0, 0]);
  inside(zeros, 'zeros');
  const empty = lineGeometry([]);
  deepEqual(empty.points, []);
  deepEqual(empty.ticks, []);
  deepEqual(empty.xLabels, []);
  equal(empty.path, '');
  inside(empty, 'empty');
  inside(lineGeometry(null), 'null');
  inside(lineGeometry([NaN, 3]), 'bad values');
});

test('charts: seriesText uses the Oxford comma', () => {
  equal(seriesText(['1', '2', '3']), '1, 2, and 3');
  equal(seriesText(['a', 'b']), 'a and b');
  equal(seriesText(['a']), 'a');
  equal(seriesText([]), '');
});

test('charts: SVG builders give role img, an aria-label, a viewBox, class-only colors, and readable text', () => {
  const bars = barChart([{ value: 1, label: 'Sep 21', data: { weekStart: 'x', count: 1 } }, { value: 0, label: 'Nov 9', current: true, data: { count: 0 } }],
    { ariaLabel: 'Sessions per week: 1 and 0', goal: 3 });
  const line = lineChart([{ value: 900, label: 'Oct 1', data: { volumeLb: 900 } }, { value: 1200, label: 'Oct 8', data: { volumeLb: 1200 } }], { ariaLabel: 'Push volume' });
  const single = lineChart([{ value: 40, label: 'Oct 1', data: { value: 40 } }], { ariaLabel: 'one' });
  const none = lineChart([], { ariaLabel: 'none' });
  [bars, line, single, none].forEach((svg) => {
    equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
    equal(svg.getAttribute('role'), 'img');
    assert(svg.getAttribute('aria-label'), 'aria-label');
    assert(/^0 0 \d+ \d+$/.test(svg.getAttribute('viewBox')), 'viewBox');
    equal(svg.getAttribute('width'), '100%');
    assert(!/#[0-9a-f]{3,6}\b|rgb\(|style=|fill=|stroke=/i.test(svg.outerHTML), 'colors only through classes');
    assert(!/NaN|Infinity/.test(svg.outerHTML), 'finite attributes');
    svg.querySelectorAll('text').forEach((t) => assert(Number(t.getAttribute('font-size')) * (313 / CHART_WIDTH) >= 11, 'text at least 11 px at 375 px'));
    svg.querySelectorAll('circle').forEach((c) => assert(Number(c.getAttribute('r')) >= 3, 'point radius'));
  });
  equal(bars.querySelectorAll('[data-count]').length, 2);
  equal(bars.querySelectorAll('rect.chart-bar.current').length, 1);
  assert(Array.from(bars.querySelectorAll('text')).some((t) => t.textContent === 'Goal 3'), 'goal label');
  equal(line.querySelectorAll('[data-volume-lb]').length, 2);
  equal(line.querySelectorAll('path.chart-line').length, 1);
  equal(single.querySelectorAll('circle').length, 1);
  equal(single.querySelectorAll('path').length, 0);
  equal(single.querySelectorAll('text').length, 2, 'one value label and one date label');
  equal(none.querySelectorAll('circle, path, text').length, 0);
});
