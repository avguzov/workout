// End-to-end driver. Runs the real app (../index.html) in a 390 x 844 iframe and drives it only
// through its DOM (data-action, data-movement-id, data-round hooks). IndexedDB is read directly
// to check what the app stored; the engine is imported only to compute reference values.
//
// Phase 1 (fresh profile): first session, full logging with edits, summary volume, reload,
// sessions until Today shows last-time numbers, mid-workout reload, and at 375 px: button labels
// on one line, the effort screen without scrolling (375 x 812), and the load wording.
// Phase 2 (second Edge process on the same profile): every session and the workout in
// progress survived the browser restart, Resume lands on the same block and round, End early
// asks first, Undo restores the prior state (after a confirm, from rest, and from effort), and
// Discard asks first.
// Named phases (?phase=swap|settings|history), each on its own fresh profile: see swapPhase,
// settingsPhase, and historyPhase.

import { validateSession, sessionVolume, nextDayType } from '../js/engine/index.js';
import { DB_NAME, STORE, DOC_KEY } from '../js/app/storage.js';

const PHASE = Number(new URLSearchParams(location.search).get('phase') || 1);
const MAX_SESSIONS = 15;
const EFFORTS = ['two_plus_left', 'hard_clean', 'barely'];
const results = [];
const info = {};
const appErrors = [];
const frame = document.getElementById('app');
const logEl = document.getElementById('log');

function log(msg) {
  logEl.textContent += msg + '\n';
  fetch('/__log', { method: 'POST', body: String(msg) }).catch(() => {});
}

function check(name, ok, message) {
  results.push({ name, ok: !!ok, message: ok ? '' : String(message || 'failed') });
  log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' -- ' + message));
  return !!ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = () => frame.contentWindow;
const D = () => frame.contentDocument;
const q = (sel) => D().querySelector(sel);
const qa = (sel) => Array.from(D().querySelectorAll(sel));
const J = (v) => JSON.stringify(v);

async function waitFor(fn, label, timeout) {
  const limit = timeout || 10000;
  const start = performance.now();
  for (;;) {
    let v = null;
    try { v = fn(); } catch (e) { v = null; }
    if (v) return v;
    if (performance.now() - start > limit) throw new Error('timed out waiting for ' + label + ' (view ' + viewKey() + ')');
    await sleep(10);
  }
}

function root() {
  const d = D();
  return d ? d.querySelector('#main [data-screen]') : null;
}

function screenName() {
  const r = root();
  return r ? r.dataset.screen : null;
}

function viewKey() {
  const r = root();
  if (!r) return '';
  const d = r.dataset;
  return [d.screen, d.phase, d.blockIndex, d.round, d.item, d.sessionId].join('|');
}

async function appReady() {
  await waitFor(() => {
    const w = W();
    const d = D();
    return w && !w.__e2eOld && d && d.documentElement.dataset.ready === '1' && root();
  }, 'app ready', 30000);
  const w = W();
  if (!w.__e2eHooked) {
    w.__e2eHooked = true;
    w.addEventListener('error', (e) => appErrors.push(String(e.message || e)));
    w.addEventListener('unhandledrejection', (e) => appErrors.push('rejection: ' + String(e.reason && (e.reason.stack || e.reason))));
  }
}

async function loadApp() {
  frame.src = '../index.html';
  await appReady();
}

async function idle() {
  await waitFor(() => D().documentElement.dataset.pendingWrites === '0', 'writes to finish');
}

async function reloadApp() {
  await idle();
  W().__e2eOld = true;
  W().location.reload();
  await appReady();
}

async function tap(sel, until, label) {
  const el = await waitFor(() => {
    const e = q(sel);
    return e && !e.disabled ? e : null;
  }, 'tappable ' + sel);
  el.click();
  if (until) await waitFor(until, label || 'result of ' + sel);
}

function readDoc() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME);
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) { db.close(); resolve(null); return; }
      const g = db.transaction(STORE, 'readonly').objectStore(STORE).get(DOC_KEY);
      g.onsuccess = () => { db.close(); resolve(g.result || null); };
      g.onerror = () => { db.close(); reject(g.error); };
    };
    r.onerror = () => reject(r.error);
  });
}

// ---------------------------------------------------------------- layout checks

const layout = { screens: [], overflow: [], small: [] };

async function frames(n) {
  for (let i = 0; i < n; i++) await new Promise((r) => W().requestAnimationFrame(() => r()));
}

async function checkLayout(label) {
  frame.style.width = '375px';
  void frame.offsetWidth;
  await frames(2);
  const de = D().documentElement;
  const vw = de.clientWidth;
  let worst = de.scrollWidth - vw;
  qa('#app *').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right - vw > worst) worst = r.right - vw;
  });
  if (worst > 0.5) layout.overflow.push(label + ' +' + Math.round(worst) + 'px');
  buttonWrapScan(label);
  frame.style.width = '390px';
  void frame.offsetWidth;
  await frames(2);
  qa('#app [data-action]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && (r.height < 47.5 || r.width < 47.5)) {
      layout.small.push(label + ' ' + el.dataset.action + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    }
  });
  qa('#app textarea, #app input, #app select').forEach((el) => {
    const fs = parseFloat(W().getComputedStyle(el).fontSize);
    if (fs < 16) layout.small.push(label + ' input font ' + fs + 'px');
  });
  layout.screens.push(label);
}

// Every visible button label sits on one line and fits inside its button, at the current width.
// Lines are counted from the client rects of the label text, so "Shuffl / e" counts as two.
const wrap = { screens: [], buttons: 0, problems: [] };

function buttonWrapScan(label) {
  wrap.screens.push(label);
  qa('#app button').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0)) return;
    wrap.buttons += 1;
    const range = D().createRange();
    range.selectNodeContents(el);
    const tops = Array.from(range.getClientRects()).filter((x) => x.width > 0 && x.height > 0)
      .map((x) => x.top).sort((a, b) => a - b);
    let lines = 0;
    let prev = -Infinity;
    tops.forEach((t) => { if (t - prev > 4) { lines += 1; prev = t; } });
    const cs = W().getComputedStyle(el);
    const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const over = Math.max(el.scrollWidth - el.clientWidth, range.getBoundingClientRect().width - room);
    if (lines > 1 || over > 0.5) {
      wrap.problems.push(label + ' "' + el.textContent + '" ' + (lines > 1 ? lines + ' lines' : 'overflows by ' + Math.round(over) + 'px'));
    }
  });
}

async function atSize(width, height, fn) {
  frame.style.width = width + 'px';
  frame.style.height = height + 'px';
  void frame.offsetWidth;
  await frames(2);
  try {
    return await fn();
  } finally {
    frame.style.width = '390px';
    frame.style.height = '844px';
    void frame.offsetWidth;
    await frames(2);
  }
}

async function checkWrap(label) {
  await atSize(375, 844, () => buttonWrapScan(label));
}

// Effort screen for a three-movement block at 375 x 812: all nine options sit above the fixed
// bar and the continue button is in view, with the page at the top (no scrolling).
const effortFit = { screens: 0, problems: [], lowest: 0, barTop: 0 };

async function checkEffortFit() {
  await atSize(375, 812, () => {
    W().scrollTo(0, 0);
    const cards = qa('#main .effort-card[data-item]');
    if (cards.length !== 3) return;
    effortFit.screens += 1;
    const vh = D().documentElement.clientHeight;
    const barTop = q('#bar').getBoundingClientRect().top;
    const opts = qa('#main [data-action="effort"]');
    const go = q('#bar [data-action="effort-done"]');
    const bad = [];
    if (opts.length !== 9) bad.push(opts.length + ' options');
    opts.forEach((el) => {
      const r = el.getBoundingClientRect();
      effortFit.lowest = Math.max(effortFit.lowest, r.bottom);
      if (r.top < 0 || r.bottom > barTop + 0.5) bad.push(el.dataset.item + ':' + el.dataset.effort + ' at ' + Math.round(r.top) + '-' + Math.round(r.bottom));
      if (r.height < 47.5) bad.push(el.dataset.effort + ' ' + Math.round(r.height) + ' px tall');
    });
    const g = go ? go.getBoundingClientRect() : null;
    if (!g || g.top < 0 || g.bottom > vh + 0.5 || g.height < 47.5) bad.push('continue button ' + J(g && [g.top, g.bottom]));
    if (W().scrollY !== 0) bad.push('page scrolled ' + W().scrollY);
    effortFit.barTop = barTop;
    if (bad.length) effortFit.problems.push('Block ' + root().dataset.block + ' (bar at ' + Math.round(barTop) + '): ' + bad.slice(0, 3).join(', '));
  });
}

// ---------------------------------------------------------------- copy checks

// One load formatter everywhere: "8 reps per side, 2 x 45 lb adjustable", "10 reps, bodyweight".
const PLAN_RE = /^\d+(\.\d)? (reps?|sec)( per side)?, (bodyweight|[12] x \d+(\.\d)? lb( adjustable)?)$/;
const CONFIRM_RE = /^Confirm \d+(\.\d)? (reps?|sec), (bodyweight|[12] x \d+(\.\d)? lb)$/;
const wording = { lines: 0, problems: [] };

function word(label, text, ok) {
  wording.lines += 1;
  if (!ok) wording.problems.push(label + ' "' + text + '"');
}

// Today: every movement line matches, and its count and weight equal the stored item's load.
async function checkTodayWording() {
  await idle();
  const doc = await readDoc();
  const items = new Map();
  doc.current.blocks.forEach((b) => b.items.forEach((it) => items.set(b.block + ':' + it.slot, it)));
  qa('#main li.item[data-movement-id]').forEach((el) => {
    const text = el.querySelector('.target').textContent;
    const it = items.get(el.dataset.block + ':' + el.dataset.slot);
    const l = it.load;
    const want = l.source === 'bodyweight' || l.weight_lb_per_dumbbell == null ? ', bodyweight'
      : ', ' + Math.max(1, l.dumbbells) + ' x ' + l.weight_lb_per_dumbbell + ' lb' + (l.source === 'adjustable' ? ' adjustable' : '');
    word('today ' + el.dataset.movementId, text, PLAN_RE.test(text) && text.endsWith(want));
  });
  const fin = q('#main .card.finisher h2');
  if (fin) word('today finisher title', fin.textContent, /^Finisher: \S/.test(fin.textContent));
}

// Workout: Target line, movement list, Confirm label, and chips ("10 @ 30", "12", "60 sec").
function checkWorkoutWording(phase) {
  if (phase === 'round') {
    const t = q('#main .target-line').textContent;
    word('target', t, /^Target /.test(t) && PLAN_RE.test(t.replace(/^Target /, '').replace(/, edited$/, '')));
    const c = q('#bar [data-action="confirm"]');
    word('confirm', c.textContent, CONFIRM_RE.test(c.textContent));
  }
  qa('#main .circuit-name .meta').forEach((el) => word('list', el.textContent, PLAN_RE.test(el.textContent)));
  qa('#main [data-logged-round]').forEach((el) => {
    const want = el.dataset.value + (el.dataset.weight === '' ? '' : ' @ ' + el.dataset.weight);
    word('chip', el.textContent, el.textContent.replace(' sec', '') === want && !/ x /.test(el.textContent));
  });
  if (phase === 'finisher') {
    const fin = q('#main .card.finisher h2');
    word('workout finisher title', fin && fin.textContent, fin && !/^Finisher/.test(fin.textContent) && fin.textContent.length > 0);
  }
}

// ---------------------------------------------------------------- Today helpers

function todayInfo() {
  const r = root();
  return {
    id: r.dataset.sessionId,
    dayType: r.dataset.dayType,
    movements: qa('#main li.item[data-movement-id]').map((el) => el.dataset.movementId),
  };
}

function activeIds(session) {
  const out = [];
  session.blocks.forEach((b) => { if (b.rounds > 0 && !b.removed) b.items.forEach((it) => out.push(it.movement_id)); });
  return out;
}

// ---------------------------------------------------------------- logging a session

let effortCounter = 0;

async function logFullSession(opts) {
  const rec = { id: root().dataset.sessionId, items: {}, edits: [], finisher: 'none' };
  await tap('[data-action="start"]', () => screenName() === 'workout' && root().dataset.phase === 'warmup', 'warm-up');
  if (opts.layout) await checkLayout('workout warm-up');
  await tap('[data-action="warmup-done"]', () => root().dataset.phase === 'round');
  let repsEdited = !opts.edit;
  let weightEdited = !opts.edit;
  const seen = new Set();
  for (let guard = 0; guard < 500; guard++) {
    const r = root();
    if (r.dataset.screen === 'summary') break;
    const phase = r.dataset.phase;
    if (opts.layout && !seen.has(phase)) {
      seen.add(phase);
      await checkLayout('workout ' + phase);
    } else {
      await checkWrap('workout ' + phase);
    }
    checkWorkoutWording(phase);
    if (phase === 'effort') await checkEffortFit();
    const key = viewKey();
    if (phase === 'round') {
      let card = q('[data-active-item]');
      const mid = card.dataset.movementId;
      const pre = { value: card.dataset.value, weight: card.dataset.weight };
      if (!repsEdited && card.dataset.unit === 'reps' && Number(pre.value) > 1) {
        await tap('[data-action="value-down"]', () => q('[data-active-item]').dataset.value !== pre.value);
        repsEdited = true;
        rec.edits.push({ kind: 'reps', movement_id: mid, round: Number(r.dataset.round), from: Number(pre.value), to: Number(q('[data-active-item]').dataset.value) });
      } else if (!weightEdited && pre.weight !== '') {
        const dir = q('[data-action="weight-down"]:not([disabled])') ? 'weight-down' : 'weight-up';
        await tap('[data-action="' + dir + '"]', () => q('[data-active-item]').dataset.weight !== pre.weight);
        weightEdited = true;
        rec.edits.push({ kind: 'weight', movement_id: mid, round: Number(r.dataset.round), from: Number(pre.weight), to: Number(q('[data-active-item]').dataset.weight) });
      }
      card = q('[data-active-item]');
      const entry = { value: Number(card.dataset.value), weight: card.dataset.weight === '' ? null : Number(card.dataset.weight) };
      if (!rec.items[mid]) rec.items[mid] = { rounds: [], effort: null };
      rec.items[mid].rounds.push(entry);
      await tap('[data-action="confirm"]', () => viewKey() !== key);
    } else if (phase === 'rest') {
      await tap('[data-action="rest-skip"]', () => viewKey() !== key);
    } else if (phase === 'effort') {
      const cards = qa('#main .effort-card[data-item]');
      for (const c of cards) {
        const i = c.dataset.item;
        const mid = c.dataset.movementId;
        const e = EFFORTS[effortCounter % EFFORTS.length];
        effortCounter += 1;
        await tap('[data-action="effort"][data-item="' + i + '"][data-effort="' + e + '"]',
          () => q('#main .effort-card[data-item="' + i + '"]').dataset.effort === e);
        rec.items[mid].effort = e;
      }
      await tap('[data-action="effort-done"]', () => viewKey() !== key);
    } else if (phase === 'finisher') {
      rec.finisher = opts.finisherDone ? 'done' : 'skipped';
      await tap(opts.finisherDone ? '[data-action="finisher-done"]' : '[data-action="finisher-skip"]',
        () => screenName() === 'summary');
    } else {
      throw new Error('unexpected phase ' + phase);
    }
  }
  await waitFor(() => screenName() === 'summary', 'summary');
  if (opts.layout) await checkLayout('summary');
  else await checkWrap('summary');
  await idle();
  return rec;
}

