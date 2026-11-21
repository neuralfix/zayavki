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
      _writeMetaEntries(t.objectStore('meta'), meta || {});
    } catch (e) { try { t.abort(); } catch (x) { /* уже прервана */ } reject(e); }
  });
}

const getMeta = (k) => dbGet('meta', k);
const setMeta = (k, v) => dbPut('meta', v, k);

function _writeMetaEntries(store, entries) {
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value !== 'function') {
      store.put(value, key);
      continue;
    }
    const current = store.get(key);
    current.onsuccess = () => store.put(value(current.result), key);
  }
}

async function setMetaEntries(entries) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction('meta', 'readwrite');
    t.oncomplete = () => resolve();
    t.onabort = () => reject(t.error || new Error('Не удалось записать настройки'));
    _writeMetaEntries(t.objectStore('meta'), entries);
  });
}

function uid() {
  return (self.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// Новая заявка: номер выдаётся и заявка записывается одной операцией — два быстрых нажатия не дадут один номер дважды
async function dbCreateOrder(rec) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(['orders', 'meta'], 'readwrite');
    const m = t.objectStore('meta');
    const g = m.get('nextNum');
    g.onsuccess = () => {
      const n = g.result || 1;
      rec.num = n;
      m.put(n + 1, 'nextNum');
      t.objectStore('orders').put(rec);
    };
    t.oncomplete = () => resolve(rec);
    t.onerror = () => reject(t.error || new Error('Не удалось сохранить заявку'));
    t.onabort = () => reject(t.error || new Error('Заявка не сохранилась'));
  });
}

// Правки формы и распознавания применяются к последней сохранённой версии заявки.
const dbUpdateOrder = (id, update) => _updateRecord('orders', id, update);
const dbUpdatePhoto = (id, update) => _updateRecord('photos', id, update);

function dbConfirmPhotoUpload(photo, path) {
  return _updateRecord('photos', photo.id, (current) => {
    if (current.blobRevision !== photo.blobRevision || !current.blob) return null;
    return { ...current, uploaded: 1, remotePath: path };
  }, { photoUploaded: true });
}

async function _updateRecord(table, id, update, { photoUploaded = false } = {}) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(photoUploaded ? [table, 'meta'] : table, 'readwrite');
    const store = t.objectStore(table);
    const request = store.get(id);
    let result;
    request.onsuccess = () => {
      const current = request.result;
      if (!current) return;
      try {
        const next = update(current);
        if (next) {
          store.put(next);
          if (photoUploaded) {
            const entries = { dataVersion: _nextDataVersion };
            const previousPath = current.remotePath;
            if (previousPath && previousPath !== next.remotePath) {
              entries.pendingDeletes = (list) => _enqueuePhotoDelete(list, previousPath);
            }
            _writeMetaEntries(t.objectStore('meta'), entries);
          }
        }
        result = next || current;
      } catch (e) {
        t.abort();
        reject(e);
      }
    };
    t.oncomplete = () => resolve(result);
    t.onabort = () => reject(t.error || new Error('Не удалось сохранить изменения'));
  });
}

// Отметка «данные изменились, надо отправить на Диск».
const _nextDataVersion = (current) => (current || 0) + 1;
async function markDirty() {
  let version;
  await setMetaEntries({ dataVersion: (current) => {
    version = _nextDataVersion(current);
    return version;
  } });
  return version;
}

// Удалённое фото стирается с Диска не сразу, а через 14 дней: на него ещё ссылаются прошлые копии в «Истории».
async function addPendingDelete(path) {
  if (!path) return;
  await setMetaEntries({ pendingDeletes: (list) => _enqueuePhotoDelete(list, path) });
}

function _enqueuePhotoDelete(current, path) {
  const list = current || [];
  if (!list.some((x) => (x.path || x) === path)) list.push({ path, at: Date.now() });
  return list;
}

// Удаляем запись и ставим в очередь путь из той же версии фото, которую удалили.
async function dbRemovePhoto(id) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(['photos', 'meta'], 'readwrite');
    const photos = t.objectStore('photos');
    const request = photos.get(id);
    request.onsuccess = () => {
      const photo = request.result;
      if (!photo) return;
      photos.delete(id);
      if (photo.remotePath) {
        _writeMetaEntries(t.objectStore('meta'), {
          pendingDeletes: (list) => _enqueuePhotoDelete(list, photo.remotePath),
        });
      }
    };
    t.oncomplete = () => resolve();
    t.onabort = () => reject(t.error || new Error('Не удалось удалить фото'));
  });
}

// Расчёты по заявке
function orderCosts(o) {
  return (o.costs || []).reduce((s, c) => s + (Number(c.amount) || 0), 0);
}
function orderNet(o) {
  return (Number(o.income) || 0) - orderCosts(o);
}
