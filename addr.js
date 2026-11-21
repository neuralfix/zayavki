// Подсказки адреса и узнавание клиента. Всё работает в телефоне, без интернета:
// справочник улиц Уфы и Уфимского района (streets.json, © участники OpenStreetMap) + адреса из своих заявок.
// Подсказки только помогают: любой адрес и номер дома можно написать руками.
'use strict';

let _streets = null;      // [{ label, key, loc, houses: [] }]
let _byLabel = null;      // label -> улица
let _districtPlaces = null;
let _streetsLoading = null;

const _norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^0-9a-zа-я]+/g, ' ').trim();
const _normalizeAvenue = (s) => String(s || '').replace(/(^\s*|,\s*)(?:пр[-–—](?:кт|т)|проспект)\.?(?=\s|$)/gi, '$1проспект');
const _labelKey = (s) => _normalizeAvenue(s).toLowerCase().replace(/\s*,\s*/g, ', ').trim();
// Слова, которые не ищем: тип улицы. «ул лен» и «лен» находят одно и то же.
const _TYPE_WORDS = new Set(['ул', 'улица', 'пр', 'пр-т', 'просп', 'проспект', 'пер', 'переулок', 'б', 'р', 'б-р', 'бульвар',
  'пр-д', 'проезд', 'ш', 'шоссе', 'туп', 'тупик', 'пл', 'площадь', 'наб', 'набережная', 'мкр', 'микрорайон', 'д', 'дом',
  'с', 'село', 'деревня', 'п', 'пос', 'поселок', 'г', 'город', 'тракт', 'аллея', 'кв', 'квартал', 'снт', 'линия']);

// Справочник: свой из комплекта приложения или скачанный кнопкой «Обновить справочник» — берётся тот, что новее
const STREETS_CACHE = 'zayavki-streets';
let _streetsMeta = null;  // { date, src, streets, houses }
// Справочник целый: есть места и улицы, у каждой улицы — название, номер места из списка и дома строкой
function _validStreets(d) {
  return !!d && Array.isArray(d.loc) && d.loc.length > 0 && Array.isArray(d.s) && d.s.length >= 100 &&
    d.s.every((x) => Array.isArray(x) && typeof x[0] === 'string' && Number.isInteger(x[1]) && x[1] >= 0 && x[1] < d.loc.length &&
      d.loc[x[1]] != null && (x[2] == null || typeof x[2] === 'string'));
}
async function _readStreets() {
  const own = await fetch('streets.json').then((r) => r.json());
  let got = null;
  try {
    const c = await caches.open(STREETS_CACHE);
    const r = await c.match('streets.json');
    if (r) got = await r.json();
    if (got && !_validStreets(got)) { got = null; await c.delete('streets.json'); }   // испорченную копию — выбросить
  } catch (e) { got = null; }
  return got && (got.date || '') > (own.date || '') ? got : own;
}
function _setMeta(d) {
  _streetsMeta = { date: d.date || '', src: d.src || '', streets: d.s.length, houses: d.s.reduce((n, x) => n + (x[2] ? x[2].split('|').length : 0), 0) };
}
async function streetsInfo() { await loadStreets(); return _streetsMeta; }
// Скачать справочник с сайта (минуя память приложения); новее — сохранить. Ответ: { updated, before, after }
// no-cache: браузер спрашивает сайт «изменился ли файл?» — если нет, справочник заново не качается
async function updateStreets() {
  const before = await streetsInfo();
  const r = await fetch('streets.json?fresh=1', { cache: 'no-cache' });
  if (!r.ok) throw new Error('Сайт не ответил (' + r.status + ')');
  const d = await r.clone().json();
  if (!_validStreets(d)) throw new Error('Справочник на сайте повреждён — оставлен прежний');
  if ((d.date || '') <= (before.date || '')) return { updated: false, before, after: before };
  await (await caches.open(STREETS_CACHE)).put('streets.json', r);
  _streets = null; _streetsLoading = null;
  return { updated: true, before, after: await streetsInfo() };
}