// Compare the summary screen and the stored session with what the script logged.
async function verifyCompleted(rec) {
  const problems = [];
  const r = root();
  const doc = await readDoc();
  const stored = doc.sessions[doc.sessions.length - 1];
  rec.completed_at = stored.completed_at;
  rec.day_type = stored.day_type;
  if (stored.id !== rec.id) problems.push('stored id ' + stored.id + ' != started ' + rec.id);
  if (r.dataset.sessionId !== stored.id) problems.push('summary shows ' + r.dataset.sessionId);
  const vol = sessionVolume(stored);
  if (Number(r.dataset.volumeLb) !== vol.volume_lb) problems.push('summary volume ' + r.dataset.volumeLb + ' != sessionVolume ' + vol.volume_lb);
  if (Number(r.dataset.bodyweightReps) !== vol.bodyweight_reps) problems.push('bodyweight reps ' + r.dataset.bodyweightReps + ' != ' + vol.bodyweight_reps);
  if (Number(r.dataset.timedSec) !== vol.timed_sec) problems.push('timed sec ' + r.dataset.timedSec + ' != ' + vol.timed_sec);
  vol.blocks.filter((b) => b.rounds > 0).forEach((b) => {
    const el = q('#main [data-block-volume][data-block="' + b.block + '"]');
    if (!el || Number(el.dataset.blockVolume) !== b.volume_lb) problems.push('block ' + b.block + ' volume ' + (el && el.dataset.blockVolume) + ' != ' + b.volume_lb);
  });
  if (r.dataset.finisher !== rec.finisher) problems.push('finisher ' + r.dataset.finisher + ' != ' + rec.finisher);
  stored.blocks.forEach((b) => {
    if (!(b.rounds > 0) || b.removed) return;
    b.items.forEach((it) => {
      const mine = rec.items[it.movement_id];
      const got = it.logged ? it.logged.rounds.map((x) => ({ value: x.value, weight: x.weight_lb_per_dumbbell })) : null;
      if (!mine) { problems.push(it.movement_id + ' was never shown for logging'); return; }
      if (J(got) !== J(mine.rounds)) problems.push(it.movement_id + ' stored ' + J(got) + ' != logged ' + J(mine.rounds));
      if (!it.logged || it.logged.effort !== mine.effort) problems.push(it.movement_id + ' effort ' + (it.logged && it.logged.effort) + ' != ' + mine.effort);
      if (got && got.length !== b.rounds) problems.push(it.movement_id + ' has ' + got.length + ' of ' + b.rounds + ' rounds');
    });
  });
  return { problems, stored, vol, doc };
}

function expectedLast(ledger, mid) {
  for (let i = ledger.length - 1; i >= 0; i--) {
    const it = ledger[i].items[mid];
    if (it && it.rounds.length) {
      const lastRound = it.rounds[it.rounds.length - 1];
      return {
        date: ledger[i].completed_at,
        weight: lastRound.weight == null ? '' : String(lastRound.weight),
        values: it.rounds.map((x) => x.value).join(','),
        effort: it.effort || '',
      };
    }
  }
  return null;
}

function lastTimeRows(ledger) {
  const els = qa('#main li.item[data-movement-id][data-last-values]');
  return els.map((el) => {
    const mid = el.dataset.movementId;
    const want = expectedLast(ledger, mid);
    const got = { date: el.dataset.lastDate, weight: el.dataset.lastWeight, values: el.dataset.lastValues, effort: el.dataset.lastEffort };
    const text = (el.querySelector('[data-last]') || {}).textContent || '';
    const textOk = !!want && text.indexOf(want.values.split(',').join(', ')) >= 0 &&
      (want.weight === '' || text.indexOf(want.weight + ' lb') >= 0);
    return { mid, ok: !!want && J(got) === J(want) && textOk, got, want, text };
  });
}

function loggedOf(session) {
  const out = {};
  session.blocks.forEach((b) => b.items.forEach((it) => {
    if (it.logged && it.logged.rounds.length) out[it.movement_id] = it.logged.rounds;
  }));
  return out;
}

function chipsOnScreen() {
  return qa('#main [data-logged-round]').map((el) => {
    const owner = el.closest('[data-movement-id]');
    return [owner ? owner.dataset.movementId : '?', el.dataset.loggedRound, el.dataset.value, el.dataset.weight].join(':');
  }).sort();
}

function position() {
  const d = root().dataset;
  return { screen: d.screen, phase: d.phase, block: d.block, blockIndex: d.blockIndex, round: d.round, item: d.item };
}

// What the Workout screen shows: position, the active entry, the chips, and the Confirm label.
function screenState() {
  const card = q('[data-active-item]');
  const c = q('#bar [data-action="confirm"]');
  return {
    pos: position(),
    entry: card ? { value: card.dataset.value, weight: card.dataset.weight } : null,
    chips: chipsOnScreen(),
    confirm: c ? c.textContent : null,
  };
}

// What the stored workout holds: every item's logged rounds and effort, the position (with the
// rest end time), and the entry the round would confirm (draft, else prefill).
function storedState(doc) {
  const c = doc.current;
  const p = c.progress;
  let entry = null;
  if (p && p.phase === 'round') {
    const it = c.blocks[p.block].items[p.item];
    entry = p.draft ? { value: p.draft.value, weight: p.draft.weight }
      : { value: it.target.value, weight: it.load ? it.load.weight_lb_per_dumbbell : null };
  }
  return {
    id: c.id,
    logged: c.blocks.map((b) => b.items.map((it) => it.logged || null)),
    progress: p ? [p.phase, p.block, p.round, p.item, p.rest_ends_at].join(':') : null,
    entry,
  };
}

// Snapshot, run `act` (a confirm that leaves the round), tap Undo, and compare the screen and the
// stored document with the snapshot, then again after a reload.
async function undoCase(act, expectPhase) {
  await idle();
  const beforeDom = screenState();
  const beforeDoc = storedState(await readDoc());
  await act();
  const problems = [];
  const phaseAfter = root().dataset.phase;
  if (phaseAfter !== expectPhase) problems.push('confirm went to ' + phaseAfter + ', expected ' + expectPhase);
  const btn = q('#main [data-action="undo"]');
  const g = btn ? btn.getBoundingClientRect() : null;
  const vw = D().documentElement.clientWidth;
  if (!g || g.height < 47.5 || g.top + W().scrollY > 100 || vw - g.right > 40) problems.push('Undo not at the top right: ' + J(g && [g.left, g.top, g.right, g.bottom]));
  await tap('#main [data-action="undo"]', () => J(position()) === J(beforeDom.pos), 'undo back to ' + J(beforeDom.pos));
  await idle();
  const afterDom = screenState();
  const afterDoc = storedState(await readDoc());
  if (J(afterDom) !== J(beforeDom)) problems.push('screen ' + J(afterDom) + ' != ' + J(beforeDom));
  if (J(afterDoc) !== J(beforeDoc)) problems.push('stored ' + J(afterDoc.progress) + ' ' + J(afterDoc.entry) + ' != ' + J(beforeDoc.progress) + ' ' + J(beforeDoc.entry));
  await reloadApp();
  const reloadDom = screenState();
  const reloadDoc = storedState(await readDoc());
  if (J(reloadDom) !== J(beforeDom)) problems.push('after reload ' + J(reloadDom));
  if (J(reloadDoc) !== J(beforeDoc)) problems.push('stored after reload differs');
  return { problems, at: beforeDom.pos, confirm: beforeDom.confirm };
}

async function confirmAndWait() {
  const k = viewKey();
  await tap('#bar [data-action="confirm"]', () => viewKey() !== k);
}

function slotIds(session) {
  return session.blocks.map((b) => b.items.map((it) => it.movement_id));
}

function validFor(library, doc) {
  return validateSession({ library, equipment: doc.equipment, sessions: doc.sessions, session: doc.current });
}

// Length picker keeps the movements; each shuffle scope gives a validated session and only
// changes the slots in scope. Returns an info line.
async function todayControls(library) {
  const problems = [];
  const notes = [];
  let doc = await readDoc();
  const base = slotIds(doc.current);
  for (const len of [30, 60, 50]) {
    await tap('[data-action="length"][data-length="' + len + '"]',
      () => root().dataset.lengthMin === String(len) || q('[data-flash]'), 'length ' + len);
    await idle();
    doc = await readDoc();
    if (q('[data-flash]')) problems.push('length ' + len + ': ' + q('[data-flash]').textContent);
    if (doc.current.length_min !== len) problems.push('stored length ' + doc.current.length_min + ' != ' + len);
    if (J(slotIds(doc.current)) !== J(base)) problems.push('movements changed at ' + len + ' min');
    if (J(todayInfo().movements) !== J(activeIds(doc.current))) problems.push('Today does not match stored at ' + len + ' min');
    const v = validFor(library, doc);
    if (v.length) problems.push('length ' + len + ' violations ' + J(v));
    notes.push(len + ' min: ' + doc.current.blocks.map((b) => b.block + b.rounds).join(' ') + ', est ' + Math.round(doc.current.estimate_sec / 60) + ' min');
  }
  const scopes = [
    ['[data-action="reroll-slot"][data-block="A"][data-slot="0"]', 'slot A0', (bi, si) => bi === 0 && si === 0],
    ['[data-action="reroll-block"][data-block="B"]', 'block B', (bi) => bi === 1],
    ['[data-action="reroll-session"]', 'session', () => true],
  ];
  for (const [sel, label, inScope] of scopes) {
    const before = slotIds(doc.current);
    const count = Number(root().dataset.rerolls);
    await tap(sel, () => Number(root().dataset.rerolls) === count + 1 || q('[data-flash]'), 'shuffle ' + label);
    await idle();
    doc = await readDoc();
    if (q('[data-flash]')) { problems.push(label + ': ' + q('[data-flash]').textContent); continue; }
    const after = slotIds(doc.current);
    const v = validFor(library, doc);
    if (v.length) problems.push(label + ' violations ' + J(v));
    let changed = 0;
    before.forEach((row, bi) => row.forEach((id, si) => {
      if (after[bi][si] !== id) {
        if (inScope(bi, si)) changed += 1;
        else problems.push(label + ' changed out-of-scope slot ' + bi + ':' + si);
      }
    }));
    if (J(todayInfo().movements) !== J(activeIds(doc.current))) problems.push(label + ': Today does not match stored');
    notes.push('shuffle ' + label + ' changed ' + changed);
    await checkWrap('today after shuffle ' + label);
    await checkTodayWording();
  }
  check('Today controls: length picker keeps the movements; shuffle slot, block, and session each give a validated session',
    problems.length === 0, problems.slice(0, 4).join('; '));
  return notes.join('; ');
}

// ---------------------------------------------------------------- phases

