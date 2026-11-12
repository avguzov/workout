// Settings: equipment (switches and the adjustable top-weight stepper; every change is probed
// against the engine first), default length, the swap switch, and backup export and import.
//
// Pure helpers (exported for tests): equipmentControls, readEquipment, applyEquipmentChange,
// singleChanges, dayTypes, probeEquipment, unfilledSlots, probeMessage, importSummaryText, listText.

import { h, button } from '../dom.js';
import * as F from '../format.js';
import { createSession, changeLength, isStarted } from '../flow.js';
import { generateSession, validateSession, isEligible, ALLOWED_LENGTHS } from '../../engine/index.js';
import { buildBackup, backupFileName, parseBackup, applyReplace, applyMerge } from '../backup.js';

const EPS = 1e-6;
export const PROBE_SEEDS = 5;
const NEXT_SESSION = 'Applies from your next session';

const LABELS = {
  'adjustable.present': 'Adjustable dumbbells',
  'adjustable.max_lb': 'Top weight',
  'bench.present': 'Bench',
  'bench.incline': 'Bench inclines',
  pull_up_bar: 'Pull-up bar',
  bands: 'Bands',
};

function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNum(v) {
  return typeof v === 'number' && isFinite(v);
}

function roundW(v) {
  return Math.round(v * 1000) / 1000;
}