function loadStreets() {
  if (_streets) return Promise.resolve(_streets);
  if (!_streetsLoading) {
    _streetsLoading = _readStreets().then((d) => {
      _setMeta(d);
      _streets = d.s.map(([label, li, h]) => {
        const loc = d.loc[li];
        // Уфа — без приписки; сёла района — «Миловка, ул. Садовая»; село без улиц — просто «Михайловка»
        const full = !label ? loc : (loc && loc !== 'Уфа' ? loc + ', ' + label : label);
        return { label: full, key: ' ' + _norm(full), loc, houses: h ? h.split('|') : [] };
      });
      _byLabel = new Map(_streets.map((s) => [_labelKey(s.label), s]));
      _districtPlaces = new Set(d.loc.filter((loc) => loc !== 'Уфа').map(_norm));
      return _streets;
    }).catch((e) => { _streetsLoading = null; console.warn('streets', e); return []; });
  }
  return _streetsLoading;
}

function _tokens(q) {
  return _norm(_normalizeAvenue(q)).split(' ').filter((t) => t && !_TYPE_WORDS.has(t));
}
// Все слова запроса — начала слов в строке
function _matches(key, toks) {
  return toks.every((t) => key.includes(' ' + t));
}

// Какая улица из справочника уже стоит в начале адреса и что написано после неё
function _splitKnownStreet(value) {
  if (!_byLabel) return null;
  let i = value.lastIndexOf(',');
  while (i !== -1) {
    const s = _byLabel.get(_labelKey(value.slice(0, i)));
    if (s) return { street: s, rest: value.slice(i + 1).trimStart() };
    i = i > 0 ? value.lastIndexOf(',', i - 1) : -1;
  }
  return null;
}

function mapsAddress(address) {
  const value = _normalizeAvenue(address).trim();
  if (!value || /^(?:уфа|уфимский\s+(?:район|р-н))(?=[\s,]|$)|^(?:г\.|город)\s*[а-яё]/i.test(value)) return value;
  const [head, next = ''] = value.split(',', 2).map((part) => part.trim());
  const streetType = /^(?:ул|улица|пр|пр-т|проспект|пер|переулок|б-р|бульвар|ш|шоссе|туп|пл|наб|мкр)(?=[\s.]|$)/i;
  const houseDetails = /^(?:д|дом|к|корпус|кв|квартира|под|подъезд|эт|этаж)(?=[\s.\d]|$)/i;
  const namedPlace = /^(?:д\.|деревня|с\.|село|п\.|пос\.|пос[её]лок)\s*[а-яё]/i;
  const district = _districtPlaces?.has(_norm(head)) || namedPlace.test(head) ||
    (!streetType.test(head) && (streetType.test(next) || (/^[А-ЯЁA-Z]/.test(head) && /^\D+\s+\d/.test(next) && !houseDetails.test(next))));
  return (district ? 'Уфимский район, ' : 'Уфа, ') + value;
}

function _houseSort(a, b) {
  const na = parseInt(a, 10) || 0; const nb = parseInt(b, 10) || 0;
  return na - nb || a.localeCompare(b, 'ru');
}

// Свои прошлые заявки по этому адресу — по квартирам: «Ленина 12, кв. 5 · Иванов · холодильник · №386».
// history — заявки, свежие первыми. match получает ключ поиска и точный ключ дома.
function _flatSuggestions(history, match, max) {
  const out = []; const seen = new Set();
  for (const o of history) {
    const key = ' ' + _norm(_normalizeAvenue(o.address));
    const house = orderAddressKey(o.address);
    if (!match(key, house)) continue;
    const flat = (house || key) + '|' + (orderApartmentKey(o.apt) || _norm(o.apt));
    if (seen.has(flat)) continue;
    seen.add(flat);
    out.push({ text: o.address + (o.apt ? ', кв. ' + o.apt : ''), value: o.address, kind: 'history', order: o,
      sub: ['были', o.name, o.device ? o.device.toLowerCase() : '', '№' + o.num].filter(Boolean).join(' · ') });
    if (out.length >= max) break;
  }
  return out;
}