// Demo sheet on the Workout screen: opens from the active card and from a circuit row, matches the
// library entry, closes without touching position, draft, or the rest timer, and fits at 375 px.
async function demoSheetChecks(library) {
  const byId = (id) => library.movements.find((m) => m.id === id);
  const snap = async () => {
    await idle();
    const d = await readDoc();
    return { pos: J(position()), progress: J(d.current.progress), entry: J(q('[data-active-item]') ? q('[data-active-item]').dataset : null) };
  };
  const openSheet = () => q('[data-demo-sheet]');

  // Round phase: from the active card
  const before = await snap();
  const activeId = q('[data-active-item]').dataset.movementId;
  const lib = byId(activeId);
  await tap('.active-card [data-action="demo"]', () => !!openSheet(), 'demo sheet open');
  const sheet = openSheet();
  const cues = qa('[data-demo-cue]');
  const video = q('[data-demo-video]');
  const cueOk = cues.length === (lib.cues || []).length && cues.every((c, i) => c.textContent === lib.cues[i]);
  const videoOk = lib.video_url ? !!video && video.getAttribute('href') === lib.video_url && video.target === '_blank' &&
    video.rel === 'noopener' && video.textContent === 'Watch video' : !video;
  check('demo sheet (round): opens from the active card with the library cues and video link, as a labelled modal dialog',
    sheet.dataset.movementId === activeId && cueOk && videoOk && sheet.getAttribute('role') === 'dialog' &&
      sheet.getAttribute('aria-modal') === 'true' && sheet.getAttribute('aria-label').indexOf(lib.name) >= 0,
    'cues ' + cues.length + '/' + (lib.cues || []).length + ', video ' + (video && video.getAttribute('href')) + ', want ' + lib.video_url);
  const text = sheet.textContent;
  check('demo sheet: visible text has no em dash, exclamation point, or emoji',
    !/[—!]/.test(text) && !/[\u{1F000}-\u{1FFFF}☀-➿]/u.test(text), text.slice(0, 80));
  await tap('[data-demo-sheet] [data-action="demo-close"].btn', () => !openSheet(), 'demo sheet closed');
  const after = await snap();
  check('demo sheet (round): closing leaves phase, round, item, draft, and stored progress as they were',
    J(after) === J(before), J(before) + ' vs ' + J(after));

  // Backdrop closes it too
  await tap('.active-card [data-action="demo"]', () => !!openSheet());
  await tap('.demo-backdrop', () => !openSheet(), 'backdrop closes');

  // From a circuit row for a different movement
  const row = qa('.circuit-item').find((li) => li.dataset.movementId !== activeId);
  const other = byId(row.dataset.movementId);
  await tap('.circuit-item[data-item="' + row.dataset.item + '"] [data-action="demo"]', () => !!openSheet(), 'row sheet open');
  const s2 = openSheet();
  check('demo sheet (circuit row): opens for that row\'s movement, with its name and cue count',
    s2.dataset.movementId === other.id && s2.querySelector('.demo-title').textContent === other.name &&
      qa('[data-demo-cue]').length === (other.cues || []).length,
    s2.dataset.movementId + ' vs ' + other.id);

  // Fit at 375 px
  const fit = await atSize(375, 844, async () => {
    const de = D().documentElement;
    const vw = de.clientWidth;
    const panel = q('.demo-panel');
    const pr = panel.getBoundingClientRect();
    let worst = de.scrollWidth - vw;
    qa('[data-demo-sheet] *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right - vw > worst) worst = r.right - vw;
    });
    const small = qa('[data-demo-sheet] .btn').filter((el) => el.getBoundingClientRect().height < 44).length;
    const wrapBefore = wrap.problems.length;
    buttonWrapScan('demo sheet');
    const wrapped = wrap.problems.length - wrapBefore;
    wrap.problems.length = wrapBefore;
    return { worst, bottom: pr.bottom, vh: W().innerHeight, height: pr.height, small, wrapped };
  });
  check('demo sheet: no horizontal overflow at 375 px, bottom edge inside the viewport, at most 80% tall, tap targets 44 px, no label wraps',
    fit.worst <= 0.5 && fit.bottom <= fit.vh + 0.5 && fit.height <= fit.vh * 0.8 + 1 && fit.small === 0 && fit.wrapped === 0,
    J(fit));
  await tap('[data-demo-sheet] [data-action="demo-close"].btn', () => !openSheet());

  // Rest phase: confirm through round 0 until rest, open and close the sheet, timer untouched
  for (let guard = 0; guard < 20 && root().dataset.phase === 'round'; guard++) {
    const key = viewKey();
    await tap('[data-action="confirm"]', () => viewKey() !== key);
  }
  if (root().dataset.phase !== 'rest') {
    check('demo sheet (rest): block reaches a rest phase', false, 'phase ' + root().dataset.phase);
    return;
  }
  const endsAt = q('[data-rest-ends-at]').dataset.restEndsAt;
  const restBefore = await snap();
  await tap('.circuit-item [data-action="demo"]', () => !!openSheet(), 'rest sheet open');
  const openedId = openSheet().dataset.movementId;
  await sleep(600);
  const stillOpen = !!openSheet() && q('[data-rest-ends-at]').dataset.restEndsAt === endsAt;
  await tap('[data-demo-sheet] [data-action="demo-close"].btn', () => !openSheet());
  const restAfter = await snap();
  check('demo sheet (rest): opens from a circuit row, stays open while the clock runs, and closing keeps data-rest-ends-at and stored progress',
    stillOpen && !!byId(openedId) && q('[data-rest-ends-at]').dataset.restEndsAt === endsAt && root().dataset.phase === 'rest' &&
      restAfter.progress === restBefore.progress,
    endsAt + ' vs ' + q('[data-rest-ends-at]').dataset.restEndsAt);
  await tap('[data-action="rest-skip"]', () => root().dataset.phase === 'round');
}

async function phase1(library) {
  await loadApp();
  if (D().documentElement.dataset.screen !== 'today') throw new Error('app did not open on Today');

  // 1. Fresh profile: Today shows a generated session that passes validateSession
  let doc = await readDoc();
  const first = todayInfo();
  const v = doc && doc.current ? validateSession({ library, equipment: doc.equipment, sessions: doc.sessions, session: doc.current }) : [{ rule: 'missing', message: 'no current session stored' }];
  check('fresh profile: Today shows a generated session that passes validateSession',
    doc && doc.sessions.length === 0 && v.length === 0 && doc.current.id === first.id &&
      J(first.movements) === J(activeIds(doc.current)) && first.dayType === 'push',
    'violations ' + J(v) + ', today ' + J(first) + ', stored ' + (doc && doc.current && doc.current.id));
  info.first_session = first.id + ' (' + first.dayType + ', ' + first.movements.length + ' movements)';
  await checkLayout('today');
  await checkTodayWording();

  // 2. Log the full first session with one reps edit and one weight edit
  const ledger = [];
  const rec1 = await logFullSession({ edit: true, finisherDone: true, layout: true });
  const v1 = await verifyCompleted(rec1);
  ledger.push(rec1);
  const editsOk = rec1.edits.length === 2 && rec1.edits.every((e) => {
    const it = v1.stored.blocks.flatMap((b) => b.items).find((x) => x.movement_id === e.movement_id);
    const round = it.logged.rounds[e.round];
    return e.kind === 'reps' ? round.value === e.to && e.to !== it.target.value
      : round.weight_lb_per_dumbbell === e.to && e.to !== it.load.weight_lb_per_dumbbell;
  });
  const totalRounds = Object.values(rec1.items).reduce((s, x) => s + x.rounds.length, 0);
  check('session 1: every round, every effort, and the finisher logged, with a reps edit and a weight edit',
    v1.problems.length === 0 && editsOk && Object.values(rec1.items).every((x) => x.effort) &&
      (v1.stored.finisher ? v1.stored.finisher.done === true : true),
    v1.problems.join('; ') + ' edits ' + J(rec1.edits));
  info.session_1 = totalRounds + ' rounds confirmed, ' + Object.keys(rec1.items).length + ' efforts, finisher ' + rec1.finisher +
    ', edits ' + rec1.edits.map((e) => e.kind + ' ' + e.movement_id + ' r' + (e.round + 1) + ' ' + e.from + '->' + e.to).join(', ');
  check('session 1: Summary volume equals sessionVolume of the stored session',
    Number(root().dataset.volumeLb) === v1.vol.volume_lb && !v1.problems.some((p) => p.indexOf('volume') >= 0),
    'summary ' + root().dataset.volumeLb + ' vs ' + v1.vol.volume_lb);
  info.session_1_volume_lb = v1.vol.volume_lb;

  // notes are saved with the session
  const notes = q('#main textarea[data-field="notes"]');
  notes.value = 'e2e note';
  notes.dispatchEvent(new Event('input', { bubbles: true }));
  await idle();

  // 3. Done, then a real reload
  await tap('[data-action="summary-done"]', () => screenName() === 'today' && root().dataset.sessionId !== rec1.id, 'Today after Done');
  const beforeReload = todayInfo();
  await reloadApp();
  const afterReload = todayInfo();
  doc = await readDoc();
  const storedFirst = doc.sessions[0];
  const sameEdits = rec1.edits.every((e) => {
    const it = storedFirst.blocks.flatMap((b) => b.items).find((x) => x.movement_id === e.movement_id);
    const round = it.logged.rounds[e.round];
    return e.kind === 'reps' ? round.value === e.to : round.weight_lb_per_dumbbell === e.to;
  });
  check('reload: completed session is in IndexedDB with the edited values and notes',
    doc.sessions.length === 1 && storedFirst.id === rec1.id && sameEdits && storedFirst.notes === 'e2e note' && !!storedFirst.completed_at,
    'sessions ' + doc.sessions.length + ', edits kept ' + sameEdits + ', notes ' + J(storedFirst && storedFirst.notes));
  const overlap = afterReload.movements.filter((m) => first.movements.indexOf(m) >= 0);
  check('reload: Today shows a new session with the next day type and different movements',
    afterReload.id === beforeReload.id && afterReload.id !== rec1.id && doc.current && doc.current.id === afterReload.id &&
      afterReload.dayType === nextDayType(doc.sessions, library) && afterReload.dayType !== first.dayType &&
      J(afterReload.movements) !== J(first.movements),
    'before ' + J(beforeReload) + ' after ' + J(afterReload));
  info.after_reload = afterReload.dayType + ' session ' + afterReload.id + ', ' + overlap.length + ' of ' + afterReload.movements.length + ' movements shared with session 1';

  // 3b. Today controls through the DOM: length picker and the three shuffle scopes
  info.today_controls = await todayControls(library);

  // 4. Keep logging full sessions until Today shows last-time numbers (cap 15 sessions)
  const summaryProblems = [];
  let rows = lastTimeRows(ledger);
  while (!rows.length && ledger.length < MAX_SESSIONS) {
    const rec = await logFullSession({ edit: false, finisherDone: ledger.length % 2 === 0, layout: false });
    const vr = await verifyCompleted(rec);
    ledger.push(rec);
    vr.problems.forEach((p) => summaryProblems.push('session ' + ledger.length + ': ' + p));
    await tap('[data-action="summary-done"]', () => screenName() === 'today' && root().dataset.sessionId !== rec.id, 'Today after Done');
    await checkWrap('today ' + root().dataset.dayType);
    await checkTodayWording();
    rows = lastTimeRows(ledger);
  }
  check('sessions 2+: every round and effort stored as logged, Summary volume equals sessionVolume',
    summaryProblems.length === 0, summaryProblems.slice(0, 5).join('; '));
  info.sessions_logged = ledger.length;
  info.day_types = ledger.map((r) => r.day_type).join(', ');
  check('last-time numbers: Today shows them and they equal what the script logged',
    rows.length > 0 && rows.every((x) => x.ok),
    rows.length ? J(rows.filter((x) => !x.ok).slice(0, 3)) : 'none shown after ' + ledger.length + ' sessions');
  info.last_time = rows.length + ' movement(s) on Today after ' + ledger.length + ' logged session(s): ' +
    rows.map((x) => x.mid + ' [' + x.text + ']').join('; ');

  // 5. Mid-workout reload: confirmed rounds intact, same block and round
  await tap('[data-action="start"]', () => screenName() === 'workout', 'workout');
  await tap('[data-action="warmup-done"]', () => root().dataset.phase === 'round');
  await demoSheetChecks(library);
  const blockIndex = root().dataset.blockIndex;
  for (let guard = 0; guard < 20; guard++) {
    const r = root();
    if (r.dataset.phase === 'round' && r.dataset.round === '1' && r.dataset.item === '1') break;
    const key = viewKey();
    if (r.dataset.phase === 'rest') await tap('[data-action="rest-skip"]', () => viewKey() !== key);
    else if (r.dataset.round === '1' && r.dataset.item === '0') {
      const val = q('[data-active-item]').dataset.value;
      await tap('[data-action="value-up"]', () => q('[data-active-item]').dataset.value !== val);
      await tap('[data-action="confirm"]', () => viewKey() !== key);
    } else await tap('[data-action="confirm"]', () => viewKey() !== key);
  }
  const posBefore = position();
  const chipsBefore = chipsOnScreen();
  await idle();
  const midDoc = await readDoc();
  const loggedBefore = loggedOf(midDoc.current);
  await reloadApp();
  const posAfter = position();
  const chipsAfter = chipsOnScreen();
  const afterDoc = await readDoc();
  check('mid-workout reload: resumes at the same block and round with the confirmed rounds intact',
    posBefore.screen === 'workout' && J(posAfter) === J(posBefore) && posAfter.blockIndex === blockIndex &&
      chipsBefore.length === 4 && J(chipsAfter) === J(chipsBefore) && J(loggedOf(afterDoc.current)) === J(loggedBefore),
    'before ' + J(posBefore) + ' ' + J(chipsBefore) + ' after ' + J(posAfter) + ' ' + J(chipsAfter));
  info.mid_workout = 'Block ' + posAfter.block + ', round ' + (Number(posAfter.round) + 1) + ', movement ' +
    (Number(posAfter.item) + 1) + ', ' + chipsAfter.length + ' confirmed rounds';

  check('layout: no horizontal scroll at 375 px (' + layout.screens.length + ' screens)', layout.overflow.length === 0, layout.overflow.join(', '));
  check('layout: tap targets at least 48 px and inputs at 16 px or more', layout.small.length === 0, layout.small.slice(0, 6).join(', '));
  const needScreens = ['today', 'workout round', 'workout rest', 'workout effort', 'workout finisher', 'summary'];
  const missing = needScreens.filter((n) => !wrap.screens.some((s) => s.indexOf(n) === 0));
  check('layout: no button label wraps onto a second line at 375 px on Today, Workout round, rest, effort, finisher, and Summary (' +
    wrap.screens.length + ' screens, ' + wrap.buttons + ' buttons)',
  missing.length === 0 && wrap.problems.length === 0,
  (missing.length ? 'not seen: ' + missing.join(', ') + '; ' : '') + wrap.problems.slice(0, 6).join(', '));
  info.button_labels = wrap.buttons + ' button labels on ' + wrap.screens.length + ' screens checked at 375 px';
  check('effort screen: a three-movement block shows all nine options and the continue button without scrolling at 375 x 812 (' +
    effortFit.screens + ' screens)',
  effortFit.screens > 0 && effortFit.problems.length === 0,
  effortFit.screens ? effortFit.problems.slice(0, 3).join('; ') : 'no three-movement effort screen seen');
  info.effort_fit = effortFit.screens + ' effort screens at 375 x 812, lowest option bottom ' + Math.round(effortFit.lowest) +
    ' px, bar top ' + Math.round(effortFit.barTop) + ' px';
  check('copy: every load line states the dumbbell count the same way, chips use @, and the Workout finisher card is titled by name (' +
    wording.lines + ' lines)',
  wording.lines > 0 && wording.problems.length === 0, wording.problems.slice(0, 5).join(', '));
  check('app: no uncaught errors', appErrors.length === 0, appErrors.slice(0, 3).join(' | '));

  return {
    session_ids: afterDoc.sessions.map((s) => s.id),
    current_id: afterDoc.current.id,
    position: posAfter,
    chips: chipsAfter,
    logged: loggedBefore,
  };
}

