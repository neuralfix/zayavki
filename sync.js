// Синхронизация с Яндекс Диском. Работает и со страницы, и из фона (service worker).
// Всё складывается в папку приложения: «Диск / Приложения / <имя приложения>».
// На Диск уходят только зашифрованные файлы (см. crypto.js), без имён и адресов в названиях:
//   data.bin            — все заявки и расходы;
//   Фото/<номер>.bin    — фото договоров и деталей.
'use strict';

const YD_API = 'https://cloud-api.yandex.net/v1/disk';
const ROOT = 'app:/';
const PHOTOS_DIR = 'app:/Фото';
const LEGACY_DIR = 'app:/Заявки'; // старая незашифрованная раскладка (версия 1.0)
const HIST_DIR = 'app:/История';   // прошлые копии data.bin: по одной в день, последние 10
const HIST_KEEP = 10;
const PHOTO_DELETE_AFTER = 14 * 864e5;   // фото стирается с Диска через 14 дней после удаления в приложении
const syncChannel = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('zayavki-sync') : null;

class NetError extends Error {}
class BusyError extends NetError {} // Диск временно занят («Resource is locked», слишком часто) — повторим
class AuthError extends Error {}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _busy = (status) => status === 423 || status === 429 || status >= 500;

// Повтор при временной занятости Диска: через 3, 10 и 30 секунд
async function _retry(fn) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (!(e instanceof BusyError) || i >= 3) throw e;
      await _sleep([3000, 10000, 30000][i]);
    }
  }
}

async function ydFetch(token, path, opts = {}) {
  let r;
  try {
    r = await fetch(YD_API + path, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: 'OAuth ' + token },
    });
  } catch (e) {
    throw new NetError('Нет связи с Яндекс Диском');
  }
  if (r.status === 401) throw new AuthError('Доступ к Диску истёк — подключите заново');
  return r;
}

async function ydFail(r) {
  if (_busy(r.status)) throw new BusyError('Яндекс Диск временно занят — отправка продолжится сама');
  let msg = '';
  try { const j = await r.json(); msg = j.description || j.message || ''; } catch (e) { /* пусто */ }
  throw new Error('Яндекс Диск: ' + (msg || ('ошибка ' + r.status)));
}

async function ydMkdir(token, path) {
  const r = await ydFetch(token, '/resources?path=' + encodeURIComponent(path), { method: 'PUT' });
  if (r.status === 201 || r.status === 409) return; // 409 — папка уже есть
  await ydFail(r);
}

async function ydUpload(token, path, body) {
  const r = await ydFetch(token, '/resources/upload?overwrite=true&path=' + encodeURIComponent(path));
  if (!r.ok) await ydFail(r);
  const { href, method } = await r.json();
  let u;
  try {
    u = await fetch(href, { method: method || 'PUT', body });
  } catch (e) {
    // Запрос к API прошёл, а загрузка файла — нет: обрыв связи или запрет браузера.
    throw new NetError('Не удалось отправить файл на Диск');
  }
  if (_busy(u.status)) throw new BusyError('Яндекс Диск временно занят — отправка продолжится сама');
  if (!(u.ok || u.status === 201 || u.status === 202)) throw new Error('Яндекс Диск: файл не принят (' + u.status + ')');
}

async function ydDelete(token, path, permanently) {
  const r = await ydFetch(token, '/resources?permanently=' + (permanently ? 'true' : 'false') + '&path=' + encodeURIComponent(path), { method: 'DELETE' });
  if (r.ok || r.status === 202 || r.status === 204 || r.status === 404) return;
  await ydFail(r);
}

async function ydCopy(token, from, path) {
  const r = await ydFetch(token, '/resources/copy?overwrite=true&from=' + encodeURIComponent(from) + '&path=' + encodeURIComponent(path), { method: 'POST' });
  if (r.status === 201 || r.status === 202) return true;
  if (r.status === 404) return false;   // копировать нечего
  await ydFail(r);
}

