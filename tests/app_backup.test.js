// Backup file: build and parse round trip, every rejection, older-schema migration, merge, replace.

import { test, equal, assert, deepEqual } from './harness.js';
import { library, clone, runChain } from './helpers.js';
import {
  buildBackup, backupFileName, parseBackup, applyReplace, applyMerge, BACKUP_APP, BACKUP_KIND,
} from '../js/app/backup.js';
import { defaultDoc, SCHEMA_VERSION } from '../js/app/storage.js';
import { generateSession } from '../js/engine/index.js';

const NOW = '2026-11-11T12:00:00.000Z';

// Four completed sessions, an unstarted current session, and a last export time.
const chain = runChain({ equipment: library.default_equipment, lengthMin: 50, count: 4, seedPrefix: 'backup' }).sessions;

function sampleDoc() {
  const doc = defaultDoc(library);
  doc.sessions = clone(chain);
  doc.current = generateSession({
    library, equipment: doc.equipment, sessions: doc.sessions, lengthMin: 50, seed: 'backup-current', now: NOW,
  });
  doc.settings.last_export_at = '2026-11-01T09:00:00.000Z';
  return doc;
}

function textOf(backup) {
  return JSON.stringify(backup);
}

test('backup: buildBackup has the app marker, kind, export time, schema, and a copy of the document', () => {
  const doc = sampleDoc();
  const b = buildBackup(doc, NOW);
  deepEqual(Object.keys(b).sort(), ['app', 'doc', 'exported_at', 'kind', 'schema_version']);
  equal(b.app, BACKUP_APP);
  equal(b.app, 'dumbbell-app');
  equal(b.kind, BACKUP_KIND);
  equal(b.exported_at, NOW);
  equal(b.schema_version, SCHEMA_VERSION);
  deepEqual(b.doc, doc);
  b.doc.sessions.pop();
  equal(doc.sessions.length, 4, 'the input document is untouched');
  equal(buildBackup(doc, new Date(NOW)).exported_at, NOW, 'a Date is stored as ISO');
});

test('backup: file name is dumbbell-backup-YYYY-MM-DD.json', () => {
  equal(backupFileName('2026-11-11T12:00:00.000Z'), 'dumbbell-backup-2026-11-11.json');
  equal(backupFileName('2026-03-05T12:00:00.000Z'), 'dumbbell-backup-2026-03-05.json');
  equal(backupFileName(new Date('2026-12-24T12:00:00.000Z')), 'dumbbell-backup-2026-12-24.json');
});

test('backup: build then parse round-trips deep-equal, with the summary', () => {
  const doc = sampleDoc();
  const r = parseBackup(textOf(buildBackup(doc, NOW)), library);
  assert(r.ok, r.error);
  deepEqual(r.doc, doc);
  deepEqual(r.summary, {
    sessions: 4,
    first_date: doc.sessions[0].completed_at,
    last_date: doc.sessions[3].completed_at,
    exported_at: NOW,
  });
});

test('backup: a document with no sessions and no current round-trips', () => {
  const doc = defaultDoc(library);
  const r = parseBackup(textOf(buildBackup(doc, NOW)), library);
  assert(r.ok, r.error);
  deepEqual(r.doc, doc);
  deepEqual(r.summary, { sessions: 0, first_date: null, last_date: null, exported_at: NOW });
});

test('backup: parse rejects text that is not JSON', () => {
  ['', 'not json', '{"app": "dumbbell-app",', 'undefined'].forEach((t) => {
    const r = parseBackup(t, library);
    assert(!r.ok && typeof r.error === 'string' && r.error.length > 0, 'accepted ' + JSON.stringify(t));
  });
});

test('backup: parse rejects a missing or wrong app marker', () => {
  const b = buildBackup(sampleDoc(), NOW);
  const cases = {
    missing: Object.assign({}, b, { app: undefined }),
    wrong: Object.assign({}, b, { app: 'some-other-app' }),
    array: [b],
    number: 42,
    nullValue: null,
  };
  Object.keys(cases).forEach((k) => {
    const r = parseBackup(JSON.stringify(cases[k]), library);
    assert(!r.ok && r.error, k + ' accepted');
  });
});

test('backup: parse rejects a schema newer than the app, in the envelope or the document', () => {
  const b1 = buildBackup(sampleDoc(), NOW);
  b1.schema_version = SCHEMA_VERSION + 1;
  b1.doc.schema_version = SCHEMA_VERSION + 1;
  const r1 = parseBackup(textOf(b1), library);
  assert(!r1.ok && /newer/.test(r1.error), 'both: ' + JSON.stringify(r1.error));
  const b2 = buildBackup(sampleDoc(), NOW);
  b2.doc.schema_version = SCHEMA_VERSION + 3;
  const r2 = parseBackup(textOf(b2), library);
  assert(!r2.ok && /newer/.test(r2.error), 'doc only: ' + JSON.stringify(r2.error));
});

test('backup: parse rejects a missing equipment object and a missing document', () => {
  const b = buildBackup(sampleDoc(), NOW);
  delete b.doc.equipment;
  assert(!parseBackup(textOf(b), library).ok, 'missing equipment accepted');
  const b2 = buildBackup(sampleDoc(), NOW);
  b2.doc.equipment = [10, 15];
  assert(!parseBackup(textOf(b2), library).ok, 'array equipment accepted');
  const b3 = buildBackup(sampleDoc(), NOW);
  delete b3.doc;
  assert(!parseBackup(textOf(b3), library).ok, 'missing doc accepted');
});