async function phase2() {
  const expect = await (await fetch('/__expect', { cache: 'no-store' })).json();
  await loadApp();
  const doc = await readDoc();
  const ids = doc ? doc.sessions.map((s) => s.id) : [];
  check('browser restart: a second Edge process finds every logged session (' + expect.session_ids.length + ')',
    J(ids) === J(expect.session_ids), 'found ' + ids.length + ' ' + J(ids.slice(-3)));
  check('browser restart: the workout in progress kept its confirmed rounds, and Today offers Resume',
    doc && doc.current && doc.current.id === expect.current_id && J(loggedOf(doc.current)) === J(expect.logged) &&
      screenName() === 'today' && !!q('[data-action="resume"]') && !q('[data-action="start"]'),
    'current ' + (doc && doc.current && doc.current.id) + ' screen ' + screenName());
  await tap('[data-action="resume"]', () => screenName() === 'workout', 'workout after Resume');
  const pos = position();
  check('browser restart: Resume lands on the same block and round',
    J(pos) === J(expect.position) && J(chipsOnScreen()) === J(expect.chips),
    'got ' + J(pos) + ' expected ' + J(expect.position));
  info.restart = ids.length + ' sessions found, resumed at Block ' + pos.block + ' round ' + (Number(pos.round) + 1);

  // End workout early asks first. With a draft edit on screen, Keep going leaves the screen and
  // the stored document exactly as they were.
  const v0 = q('[data-active-item]').dataset.value;
  await tap('[data-action="value-up"]', () => q('[data-active-item]').dataset.value !== v0);
  await idle();
  const keepDom = screenState();
  const keepDoc = J(await readDoc());
  await tap('[data-action="end-early"]', () => q('[data-action="confirm-end"]'), 'end-early confirm');
  const asked = screenName() === 'workout' && !q('[data-action="confirm"]') && !!q('[data-action="cancel-confirm"]');
  await idle();
  const askingDoc = J(await readDoc());
  await tap('[data-action="cancel-confirm"]', () => q('#bar [data-action="confirm"]'), 'Confirm back after Keep going');
  await idle();
  const cancelDom = screenState();
  const cancelDoc = J(await readDoc());
  const cancelProblems = [];
  if (!asked) cancelProblems.push('End workout early did not ask first');
  if (askingDoc !== keepDoc) cancelProblems.push('stored document changed while asking');
  if (J(cancelDom) !== J(keepDom)) cancelProblems.push('screen after Keep going ' + J(cancelDom) + ' != ' + J(keepDom));
  if (cancelDoc !== keepDoc) cancelProblems.push('stored document changed after Keep going');

  // End workout early: confirmed rounds saved, the rest unlogged as { rounds: [], effort: null }
  await tap('[data-action="end-early"]', () => q('[data-action="confirm-end"]'), 'end-early confirm');
  await tap('[data-action="confirm-end"]', () => screenName() === 'summary', 'summary after End early');
  await idle();
  const after = await readDoc();
  const ended = after.sessions[after.sessions.length - 1];
  const vol = sessionVolume(ended);
  let partial = 0;
  let empty = 0;
  let removedNull = 0;
  const bad = [];
  ended.blocks.forEach((b) => b.items.forEach((it) => {
    if (!(b.rounds > 0) || b.removed) {
      if (it.logged === null) removedNull += 1; else bad.push(it.movement_id + ' in removed block has ' + J(it.logged));
    } else if (it.logged && it.logged.rounds.length) partial += 1;
    else if (J(it.logged) === J({ rounds: [], effort: null })) empty += 1;
    else bad.push(it.movement_id + ' ' + J(it.logged));
  }));
  check('End workout early: confirmed rounds saved, the rest stored as { rounds: [], effort: null }, Summary volume equals sessionVolume',
    after.sessions.length === ids.length + 1 && ended.id === expect.current_id && ended.ended_early === true &&
      after.current === null && J(loggedOf(ended)) === J(expect.logged) && bad.length === 0 && empty > 0 &&
      Number(root().dataset.volumeLb) === vol.volume_lb && (!ended.finisher || ended.finisher.done === false),
    'sessions ' + after.sessions.length + ', bad ' + J(bad) + ', summary ' + root().dataset.volumeLb + ' vs ' + vol.volume_lb);
  info.end_early = partial + ' movements with confirmed rounds, ' + empty + ' unlogged as {rounds: [], effort: null}, ' +
    removedNull + ' in a removed block left null, volume ' + vol.volume_lb + ' lb';
  check('End workout early: asks first; Keep going leaves the workout exactly as it was, End workout saves it',
    cancelProblems.length === 0 && after.sessions.length === ids.length + 1 && ended.ended_early === true && ended.id === expect.current_id,
    cancelProblems.join('; ') + (ended.ended_early === true ? '' : ' not saved as ended early'));
  await tap('[data-action="summary-done"]', () => screenName() === 'today' && root().dataset.sessionId !== ended.id, 'Today after Done');
  const nextDay = root().dataset.dayType;
  const discardId = root().dataset.sessionId;

  // Undo: hidden with nothing to undo; after a confirm, from rest, and from effort it restores the
  // screen and the stored workout, and a reload shows the undone state.
  await tap('[data-action="start"]', () => screenName() === 'workout', 'workout');
  await tap('[data-action="warmup-done"]', () => root().dataset.phase === 'round');
  const hiddenAtStart = !q('[data-action="undo"]');
  const v1 = q('[data-active-item]').dataset.value;
  await tap('[data-action="value-up"]', () => q('[data-active-item]').dataset.value !== v1);
  const u1 = await undoCase(confirmAndWait, 'round');
  check('Undo after a confirm: back to that movement with the logged value as the draft, on screen and in storage, and after a reload; hidden at the first movement',
    u1.problems.length === 0 && hiddenAtStart, (hiddenAtStart ? '' : 'Undo shown with nothing to undo; ') + u1.problems.join('; '));
  const uDoc = await readDoc();
  const bi = uDoc.current.progress.block;
  const blk = uDoc.current.blocks[bi];
  const n = blk.items.length;
  for (let guard = 0; guard < 10 && root().dataset.item !== String(n - 1); guard++) await confirmAndWait();
  const u2 = await undoCase(confirmAndWait, 'rest');
  check('Undo from rest: cancels the rest and restores the last movement of the round, on screen and in storage, and after a reload',
    u2.problems.length === 0, u2.problems.join('; '));
  for (let guard = 0; guard < 60; guard++) {
    const d = root().dataset;
    if (d.phase === 'round' && d.round === String(blk.rounds - 1) && d.item === String(n - 1)) break;
    if (d.phase === 'rest') {
      const kr = viewKey();
      await tap('[data-action="rest-skip"]', () => viewKey() !== kr);
    } else await confirmAndWait();
  }
  const u3 = await undoCase(async () => {
    await confirmAndWait();
    await tap('[data-action="effort"][data-item="0"][data-effort="barely"]',
      () => q('#main .effort-card[data-item="0"]').dataset.effort === 'barely');
  }, 'effort');
  // Finish the block: at the start of the next block there is nothing to undo
  await confirmAndWait();
  for (const c of qa('#main .effort-card[data-item]')) {
    const i = c.dataset.item;
    await tap('[data-action="effort"][data-item="' + i + '"][data-effort="hard_clean"]',
      () => q('#main .effort-card[data-item="' + i + '"]').dataset.effort === 'hard_clean');
  }
  const ke = viewKey();
  await tap('[data-action="effort-done"]', () => viewKey() !== ke);
  const nd = root().dataset;
  const hiddenNextBlock = nd.phase === 'round' && nd.blockIndex !== String(bi) && nd.round === '0' && nd.item === '0' &&
    !q('[data-action="undo"]');
  check('Undo from effort: back to the last movement of the last round with efforts cleared, on screen and in storage, and after a reload; hidden once the block is submitted',
    u3.problems.length === 0 && hiddenNextBlock, (hiddenNextBlock ? '' : 'Undo shown at ' + viewKey() + '; ') + u3.problems.join('; '));
  info.undo = 'after a confirm at ' + J(u1.at) + ', from rest at ' + J(u2.at) + ', from effort at ' + J(u3.at) +
    ', label before and after: ' + u3.confirm;

  // Discard workout: confirm first, clears current, saves nothing
  const k = viewKey();
  await tap('[data-action="confirm"]', () => viewKey() !== k);
  await tap('[data-action="discard"]', () => q('[data-action="confirm-discard"]'), 'discard confirm');
  const stillWorkout = screenName() === 'workout';
  await tap('[data-action="confirm-discard"]', () => screenName() === 'today', 'Today after Discard');
  await idle();
  const afterDiscard = await readDoc();
  check('Discard workout: asks first, saves nothing, and Today shows a fresh unstarted session',
    stillWorkout && afterDiscard.sessions.length === after.sessions.length && afterDiscard.current &&
      !afterDiscard.current.started_at && afterDiscard.current.id !== discardId && root().dataset.started === '0' &&
      afterDiscard.current.day_type === nextDay && !!q('[data-action="start"]'),
    'sessions ' + afterDiscard.sessions.length + ' vs ' + after.sessions.length + ', current ' + J(afterDiscard.current && afterDiscard.current.id));
  check('app: no uncaught errors after restart', appErrors.length === 0, appErrors.slice(0, 3).join(' | '));
  return null;
}

// ---------------------------------------------------------------- swap phase
// Swap phase (?phase=swap, its own fresh profile, so phases 1 and 2 keep theirs): every Today row
// has a Swap button; the sheet lists exactly swapCandidates for the stored session with each
// row's plan line; Form shows the demo sheet and returns; Close and the backdrop close it; the sheet
// fits 375 px; picking the first candidate swaps that row, validates clean, and survives a reload;
// no Swap buttons once the workout has started.

const PHASE_NAME = new URLSearchParams(location.search).get('phase');

