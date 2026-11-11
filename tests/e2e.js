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

async function main() {
  let expectOut = null;
  try {
    const library = await (await fetch('../data/library.json', { cache: 'no-store' })).json();
    if (PHASE === 1) expectOut = await phase1(library);
    else await phase2();
  } catch (e) {
    check('phase ' + PHASE + ' driver', false, String((e && e.stack) || e));
  }
  await window.__postResults({ phase: PHASE, results, info, expect: expectOut });
}

main();
