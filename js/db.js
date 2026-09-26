/*
 * db.js — IndexedDB 持久化 trap 报告与源码映射。
 */
(function (global) {
  'use strict';
  const DB_NAME = 'wasm-trap-lab';
  const STORE = 'reports';
  const META = 'meta';
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          s.createIndex('ts', 'timestamp');
        }
        if (!db.objectStoreNames.contains(META)) {
          db.createObjectStore(META, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  function tx(db, store, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
    });
  }
  const DB = {
    async addReport(report) {
      const db = await open();
      return tx(db, STORE, 'readwrite', (s) => s.add(report));
    },
    async getReports() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(STORE, 'readonly');
        const req = t.objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result.sort((a, b) => a.timestamp - b.timestamp));
        req.onerror = () => reject(req.error);
      });
    },
    async clear() {
      const db = await open();
      return tx(db, STORE, 'readwrite', (s) => s.clear());
    },
    async putMeta(key, value) {
      const db = await open();
      return tx(db, META, 'readwrite', (s) => s.put({ key, value }));
    },
    async getMeta(key) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(META, 'readonly');
        const req = t.objectStore(META).get(key);
        req.onsuccess = () => resolve(req.result && req.result.value);
        req.onerror = () => reject(req.error);
      });
    },
  };
  global.TrapDB = DB;
})(typeof self !== 'undefined' ? self : globalThis);
