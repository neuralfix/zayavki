// Синхронизация с Яндекс Диском. Работает и со страницы, и из фона (service worker).
// Всё складывается в папку приложения: «Диск / Приложения / <имя приложения>».
'use strict';

const YD_API = 'https://cloud-api.yandex.net/v1/disk';
const ROOT = 'app:/';
const ORDERS_DIR = 'app:/Заявки';
const syncChannel = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('zayavki-sync') : null;

class NetError extends Error {}
class AuthError extends Error {}

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
  if (!(u.ok || u.status === 201 || u.status === 202)) throw new Error('Яндекс Диск: файл не принят (' + u.status + ')');
}

async function ydDelete(token, path) {
  const r = await ydFetch(token, '/resources?permanently=false&path=' + encodeURIComponent(path), { method: 'DELETE' });
  if (r.ok || r.status === 202 || r.status === 204 || r.status === 404) return;
  await ydFail(r);
}

async function ydDownloadText(token, path) {
  const r = await ydFetch(token, '/resources/download?path=' + encodeURIComponent(path));
  if (r.status === 404) return null;
  if (!r.ok) await ydFail(r);
  const { href } = await r.json();
  let d;
  try { d = await fetch(href); } catch (e) { throw new NetError('Не удалось скачать файл с Диска'); }
  if (!d.ok) throw new Error('Яндекс Диск: файл не скачан (' + d.status + ')');
  return d.text();
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
const STATUS_RU = { open: 'В работе', closed: 'Закрыта', cancelled: 'Отменена' };

function ordersCsv(orders) {
  const rows = [['№', 'Создана', 'Статус', 'Закрыта', 'Имя', 'Телефон', 'Адрес', 'Техника', 'Модель', 'Проблема',
    'Что сделано', 'Взял', 'Расходы (что)', 'Расходы, сумма', 'Чистыми']];
  orders.slice().sort((a, b) => a.num - b.num).forEach((o) => rows.push([
    o.num, _d(o.createdAt), STATUS_RU[o.status] || o.status, _d(o.closedAt), o.name, o.phone, o.address,
    o.device, o.model, o.problem, o.workDone, o.income || 0,
    (o.costs || []).map((c) => (c.name || 'расход') + ' ' + c.amount).join(', '),
    orderCosts(o), o.status === 'open' ? '' : orderNet(o),
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

function orderFolderName(o) {
  const parts = [String(o.num).padStart(4, '0'), o.name, o.address].filter(Boolean).join(' ');
  return parts.replace(/[\\/:*?"<>|#%{}~&]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);
}

// ---------- Синхронизация ----------

async function syncStatus() {
  const token = await getMeta('ydToken');
  const photos = await dbAll('photos');
  const pendingPhotos = photos.filter((p) => !p.uploaded && p.blob).length;
  const dataVersion = (await getMeta('dataVersion')) || 0;
  const syncedVersion = (await getMeta('syncedVersion')) || 0;
  return {
    connected: !!token,
    pendingPhotos,
    dataPending: dataVersion !== syncedVersion,
    pendingDeletes: ((await getMeta('pendingDeletes')) || []).length,
    lastSync: await getMeta('lastSync'),
    error: await getMeta('syncError'),
    waiting: await getMeta('syncWaiting'),
  };
}

function syncNow() {
  if (self.navigator && navigator.locks) {
    return navigator.locks.request('zayavki-disk-sync', { ifAvailable: true },
      (lock) => (lock ? _doSync() : { status: 'busy' }));
  }
  return _doSync();
}

async function _doSync() {
  const token = await getMeta('ydToken');
  if (!token) return { status: 'off' };

  const photos = (await dbAll('photos')).filter((p) => !p.uploaded && p.blob);
  const deletes = (await getMeta('pendingDeletes')) || [];
  const versionAtStart = (await getMeta('dataVersion')) || 0;
  const dataPending = versionAtStart !== ((await getMeta('syncedVersion')) || 0);
  if (!photos.length && !deletes.length && !dataPending) {
    await setMeta('syncWaiting', false);
    return { status: 'nothing' };
  }

  _notify({ type: 'start' });
  let sent = 0;
  try {
    await ydMkdir(token, ROOT);
    await ydMkdir(token, ORDERS_DIR);

    // 1. Фото — по папкам заявок
    const madeDirs = new Set();
    for (const p of photos) {
      const o = await dbGet('orders', p.orderId);
      if (!o) { await dbDel('photos', p.id); continue; }
      if (!o.remoteFolder) {
        o.remoteFolder = orderFolderName(o);
        await dbPut('orders', o);
      }
      const dir = ORDERS_DIR + '/' + o.remoteFolder;
      if (!madeDirs.has(dir)) { await ydMkdir(token, dir); madeDirs.add(dir); }
      const name = (p.kind === 'contract' ? 'договор-' : 'фото-') + p.id.slice(0, 8) + '.jpg';
      const path = dir + '/' + name;
      await ydUpload(token, path, p.blob);
      const fresh = await dbGet('photos', p.id);
      if (fresh) { fresh.uploaded = 1; fresh.remotePath = path; await dbPut('photos', fresh); }
      sent++;
      _notify({ type: 'progress', sent, total: photos.length });
    }

    // 2. Удалённое в приложении — в корзину Диска
    for (const path of deletes) {
      await ydDelete(token, path);
      const left = ((await getMeta('pendingDeletes')) || []).filter((x) => x !== path);
      await setMeta('pendingDeletes', left);
    }

    // 3. Сами данные + таблицы для Excel
    if (dataPending || sent) {
      const dump = await buildDump();
      await ydUpload(token, ROOT + 'data.json', new Blob([JSON.stringify(dump)], { type: 'application/json' }));
      await ydUpload(token, ROOT + 'Заявки.csv', new Blob([ordersCsv(dump.orders)], { type: 'text/csv' }));
      await ydUpload(token, ROOT + 'Расходы.csv', new Blob([expensesCsv(dump.expenses)], { type: 'text/csv' }));
      await setMeta('syncedVersion', versionAtStart);
    }

    await setMeta('lastSync', Date.now());
    await setMeta('syncError', null);
    await setMeta('syncWaiting', false);
    _notify({ type: 'done', sent });
    return { status: 'ok', sent };
  } catch (e) {
    if (e instanceof NetError) {
      await setMeta('syncWaiting', true);
      _notify({ type: 'waiting' });
      return { status: 'waiting', error: e.message };
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