// Подсказки для текущего текста: [{ text, sub, value, kind, order? }]
async function addressSuggestions(value, history) {
  const v = value.replace(/^\s+/, '');
  const out = [];
  if (_norm(v).length < 2) return out;
  await loadStreets();

  // Улица уже выбрана — сначала квартиры, где уже были, потом дома
  const known = _splitKnownStreet(v);
  if (known && !known.rest.includes(',')) {
    const nv = ' ' + _norm(_normalizeAvenue(v));
    const house = orderAddressKey(v);
    const flats = _norm(known.rest) ? _flatSuggestions(history,
      (k, candidate) => (house && house === candidate) || k === nv || k.startsWith(nv + ' '), 6) : [];
    const q = _norm(known.rest).replace(/^(д|дом)\s*/, '').replace(/\s+/g, '');
    const hs = known.street.houses.filter((h) => _norm(h).replace(/\s+/g, '').startsWith(q)).sort(_houseSort);
    if (q && hs.length === 1 && _norm(hs[0]).replace(/\s+/g, '') === q) return flats; // дом уже дописан
    return flats.concat(hs.slice(0, 8 - Math.min(flats.length, 4)).map((h) => ({ text: known.street.label + ', ' + h, sub: 'дом', value: known.street.label + ', ' + h, kind: 'house' })));
  }

  const toks = _tokens(v);
  if (!toks.length) return out;

  // После запятой улицы не ищем — пишут дом/квартиру: тут нужны свои прошлые адреса
  if (v.includes(',')) return _flatSuggestions(history, (k) => _matches(k, toks), 6);

  // Пока пишут улицу — сначала улицы из справочника: выбрал, и она дописалась.
  // Квартиры, где уже были, — ниже улиц (а после выбора улицы и дома — первыми, см. выше).
  const first = toks[0];
  const hits = [];
  for (const s of _streets) {
    if (!_matches(s.key, toks)) continue;
    // выше: слово целиком совпало; Уфа выше района
    const rank = (s.key.split(' ').includes(first) ? 0 : 1) + (s.loc === 'Уфа' ? 0 : 2);
    hits.push([rank, -s.houses.length, s]);
    if (hits.length > 400) break;
  }
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2].label.localeCompare(b[2].label, 'ru'));
  for (const [, , s] of hits.slice(0, 8)) {
    out.push({ text: s.label, sub: s.loc === 'Уфа' ? '' : 'Уфимский р-н', value: s.label + ', ', kind: 'street' });
  }
  // Места под список остались — добавить квартиры, где уже были (например, адрес не из справочника)
  if (out.length < 8) out.push(..._flatSuggestions(history, (k) => _matches(k, toks), Math.min(4, 8 - out.length)));
  return out;
}

// Подключить подсказки к полю адреса. onPick(order) — выбрали квартиру, где уже были.
function attachAddressSuggest(input, getHistory, onPick) {
  const field = input.closest('.field');
  field.classList.add('suggest-host');
  const list = document.createElement('div');
  list.className = 'suggest';
  list.hidden = true;
  field.appendChild(list);
  let seq = 0;

  const show = async () => {
    const my = ++seq;
    const items = await addressSuggestions(input.value, await getHistory());
    if (my !== seq) return;
    if (!items.length || document.activeElement !== input) { list.hidden = true; return; }
    list.innerHTML = items.map((it, i) => `<button type="button" data-i="${i}" class="${it.kind}">
      <span>${esc(it.text)}</span>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</button>`).join('');
    list.hidden = false;
    $$('button', list).forEach((b) => {
      // pointerdown, чтобы поле не теряло фокус и клавиатура не пряталась
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const it = items[+b.dataset.i];
        input.value = it.value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        if (it.kind !== 'street') { list.hidden = true; seq++; }
        if (it.order && onPick) { onPick(it.order); return; }
        input.focus();
        const end = input.value.length; input.setSelectionRange(end, end);
      });
    });
  };
  input.addEventListener('input', show);
  input.addEventListener('focus', () => { loadStreets(); show(); });
  input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; seq++; }, 150));
}

