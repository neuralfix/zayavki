// Хранилище в телефоне (IndexedDB). Используется и страницей, и фоновым service worker.
'use strict';

const DB_NAME = 'master-zayavki';
const DB_VER = 1;
let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('orders', { keyPath: 'id' });
      const p = d.createObjectStore('photos', { keyPath: 'id' });
      p.createIndex('orderId', 'orderId');
      d.createObjectStore('expenses', { keyPath: 'id' });
      d.createObjectStore('meta');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return _dbPromise;
}

function _req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function _store(name, mode = 'readonly') {
  const d = await openDB();
  return d.transaction(name, mode).objectStore(name);
}

const dbAll = async (n) => _req((await _store(n)).getAll());
const dbGet = async (n, k) => _req((await _store(n)).get(k));
const dbPut = async (n, v, k) => _req((await _store(n, 'readwrite')).put(v, k));
const dbDel = async (n, k) => _req((await _store(n, 'readwrite')).delete(k));
const dbClear = async (n) => _req((await _store(n, 'readwrite')).clear());
const dbByIndex = async (n, i, v) => _req((await _store(n)).index(i).getAll(v));

// Заменить заявки, расходы и фото одной операцией: либо всё целиком, либо ничего (старые данные остаются).
async function dbReplaceAll(data, meta) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(['orders', 'expenses', 'photos', 'meta'], 'readwrite');
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error || new Error('Не удалось записать данные'));
    t.onabort = () => reject(t.error || new Error('Запись прервана — данные в телефоне не изменились'));
    try {
      for (const n of ['orders', 'expenses', 'photos']) {
        const s = t.objectStore(n); s.clear();
        for (const v of data[n] || []) s.put(v);
      }
      const m = t.objectStore('meta');
      for (const [k, v] of Object.entries(meta || {})) m.put(v, k);
    } catch (e) { try { t.abort(); } catch (x) { /* уже прервана */ } reject(e); }
  });
}

const getMeta = (k) => dbGet('meta', k);
const setMeta = (k, v) => dbPut('meta', v, k);

function uid() {
  return (self.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

async function nextOrderNum() {
  const n = (await getMeta('nextNum')) || 1;
  await setMeta('nextNum', n + 1);
  return n;
}

// Отметка «данные изменились, надо отправить на Диск».
async function markDirty() {
  const v = ((await getMeta('dataVersion')) || 0) + 1;
  await setMeta('dataVersion', v);
  return v;
}

// Удалённое фото стирается с Диска не сразу, а через 14 дней: на него ещё ссылаются прошлые копии в «Истории».
async function addPendingDelete(path) {
  if (!path) return;
  const list = (await getMeta('pendingDeletes')) || [];
  if (!list.some((x) => (x.path || x) === path)) list.push({ path, at: Date.now() });
  await setMeta('pendingDeletes', list);
}

// Расчёты по заявке
function orderCosts(o) {
  return (o.costs || []).reduce((s, c) => s + (Number(c.amount) || 0), 0);
}
function orderNet(o) {
  return (Number(o.income) || 0) - orderCosts(o);
}
