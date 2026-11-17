// Подсказки адреса и узнавание клиента. Всё работает в телефоне, без интернета:
// справочник улиц Уфы и Уфимского района (streets.json, © участники OpenStreetMap) + адреса из своих заявок.
// Подсказки только помогают: любой адрес и номер дома можно написать руками.
'use strict';

let _streets = null;      // [{ label, key, loc, houses: [] }]
let _byLabel = null;      // label -> улица
let _streetsLoading = null;

const _norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^0-9a-zа-я]+/g, ' ').trim();
// Слова, которые не ищем: тип улицы. «ул лен» и «лен» находят одно и то же.
const _TYPE_WORDS = new Set(['ул', 'улица', 'пр', 'пр-т', 'просп', 'проспект', 'пер', 'переулок', 'б', 'р', 'б-р', 'бульвар',
  'пр-д', 'проезд', 'ш', 'шоссе', 'туп', 'тупик', 'пл', 'площадь', 'наб', 'набережная', 'мкр', 'микрорайон', 'д', 'дом',
  'с', 'село', 'деревня', 'п', 'пос', 'поселок', 'г', 'город', 'тракт', 'аллея', 'кв', 'квартал', 'снт', 'линия']);

function loadStreets() {
  if (_streets) return Promise.resolve(_streets);
  if (!_streetsLoading) {
    _streetsLoading = fetch('streets.json').then((r) => r.json()).then((d) => {
      _streets = d.s.map(([label, li, h]) => {
        const loc = d.loc[li];
        // Уфа — без приписки; сёла района — «Миловка, ул. Садовая»; село без улиц — просто «Михайловка»
        const full = !label ? loc : (loc && loc !== 'Уфа' ? loc + ', ' + label : label);
        return { label: full, key: ' ' + _norm(full), loc, houses: h ? h.split('|') : [] };
      });
      _byLabel = new Map(_streets.map((s) => [s.label.toLowerCase(), s]));
      return _streets;
    }).catch((e) => { _streetsLoading = null; console.warn('streets', e); return []; });
  }
  return _streetsLoading;
}

function _tokens(q) {
  return _norm(q).split(' ').filter((t) => t && !_TYPE_WORDS.has(t));
}
// Все слова запроса — начала слов в строке
function _matches(key, toks) {
  return toks.every((t) => key.includes(' ' + t));
}

// Какая улица из справочника уже стоит в начале адреса и что написано после неё
function _splitKnownStreet(value) {
  if (!_byLabel) return null;
  const low = value.toLowerCase();
  let i = low.indexOf(', ');
  while (i !== -1) {
    const s = _byLabel.get(low.slice(0, i));
    if (s) return { street: s, rest: value.slice(i + 2) };
    i = low.indexOf(', ', i + 2);
  }
  return null;
}

function _houseSort(a, b) {
  const na = parseInt(a, 10) || 0; const nb = parseInt(b, 10) || 0;
  return na - nb || a.localeCompare(b, 'ru');
}

// Подсказки для текущего текста: [{ text, sub, value, kind }]
async function addressSuggestions(value, history) {
  const v = value.replace(/^\s+/, '');
  const out = [];
  if (_norm(v).length < 2) return out;
  await loadStreets();

  // Улица уже выбрана — подсказываем дома
  const known = _splitKnownStreet(v);
  if (known && !known.rest.includes(',')) {
    const q = _norm(known.rest).replace(/^(д|дом)\s*/, '').replace(/\s+/g, '');
    const hs = known.street.houses.filter((h) => _norm(h).replace(/\s+/g, '').startsWith(q)).sort(_houseSort);
    if (q && hs.length === 1 && _norm(hs[0]).replace(/\s+/g, '') === q) return out; // дом уже дописан
    return hs.slice(0, 8).map((h) => ({ text: known.street.label + ', ' + h, sub: 'дом', value: known.street.label + ', ' + h, kind: 'house' }));
  }

  const toks = _tokens(v);
  if (!toks.length) return out;

  // Свои прошлые адреса — первыми
  const seen = new Set();
  for (const a of history) {
    const key = ' ' + _norm(a);
    if (seen.has(key) || !_matches(key, toks)) continue;
    seen.add(key);
    out.push({ text: a, sub: 'уже были', value: a, kind: 'history' });
    if (out.length >= 3) break;
  }

  if (v.includes(',')) return out; // после запятой улицы не ищем — пишут дом/квартиру
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
  for (const [, , s] of hits.slice(0, 8 - out.length)) {
    out.push({ text: s.label, sub: s.loc === 'Уфа' ? '' : 'Уфимский р-н', value: s.label + ', ', kind: 'street' });
  }
  return out;
}

// Подключить подсказки к полю адреса
function attachAddressSuggest(input, getHistory) {
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
    // последняя закрытая заявка, гарантия по которой ещё идёт
    warranty: orders.find((o) => o.status === 'closed' && o.warrantyDays && o.closedAt + o.warrantyDays * 864e5 >= now) || null,
  };
}
