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
    'Что сделано', 'Гарантия, дней', 'По гарантии', 'Взял', 'Расходы (что)', 'Расходы, сумма', 'Чистыми']];
  orders.slice().sort((a, b) => a.num - b.num).forEach((o) => rows.push([
    o.num, _d(o.createdAt), STATUS_RU[o.status] || o.status, _d(o.closedAt), o.name, o.phone, o.address, o.apt,
    o.device, o.model, o.problem, o.workDone, o.warrantyDays || '', o.isWarranty ? 'да' : '',
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
    pendingDeletes: ((await getMeta('pendingDeletes')) || []).length,
    lastSync: await getMeta('lastSync'),
    error: await getMeta('syncError'),
    waiting: await getMeta('syncWaiting'),
    waitWhy: await getMeta('syncWaitWhy'),   // offline | busy | net — почему ждём
  };
}

function syncNow() {
  if (self.navigator && navigator.locks) {
    return navigator.locks.request('zayavki-disk-sync', { ifAvailable: true },
      (lock) => (lock ? _doSync() : { status: 'busy' }));
  }
  return _doSync();
}

async function _pending() {
  const photos = (await dbAll('photos')).filter((p) => !p.uploaded && p.blob);
  const deletes = (await getMeta('pendingDeletes')) || [];
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
      const o = await dbGet('orders', p.orderId);
      if (!o) { await dbDel('photos', p.id); continue; }
      const path = PHOTOS_DIR + '/' + p.id + '.bin';
      const body = new Blob([await encryptBytes(p.blob)]);
      await _retry(() => ydUpload(token, path, body));
      if (q.photos.length > 20) await _sleep(250);   // много фото подряд — не торопим Диск, иначе он блокирует папку
      const fresh = await dbGet('photos', p.id);
      if (fresh) { fresh.uploaded = 1; fresh.remotePath = path; await dbPut('photos', fresh); }
      sent++;
      _notify({ type: 'progress', sent, total: q.photos.length, done: before + sent, all: before + q.photos.length });
    }

    // 2. Удалённое в приложении — в корзину Диска (там тоже только зашифрованное)
    for (const path of q.deletes) {
      await _retry(() => ydDelete(token, path));
      const left = ((await getMeta('pendingDeletes')) || []).filter((x) => x !== path);
      await setMeta('pendingDeletes', left);
    }

    // 3. Сами данные. Пустую копию не отправляем, чтобы новый телефон не затёр копию на Диске.
    if (q.dataPending || sent) {
      const dump = await buildDump();
      if (dump.orders.length || dump.expenses.length) {
        const body = new Blob([await encryptBytes(JSON.stringify(dump))]);
        await _retry(() => ydUpload(token, ROOT + 'data.bin', body));
      }
      await setMeta('syncedVersion', q.version);
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
  const localPhotos = new Map((await dbAll('photos')).map((p) => [p.id, p]));
  await dbClear('orders');
  await dbClear('expenses');
  await dbClear('photos');
  for (const o of d.orders) await dbPut('orders', o);
  for (const e of (d.expenses || [])) await dbPut('expenses', e);
  for (const p of (d.photos || [])) {
    const local = localPhotos.get(p.id);
    await dbPut('photos', { ...p, blob: local ? local.blob : null });
  }
  const maxNum = d.orders.reduce((m, o) => Math.max(m, o.num || 0), 0);
  await setMeta('nextNum', Math.max(d.nextNum || 1, maxNum + 1));
  const v = await markDirty();
  if (fromDisk) await setMeta('syncedVersion', v);
}
