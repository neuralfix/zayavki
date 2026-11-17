// Шифрование. Всё, что уходит с телефона (Яндекс Диск, файл копии), шифруется паролем мастера.
// AES-GCM 256 бит, ключ получается из пароля (PBKDF2-SHA256). Сам пароль нигде не хранится:
// в телефоне лежит только готовый ключ, и браузер не отдаёт его наружу даже самому приложению.
// Используется и страницей, и фоновым service worker.
'use strict';

const ENC_MAGIC = 'MZE1';
const ENC_ITER = 310000;
const ENC_HEAD = 4 + 4 + 16 + 12; // метка, число итераций, соль, IV

class WrongPassword extends Error {}

async function deriveKey(password, salt, iter) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function getEnc() {
  const key = await getMeta('encKey');
  const salt = await getMeta('encSalt');
  const iter = await getMeta('encIter');
  return key && salt && iter ? { key, salt: new Uint8Array(salt), iter } : null;
}
async function hasPassword() { return !!(await getEnc()); }

async function _rawEncrypt(key, salt, iter, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  const out = new Uint8Array(ENC_HEAD + ct.byteLength);
  out.set(new TextEncoder().encode(ENC_MAGIC), 0);
  new DataView(out.buffer).setUint32(4, iter);
  out.set(salt, 8);
  out.set(iv, 24);
  out.set(new Uint8Array(ct), ENC_HEAD);
  return out;
}

// Запомнить ключ на этом телефоне. Проверочная запись нужна, чтобы потом проверить, помнит ли мастер пароль.
async function _adoptKey(key, salt, iter) {
  const prev = await getEnc();
  await setMeta('encKey', key);
  await setMeta('encSalt', salt);
  await setMeta('encIter', iter);
  await setMeta('encCheck', await _rawEncrypt(key, salt, iter, new TextEncoder().encode('ok')));
  // Ключ сменился — то, что уже лежит на Диске, зашифровано старым. Отправим фото из телефона заново.
  if (prev && !_same(prev.salt, salt)) {
    for (const p of await dbAll('photos')) {
      if (p.blob && p.uploaded) { p.uploaded = 0; await dbPut('photos', p); }
    }
    await markDirty();
  }
}

async function setPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt, ENC_ITER);
  await _adoptKey(key, salt, ENC_ITER);
}

async function checkPassword(password) {
  const enc = await getEnc();
  const check = await getMeta('encCheck');
  if (!enc || !check) return false;
  const info = encInfo(check);
  const key = await deriveKey(password, enc.salt, enc.iter);
  try { await crypto.subtle.decrypt({ name: 'AES-GCM', iv: info.iv }, key, info.ct); return true; } catch (e) { return false; }
}

// data: Blob, строка или байты. Возвращает зашифрованные байты (Uint8Array).
async function encryptBytes(data) {
  const enc = await getEnc();
  if (!enc) throw new Error('Не задан пароль для шифрования');
  const plain = typeof data === 'string' ? new TextEncoder().encode(data)
    : (data instanceof Blob ? await data.arrayBuffer() : data);
  return _rawEncrypt(enc.key, enc.salt, enc.iter, plain);
}

function encInfo(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < ENC_HEAD + 16 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== ENC_MAGIC) return null;
  return {
    iter: new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(4),
    salt: b.slice(8, 24), iv: b.slice(24, ENC_HEAD), ct: b.slice(ENC_HEAD),
  };
}

function _same(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Расшифровать. Если копия сделана с другим паролем (или на этом телефоне пароля ещё нет),
// спрашивает пароль через askPassword(номерПопытки). Подошедший пароль становится паролем этого телефона.
async function decryptBytes(bytes, askPassword) {
  const info = encInfo(bytes);
  if (!info) throw new Error('Файл не похож на копию из приложения');
  const enc = await getEnc();
  if (enc && _same(enc.salt, info.salt)) {
    try { return await crypto.subtle.decrypt({ name: 'AES-GCM', iv: info.iv }, enc.key, info.ct); } catch (e) { /* спросим пароль */ }
  }
  if (!askPassword) throw new WrongPassword('Зашифровано другим паролем');
  for (let attempt = 0; ; attempt++) {
    const pw = await askPassword(attempt);
    if (pw == null) throw new Error('Отменено');
    const key = await deriveKey(pw, info.salt, info.iter);
    let plain;
    try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: info.iv }, key, info.ct); } catch (e) { continue; }
    await _adoptKey(key, info.salt, info.iter);
    return plain;
  }
}

function toBase64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64) {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
