// Разбор заявки из текста сообщения: «Ленина 12-34, Мария, хк / 89170000000 / не морозит / завтра в 14:00».
// Работает только в телефоне — текст никуда не отправляется.
'use strict';

const PARSE_DEV = [
  ['Холодильник', /(^|[^а-яёa-z])(хк|холод[а-яё]*|хол|морозил[а-яё]*|мк|ларь)(?![а-яёa-z])/i],
  ['Стиральная машина', /(^|[^а-яёa-z])(сма|см|стир(ал[а-яё]*)?\.?(\s*маш[а-яё]*)?)(?![а-яёa-z])/i],
  ['Телевизор', /(^|[^а-яёa-z])(тв|телевизор[а-яё]*|телик|tv)(?![а-яёa-z])/i],
];
const PARSE_LABEL = [
  ['phone', /^(тел(ефон)?|номер|моб(ильный)?|т\.)\s*[:.\-–]?\s*/i],
  ['address', /^(адрес|адр)\s*[:.\-–]?\s*/i],
  ['name', /^(имя|клиент|фио|ф\.и\.о\.?|контакт(ное лицо)?|заказчик)\s*[:.\-–]\s*/i],
  ['device', /^(техника|устройство|прибор|оборудование|что ремонтир\w*)\s*[:.\-–]\s*/i],
  ['model', /^(марка|модель|марка\s*\/?\s*модель)\s*[:.\-–]\s*/i],
  ['problem', /^(проблема|неисправность|описание|поломка|что случилось|причина( обращения)?|комментарий)\s*[:.\-–]\s*/i],
  ['when', /^(время|дата|когда|дата и время|визит|выезд)\s*[:.\-–]\s*/i],
];
const PARSE_WEEK = ['воскресенье', 'понедельник', 'вторник', 'сред', 'четверг', 'пятниц', 'суббот'];

function parseDeviceOf(t) {
  for (const [name, re] of PARSE_DEV) if (re.test(t)) return name;
  return '';
}

// «завтра в 14:00», «20.11 к 12», «в пятницу с 15 до 17», «сегодня 16.30» → время выезда
function parseWhen(line, now = new Date()) {
  let t = line.toLowerCase().replace(/ё/g, 'е');
  let day = null;
  let m;
  if (/послезавтра/.test(t)) day = 2;
  else if (/завтра/.test(t)) day = 1;
  else if (/сегодня/.test(t)) day = 0;
  let date = null;
  if (day !== null) date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day);
  if (!date && (m = t.match(/(^|[^\d])(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?![\d])/)) && +m[3] >= 1 && +m[3] <= 12 && +m[2] >= 1 && +m[2] <= 31) {
    let y = m[4] ? +m[4] : now.getFullYear(); if (y < 100) y += 2000;
    date = new Date(y, +m[3] - 1, +m[2]);
    if (date.getDate() !== +m[2] || date.getMonth() !== +m[3] - 1) return null;   // 31.02 и т. п.
    if (!m[4] && date < new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)) date.setFullYear(y + 1);
    t = t.replace(m[0], m[1] + ' ');   // чтобы «20.11» не приняли за время
  }
  if (!date) {
    const wi = PARSE_WEEK.findIndex((w) => new RegExp('(^|\\s)(в|во|на)?\\s*' + w).test(t));
    if (wi >= 0) { const add = (wi - now.getDay() + 7) % 7 || 7; date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + add); }
  }
  // время: «14:00», «14.30» (не дата), «в 14», «к 9», «с 15 до 17», «после 18»
  let hh = null, mm = 0;
  if ((m = t.match(/(^|[^\d.])([01]?\d|2[0-3]):(\d{2})(?![\d])/)) || (m = t.match(/(^|[^\d.])([01]?\d|2[0-3])\.([0-5]\d)(?![\d.])/))) {
    hh = +m[2]; mm = +m[3];
  }
  if (hh === null && (m = t.match(/(^|\s)(в|к|с|после|около|на)\s+([01]?\d|2[0-3])(\s*(ч|час[а-я]*))?(?![\d.:])/)) && +m[3] >= 7 && +m[3] <= 22) hh = +m[3];   // «с 2 сторон» — не время
  if (hh === null && !date) return null;
  if (!date) {   // только время: сегодня, а если уже прошло — завтра
    date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (hh !== null && (hh * 60 + mm) < now.getHours() * 60 + now.getMinutes() - 30) date.setDate(date.getDate() + 1);
  }
  if (hh !== null && hh < 8 && /(вечер|после обеда|дня)/.test(t)) hh += 12;
  date.setHours(hh !== null ? hh : 0, hh !== null ? mm : 0, 0, 0);
  return { ts: date.getTime(), timeKnown: hh !== null };
}

