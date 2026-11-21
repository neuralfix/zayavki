// Разбор заявки из текста сообщения: «Ленина 12-34, Мария, хк / 89170000000 / не морозит / завтра в 14:00».
// Работает только в телефоне — текст никуда не отправляется.
'use strict';

const PARSE_DEV = [
  ['Холодильник', /(^|[^а-яёa-z])(хк|холод[а-яё]*|хол|морозил[а-яё]*|мк|ларь)(?![а-яёa-z])/i],
  ['Стиральная машина', /(^|[^а-яёa-z])(сма|см|стир(ал[а-яё]*)?\.?(\s*маш[а-яё]*)?)(?![а-яёa-z])/i],
  ['Телевизор', /(^|[^а-яёa-z])(тв|телевизор[а-яё]*|телик|tv)(?![а-яёa-z])/i],
];
const PARSE_LABEL = [
  ['phone', /^(тел(ефон)?|номер|моб(ильный)?|т\.)(?![а-яёa-z])\.?\s*[:\-–]?\s*/i],
  ['address', /^(адрес|адр)(?![а-яёa-z])\s*[:.\-–]?\s*/i],
  ['name', /^(имя|клиент|фио|ф\.и\.о\.?|контакт(ное лицо)?|заказчик)\s*[:.\-–]\s*/i],
  ['device', /^(техника|устройство|прибор|оборудование|что ремонтир\w*)\s*[:.\-–]\s*/i],
  ['model', /^(марка|модель|марка\s*\/?\s*модель)\s*[:.\-–]\s*/i],
  ['problem', /^(проблема|неисправность|описание|поломка|что случилось|причина( обращения)?|комментарий)\s*[:.\-–]\s*/i],
  ['when', /^(время|дата|когда|дата и время|визит|выезд)\s*[:.\-–]\s*/i],
];
const PARSE_CITY_PHONE = /^\d{3}[\s\-–—]*\d{2}[\s\-–—]*\d{2}(?![\dа-яёa-z]|\s*[-–—]\s*\d)/i;
const PARSE_WEEK = ['воскресень[ея]', 'понедельник', 'вторник', 'сред[ауые]', 'четверг', 'пятниц[ауые]', 'суббот[ауые]']
  .map((day) => new RegExp('(^|[^а-яa-z])(?:(?:в|во|на)\\s+)?' + day + '(?![а-яa-z])'));
const PARSE_HOUR_END = '(?:\\s*ч(?:ас(?:а|ов)?)?(?![а-я]))?(?:\\s*(?:до|[-–—])\\s*(?:[01]?\\d|2[0-3])(?:[:.][0-5]\\d)?(?![\\d.:]))?';
const PARSE_CLOCK = new RegExp('(^|[^\\d.:а-яa-z])(?:(?:в|к|с|после|около|на)\\s+)?([01]?\\d|2[0-3])[:.]([0-5]\\d)(?![\\d.:])' + PARSE_HOUR_END);
const PARSE_BARE_HOUR = new RegExp('(^|[\\s,;])(?:в|к|с|после|около|на)\\s+(0?[7-9]|1\\d|2[0-2])(?![\\d.:])' + PARSE_HOUR_END);
const PARSE_DAY_PART = /^([\s,]+)(?:утром|днем|вечером|ночью|до обеда|после обеда|после работы|в первой половине дня|во второй половине дня|в течение дня|к вечеру|под вечер)(?![а-яa-z])/;
const PARSE_ADDRESS_PART = /^(?:ул|улица|пр|пр-?т|проспект|пер|переулок|б-р|бульвар|ш\.|шоссе|мкр|д\.|дом|кв|корп|под|подъезд|эт|этаж|г\.|село|с\.|п\.|дер)(?=[\s.\d]|$)/i;

function parseDeviceOf(t) {
  for (const [name, re] of PARSE_DEV) if (re.test(t)) return name;
  return '';
}