async function swapPhase(library) {
  const E = await import('../js/engine/index.js');
  const F = await import('../js/app/format.js');
  const byId = (id) => library.movements.find((m) => m.id === id);
  const sheetEl = () => q('[data-swap-sheet]');
  const rowSel = (t) => '#main li.item[data-block="' + t.block + '"][data-slot="' + t.slot + '"]';
  const paramsFor = (d, bi, si) => ({ library, equipment: d.equipment, sessions: d.sessions, session: d.current, blockIndex: bi, slotIndex: si });
  await loadApp();
  if (screenName() !== 'today') throw new Error('app did not open on Today');
  await idle();
  let doc = await readDoc();

  // Every movement row has a Swap button carrying its block and slot
  const rows = qa('#main li.item[data-movement-id]');
  const btnProblems = [];
  rows.forEach((li) => {
    const b = li.querySelector('[data-action="swap-open"]');
    if (!b) btnProblems.push(li.dataset.movementId + ' has no Swap button');
    else if (b.dataset.block !== li.dataset.block || b.dataset.slot !== li.dataset.slot || b.textContent !== 'Swap') {
      btnProblems.push(li.dataset.movementId + ' Swap button ' + J(b.dataset) + ' "' + b.textContent + '"');
    }
  });
  check('swap: every movement row on Today has a Swap button with its data-block and data-slot (' + rows.length + ' rows)',
    rows.length > 0 && btnProblems.length === 0 && qa('#main [data-action="swap-open"]').length === rows.length, btnProblems.slice(0, 3).join('; '));

  // The first visible slot with candidates, and the first with none (if any)
  let target = null;
  let empty = null;
  for (const li of rows) {
    const bi = doc.current.blocks.findIndex((b) => b.block === li.dataset.block);
    const si = Number(li.dataset.slot);
    const cands = E.swapCandidates(paramsFor(doc, bi, si));
    const t = { block: li.dataset.block, slot: li.dataset.slot, bi, si, cands, from: li.dataset.movementId };
    if (cands.length && !target) target = t;
    if (!cands.length && !empty) empty = t;
  }
  if (!target) {
    check('swap: some slot on Today has a swap candidate', false, 'no candidates in ' + rows.length + ' rows');
    return;
  }
  const openSel = (t) => '#main [data-action="swap-open"][data-block="' + t.block + '"][data-slot="' + t.slot + '"]';
  await tap(openSel(target), () => !!sheetEl(), 'swap sheet open');
  const sheet = sheetEl();
  const listed = qa('[data-swap-candidate]').map((el) => el.dataset.movementId);
  const fromMv = byId(target.from);
  const planProblems = [];
  qa('[data-swap-candidate]').forEach((el) => {
    const id = el.dataset.movementId;
    const out = E.swapSlot(Object.assign({ movementId: id, now: null }, paramsFor(doc, target.bi, target.si)));
    const it = out.blocks[target.bi].items[target.si];
    const want = F.formatPlan(it.target, it.load);
    const got = el.querySelector('.swap-plan') ? el.querySelector('.swap-plan').textContent : '';
    if (got !== want || !PLAN_RE.test(got)) planProblems.push(id + ' "' + got + '" vs "' + want + '"');
    if (el.querySelector('h3').textContent !== byId(id).name) planProblems.push(id + ' name ' + el.querySelector('h3').textContent);
    if (!el.querySelector('[data-action="swap-pick"][data-movement-id="' + id + '"]')) planProblems.push(id + ' has no swap-pick');
    if (!!it.recommendation.last !== !!el.querySelector('[data-last]')) planProblems.push(id + ' last-time line mismatch');
  });
  check('swap sheet: lists exactly swapCandidates for the stored session (' + target.cands.length + ' for ' + target.block + (target.si + 1) +
    '), titled Swap <name>, a labelled modal dialog, each row with its name and the plan it would run',
  J(listed) === J(target.cands) && sheet.querySelector('.demo-title').textContent === 'Swap ' + fromMv.name &&
    sheet.dataset.block === target.block && sheet.dataset.slot === target.slot && sheet.getAttribute('role') === 'dialog' &&
    sheet.getAttribute('aria-modal') === 'true' && sheet.getAttribute('aria-label') === 'Swap ' + fromMv.name && planProblems.length === 0,
  'listed ' + J(listed) + ' want ' + J(target.cands) + '; ' + planProblems.slice(0, 3).join('; '));
  const text = sheet.textContent;
  check('swap sheet: visible text has no em dash, exclamation point, or emoji',
    !/[—!]/.test(text) && !/[\u{1F000}-\u{1FFFF}☀-➿]/u.test(text), text.slice(0, 80));

  // Fit at 375 px
  const fit = await atSize(375, 844, async () => {
    const de = D().documentElement;
    const vw = de.clientWidth;
    const pr = q('[data-swap-sheet] .demo-panel').getBoundingClientRect();
    let worst = de.scrollWidth - vw;
    qa('[data-swap-sheet] *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right - vw > worst) worst = r.right - vw;
    });
    const small = qa('[data-swap-sheet] .btn').filter((el) => {
      const r = el.getBoundingClientRect();
      return r.height < 44 || r.width < 44;
    }).length;
    const wrapBefore = wrap.problems.length;
    buttonWrapScan('swap sheet');
    const wrapped = wrap.problems.slice(wrapBefore);
    wrap.problems.length = wrapBefore;
    const list = q('[data-swap-sheet] .swap-list');
    return {
      worst, bottom: pr.bottom, vh: W().innerHeight, height: pr.height, small, wrapped,
      scrolls: list ? list.scrollHeight > list.clientHeight + 1 : false,
    };
  });
  check('swap sheet: no horizontal overflow at 375 px, bottom edge inside the viewport, at most 80% tall, tap targets 44 px, no label wraps',
    fit.worst <= 0.5 && fit.bottom <= fit.vh + 0.5 && fit.height <= fit.vh * 0.8 + 1 && fit.small === 0 && fit.wrapped.length === 0,
    J(fit));

  // Form: the demo sheet for that candidate, and closing it returns to the swap sheet
  const formId = target.cands[0];
  await tap('[data-swap-candidate][data-movement-id="' + formId + '"] [data-action="swap-demo"]', () => !!q('[data-demo-sheet]'), 'form sheet');
  const demoOk = q('[data-demo-sheet]').dataset.movementId === formId && !sheetEl();
  await tap('[data-demo-sheet] [data-action="demo-close"].btn', () => !!sheetEl() && !q('[data-demo-sheet]'), 'back to the swap sheet');
  const backOk = sheetEl().dataset.block === target.block && sheetEl().dataset.slot === target.slot &&
    J(qa('[data-swap-candidate]').map((el) => el.dataset.movementId)) === J(target.cands);
  check('swap sheet: Form shows the demo sheet for that candidate, and closing it returns to the same swap sheet', demoOk && backOk,
    'demo ' + demoOk + ', back ' + backOk);

  // Close and the backdrop both close it, and storage is untouched
  await idle();
  const beforeClose = J((await readDoc()).current);
  await tap('[data-swap-sheet] [data-action="swap-close"].btn', () => !sheetEl(), 'Close closes');
  await tap(openSel(target), () => !!sheetEl());
  await tap('[data-swap-sheet] .demo-backdrop', () => !sheetEl(), 'backdrop closes');
  await idle();
  check('swap sheet: Close and a backdrop tap both close it and leave the stored session unchanged',
    !sheetEl() && J((await readDoc()).current) === beforeClose, 'stored session changed');

  // A slot with no candidates says so and offers Close (only when such a slot is on screen)
  if (empty) {
    await tap(openSel(empty), () => !!sheetEl(), 'empty swap sheet');
    const msg = q('[data-swap-sheet] [data-swap-empty]');
    const ok = !!msg && msg.textContent === 'No other movement fits this slot with your equipment' && !q('[data-swap-candidate]') &&
      !!q('[data-swap-sheet] [data-action="swap-close"].btn');
    await tap('[data-swap-sheet] [data-action="swap-close"].btn', () => !sheetEl());
    check('swap sheet: a slot with no candidates says No other movement fits this slot with your equipment, with Close', ok,
      msg ? msg.textContent : 'no message');
  }

  // Pick the first candidate
  const pick = target.cands[0];
  await tap(openSel(target), () => !!sheetEl());
  await tap('[data-swap-candidate][data-movement-id="' + pick + '"] [data-action="swap-pick"]',
    () => !sheetEl() && q(rowSel(target)) && q(rowSel(target)).dataset.movementId === pick, 'row shows the swapped movement');
  await idle();
  const prev = doc;
  doc = await readDoc();
  const flash = q('[data-flash]');
  const v = validFor(library, doc);
  const others = [];
  prev.current.blocks.forEach((b, bi) => b.items.forEach((it, si) => {
    const now = doc.current.blocks[bi].items[si].movement_id;
    if (!(bi === target.bi && si === target.si) && now !== it.movement_id) others.push(b.block + (si + 1));
  }));
  const rec = doc.current.rerolls.history[doc.current.rerolls.history.length - 1];
  check('swap: picking the first candidate shows it in that row, says Swapped to <name>, and the stored current validates clean with only that slot changed',
    doc.current.blocks[target.bi].items[target.si].movement_id === pick && v.length === 0 && others.length === 0 &&
      !!flash && flash.textContent === 'Swapped to ' + byId(pick).name && rec && rec.scope.type === 'swap' &&
      J(todayInfo().movements) === J(activeIds(doc.current)),
    'violations ' + J(v) + ', others ' + J(others) + ', flash ' + (flash && flash.textContent) + ', record ' + J(rec));
  info.swap = target.block + (target.si + 1) + ' ' + target.from + ' -> ' + pick + ' (' + target.cands.length + ' candidates: ' +
    target.cands.join(', ') + ')' + (empty ? '; no candidates for ' + empty.block + (empty.si + 1) + ' ' + empty.from : '');

  // Reload keeps it
  await reloadApp();
  const reloaded = await readDoc();
  check('swap: the swapped session survives a reload',
    reloaded.current.id === doc.current.id && reloaded.current.blocks[target.bi].items[target.si].movement_id === pick &&
      q(rowSel(target)).dataset.movementId === pick && validFor(library, reloaded).length === 0,
    'stored ' + reloaded.current.blocks[target.bi].items[target.si].movement_id);

  // Once the workout has started, Today shows no Swap buttons
  await tap('[data-action="start"]', () => screenName() === 'workout', 'workout');
  W().location.hash = '#/today';
  await waitFor(() => screenName() === 'today' && root().dataset.started === '1', 'Today after Start');
  check('swap: no Swap buttons on Today once the workout has started',
    qa('#main li.item[data-movement-id]').length > 0 && !q('[data-action="swap-open"]') && !sheetEl(),
    qa('[data-action="swap-open"]').length + ' Swap buttons');
  check('swap phase: no uncaught errors', appErrors.length === 0, appErrors.slice(0, 3).join(' | '));
}

// ---------------------------------------------------------------- settings phase
// Settings phase (?phase=settings, its own fresh profile): the tab row moves among Today, History,
// Progress, and Settings by tap and by hash and is absent on Workout and Summary; bench off and
// back on rebuild the unstarted session; a change the guard rejects leaves the document untouched;
// default length and the swap switch survive a reload; export (cancelled share, download
// fallback, share sheet) carries the stored sessions; import through the real file input restores
// everything on an emptied database, rejects malformed files, and Add missing sessions adds only
// the missing ones; Settings fits 375 px. History is written through the storage API.