test('backup: parse rejects a sessions value that is not an array', () => {
  [{}, 'x', null, 3].forEach((v) => {
    const b = buildBackup(sampleDoc(), NOW);
    b.doc.sessions = v;
    assert(!parseBackup(textOf(b), library).ok, 'sessions ' + JSON.stringify(v) + ' accepted');
  });
  const b = buildBackup(sampleDoc(), NOW);
  delete b.doc.sessions;
  assert(!parseBackup(textOf(b), library).ok, 'missing sessions accepted');
});

test('backup: parse rejects any session without an id or completed_at', () => {
  const noId = buildBackup(sampleDoc(), NOW);
  delete noId.doc.sessions[2].id;
  const r1 = parseBackup(textOf(noId), library);
  assert(!r1.ok && /Session 3/.test(r1.error), 'no id: ' + JSON.stringify(r1));
  const emptyId = buildBackup(sampleDoc(), NOW);
  emptyId.doc.sessions[0].id = '';
  assert(!parseBackup(textOf(emptyId), library).ok, 'empty id accepted');
  const noDone = buildBackup(sampleDoc(), NOW);
  delete noDone.doc.sessions[1].completed_at;
  const r2 = parseBackup(textOf(noDone), library);
  assert(!r2.ok && /Session 2/.test(r2.error), 'no completed_at: ' + JSON.stringify(r2));
  const nullDone = buildBackup(sampleDoc(), NOW);
  nullDone.doc.sessions[3].completed_at = null;
  assert(!parseBackup(textOf(nullDone), library).ok, 'null completed_at accepted');
  const notSession = buildBackup(sampleDoc(), NOW);
  notSession.doc.sessions.push('x');
  assert(!parseBackup(textOf(notSession), library).ok, 'non-object session accepted');
});

test('backup: an older schema runs through migrate', () => {
  const old = {
    app: 'dumbbell-app', kind: 'backup', exported_at: NOW,
    doc: { equipment: clone(library.default_equipment), settings: { default_length_min: 40 }, sessions: clone(chain) },
  };
  const r = parseBackup(JSON.stringify(old), library);
  assert(r.ok, r.error);
  equal(r.doc.schema_version, SCHEMA_VERSION);
  deepEqual(r.doc.settings, { default_length_min: 40, auto_pick_swaps: true });
  deepEqual(r.doc.sessions, chain);
  equal(r.doc.current, null);
  equal(r.summary.sessions, 4);
});

test('backup: applyReplace returns the backup document whole, as a copy', () => {
  const phone = defaultDoc(library);
  phone.settings.default_length_min = 30;
  const backupDoc = sampleDoc();
  backupDoc.equipment.bench.present = false;
  const out = applyReplace(phone, backupDoc);
  deepEqual(out, backupDoc);
  assert(out !== backupDoc && out.sessions !== backupDoc.sessions, 'a copy');
  equal(phone.settings.default_length_min, 30, 'the phone document is untouched');
});

test('backup: applyMerge adds only missing ids, sorted by completed_at, and keeps everything else', () => {
  const [s0, s1, s2, s3] = clone(chain);
  const phone = defaultDoc(library);
  phone.settings.default_length_min = 30;
  phone.equipment.fixed_pairs_lb = [10, 20];
  phone.sessions = [clone(s0), clone(s2)];
  phone.current = sampleDoc().current;
  const phoneBefore = clone(phone);
  const backupDoc = defaultDoc(library);
  const s2copy = Object.assign(clone(s2), { notes: 'backup copy' });
  backupDoc.sessions = [clone(s1), s2copy, clone(s3)];
  backupDoc.settings.auto_pick_swaps = false;
  const backupBefore = clone(backupDoc);

  const out = applyMerge(phone, backupDoc);
  deepEqual(out.sessions.map((s) => s.id), [s0.id, s1.id, s2.id, s3.id]);
  deepEqual(out.sessions[2], s2, 'the phone keeps its own copy of a shared id');
  deepEqual(out.sessions[1], s1);
  deepEqual(out.equipment, phone.equipment);
  deepEqual(out.settings, phone.settings);
  deepEqual(out.current, phone.current);
  deepEqual(phone, phoneBefore, 'phone document untouched');
  deepEqual(backupDoc, backupBefore, 'backup document untouched');
  for (let i = 1; i < out.sessions.length; i++) {
    assert(Date.parse(out.sessions[i - 1].completed_at) <= Date.parse(out.sessions[i].completed_at), 'sorted at ' + i);
  }
  const again = applyMerge(out, backupDoc);
  deepEqual(again, out, 'merging twice adds nothing');
});

test('backup: applyMerge puts an older backup session before the phone sessions and keeps their order', () => {
  const [s0, s1, s2, s3] = clone(chain);
  const phone = defaultDoc(library);
  phone.sessions = [clone(s2), clone(s3)];
  const backupDoc = defaultDoc(library);
  backupDoc.sessions = [clone(s3), clone(s0), clone(s1)];
  const out = applyMerge(phone, backupDoc);
  deepEqual(out.sessions.map((s) => s.id), [s0.id, s1.id, s2.id, s3.id]);
  equal(out.current, null);
});
