// Считывание модели с фото шильдика. Работает прямо в телефоне (Tesseract), фото никуда не отправляется.
// Файлы распознавания (~10 МБ) лежат в vendor/ocr, скачиваются один раз и дальше работают без интернета.
'use strict';

const OCR_BASE = new URL('vendor/ocr/', location.href).href;
const OCR_FILES = ['tesseract.min.js', 'worker.min.js', 'tesseract-core-simd-lstm.wasm.js', 'eng.traineddata.gz', 'rus.traineddata.gz'];
let _ocrWorker = null;
let _ocrProgress = null;

function _loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve;
    s.onerror = () => reject(new Error('Не удалось загрузить распознавание. Первый раз нужен интернет.'));
    document.head.appendChild(s);
  });
}

async function _getOcrWorker() {
  if (_ocrWorker) return _ocrWorker;
  if (!window.Tesseract) await _loadScript(OCR_BASE + 'tesseract.min.js');
  _ocrWorker = await Tesseract.createWorker('eng+rus', 1, {
    workerPath: OCR_BASE + 'worker.min.js', corePath: OCR_BASE, langPath: OCR_BASE, workerBlobURL: false,
    logger: (m) => _ocrProgress && _ocrProgress(m),
  });
  await _ocrWorker.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' }); // разрозненный текст наклейки
  return _ocrWorker;
}

// Заранее скачать файлы распознавания, чтобы потом работало без интернета (один раз, в фоне)
async function prefetchOcr() {
  try {
    if (!navigator.onLine || !('caches' in window)) return;
    const c = await caches.open('zayavki-ocr-v1');
    for (const f of OCR_FILES) if (!(await c.match(OCR_BASE + f))) await fetch(OCR_BASE + f);
  } catch (e) { /* в другой раз */ }
}

// Фото → холст в оттенках серого. mode 'bw' — ещё и чёрно-белый с лёгким сглаживанием (для мутных фото).
async function _plateCanvas(blob, rotate, mode) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k); const h = Math.round(bmp.height * k);
  const c = document.createElement('canvas');
  const turn = rotate === 90 || rotate === 270;
  c.width = turn ? h : w; c.height = turn ? w : h;
  const g = c.getContext('2d');
  g.translate(c.width / 2, c.height / 2); g.rotate((rotate || 0) * Math.PI / 180);
  if (mode === 'bw') g.filter = 'blur(1px)';
  g.drawImage(bmp, -w / 2, -h / 2, w, h);
  g.filter = 'none';
  bmp.close && bmp.close();
  g.setTransform(1, 0, 0, 1, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height); const d = img.data;
  const hist = new Array(256).fill(0);
  let lo = 255, hi = 0;
  for (let i = 0; i < d.length; i += 4) {
    const y = Math.round((d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000);
    d[i] = y; hist[y]++; if (y < lo) lo = y; if (y > hi) hi = y;
  }
  let cut = -1;
  if (mode === 'bw') { // порог Оцу
    const total = d.length / 4; let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sB = 0, wB = 0, best = 0;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue; const wF = total - wB; if (!wF) break;
      sB += t * hist[t]; const mB = sB / wB; const mF = (sum - sB) / wF; const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; cut = t; }
    }
  }
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const v = cut >= 0 ? (d[i] > cut ? 255 : 0) : (d[i] - lo) * 255 / span;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  g.putImageData(img, 0, 0);
  return c;
}

// ---------- Разбор текста ----------
const OCR_BRANDS = ['Samsung', 'LG', 'Atlant', 'Indesit', 'Bosch', 'Siemens', 'Beko', 'Haier', 'Hotpoint', 'Ariston', 'Stinol',
  'Liebherr', 'Electrolux', 'Whirlpool', 'Candy', 'Gorenje', 'Sharp', 'Hisense', 'Zanussi', 'Pozis', 'Biryusa', 'Nord',
  'Daewoo', 'Midea', 'TCL', 'Xiaomi', 'Philips', 'Sony', 'Panasonic', 'Toshiba', 'Dexp', 'BBK', 'Supra', 'Thomson',
  'Telefunken', 'Polar', 'Weissgauff', 'Kuppersberg', 'AEG', 'Vestel', 'Smeg', 'Hansa', 'Korting', 'Shivaki', 'Leran',
  'Hyundai', 'Asko', 'Miele', 'Maunfeld', 'Hitachi', 'Mitsubishi', 'Sanyo', 'Vestfrost', 'Snaige', 'Saratov', 'Sviyaga',
  'Minsk', 'Bauknecht', 'Kaiser', 'Neff', 'Grundig', 'Akai', 'Erisson', 'Harper', 'Yandex', 'Tesler', 'Skyworth'];
const OCR_BRAND_RU = { 'АТЛАНТ': 'Atlant', 'БИРЮСА': 'Biryusa', 'ПОЗИС': 'Pozis', 'СТИНОЛ': 'Stinol', 'САРАТОВ': 'Saratov',
  'СВИЯГА': 'Sviyaga', 'МИНСК': 'Minsk', 'НОРД': 'Nord', 'ИНДЕЗИТ': 'Indesit', 'АРИСТОН': 'Ariston' };
