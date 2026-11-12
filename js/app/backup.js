// Backup file: build, parse, and apply. Pure functions, no DOM, storage, or clock; the caller
// passes `now`. Delivery (share sheet or download) and the file input live in screens/settings.js.
//
// File: { app: "dumbbell-app", kind: "backup", exported_at, schema_version, doc }
// named dumbbell-backup-YYYY-MM-DD.json (local date of the export).

import { migrate, SCHEMA_VERSION, DEFAULT_LENGTH_MIN } from './storage.js';

export const BACKUP_APP = 'dumbbell-app';
export const BACKUP_KIND = 'backup';

function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function iso(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === 'number') return new Date(now).toISOString();
  return String(now);
}

function time(s) {
  const t = Date.parse(s && s.completed_at);
  return isNaN(t) ? 0 : t;
}

// Chronological by completed_at; equal times keep their order (Array.prototype.sort is stable).
function chronological(sessions) {
  return sessions.slice().sort((a, b) => time(a) - time(b));
}

export function buildBackup(doc, now) {
  return {
    app: BACKUP_APP,
    kind: BACKUP_KIND,
    exported_at: iso(now),
    schema_version: doc.schema_version,
    doc: clone(doc),
  };
}

function pad(n) {
  return (n < 10 ? '0' : '') + n;
}

export function backupFileName(now) {
  const d = new Date(now);
  return 'dumbbell-backup-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '.json';
}

function fail(error) {
  return { ok: false, error };
}

function version(v) {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

// parseBackup(text, library) -> { ok: true, doc, summary } | { ok: false, error }
// Structure is checked on the stored document before migration (every schema so far uses the
// same field names), then an older schema runs through storage's migrate.
export function parseBackup(text, library) {
  let data;
  try {
    data = JSON.parse(String(text));
  } catch (e) {
    return fail('This file is not a backup. It could not be read as JSON.');
  }
  if (!isObj(data) || data.app !== BACKUP_APP) return fail('This file is not a backup from this app.');
  const raw = data.doc;
  if (!isObj(raw)) return fail('This backup holds no data.');
  const newest = Math.max(version(data.schema_version), version(raw.schema_version));
  if (newest > SCHEMA_VERSION) {
    return fail('This backup comes from a newer version of the app (schema ' + newest + '). Update the app, then import it.');
  }
  if (!isObj(raw.equipment)) return fail('This backup has no equipment profile.');
  if (!Array.isArray(raw.sessions)) return fail('This backup has no session list.');
  for (let i = 0; i < raw.sessions.length; i++) {
    const s = raw.sessions[i];
    if (!isObj(s) || s.id == null || s.id === '') return fail('Session ' + (i + 1) + ' in this backup has no id.');
    if (typeof s.completed_at !== 'string' || isNaN(Date.parse(s.completed_at))) {
      return fail('Session ' + (i + 1) + ' in this backup has no completion date.');
    }
  }
  let doc;
  try {
    doc = migrate(raw, library);
  } catch (e) {
    return fail(String((e && e.message) || e));
  }
  // Fill what the app needs to run without changing a well-formed document.
  if (!isObj(doc.settings)) doc.settings = {};
  if (typeof doc.settings.default_length_min !== 'number') doc.settings.default_length_min = DEFAULT_LENGTH_MIN;
  if (typeof doc.settings.auto_pick_swaps !== 'boolean') doc.settings.auto_pick_swaps = true;
  if (!isObj(doc.current)) doc.current = null;
  const sorted = chronological(doc.sessions);
  return {
    ok: true,
    doc,
    summary: {
      sessions: sorted.length,
      first_date: sorted.length ? sorted[0].completed_at : null,
      last_date: sorted.length ? sorted[sorted.length - 1].completed_at : null,
      exported_at: typeof data.exported_at === 'string' ? data.exported_at : null,
    },
  };
}

// Replace everything: the backup's document whole (equipment, settings, sessions, current).
export function applyReplace(doc, backupDoc) {
  return clone(backupDoc);
}

// Add missing sessions: this phone's document plus every backup session whose id is not
// already here, sorted by completed_at. Equipment, settings, and current stay as they are; the
// caller regenerates an unstarted current when sessions were added.
export function applyMerge(doc, backupDoc) {
  const out = clone(doc);
  const have = new Set(out.sessions.map((s) => String(s.id)));
  const added = [];
  (backupDoc.sessions || []).forEach((s) => {
    const id = String(s.id);
    if (have.has(id)) return;
    have.add(id);
    added.push(clone(s));
  });
  out.sessions = chronological(out.sessions.concat(added));
  return out;
}