function humanize(key) {
  const s = String(key).replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function labelFor(key) {
  return LABELS[key] || humanize(key.split('.').pop());
}

// "a", "a and b", "a, b, and c"
export function listText(items, conj) {
  const c = conj || 'and';
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return items[0] + ' ' + c + ' ' + items[1];
  return items.slice(0, -1).join(', ') + ', ' + c + ' ' + items[items.length - 1];
}

function count(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

// ------------------------------------------------------------------ equipment model

function splitKey(key) {
  const i = key.indexOf('.');
  return i < 0 ? [key, null] : [key.slice(0, i), key.slice(i + 1)];
}

function hasPair(equipment, w) {
  return (equipment.fixed_pairs_lb || []).some((x) => Math.abs(x - w) < EPS);
}

// Top-weight steps: min_lb up to the larger of the library's top and the stored top, in step_lb.
function maxOptions(library, adjustable) {
  const base = (library.default_equipment && library.default_equipment.adjustable) || {};
  const min = isNum(adjustable.min_lb) ? adjustable.min_lb : base.min_lb;
  const step = isNum(adjustable.step_lb) && adjustable.step_lb > 0 ? adjustable.step_lb : base.step_lb;
  const top = Math.max(isNum(base.max_lb) ? base.max_lb : 0, isNum(adjustable.max_lb) ? adjustable.max_lb : 0);
  const out = [];
  if (!isNum(min) || !isNum(step) || !(step > 0)) return out;
  for (let i = 0; i < 1000; i++) {
    const w = roundW(min + i * step);
    if (w > top + EPS) break;
    out.push(w);
  }
  return out;
}

function fixedPairOptions(library, equipment) {
  const all = ((library.default_equipment && library.default_equipment.fixed_pairs_lb) || [])
    .concat(equipment.fixed_pairs_lb || []).filter(isNum).map(roundW).sort((a, b) => a - b);
  return all.filter((w, i) => i === 0 || Math.abs(all[i - 1] - w) >= EPS);
}

// The controls Settings shows, in the order of the equipment fields:
// { key, kind: 'switch'|'stepper', label, value, disabled, options? }
export function equipmentControls(library, equipment) {
  const eq = equipment || {};
  const out = [];
  Object.keys(eq).forEach((k) => {
    const v = eq[k];
    if (k === 'adjustable' && isObj(v)) {
      out.push({ key: 'adjustable.present', kind: 'switch', label: labelFor('adjustable.present'), value: !!v.present, disabled: false });
      out.push({
        key: 'adjustable.max_lb', kind: 'stepper', label: labelFor('adjustable.max_lb'), value: v.max_lb,
        options: maxOptions(library, v), disabled: !v.present,
      });
    } else if (k === 'fixed_pairs_lb' && Array.isArray(v)) {
      fixedPairOptions(library, eq).forEach((w) => out.push({
        key: 'fixed_pairs_lb.' + w, kind: 'switch', label: F.formatWeight(w) + ' pair', value: hasPair(eq, w), disabled: false, pair: w,
      }));
    } else if (typeof v === 'boolean') {
      out.push({ key: k, kind: 'switch', label: labelFor(k), value: v, disabled: false });
    } else if (isObj(v) && typeof v.present === 'boolean') {
      out.push({ key: k + '.present', kind: 'switch', label: labelFor(k + '.present'), value: v.present, disabled: false });
      Object.keys(v).forEach((sub) => {
        if (sub === 'present' || typeof v[sub] !== 'boolean') return;
        const key = k + '.' + sub;
        out.push({ key, kind: 'switch', label: labelFor(key), value: v[sub], disabled: !v.present });
      });
    }
  });
  return out;
}

export function readEquipment(equipment, key) {
  const [head, sub] = splitKey(key);
  if (head === 'fixed_pairs_lb') return hasPair(equipment, Number(sub));
  if (sub != null) return equipment[head] ? equipment[head][sub] : undefined;
  return equipment[head];
}

// -> a new equipment profile with one field changed; the input is untouched.
export function applyEquipmentChange(equipment, key, value) {
  const eq = clone(equipment);
  const [head, sub] = splitKey(key);
  if (head === 'fixed_pairs_lb') {
    const w = Number(sub);
    const list = (eq.fixed_pairs_lb || []).filter((x) => Math.abs(x - w) >= EPS);
    if (value) list.push(w);
    eq.fixed_pairs_lb = list.sort((a, b) => a - b);
  } else if (sub != null) {
    eq[head] = Object.assign({}, eq[head], { [sub]: value });
  } else {
    eq[head] = value;
  }
  return eq;
}

function stepFrom(control, dir) {
  const opts = control.options || [];
  if (dir < 0) {
    for (let i = opts.length - 1; i >= 0; i--) if (opts[i] < control.value - EPS) return opts[i];
  } else {
    for (let i = 0; i < opts.length; i++) if (opts[i] > control.value + EPS) return opts[i];
  }
  return null;
}

// Every change one tap can make from this profile: each enabled switch flipped, the stepper one
// step down and one step up where possible. -> [{ key, value }]
export function singleChanges(library, equipment) {
  const out = [];
  equipmentControls(library, equipment).forEach((c) => {
    if (c.disabled) return;
    if (c.kind === 'switch') out.push({ key: c.key, value: !c.value });
    else {
      [-1, 1].forEach((dir) => {
        const w = stepFrom(c, dir);
        if (w != null) out.push({ key: c.key, value: w });
      });
    }
  });
  return out;
}

// ------------------------------------------------------------------ guard

export function dayTypes(library) {
  const out = [];
  library.slot_templates.forEach((t) => { if (out.indexOf(t.day_type) < 0) out.push(t.day_type); });
  return out;
}

// Can the engine still build every day type under `equipment` with this history? Generates and
// validates PROBE_SEEDS sessions per day type (dayType forced, so the day-order rule is skipped).
// A day type stops at its first failure. -> { ok, runs, failures: [{ dayType, seed, error? , violations? }] }
export function probeEquipment({ library, equipment, sessions, lengthMin, autoPickSwaps, now, seeds }) {
  const n = seeds || PROBE_SEEDS;
  const history = sessions || [];
  const failures = [];
  let runs = 0;
  dayTypes(library).forEach((dayType) => {
    for (let i = 0; i < n; i++) {
      runs += 1;
      let problem = null;
      try {
        const session = generateSession({
          library, equipment, sessions: history, lengthMin, seed: 'probe|' + dayType + '|' + i, now, dayType,
          autoPickSwaps: autoPickSwaps !== false,
        });
        const v = validateSession({ library, equipment, sessions: history, session })
          .filter((x) => x.rule !== 'day_type_order');
        if (v.length) problem = { violations: v };
      } catch (e) {
        problem = { error: String((e && e.message) || e) };
      }
      if (problem) {
        failures.push(Object.assign({ dayType, seed: i }, problem));
        break;
      }
    }
  });
  return { ok: failures.length === 0, runs, failures };
}

function roleLabel(library, id) {
  const r = (library.roles || []).find((x) => x.id === id);
  return r ? r.label : humanize(id);
}

// Template slots of this day type that no movement can fill under `equipment`, as role labels.
export function unfilledSlots(library, equipment, dayType) {
  const out = [];
  library.slot_templates.filter((t) => t.day_type === dayType).forEach((t) => t.blocks.forEach((b) => b.slots.forEach((slot) => {
    if (library.movements.some((m) => isEligible(m, slot.roles, equipment))) return;
    const label = listText(slot.roles.map((r) => roleLabel(library, r)), 'or');
    if (out.indexOf(label) < 0) out.push(label);
  })));
  return out;
}

// Short reason for a rejected change: up to three slot names (then a count), and the day types.
export function probeMessage(library, equipment, probe) {
  if (probe.ok) return '';
  const labels = [];
  const slotDays = [];
  const otherDays = [];
  probe.failures.forEach((f) => {
    const day = F.dayLabel(f.dayType).toLowerCase();
    const slots = unfilledSlots(library, equipment, f.dayType);
    if (!slots.length) {
      otherDays.push(day);
      return;
    }
    slotDays.push(day);
    slots.forEach((s) => { if (labels.indexOf(s) < 0) labels.push(s); });
  });
  let text = 'Not changed.';
  if (labels.length) {
    const named = labels.length <= 3 ? labels : labels.slice(0, 2).concat([(labels.length - 2) + ' other slots']);
    text += ' With that change nothing can fill ' + listText(named) + ' on ' + listText(slotDays) + ' days.';
  }
  if (otherDays.length) text += ' With that change the app cannot build a full ' + listText(otherDays, 'or') + ' day.';
  return text;
}

// ------------------------------------------------------------------ backup text

export function importSummaryText(summary, have) {
  let t = (summary.exported_at ? 'Backup from ' + F.formatDate(summary.exported_at) : 'Backup') + ': ' +
    count(summary.sessions, 'session');
  if (summary.sessions) t += ' (' + F.formatDate(summary.first_date) + ' to ' + F.formatDate(summary.last_date) + ')';
  return t + '. This phone has ' + count(have, 'session') + '.';
}

// ------------------------------------------------------------------ render

function note(ctx, section) {
  const n = ctx.ui.settingsNote;
  if (!n || n.section !== section) return null;
  return h('p', { class: 'set-note' + (n.kind === 'error' ? ' error' : ''), role: 'status', data: { settingsNote: n.kind } }, n.text);
}

function domId(key) {
  return 'set-' + String(key).replace(/[^A-Za-z0-9]/g, '-');
}

function switchRow(key, label, on, attrs) {
  const id = domId(key);
  return h('div', { class: 'set-row' },
    h('span', { class: 'set-text', id }, label),
    h('button', Object.assign({
      type: 'button', class: 'switch', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-labelledby': id,
    }, attrs)));
}

function controlRow(c) {
  if (c.kind === 'switch') {
    return switchRow(c.key, c.label, c.value, {
      disabled: c.disabled, data: { action: 'equipment-toggle', equipment: c.key, on: c.value ? '1' : '0' },
    });
  }
  const id = domId(c.key);
  return h('div', { class: 'set-row' },
    h('span', { class: 'set-text', id }, c.label),
    h('div', { class: 'mini-stepper', role: 'group', 'aria-labelledby': id, data: { equipment: c.key, value: c.value } },
      button('-', 'equipment-down', null, { class: 'btn', 'aria-label': 'Lower', disabled: c.disabled || stepFrom(c, -1) == null }),
      h('span', { class: 'num' }, F.formatWeight(c.value)),
      button('+', 'equipment-up', null, { class: 'btn', 'aria-label': 'Higher', disabled: c.disabled || stepFrom(c, 1) == null })));
}

function importConfirm(ctx, pend) {
  return h('div', { class: 'confirm', role: 'alertdialog', 'aria-label': 'Import backup', data: { importConfirm: '' } },
    h('p', { data: { importSummary: '' } }, importSummaryText(pend.summary, ctx.doc.sessions.length)),
    h('div', { class: 'confirm-stack' },
      button('Replace everything', 'import-replace', null, { class: 'btn primary danger' }),
      button('Add missing sessions', 'import-merge', null, { class: 'btn' }),
      button('Cancel', 'import-cancel', null, { class: 'btn ghost' })));
}

export function render(ctx) {
  const doc = ctx.doc;
  const settings = doc.settings || {};
  const swaps = settings.auto_pick_swaps !== false;
  const last = settings.last_export_at || null;
  const pend = ctx.ui.backupImport;
  const main = h('div', {
    class: 'screen settings',
    data: {
      screen: 'settings', started: isStarted(doc.current) ? '1' : '0', lengthMin: settings.default_length_min,
      autoPickSwaps: swaps ? '1' : '0',
    },
  },
    h('header', { class: 'screen-head' }, h('h1', null, 'Settings')),
    h('section', { class: 'card set-card', data: { section: 'equipment' } },
      h('h2', null, 'Equipment'),
      h('p', { class: 'meta' }, 'Sessions use only what is switched on.'),
      equipmentControls(ctx.library, doc.equipment).map(controlRow),
      note(ctx, 'equipment')),
    h('section', { class: 'card set-card', data: { section: 'length' } },
      h('h2', null, 'Default length'),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Default length' },
        ALLOWED_LENGTHS.map((m) => button(m + ' min', 'default-length', { length: m },
          { class: 'btn seg-btn', 'aria-pressed': settings.default_length_min === m ? 'true' : 'false' }))),
      note(ctx, 'length')),
    h('section', { class: 'card set-card', data: { section: 'swaps' } },
      switchRow('auto_pick_swaps', 'Include swap movements in automatic picks', swaps,
        { data: { action: 'swaps-toggle', setting: 'auto_pick_swaps' } }),
      note(ctx, 'swaps')),
    h('section', { class: 'card set-card', data: { section: 'backup' } },
      h('h2', null, 'Backup'),
      h('p', { class: 'meta', data: { lastExport: last || '' } }, last ? 'Last backup: ' + F.formatDate(last) : 'No backup yet'),
      h('div', { class: 'backup-actions' },
        button('Export backup', 'export-backup', null, { class: 'btn' }),
        button('Import backup', 'import-backup', null, { class: 'btn' })),
      h('input', {
        type: 'file', accept: '.json,application/json', class: 'file-input', tabindex: '-1', 'aria-hidden': 'true',
        data: { backupFile: '' },
      }),
      note(ctx, 'backup')));
  return { main, bar: pend ? importConfirm(ctx, pend) : null };
}

export function mounted(ctx, root) {
  const input = root.querySelector('[data-backup-file]');
  if (input) input.addEventListener('change', () => readImport(ctx, input));
}

// ------------------------------------------------------------------ actions

function setNote(ctx, section, kind, text) {
  ctx.ui.settingsNote = { section, kind, text };
}

function newSeed() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0];
}