// Похожие буквы: в модели «ХМ 4021» и «XM 4021» — одно и то же. Модели пишем латиницей.
const CYR2LAT = { 'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'У': 'Y', 'З': '3', 'Ё': 'E' };
const _lat = (s) => s.toUpperCase().replace(/[А-ЯЁ]/g, (ch) => CYR2LAT[ch] || ch);

function _lev(a, b) {
  const m = a.length; const n = b.length; if (Math.abs(m - n) > 1) return 9;
  const row = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= n; j++) { const t = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return row[n];
}

function _findBrand(words) {
  for (const w of words) {
    const u = w.toUpperCase().replace(/[^A-ZА-ЯЁ0-9]/g, '');
    if (u.length < 2) continue;
    const L = _lat(u); // на шильдике бывают вперемешку русские и латинские буквы
    for (const [ru, b] of Object.entries(OCR_BRAND_RU)) { const R = _lat(ru); if (L === R || (R.length >= 5 && _lev(L, R) <= 1)) return b; }
    for (const b of OCR_BRANDS) {
      const B = b.toUpperCase();
      if (L === B || (B.length >= 5 && _lev(L, B) <= 1)) return b;
    }
  }
  return '';
}

// Не модель: напряжение, мощность, частота, хладагент, класс защиты, вес, дата
const OCR_NOT_MODEL = [/^\d+([.,]\d+)?(V|VAC|W|KW|KWH|HZ|KG|L|A|MA|MM|CM|G|DB|DBA|BAR|MPA)$/, /^\d{2,3}[-/~]\d{2,3}V/,
  /^R-?\d{3}[A-Z]?$/, /^IP\d{1,2}$/, /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/, /^(SN|S\/N|SIN)\b/, /^CLASS/, /^\d+([-/.]\d+)*$/];
const OCR_KEY = /(MODEL|MODE1|M0DEL|MOD[.:]|TYPE|TYP\b|МОДЕЛЬ|МОДЕЛ|ТИП\b)/i;
const OCR_SERIAL = /(SERIAL|S\/N|\bSN\b|\bSIN\b|№|\bNO[.:]|ЗАВ|СЕРИЙ|BAR ?CODE)/i;

function plateCandidates(text) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.replace(/[^A-Za-zА-Яа-яЁё0-9]/g, '').length >= 3);
  const brand = _findBrand(lines.join(' ').split(' '));
  const score = new Map();
  const add = (raw, s) => {
    const t = _lat(raw).replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, '');
    if (t.length < 4 || t.length > 22) return;
    if (/[^A-Z0-9\-/. ]/.test(t)) return;            // мусор распознавания
    if (!/\d/.test(t) || !/[A-Z]/.test(t)) return;   // модель — это буквы и цифры вместе
    if (OCR_NOT_MODEL.some((r) => r.test(t))) return;
    if (brand && t === brand.toUpperCase()) return;
    let v = s;
    const dig = (t.match(/\d/g) || []).length / t.length;
    if (dig > 0.75 && t.length > 9) v -= 3;          // похоже на серийный номер
    if (/^[A-Z]{1,5}[- ]?\d/.test(t)) v += 1;        // буквы, потом цифры — обычный вид модели
    if (t.length >= 6 && t.length <= 16) v += 1;
    score.set(t, Math.max(score.get(t) ?? -99, v));
  };
  lines.forEach((l) => {
    const key = OCR_KEY.exec(l);
    const serial = OCR_SERIAL.test(l) && !key;
    const base = key ? 1 : serial ? -4 : 0;
    const after = key ? l.slice(key.index + key[0].length) : '';
    // «ХМ 4021-000», «GA B419» — короткие буквы отдельно от цифр
    for (const m of l.matchAll(/(?:^|\s)([A-Za-zА-ЯЁа-яё]{1,4})[\s-](\d{3,5}(?:[-/.]\d{1,4})*[A-Za-z0-9]{0,6})(?=\s|$)/g)) {
      add(m[1] + ' ' + m[2], base + (key ? 3 : 1));
    }
    for (const w of l.split(' ')) add(w.replace(/[:;,]/g, ''), base + (key && after.includes(w) ? 3 : 0));
  });
  const models = [...score.entries()].filter(([, v]) => v > -2).sort((a, b) => b[1] - a[1]).map(([t]) => t)
    .filter((t, i, arr) => !arr.slice(0, i).some((x) => x.includes(t))).slice(0, 4);
  return { brand, models, lines: lines.slice(0, 14) };
}

// Распознать фото. onStep(текст) — для надписи на кнопке.
async function readPlate(blob, onStep) {
  let pass = 0;
  _ocrProgress = (m) => {
    if (m.status === 'recognizing text') onStep && onStep('Читаю… ' + (pass > 1 ? '(' + pass + ') ' : '') + Math.round((m.progress || 0) * 100) + '%');
    else if (/load|initializ/.test(m.status || '')) onStep && onStep('Готовлю распознавание…');
  };
  try {
    const w = await _getOcrWorker();
    const run = async (rot, mode) => {
      pass++;
      const { data } = await w.recognize(await _plateCanvas(blob, rot, mode));
      const r = plateCandidates(data.text);
      r.confidence = data.confidence; r.rot = rot;
      r.rank = data.confidence + (r.models.length ? 15 : 0) + (r.brand ? 5 : 0);
      return r;
    };
    let best = await run(0);
    // Фото могло быть снято боком — пробуем повернуть, если прочиталось плохо
    if (best.confidence < 75 || !best.models.length) {
      for (const rot of [90, 270]) {
        const r = await run(rot);
        if (r.rank > best.rank) best = r;
        if (r.confidence >= 75 && r.models.length) break;
      }
    }
    // Мутное фото — ещё раз в чёрно-белом
    if (best.confidence < 75 || !best.models.length) {
      const r = await run(best.rot, 'bw');
      if (r.rank > best.rank) best = r;
    }
    return best;
  } finally { _ocrProgress = null; }
}