// «Ленина 12-34, 2 под., 5 эт.» → улица и дом, кв., подъезд, этаж
function parseSplitAddress(addr) {
  let apt = '', entrance = '', floor = '';
  const parts = [];
  for (let p of addr.split(',').map((x) => x.trim()).filter(Boolean)) {
    let m;
    if (!floor && (m = p.match(/(\d+)\s*эт\.?(аж)?/i) || p.match(/эт(аж)?\.?\s*(\d+)/i))) { floor = (m.slice(1).find((x) => /^\d+$/.test(x || ''))); p = p.replace(m[0], '').trim().replace(/^[,.\s]+|[,.\s]+$/g, ''); }
    if (!entrance && (m = p.match(/(\d+)\s*(под(ъезд)?|п)\.?(?![а-яё])/i) || p.match(/под(ъезд)?\.?\s*(\d+)/i))) { entrance = (m.slice(1).find((x) => /^\d+$/.test(x || ''))); p = p.replace(m[0], '').trim().replace(/^[,.\s]+|[,.\s]+$/g, ''); }
    if (!apt && (m = p.match(/кв(артира)?\.?\s*(\d+[а-я]?)/i))) { apt = m[2]; p = p.replace(m[0], '').trim().replace(/^[,.\s]+|[,.\s]+$/g, ''); }
    if (!apt && (m = p.match(/^(.*?\d+[а-яА-Я]?(?:\/\d+[а-яА-Я]?)?(?:\s*к\.?\s*\d+)?)\s*-\s*(\d+[а-яА-Я]?)$/))) { p = m[1].trim(); apt = m[2]; }
    if (p) parts.push(p);
  }
  return { address: parts.join(', '), apt, entrance, floor };
}

const parseLooksAddress = (s) => /\d/.test(s) && /[а-яё]{3,}/i.test(s) &&
  (/(ул\.?|улица|пр-?т|проспект|пер\.?|б-р|бульвар|ш\.|шоссе|мкр|д\.|дом|кв\.?)\s*/i.test(s) || /^[А-ЯЁ0-9][а-яё.\s-]+\d+/.test(s.trim()) || /\d+\s*-\s*\d+/.test(s));
const parseLooksName = (s) => /^[А-ЯЁ][а-яё]+(\s+[А-ЯЁ][а-яё]+){0,2}$/.test(s.trim()) && !parseDeviceOf(s);

