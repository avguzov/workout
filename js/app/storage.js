// App storage: one versioned JSON document in IndexedDB (one object store, one key).
//
// Document shape (schema_version 1):
//   { schema_version, equipment, settings: { default_length_min, auto_pick_swaps },
//     sessions: [completed sessions, chronological], current: null | Session }
//
// openStorage(dbName) -> { load(library), save(doc), flush(), pending(), close() }
// Saves are coalesced: a save while a write is in flight writes the latest document once the
// in-flight write commits, so the stored document is never older than the last save() call.

export const SCHEMA_VERSION = 1;
export const DB_NAME = 'dumbbell-app';
export const STORE = 'app';
export const DOC_KEY = 'doc';
export const DEFAULT_LENGTH_MIN = 50;

function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// First-run document: equipment is a copy of the library's default profile.
export function defaultDoc(library) {
  return {
    schema_version: SCHEMA_VERSION,
    equipment: clone(library.default_equipment),
    settings: { default_length_min: DEFAULT_LENGTH_MIN, auto_pick_swaps: true },
    sessions: [],
    current: null,
  };
}

// One step per version: MIGRATIONS[v] turns a version-v document into version v + 1.
// Version 0 is any document saved without a schema_version.
const MIGRATIONS = {
  0(doc, library) {
    const base = defaultDoc(library);
    const settings = isObj(doc.settings) ? doc.settings : {};
    return {
      schema_version: 1,
      equipment: isObj(doc.equipment) ? doc.equipment : base.equipment,
      settings: {
        default_length_min: typeof settings.default_length_min === 'number'
          ? settings.default_length_min : base.settings.default_length_min,
        auto_pick_swaps: typeof settings.auto_pick_swaps === 'boolean'
          ? settings.auto_pick_swaps : base.settings.auto_pick_swaps,
      },
      sessions: Array.isArray(doc.sessions) ? doc.sessions : [],
      current: isObj(doc.current) ? doc.current : null,
    };
  },
};

// migrate(doc, library) -> document at SCHEMA_VERSION. A missing doc gives the first-run
// document. A document from a newer app version throws rather than being overwritten.
// `migrations` and `target` default to the app's own chain; tests pass their own.
export function migrate(doc, library, migrations, target) {
  const steps = migrations || MIGRATIONS;
  const top = typeof target === 'number' ? target : SCHEMA_VERSION;
  if (!isObj(doc)) return defaultDoc(library);
  let d = clone(doc);
  let v = typeof d.schema_version === 'number' ? d.schema_version : 0;
  if (v > top) {
    throw new Error('This data was saved by a newer version of the app (schema ' + v + ').');
  }
  while (v < top) {
    const step = steps[v];
    if (!step) throw new Error('No migration from schema ' + v + '.');
    d = step(d, library);
    if (typeof d.schema_version !== 'number' || d.schema_version <= v) {
      throw new Error('Migration from schema ' + v + ' did not advance the version.');
    }
    v = d.schema_version;
  }
  return d;
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

function openVersion(dbName, version) {
  return new Promise((resolve, reject) => {
    const r = version ? indexedDB.open(dbName, version) : indexedDB.open(dbName);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('database open blocked'));
  });
}

// Opens at the current version; if the store is missing (a database created by something
// else), bumps the version once to create it.
async function openDb(dbName) {
  const db = await openVersion(dbName);
  if (db.objectStoreNames.contains(STORE)) return db;
  const v = db.version + 1;
  db.close();
  return openVersion(dbName, v);
}

function writeTx(db) {
  try {
    return db.transaction(STORE, 'readwrite', { durability: 'strict' });
  } catch (e) {
    return db.transaction(STORE, 'readwrite');
  }
}

export async function readRaw(db) {
  const tx = db.transaction(STORE, 'readonly');
  const value = await req(tx.objectStore(STORE).get(DOC_KEY));
  return value === undefined ? null : value;
}

export async function writeRaw(db, doc) {
  const tx = writeTx(db);
  tx.objectStore(STORE).put(doc, DOC_KEY);
  await done(tx);
}

export function deleteDatabase(dbName) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.deleteDatabase(dbName);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
    r.onblocked = () => resolve();
  });
}

// Ask the browser not to evict our data. Safari 15.4+ has it; older browsers skip it.
export async function requestPersistence() {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persist === 'function') {
      return await navigator.storage.persist();
    }
  } catch (e) {
    // not fatal
  }
  return false;
}

export async function openStorage(dbName, options) {
  const opts = options || {};
  const db = await openDb(dbName || DB_NAME);
  db.onversionchange = () => db.close();
  let latest = null;
  let dirty = false;
  let inFlight = null;
  let lastError = null;
  const notify = () => {
    if (opts.onPending) opts.onPending(dirty || inFlight ? 1 : 0, lastError);
  };

  function pump() {
    if (inFlight || !dirty) return inFlight || Promise.resolve();
    dirty = false;
    const doc = latest;
    inFlight = writeRaw(db, doc).then(() => {
      lastError = null;
    }, (e) => {
      lastError = e;
      if (opts.onError) opts.onError(e);
    }).then(() => {
      inFlight = null;
      notify();
      return pump();
    });
    notify();
    return inFlight;
  }

  return {
    db,
    // load(library) -> migrated document; writes it back when it was missing or migrated.
    async load(library) {
      const raw = await readRaw(db);
      const doc = migrate(raw, library);
      if (!raw || raw.schema_version !== doc.schema_version) await writeRaw(db, doc);
      return doc;
    },
    save(doc) {
      latest = doc;
      dirty = true;
      return pump();
    },
    async flush() {
      while (inFlight || dirty) await pump();
      if (lastError) throw lastError;
    },
    pending() {
      return dirty || inFlight ? 1 : 0;
    },
    close() {
      db.close();
    },
  };
}
