// App storage: first-run defaults, round trip through IndexedDB, coalesced saves, migration.
// Every test uses its own scratch database and deletes it afterwards.

import { test, equal, assert, deepEqual } from './harness.js';
import { library, clone } from './helpers.js';
import {
  openStorage, defaultDoc, migrate, readRaw, writeRaw, deleteDatabase, SCHEMA_VERSION, DB_NAME,
} from '../js/app/storage.js';
import { generateSession } from '../js/engine/index.js';

let counter = 0;
function scratchName() {
  counter += 1;
  return 'test-app-' + Date.now().toString(36) + '-' + counter;
}

async function withDb(fn) {
  const name = scratchName();
  try {
    await fn(name);
  } finally {
    await deleteDatabase(name);
  }
}

test('storage: scratch database name is not the app database', () => {
  assert(scratchName() !== DB_NAME);
});

test('storage: first run gives default equipment, 50 min, auto-pick swaps, no sessions', async () => {
  await withDb(async (name) => {
    const st = await openStorage(name);
    const doc = await st.load(library);
    equal(doc.schema_version, SCHEMA_VERSION);
    deepEqual(doc.equipment, library.default_equipment);
    assert(doc.equipment !== library.default_equipment, 'equipment is a copy');
    deepEqual(doc.settings, { default_length_min: 50, auto_pick_swaps: true });
    deepEqual(doc.sessions, []);
    equal(doc.current, null);
    const raw = await readRaw(st.db);
    deepEqual(raw, doc, 'first-run document is written');
    doc.equipment.fixed_pairs_lb.push(99);
    assert(library.default_equipment.fixed_pairs_lb.indexOf(99) < 0, 'library default untouched');
    st.close();
  });
});

test('storage: round trip of a document with a current session survives close and reopen', async () => {
  await withDb(async (name) => {
    const st = await openStorage(name);
    const doc = await st.load(library);
    doc.current = generateSession({
      library, equipment: doc.equipment, sessions: [], lengthMin: 50, seed: 12345, now: '2026-11-11T07:00:00.000Z',
    });
    doc.current.started_at = '2026-11-11T07:01:00.000Z';
    doc.current.notes = 'note';
    doc.settings.default_length_min = 40;
    await st.save(doc);
    await st.flush();
    st.close();
    const st2 = await openStorage(name);
    const back = await st2.load(library);
    deepEqual(back, doc);
    st2.close();
  });
});

test('storage: rapid saves coalesce and the latest document wins', async () => {
  await withDb(async (name) => {
    const pend = [];
    const st = await openStorage(name, { onPending: (n) => pend.push(n) });
    const doc = await st.load(library);
    for (let i = 0; i < 20; i++) {
      doc.settings.default_length_min = 30 + i;
      st.save(doc);
    }
    await st.flush();
    equal(st.pending(), 0);
    equal(pend[pend.length - 1], 0, 'last pending notice is 0');
    st.close();
    const st2 = await openStorage(name);
    equal((await st2.load(library)).settings.default_length_min, 49);
    st2.close();
  });
});

test('storage: migrate(null) is the first-run document', () => {
  deepEqual(migrate(null, library), defaultDoc(library));
  deepEqual(migrate(undefined, library), defaultDoc(library));
});

test('storage: migrate fills a version-0 document and keeps its sessions', () => {
  const s = { id: 'push-1', day_type: 'push', completed_at: '2026-11-01T08:00:00.000Z', blocks: [] };
  const old = { sessions: [s], settings: { auto_pick_swaps: false } };
  const out = migrate(old, library);
  equal(out.schema_version, 1);
  deepEqual(out.sessions, [s]);
  deepEqual(out.settings, { default_length_min: 50, auto_pick_swaps: false });
  deepEqual(out.equipment, library.default_equipment);
  equal(out.current, null);
  assert(old.schema_version === undefined, 'input left alone');
});

test('storage: migrate leaves a current-version document as is', () => {
  const doc = defaultDoc(library);
  doc.settings.default_length_min = 60;
  deepEqual(migrate(doc, library), doc);
});

test('storage: migrate runs a chain keyed on schema_version', () => {
  const chain = {
    0: (d) => Object.assign({}, d, { schema_version: 1, a: 1 }),
    1: (d) => Object.assign({}, d, { schema_version: 2, b: d.a + 1 }),
  };
  const out = migrate({ x: 'kept' }, library, chain, 2);
  deepEqual(out, { x: 'kept', schema_version: 2, a: 1, b: 2 });
  deepEqual(migrate({ schema_version: 1, a: 5 }, library, chain, 2), { schema_version: 2, a: 5, b: 6 });
});

test('storage: a document from a newer app version is refused, not overwritten', async () => {
  let threw = false;
  try { migrate({ schema_version: SCHEMA_VERSION + 1 }, library); } catch (e) { threw = true; }
  assert(threw, 'migrate throws');
  await withDb(async (name) => {
    const st = await openStorage(name);
    const future = { schema_version: SCHEMA_VERSION + 1, keep: true };
    await writeRaw(st.db, future);
    let loadThrew = false;
    try { await st.load(library); } catch (e) { loadThrew = true; }
    assert(loadThrew, 'load throws');
    deepEqual(await readRaw(st.db), future, 'stored document unchanged');
    st.close();
  });
});

test('storage: load migrates a stored version-0 document and writes it back', async () => {
  await withDb(async (name) => {
    const st = await openStorage(name);
    await writeRaw(st.db, { sessions: [], settings: { default_length_min: 30 } });
    const doc = await st.load(library);
    equal(doc.schema_version, 1);
    equal(doc.settings.default_length_min, 30);
    const raw = await readRaw(st.db);
    equal(raw.schema_version, 1, 'written back');
    deepEqual(raw, clone(doc));
    st.close();
  });
});
