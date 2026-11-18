// Считывание модели с фото шильдика: через Яндекс (функция владельца в Яндекс Облаке) или прямо в телефоне (Tesseract).
// Файлы распознавания (~10 МБ) лежат в vendor/ocr — запасной вариант без интернета. Точно читает Яндекс через функцию владельца.
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
async function _plateCanvas(blob, rotate, mode, maxSide = 2200) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
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

// ---------- Разбор текста: где на наклейке марка, а где модель ----------
const OCR_BRANDS = ['Samsung', 'LG', 'Atlant', 'Indesit', 'Bosch', 'Siemens', 'Beko', 'Haier', 'Hotpoint', 'Ariston', 'Stinol',
  'Liebherr', 'Electrolux', 'Whirlpool', 'Candy', 'Gorenje', 'Sharp', 'Hisense', 'Zanussi', 'Pozis', 'Biryusa', 'Nord',
  'Daewoo', 'Midea', 'TCL', 'Xiaomi', 'Philips', 'Sony', 'Panasonic', 'Toshiba', 'Dexp', 'BBK', 'Supra', 'Thomson',
  'Telefunken', 'Polar', 'Weissgauff', 'Kuppersberg', 'AEG', 'Vestel', 'Smeg', 'Hansa', 'Korting', 'Shivaki', 'Leran',
  'Hyundai', 'Asko', 'Miele', 'Maunfeld', 'Hitachi', 'Mitsubishi', 'Sanyo', 'Vestfrost', 'Snaige', 'Saratov', 'Sviyaga',
  'Minsk', 'Bauknecht', 'Kaiser', 'Neff', 'Grundig', 'Akai', 'Erisson', 'Harper', 'Yandex', 'Tesler', 'Skyworth'];
// Русские названия: показываем как на наклейке
const OCR_BRAND_RU = { 'АТЛАНТ': 'Атлант', 'БИРЮСА': 'Бирюса', 'ПОЗИС': 'Позис', 'СТИНОЛ': 'Стинол', 'САРАТОВ': 'Саратов',
  'СВИЯГА': 'Свияга', 'МИНСК': 'Минск', 'НОРД': 'Норд', 'ИНДЕЗИТ': 'Индезит', 'ЗИЛ': 'ЗИЛ', 'ДОНБАСС': 'Донбасс',
  'ОКА': 'Ока', 'ЮРЮЗАНЬ': 'Юрюзань', 'СМОЛЕНСК': 'Смоленск', 'ОРСК': 'Орск', 'ПОЛЮС': 'Полюс', 'МИР': 'Мир' };
