// Фоновая часть: держит приложение в телефоне для работы без связи
// и отправляет данные на Диск, когда появляется интернет (даже если приложение закрыто).
'use strict';
importScripts('db.js', 'crypto.js', 'sync.js');

// При выпуске новой версии меняется номер здесь, в version.json и APP_VERSION в app.js.
const CACHE = 'zayavki-v23';
const OCR_CACHE = 'zayavki-ocr-v1'; // распознавание шильдика: большие файлы, не перекачиваются при обновлении
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'db.js', 'crypto.js', 'sync.js', 'addr.js', 'ocr.js', 'parse.js', 'streets.json', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'];

self.addEventListener('install', (e) => {
  // cache: 'reload' — берём файлы с сервера, а не из кэша браузера, чтобы не застрять на старой версии
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== OCR_CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Файлы приложения — только из комплекта своей версии. Новый комплект целиком скачивается при установке
// новой версии (install), поэтому новая страница никогда не окажется без своего нового скрипта.
const SHELL_PATHS = new Set(SHELL.map((u) => new URL(u, self.registration.scope).pathname));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('/version.json')) return; // проверка обновления — всегда с сервера
  if (url.pathname.includes('/vendor/ocr/')) {         // не меняются — берём из памяти, с сервера только раз
    e.respondWith(caches.open(OCR_CACHE).then(async (c) => (await c.match(req, { ignoreSearch: true })) ||
      fetch(req).then((res) => { if (res && res.ok) c.put(req, res.clone()); return res; })));
    return;
  }
  const shell = req.mode === 'navigate' || SHELL_PATHS.has(url.pathname);
  const key = req.mode === 'navigate' ? 'index.html' : req;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(key, { ignoreSearch: true });
    if (shell && cached) return cached;            // комплект версии не подменяем по одному файлу
    try {
      const res = await fetch(req);
      if (res && res.ok && !shell) cache.put(key, res.clone());
      return res;
    } catch (err) {
      return cached || new Response('Нет связи', { status: 503 });
    }
  }));
});

async function backgroundSync() {
  const r = await syncNow();
  // Нет связи — пусть браузер повторит попытку позже.
  if (r && r.status === 'waiting') throw new Error(r.error);
}

self.addEventListener('sync', (e) => {
  if (e.tag === 'disk-sync') e.waitUntil(backgroundSync());
});

self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'disk-sync') e.waitUntil(syncNow());
});