async function settingsPhase(library) {
  const S = await import('../js/app/storage.js');
  const E = await import('../js/engine/index.js');
  const F = await import('../js/app/format.js');
  const H = await import('./helpers.js');
  const { diff } = await import('./harness.js');
  const byId = new Map(library.movements.map((m) => [m.id, m]));
  const TABS = 'today,history,progress,settings';
  const FULL = '#app button, #app a, #app [data-action]';
  const lay = { screens: [], overflow: [], wrapped: [], small: [] };

  const tabNames = () => qa('#nav [data-nav]').map((t) => t.dataset.nav).join(',');
  const currentTab = () => {
    const c = qa('#nav [aria-current="page"]');
    return c.length === 1 ? c[0].dataset.nav : c.length + ' marked';
  };
  const goTab = (name) => tap('#nav [data-nav="' + name + '"]', () => screenName() === name, 'tab ' + name);
  const sw = (key) => q('[data-equipment="' + key + '"]');
  const noteEl = () => q('#main [data-settings-note]');
  const lastLine = () => q('#main [data-last-export]');
  const violations = (doc) => E.validateSession({ library, equipment: doc.equipment, sessions: doc.sessions, session: doc.current });
  const movementIds = (s) => s.blocks.flatMap((b) => b.items.map((it) => it.movement_id));

  async function blankFrame() {
    await idle();
    W().__e2eOld = true;
    frame.src = 'about:blank';
    await waitFor(() => { const w = W(); return w && !w.__e2eOld && w.location.href === 'about:blank'; }, 'blank frame');
  }

  function dropDb() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.deleteDatabase(S.DB_NAME);
      const t = setTimeout(() => reject(new Error('delete database timed out')), 10000);
      r.onsuccess = () => { clearTimeout(t); resolve(); };
      r.onerror = () => { clearTimeout(t); reject(r.error); };
    });
  }

  // Close the app, delete its database, optionally store `doc` through the storage API, reopen.
  async function restart(doc) {
    await blankFrame();
    await dropDb();
    if (doc) {
      const st = await S.openStorage(S.DB_NAME);
      await S.writeRaw(st.db, doc);
      st.close();
    }
    await loadApp();
    await idle();
  }

  // Flip one equipment switch; accepted when its state changed, rejected when an error note shows.
  async function flip(key) {
    const el = await waitFor(() => { const e = sw(key); return e && !e.disabled ? e : null; }, 'switch ' + key);
    const was = el.getAttribute('aria-checked');
    el.click();
    await waitFor(() => (sw(key) && sw(key).getAttribute('aria-checked') !== was) ||
      (noteEl() && noteEl().dataset.settingsNote === 'error'), 'result of ' + key);
    await idle();
    return { accepted: sw(key).getAttribute('aria-checked') !== was, note: noteEl() ? noteEl().textContent : '' };
  }

  function chooseFile(text, name) {
    const w = W();
    const input = q('[data-backup-file]');
    const dt = new w.DataTransfer();
    dt.items.add(new w.File([text], name, { type: 'application/json' }));
    input.files = dt.files;
    input.dispatchEvent(new w.Event('change', { bubbles: true }));
  }

  // Items of the current session that need a bench or fail isEligible under the stored equipment.
  function benchProblems(doc) {
    const s = doc.current;
    const tpl = library.slot_templates.find((t) => t.id === s.template_id);
    const bad = [];
    s.blocks.forEach((b, bi) => b.items.forEach((it) => {
      const m = byId.get(it.movement_id);
      const need = m && m.equipment && m.equipment.bench;
      if (!m || need === 'flat' || need === 'incline' || !E.isEligible(m, tpl.blocks[bi].slots[it.slot].roles, doc.equipment)) {
        bad.push(it.movement_id + (need ? ' (' + need + ')' : ''));
      }
    }));
    return bad;
  }

  function labelFit(el) {
    const range = D().createRange();
    range.selectNodeContents(el);
    const tops = Array.from(range.getClientRects()).filter((x) => x.width > 0 && x.height > 0)
      .map((x) => x.top).sort((a, b) => a - b);
    let lines = 0;
    let prev = -Infinity;
    tops.forEach((t) => { if (t - prev > 4) { lines += 1; prev = t; } });
    const cs = W().getComputedStyle(el);
    const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return { lines, over: Math.max(el.scrollWidth - el.clientWidth, range.getBoundingClientRect().width - room) };
  }

  // At 375 px: no horizontal overflow, labels in `sel` on one line, and targets at least 44 px.
  async function fits(label, sel) {
    await atSize(375, 812, () => {
      lay.screens.push(label);
      const de = D().documentElement;
      const vw = de.clientWidth;
      let worst = de.scrollWidth - vw;
      qa('#app *').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right - vw > worst) worst = r.right - vw;
      });
      if (worst > 0.5) lay.overflow.push(label + ' +' + Math.round(worst) + 'px');
      qa(sel).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (!(r.width > 0)) return;
        const name = el.textContent.trim() || el.dataset.action || el.dataset.nav;
        if (el.textContent.trim()) {
          const f = labelFit(el);
          if (f.lines > 1 || f.over > 0.5) lay.wrapped.push(label + ' "' + name + '" ' + (f.lines > 1 ? f.lines + ' lines' : '+' + Math.round(f.over) + 'px'));
        }
        if (r.height < 44 || r.width < 44) lay.small.push(label + ' "' + name + '" ' + Math.round(r.width) + 'x' + Math.round(r.height));
      });
    });
  }

  // 1. Fresh profile, then a five-session history written through the storage API
  await loadApp();
  await idle();
  let doc = await readDoc();
  const freshOk = screenName() === 'today' && !!doc && doc.sessions.length === 0 && !!doc.current;
  const hist = H.runChain({ equipment: library.default_equipment, lengthMin: 50, count: 5, seedPrefix: 'e2e-settings' }).sessions;
  await restart(Object.assign(S.defaultDoc(library), { sessions: hist }));
  doc = await readDoc();
  check('settings phase: a fresh profile opens on Today, then a five-session history written through the storage API loads',
    freshOk && screenName() === 'today' && doc.sessions.length === 5 && !!doc.current && !doc.current.started_at &&
      root().dataset.sessionId === doc.current.id,
    'fresh ' + freshOk + ', sessions ' + (doc && doc.sessions.length) + ', screen ' + screenName());

  // 2. Tabs: by tap and by hash; absent on Workout and Summary
  const navProblems = [];
  if (tabNames() !== TABS || currentTab() !== 'today') navProblems.push('today: ' + tabNames() + ' current ' + currentTab());
  for (const name of ['history', 'progress', 'settings', 'today']) {
    await goTab(name);
    if (tabNames() !== TABS || currentTab() !== name || D().documentElement.dataset.screen !== name || W().location.hash !== '#/' + name) {
      navProblems.push('tap ' + name + ': tabs ' + tabNames() + ', current ' + currentTab() + ', hash ' + W().location.hash);
    }
    if (name === 'history' && qa('#main [data-history-row]').length !== 5) navProblems.push('history rows ' + qa('#main [data-history-row]').length);
    if (name === 'progress' && !q('#main [data-chart="weekly"]')) navProblems.push('progress has no weekly chart');
    await fits(name === 'settings' ? 'settings' : 'tabs on ' + name, name === 'settings' ? FULL : '#nav a');
  }
  for (const name of ['progress', 'settings', 'history', 'today']) {
    W().location.hash = '#/' + name;
    await waitFor(() => screenName() === name && currentTab() === name, 'route #/' + name);
  }
  await tap('[data-action="start"]', () => screenName() === 'workout', 'workout');
  const navOnWorkout = qa('#nav, [data-nav]').length;
  await tap('[data-action="end-early"]', () => q('[data-action="confirm-end"]'), 'end-early confirm');
  await tap('[data-action="confirm-end"]', () => screenName() === 'summary', 'summary');
  const navOnSummary = qa('#nav, [data-nav]').length;
  await tap('[data-action="summary-done"]', () => screenName() === 'today', 'Today after Done');
  check('tabs: Today, History, Progress, and Settings move among the four screens by tap and by hash with the current one marked; absent on Workout and Summary',
    navProblems.length === 0 && navOnWorkout === 0 && navOnSummary === 0 && tabNames() === TABS && currentTab() === 'today',
    navProblems.join('; ') + ' nav on workout ' + navOnWorkout + ', on summary ' + navOnSummary);

  // 3. Bench off: a new unstarted session with no bench movement, kept after a reload; back on
  await idle();
  doc = await readDoc();
  const idBefore = doc.current.id;
  await goTab('settings');
  const off = await flip('bench.present');
  doc = await readDoc();
  const offId = doc.current && doc.current.id;
  const benchBad = doc.current ? benchProblems(doc) : ['no current session'];
  const vOff = doc.current ? violations(doc) : [];
  await goTab('today');
  const todayOff = root().dataset.sessionId;
  await reloadApp();
  const docOff = await readDoc();
  check('bench off: Today shows a new unstarted session with no movement that needs the bench (library and isEligible), valid, and it survives a reload',
    off.accepted && doc.equipment.bench.present === false && !!offId && offId !== idBefore && !doc.current.started_at &&
      benchBad.length === 0 && vOff.length === 0 && todayOff === offId && screenName() === 'today' &&
      root().dataset.sessionId === offId && docOff.current.id === offId && docOff.equipment.bench.present === false,
    'accepted ' + off.accepted + ' ' + off.note + ', ids ' + idBefore + ' -> ' + offId + ' (Today ' + todayOff + ', after reload ' +
      root().dataset.sessionId + '), bench items ' + J(benchBad) + ', violations ' + J(vOff));
  info.bench_off = offId + ': ' + movementIds(doc.current).join(', ');
  await goTab('settings');
  const on = await flip('bench.present');
  doc = await readDoc();
  check('bench on again: saved, and Today gets another new unstarted session that passes validateSession',
    on.accepted && doc.equipment.bench.present === true && doc.current.id !== offId && !doc.current.started_at &&
      violations(doc).length === 0 && diff(doc.equipment, library.default_equipment) === '',
    'accepted ' + on.accepted + ', current ' + doc.current.id + ', violations ' + J(violations(doc)));

  // 4. A change the guard rejects: the adjustable off, then fixed pairs off one at a time
  const steps = [];
  let rejected = null;
  const adj = await flip('adjustable.present');
  steps.push('adjustable off ' + (adj.accepted ? 'accepted' : 'rejected'));
  if (adj.accepted) {
    for (const w of library.default_equipment.fixed_pairs_lb) {
      const key = 'fixed_pairs_lb.' + w;
      const before = J(await readDoc());
      const r = await flip(key);
      if (r.accepted) { steps.push(w + ' lb pair off accepted'); continue; }
      const after = J(await readDoc());
      rejected = { key, note: r.note, untouched: after === before, shownOn: sw(key).getAttribute('aria-checked') === 'true' };
      await fits('settings with an error note', FULL);
      break;
    }
  }
  for (const w of library.default_equipment.fixed_pairs_lb) {
    if (sw('fixed_pairs_lb.' + w).getAttribute('aria-checked') === 'false') await flip('fixed_pairs_lb.' + w);
  }
  if (sw('adjustable.present').getAttribute('aria-checked') === 'false') await flip('adjustable.present');
  doc = await readDoc();
  check('guard: a change it rejects leaves the stored document untouched and the message names what could not be filled',
    !!rejected && rejected.untouched && rejected.shownOn && /^Not changed\./.test(rejected.note) && rejected.note.length > 20 &&
      rejected.note.length < 160 &&
      diff(doc.equipment, library.default_equipment) === '' && violations(doc).length === 0,
    J(steps) + ' rejected ' + J(rejected) + ' equipment ' + diff(doc.equipment, library.default_equipment));
  info.guard = steps.join(', ') + '; rejected ' + (rejected ? rejected.key + ' off: "' + rejected.note + '"' : 'none');

  // 5. Default length and the swap switch survive a reload
  const lenBefore = movementIds(doc.current);
  await tap('[data-action="default-length"][data-length="40"]',
    () => q('[data-action="default-length"][data-length="40"]').getAttribute('aria-pressed') === 'true', 'length 40');
  await idle();
  doc = await readDoc();
  const lenStored = doc.settings.default_length_min === 40 && doc.current.length_min === 40 && !doc.current.started_at &&
    J(movementIds(doc.current)) === J(lenBefore);
  await tap('[data-action="swaps-toggle"]', () => q('[data-action="swaps-toggle"]').getAttribute('aria-checked') === 'false', 'swaps off');
  await idle();
  doc = await readDoc();
  const swapStored = doc.settings.auto_pick_swaps === false && doc.current.auto_pick_swaps === false && !doc.current.started_at &&
    doc.current.length_min === 40 && violations(doc).length === 0;
  await reloadApp();
  const lenUi = screenName() === 'settings' && q('[data-action="default-length"][data-length="40"]').getAttribute('aria-pressed') === 'true';
  const swapUi = q('[data-action="swaps-toggle"]').getAttribute('aria-checked') === 'false';
  await goTab('today');
  const todayLen = root().dataset.lengthMin;
  doc = await readDoc();
  check('default length: 40 min is saved, the unstarted session keeps its movements at 40 min now, and both survive a reload',
    lenStored && lenUi && todayLen === '40' && doc.settings.default_length_min === 40 && doc.current.length_min === 40,
    'stored ' + lenStored + ', ui ' + lenUi + ', Today ' + todayLen);
  check('swap switch: off is saved, rebuilds the unstarted session with auto_pick_swaps false, and survives a reload',
    swapStored && swapUi && doc.settings.auto_pick_swaps === false && doc.current.auto_pick_swaps === false,
    'stored ' + swapStored + ', ui ' + swapUi);

  // 5b. An equipment change during a started workout is saved and leaves the workout alone
  await tap('[data-action="start"]', () => screenName() === 'workout', 'workout');
  await idle();
  const startedDoc = await readDoc();
  W().location.hash = '#/settings';
  await waitFor(() => screenName() === 'settings', 'Settings during a workout');
  const pb = await flip('pull_up_bar');
  const nextNote = noteEl() ? noteEl().textContent : '';
  const duringDoc = await readDoc();
  W().location.hash = '#/workout';
  await waitFor(() => screenName() === 'workout', 'back to the workout');
  await tap('[data-action="discard"]', () => q('[data-action="confirm-discard"]'), 'discard confirm');
  await tap('[data-action="confirm-discard"]', () => screenName() === 'today', 'Today after Discard');
  await idle();
  check('equipment change during a started workout: saved, the workout left exactly as it was, and the line Applies from your next session shows',
    pb.accepted && nextNote === 'Applies from your next session' && duringDoc.equipment.pull_up_bar === true &&
      J(duringDoc.current) === J(startedDoc.current),
    'accepted ' + pb.accepted + ', note ' + J(nextNote) + ', current kept ' + (J(duringDoc.current) === J(startedDoc.current)));

  // 6. Export: a cancelled share, the download fallback, then the share sheet
  await goTab('settings');
  const w = W();
  const noBackupYet = lastLine().textContent === 'No backup yet' && lastLine().dataset.lastExport === '';
  Object.defineProperty(w.navigator, 'canShare', { configurable: true, value: () => true });
  Object.defineProperty(w.navigator, 'share', {
    configurable: true, value: () => Promise.reject(new w.DOMException('Share canceled', 'AbortError')),
  });
  const beforeCancel = J(await readDoc());
  q('[data-action="export-backup"]').click();
  await sleep(300);
  await idle();
  const cancelOk = J(await readDoc()) === beforeCancel && !q('[data-settings-note="error"]') && lastLine().textContent === 'No backup yet';

  const proto = w.HTMLAnchorElement.prototype;
  const realClick = proto.click;
  let anchor = null;
  Object.defineProperty(w.navigator, 'canShare', { configurable: true, value: () => false });
  proto.click = function () { anchor = { href: this.href, download: this.download }; };
  const beforeDl = await readDoc();
  try {
    await tap('[data-action="export-backup"]', () => anchor && lastLine().dataset.lastExport !== '', 'download export');
  } finally {
    proto.click = realClick;
  }
  await idle();
  const dl = JSON.parse(await (await w.fetch(anchor.href)).text());
  const afterDl = await readDoc();
  const dlOk = /^dumbbell-backup-\d{4}-\d{2}-\d{2}\.json$/.test(anchor.download) && dl.app === 'dumbbell-app' &&
    diff(dl.doc.sessions, beforeDl.sessions) === '' && afterDl.settings.last_export_at === dl.exported_at;

  let shared = null;
  Object.defineProperty(w.navigator, 'canShare', { configurable: true, value: (d) => !!(d && d.files && d.files.length === 1) });
  Object.defineProperty(w.navigator, 'share', {
    configurable: true,
    value: (d) => d.files[0].text().then((text) => { shared = { name: d.files[0].name, type: d.files[0].type, text }; }),
  });
  const original = await readDoc();
  await tap('[data-action="export-backup"]',
    () => shared && lastLine().dataset.lastExport === JSON.parse(shared.text).exported_at, 'share export');
  await idle();
  const payload = JSON.parse(shared.text);
  const afterShare = await readDoc();
  const shareOk = /^dumbbell-backup-\d{4}-\d{2}-\d{2}\.json$/.test(shared.name) && shared.type === 'application/json' &&
    payload.app === 'dumbbell-app' && payload.kind === 'backup' && payload.schema_version === S.SCHEMA_VERSION &&
    diff(payload.doc.sessions, original.sessions) === '' && diff(payload.doc, original) === '' &&
    afterShare.settings.last_export_at === payload.exported_at &&
    lastLine().textContent === 'Last backup: ' + F.formatDate(payload.exported_at);
  check('export: a cancelled share saves nothing; the download fallback and the share sheet each carry the stored sessions; Last backup updates after delivery',
    noBackupYet && cancelOk && dlOk && shareOk,
    'no backup yet ' + noBackupYet + ', cancel ' + cancelOk + ', download ' + dlOk + ' ' + J(anchor && anchor.download) +
      ', share ' + shareOk + ' ' + J(shared && shared.name) + ' ' + diff(payload.doc, original));
  info.export = shared.name + ', ' + shared.text.length + ' bytes, ' + payload.doc.sessions.length + ' sessions';

  // 7. Import with Replace everything on an emptied database
  await restart(null);
  doc = await readDoc();
  const emptyOk = doc.sessions.length === 0 && diff(doc.equipment, library.default_equipment) === '' &&
    diff(doc.settings, { default_length_min: 50, auto_pick_swaps: true }) === '';
  await goTab('settings');
  const all = payload.doc.sessions;
  chooseFile(shared.text, shared.name);
  await waitFor(() => q('[data-import-summary]'), 'import summary');
  const expectSummary = 'Backup from ' + F.formatDate(payload.exported_at) + ': ' + all.length + ' sessions (' +
    F.formatDate(all[0].completed_at) + ' to ' + F.formatDate(all[all.length - 1].completed_at) + '). This phone has 0 sessions.';
  const summaryText = q('[data-import-summary]').textContent;
  const choices = qa('#bar [data-action^="import-"]').map((b) => b.textContent).join('|');
  await fits('settings import confirm', FULL);
  await tap('[data-action="import-replace"]', () => !q('[data-import-summary]') && noteEl() && /^Restored/.test(noteEl().textContent), 'restored');
  await idle();
  const restoredNote = noteEl().textContent;
  const restored = await readDoc();
  const keys = ['sessions', 'equipment', 'settings', 'current'];
  const restoreDiffs = keys.map((k) => { const d = diff(restored[k], payload.doc[k]); return d ? k + ' ' + d : ''; }).filter(Boolean);
  await reloadApp();
  const persisted = await readDoc();
  const persistDiffs = keys.map((k) => { const d = diff(persisted[k], payload.doc[k]); return d ? k + ' ' + d : ''; }).filter(Boolean);
  await goTab('today');
  const todayRestored = root().dataset.sessionId === payload.doc.current.id;
  check('import, Replace everything: on an emptied database the confirm shows the summary and three choices; every session, the equipment, and the settings deep-equal the originals, also after a reload',
    emptyOk && summaryText === expectSummary && choices === 'Replace everything|Add missing sessions|Cancel' &&
      restoredNote === 'Restored ' + all.length + ' sessions' && restoreDiffs.length === 0 && persistDiffs.length === 0 && todayRestored,
    'empty ' + emptyOk + ', summary ' + J(summaryText) + ' expected ' + J(expectSummary) + ', choices ' + choices + ', note ' +
      J(restoredNote) + ', diffs ' + J(restoreDiffs) + ' after reload ' + J(persistDiffs) + ', Today ' + todayRestored);
  info.import_summary = summaryText;

  // 8. Malformed files: an error, no import offered, data untouched
  await goTab('settings');
  await idle();
  const beforeBad = J(await readDoc());
  chooseFile('{"app": "dumbbell-app", "doc": {', 'broken.json');
  await waitFor(() => noteEl() && noteEl().dataset.settingsNote === 'error', 'error for broken JSON');
  const bad1 = noteEl().textContent;
  const noConfirm1 = !q('[data-import-summary]');
  chooseFile(JSON.stringify({ app: 'another-app', kind: 'backup', doc: payload.doc }), 'other.json');
  await waitFor(() => noteEl() && noteEl().dataset.settingsNote === 'error' && noteEl().textContent !== bad1, 'error for another app');
  const bad2 = noteEl().textContent;
  const noConfirm2 = !q('[data-import-summary]');
  await fits('settings with an import error', FULL);
  await idle();
  check('import: a malformed file and a file from another app show an error, offer no import, and leave the data untouched',
    noConfirm1 && noConfirm2 && bad1.length > 0 && bad2.length > 0 && J(await readDoc()) === beforeBad,
    J([bad1, bad2]) + ' confirm shown ' + !(noConfirm1 && noConfirm2));
  info.import_errors = bad1 + ' | ' + bad2;

  // 9. Add missing sessions on a profile that already holds two of them
  const phoneDoc = S.defaultDoc(library);
  phoneDoc.sessions = H.clone(all.slice(0, 2));
  phoneDoc.settings.default_length_min = 30;
  phoneDoc.equipment.fixed_pairs_lb = [10, 15, 20];
  await restart(phoneDoc);
  const phoneBefore = await readDoc();
  await goTab('settings');
  chooseFile(shared.text, shared.name);
  await waitFor(() => q('[data-import-summary]'), 'merge summary');
  const mergeSummary = q('[data-import-summary]').textContent;
  await tap('[data-action="import-merge"]', () => !q('[data-import-summary]') && noteEl() && /^Added/.test(noteEl().textContent), 'added');
  await idle();
  const addedNote = noteEl().textContent;
  const merged = await readDoc();
  const mergeProblems = [];
  if (J(merged.sessions.map((s) => s.id)) !== J(all.map((s) => s.id))) mergeProblems.push('ids ' + J(merged.sessions.map((s) => s.id)));
  if (diff(merged.sessions.slice(0, 2), phoneBefore.sessions)) mergeProblems.push('phone sessions changed');
  if (diff(merged.sessions, all)) mergeProblems.push('sessions ' + diff(merged.sessions, all));
  if (diff(merged.equipment, phoneBefore.equipment)) mergeProblems.push('equipment changed');
  if (diff(merged.settings, phoneBefore.settings)) mergeProblems.push('settings changed');
  if (!merged.current || merged.current.started_at || merged.current.id === phoneBefore.current.id ||
    merged.current.day_type !== E.nextDayType(merged.sessions, library) || violations(merged).length) {
    mergeProblems.push('current ' + J(merged.current && [merged.current.id, merged.current.day_type]) + ' violations ' + J(merged.current ? violations(merged) : []));
  }
  if (addedNote !== 'Added ' + (all.length - 2) + ' sessions') mergeProblems.push('note ' + J(addedNote));
  if (!/This phone has 2 sessions\.$/.test(mergeSummary)) mergeProblems.push('summary ' + J(mergeSummary));
  await reloadApp();
  const mergedAfter = await readDoc();
  if (diff(mergedAfter.sessions, all) || diff(mergedAfter.settings, phoneBefore.settings) || diff(mergedAfter.equipment, phoneBefore.equipment)) {
    mergeProblems.push('not kept after a reload');
  }
  check('import, Add missing sessions: adds only the missing ones in order, keeps this phone\'s equipment and settings, rebuilds the unstarted session, and survives a reload',
    mergeProblems.length === 0, mergeProblems.join('; '));
  info.merge = phoneBefore.sessions.length + ' on the phone, ' + addedNote;

  check('settings at 375 px: no horizontal overflow (' + lay.screens.length + ' views: ' + lay.screens.join(', ') + ')',
    lay.overflow.length === 0, lay.overflow.join(', '));
  check('settings at 375 px: no button or tab label wraps and every tap target is at least 44 px',
    lay.wrapped.length === 0 && lay.small.length === 0, lay.wrapped.concat(lay.small).slice(0, 6).join(', '));
  check('settings phase: no uncaught errors', appErrors.length === 0, appErrors.slice(0, 3).join(' | '));
}