// Клиент уже был? Ищем по последним 10 цифрам телефона.
async function findClientByPhone(phone, exceptId) {
  const d = String(phone || '').replace(/\D/g, '').slice(-10);
  if (d.length < 10) return null;
  const orders = (await dbAll('orders'))
    .filter((o) => o.id !== exceptId && String(o.phone || '').replace(/\D/g, '').slice(-10) === d)
    .sort((a, b) => b.createdAt - a.createdAt);
  if (!orders.length) return null;
  const now = Date.now();
  return {
    last: orders[0],
    count: orders.length,
    // отмечен как проблемный хоть в одной заявке
    problem: orders.find((o) => o.problemClient) || null,
    // мастер у этого клиента уже был (ремонт или отказ на месте) — новая заявка от него повторная
    visited: orders.some((o) => o.status === 'closed' || o.status === 'refused'),
    // последняя закрытая заявка, гарантия по которой ещё идёт
    warranty: orders.find((o) => o.status === 'closed' && o.warrantyDays && o.closedAt + o.warrantyDays * 864e5 >= now) || null,
  };
}

// ---------- Подъезд и этаж по номеру квартиры ----------
// Два источника, оба работают без интернета:
// 1) карта OpenStreetMap (entrances.json): подписанные диапазоны квартир и номера подъездов;
// 2) свои прошлые заявки: точное совпадение квартиры или оценка по двум соседним номерам.
let _entrances = null, _entrLoading = null;
function loadEntrances() {
  if (_entrances) return Promise.resolve(_entrances);
  if (!_entrLoading) {
    _entrLoading = fetch('entrances.json').then((r) => (r.ok ? r.json() : { h: {} }))
      .then((d) => {
        const h = d?.h || {};
        // Старая выгрузка при пропуске хотя бы одного номера переписывала все на 1, 2, ... .
        // Если они идут в таком порядке, отличить записанные номера от выдуманных уже нельзя.
        _entrances = d?.v === 2 ? h : Object.fromEntries(Object.entries(h)
          .filter(([, [, ranges]]) => ranges.some(([ref], i) => ref !== i + 1)));
        return _entrances;
      }).catch(() => { _entrLoading = null; return {}; });
  }
  return _entrLoading;
}

const _ORDER_HOUSE_END = /(?:,\s*|\s+)(?:(?:дом|д)\.?\s*)?(\d+[а-яёa-z]?(?:\s*[/\-–—]\s*\d+[а-яёa-z]?)*(?:\s*,?\s*(?:корпус|корп|к|строение|стр|с|литера|лит)\.?\s*[\dа-яёa-z]+)*)$/i;
const _ORDER_HOUSE_TYPES = { корпус: 'к', корп: 'к', строение: 'с', стр: 'с', литера: 'лит' };
const _ORDER_STREET_PREFIX = /^(ул|улица|пр-т|просп|проспект|пер|переулок|б-р|бульвар|пр-д|проезд|ш|шоссе|туп|тупик|пл|площадь|наб|набережная|мкр|микрорайон|кв-л|квартал|тракт|аллея|линия|тер|спуск|въезд)\.?(?=\s)\s*/i;
const _orderKeyText = (value) => value.toLowerCase().replace(/ё/g, 'е').replace(/[–—]/g, '-').replace(/\./g, '').replace(/\s+/g, ' ').trim();

function _orderHouseParts(address) {
  const v = _normalizeAvenue(address).trim();
  const m = v.match(_ORDER_HOUSE_END);
  if (!m) return null;
  const parts = v.slice(0, m.index).split(',').map((part) => part.trim()).filter(Boolean);
  const street = parts.pop();
  if (!street || !/[а-яёa-z]/i.test(street)) return null;
  const place = parts.map((part) => _orderKeyText(part).replace(/^(?:г|город)\s+/, '')).join(', ');
  const house = _orderKeyText(m[1]).replace(/корпус|корп|строение|стр|литера/g, (type) => _ORDER_HOUSE_TYPES[type])
    .replace(/[,\s]+/g, '');
  return { street, place: place || 'уфа', house };
}