// A new unstarted session for `doc`, made the way Today makes one (createSession, random seed).
// Null when no try passes the rules; Today then builds one or shows its own error.
function freshSession(ctx, doc) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = createSession({ library: ctx.library, doc, seed: newSeed(), now: ctx.now() });
      if (!r.violations.length) return r.session;
    } catch (e) {
      // try another seed
    }
  }
  return null;
}

// After equipment or swap changes: rebuild an unstarted session, leave a started one alone.
function replan(ctx, d, section) {
  ctx.ui.genError = null;
  if (!d.current) return;
  if (isStarted(d.current)) {
    setNote(ctx, section, 'info', NEXT_SESSION);
    return;
  }
  d.current = freshSession(ctx, d);
}

function changeEquipment(ctx, key, value) {
  ctx.ui.settingsNote = null;
  const doc = ctx.doc;
  const next = applyEquipmentChange(doc.equipment, key, value);
  const probe = probeEquipment({
    library: ctx.library, equipment: next, sessions: doc.sessions, lengthMin: doc.settings.default_length_min,
    autoPickSwaps: doc.settings.auto_pick_swaps !== false, now: ctx.now(),
  });
  if (!probe.ok) {
    setNote(ctx, 'equipment', 'error', probeMessage(ctx.library, next, probe));
    ctx.render();
    return;
  }
  ctx.commit((d) => {
    d.equipment = next;
    replan(ctx, d, 'equipment');
  });
}