function parseOrderText(text) {
  const r = { phone: '', name: '', address: '', apt: '', entrance: '', floor: '', device: '', model: '', problem: '', visitAt: null, whenNote: '' };
  const problem = [];
  const lines = String(text || '').replace(/\r/g, '').split('\n')
    .map((l) => l.replace(/[\u{1F300}-\u{1FAFF}☀-➿️]/gu, '').replace(/^[\s•*·\->–—]+/, '').trim()).filter(Boolean);
  let headDone = false;
  for (let line of lines) {
    // подписи «Адрес: …», «Телефон: …»
    let label = '';
    for (const [k, re] of PARSE_LABEL) if (re.test(line)) { label = k; line = line.replace(re, '').trim(); break; }
    // телефон — где угодно в строке
    const pm = line.match(PHONE_RE);
    if (pm && digits(pm[0]).length >= 10) {
      if (!r.phone) r.phone = fmtPhone(pm[0]); else problem.push('доп. телефон ' + fmtPhone(pm[0]));
      line = line.replace(pm[0], '').replace(/^[\s,.;:–-]+|[\s,.;:–-]+$/g, '');
      if (!line) continue;
      if (label === 'phone') label = '';
    }
    if (label === 'when' || (!label && /(сегодня|завтра|послезавтра|\d{1,2}[:.]\d{2}|(^|\s)(в|к|с|после)\s+\d{1,2}(\s|$|ч)|понедельник|вторник|сред[ау]|четверг|пятниц|суббот|воскресень)/i.test(line) && line.length < 60)) {
      const w = parseWhen(line);
      if (w && !w.timeKnown) { r.whenNote = 'Когда: ' + line; continue; }   // день без часа — в заметки, час не выдумываем
      if (w && !r.visitAt) {
        r.visitAt = w.ts;
        if (label === 'when') continue;
        const rest = line.replace(/(послезавтра|завтра|сегодня|(в|во|на)?\s*(понедельник|вторник|сред[ау]|четверг|пятниц[ау]|суббот[ау]|воскресень[ея]))/i, '').replace(/(в|к|с|после|около)?\s*\d{1,2}([:.]\d{2})?(\s*(ч|час\w*))?(\s*(до|-)\s*\d{1,2}([:.]\d{2})?)?/i, '').replace(/^[\s,.;:–-]+|[\s,.;:–-]+$/g, '');
        if (!rest || rest.length < 4) continue;
        line = rest;
      }
    }
    if (label === 'name') { r.name = line; continue; }
    if (label === 'model') { r.model = line; continue; }
    if (label === 'device') { r.device = parseDeviceOf(line) || r.device; const dre = PARSE_DEV.find(([n]) => n === r.device)?.[1]; const rest = (dre ? line.replace(dre, '$1') : line).trim(); if (rest.length > 1 && !r.model) r.model = rest.replace(/^[,.\s]+/, ''); continue; }
    if (label === 'problem') { problem.push(line); continue; }
    if (label === 'address' || (!headDone && parseLooksAddress(line))) {
      headDone = true;
      // «Ленина 12-34, Мария, хк» — адрес, имя и техника в одной строке
      const addr = [];
      for (let p of line.split(',').map((x) => x.trim()).filter(Boolean)) {
        const dev = parseDeviceOf(p);
        if (dev && !/\d/.test(p) && p.length <= 22) { r.device = r.device || dev; continue; }
        if (dev && !r.device) r.device = dev;
        p = p.replace(/\s+(хк|сма|см|тв|мк)\.?$/i, '').trim();
        if (!r.name && addr.length && parseLooksName(p)) { r.name = p; continue; }
        if (addr.length && !/\d/.test(p) && /^[а-яё]/.test(p) && !/^(ул|улица|пр|пер|кв|под|эт|д\.|дом|корп|мкр|г\.|село|с\.|п\.|дер)/i.test(p)) { problem.push(p); continue; }
        addr.push(p);
      }
      Object.assign(r, parseSplitAddress(addr.join(', ').replace(/^(г\.?\s*уфа|уфа)\s*,\s*/i, '')));
      continue;
    }
    if (!r.name && parseLooksName(line)) { r.name = line; continue; }
    if (!r.device) r.device = parseDeviceOf(line);
    problem.push(line);
  }
  // «хк не морозит» — слово техники в проблеме не повторяем
  r.problem = problem.map((p) => p.replace(/^(хк|сма|см|тв|мк)[\s,.:-]+/i, '')).filter(Boolean).join('. ');
  return r;
}