// Ключ истории сохраняет населённый пункт и разделители номера дома: 12/1, 12-1 и 12 к1 — разные адреса.
function orderAddressKey(address) {
  const parts = _orderHouseParts(address);
  if (!parts) return null;
  const street = _orderKeyText(parts.street).replace(/^(?:ул|улица)\s+/, '');
  return parts.place + '|' + street + '|' + parts.house;
}

// В карте подъездов только Уфа. Типы улиц убираются по формату карты.
function _entrHouseKey(address) {
  const parts = _orderHouseParts(address);
  if (!parts || parts.place !== 'уфа' || _districtPlaces?.has(_norm(parts.street))) return null;
  const bare = parts.street.replace(_ORDER_STREET_PREFIX, '');
  const street = _norm(bare).split(' ').filter((t) => t && !_TYPE_WORDS.has(t)).join(' ');
  return street ? street + '|' + parts.house : null;
}

const _entrInt = (x) => (/^\s*\d+\s*$/.test(String(x ?? '')) ? parseInt(x, 10) : 0);
const _entrSame = (arr) => (arr.every((x) => x === arr[0]) ? arr[0] || 0 : 0);
const _entrRecorded = (matches, field) => _entrSame(matches.map((s) => s[field]).filter(Boolean));
function orderApartmentKey(value) {
  const m = String(value ?? '').trim().match(/^([0-9]+)\s*([а-яёa-z]?)$/i);
  return m && Number.isSafeInteger(+m[1]) && +m[1] > 0 ? String(+m[1]) + m[2].toLowerCase() : null;
}

// { entrance, floor, src, estimated } — при противоречиях оставляем поле пустым.
async function guessEntrance(address, apt, history) {
  const addrKey = orderAddressKey(address);
  const aptKey = orderApartmentKey(apt);
  if (!addrKey || !aptKey) return null;
  const samples = (history || []).filter((o) => orderAddressKey(o.address) === addrKey)
    .map((o) => ({ apt: orderApartmentKey(o.apt), entrance: _entrInt(o.entrance), floor: _entrInt(o.floor) }));
  const same = samples.filter((s) => s.apt === aptKey);
  if (same.some((s) => s.entrance || s.floor)) {
    const entrance = _entrRecorded(same, 'entrance');
    const floor = _entrRecorded(same, 'floor');
    return entrance || floor ? { entrance, floor, src: 'по заявкам в этой квартире', estimated: false } : null;
  }

  // Диапазоны карты относятся к целым номерам квартир. Этажность дома не указывает этаж квартиры.
  const n = _entrInt(aptKey);
  if (!n) return null;
  const key = _entrHouseKey(address);
  const house = key ? (await loadEntrances())[key] : undefined;
  const refs = (house?.[1] || []).filter(([, first, last]) => n >= first && n <= last).map(([ref]) => ref);
  const mapped = _entrSame(refs);

  // Оценка между соседними квартирами возможна только при совпадении подъезда с обеих сторон.
  const below = samples.filter((s) => s.apt === String(n - 1));
  const above = samples.filter((s) => s.apt === String(n + 1));
  const nearby = _entrSame([_entrRecorded(below, 'entrance'), _entrRecorded(above, 'entrance')]);
  if (nearby && (!refs.length || mapped === nearby)) {
    const floor = _entrSame([_entrRecorded(below, 'floor'), _entrRecorded(above, 'floor')]);
    if (!mapped || floor) {
      return { entrance: nearby, floor, src: mapped ? 'подъезд по карте, этаж — по соседним квартирам' : 'по соседним квартирам', estimated: true };
    }
  }
  return mapped ? { entrance: mapped, floor: 0, src: 'по карте OpenStreetMap', estimated: false } : null;
}