// «завтра в 14:00», «20.11 к 12», «в пятницу с 15 до 17», «сегодня 16.30» → время выезда
function parseWhen(line, now = new Date()) {
  let t = line.toLowerCase().replace(/ё/g, 'е');
  const spans = [];
  // Запоминаем точные границы даты и времени, оставляя номер дома и остальной текст на месте.
  const mark = (match) => {
    const start = match.index + match[1].length;
    const end = match.index + match[0].length;
    spans.push({ start, end });
    t = t.slice(0, start) + ' '.repeat(end - start) + t.slice(end);
  };
  let m;
  let date = null;
  if ((m = t.match(/(^|[^а-яa-z])(?:на\s+)?(послезавтра|завтра|сегодня)(?![а-яa-z])/))) {
    const day = { сегодня: 0, завтра: 1, послезавтра: 2 }[m[2]];
    date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day);
    mark(m);
  } else {
    const wi = PARSE_WEEK.findIndex((re) => (m = t.match(re)));
    if (wi >= 0) {
      const day = (wi - now.getDay() + 7) % 7 || 7;
      date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day);
      mark(m);
    } else if ((m = t.match(/(^|[^\d.:])(?:на\s+)?(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?![\d.:])/)) && +m[3] >= 1 && +m[3] <= 12 && +m[2] >= 1 && +m[2] <= 31) {
      let y = m[4] ? +m[4] : now.getFullYear(); if (y < 100) y += 2000;
      date = new Date(y, +m[3] - 1, +m[2]);
      if (date.getDate() !== +m[2] || date.getMonth() !== +m[3] - 1) return null;   // 31.02 и т. п.
      if (!m[4] && date < new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)) date.setFullYear(y + 1);
      mark(m);
    }
  }
  // время: «14:00», «14.30» (не дата), «в 14», «к 9», «с 15 до 17», «после 18»
  let hh = null, mm = 0;
  if ((m = t.match(PARSE_CLOCK) || t.match(PARSE_BARE_HOUR))) {
    hh = +m[2]; mm = +(m[3] || 0);
    mark(m);
  }
  if (hh === null && !date) return null;
  if (hh === null && spans.length) {
    const end = spans[0].end;
    const partOfDay = t.slice(end).match(PARSE_DAY_PART);
    if (partOfDay) {
      partOfDay.index += end;
      mark(partOfDay);
    }
  }
  if (!date) {   // только время: сегодня, а если уже прошло — завтра
    date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (hh !== null && (hh * 60 + mm) < now.getHours() * 60 + now.getMinutes() - 30) date.setDate(date.getDate() + 1);
  }
  if (hh !== null && hh < 8 && /(вечер|после обеда|дня)/.test(t)) hh += 12;
  date.setHours(hh !== null ? hh : 0, hh !== null ? mm : 0, 0, 0);
  // Восстанавливаем регистр и букву «ё» в тексте, который остаётся в заявке.
  const remaining = line.split('');
  for (const { start, end } of spans) remaining.fill(' ', start, end);
  return {
    ts: date.getTime(),
    timeKnown: hh !== null,
    text: spans.map(({ start, end }) => line.slice(start, end)).join(' '),
    rest: remaining.join('').replace(/([,;]\s*){2,}/g, ', ').replace(/\s+/g, ' ').replace(/^[\s,.;:–—-]+|[\s,.;:–—-]+$/g, ''),
  };
}

// «Ленина 12-34, 2 под., 5 эт.» → улица и дом, кв., подъезд, этаж
function parseSplitAddress(addr) {
  let apt = '', entrance = '', floor = '';
  const parts = [];
  // «эт. 5» (подпись перед числом) важнее «5 эт.»: иначе в «кв. 34 под. 2 эт. 5» этажом станет 2, подъездом 34.
  // Число после подписи не берём, если за ним своя подпись: в «2 под. 5 эт.» пятёрка — этаж, а не подъезд.
  const NEXT = '(?!\\s*(?:эт|под|п(?![а-яё])|кв))';
  const cut = (p, m) => p.replace(m[0], ' ').replace(/\s+/g, ' ').trim().replace(/^[,.\s]+|[,.\s]+$/g, '');
  const num = (m) => m.slice(1).find((x) => /^\d+$/.test(x || ''));
  for (let p of addr.split(',').map((x) => x.trim()).filter(Boolean)) {
    let m;
    if (!apt && (m = p.match(/кв(артира)?\.?\s*(\d+[а-я]?)/i))) { apt = m[2]; p = cut(p, m); }
    if (!floor && (m = p.match(new RegExp('(^|[^а-яё])эт(аж)?\\.?\\s*(\\d+)' + NEXT, 'i')) || p.match(/(\d+)\s*эт\.?(аж)?/i))) { floor = num(m); p = cut(p, m); }
    if (!entrance && (m = p.match(new RegExp('(^|[^а-яё])под(ъезд)?\\.?\\s*(\\d+)' + NEXT, 'i')) || p.match(/(\d+)\s*(под(ъезд)?|п)\.?(?![а-яё])/i))) { entrance = num(m); p = cut(p, m); }
    if (!apt && (m = p.match(/^(.*?\d+[а-яА-Я]?(?:\/\d+[а-яА-Я]?)?(?:\s*к\.?\s*\d+)?)\s*-\s*(\d+[а-яА-Я]?)$/))) { p = m[1].trim(); apt = m[2]; }
    if (p) parts.push(p);
  }
  return { address: parts.join(', '), apt, entrance, floor };
}

