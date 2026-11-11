// Tiny test harness: test, assert, equal, deepEqual, setReport, run, report.

const tests = [];
const results = [];
const reports = {};

export function test(name, fn) {
  tests.push({ name, fn });
}

function fmt(v) {
  try {
    const s = JSON.stringify(v);
    return s && s.length > 160 ? s.slice(0, 157) + '...' : s;
  } catch (e) {
    return String(v);
  }
}

export function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}

export function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error((message ? message + ': ' : '') + 'expected ' + fmt(expected) + ', got ' + fmt(actual));
  }
}

// First difference between two values, or '' when they are deep-equal (key order ignored).
export function diff(a, b, path) {
  const p = path || '$';
  if (a === b) return '';
  if (typeof a === 'number' && typeof b === 'number' && isNaN(a) && isNaN(b)) return '';
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return p + ': ' + fmt(a) + ' != ' + fmt(b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return p + ': array vs object';
  if (Array.isArray(a)) {
    if (a.length !== b.length) return p + ': length ' + a.length + ' != ' + b.length;
    for (let i = 0; i < a.length; i++) {
      const d = diff(a[i], b[i], p + '[' + i + ']');
      if (d) return d;
    }
    return '';
  }
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.join(',') !== kb.join(',')) return p + ': keys [' + ka.join(',') + '] != [' + kb.join(',') + ']';
  for (const k of ka) {
    const d = diff(a[k], b[k], p + '.' + k);
    if (d) return d;
  }
  return '';
}

export function deepEqual(actual, expected, message) {
  const d = diff(actual, expected);
  if (d) throw new Error((message ? message + ': ' : '') + 'not deep-equal at ' + d);
}

export function setReport(key, value) {
  reports[key] = value;
}

export async function run(onResult) {
  for (const t of tests) {
    let r;
    try {
      await t.fn();
      r = { name: t.name, ok: true, message: '' };
    } catch (e) {
      r = { name: t.name, ok: false, message: String((e && e.message) || e) };
    }
    results.push(r);
    if (onResult) onResult(r);
    // yield so the page can paint between tests
    await new Promise((res) => setTimeout(res, 0));
  }
  return report();
}

export function report() {
  const passed = results.filter((r) => r.ok).length;
  return { passed, failed: results.length - passed, results: results.slice(), reports };
}