// History phase (its own fresh profile): History and Progress empty states, then a history built
// with the real engine and flow.js (generate, log rounds, set efforts, complete) at controlled
// local dates over three calendar weeks, written through the storage API. Checks the History list
// and detail against sessionVolume and compareVolume, Progress against stats.js, and 375 px layout.
async function historyPhase(library) {
  const S = await import('../js/app/storage.js');
  const E = await import('../js/engine/index.js');
  const F = await import('../js/app/format.js');
  const FL = await import('../js/app/flow.js');
  const ST = await import('../js/app/stats.js');
  const { diff } = await import('./harness.js');
  const lay = { screens: [], overflow: [], wrapped: [], small: [], text: [], copy: [] };
  const currentTab = () => {
    const c = qa('#nav [aria-current="page"]');
    return c.length === 1 ? c[0].dataset.nav : c.length + ' marked';
  };
  const goTab = (name) => tap('#nav [data-nav="' + name + '"]', () => screenName() === name, 'tab ' + name);

  async function restart(doc) {
    await idle();
    W().__e2eOld = true;
    frame.src = 'about:blank';
    await waitFor(() => { const w = W(); return w && !w.__e2eOld && w.location.href === 'about:blank'; }, 'blank frame');
    await new Promise((resolve, reject) => {
      const r = indexedDB.deleteDatabase(S.DB_NAME);
      const t = setTimeout(() => reject(new Error('delete database timed out')), 10000);
      r.onsuccess = () => { clearTimeout(t); resolve(); };
      r.onerror = () => { clearTimeout(t); reject(r.error); };
    });
    const st = await S.openStorage(S.DB_NAME);
    await S.writeRaw(st.db, doc);
    st.close();
    await loadApp();
    await idle();
  }

  function labelLines(el) {
    const range = D().createRange();
    range.selectNodeContents(el);
    const tops = Array.from(range.getClientRects()).filter((x) => x.width > 0 && x.height > 0).map((x) => x.top).sort((a, b) => a - b);
    let lines = 0;
    let prev = -Infinity;
    tops.forEach((t) => { if (t - prev > 4) { lines += 1; prev = t; } });
    const cs = W().getComputedStyle(el);
    const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return { lines, over: Math.max(el.scrollWidth - el.clientWidth, range.getBoundingClientRect().width - room) };
  }

  // At 375 px: no horizontal overflow, button and tab labels on one line, targets at least 44 px,
  // chart text at least 11 px as rendered, and visible copy without em dashes, exclamation points, or emoji.
  async function fits(label, targetSel) {
    await atSize(375, 812, () => {
      lay.screens.push(label);
      const de = D().documentElement;
      const vw = de.clientWidth;
      let worst = de.scrollWidth - vw;
      qa('#app *').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right - vw > worst) worst = r.right - vw;
      });
      if (worst > 0.5) lay.overflow.push(label + ' +' + Math.round(worst) + 'px');
      qa('#nav a, #app button').forEach((el) => {
        if (!(el.getBoundingClientRect().width > 0)) return;
        const f = labelLines(el);
        if (f.lines > 1 || f.over > 0.5) lay.wrapped.push(label + ' "' + el.textContent.trim() + '" ' + (f.lines > 1 ? f.lines + ' lines' : '+' + Math.round(f.over) + 'px'));
      });
      qa('#nav a, #app button, ' + targetSel).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (!(r.width > 0)) return;
        if (r.height < 44 || r.width < 44) lay.small.push(label + ' "' + (el.textContent.trim().slice(0, 20) || el.tagName) + '" ' + Math.round(r.width) + 'x' + Math.round(r.height));
      });
      qa('#main svg.chart').forEach((svg) => {
        const vb = svg.viewBox.baseVal;
        const scale = svg.getBoundingClientRect().width / vb.width;
        svg.querySelectorAll('text').forEach((t) => {
          const px = Number(t.getAttribute('font-size')) * scale;
          if (!(px >= 11)) lay.text.push(label + ' "' + t.textContent + '" ' + px.toFixed(1) + 'px');
        });
        svg.querySelectorAll('circle').forEach((c) => { if (!(Number(c.getAttribute('r')) >= 3)) lay.text.push(label + ' point r ' + c.getAttribute('r')); });
      });
      const copy = (D().querySelector('#app').innerText || '') + ' ' + qa('#main [aria-label]').map((x) => x.getAttribute('aria-label')).join(' ');
      if (/[—–]|!|\p{Extended_Pictographic}/u.test(copy)) lay.copy.push(label + ': ' + (copy.match(/.{0,20}([—–]|!|\p{Extended_Pictographic}).{0,20}/u) || [''])[0]);
    });
  }

  // 1. Empty states on a fresh profile
  await loadApp();
  await idle();
  await goTab('history');
  const emptyHistory = root().textContent.indexOf('No workouts logged yet') >= 0 && qa('#main [data-history-row]').length === 0 && currentTab() === 'history';
  await fits('empty history', '[data-history-row]');
  await goTab('progress');
  const emptyProgress = root().textContent.indexOf('Log a workout to see progress') >= 0 && !q('#main [data-chart]') && currentTab() === 'progress';
  await fits('empty progress', '[data-field="progress-movement"]');
  check('history phase: on an empty profile History shows "No workouts logged yet" and Progress shows "Log a workout to see progress"',
    emptyHistory && emptyProgress, 'history ' + emptyHistory + ', progress ' + emptyProgress);

  // 2. Seed eight sessions with flow.js at local dates in the three weeks before this one
  const today = new Date();
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (today.getDay() + 6) % 7);
  const at = (week, day, hour, min) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7 * week + day, hour, min);
  const plan = [
    { end: at(-3, 0, 7, 0) }, { end: at(-3, 2, 7, 0) }, { end: at(-3, 4, 18, 0) },
    { end: at(-2, 1, 7, 0) }, { end: at(-2, 3, 7, 0) },
    { end: at(-1, 0, 0, 30) }, // started on Sunday night, completed after the Monday boundary
    { end: at(-1, 2, 7, 0), endAfterBlocks: 1 }, // ended early after Block A
    { end: at(-1, 6, 21, 0) },
  ];
  const seedDoc = S.defaultDoc(library);
  const seedProblems = [];
  plan.forEach((p, i) => {
    const endIso = p.end.toISOString();
    const startIso = new Date(p.end.getTime() - (p.endAfterBlocks ? 20 : 52) * 60000).toISOString();
    const r = FL.createSession({ library, doc: seedDoc, seed: 'e2e-history|' + i, now: startIso });
    if (r.violations.length) seedProblems.push('#' + i + ' ' + r.violations.map((v) => v.rule).join(','));
    let s = FL.finishWarmup(FL.startWorkout(r.session, startIso));
    let t = Date.parse(startIso);
    for (let guard = 0; s.progress && s.progress.phase !== 'finisher'; guard++) {
      if (guard > 400) throw new Error('seed session ' + i + ' did not finish');
      const pr = s.progress;
      if (pr.phase === 'round' && p.endAfterBlocks && FL.activeBlockIndexes(s).indexOf(pr.block) >= p.endAfterBlocks) {
        s = FL.endEarly(s, endIso);
        break;
      }
      if (pr.phase === 'round') {
        const e = FL.currentEntry(s);
        const b = s.blocks[pr.block];
        const it = b.items[pr.item];
        const shortBy = it.target.unit === 'reps' && pr.round === b.rounds - 1 && (i + pr.item) % 2 === 0 ? 1 : 0;
        const value = Math.max(1, e.value - shortBy + (it.target.unit === 'seconds' && pr.round === 0 ? 5 : 0));
        s = FL.setDraft(s, { value, weight: e.weight });
        t += 90000;
        s = FL.confirmRound(s, null, new Date(t).toISOString());
      } else if (pr.phase === 'rest') {
        s = FL.endRest(s);
      } else if (pr.phase === 'effort') {
        s.blocks[pr.block].items.forEach((_, ii) => { s = FL.setEffort(s, ii, EFFORTS[(i + ii + pr.block) % 3]); });
        s = FL.finishEffort(s, endIso);
      } else {
        s = FL.finishWarmup(s);
      }
    }
    if (s.progress && s.progress.phase === 'finisher') s = FL.finishFinisher(s, i % 3 !== 2, endIso);
    if (s.progress || s.completed_at !== endIso) seedProblems.push('#' + i + ' not completed at ' + endIso);
    seedDoc.sessions.push(s);
  });
  await restart(seedDoc);
  let doc = await readDoc();
  const sessions = doc.sessions;
  const ended = sessions.filter((s) => s.ended_early).length;
  const weeksSpanned = new Set(sessions.map((s) => ST.weekStart(s.completed_at).getTime())).size;
  check('history phase: eight sessions built with the engine and flow.js (generate, log rounds, set efforts, complete) over three calendar weeks load from storage',
    seedProblems.length === 0 && sessions.length === 8 && weeksSpanned === 3 && ended === 1 && !diff(sessions, seedDoc.sessions),
    seedProblems.join('; ') + ' sessions ' + sessions.length + ', weeks ' + weeksSpanned + ', ended early ' + ended);
  info.history = sessions.map((s) => s.day_type + ' ' + F.formatDate(s.completed_at) + ' ' + E.sessionVolume(s).volume_lb + ' lb' + (s.ended_early ? ' (ended early)' : '')).join(', ');

  // 3. History list: newest first, volume from sessionVolume, facts per row
  await goTab('history');
  const newest = sessions.slice().reverse();
  const rows = qa('#main [data-history-row]');
  const listProblems = [];
  if (J(rows.map((r) => r.dataset.sessionId)) !== J(newest.map((s) => s.id))) listProblems.push('order ' + J(rows.map((r) => r.dataset.sessionId)));
  rows.forEach((row, i) => {
    const s = newest[i];
    if (!s) return;
    const vol = E.sessionVolume(s).volume_lb;
    const text = row.textContent;
    if (Number(row.dataset.volumeLb) !== vol) listProblems.push(s.id + ' volume ' + row.dataset.volumeLb + ' != ' + vol);
    const want = [F.formatDate(s.completed_at), F.dayLabel(s.day_type), F.formatNumber(vol) + ' lb',
      F.formatDuration((Date.parse(s.completed_at) - Date.parse(s.started_at)) / 1000), s.finisher ? 'Finisher ' + (s.finisher.done ? 'done' : 'skipped') : ''];
    want.forEach((w) => { if (w && text.indexOf(w) < 0) listProblems.push(s.id + ' missing "' + w + '"'); });
    if ((text.indexOf('Ended early') >= 0) !== !!s.ended_early) listProblems.push(s.id + ' ended early tag');
    if (row.getAttribute('href') !== '#/history/' + encodeURIComponent(s.id)) listProblems.push(s.id + ' href ' + row.getAttribute('href'));
  });
  await fits('history list', '[data-history-row]');
  check('history: lists all ' + sessions.length + ' sessions newest first, each row with date, day type, duration, volume equal to sessionVolume, finisher, and the Ended early tag when set',
    rows.length === sessions.length && listProblems.length === 0, 'rows ' + rows.length + '; ' + listProblems.slice(0, 5).join('; '));

  // 4. Detail of a middle session, Back, deep link, and an unknown id
  const mid = newest[Math.floor(newest.length / 2)];
  const midIndex = sessions.findIndex((s) => s.id === mid.id);
  await tap('#main [data-history-row][data-session-id="' + mid.id + '"]',
    () => screenName() === 'history-detail' && root().dataset.sessionId === mid.id, 'history detail');
  const detailProblems = [];
  if (W().location.hash !== '#/history/' + encodeURIComponent(mid.id)) detailProblems.push('hash ' + W().location.hash);
  if (currentTab() !== 'history' || !q('#nav')) detailProblems.push('tabs ' + currentTab());
  if (Number(root().dataset.volumeLb) !== E.sessionVolume(mid).volume_lb) detailProblems.push('volume ' + root().dataset.volumeLb);
  const cmpText = F.comparisonText(E.compareVolume(mid, sessions.slice(0, midIndex)), mid.day_type);
  if (!q('#main .compare') || q('#main .compare').textContent !== cmpText) detailProblems.push('compare "' + (q('#main .compare') || {}).textContent + '" != "' + cmpText + '"');
  const activeItems = mid.blocks.filter((b) => b.rounds > 0 && !b.removed).flatMap((b) => b.items);
  const shownItems = qa('#main [data-history-item]');
  if (J(shownItems.map((x) => x.dataset.movementId)) !== J(activeItems.map((it) => it.movement_id))) detailProblems.push('movements ' + J(shownItems.map((x) => x.dataset.movementId)));
  let chipCount = 0;
  shownItems.forEach((el, k) => {
    const it = activeItems[k];
    if (!it) return;
    const name = (library.movements.find((m) => m.id === it.movement_id) || {}).name;
    if (el.textContent.indexOf(name) < 0) detailProblems.push(it.movement_id + ' name');
    const chips = Array.from(el.querySelectorAll('[data-logged-round]'));
    chipCount += chips.length;
    const want = (it.logged.rounds || []).map((r) => F.chipText(r, it.target.unit));
    if (J(chips.map((c) => c.textContent)) !== J(want)) detailProblems.push(it.movement_id + ' chips ' + J(chips.map((c) => c.textContent)) + ' != ' + J(want));
    if (el.querySelector('[data-effort]').textContent !== F.effortLabel(it.logged.effort)) detailProblems.push(it.movement_id + ' effort');
  });
  const blockVols = qa('#main [data-block-volume]').map((x) => Number(x.dataset.blockVolume));
  const wantBlocks = E.sessionVolume(mid).blocks.filter((b) => b.rounds > 0).map((b) => b.volume_lb);
  if (J(blockVols) !== J(wantBlocks)) detailProblems.push('block volumes ' + J(blockVols));
  if (!q('#main [data-notes]')) detailProblems.push('notes');
  await fits('history detail', '[data-history-row]');
  await tap('#bar [data-action="history-back"]', () => screenName() === 'history', 'Back to the list');
  const backOk = W().location.hash === '#/history' && qa('#main [data-history-row]').length === sessions.length;
  W().location.hash = '#/history/' + encodeURIComponent(sessions[0].id);
  await waitFor(() => screenName() === 'history-detail' && root().dataset.sessionId === sessions[0].id, 'deep link to the oldest session');
  const firstCmp = q('#main .compare').textContent === F.comparisonText(null, sessions[0].day_type);
  W().location.hash = '#/history/no-such-session';
  await waitFor(() => screenName() === 'history' && W().location.hash === '#/history', 'unknown id falls back to the list');
  const fallbackOk = qa('#main [data-history-row]').length === sessions.length && currentTab() === 'history';
  check('history detail: a middle session shows its movements, logged chips, efforts, block volumes, and the comparison with only earlier sessions; Back returns to the list; an unknown id falls back to the list',
    detailProblems.length === 0 && chipCount > 0 && backOk && firstCmp && fallbackOk,
    detailProblems.slice(0, 5).join('; ') + ' chips ' + chipCount + ', back ' + backOk + ', first compare ' + firstCmp + ', fallback ' + fallbackOk);
  info.historyDetail = F.dayLabel(mid.day_type) + ' ' + F.formatDate(mid.completed_at) + ': ' + shownItems.length + ' movements, ' + chipCount + ' chips, "' + cmpText + '"';

  // 5. Progress against stats.js
  await goTab('progress');
  const nowDate = new Date();
  const weeks = ST.weeklyCounts(sessions, nowDate);
  const bars = qa('#main [data-chart="weekly"] [data-week-start]').map((b) => ({ week_start: b.dataset.weekStart, count: Number(b.dataset.count) }));
  const weeklyOk = !diff(bars, weeks) && J(weeks.map((w) => w.count)) === J([0, 0, 0, 0, 3, 2, 3, 0]) &&
    q('#main [data-section="weekly"] .chart-headline').textContent === '0 of 3 this week' &&
    !!q('#main [data-chart="weekly"] .chart-goal') && qa('#main [data-chart="weekly"] text').some((x) => x.textContent === 'Goal 3');
  check('progress: the weekly bars equal weeklyCounts (8 weeks: ' + weeks.map((w) => w.count).join(', ') + ') with the headline and the Goal 3 line',
    weeklyOk, 'bars ' + J(bars.map((b) => b.count)) + ' vs ' + J(weeks.map((w) => w.count)) + (diff(bars, weeks) ? ' ' + diff(bars, weeks) : ''));

  const byType = ST.volumeByDayType(sessions);
  const volProblems = [];
  ['push', 'hinge', 'pull'].forEach((dt) => {
    const el = q('#main [data-chart="volume"][data-day-type="' + dt + '"]');
    const all = sessions.filter((s) => s.day_type === dt);
    const want = all.slice(-12).map((s) => E.sessionVolume(s).volume_lb);
    const got = el ? Array.from(el.querySelectorAll('[data-volume-lb]')).map((p) => Number(p.dataset.volumeLb)) : null;
    if (!el || J(got) !== J(want) || J(byType[dt].slice(-12).map((v) => v.volume_lb)) !== J(want)) volProblems.push(dt + ' ' + J(got) + ' != ' + J(want));
    const latest = want[want.length - 1];
    const big = el && el.querySelector('.chart-big');
    if (!big || big.textContent !== F.formatNumber(latest) + ' lb') volProblems.push(dt + ' headline ' + (big && big.textContent));
    const change = el && el.querySelector('.chart-change');
    if (want.length > 1) {
      const d = latest - want[want.length - 2];
      if (!change || change.textContent.indexOf((d > 0 ? '+' : '') + F.formatNumber(d) + ' lb') !== 0) volProblems.push(dt + ' change ' + (change && change.textContent));
    }
  });
  check('progress: Push, Hinge, and Pull volume charts have one point per session of that day type, equal to sessionVolume, with the latest volume and the change',
    volProblems.length === 0, volProblems.join('; '));

  const moves = ST.movementsWithHistory(sessions, library);
  const select = () => q('#main [data-field="progress-movement"]');
  const options = Array.from(select().options).map((o) => o.value);
  const optionNames = Array.from(select().options).map((o) => o.textContent);

  function movementProblems(id) {
    const bad = [];
    const hist = ST.movementHistory(sessions, id);
    const recent = hist.slice(-12);
    const detail = q('#main .movement-detail');
    if (!detail || detail.dataset.movementId !== id || select().value !== id) bad.push('shown ' + (detail && detail.dataset.movementId) + ' select ' + select().value);
    const weighted = recent.filter((e) => e.weight_lb_per_dumbbell != null);
    const wChart = q('#main [data-chart="movement-weight"]');
    if (weighted.length) {
      const got = wChart ? Array.from(wChart.querySelectorAll('circle[data-value]')).map((c) => Number(c.dataset.value)) : null;
      if (J(got) !== J(weighted.map((e) => e.weight_lb_per_dumbbell))) bad.push('weights ' + J(got));
    } else if (wChart) bad.push('weight chart on a bodyweight movement');
    const vChart = q('#main [data-chart="movement-value"]');
    const vals = vChart ? Array.from(vChart.querySelectorAll('circle[data-value]')).map((c) => Number(c.dataset.value)) : null;
    if (J(vals) !== J(recent.map((e) => e.best_value))) bad.push('best values ' + J(vals));
    const entries = qa('#main [data-movement-entry]');
    const wantEntries = hist.slice(-6).reverse();
    if (J(entries.map((x) => x.dataset.sessionId)) !== J(wantEntries.map((e) => e.session_id))) bad.push('entries ' + entries.length);
    entries.forEach((x, k) => {
      const e = wantEntries[k];
      if (!e) return;
      [F.formatDate(e.date), F.formatLoad(e.load), e.values.map(F.formatNumber).join(', '), F.effortLabel(e.effort)].forEach((w) => {
        if (x.textContent.indexOf(w) < 0) bad.push('entry ' + k + ' missing "' + w + '"');
      });
    });
    return { bad, hist, weighted: weighted.length };
  }

  const first = movementProblems(moves[0].movement_id);
  const histOf = (m) => ST.movementHistory(sessions, m.movement_id);
  const bodyweight = moves.slice(1).find((m) => histOf(m).every((e) => e.weight_lb_per_dumbbell == null));
  const weighted = moves.slice(1).find((m) => histOf(m).length > 1 && histOf(m).some((e) => e.weight_lb_per_dumbbell != null));
  const picks = [bodyweight, weighted].filter((m) => m && m.movement_id !== moves[0].movement_id);
  const pickProblems = [];
  for (const m of picks) {
    const sel = select();
    sel.value = m.movement_id;
    sel.dispatchEvent(new (W().Event)('input', { bubbles: true }));
    await waitFor(() => q('#main .movement-detail') && q('#main .movement-detail').dataset.movementId === m.movement_id, 'movement ' + m.movement_id);
    const r = movementProblems(m.movement_id);
    r.bad.forEach((b) => pickProblems.push(m.movement_id + ': ' + b));
    await fits('progress ' + m.movement_id, '[data-field="progress-movement"]');
  }
  const lastPick = picks.length ? picks[picks.length - 1].movement_id : moves[0].movement_id;
  await goTab('history');
  await goTab('progress');
  const kept = select().value === lastPick;
  await reloadApp();
  await goTab('progress');
  const resetAfterReload = select().value === moves[0].movement_id;
  check('progress: the movement select lists exactly movementsWithHistory (' + moves.length + ', most recent first) and defaults to the most recent',
    J(options) === J(moves.map((m) => m.movement_id)) && J(optionNames) === J(moves.map((m) => m.name)) && first.bad.length === 0,
    'options ' + J(options.slice(0, 5)) + ' vs ' + J(moves.slice(0, 5).map((m) => m.movement_id)) + '; ' + first.bad.join('; '));
  check('progress: choosing another movement (bodyweight and weighted) changes the charts and the last 6 entries to match movementHistory; the choice is memory only',
    picks.length === 2 && pickProblems.length === 0 && kept && resetAfterReload,
    'picks ' + picks.length + '; ' + pickProblems.slice(0, 5).join('; ') + ' kept ' + kept + ', reset after reload ' + resetAfterReload);
  info.progress = 'weeks ' + weeks.map((w) => w.count).join(',') + '; movements ' + moves.length + ', default ' + moves[0].name +
    '; picked ' + picks.map((m) => m.name + ' (' + histOf(m).length + ' entries)').join(', ');

  // 6. 375 px layout on everything above
  await fits('progress', '[data-field="progress-movement"]');
  check('history and progress at 375 px: no horizontal overflow (' + lay.screens.length + ' views: ' + lay.screens.join(', ') + ')',
    lay.overflow.length === 0, lay.overflow.join(', '));
  check('history and progress at 375 px: no button or tab label wraps; rows, the select, Back, and the tabs are at least 44 px; chart text at least 11 px',
    lay.wrapped.length === 0 && lay.small.length === 0 && lay.text.length === 0, lay.wrapped.concat(lay.small, lay.text).slice(0, 6).join(', '));
  check('history and progress copy: no em dashes, exclamation points, or emoji in visible text and chart labels',
    lay.copy.length === 0, lay.copy.slice(0, 3).join(' | '));
  check('history phase: no uncaught errors', appErrors.length === 0, appErrors.slice(0, 3).join(' | '));
}

async function main() {
  let expectOut = null;
  try {
    const library = await (await fetch('../data/library.json', { cache: 'no-store' })).json();
    if (PHASE_NAME === 'swap') await swapPhase(library);
    else if (PHASE_NAME === 'settings') await settingsPhase(library);
    else if (PHASE_NAME === 'history') await historyPhase(library);
    else if (PHASE === 1) expectOut = await phase1(library);
    else await phase2();
  } catch (e) {
    check('phase ' + (PHASE_NAME || PHASE) + ' driver', false, String((e && e.stack) || e));
  }
  await window.__postResults({ phase: PHASE, results, info, expect: expectOut });
}

main();