const parseLooksAddress = (s) => /\d/.test(s) && /[а-яё]{3,}/i.test(s) &&
  (s.split(',').some((part) => PARSE_ADDRESS_PART.test(part.trim()) || /^[А-ЯЁ0-9][а-яё.\s-]+\d+/.test(part.trim())) ||
    /^[а-яё]+(?:\s*,\s*|\s+)\d+[а-яё]?(?=[\s,/-]|$)/i.test(s) || /\d+\s*-\s*\d+/.test(s));
const parseLooksName = (s) => /^[А-ЯЁ][а-яё]+(\s+[А-ЯЁ][а-яё]+){0,2}$/.test(s.trim()) && !parseDeviceOf(s);
const parseLabelOf = (s) => PARSE_LABEL.find(([key, re]) => re.test(s) &&
  (key !== 'phone' || PHONE_RE.test(s) || PARSE_CITY_PHONE.test(s.replace(re, ''))));

function parseOrderText(text) {
  const r = { phone: '', name: '', address: '', apt: '', entrance: '', floor: '', device: '', model: '', problem: '', visitAt: null, whenNote: '' };
  const problem = [];
  const lines = String(text || '').replace(/\r/g, '').split(/[\n;]|\s+\/\s+/)
    .map((l) => l.replace(/[\u{1F300}-\u{1FAFF}☀-➿️]/gu, '').replace(/^[\s•*·\->–—]+/, '').trim()).filter(Boolean)
    .flatMap((line) => {
      // «Адрес: Ленина, 12, Телефон: …, Время: …» — запятая внутри адреса остаётся.
      const parts = [];
      for (const part of line.split(',').map((p) => p.trim())) {
        if (!parts.length || parseLabelOf(part)) parts.push(part);
        else parts[parts.length - 1] += ', ' + part;
      }
      return parts;
    });
  let headDone = false;
  for (let line of lines) {
    // подписи «Адрес: …», «Телефон: …»
    let [label = '', labelPattern] = parseLabelOf(line) || [];
    if (labelPattern) line = line.replace(labelPattern, '').trim();
    // телефон — где угодно в строке
    const pm = line.match(PHONE_RE) || (label === 'phone' && line.match(PARSE_CITY_PHONE));
    if (pm) {
      if (!r.phone) r.phone = fmtPhone(pm[0]); else problem.push('доп. телефон ' + fmtPhone(pm[0]));
      line = line.replace(pm[0], '').replace(/^[\s,.;:–-]+|[\s,.;:–-]+$/g, '');
      if (!line) continue;
      if (label === 'phone') label = '';
    }
    if (label === 'when' || label === 'address' || !label) {
      const w = parseWhen(line);
      if (w && (!w.timeKnown || !r.visitAt)) {
        if (w.timeKnown) r.visitAt = w.ts;
        else r.whenNote = 'Когда: ' + (label === 'when' ? line : w.text);
        if (label === 'when' || !w.rest) continue;
        line = w.rest;
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
      const parts = line.split(',').map((x) => x.trim()).filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        let p = parts[i];
        const dev = parseDeviceOf(p);
        if (dev && !r.device) r.device = dev;
        if (dev && !parseLooksAddress(p)) {
          const re = PARSE_DEV.find(([name]) => name === dev)[1];
          if (p.replace(re, '$1').replace(/[\s.:–—-]+/g, '') !== '') problem.push(p);
          continue;
        }
        p = p.replace(/\s+(хк|сма|см|тв|мк)\.?$/i, '').trim();
        if (addr.length && !/\d/.test(p) && !PARSE_ADDRESS_PART.test(p) && !/^(?:(?:д\.?|дом)\s*)?\d/.test(parts[i + 1] || '')) {
          if (!r.name && parseLooksName(p)) r.name = p;
          else problem.push(p);
          continue;
        }
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