function stepEquipment(ctx, el, dir) {
  const group = el.closest('[data-equipment]');
  if (!group) return;
  const c = equipmentControls(ctx.library, ctx.doc.equipment).find((x) => x.key === group.dataset.equipment);
  const w = c ? stepFrom(c, dir) : null;
  if (w != null) changeEquipment(ctx, c.key, w);
}

// Share sheet when the browser can share this file (iPhone), else a download link.
// -> true when delivered, false when the share was cancelled.
async function deliverFile(text, name) {
  const type = 'application/json';
  let file = null;
  try {
    file = new File([text], name, { type });
  } catch (e) {
    file = null;
  }
  let canShare = false;
  try {
    canShare = !!(file && typeof navigator.share === 'function' && typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [file] }));
  } catch (e) {
    canShare = false;
  }
  if (canShare) {
    try {
      await navigator.share({ files: [file] });
      return true;
    } catch (e) {
      if (e && e.name === 'AbortError') return false;
      // any other share failure falls through to the download
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.hidden = true;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}

async function exportBackup(ctx) {
  ctx.ui.settingsNote = null;
  const now = ctx.now();
  const text = JSON.stringify(buildBackup(ctx.doc, now));
  let delivered = false;
  try {
    delivered = await deliverFile(text, backupFileName(now));
  } catch (e) {
    setNote(ctx, 'backup', 'error', 'Could not export the backup. ' + String((e && e.message) || e));
    ctx.render();
    return;
  }
  if (!delivered) {
    ctx.render();
    return;
  }
  setNote(ctx, 'backup', 'info', 'Backup exported');
  ctx.commit((d) => { d.settings.last_export_at = now; });
}

async function readImport(ctx, input) {
  const file = input.files && input.files[0];
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch (e) {
    text = null;
  }
  if (document.documentElement.dataset.screen !== 'settings') return;
  ctx.ui.settingsNote = null;
  ctx.ui.backupImport = null;
  const r = text == null ? { ok: false, error: 'Could not read that file.' } : parseBackup(text, ctx.library);
  if (!r.ok) setNote(ctx, 'backup', 'error', r.error);
  else ctx.ui.backupImport = r;
  ctx.render();
}

function replaceDoc(d, next) {
  Object.keys(d).forEach((k) => { delete d[k]; });
  Object.assign(d, next);
}

export const actions = {
  'equipment-toggle'(ctx, data, el) {
    const key = el.dataset.equipment;
    changeEquipment(ctx, key, !readEquipment(ctx.doc.equipment, key));
  },
  'equipment-down'(ctx, data, el) { stepEquipment(ctx, el, -1); },
  'equipment-up'(ctx, data, el) { stepEquipment(ctx, el, 1); },
  'default-length'(ctx, data) {
    ctx.ui.settingsNote = null;
    const lengthMin = Number(data.length);
    if (ALLOWED_LENGTHS.indexOf(lengthMin) < 0) return;
    ctx.commit((d) => {
      d.settings.default_length_min = lengthMin;
      const c = d.current;
      if (!c) return;
      if (isStarted(c)) {
        setNote(ctx, 'length', 'info', NEXT_SESSION);
        return;
      }
      if (c.length_min === lengthMin) return;
      try {
        const r = changeLength({ library: ctx.library, doc: d, lengthMin });
        if (!r.violations.length) {
          d.current = r.session;
          return;
        }
      } catch (e) {
        // keep the session as it is
      }
      setNote(ctx, 'length', 'error', 'The next session keeps its length because ' + lengthMin +
        ' min breaks the session rules. Sessions after it use ' + lengthMin + ' min.');
    });
  },
  'swaps-toggle'(ctx) {
    ctx.ui.settingsNote = null;
    const on = ctx.doc.settings.auto_pick_swaps === false;
    ctx.commit((d) => {
      d.settings.auto_pick_swaps = on;
      replan(ctx, d, 'swaps');
    });
  },
  'export-backup'(ctx) {
    return exportBackup(ctx);
  },
  'import-backup'(ctx) {
    if (ctx.ui.settingsNote) {
      ctx.ui.settingsNote = null;
      ctx.render();
    }
    const input = document.querySelector('[data-backup-file]');
    if (input) input.click();
  },
  'import-replace'(ctx) {
    const pend = ctx.ui.backupImport;
    if (!pend) return;
    ctx.ui.backupImport = null;
    ctx.ui.genError = null;
    const next = applyReplace(ctx.doc, pend.doc);
    setNote(ctx, 'backup', 'info', 'Restored ' + count(next.sessions.length, 'session'));
    ctx.commit((d) => replaceDoc(d, next));
  },
  'import-merge'(ctx) {
    const pend = ctx.ui.backupImport;
    if (!pend) return;
    ctx.ui.backupImport = null;
    ctx.ui.genError = null;
    const next = applyMerge(ctx.doc, pend.doc);
    const added = next.sessions.length - ctx.doc.sessions.length;
    if (added > 0 && next.current && !isStarted(next.current)) next.current = freshSession(ctx, next);
    setNote(ctx, 'backup', 'info', 'Added ' + count(added, 'session'));
    ctx.commit((d) => replaceDoc(d, next));
  },
  'import-cancel'(ctx) {
    ctx.ui.backupImport = null;
    ctx.render();
  },
};
