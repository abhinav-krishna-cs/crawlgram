// Local IndexedDB storage. Works in the service worker and the dashboard page
// (both run on the extension origin, so they share the same database).

const DB_NAME = 'crawlvault';
const DB_VERSION = 1;
let dbPromise;

export function openDB() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('properties', { keyPath: 'id' });
      const exp = db.createObjectStore('exports', { keyPath: 'id' });
      exp.createIndex('propertyId', 'propertyId');
      const daily = db.createObjectStore('daily', { keyPath: ['propertyId', 'date'] });
      daily.createIndex('propertyId', 'propertyId');
      const bd = db.createObjectStore('breakdowns', { keyPath: ['exportId', 'dimension', 'value'] });
      bd.createIndex('propertyId', 'propertyId');
      const raw = db.createObjectStore('rawFiles', { keyPath: ['exportId', 'name'] });
      raw.createIndex('exportId', 'exportId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const done = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const txDone = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

export async function get(store, key) {
  const db = await openDB();
  return done(db.transaction(store).objectStore(store).get(key));
}

export async function getAll(store, indexName, query) {
  const db = await openDB();
  const os = db.transaction(store).objectStore(store);
  return done(indexName ? os.index(indexName).getAll(query) : os.getAll());
}

export async function put(store, value) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  return txDone(tx);
}

// Write many records across stores in a single transaction.
export async function putMany(records /* { store: [values] } */) {
  const db = await openDB();
  const tx = db.transaction(Object.keys(records), 'readwrite');
  for (const [store, values] of Object.entries(records)) {
    const os = tx.objectStore(store);
    for (const v of values) os.put(v);
  }
  return txDone(tx);
}

export async function deleteProperty(propertyId) {
  const db = await openDB();
  const exports = await getAll('exports', 'propertyId', propertyId);
  const tx = db.transaction(['properties', 'exports', 'daily', 'breakdowns', 'rawFiles'], 'readwrite');
  tx.objectStore('properties').delete(propertyId);
  tx.objectStore('daily').delete(IDBKeyRange.bound([propertyId, ''], [propertyId, '￿']));
  for (const e of exports) {
    tx.objectStore('exports').delete(e.id);
    tx.objectStore('breakdowns').delete(IDBKeyRange.bound([e.id, '', ''], [e.id, '￿', '￿']));
    tx.objectStore('rawFiles').delete(IDBKeyRange.bound([e.id, ''], [e.id, '￿']));
  }
  return txDone(tx);
}

export async function dumpAll() {
  const out = {};
  for (const s of ['properties', 'exports', 'daily', 'breakdowns', 'rawFiles']) out[s] = await getAll(s);
  return { app: 'crawlvault', version: DB_VERSION, exportedAt: new Date().toISOString(), data: out };
}

export async function restoreAll(dump) {
  if (dump?.app !== 'crawlvault') throw new Error('Not a CrawlVault backup file');
  return putMany(dump.data);
}
