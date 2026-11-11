// App entry: loads the library and the stored document, then routes by hash
// (#/today, #/workout, #/summary). Every state change is written to IndexedDB right away.

import { openStorage, requestPersistence, DB_NAME } from './storage.js';
import { createSession, isStale, isStarted } from './flow.js';
import { h, append } from './dom.js';
import * as today from './screens/today.js';
import * as workout from './screens/workout.js';
import * as summary from './screens/summary.js';

const ROUTES = { today, workout, summary };

function newSeed() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0];
}

async function loadLibrary() {
  const res = await fetch(new URL('../../data/library.json', import.meta.url));
  if (!res.ok) throw new Error('Could not load the movement library (' + res.status + ').');
  return res.json();
}

// ---------------------------------------------------------------- wake lock

const wake = { want: false, lock: null, pending: false };

async function acquireWakeLock() {
  if (!wake.want || wake.lock || wake.pending || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  wake.pending = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (!wake.want) { lock.release().catch(() => {}); return; }
    wake.lock = lock;
    lock.addEventListener('release', () => { if (wake.lock === lock) wake.lock = null; });
  } catch (e) {
    // denied or unsupported here; the workout still runs
  } finally {
    wake.pending = false;
  }
}

function setWakeLock(on) {
  wake.want = on;
  if (on) acquireWakeLock();
  else if (wake.lock) {
    const l = wake.lock;
    wake.lock = null;
    l.release().catch(() => {});
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') acquireWakeLock();
});

// ---------------------------------------------------------------- app

function fatal(root, err) {
  root.textContent = '';
  append(root, [h('main', { class: 'content', data: { screen: 'error' } },
    h('div', { class: 'screen' },
      h('h1', null, 'Something went wrong'),
      h('p', { class: 'note warn' }, String((err && err.message) || err))))]);
}

async function boot() {
  const root = document.getElementById('app');
  const html = document.documentElement;
  let storage;
  let library;
  let doc;
  try {
    library = await loadLibrary();
    storage = await openStorage(DB_NAME, {
      onPending(n) { html.dataset.pendingWrites = String(n); },
      onError(e) { html.dataset.saveError = String((e && e.message) || e); },
    });
    doc = await storage.load(library);
  } catch (e) {
    fatal(root, e);
    return;
  }
  html.dataset.pendingWrites = '0';
  requestPersistence();

  const byId = new Map(library.movements.map((m) => [m.id, m]));
  let active = null;

  const ctx = {
    library,
    get doc() { return doc; },
    ui: { flash: null, confirm: null, genError: null },
    now: () => new Date().toISOString(),
    movement: (id) => byId.get(id) || null,
    commit(fn, opts) {
      fn(doc);
      storage.save(doc);
      if (!opts || opts.render !== false) render();
    },
    go(name) {
      const target = '#/' + name;
      if (location.hash === target) render();
      else location.hash = target;
    },
    render: () => render(),
  };

  function ensureCurrent() {
    if (ctx.ui.genError) return;
    if (doc.current && !isStale(library, doc)) return;
    try {
      const r = createSession({ library, doc, seed: newSeed(), now: ctx.now() });
      if (r.violations.length) {
        ctx.ui.genError = { message: 'The generated session broke the session rules.', violations: r.violations };
        return;
      }
      doc.current = r.session;
      storage.save(doc);
    } catch (e) {
      ctx.ui.genError = { message: String((e && e.message) || e), violations: [] };
    }
  }

  function resolve() {
    let name = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
    if (!ROUTES[name]) name = 'today';
    if (name === 'workout' && !(doc.current && isStarted(doc.current) && doc.current.progress)) name = 'today';
    if (name === 'summary' && !doc.sessions.length) name = 'today';
    if (location.hash !== '#/' + name) history.replaceState(null, '', '#/' + name);
    if (name === 'today') ensureCurrent();
    return name;
  }

  // Scroll to the top whenever the screen, phase, block, or round changes.
  let lastView = '';
  function viewKey(name) {
    const p = name === 'workout' && doc.current ? doc.current.progress : null;
    return name + (p ? '|' + p.phase + '|' + p.block + '|' + p.round : '');
  }

  function render() {
    const name = resolve();
    if (active && active.unmount) active.unmount();
    if (name !== 'workout') ctx.ui.confirm = null;
    const screen = ROUTES[name];
    active = screen;
    const view = screen.render(ctx);
    const main = h('main', { class: 'content', id: 'main' }, view.main);
    const bar = h('footer', { class: 'bar', id: 'bar' }, view.bar);
    root.textContent = '';
    root.appendChild(main);
    root.appendChild(bar);
    html.dataset.screen = name;
    const key = viewKey(name);
    if (key !== lastView) window.scrollTo(0, 0);
    lastView = key;
    setWakeLock(name === 'workout');
    if (screen.mounted) screen.mounted(ctx, root);
  }

  window.addEventListener('hashchange', () => render());

  root.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-action]');
    if (!el || el.disabled || !active) return;
    const handler = active.actions && active.actions[el.dataset.action];
    if (!handler) return;
    ev.preventDefault();
    ctx.ui.flash = null;
    handler(ctx, el.dataset, el);
  });

  root.addEventListener('input', (ev) => {
    const el = ev.target.closest('[data-field]');
    if (!el || !active || !active.inputs) return;
    const handler = active.inputs[el.dataset.field];
    if (handler) handler(ctx, el.value);
  });

  render();
  html.dataset.ready = '1';
}

boot();