// Похожие буквы: «ХМ-4021» и «XM-4021» — одно и то же; если слово целиком из таких букв — пишем латиницей
const CYR2LAT = { 'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'У': 'Y', 'Ё': 'E' };
const _lat = (s) => s.toUpperCase().replace(/[А-ЯЁ]/g, (ch) => CYR2LAT[ch] || ch);
const _latIfCan = (s) => { const l = _lat(s); return /[А-ЯЁ]/.test(l) ? s.toUpperCase() : l; };

function _lev(a, b) {
  const m = a.length; const n = b.length; if (Math.abs(m - n) > 1) return 9;
  const row = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= n; j++) { const t = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return row[n];
}

// Слово → марка или ''
function _brandOf(w) {
  const u = String(w).toUpperCase().replace(/[^A-ZА-ЯЁ0-9]/g, '');
  if (u.length < 2) return '';
  for (const [ru, b] of Object.entries(OCR_BRAND_RU)) if (u === ru || (ru.length >= 6 && _lev(u, ru) <= 1)) return b;
  const L = _lat(u); // на наклейке бывают вперемешку русские и латинские буквы
  for (const b of OCR_BRANDS) { const B = b.toUpperCase(); if (L === B || (B.length >= 6 && _lev(L, B) <= 1)) return b; }
  return '';
}

// Что точно не модель: напряжение, мощность, частота, вес, объём, хладагент, класс, даты, стандарты, типы по ГОСТ
const OCR_NOT_MODEL = [/^\d+([.,]\d+)?(V|VAC|W|KW|KWH|HZ|KG|L|A|MA|MM|CM|G|DB|DBA|BAR|MPA|LM|В|ВТ|КВТ|ГЦ|КГ|Л|А|МА|ММ|СМ|Г|ДМ3|DM3|ГР)$/,
  /^\d{2,3}[-/~]\d{2,3}(V|В|B)/, /\/(24H|24Ч|СУТ|DAY)$/, /^KГ?G?\/\d/, /^KG\/\d/, /^(R|ХЛАДОН|XЛAДOH|FREON|ФРЕОН)[-.]?\d/, /CH3/, /^IP\d/, /^УХЛ/, /^FD:?\d{4}$/,
  /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/, /^\d+([-/.]\d+)*$/, /^(SN|S\/N|SIN|N|NO)\d/, /^(CLASS|КЛАСС)/, /^(РБ|УП|EN|ТУ|ГОСТ|СТБ)\d/,
  /^\d+[.,]\d+$/, /^A\+*$/, /^\d+([.,]\d+)?(BT|KBT|B|KГ|БАР|BAR|DM|ДM|M3)$/, /(РБ|УП|PБ|YП)\d{2}/, /[A-ZА-ЯЁ]\.[A-ZА-ЯЁ]\./,
  /^\d+([.,]\d+)?\/\d+([.,]\d+)?(DM|ДM|ДМ|Л|L|БАР|BAR)?$/, /^(ДМ|ДM|DM|M)3$/, /^\d+(Л|L)?\/\d+(Л|L)$/];
// Единицы и подписи — не начало модели: «Hz 110», «W 210W», «Max 15W»
const OCR_UNIT_WORD = /^(HZ|W|V|A|L|G|KG|MAX|BT|ГЦ|KГ|Л|Г|B|DM|ДM|БAP|BAR|N|NO|TY|ГOCT|CTБ|EN|R|IP|YXЛ|SN|ST|T|C|Д)$/;
const OCR_KEY = /(MODEL(UL)?|MODE1|M0DEL|MOD\s*[.:]|E-?NR\.?|МОДЕЛЬ)\s*[:.]?/i;
const OCR_TYPE_KEY = /(TYPE\b|TYP\b|ТИП(?![А-Яа-яЁё]))\s*[:.]?/i;   // «Тип» — слабее «Модели»
const OCR_SERIAL = /(SERIAL(\s*NO)?|S\/N|\bSN\b|№|N°|(^|\s)N\.?\s+(?=\d)|\bNO[.:]|ЗАВ\.?|СЕРИЙН\S*\s*НОМЕР|I\.C\.|Z-NR|BAR\s?CODE|ДАТА)/i;
const OCR_STD = /(^|\s)(ТУ|TU|ГОСТ|СТБ|EN)(\s+РБ)?\s+\d/i;
const OCR_DEVICE = /(ХОЛОДИЛЬНИК|МОРОЗИЛЬНИК|REFRIGERATOR|FREEZER|СТИРАЛЬН|WASHING|ТЕЛЕВИЗОР|ЛАРЬ)/i;
const OCR_GOST_TYPE = /^(КШД|КШТ|МКШ|КШ|КС|КХ|МК|ДХ)[-\s]?\d/;

function plateCandidates(text) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\s+/g, ' ').replace(/\s*[–—-]\s*/g, '-').trim())
    .filter((l) => l.replace(/[^A-Za-zА-Яа-яЁё0-9]/g, '').length >= 2);
  let brand = '';
  for (const w of lines.join(' ').split(/[^A-Za-zА-Яа-яЁё0-9]+/)) { brand = _brandOf(w); if (brand) break; }
  const score = new Map();
  const add = (raw, s, afterBrand) => {
    let t = String(raw).replace(/[«»"“”„()[\]{}]/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/^[^A-Za-zА-Яа-яЁё0-9]+|[^A-Za-zА-Яа-яЁё0-9]+$/g, '');
    t = _latIfCan(t);
    if (t.replace(/[^A-ZА-ЯЁ0-9]/g, '').length < 3 || t.length > 24) return;
    if (/[^A-ZА-ЯЁ0-9\-/. ]/.test(t) || !/\d/.test(t)) return;
    const c = t.replace(/\s+/g, '');
    if (afterBrand && /^\d{2,5}$/.test(c)) { score.set(t, Math.max(score.get(t) ?? -99, s)); return; } // «Бирюса 118»
    if (OCR_NOT_MODEL.some((r) => r.test(c))) return;
    let v = s;
    const dig = (t.match(/\d/g) || []).length / t.replace(/\W/g, '').length;
    if (dig > 0.75 && t.length > 8) v -= 3;            // похоже на серийный номер
    if (!/[A-ZА-ЯЁ]/.test(t)) v -= 2;                    // одни цифры — модель только рядом с маркой
    if (OCR_GOST_TYPE.test(t)) v -= 3;                   // КШД-280/45 — тип по ГОСТ, не модель
    if (t.length >= 5 && t.length <= 16) v += 1;
    score.set(t, Math.max(score.get(t) ?? -99, v));
  };
  let keyNext = 0, devNext = 0;
  lines.forEach((l) => {
    const U = l.toUpperCase();
    const tokens = l.split(' ');
    // позиции: после «Модель:», после номера (серийный), после ТУ/ГОСТ, после слова «Холодильник»
    const key = OCR_KEY.exec(l) || OCR_TYPE_KEY.exec(l); const keyEnd = key ? key.index + key[0].length : -1;
    const keyW = key && OCR_KEY.test(l) ? 4 : 2;
    const ser = OCR_SERIAL.exec(l); const serAt = ser ? ser.index : Infinity;
    const std = OCR_STD.exec(l); const stdAt = std ? std.index : Infinity;
    const dev = OCR_DEVICE.exec(U); const devEnd = dev ? dev.index + dev[0].length : -1;
    const bonusAt = (pos) => (pos >= serAt || pos >= stdAt) ? -6 : (key && pos >= keyEnd ? keyW : 0) + (dev && pos >= devEnd ? 2 : 0) + keyNext + devNext;
    let pos = 0, first = true;
    tokens.forEach((tk, i) => {
      const at = l.indexOf(tk, pos); pos = at + tk.length;
      // марка, а за ней модель: «Бирюса 118», «POZIS RK FNF-172», «STINOL-104»
      const head = tk.split(/[-«»"]/).filter(Boolean)[0] || '';
      if (head && _brandOf(head) && /\d/.test(tk.slice(tk.indexOf(head) + head.length))) add(tk, 5); // «STINOL-104»
      if (_brandOf(tk.split(/[-«»"]/)[0])) {
        const rest = tokens.slice(i + 1, i + 4).join(' ').split(/\s(?=(?:КШ|УХЛ|ТУ|ГОСТ|№|N\s))/)[0];
        if (/\d/.test(rest) && at < serAt && at < stdAt) add(rest, 5 + (dev ? 1 : 0), true);
      }
      const b = bonusAt(at) + (first ? 1 : 0);
      add(tk, b);
      if (/^[«"„“]/.test(tk) || /[»"”]$/.test(tk)) add(tk, b + 3);      // модель в кавычках: «ЗИЛ-63»
      if (/\d/.test(tk)) first = false;
    });
    // «ХМ 4021-000», «GA B419» — короткие буквы отдельно от цифр
    for (const m of l.matchAll(/(?:^|\s)([A-ZА-ЯЁ]{1,4})[\s-](\d{2,5}(?:[-/.]\d{1,4})*[A-Za-z0-9]{0,6})(?=\s|$)/g)) {
      if (!OCR_UNIT_WORD.test(_lat(m[1]))) add(m[1] + '-' + m[2], bonusAt(l.indexOf(m[0].trim())) + 1);
    }
    // строка, где только модель: «ITF 020 S», «ES 15 A», «HBD1201.3XNFH»
    if (l.length <= 16 && tokens.length <= 3 && /\d/.test(l) && /[A-Za-zА-Яа-я]/.test(l) && !ser && !std &&
      !tokens.some((x) => /^(\d+([.,]\d+)?(V|VAC|W|KW|HZ|KG|ГЦ|ВТ|КГ)|\d{2,3}[-/~]\d{2,3}V|R-?\d{2,3}A?)$/i.test(_lat(x))) &&   // «220V 50Hz R600a» — это характеристики, не модель
      !OCR_UNIT_WORD.test(_lat(tokens[0])) && !_brandOf(tokens[0])) add(l, 3 + keyNext + devNext);
    keyNext = key && !/\d/.test(l.slice(keyEnd)) ? 3 : 0;  // «Модель/Үлгісі» — а сама модель на следующей строке
    devNext = dev && !/\d/.test(l.slice(devEnd)) ? 2 : 0;  // «ХОЛОДИЛЬНИК» — модель строкой ниже
  });
  const B = brand ? _lat(brand.toUpperCase()) : '';
  const models = [...score.entries()].filter(([, v]) => v > -1).sort((a, b) => b[1] - a[1]).map(([t]) => t)
    .filter((t, i, arr) => !arr.slice(0, i).some((x) => x.replace(/\W/g, '').includes(t.replace(/\W/g, ''))))
    .filter((t) => !B || _lat(t) !== B).slice(0, 4);
  return { brand, models, lines: lines.slice(0, 16), device: plateDevice(text) };
}

// Вид техники по словам на шильдике. Посудомойка и прочее — не угадываем.
const PLATE_DEVICE = [
  ['Холодильник', /(ХОЛОДИЛЬН|МОРОЗИЛЬН|REFRIGERAT|FRIDGE|FREEZER|K[UÜ]HL)/i],
  ['Стиральная машина', /(СТИРАЛЬН|WASHING\s*MACHINE|WASCHMASCHINE|LAVATRICE|LAVE-?LINGE|(^|[^A-Z])WASHER)/i],
  ['Телевизор', /(ТЕЛЕВИЗ|TELEVISION|(LED|LCD|SMART|COLOU?R)\s*TV(?![A-Z]))/i],
];
function plateDevice(text) {
  const raw = String(text || '');
  if (/(DISH\s*WASHER|ПОСУДОМО)/i.test(raw)) return '';
  const cyr = raw.toUpperCase().replace(/[ABEKMHOPCTXY]/g, (ch) => ({ A: 'А', B: 'В', E: 'Е', K: 'К', M: 'М', H: 'Н', O: 'О', P: 'Р', C: 'С', T: 'Т', X: 'Х', Y: 'У' })[ch]);
  let best = '', at = Infinity;
  for (const [name, re] of PLATE_DEVICE) {
    for (const t of [raw, cyr]) {   // местное чтение путает буквы: «XOЛOДИЛЬHИK» латиницей
      const m = t.match(re);
      if (m && m.index < at) { at = m.index; best = name; }
    }
  }
  return best;
}

// Марка + модель для записи в заявку (без повтора: «STINOL-104», а не «Stinol STINOL-104»)
function plateLabel(brand, model) {
  if (!brand) return model;
  const b = _lat(brand.toUpperCase());
  return _lat(model.toUpperCase()).startsWith(b) ? model : brand + ' ' + model;
}

// ---------- Распознавание через Яндекс (ваша функция в Яндекс Облаке) ----------
async function ocrCloudConf() {
  const url = await getMeta('ocrUrl'); const key = await getMeta('ocrKey');
  return url && key ? { url, key } : null;
}

// Фото заново сжимается: так из него пропадает место съёмки и прочие служебные данные
async function _jpegBase64(blob) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  return c.toDataURL('image/jpeg', 0.88).split(',')[1];
}

async function cloudOcrText(blob, conf) {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 40000);
  try {
    const r = await fetch(conf.url, { method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'X-App-Key': conf.key },
      body: JSON.stringify({ key: conf.key, image: await _jpegBase64(blob) }) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 403) {
      throw new Error('Неверный ключ: ' + (j.why || 'в приложении ' + conf.key.length + ' символов, сравните буква в букву с APP_KEY') +
        (/[^\x21-\x7e]/.test(conf.key) ? '. В ключе в приложении есть русские буквы или пробелы.' : '.'));
    }
    if (!r.ok) throw new Error(j.error ? 'Яндекс: ' + j.error + (j.detail ? ' — ' + j.detail.slice(0, 120) : '') : 'Яндекс ответил ошибкой ' + r.status);
    return j.text || (j.lines || []).join('\n');
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Яндекс не ответил за 40 секунд');
    if (e instanceof TypeError) throw new Error('Нет связи с функцией в Яндексе: проверьте интернет и ссылку');
    throw e;
  } finally { clearTimeout(timer); }
}

// Распознать фото. onStep(текст) — для надписи на кнопке.
// Настроен Яндекс и есть интернет — читает Яндекс (точно). Иначе — прямо в телефоне (заметно хуже).
async function readPlate(blob, onStep) {
  const conf = await ocrCloudConf();
  if (conf && navigator.onLine) {
    onStep && onStep('Читаю через Яндекс…');
    const r = plateCandidates(await cloudOcrText(blob, conf));
    r.source = 'cloud';
    return r;
  }
  const r = await _readLocal(blob, onStep);
  r.note = conf ? 'Нет интернета — прочитано прямо в телефоне, проверьте внимательно.'
    : 'Прочитано прямо в телефоне — это неточно. Точное чтение через Яндекс включается в «Диск» → «Считывание шильдиков».';
  return r;
}

async function _readLocal(blob, onStep) {
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
    return best;
  } finally { _ocrProgress = null; }
}

// ---------- Пачкой: модели для старых заявок ----------
// Каждое фото сначала читается прямо в телефоне, без интернета. В Яндекс уходит только то, что похоже
// на шильдик и не похоже на договор, квитанцию или запчасть. Сомнение — не отправляем.
const LAT2CYR = { A: 'А', B: 'В', E: 'Е', K: 'К', M: 'М', H: 'Н', O: 'О', P: 'Р', C: 'С', T: 'Т', X: 'Х', Y: 'У' };
const SCAN_PRIVATE = /(ДОГОВОР|ЗАКАЗЧИК|ИСПОЛНИТЕЛ|ПАСПОРТ|ПОДПИС|(^|[^А-ЯЁ])Ф\.?\s?И\.?\s?О(?![А-ЯЁ])|КВИТАНЦ|СТОИМОСТ|ИТОГО|НАРЯД|КЛИЕНТ|ГАРАНТИЙН|ПОТРЕБИТЕЛ|ОПЛАТ|АКТ\s+ВЫП|ФАМИЛИ|ПРОЖИВА|ТЕЛЕФОН|ТЕЛ\.)/;
// Признаки адреса и имени с отчеством. Шильдик с адресом завода тоже пропустится — так безопаснее.
const SCAN_ADDR = /(^|[^А-ЯЁ])(УЛ\.|УЛИЦА|КВ\.|КВАРТИР|ПОДЪЕЗД|ЭТАЖ|ДОМ\s*\d|Д\.\s*\d|ПР-?Т|ПРОСПЕКТ|ПЕР\.|ПЕРЕУЛОК|МКР|МИКРОРАЙОН)/;
const SCAN_PATRONYMIC = /[А-ЯЁ]{3,}(ОВИЧ|ЕВИЧ|ОВНА|ЕВНА|ИЧНА|ИНИЧНА)(?![А-ЯЁ])/;
const SCAN_PHONE =/(\+7|8)\D{0,3}9\d\d\D{0,3}\d{3}\D{0,2}\d{2}\D{0,2}\d{2}/;
const SCAN_PART = /(COMPRESSOR|КОМПРЕССОР|EMBRACO|DANFOSS|SECOP|JIAXIPERA|HUAYI|DONPER|CUBIGEL|TECUMSEH|WANBAO|\bLBP\b|\bHBP\b|THERMOSTAT|ТЕРМОСТАТ|RANCO|\bATEA\b|\bRELAY\b|(^|[^А-ЯЁ])РЕЛЕ(?![А-ЯЁ])|\bPCB\b|WELLING|NIDEC|ASKOLL|LEILI|HANYU|PLASET|ТАЙМЕР)/i; // наклейки компрессора, насоса, мотора, платы
const SCAN_PLATE = [OCR_KEY, OCR_TYPE_KEY, /\d\s?(V|В)\b|VAC|~\s?\d/i, /\d\s?(HZ|ГЦ)/i, /\d\s?(W|ВТ|KW|КВТ)\b/i, /\d\s?(KG|КГ)\b/i,
  /R-?(600|134|12)A?\b/i, /(ХЛАДАГЕНТ|REFRIGERANT|КЛИМАТИЧ|CLIMAT|КЛАСС|CLASS)/i, /(MADE IN|СДЕЛАНО|ИЗГОТОВ|PRODUCED)/i, OCR_DEVICE,
  /(НАПРЯЖ|ЧАСТОТ|МОЩНОСТ|ПОТРЕБЛ|ОБ[ЪЬ]?[ЕЁ]М|VOLUME|WEIGHT|ИЗОЛЯЦ|SERIAL|СЕРИЙН|S\/N)/i];

// private — похоже на договор/документ клиента; part — наклейка запчасти; plate — шильдик техники
function screenPlate(text) {
  const t = String(text || '');
  const cyr = t.toUpperCase().replace(/[ABEKMHOPCTXY]/g, (ch) => LAT2CYR[ch]);
  if (SCAN_PRIVATE.test(cyr) || SCAN_ADDR.test(cyr) || SCAN_PATRONYMIC.test(cyr) || SCAN_PHONE.test(t)) return { kind: 'private', n: 0 };
  if (SCAN_PART.test(t) || SCAN_PART.test(cyr)) return { kind: 'part', n: 0 };
  const n = SCAN_PLATE.filter((re) => re.test(t)).length + (plateCandidates(t).brand ? 1 : 0);
  return { kind: n >= 2 ? 'plate' : 'none', n };
}

// Проверка в телефоне. Фото могло быть снято боком — смотрим и повёрнутым.
async function _screenLocal(blob) {
  const w = await _getOcrWorker();
  let best = { kind: 'none', n: 0 };
  for (const rot of [0, 90, 270]) {
    const { data } = await w.recognize(await _plateCanvas(blob, rot, null, 1400));
    const v = screenPlate(data.text);
    if (v.kind === 'private' || v.kind === 'part') return v;   // хоть в одном повороте похоже на договор — не отправляем
    if (v.n > best.n) best = v;
    if (rot === 0 && v.n >= 3) return v;                        // явный шильдик — дальше не крутим
  }
  return best.n >= 2 ? { kind: 'plate', n: best.n } : { kind: 'none', n: best.n };
}

// ---------- Шильдик сразу при добавлении фото ----------
// Новые фото заявки, где нет модели или вида техники: телефон сам ищет среди них шильдик (договоры
// и прочее отсеиваются ещё в телефоне), найденный читает Яндекс. Записывается только пустое.
let _autoPlateQueue = Promise.resolve();
function autoPlateOnAdd(orderId, photoIds, onStep) {
  const run = _autoPlateQueue.then(() => _autoPlate(orderId, photoIds, onStep));
  _autoPlateQueue = run.catch(() => null);
  return run;
}

async function _autoPlate(orderId, photoIds, onStep) {
  const conf = await ocrCloudConf();
  if (!conf || !navigator.onLine || (await getMeta('autoPlate')) === false) return null;
  const o0 = await dbGet('orders', orderId);
  if (!o0 || ((o0.model || '').trim() && o0.device)) return null;
  const got = {};
  for (const pid of photoIds) {
    const p = await dbGet('photos', pid);
    if (!p || !p.blob) continue;
    onStep && onStep('Ищу шильдик на фото…');
    const v = await _screenLocal(p.blob);
    if (v.kind !== 'plate') continue;
    onStep && onStep('Читаю шильдик…');
    const text = await cloudOcrText(p.blob, conf);
    if (screenPlate(text).kind !== 'plate') continue;
    const r = plateCandidates(text);
    const o = await dbGet('orders', orderId);
    if (!o) return null;
    if (!o.device && r.device) { o.device = r.device; o.deviceAuto = true; got.device = r.device; }
    const sure = r.models.length && (r.brand || OCR_KEY.test(text) || OCR_TYPE_KEY.test(text));
    if (!(o.model || '').trim() && sure) { o.model = plateLabel(r.brand, r.models[0]); o.modelAuto = true; got.model = o.model; }
    if (got.device || got.model) { o.updatedAt = Date.now(); await dbPut('orders', o); await markDirty(); }
    if ((o.model || '').trim() && o.device) break;   // всё заполнено — остальные фото не нужны
  }
  return got.device || got.model ? got : null;
}