async function ydList(token, path) {
  const r = await ydFetch(token, '/resources?limit=200&fields=_embedded.items.name&path=' + encodeURIComponent(path));
  if (r.status === 404) return [];
  if (!r.ok) await ydFail(r);
  const j = await r.json();
  return ((j._embedded || {}).items || []).map((x) => x.name);
}

const _day = (ts = Date.now()) => { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

// Раз в день, перед заменой data.bin, прежняя копия сохраняется в «Историю». Хранятся последние 10.
async function _historyCopy(token) {
  const day = _day();
  if ((await getMeta('histDay')) === day) return;
  await _retry(() => ydMkdir(token, HIST_DIR));
  const copied = await _retry(() => ydCopy(token, ROOT + 'data.bin', HIST_DIR + '/data-' + day + '.bin'));
  if (!copied) return;
  await setMeta('histDay', day);
  const old = (await ydList(token, HIST_DIR)).filter((n) => /^data-\d{4}-\d\d-\d\d\.bin$/.test(n)).sort().reverse().slice(HIST_KEEP);
  for (const n of old) await _retry(() => ydDelete(token, HIST_DIR + '/' + n));
}

// Сохранить в «Историю» отдельную копию (данные телефона перед восстановлением, копию Диска перед заменой)
async function saveHistoryCopy(kind, dump) {
  const token = await getMeta('ydToken');
  if (!token) return;
  await _retry(() => ydMkdir(token, ROOT));
  await _retry(() => ydMkdir(token, HIST_DIR));
  const name = HIST_DIR + '/' + kind + '-' + _day() + '-' + Date.now().toString(36) + '.bin';
  if (dump) { const body = new Blob([await encryptBytes(JSON.stringify(dump))]); await _retry(() => ydUpload(token, name, body)); }
  else await _retry(() => ydCopy(token, ROOT + 'data.bin', name));
}

async function ydDownloadBytes(token, path) {
  const r = await ydFetch(token, '/resources/download?path=' + encodeURIComponent(path));
  if (r.status === 404) return null;
  if (!r.ok) await ydFail(r);
  const { href } = await r.json();
  let d;
  try { d = await fetch(href); } catch (e) { throw new NetError('Не удалось скачать файл с Диска'); }
  if (!d.ok) throw new Error('Яндекс Диск: файл не скачан (' + d.status + ')');
  return new Uint8Array(await d.arrayBuffer());
}

// Скачать с Диска и расшифровать фото, которого нет в телефоне (например, после переезда на новый телефон).
async function fetchPhoto(id) {
  const p = await dbGet('photos', id);
  if (!p || p.blob) return p;
  const token = await getMeta('ydToken');
  if (!token) throw new Error('Подключите Яндекс Диск');
  if (!p.remotePath) throw new Error('Этого фото нет на Диске');
  const bytes = await ydDownloadBytes(token, p.remotePath);
  if (!bytes) throw new Error('Фото не найдено на Диске');
  let plain;
  try { plain = await decryptBytes(bytes, null); } catch (e) { throw new Error('Фото зашифровано другим паролем'); }
  p.blob = new Blob([plain], { type: 'image/jpeg' });
  p.uploaded = 1;
  await dbPut('photos', p);
  return p;
}

// Скачать копию с Диска. Возвращает данные или null, если копии там нет.
async function downloadDiskDump(askPassword) {
  const bytes = await ydDownloadBytes(await getMeta('ydToken'), ROOT + 'data.bin');
  if (!bytes) return null;
  const plain = await decryptBytes(bytes, askPassword);
  return JSON.parse(new TextDecoder().decode(plain));
}

// ---------- Выгрузка данных ----------

async function buildDump() {
  const orders = await dbAll('orders');
  const expenses = await dbAll('expenses');
  const photos = (await dbAll('photos')).map(({ blob, ...p }) => p);
  return {
    app: 'master-zayavki',
    format: 1,
    exportedAt: new Date().toISOString(),
    nextNum: (await getMeta('nextNum')) || 1,
    orders, expenses, photos,
  };
}

function _csvCell(v) {
  const s = String(v ?? '');
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function _csv(rows) {
  return '﻿' + rows.map((r) => r.map(_csvCell).join(';')).join('\r\n');
}
function _d(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
const STATUS_RU = { open: 'В работе', sd: 'На СД', closed: 'Закрыта', refused: 'Отказ', cancelled: 'Отмена' };

function ordersCsv(orders) {
  const rows = [['№', 'Создана', 'Статус', 'Закрыта', 'Имя', 'Телефон', 'Адрес', 'Кв.', 'Техника', 'Модель', 'Проблема',
    'Что сделано', 'Гарантия, дней', 'Тип заявки','Оплата клиента', 'Расходы (что)', 'Расходы, сумма', 'Чистыми']];
  orders.slice().sort((a, b) => a.num - b.num).forEach((o) => rows.push([
    o.num, _d(o.createdAt), STATUS_RU[o.status] || o.status, _d(o.closedAt), o.name, o.phone, o.address, o.apt,
    o.device, o.model, o.problem, o.workDone, o.warrantyDays || '', o.isWarranty ? 'Гарантия' : o.isRepeat ? 'Повторная' : 'Новая',
    o.status === 'closed' ? (o.income || 0) : '',
    (o.costs || []).map((c) => (c.name || 'расход') + ' ' + c.amount).join(', '),
    o.status === 'closed' ? orderCosts(o) : '', o.status === 'closed' ? orderNet(o) : '',
  ]));
  return _csv(rows);
}

function expensesCsv(expenses) {
  const rows = [['Дата', 'Категория', 'Сумма', 'Комментарий']];
  expenses.slice().sort((a, b) => a.date - b.date).forEach((e) => rows.push([
    new Date(e.date).toLocaleDateString('ru-RU'), e.category, e.amount, e.comment,
  ]));
  return _csv(rows);
}

// ---------- Синхронизация ----------

async function syncStatus() {
  const token = await getMeta('ydToken');
  const photos = await dbAll('photos');
  const pendingPhotos = photos.filter((p) => !p.uploaded && p.blob).length;
  const uploadedPhotos = photos.filter((p) => p.uploaded).length;
  const dataVersion = (await getMeta('dataVersion')) || 0;
  const syncedVersion = (await getMeta('syncedVersion')) || 0;
  return {
    connected: !!token,
    hasKey: await hasPassword(),
    pendingPhotos,
    uploadedPhotos,
    dataPending: dataVersion !== syncedVersion,
    pendingDeletes: _dueDeletes((await getMeta('pendingDeletes')) || []).length,
    paused: await getMeta('syncPaused'),   // check | both — отправка остановлена до решения
    lastSync: await getMeta('lastSync'),
    error: await getMeta('syncError'),
    waiting: await getMeta('syncWaiting'),
    waitWhy: await getMeta('syncWaitWhy'),   // offline | busy | net — почему ждём
  };
}

function withDiskSyncLock(task, ifAvailable = false) {
  if (!self.navigator?.locks) return task();
  return navigator.locks.request('zayavki-disk-sync', { ifAvailable },
    (lock) => (lock ? task() : { status: 'busy' }));
}

function syncNow() {
  return withDiskSyncLock(_doSync, true);
}

// Фоновая отправка не должна увидеть новый ключ, пока проверка копии не поставлена на паузу.
function beginDiskCheck(token) {
  const entries = { syncPaused: 'check', syncError: null };
  if (token !== undefined) entries.ydToken = token;
  return withDiskSyncLock(() => setMetaEntries(entries));
}

const _photoPath = (id) => PHOTOS_DIR + '/' + id + '.bin';
const _pendingDeletePath = (entry) => typeof entry === 'string' ? entry : entry.path;
const _dueDeletes = (list) => list.filter((x) => typeof x === 'string' || Date.now() - (x.at || 0) >= PHOTO_DELETE_AFTER)
  .map(_pendingDeletePath);

function _livePhotoPaths(orders, photos) {
  const orderIds = new Set(orders.map((o) => o.id));
  const paths = new Set();
  for (const p of photos) {
    if (!orderIds.has(p.orderId)) continue;
    if (p.remotePath) paths.add(p.remotePath);
    paths.add(_photoPath(p.id));
  }
  return paths;
}

async function _pending() {
  const photos = (await dbAll('photos')).filter((p) => !p.uploaded && p.blob);
  const deletes = _dueDeletes((await getMeta('pendingDeletes')) || []);
  const version = (await getMeta('dataVersion')) || 0;
  const dataPending = version !== ((await getMeta('syncedVersion')) || 0);
  return { photos, deletes, version, dataPending };
}

// Переход с версии 1.0: там файлы лежали на Диске открыто, а папки назывались по имени и адресу клиента.
// Удаляем их насовсем (не в корзину) и отправляем всё заново в зашифрованном виде.
async function _migrateToEncrypted(token) {
  for (const f of ['data.json', 'Заявки.csv', 'Расходы.csv']) await ydDelete(token, ROOT + f, true);
  await ydDelete(token, LEGACY_DIR, true);
  for (const p of await dbAll('photos')) {
    if (p.remotePath && !p.remotePath.startsWith(PHOTOS_DIR + '/')) {
      p.uploaded = 0; p.remotePath = null; await dbPut('photos', p);
    }
  }
  for (const o of await dbAll('orders')) {
    if (o.remoteFolder) { delete o.remoteFolder; await dbPut('orders', o); }
  }
  await setMeta('pendingDeletes', []);
  await setMeta('diskLayout', 2);
  await markDirty();
}

async function _doSync() {
  const token = await getMeta('ydToken');
  if (!token) return { status: 'off' };
  // Без пароля ничего не отправляем: на Диск попадает только зашифрованное.
  if (!(await hasPassword())) return { status: 'nokey' };
  // Копия на Диске не проверена или отличается от телефона — ничего не отправляем, пока не решите
  if (await getMeta('syncPaused')) return { status: 'paused' };

  const needMigrate = (await getMeta('diskLayout')) !== 2;
  let q = await _pending();
  if (!needMigrate && !q.photos.length && !q.deletes.length && !q.dataPending) {
    await setMeta('syncWaiting', false);
    return { status: 'nothing' };
  }

  _notify({ type: 'start' });
  let sent = 0;
  const before = (await dbAll('photos')).filter((p) => p.uploaded).length;   // для процента «отправлено из всех»
  try {
    await _retry(() => ydMkdir(token, ROOT));
    if (needMigrate) { await _migrateToEncrypted(token); q = await _pending(); }
    if (q.photos.length) await _retry(() => ydMkdir(token, PHOTOS_DIR));

    // 1. Фото: имя файла — случайный номер, внутри — зашифрованный снимок
    for (const p of q.photos) {
      const path = _photoPath(p.id);
      const body = new Blob([await encryptBytes(p.blob)]);
      await _retry(() => ydUpload(token, path, body));
      if (q.photos.length > 20) await _sleep(250);   // много фото подряд — не торопим Диск, иначе он блокирует папку
      const fresh = await dbGet('photos', p.id);
      if (fresh) { fresh.uploaded = 1; fresh.remotePath = path; await dbPut('photos', fresh); }
      sent++;
      _notify({ type: 'progress', sent, total: q.photos.length, done: before + sent, all: before + q.photos.length });
    }

    // 2. После проверки Диска отправляем и пустую копию: последняя запись могла быть удалена.
    if (q.dataPending || sent) {
      const dump = await buildDump();
      await _historyCopy(token);   // прежняя копия — в «Историю»
      const body = new Blob([await encryptBytes(JSON.stringify(dump))]);
      await _retry(() => ydUpload(token, ROOT + 'data.bin', body));
      await setMeta('syncedVersion', q.version);
    }

    // 3. Удалённое в приложении (больше 14 дней назад) — в корзину Диска (там тоже только зашифрованное)
    if (q.deletes.length) {
      const live = _livePhotoPaths(await dbAll('orders'), await dbAll('photos'));
      for (const path of q.deletes) {
        // Старые версии могли оставить в очереди фото, уже восстановленное вместе с заявкой.
        if (!live.has(path)) await _retry(() => ydDelete(token, path));
        await setMetaEntries({ pendingDeletes: (list) => (list || []).filter((x) => _pendingDeletePath(x) !== path) });
      }
    }

    await setMeta('lastSync', Date.now());
    await setMeta('syncError', null);
    await setMeta('syncWaiting', false);
    _notify({ type: 'done', sent });
    return { status: 'ok', sent };
  } catch (e) {
    if (e instanceof NetError) {
      await setMeta('syncError', null);   // временное — не ошибка, повторим позже
      await setMeta('syncWaiting', true);
      const why = e instanceof BusyError ? 'busy' : (self.navigator && navigator.onLine === false ? 'offline' : 'net');
      await setMeta('syncWaitWhy', why);
      _notify({ type: 'waiting', why });
      return { status: 'waiting', why, sent, error: e.message };
    }
    await setMeta('syncError', e.message);
    _notify({ type: 'error', error: e.message });
    return { status: 'error', error: e.message };
  }
}

function _notify(msg) {
  try { syncChannel && syncChannel.postMessage(msg); } catch (e) { /* пусто */ }
}

// Восстановить данные из выгрузки (файл или Диск). Фото, которых нет в телефоне, остаются на Диске.
async function restoreDump(d, fromDisk) {
  if (!d || d.app !== 'master-zayavki' || !Array.isArray(d.orders)) throw new Error('Это не файл копии заявок');
  // 1. Проверяем всю копию, пока в телефоне ничего не тронуто
  const bad = (list, need) => !Array.isArray(list) || list.some((x) => !x || typeof x !== 'object' || need.some((k) => x[k] === undefined || x[k] === null || x[k] === ''));
  const uniq = (list) => new Set(list.map((x) => x.id)).size === list.length;
  const expenses = d.expenses || []; const photos = d.photos || [];
  if (bad(d.orders, ['id']) || bad(expenses, ['id']) || bad(photos, ['id', 'orderId']) || !uniq(d.orders) || !uniq(expenses) || !uniq(photos)) {
    throw new Error('Копия повреждена — данные в телефоне не тронуты');
  }
  await withDiskSyncLock(async () => {
    // 2. Фото из телефона не теряем: снимки копии берут картинку из телефона, остальные снимки телефона остаются
    const local = await dbAll('photos');
    const byId = new Map(local.map((p) => [p.id, p]));
    const inDump = new Set(photos.map((p) => p.id));
    const allPhotos = photos.map((p) => ({ ...p, blob: byId.get(p.id)?.blob || null }))
      .concat(local.filter((p) => !inDump.has(p.id)));
    const maxNum = d.orders.reduce((m, o) => Math.max(m, o.num || 0), 0);
    const v = ((await getMeta('dataVersion')) || 0) + 1;
    const live = _livePhotoPaths(d.orders, allPhotos);
    // repeatsMarked сбрасываем: в старой копии (до 1.28) повторные заявки ещё не отмечены
    const meta = {
      nextNum: Math.max(d.nextNum || 1, maxNum + 1), dataVersion: v, repeatsMarked: null,
      pendingDeletes: (list) => (list || []).filter((x) => !live.has(_pendingDeletePath(x))),
    };
    if (fromDisk) meta.syncedVersion = v;
    // 3. Заменяем данные и очередь фото одной операцией, пока отправка ждёт.
    await dbReplaceAll({ orders: d.orders, expenses, photos: allPhotos }, meta);
  });
  // 4. Разметить повторные заявки, если копия старая (в приложении; в фоновой части этой функции нет)
  if (typeof markOldRepeats === 'function') { try { await markOldRepeats(); } catch (e) { console.warn('repeats', e); } }
}
