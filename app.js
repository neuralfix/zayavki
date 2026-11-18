'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const view = $('#view');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0)) + ' ₽';
const parseMoney = (s) => { const v = parseFloat(String(s ?? '').replace(/[\s ₽]/g, '').replace(',', '.')); return isFinite(v) ? v : 0; };
const digits = (s) => String(s ?? '').replace(/\D/g, '');

// «89659324576», «8-965-932-45-76», «+7 965 9324576», «9659324576» → «+7 (965) 932-45-76».
// Что не похоже на один номер (буквы, два номера, короткий городской) — оставляем как написано.
function fmtPhone(s) {
  const raw = String(s ?? '').trim();
  if (!raw || /[a-zа-яё]/i.test(raw)) return raw;
  let d = digits(raw);
  if (d.length === 11 && /^[78]/.test(d)) d = d.slice(1);
  if (d.length !== 10) return raw;
  return '+7 (' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6, 8) + '-' + d.slice(8);
}
const PHONE_RE = /(?:\+7|8)?[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/;
const telHref = (phone) => 'tel:' + String(phone).replace(/[^\d+]/g, '');

// Строка для имени контакта в телефонной книге: «ХК Ленина 12-34 Иван 11.11.26»
const DEV_SHORT = { 'Холодильник': 'ХК', 'Стиральная машина': 'СМА', 'Телевизор': 'ТВ' };
function contactLabel(o) {
  const dev = DEV_SHORT[o.device] || (o.model ? o.model.split(/\s+/)[0] : '');
  const addr = String(o.address || '')
    .replace(/(^|,\s*)(ул\.|улица)\s*/gi, '$1')
    .replace(/(^|,\s*)(пр-т|проспект)\s*/gi, '$1пр. ')
    .replace(/\s*,\s*/g, ' ').trim();
  const d = new Date(o.createdAt || Date.now());
  const date = String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getFullYear()).slice(2);
  return [dev, addr ? addr + (o.apt ? '-' + o.apt : '') : '', o.name, date].filter(Boolean).join(' ');
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch (e) { /* запасной способ ниже */ }
  const ta = document.createElement('textarea');
  ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch (e) { /* нет */ }
  ta.remove(); return ok;
}

const DEVICES = ['Холодильник', 'Стиральная машина', 'Телевизор', 'Другое'];
const EXP_CATS = ['Реклама', 'Колибри', 'Прочее'];
const EXP_MONTHLY = ['Реклама', 'Колибри']; // платятся раз в месяц — выбирается месяц, а не дата
const COST_CHIPS = ['Компрессор', 'Фреон', 'Шредер', 'Фильтр', 'Реле', 'Датчик', 'Термостат', 'Испаритель', 'ТЭН', 'Насос', 'Подшипники', 'Плата', 'Подсветка'];
const STATUS = { open: 'В работе', sd: 'На СД', closed: 'Закрыта', refused: 'Отказ', cancelled: 'Отмена' };
const SD_WHAT = ['Плата', 'Модуль', 'Блок питания', 'Техника целиком'];
const APP_VERSION = '1.27'; // вместе с version.json и CACHE в sw.js

const state = { filter: 'all', search: '', month: monthKey(Date.now()) };
let photoUrls = [];

// ---------- Даты ----------
function monthKey(ts) { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function shiftMonth(key, k) { const [y, m] = key.split('-').map(Number); return monthKey(new Date(y, m - 1 + k, 1)); }
function monthName(key, short) {
  const [y, m] = key.split('-').map(Number);
  const s = new Date(y, m - 1, 1).toLocaleDateString('ru-RU', short ? { month: 'short' } : { month: 'long', year: 'numeric' });
  return s.replace(' г.', '').replace('.', '');
}
function fmtDate(ts, time = true) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date(); const yest = new Date(Date.now() - 864e5);
  let day = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  if (d.toDateString() === today.toDateString()) day = 'сегодня';
  else if (d.toDateString() === yest.toDateString()) day = 'вчера';
  else if (d.getFullYear() !== today.getFullYear()) day = d.toLocaleDateString('ru-RU');
  return time ? day + ', ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : day;
}
const toDateInput = (ts) => { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const toDTInput = (ts) => ts ? toDateInput(ts) + 'T' + new Date(ts).toTimeString().slice(0, 5) : '';
function fromDateInput(v, keepTimeOf) {
  if (!v) return Date.now();
  const [y, m, d] = v.split('-').map(Number);
  const t = new Date(keepTimeOf || Date.now());
  return new Date(y, m - 1, d, t.getHours(), t.getMinutes()).getTime();
}

// ---------- Общие мелочи ----------
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function setTitle(t, back) {
  $('#title').textContent = t;
  $('#backBtn').hidden = !back;
  document.title = t + ' — Мои заявки';
}
function setTab(name) {
  const map = { today: 'today', orders: 'orders', new: 'orders', edit: 'orders', order: 'orders', close: 'orders', expense: 'report', report: 'report', settings: 'settings' };
  $$('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === map[name]));
}
function go(hash, replace) { if (replace) location.replace(hash); else location.hash = hash; }

async function changed() {
  await markDirty();
  requestSync();
}

async function requestSync() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg && reg.sync) await reg.sync.register('disk-sync');
  } catch (e) { /* фоновая отправка недоступна — отправим со страницы */ }
  if (navigator.onLine) { await syncNow(); }
  updateSyncBadge();
}

// ---------- Значок синхронизации ----------
// Шапка: компактный значок Диска. То, что требует действия, — отдельной строкой под шапкой.
async function updateSyncBadge() {
  const b = $('#syncBadge'); const bar = $('#diskBar');
  const s = await syncStatus();
  const pending = s.pendingPhotos + (s.dataPending ? 1 : 0) + s.pendingDeletes;
  let icon = '☁ ✓', cls = '', alert = '';
  if (!s.connected) { icon = '☁ !'; cls = 'warn'; alert = 'Автокопии на Яндекс Диск выключены. Заявки сохраняются в телефоне'; }
  else if (!s.hasKey) { icon = '🔒'; cls = 'warn'; alert = 'Задайте пароль — без него на Диск ничего не уходит'; }
  else if (s.paused) { icon = '☁ ⏸'; cls = 'warn'; alert = 'Отправка на Диск на паузе — выберите, какую копию оставить'; }
  else if (s.error) { icon = '☁ !'; cls = 'err'; alert = 'Ошибка Диска: ' + s.error; }
  else if (pending) { icon = navigator.onLine ? '☁ ↑' + (s.pendingPhotos || '') : '☁ ⏸'; }
  b.className = 'sync' + (cls ? ' ' + cls : '');
  b.textContent = icon;
  b.title = alert || (pending ? 'Ждут отправки: ' + s.pendingPhotos + ' фото' + (s.dataPending ? ' + данные' : '') : s.lastSync ? 'На Диске, последняя отправка ' + fmtDate(s.lastSync) : 'На Диске');
  b.setAttribute('aria-label', 'Диск: ' + b.title);
  // строка-предупреждение не нужна на самой странице «Диск» — там всё подробно
  bar.hidden = !alert || location.hash.startsWith('#/settings');
  bar.className = cls === 'err' ? 'err' : '';
  bar.innerHTML = alert ? `<a href="#/settings">⚠ ${esc(alert)} <b>›</b></a>` : '';
}

// ---------- Маршруты ----------
async function route() {
  photoUrls.forEach((u) => URL.revokeObjectURL(u)); photoUrls = [];
  const h = location.hash || '#/today';
  const [, name, id] = h.split('/');
  setTab(name);
  window.scrollTo(0, 0);
  updateSyncBadge();
  try {
    switch (name) {
      case 'today': return await renderToday();
      case 'orders': return await renderOrders();
      case 'new': return await renderOrderForm(null, id); // #/new/<id> — заявка по гарантии к заявке id
      case 'edit': return await renderOrderForm(id);
      case 'order': return await renderOrder(id);
      case 'close': return await renderClose(id);
      case 'expense': return await renderExpenseForm(id === 'new' ? null : id);
      case 'report': return await renderReport();
      case 'settings': return await renderSettings();
      default: return go('#/today', true);
    }
  } catch (e) {
    console.error(e);
    view.innerHTML = '<div class="empty">Что-то пошло не так: ' + esc(e.message) + '</div>';
  }
}

// ================= ЗАЯВКИ =================
const isActive = (s) => s === 'open' || s === 'sd';
const shortAddress = (o) => [o.address, o.apt ? 'кв. ' + o.apt : ''].filter(Boolean).join(', ');
const fullAddress = (o) => [o.address, o.apt ? 'кв. ' + o.apt : '', o.entrance ? 'под. ' + o.entrance : '', o.floor ? 'эт. ' + o.floor : ''].filter(Boolean).join(', ');
const dayShort = (ts) => new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');
// СД: деталь ждёт дольше недели — подсвечиваем, чтобы клиент не потерялся
const SD_LATE_DAYS = 7;
const sdDays = (o) => (o.sd?.at ? Math.floor((Date.now() - o.sd.at) / 864e5) : 0);
const sdLate = (o) => o.status === 'sd' && sdDays(o) >= SD_LATE_DAYS;
const sdLine = (o) => o.sd ? ['на СД с ' + dayShort(o.sd.at), o.sd.what, o.sd.advance ? 'аванс ' + money(o.sd.advance) : ''].filter(Boolean).join(' · ') : '';
// Для Яндекс Карт: улица Уфы → «Уфа, …», село района («Миловка, ул. …») → «Уфимский район, …». Без квартиры.
const mapsQuery = (o) => (/^[А-ЯЁA-Z][^,]*,/.test(o.address) && !/^(ул|улица|пр|пр-т|проспект|пер|переулок|б-р|ш|шоссе|туп|пл|наб|мкр)(?=[\s.,]|$)/i.test(o.address) ? 'Уфимский район, ' : 'Уфа, ') + o.address;
// Android: сразу Яндекс Навигатор; если его нет — Яндекс Карты. На компьютере — Карты.
function routeHref(o) {
  const q = mapsQuery(o);
  const maps = 'https://yandex.ru/maps/?text=' + encodeURIComponent(q);
  if (!/Android/i.test(navigator.userAgent)) return maps;
  return 'intent://map_search?text=' + encodeURIComponent(q) +
    '#Intent;scheme=yandexnavi;package=ru.yandex.yandexnavi;S.browser_fallback_url=' + encodeURIComponent(maps) + ';end';
}
const plural = (n, one, few, many) => n % 10 === 1 && n % 100 !== 11 ? one : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);
const daysWord = (n) => plural(n, 'день', 'дня', 'дней');
// Гарантия: до какого дня и идёт ли сейчас (только у закрытых с ремонтом)
const warEndOf = (o) => (o.status === 'closed' && o.warrantyDays && o.closedAt ? o.closedAt + o.warrantyDays * 864e5 : 0);
const onWarranty = (o) => warEndOf(o) >= Date.now();
// Раздел «Гарантия»: только гарантийные заявки, которые сейчас в работе или на СД. После закрытия — в «Закрытые»
const inWarrantyTab = (o) => o.isWarranty && isActive(o.status);
// «12 дней» / «3 месяца»
const warrantyText = (o) => o.warrantyMonths ? o.warrantyMonths + ' ' + plural(o.warrantyMonths, 'месяц', 'месяца', 'месяцев')
  : o.warrantyDays ? o.warrantyDays + ' ' + daysWord(o.warrantyDays) : '';

function matches(o, q) {
  if (!q) return true;
  const text = [o.num, o.name, o.phone, o.address, o.apt, o.device, o.model, o.problem, o.notes, o.workDone, o.sd?.what, o.problemClient].join(' ').toLowerCase();
  if (text.includes(q)) return true;
  const dq = digits(q);
  if (dq.length < 3) return false;
  const tel = digits(o.phone);
  const tries = [dq];
  if (/^[78]/.test(dq) && dq.length >= 4) tries.push('7' + dq.slice(1), '8' + dq.slice(1));
  if (dq.length === 11 && /^[78]/.test(dq)) tries.push(dq.slice(1));
  return tries.some((t) => tel.includes(t));
}

async function renderOrders() {
  setTitle('Заявки');
  const all = await dbAll('orders');
  const cnt = { open: 0, sd: 0, closed: 0, war: 0 };
  all.forEach((o) => { if (o.status === 'open') cnt.open++; else if (o.status === 'sd') cnt.sd++; else cnt.closed++; if (inWarrantyTab(o)) cnt.war++; });
  view.innerHTML = `
    <div class="seg ofilter">
      ${[['all', 'Все', all.length], ['open', 'В работе', cnt.open], ['sd', 'На СД', cnt.sd], ['closed', 'Закрытые', cnt.closed], ['war', 'Гарантия', cnt.war]]
        .map(([f, t, n]) => `<button data-f="${f}" class="${state.filter === f ? 'on' : ''}">${t}<i>${n}</i></button>`).join('')}
    </div>
    <input class="search" type="search" placeholder="Поиск: имя, телефон, адрес, №" value="${esc(state.search)}">
    <div class="list" id="list"></div>
    <a class="fab" href="#/new" aria-label="Новая заявка">+</a>`;
  $$('.seg button', view).forEach((b) => b.onclick = () => { state.filter = b.dataset.f; renderOrders(); });
  $('.search', view).oninput = (e) => { state.search = e.target.value; drawList(all); };
  drawList(all);
}

function drawList(all) {
  const q = state.search.trim().toLowerCase();
  const f = state.filter;
  let list = all.filter((o) => (f === 'all' || (f === 'war' ? inWarrantyTab(o) : f === 'closed' ? !isActive(o.status) : o.status === f)) && matches(o, q));
  // В работе: сначала с назначенным временем (по порядку), потом без времени — новые сверху.
  // На СД: давние сверху. Закрытые, отказы, отмены: свежие сверху. «Все» — в таком же порядке группами.
  const rank = (o) => (o.status === 'open' ? 0 : o.status === 'sd' ? 1 : 2);
  list.sort((a, b) => rank(a) - rank(b) || (rank(a) === 0
    ? (a.visitAt || Infinity) - (b.visitAt || Infinity) || b.createdAt - a.createdAt
    : rank(a) === 1 ? (a.sd?.at || 0) - (b.sd?.at || 0)
      : (b.closedAt || b.createdAt) - (a.closedAt || a.createdAt)));
  const el = $('#list');
  if (!list.length) {
    el.innerHTML = `<div class="empty">${q ? 'Ничего не найдено' : f === 'open' ? 'Заявок в работе нет.<br>Нажмите «+», чтобы добавить.' : f === 'sd' ? 'Сейчас на СД ничего нет' : f === 'war' ? 'Гарантийных заявок в работе нет.<br>Закрытые гарантийные — в разделе «Закрытые».' : f === 'all' ? 'Заявок пока нет.<br>Нажмите «+», чтобы добавить.' : 'Пока пусто'}</div>`;
    return;
  }
  el.innerHTML = list.map((o) => {
    let when;
    if (o.status === 'open') when = o.visitAt ? '🕑 ' + fmtDate(o.visitAt) : 'создана ' + fmtDate(o.createdAt);
    else if (o.status === 'sd') when = '🔧 ' + sdLine(o) + (sdLate(o) ? ' · ⚠ ждёт ' + sdDays(o) + ' ' + daysWord(sdDays(o)) : '');
    else when = STATUS[o.status].toLowerCase() + ' ' + fmtDate(o.closedAt || o.updatedAt, false) + (o.diagOnly ? ' · диагностика' : '');
    const sum = o.status === 'closed' ? `<span class="${orderNet(o) >= 0 ? 'pos' : 'neg'}">${orderNet(o) >= 0 ? '+' : ''}${money(orderNet(o))}</span>` : '';
    return `<a class="item${sdLate(o) ? ' late' : ''}" href="#/order/${o.id}">
      <div class="row"><b>№${o.num}</b><span class="grow">${esc([o.device, o.model].filter(Boolean).join(' '))}${o.isWarranty ? ' <span class="tag-w">гарантия</span>' : ''}${o.problemClient ? ' <span class="tag-bad">⚠</span>' : ''}</span><span class="badge ${o.status}">${STATUS[o.status]}</span></div>
      <div class="row small"><span class="grow">${esc([o.name, shortAddress(o)].filter(Boolean).join(' · ') || o.phone || o.notes || '—')}</span></div>
      <div class="row small muted"><span class="grow">${esc(when)}</span>${sum}</div>
    </a>`;
  }).join('');
}

// ================= СЕГОДНЯ =================
const hhmm = (ts) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

const ICON_CALL = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M6.6 3.5l2.6-.3 1.6 4-2 1.5a12 12 0 0 0 6.5 6.5l1.5-2 4 1.6-.3 2.6c-.2 1.3-1.3 2.2-2.6 2.1C10.6 19 5 13.4 4.5 6.1c-.1-1.3.8-2.4 2.1-2.6z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>';
const ICON_ROUTE = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 2.5l7.5 18-7.5-4-7.5 4z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>';

// Строка выезда: время и улица с домом — главное; звонок и маршрут — в одно касание справа
function todayItem(o, timeText) {
  const tel = digits(o.phone);
  const street = o.address || o.name || 'Адрес не указан';
  const flat = o.address ? [o.apt ? 'кв. ' + o.apt : '', o.entrance ? 'под. ' + o.entrance : '', o.floor ? 'эт. ' + o.floor : ''].filter(Boolean).join(', ') : '';
  const sub = [o.device, o.address ? o.name : '', o.problem].filter(Boolean).join(' · ');
  return `<div class="item today-item">
    <a class="t-main${timeText && timeText.length > 5 ? ' t-stack' : ''}" href="#/order/${o.id}">
      ${timeText ? `<b class="t-time">${esc(timeText)}</b>` : ''}
      <div class="t-body">
        <div class="t-addr">${esc(street)}${flat ? ` <span class="t-flat">${esc(flat)}</span>` : ''}
          ${o.problemClient ? '<span class="tag-bad">⚠</span>' : ''}${o.isWarranty ? ' <span class="tag-w">гарантия</span>' : ''}</div>
        <div class="t-sub">${esc(sub || '№' + o.num)}</div>
      </div>
    </a>
    ${tel || o.address ? `<div class="t-act">
      ${tel ? `<a class="ico" href="${esc(telHref(o.phone))}" aria-label="Позвонить">${ICON_CALL}</a>` : ''}
      ${o.address ? `<a class="ico" href="${esc(routeHref(o))}" aria-label="Маршрут">${ICON_ROUTE}</a>` : ''}
    </div>` : ''}
  </div>`;
}

async function renderToday() {
  setTitle('Сегодня');
  const all = await dbAll('orders');
  const n = new Date();
  const start = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  const end = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1).getTime();
  const end2 = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 2).getTime();
  const open = all.filter((o) => o.status === 'open');
  const byTime = (a, b) => a.visitAt - b.visitAt;
  const late = open.filter((o) => o.visitAt && o.visitAt < start).sort(byTime);
  const today = open.filter((o) => o.visitAt >= start && o.visitAt < end).sort(byTime);
  const noTime = open.filter((o) => !o.visitAt).sort((a, b) => b.createdAt - a.createdAt);
  const tomorrow = open.filter((o) => o.visitAt >= end && o.visitAt < end2).sort(byTime);
  const sd = all.filter((o) => o.status === 'sd').length;
  const sdOld = all.filter(sdLate).length;
  const sec = (title, list, t, cls = '') => list.length ? `<h3 class="sec-h ${cls}">${title} <span class="muted">${list.length}</span></h3>
    <div class="list">${list.map((o) => todayItem(o, t(o))).join('')}</div>` : '';
  view.innerHTML = `
    <div class="today-head"><h2 id="todayDate">${esc(todayDateText())}</h2><a class="btn mini" href="#/new">+ Новая заявка</a></div>
    ${sd ? `<a class="item sd-link${sdOld ? ' late' : ''}" href="#/orders" id="toSd">🔧 На СД: ${sd}${sdOld ? ` <span class="neg">· ⚠ ${sdOld} ${sdOld === 1 ? 'ждёт' : 'ждут'} больше недели</span>` : ''}</a>` : ''}
    ${sec('Просрочено', late, (o) => dayShort(o.visitAt) + ', ' + hhmm(o.visitAt), 'neg')}
    ${sec('На сегодня', today, (o) => hhmm(o.visitAt))}
    ${sec('Без времени', noTime, () => '')}
    ${!late.length && !today.length && !noTime.length ? '<div class="empty">На сегодня заявок нет.</div>' : ''}
    ${sec('Завтра', tomorrow, (o) => hhmm(o.visitAt))}`;
  const toSd = $('#toSd'); if (toSd) toSd.onclick = () => { state.filter = 'sd'; };
}

// Заявки в тот же день, что и выбранное время. near — ближе, чем длительность выезда.
async function visitConflicts(ts, exceptId) {
  if (!ts) return [];
  const hours = Number(await getMeta('visitHours')) || 1.5;
  const day = new Date(ts).toDateString();
  return (await dbAll('orders'))
    .filter((x) => x.id !== exceptId && isActive(x.status) && x.visitAt && new Date(x.visitAt).toDateString() === day)
    .sort((a, b) => a.visitAt - b.visitAt)
    .map((x) => ({ o: x, near: Math.abs(x.visitAt - ts) < hours * 3600e3 }));
}

async function renderOrderForm(id, warrantyFromId) {
  const o = id ? await dbGet('orders', id) : null;
  if (id && !o) return go('#/orders', true);
  const src = !o && warrantyFromId ? await dbGet('orders', warrantyFromId) : null;
  setTitle(o ? 'Заявка №' + o.num : src ? 'По гарантии' : 'Новая заявка', true);
  const v = o || (src ? { phone: src.phone, name: src.name, address: src.address, apt: src.apt, entrance: src.entrance, floor: src.floor,
    device: src.device, model: src.model, isWarranty: true, warrantyOf: src.id } : {});
  let warrantyOf = v.warrantyOf || null;
  view.innerHTML = `
    <form id="f" autocomplete="off">
      ${!o && !src ? '<button type="button" class="btn sec" id="pasteOrder" style="margin-bottom:12px">📋 Вставить заявку из сообщения</button>' : ''}
      <div class="client-hint warn" id="wbanner" ${warrantyOf ? '' : 'hidden'}>${src ? `Заявка по гарантии к №${src.num}${src.warrantyDays ? ' (гарантия ' + warrantyText(src) + ')' : ''}` : (v.isWarranty ? 'Заявка по гарантии' : '')}</div>
      <div class="field"><label>Телефон</label>
        <div class="phone-row"><input class="input" name="phone" type="tel" inputmode="tel" value="${esc(v.phone)}">
          <button type="button" class="btn sec" id="pastePh">📋 Вставить</button></div>
        <div id="client"></div></div>
      <div class="field"><label>Имя</label><input class="input" name="name" value="${esc(v.name)}" autocapitalize="words"></div>
      <div class="addr-row">
        <div class="field"><label>Улица, дом</label><input class="input" name="address" value="${esc(v.address)}" placeholder="Начните вводить улицу"></div>
        <div class="field"><label>Кв.</label><input class="input" name="apt" value="${esc(v.apt)}" inputmode="numeric"></div>
      </div>
      <div id="addrHint"></div>
      <button type="button" class="link small" id="moreAddr" ${v.entrance || v.floor ? 'hidden' : ''}>+ подъезд, этаж</button>
      <div class="addr-row two" id="addrMore" ${v.entrance || v.floor ? '' : 'hidden'}>
        <div class="field"><label>Подъезд</label><input class="input" name="entrance" value="${esc(v.entrance)}" inputmode="numeric"></div>
        <div class="field"><label>Этаж</label><input class="input" name="floor" value="${esc(v.floor)}" inputmode="numeric"></div>
      </div>
      <div class="field"><label>Техника</label>
        <div class="chips" id="dev">${DEVICES.map((d) => `<button type="button" class="chip ${v.device === d ? 'on' : ''}" data-v="${d}">${d}</button>`).join('')}</div>
      </div>
      <div class="field"><label>Марка / модель</label><input class="input" name="model" value="${esc(v.model)}"></div>
      <div class="field"><label>Проблема</label><textarea class="input" name="problem">${esc(v.problem)}</textarea></div>
      <div class="field"><label>Когда ехать <span class="muted">— если клиент просит на время или на другой день</span></label>
        <input class="input" name="visitAt" type="datetime-local" value="${toDTInput(v.visitAt)}">
        <div id="conflicts"></div></div>
      <div class="field"><label>Заметки</label><textarea class="input" name="notes">${esc(v.notes)}</textarea></div>
      <button class="btn" type="submit">${o ? 'Сохранить' : 'Создать заявку'}</button>
    </form>`;
  let device = v.device || '';
  $$('#dev .chip').forEach((c) => c.onclick = () => {
    device = device === c.dataset.v ? '' : c.dataset.v;
    $$('#dev .chip').forEach((x) => x.classList.toggle('on', x.dataset.v === device));
  });
  $('#moreAddr').onclick = () => { $('#addrMore').hidden = false; $('#moreAddr').hidden = true; $('[name=entrance]').focus(); };

  // Подсказки адреса: квартиры, где уже были, + справочник улиц
  attachAddressSuggest($('[name=address]'), async () => (await dbAll('orders'))
    .filter((x) => x.address && x.id !== v.id).sort((a, b) => b.createdAt - a.createdAt), (po) => pickFlat(po));

  // Пересечения по времени
  const visitIn = $('[name=visitAt]');
  const showConflicts = async () => {
    const ts = visitIn.value ? new Date(visitIn.value).getTime() : null;
    const list = await visitConflicts(ts, v.id);
    $('#conflicts').innerHTML = list.length ? `<div class="client-hint ${list.some((x) => x.near) ? 'bad' : ''}">
      <b>На ${esc(new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }))} уже есть:</b>
      ${list.map((x) => `<div>${x.near ? '⚠ ' : ''}${new Date(x.o.visitAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} — ${esc(shortAddress(x.o) || x.o.name || '№' + x.o.num)}${x.o.device ? ' · ' + esc(x.o.device.toLowerCase()) : ''}${x.near ? ' <b>— близко по времени</b>' : ''}</div>`).join('')}
    </div>` : '';
  };
  visitIn.addEventListener('change', showConflicts);
  visitIn.addEventListener('input', showConflicts);
  if (v.visitAt) showConflicts();

  // Клиент уже был / проблемный / на гарантии
  const phoneIn = $('[name=phone]'); const hint = $('#client');
  const showClient = async () => {
    const c = await findClientByPhone(phoneIn.value, v.id);
    if (!c) { hint.innerHTML = ''; return; }
    const l = c.last;
    const w = c.warranty;
    hint.innerHTML = `
      ${c.problem ? `<div class="client-hint bad"><b>⚠ Проблемный клиент</b>${c.problem.problemClient && c.problem.problemClient !== 'да' ? ': ' + esc(c.problem.problemClient) : ''}
        <span class="muted">(№${c.problem.num})</span></div>` : ''}
      ${w ? `<div class="client-hint warn"><b>На гарантии до ${esc(new Date(w.closedAt + w.warrantyDays * 864e5).toLocaleDateString('ru-RU'))}</b>
        — №${w.num}${w.workDone ? ': ' + esc(w.workDone) : ''}
        ${!warrantyOf ? '<br><button type="button" class="link" data-a="asw">Оформить как заявку по гарантии</button>' : ''}</div>` : ''}
      <div class="client-hint"><b>Этот клиент уже обращался</b>${c.count > 1 ? ' (заявок: ' + c.count + ')' : ''}:
        ${esc(l.name || 'без имени')}${l.address ? ', ' + esc(shortAddress(l)) : ''}
        <span class="muted">· №${l.num}, ${esc(fmtDate(l.createdAt, false))}${l.device ? ', ' + esc(l.device.toLowerCase()) : ''}</span>
        <br><button type="button" class="link" data-a="fill">Подставить имя и адрес</button></div>`;
    $('[data-a=fill]', hint).onclick = () => {
      for (const k of ['name', 'address', 'apt', 'entrance', 'floor']) if (l[k]) $('[name=' + k + ']').value = l[k];
      if (l.entrance || l.floor) { $('#addrMore').hidden = false; $('#moreAddr').hidden = true; }
      if (!device && l.device) $$('#dev .chip').find((x) => x.dataset.v === l.device)?.click();
    };
    const asw = $('[data-a=asw]', hint); if (asw) asw.onclick = () => {
      warrantyOf = w.id;
      $('#wbanner').textContent = 'Заявка по гарантии к №' + w.num; $('#wbanner').hidden = false;
      $('[data-a=fill]', hint).click(); asw.remove();
    };
  };
  phoneIn.addEventListener('input', showClient);
  if (src) showClient();

  // Выбрали квартиру, где уже были: адрес подставлен, ниже — кто там был; вбить как новую или как гарантию
  const setAddrMore = () => { if ($('[name=entrance]').value || $('[name=floor]').value) { $('#addrMore').hidden = false; $('#moreAddr').hidden = true; } };
  async function pickFlat(po) {
    const same = (await dbAll('orders')).filter((x) => x.id !== v.id && _norm(x.address) === _norm(po.address) && _norm(x.apt) === _norm(po.apt))
      .sort((a, b) => b.createdAt - a.createdAt);
    const l = same[0] || po;
    for (const k of ['apt', 'entrance', 'floor']) $('[name=' + k + ']').value = l[k] || '';
    setAddrMore();
    const w = same.find(onWarranty);
    // Ремонты в этой квартире: сначала тот, что на гарантии, потом свежие
    const repairs = same.filter((x) => x.status === 'closed').sort((a, b) => (b === w) - (a === w));
    const lastRepair = repairs[0];
    // Разные жильцы (другой телефон или имя) — пусть мастер выберет, к какому ремонту гарантия
    const who = (x) => digits(x.phone).slice(-10) || _norm(x.name);
    const manyClients = new Set(repairs.map(who)).size > 1;
    const box = $('#addrHint');
    box.innerHTML = `<div class="client-hint${w ? ' warn' : ''}">
      <b>${l.apt ? 'Кв. ' + esc(l.apt) + ' — ' : ''}здесь уже были</b>${same.length > 1 ? ' (заявок: ' + same.length + ')' : ''}:
      ${esc([l.name || 'без имени', l.phone].filter(Boolean).join(', '))}
      <span class="muted">· №${l.num}, ${esc(fmtDate(l.createdAt, false))}${l.device ? ', ' + esc(l.device.toLowerCase()) : ''}${l.model ? ' ' + esc(l.model) : ''} — ${esc(STATUS[l.status].toLowerCase())}</span>
      ${w ? `<br><b>На гарантии до ${esc(new Date(warEndOf(w)).toLocaleDateString('ru-RU'))}</b> — №${w.num}${w.workDone ? ': ' + esc(w.workDone) : ''}` : ''}
      <div class="btns" style="margin-top:8px"><button type="button" class="btn sec" data-a="flatNew">Новая заявка</button>
        ${lastRepair && !warrantyOf ? `<button type="button" class="btn sec" data-a="flatWar">${manyClients ? 'Как гарантия…' : 'Как гарантия к №' + lastRepair.num}</button>` : ''}</div></div>`;
    // Имя, телефон и техника — всегда из одной заявки, чтобы не смешать двух жильцов
    const fillClient = (r) => {
      if (r.name) $('[name=name]').value = r.name;
      if (r.phone) phoneIn.value = fmtPhone(r.phone);
      if (r.device && device !== r.device) $$('#dev .chip').find((x) => x.dataset.v === r.device)?.click();
      if (r.model) $('[name=model]').value = r.model;
    };
    $('[data-a=flatNew]', box).onclick = () => {
      if (l.name) $('[name=name]').value = l.name;
      if (l.phone) phoneIn.value = fmtPhone(l.phone);
      if (!device && l.device) $$('#dev .chip').find((x) => x.dataset.v === l.device)?.click();
      if (!$('[name=model]').value && l.model) $('[name=model]').value = l.model;
      box.innerHTML = ''; showClient();
    };
    const fw = $('[data-a=flatWar]', box); if (fw) fw.onclick = () => {
      if (!manyClients) return asWarranty(lastRepair);
      box.innerHTML = `<div class="client-hint"><b>Гарантия к какому ремонту?</b> Здесь были разные клиенты.
        <div class="btns col" style="margin-top:8px">${repairs.slice(0, 6).map((x, i) => `<button type="button" class="btn sec" data-i="${i}">
          №${x.num} · ${esc(fmtDate(x.closedAt || x.createdAt, false))}<small>${esc([x.name || 'без имени', x.phone, [x.device, x.model].filter(Boolean).join(' ')].filter(Boolean).join(' · '))}${x === w ? ' · на гарантии' : ''}</small></button>`).join('')}</div></div>`;
      $$('[data-i]', box).forEach((b) => b.onclick = () => asWarranty(repairs[+b.dataset.i]));
    };
    const asWarranty = (base) => {
      fillClient(base);
      warrantyOf = base.id;
      $('#wbanner').textContent = 'Заявка по гарантии к №' + base.num + (onWarranty(base)
        ? ' (гарантия до ' + new Date(warEndOf(base)).toLocaleDateString('ru-RU') + ')'
        : warEndOf(base) ? ' — гарантия кончилась ' + new Date(warEndOf(base)).toLocaleDateString('ru-RU') : ' — гарантию не ставили');
      $('#wbanner').hidden = false;
      box.innerHTML = ''; showClient();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
  }
  // Вставили или дописали — приводим к виду +7 (965) 932-45-76
  const tidyPhone = () => { const f = fmtPhone(phoneIn.value); if (f !== phoneIn.value) { phoneIn.value = f; showClient(); } };
  phoneIn.addEventListener('paste', () => setTimeout(tidyPhone, 0));
  phoneIn.addEventListener('change', tidyPhone);
  $('#pastePh').onclick = async () => {
    let t = '';
    try { t = await navigator.clipboard.readText(); } catch (e) { toast('Телефон не дал прочитать буфер — вставьте долгим нажатием', 4000); return; }
    const m = String(t).match(PHONE_RE);
    if (!m && digits(t).length < 5) { toast('В буфере нет номера'); return; }
    phoneIn.value = fmtPhone(m ? m[0] : t.trim());
    showClient();
  };

  // Скопировали сообщение с заявкой — раскладываем по полям (разбор прямо в телефоне)
  const fillFrom = (t) => {
    const r = parseOrderText(t);
    let n = 0;
    for (const k of ['phone', 'name', 'address', 'apt', 'entrance', 'floor', 'model', 'problem']) if (r[k]) { $('[name=' + k + ']').value = r[k]; n++; }
    if (r.entrance || r.floor) { $('#addrMore').hidden = false; $('#moreAddr').hidden = true; }
    if (r.device && device !== r.device) { $$('#dev .chip').find((x) => x.dataset.v === r.device)?.click(); n++; }
    if (r.visitAt) { visitIn.value = toDTInput(r.visitAt); showConflicts(); n++; }
    if (r.whenNote) { const nt = $('[name=notes]'); nt.value = [nt.value.trim(), r.whenNote].filter(Boolean).join('\n'); n++; }
    if (r.phone) showClient();
    return n;
  };
  const po = $('#pasteOrder'); if (po) po.onclick = async () => {
    let t = '';
    try { t = await navigator.clipboard.readText(); } catch (e) { /* не дали — попросим вставить вручную */ }
    if (t && t.trim().length >= 8 && fillFrom(t) >= 2) { toast('Заполнено из сообщения — проверьте поля', 4000); return; }
    const res = await formDialog('Заявка из сообщения', `<p class="note" style="margin-top:0">Вставьте текст сообщения: долгое нажатие → «Вставить».</p>
      <textarea class="input" name="t" rows="7">${esc(t || '')}</textarea>`, (d) => $('[name=t]', d).focus());
    if (!res || !res.t) return;
    toast(fillFrom(res.t) ? 'Заполнено из сообщения — проверьте поля' : 'Не получилось разобрать — заполните вручную', 4000);
  };

  if (!o && !src) phoneIn.focus();
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = Object.fromEntries([...fd.entries()].map(([k, val]) => [k, String(val).trim()]));
    data.phone = fmtPhone(data.phone);
    if (!data.phone && !data.name && !data.address && !data.notes && !data.problem) { toast('Заполните хотя бы одно поле'); return; }
    const now = Date.now();
    const rec = o ? { ...o } : { id: uid(), num: await nextOrderNum(), createdAt: now, status: 'open', costs: [], income: 0 };
    Object.assign(rec, data, { device, visitAt: data.visitAt ? new Date(data.visitAt).getTime() : null, updatedAt: now });
    if (warrantyOf) { rec.isWarranty = true; rec.warrantyOf = warrantyOf; }
    if (o && o.modelAuto && rec.model !== o.model) delete rec.modelAuto;   // поправили вручную — уже не «авто»
    if (o && o.deviceAuto && rec.device !== o.device) delete rec.deviceAuto;
    await dbPut('orders', rec);
    toast(o ? 'Сохранено' : 'Заявка №' + rec.num + ' создана');
    changed();
    go('#/order/' + rec.id, true);
  };
}

// Небольшое окно с полями (для «Забрал на СД» и отметки клиента)
function formDialog(title, html, onOpen) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'pw';
    d.innerHTML = `<form><h3>${esc(title)}</h3>${html}
      <div class="btns"><button type="button" class="btn sec" data-a="no">Отмена</button><button class="btn">Готово</button></div></form>`;
    document.body.appendChild(d);
    const f = $('form', d);
    const done = (val) => { d.close(); d.remove(); resolve(val); };
    $('[data-a=no]', d).onclick = () => done(null);
    d.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    f.onsubmit = (e) => { e.preventDefault(); done(Object.fromEntries([...new FormData(f).entries()].map(([k, x]) => [k, String(x).trim()]))); };
    d.showModal();
    onOpen && onOpen(d);
  });
}

async function sdDialog(o) {
  const cur = o.sd || {};
  return formDialog('Забрал на СД', `
    <div class="chips" style="margin-bottom:8px">${SD_WHAT.map((w) => `<button type="button" class="chip" data-w="${w}">${w}</button>`).join('')}</div>
    <div class="field"><label>Что забрал</label><input class="input" name="what" value="${esc(cur.what || '')}" placeholder="Например: модуль"></div>
    <div class="field"><label>Аванс, ₽ <span class="muted">— если взяли</span></label><input class="input" name="advance" inputmode="decimal" value="${cur.advance ? esc(cur.advance) : ''}" placeholder="0"></div>`,
  (d) => $$('[data-w]', d).forEach((b) => b.onclick = () => { $('[name=what]', d).value = b.dataset.w; $('[name=advance]', d).focus(); }));
}

async function renderOrder(id) {
  const o = await dbGet('orders', id);
  if (!o) return go('#/orders', true);
  setTitle('Заявка №' + o.num, true);
  const tel = digits(o.phone);
  const net = orderNet(o);
  const parent = o.warrantyOf ? await dbGet('orders', o.warrantyOf) : null;
  let report = '';
  const sdLineHtml = o.sd ? `<p class="small muted" style="margin:8px 0 0">🔧 был на СД с ${esc(dayShort(o.sd.at))}${o.sd.what ? ' · ' + esc(o.sd.what) : ''}${o.sd.advance ? ' · аванс ' + money(o.sd.advance) : ''}</p>` : '';
  const warEnd = o.warrantyDays ? o.closedAt + o.warrantyDays * 864e5 : 0;
  const warActive = warEnd >= Date.now();
  if (o.status === 'closed') {
    report = `<div class="card">
      <div class="row card-head"><h2 class="grow">Отчёт · ${esc(fmtDate(o.closedAt, false))}</h2><a class="link small" href="#/close/${o.id}">Изменить</a></div>
      <div class="stat">
        <span>Оплата клиента</span><b>${money(o.income)}</b>
        ${(o.costs || []).length ? `<span>Расходы</span><span>− ${money(orderCosts(o))}</span>
        <div class="stat-note">${(o.costs || []).map((c) => esc(c.name || 'расход') + ((o.costs || []).length > 1 ? ' — ' + money(c.amount) : '')).join('<br>')}</div>` : ''}
        <div class="sep"></div>
        <span class="em">Чистыми</span><span class="em ${net >= 0 ? 'pos' : 'neg'}">${money(net)}</span>
      </div>
      ${o.workDone ? `<p class="small" style="margin:10px 0 0"><span class="muted">Что сделано:</span> ${esc(o.workDone)}</p>` : ''}
      ${o.diagOnly && !/диагност/i.test(o.workDone || '') ? '<p class="small" style="margin:6px 0 0"><span class="tag-w">только диагностика</span></p>' : ''}
      ${o.warrantyDays ? `<p class="small" style="margin:6px 0 0"><span class="muted">Гарантия:</span> ${warrantyText(o)} — до ${esc(new Date(warEnd).toLocaleDateString('ru-RU'))}${warActive ? ` · <a class="link" href="#/new/${o.id}">Оформить по гарантии</a>` : ' <span class="muted">(кончилась)</span>'}</p>` : ''}
      ${sdLineHtml}
    </div>`;
  } else if (o.status === 'refused') {
    report = `<div class="card"><h2>Отказ · ${esc(fmtDate(o.closedAt, false))}</h2><p class="small" style="margin:0">Приехал, денег не взял${o.sd?.advance ? ', аванс вернул' : ''}.</p>${sdLineHtml}</div>`;
  } else if (o.status === 'cancelled') {
    report = `<div class="card"><h2>Отмена · ${esc(fmtDate(o.closedAt, false))}</h2><p class="small" style="margin:0">Не приезжал — клиент отменил.</p></div>`;
  }
  const sdCard = o.sd && o.status === 'sd'
    ? `<div class="card sd-card"><b>🔧 На СД</b> с ${esc(dayShort(o.sd.at))}
       ${o.sd.what ? '· ' + esc(o.sd.what) : ''}${o.sd.advance ? ' · аванс ' + money(o.sd.advance) : ''}</div>` : '';
  // Главное действие по статусу — сразу под карточкой; редкие — в «Ещё»
  let main = '', more = '';
  if (o.status === 'open') {
    main = `<div class="btns main-act"><a class="btn" href="#/close/${o.id}">Закрыть заявку</a><button class="btn sec" data-a="sd">Забрал на СД</button></div>`;
    more = `<button class="btn danger" data-a="refuse">Отказ — приехал, денег не взял</button><button class="btn danger" data-a="cancel">Отмена — клиент отменил</button>`;
  } else if (o.status === 'sd') {
    main = `<div class="main-act"><a class="btn" href="#/close/${o.id}">Отремонтировал — закрыть</a></div>`;
    more = `<button class="btn sec" data-a="sd">Изменить: что забрал, аванс</button><button class="btn danger" data-a="refuse">Отказ — вернул без ремонта</button>`;
  } else if (o.status === 'closed') {
    more = `${warActive ? '' : `<a class="btn sec" href="#/new/${o.id}">Заявка по гарантии</a>`}<button class="btn danger" data-a="reopen">Вернуть в работу</button>`;
  } else {
    more = `<button class="btn sec" data-a="reopen">Вернуть в работу</button>`;
  }
  const big = isActive(o.status);   // в работе и на СД — большие «Позвонить» и «Маршрут»; у остальных — значки
  const icons = !big && (tel || o.address) ? `<div class="ord-icons">
      ${tel ? `<a class="ico" href="${esc(telHref(o.phone))}" aria-label="Позвонить">${ICON_CALL}</a>` : ''}
      ${o.address ? `<a class="ico" href="${esc(routeHref(o))}" aria-label="Маршрут">${ICON_ROUTE}</a>` : ''}</div>` : '';
  const doneWord = { closed: 'Закрыта', refused: 'Отказ', cancelled: 'Отмена' }[o.status];
  const meta = ['Создана ' + fmtDate(o.createdAt), doneWord && o.closedAt ? doneWord + ' ' + fmtDate(o.closedAt) : ''].filter(Boolean).join(' · ');
  view.innerHTML = `
    ${big && (tel || o.address) ? `<div class="btns" style="margin-bottom:12px">
      ${tel ? `<a class="btn" href="${esc(telHref(o.phone))}">Позвонить</a>` : '<span></span>'}
      ${o.address ? `<a class="btn sec" href="${esc(routeHref(o))}">Маршрут</a>` : '<span></span>'}
    </div>` : ''}
    ${o.problemClient ? `<div class="client-hint bad" style="margin-bottom:12px"><b>⚠ Проблемный клиент</b>${o.problemClient !== 'да' ? ': ' + esc(o.problemClient) : ''}</div>` : ''}
    <div class="card">
      <div class="ord-head"><div class="ord-title">${o.device ? `<b>${esc(o.device)}</b>${o.deviceAuto ? ' <span class="muted small" title="Вид техники вписан автоматически по фото шильдика">· авто</span>' : ''}` : '<span class="muted">Техника не указана</span> · <button type="button" class="link" data-a="edit2">указать</button>'}${o.isWarranty ? ' <span class="tag-w">по гарантии</span>' : ''}
          ${o.model ? `<div class="ord-model">${esc(o.model)}${o.modelAuto ? ' <span class="muted small" title="Модель вписана автоматически по фото шильдика">· авто</span>' : ''}</div>` : ''}</div>
        <span class="badge ${o.status}">${STATUS[o.status]}</span>${icons}</div>
      <dl class="kv">
        ${o.name ? `<dt>Имя</dt><dd>${esc(o.name)}</dd>` : ''}
        ${o.phone ? `<dt>Телефон</dt><dd>${esc(o.phone)} <button type="button" class="copy-ico" data-a="copyc" aria-label="Копировать для контакта" title="Копировать для контакта">📋</button></dd>` : ''}
        ${o.address ? `<dt>Адрес</dt><dd>${esc(fullAddress(o))}</dd>` : ''}
        ${o.problem ? `<dt>Проблема</dt><dd>${esc(o.problem)}</dd>` : ''}
        ${o.visitAt && isActive(o.status) ? `<dt>Когда</dt><dd>${esc(fmtDate(o.visitAt))}</dd>` : ''}
        ${parent ? `<dt>Гарантия к</dt><dd><a href="#/order/${parent.id}">№${parent.num}</a> от ${esc(fmtDate(parent.closedAt || parent.createdAt, false))}</dd>` : ''}
        ${o.notes ? `<dt>Заметки</dt><dd>${esc(o.notes)}</dd>` : ''}
      </dl>
      <button class="link" data-a="edit">Изменить данные</button>
      <p class="ord-meta">${esc(meta)}</p>
    </div>
    ${main}
    ${sdCard}
    ${report}
    <div class="card"><h2>Фото</h2><div id="photos"></div></div>
    <details class="card fold more-act"><summary><h2>Ещё</h2></summary>
      ${more}
      <button class="btn danger" data-a="bad">${o.problemClient ? 'Снять отметку «проблемный клиент»' : '⚠ Отметить: проблемный клиент'}</button>
      <button class="btn danger" data-a="del">Удалить заявку</button>
    </details>`;
  await photoWidget(o, $('#photos'));
  const save = async (patch) => { Object.assign(o, patch, { updatedAt: Date.now() }); await dbPut('orders', o); changed(); renderOrder(id); };
  $('[data-a=edit]').onclick = () => go('#/edit/' + o.id);
  const e2 = $('[data-a=edit2]'); if (e2) e2.onclick = () => go('#/edit/' + o.id);
  const cc = $('[data-a=copyc]'); if (cc) cc.onclick = async () => {
    const t = contactLabel(o);
    if (await copyText(t)) toast('Скопировано: ' + t + ' · Сохраняйте контакт в «Телефон», не в Google', 5000);
    else toast('Не получилось скопировать: ' + t, 5000);
  };
  const sdB = $('[data-a=sd]'); if (sdB) sdB.onclick = async () => {
    const r = await sdDialog(o); if (!r) return;
    await save({ status: 'sd', sd: { at: o.sd?.at || Date.now(), what: r.what, advance: parseMoney(r.advance) } });
    toast('Отмечено: на СД');
  };
  const rf = $('[data-a=refuse]'); if (rf) rf.onclick = async () => {
    if (!confirm('Отказ: приехали, но денег не взяли' + (o.sd?.advance ? ' (аванс ' + money(o.sd.advance) + ' вернули)' : '') + '?')) return;
    await save({ status: 'refused', income: 0, costs: [], closedAt: Date.now() });
  };
  const cn = $('[data-a=cancel]'); if (cn) cn.onclick = async () => {
    if (!confirm('Отмена: не приезжали, клиент отменил?')) return;
    await save({ status: 'cancelled', closedAt: Date.now() });
  };
  const re = $('[data-a=reopen]'); if (re) re.onclick = async () => {
    await save({ status: o.sd ? 'sd' : 'open', closedAt: null });
  };
  $('[data-a=bad]').onclick = async () => {
    if (o.problemClient) { if (confirm('Снять отметку «проблемный клиент»?')) await save({ problemClient: null }); return; }
    const r = await formDialog('Проблемный клиент', `<p class="note" style="margin-top:0">При вводе этого номера в новой заявке появится предупреждение.</p>
      <div class="field"><label>Что случилось</label><input class="input" name="note" placeholder="Например: не заплатил, скандал"></div>`);
    if (r) await save({ problemClient: r.note || 'да' });
  };
  $('[data-a=del]').onclick = async () => {
    if (!confirm('Удалить заявку №' + o.num + ' вместе с фото? На Диске фото уйдут в корзину.')) return;
    for (const p of await dbByIndex('photos', 'orderId', o.id)) {
      if (p.remotePath) await addPendingDelete(p.remotePath);
      await dbDel('photos', p.id);
    }
    await dbDel('orders', o.id);
    toast('Заявка удалена'); changed(); go('#/orders', true);
  };
}

// ---------- Фото ----------
async function compressImage(file, max, q) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close && bmp.close();
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
    return blob || file;
  } catch (e) { return file; }
}

async function photoWidget(o, box) {
  const photos = (await dbByIndex('photos', 'orderId', o.id)).sort((a, b) => a.createdAt - b.createdAt);
  const tiles = photos.map((p) => {
    if (!p.blob) return `<button type="button" class="ph remote" data-remote="${p.id}">на Диске<br>открыть</button>`;
    const u = URL.createObjectURL(p.blob); photoUrls.push(u);
    return `<button type="button" class="ph" data-id="${p.id}"><img src="${u}" alt="">
      ${p.kind === 'contract' ? '<span class="tag">договор</span>' : ''}${p.uploaded ? '' : '<span class="up">↑</span>'}</button>`;
  }).join('');
  box.innerHTML = `
    ${photos.length ? `<div class="photos">${tiles}</div>` : '<div class="note">Фото пока нет</div>'}
    <div class="add-ph">
      <label>📷 Снять<input type="file" accept="image/*" capture="environment"></label>
      <label>🖼 Галерея<input type="file" accept="image/*" multiple></label>
      <label title="Если галерея не грузит">📁 Папки<input type="file" multiple></label></div>
    ${photos.some((p) => !p.uploaded && p.blob) ? '<div class="note" style="margin-top:6px">↑ — ещё не отправлено на Диск</div>' : ''}`;
  $$('input[type=file]', box).forEach((inp) => inp.onchange = async () => {
    // из «Папок» можно выбрать что угодно — берём только картинки
    const files = [...inp.files].filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
    const picked = inp.files.length; inp.value = '';
    if (!files.length) { if (picked) toast('Это не фото'); return; }
    toast('Сохраняю фото…');
    const ids = [];
    for (const f of files) {
      // крупнее и чётче, чтобы текст договора читался
      const blob = await compressImage(f, 2000, 0.8);
      const id = uid(); ids.push(id);
      await dbPut('photos', { id, orderId: o.id, kind: 'extra', blob, createdAt: Date.now(), uploaded: 0 });
    }
    toast('Фото сохранено: ' + files.length);
    await photoWidget(o, box);
    changed();
    autoPlateAfterAdd(o.id, ids);
  });
  $$('.ph[data-id]', box).forEach((b) => b.onclick = () => openViewer(b.dataset.id, o, box));
  $$('.ph[data-remote]', box).forEach((b) => b.onclick = async () => {
    b.disabled = true; b.textContent = 'Загружаю…';
    try { await fetchPhoto(b.dataset.remote); await photoWidget(o, box); } catch (e) { toast(e.message); b.disabled = false; b.innerHTML = 'на Диске<br>открыть'; }
  });
}

// Добавили фото, а модели или вида техники нет — ищем шильдик сами, в фоне. Записанное видно сразу.
function autoPlateAfterAdd(orderId, ids) {
  let said = false;
  autoPlateOnAdd(orderId, ids, (t) => { if (!said) { said = true; toast(t, 2500); } }).then((got) => {
    if (!got) return;
    toast('С шильдика записано: ' + [got.device, got.model].filter(Boolean).join(', '), 5000);
    changed();
    if (location.hash === '#/order/' + orderId) route();   // на форме закрытия не перерисовываем — там вводят суммы
  }).catch((e) => toast('Шильдик не прочитан: ' + e.message, 5000));
}

// Просмотр фото заявки: листать пальцем влево-вправо (или стрелками), счётчик «3 / 7»
async function openViewer(photoId, o, box) {
  const list = (await dbByIndex('photos', 'orderId', o.id)).filter((x) => x.blob).sort((a, b) => a.createdAt - b.createdAt);
  if (!list.length) return;
  let i = Math.max(0, list.findIndex((x) => x.id === photoId));
  let u = null;
  const v = $('#viewer');
  v.innerHTML = `<div class="stage"><img alt=""><span class="cnt"></span>
      <button class="nav prev" data-a="prev" aria-label="Предыдущее фото">‹</button><button class="nav next" data-a="next" aria-label="Следующее фото">›</button></div>
    <div class="bar"><button data-a="del" style="background:#3a1512;color:#ff8a80">Удалить</button>
    <button data-a="ocr" class="ocr">Считать модель</button><button data-a="x">Закрыть</button></div>`;
  v.hidden = false;
  const img = $('img', v);
  const show = () => {
    if (u) URL.revokeObjectURL(u);
    u = URL.createObjectURL(list[i].blob); img.src = u;
    $('.cnt', v).textContent = list.length > 1 ? (i + 1) + ' / ' + list.length : '';
    $$('.nav', v).forEach((b) => { b.hidden = list.length < 2; });
  };
  const step = (d) => { if (list.length > 1) { i = (i + d + list.length) % list.length; show(); } };
  show();
  // Свайп: палец ведёт фото за собой, отпустили дальше 60 px — следующее
  let sx = null, sy = 0, dx = 0;
  const stage = $('.stage', v);
  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { sx = null; return; }
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; dx = 0; img.style.transition = 'none';
  }, { passive: true });
  stage.addEventListener('touchmove', (e) => {
    if (sx === null || e.touches.length !== 1) return;
    dx = e.touches[0].clientX - sx;
    if (Math.abs(dx) > Math.abs(e.touches[0].clientY - sy)) img.style.transform = 'translateX(' + dx + 'px)';
  }, { passive: true });
  stage.addEventListener('touchend', () => {
    if (sx === null) return;
    img.style.transition = ''; img.style.transform = '';
    if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1);
    sx = null;
  });
  const onKey = (e) => { if (e.key === 'ArrowLeft') step(-1); else if (e.key === 'ArrowRight') step(1); else if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  $('[data-a=prev]', v).onclick = () => step(-1);
  $('[data-a=next]', v).onclick = () => step(1);
  const close = () => { v.hidden = true; v.innerHTML = ''; if (u) URL.revokeObjectURL(u); document.removeEventListener('keydown', onKey); };
  $('[data-a=x]', v).onclick = close;
  $('[data-a=del]', v).onclick = async () => {
    if (!confirm('Удалить это фото?')) return;
    const p = list[i];
    if (p.remotePath) await addPendingDelete(p.remotePath);
    await dbDel('photos', p.id);
    list.splice(i, 1); changed(); photoWidget(o, box);
    if (!list.length) { close(); return; }
    i = Math.min(i, list.length - 1); show();
  };
  // Модель с шильдика — распознаётся в телефоне, вы выбираете и проверяете
  $('[data-a=ocr]', v).onclick = async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    const reset = () => { btn.textContent = 'Считать модель'; btn.disabled = false; };
    try {
      const r = await readPlate(list[i].blob, (t) => { btn.textContent = t; });
      reset();
      const fresh = await dbGet('orders', o.id); if (!fresh) return;
      const res = await plateDialog(r, fresh.model || '', fresh.device);
      const setDev = res && res.dev === 'on' && r.device && !fresh.device;
      if (!res || (!res.model && !setDev)) return;
      if (res.model) { fresh.model = res.model; delete fresh.modelAuto; }
      if (setDev) { fresh.device = r.device; delete fresh.deviceAuto; }
      fresh.updatedAt = Date.now();
      await dbPut('orders', fresh);
      Object.assign(o, { model: fresh.model, device: fresh.device });
      toast([setDev ? fresh.device : '', res.model ? 'модель ' + res.model : ''].filter(Boolean).join(', ').replace(/^./, (c) => c.toUpperCase()) + ' — записано'); changed();
      close();
      if (location.hash.startsWith('#/order/')) route();
    } catch (err) { console.error(err); toast(err.message || 'Не получилось прочитать', 4000); reset(); }
  };
}

function plateDialog(r, cur, curDevice) {
  const guess = r.models[0] ? plateLabel(r.brand, r.models[0]) : r.brand;
  return formDialog('Модель с шильдика', `
    ${r.note ? `<p class="small warn-text" style="margin-top:0">${esc(r.note)}</p>` : ''}
    ${r.device && !curDevice ? `<label class="check" style="margin-bottom:10px"><input type="checkbox" name="dev" checked> Вписать вид техники: <b>${esc(r.device)}</b></label>` : ''}
    ${r.models.length ? `<p class="note" style="margin-top:0">Нажмите подходящую и сверьте буквы и цифры с фото:</p>
      <div class="chips" style="margin-bottom:10px">${r.models.map((m) => `<button type="button" class="chip" data-m="${esc(plateLabel(r.brand, m))}">${esc(m)}</button>`).join('')}</div>`
      : '<p class="note" style="margin-top:0">Модель не нашлась. Выберите строку из текста ниже или впишите вручную. Лучше всего читается снимок прямо, без блика.</p>'}
    <div class="field"><label>Марка / модель</label><input class="input" name="model" value="${esc(guess || cur)}" autocapitalize="characters"></div>
    ${cur && cur !== guess ? `<p class="note" style="margin-top:-4px">Сейчас записано: ${esc(cur)}</p>` : ''}
    ${r.lines.length ? `<details class="tg"><summary>Весь текст с шильдика</summary>
      <div class="chips" style="margin-top:8px">${r.lines.map((l) => `<button type="button" class="chip" data-m="${esc(l)}">${esc(l)}</button>`).join('')}</div></details>` : ''}`,
  (d) => $$('[data-m]', d).forEach((b) => b.onclick = () => { $('[name=model]', d).value = b.dataset.m; }));
}

// ---------- Закрытие заявки ----------
async function renderClose(id) {
  const o = await dbGet('orders', id);
  if (!o) return go('#/orders', true);
  const wasClosed = o.status === 'closed';
  setTitle('Отчёт · №' + o.num, true);
  const costs = (o.costs && o.costs.length) ? o.costs : [{ name: '', amount: '' }];
  // Гарантия: число + дней/месяцев; по умолчанию 12 дней, у уже закрытой — как было
  let warN = o.warrantyMonths || o.warrantyDays || (wasClosed ? '' : 12);
  let warU = o.warrantyMonths ? 'm' : 'd';
  view.innerHTML = `
    <form id="f" autocomplete="off">
      <div class="card">
        <div class="field"><label>Оплата клиента, ₽ — вся сумма</label>
          <input class="input big" name="income" inputmode="decimal" placeholder="0" value="${o.income ? esc(o.income) : ''}">
          ${o.sd?.advance ? `<p class="small warn-text" style="margin:6px 0 0">Аванс был ${money(o.sd.advance)} — впишите общую сумму вместе с ним.</p>` : ''}
          <label class="check" style="margin-top:8px"><input type="checkbox" id="diag" ${o.diagOnly ? 'checked' : ''}> Была только диагностика</label></div>
        <span class="label">Расходы — что купили по заявке</span>
        <div id="costs"></div>
        <button type="button" class="link" id="addCost">+ Добавить расход</button>
        <div class="chips" style="margin-top:6px">${COST_CHIPS.map((c) => `<button type="button" class="chip" data-c="${c}">${c}</button>`).join('')}</div>
        <div class="total" id="total"></div>
      </div>
      <div class="card">
        <div class="field"><label>Гарантия <span class="muted">— пусто или 0, если без гарантии</span></label>
          <div class="war-row"><input class="input" id="warN" inputmode="numeric" placeholder="нет" value="${esc(warN)}">
            <div class="seg" id="warU"><button type="button" data-u="d" class="${warU === 'd' ? 'on' : ''}">дней</button><button type="button" data-u="m" class="${warU === 'm' ? 'on' : ''}">месяцев</button></div>
            <button type="button" class="chip" id="warNone">без гарантии</button></div></div>
        <div class="field"><label>Что сделано <span class="muted">— если пусто, подставятся запчасти</span></label><textarea class="input" name="workDone" placeholder="Например: замена компрессора, заправка">${esc(o.workDone)}</textarea></div>
        <div class="field"><label>Дата</label><input class="input" type="date" name="date" value="${toDateInput(o.closedAt || Date.now())}"></div>
      </div>
      <div class="card"><h2>Фото</h2><div id="photos"></div></div>
      <div class="close-bar"><div class="cb-sum" id="netBar"></div>
        <button class="btn" type="submit">${wasClosed ? 'Сохранить отчёт' : 'Закрыть заявку'}</button></div>
    </form>`;
  const box = $('#costs');
  const addRow = (c = { name: '', amount: '' }, focus) => {
    const row = document.createElement('div');
    row.className = 'cost-row';
    row.innerHTML = `<input class="input" placeholder="Что купил" value="${esc(c.name)}">
      <input class="input" inputmode="decimal" placeholder="₽" value="${c.amount !== '' && c.amount != null ? esc(c.amount) : ''}">
      <button type="button" class="x" aria-label="Убрать">×</button>`;
    $('.x', row).onclick = () => { row.remove(); if (!box.children.length) addRow(); recalc(); };
    box.appendChild(row);
    if (focus) $$('input', row)[c.name ? 1 : 0].focus();
  };
  const readCosts = () => $$('.cost-row', box).map((r) => {
    const [n, a] = $$('input', r);
    return { name: n.value.trim(), amount: parseMoney(a.value) };
  }).filter((c) => c.name || c.amount);
  const recalc = () => {
    const inc = parseMoney($('[name=income]').value);
    const cs = readCosts().reduce((s, c) => s + c.amount, 0);
    const net = inc - cs;
    $('#total').innerHTML = `<span>Оплата клиента</span><span>${money(inc)}</span>
      <span>Расходы</span><span>− ${money(cs)}</span>
      <span class="sum">Чистыми</span><span class="sum ${net >= 0 ? 'pos' : 'neg'}">${money(net)}</span>`;
    // итог рядом с кнопкой — сумма и действие видны вместе
    $('#netBar').innerHTML = `<span class="muted small">Чистыми</span><b class="${net >= 0 ? 'pos' : 'neg'}">${money(net)}</b>
      <span class="muted small">${money(inc)}${cs ? ' − ' + money(cs) : ''}</span>`;
  };
  costs.forEach((c) => addRow(c));
  $('#addCost').onclick = () => addRow({ name: '', amount: '' }, true);
  $$('[data-c]').forEach((ch) => ch.onclick = () => {
    const empty = $$('.cost-row', box).find((r) => !$$('input', r)[0].value && !$$('input', r)[1].value);
    if (empty) { $$('input', empty)[0].value = ch.dataset.c; $$('input', empty)[1].focus(); } else addRow({ name: ch.dataset.c, amount: '' }, true);
  });
  $$('#warU button').forEach((b) => b.onclick = () => { warU = b.dataset.u; $$('#warU button').forEach((x) => x.classList.toggle('on', x === b)); });
  $('#warNone').onclick = () => { $('#warN').value = ''; };
  $('#warN').oninput = () => { $('#warN').value = $('#warN').value.replace(/\D/g, '').slice(0, 3); };
  $('#diag').onchange = () => {
    const w = $('[name=workDone]');
    if ($('#diag').checked) { $('#warN').value = ''; if (!w.value.trim()) w.value = 'Диагностика'; }
    else if (w.value.trim() === 'Диагностика') w.value = '';
  };
  $('#f').addEventListener('input', recalc);
  recalc();
  await photoWidget(o, $('#photos'));
  if (!wasClosed) $('[name=income]').focus();

  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const fresh = await dbGet('orders', id);
    const date = $('[name=date]').value;
    const cs = readCosts();
    const diag = $('#diag').checked;
    const work = $('[name=workDone]').value.trim() || cs.map((c) => c.name).filter(Boolean).join(', ') || (diag ? 'Диагностика' : '');
    const closedAt = fromDateInput(date, fresh.closedAt);
    const n = parseInt($('#warN').value, 10) || 0;
    let wDays = n, wMonths = null;
    if (n && warU === 'm') {   // месяцы → точное число дней от даты закрытия
      const end = new Date(closedAt); end.setMonth(end.getMonth() + n);
      wDays = Math.round((end - closedAt) / 864e5); wMonths = n;
    }
    Object.assign(fresh, {
      income: parseMoney($('[name=income]').value),
      costs: cs,
      workDone: work,
      diagOnly: diag || undefined,
      warrantyDays: wDays || null,
      warrantyMonths: wMonths,
      status: 'closed',
      closedAt,
      updatedAt: Date.now(),
    });
    await dbPut('orders', fresh);
    toast(`№${fresh.num} закрыта · чистыми ${money(orderNet(fresh))}`);
    changed();
    go('#/order/' + id, true);
  };
}

// ================= РЕКЛАМА И ПРОЧЕЕ (живут в «Отчёте») =================
async function renderExpenseForm(id) {
  const e0 = id ? await dbGet('expenses', id) : null;
  if (id && !e0) return go('#/report', true);
  setTitle(e0 ? 'Реклама и прочее' : 'Новый расход', true);
  // новый расход — в тот месяц, который открыт в отчёте
  const [ry, rm] = state.month.split('-').map(Number);
  const defDate = state.month === monthKey(Date.now()) ? Date.now() : new Date(ry, rm - 1, 1, 12).getTime();
  let cat = e0 ? e0.category : 'Реклама';
  let month = e0 ? monthKey(e0.date) : state.month;
  const cats = EXP_CATS.includes(cat) ? EXP_CATS : [...EXP_CATS, cat]; // старые категории не теряем
  view.innerHTML = `
    <form id="f" autocomplete="off">
      <div class="field"><label>Что за расход</label>
        <div class="chips" id="cats">${cats.map((c) => `<button type="button" class="chip ${c === cat ? 'on' : ''}" data-v="${c}">${c}</button>`).join('')}</div></div>
      <div class="field" id="monthF"><label>За какой месяц</label>
        <div class="month-nav" style="margin:0"><button type="button" id="mPrev">‹</button><b id="mName"></b><button type="button" id="mNext">›</button></div></div>
      <div class="field"><label>Сумма, ₽</label><input class="input big" name="amount" inputmode="decimal" placeholder="0" value="${e0 ? esc(e0.amount) : ''}"></div>
      <div class="field"><label id="cLabel"></label><input class="input" name="comment" value="${esc(e0?.comment)}"></div>
      <div class="field" id="dateF"><label>Дата</label><input class="input" type="date" name="date" value="${toDateInput(e0 ? e0.date : defDate)}"></div>
      <button class="btn" type="submit">Сохранить</button>
      ${e0 ? '<button class="btn danger" type="button" id="del">Удалить</button>' : ''}
    </form>`;
  const sync = () => {
    const monthly = EXP_MONTHLY.includes(cat);
    $('#monthF').hidden = !monthly; $('#dateF').hidden = monthly;
    $('#mName').textContent = monthName(month);
    $('#cLabel').innerHTML = monthly ? 'Комментарий <span class="muted">— можно не писать</span>' : 'За что заплачено';
    $('[name=comment]').placeholder = cat === 'Реклама' ? 'Например: Авито, Яндекс' : cat === 'Колибри' ? 'колл-трекинг' : 'Например: бензин, инструмент, связь';
  };
  $$('#cats .chip').forEach((c) => c.onclick = () => { cat = c.dataset.v; $$('#cats .chip').forEach((x) => x.classList.toggle('on', x === c)); sync(); });
  $('#mPrev').onclick = () => { month = shiftMonth(month, -1); sync(); };
  $('#mNext').onclick = () => { month = shiftMonth(month, 1); sync(); };
  sync();
  if (!e0) $('[name=amount]').focus();
  $('#f').onsubmit = async (ev) => {
    ev.preventDefault();
    const amount = parseMoney($('[name=amount]').value);
    if (!amount) { toast('Введите сумму'); return; }
    const monthly = EXP_MONTHLY.includes(cat);
    const comment = $('[name=comment]').value.trim();
    if (!monthly && !comment) { toast('Напишите, за что заплачено'); $('[name=comment]').focus(); return; }
    const [y, m] = month.split('-').map(Number);
    const date = monthly ? new Date(y, m - 1, 1, 12).getTime() : fromDateInput($('[name=date]').value, e0?.date);
    const rec = { ...(e0 || { id: uid(), createdAt: Date.now() }), category: cat, amount, comment, date, monthly: monthly || undefined, updatedAt: Date.now() };
    await dbPut('expenses', rec);
    state.month = monthKey(date); // показать отчёт за тот месяц, куда записали
    toast('Расход сохранён'); changed(); go('#/report', true);
  };
  const d = $('#del'); if (d) d.onclick = async () => {
    if (!confirm('Удалить расход?')) return;
    await dbDel('expenses', e0.id); changed(); go('#/report', true);
  };
}

// ================= ОТЧЁТ =================
function monthStats(orders, expenses, key) {
  const done = orders.filter((o) => !isActive(o.status) && o.closedAt && monthKey(o.closedAt) === key);
  const closed = done.filter((o) => o.status === 'closed');
  const income = closed.reduce((s, o) => s + (Number(o.income) || 0), 0);
  const parts = closed.reduce((s, o) => s + orderCosts(o), 0);
  const exps = expenses.filter((e) => monthKey(e.date) === key);
  const byCat = {};
  exps.forEach((e) => { byCat[e.category] = (byCat[e.category] || 0) + e.amount; });
  const other = exps.reduce((s, e) => s + e.amount, 0);
  return { done, closed, refused: done.filter((o) => o.status === 'refused').length, cancelled: done.filter((o) => o.status === 'cancelled').length,
    income, parts, net: income - parts, byCat, other, profit: income - parts - other };
}

async function renderReport() {
  setTitle('Отчёт');
  const orders = await dbAll('orders');
  const expenses = await dbAll('expenses');
  const key = state.month;
  const s = monthStats(orders, expenses, key);
  const paid = s.closed.filter((o) => (Number(o.income) || 0) > 0).length;   // закрытые с оплатой 0 ₽ в средний чек не идут
  const avg = paid ? s.income / paid : 0;
  const byDev = {};
  s.closed.forEach((o) => { const d = o.device || 'Не указано'; byDev[d] = byDev[d] || { n: 0, net: 0 }; byDev[d].n++; byDev[d].net += orderNet(o); });
  const months = [-5, -4, -3, -2, -1, 0].map((k) => shiftMonth(key, k));
  const profits = months.map((m) => monthStats(orders, expenses, m).profit);
  const maxAbs = Math.max(1, ...profits.map(Math.abs));
  const openNow = orders.filter((o) => o.status === 'open').length;
  const sdNow = orders.filter((o) => o.status === 'sd').length;
  const short = (n) => Math.abs(n) >= 1000 ? Math.round(n / 1000) + 'к' : Math.round(n);
  // Заработок по дням месяца (чистыми с заявок)
  const [yy, mm] = key.split('-').map(Number);
  const nDays = new Date(yy, mm, 0).getDate();
  const perDay = Array(nDays).fill(0);
  s.closed.forEach((o) => { perDay[new Date(o.closedAt).getDate() - 1] += orderNet(o); });
  const maxDay = Math.max(1, ...perDay.map(Math.abs));
  const workDays = perDay.filter((x) => x).length;
  const today = monthKey(Date.now()) === key ? new Date().getDate() : 0;
  const total = s.closed.length + s.refused + s.cancelled;
  const exps = expenses.filter((e) => monthKey(e.date) === key).sort((a, b) => b.date - a.date);

  view.innerHTML = `
    <div class="month-nav"><button id="prev">‹</button><b>${monthName(key)}</b><button id="next">›</button></div>
    <div class="card">
      <h2>Прибыль за месяц</h2>
      <div class="big-num ${s.profit >= 0 ? 'pos' : 'neg'}">${money(s.profit)}</div>
      <div class="stat" style="margin-top:12px">
        <span>Оплата клиентов</span><b>${money(s.income)}</b>
        <span>Расходы</span><span>− ${money(s.parts)}</span>
        <span>Чистыми с заявок</span><b>${money(s.net)}</b>
        ${Object.entries(s.byCat).map(([c, v]) => `<span class="muted">− ${esc(c)}</span><span class="muted">${money(v)}</span>`).join('')}
        <div class="sep"></div>
        <span class="em">Итого прибыль</span><span class="em ${s.profit >= 0 ? 'pos' : 'neg'}">${money(s.profit)}</span>
      </div>
    </div>
    <div class="card">
      <div class="row card-head"><h2 class="grow">Реклама и прочее</h2><a class="btn sec mini" href="#/expense/new">+ Добавить</a></div>
      ${exps.length ? `<div class="list">${exps.map((e) => `<a class="item" href="#/expense/${e.id}" style="border:0;padding:6px 0">
        <div class="row small"><span class="grow">${esc(e.category)}${e.comment ? ' · ' + esc(e.comment) : ''}</span>
        <span class="muted">${e.monthly ? 'за месяц' : esc(dayShort(e.date))}</span><span class="neg">${money(e.amount)}</span></div></a>`).join('')}</div>`
        : '<p class="note" style="margin:0">В этом месяце пусто. Реклама, бензин и всё, что не относится к одной заявке.</p>'}
    </div>
    <div class="card">
      <h2>Заработок по дням</h2>
      <div class="bars days">${perDay.map((v, i) => `<div class="bar ${i + 1 === today ? 'cur' : ''}" title="${i + 1}: ${money(v)}">
        <span class="v">${v && Math.abs(v) / maxDay > 0.45 ? short(v) : ''}</span>
        <i class="${v < 0 ? 'neg' : ''}" style="height:${Math.round(Math.abs(v) / maxDay * 100)}%"></i>
        <span>${(i + 1) % 5 === 0 || i === 0 ? i + 1 : ''}</span></div>`).join('')}</div>
      <p class="note" style="margin-bottom:0">Рабочих дней с заработком: ${workDays}${workDays ? ', в среднем ' + money(s.net / workDays) + ' в день' : ''}</p>
    </div>
    <div class="card">
      <h2>Выезды</h2>
      <div class="stat">
        <span>Сделал</span><b>${s.closed.length}</b>
        <span>Отказ</span><span>${s.refused}</span>
        <span>Отмена</span><span>${s.cancelled}</span>
        ${total ? `<span class="muted">Доля выездов с деньгами</span><span class="muted">${Math.round(s.closed.filter((o) => (Number(o.income) || 0) > 0).length / Math.max(1, s.closed.length + s.refused) * 100)}%</span>` : ''}
        <div class="sep"></div>
        <span>Средний чек</span><b>${money(avg)}</b>
        <span>Сейчас на СД</span><span>${sdNow}</span>
        <span>Сейчас в работе</span><span>${openNow}</span>
        ${Object.keys(byDev).length ? '<div class="sep"></div>' : ''}
        ${Object.entries(byDev).map(([d, v]) => `<span>${esc(d)} · ${v.n} шт</span><span>${money(v.net)}</span>`).join('')}
      </div>
    </div>
    <div class="card">
      <h2>Прибыль по месяцам</h2>
      <div class="bars">${months.map((m, i) => `<div class="bar ${m === key ? 'cur' : ''}">
        <span class="v">${profits[i] ? short(profits[i]) : ''}</span>
        <i class="${profits[i] < 0 ? 'neg' : ''}" style="height:${Math.round(Math.abs(profits[i]) / maxAbs * 100)}%"></i>
        <span>${monthName(m, true)}</span></div>`).join('')}</div>
    </div>
    ${s.done.length ? `<div class="card"><h2>Закрытые в этом месяце</h2><div class="list">${s.done.sort((a, b) => b.closedAt - a.closedAt).map((o) => `
      <a class="item" href="#/order/${o.id}" style="border:0;padding:6px 0">
        <div class="row small"><b>№${o.num}</b><span class="grow">${esc([o.device, o.name || shortAddress(o)].filter(Boolean).join(' · '))}</span>
        ${o.status === 'closed' ? `<span class="${orderNet(o) >= 0 ? 'pos' : 'neg'}">${money(orderNet(o))}</span>` : `<span class="badge ${o.status}">${STATUS[o.status]}</span>`}</div></a>`).join('')}</div></div>` : ''}`;
  $('#prev').onclick = () => { state.month = shiftMonth(key, -1); renderReport(); };
  $('#next').onclick = () => { state.month = shiftMonth(key, 1); renderReport(); };
}

// ================= ПАРОЛЬ, ДИСК И КОПИИ =================
const redirectUri = () => location.origin + location.pathname;

// Окно ввода пароля. Возвращает пароль или null, если нажали «Отмена».
function passwordDialog({ title, text, repeat }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'pw';
    d.innerHTML = `<form>
      <h3>${esc(title)}</h3>
      ${text ? `<p class="note">${esc(text)}</p>` : ''}
      <input class="input" type="password" name="p1" placeholder="Пароль" autocomplete="${repeat ? 'new-password' : 'current-password'}">
      ${repeat ? '<input class="input" type="password" name="p2" placeholder="Ещё раз тот же пароль" autocomplete="new-password" style="margin-top:8px">' : ''}
      <label class="small muted show"><input type="checkbox"> показать пароль</label>
      <p class="small neg" data-err hidden></p>
      <div class="btns"><button type="button" class="btn sec" data-a="no">Отмена</button><button class="btn">Готово</button></div>
    </form>`;
    document.body.appendChild(d);
    const f = $('form', d);
    const err = $('[data-err]', d);
    const done = (v) => { d.close(); d.remove(); resolve(v); };
    $('.show input', d).onchange = (e) => $$('input.input', d).forEach((i) => { i.type = e.target.checked ? 'text' : 'password'; });
    $('[data-a=no]', d).onclick = () => done(null);
    d.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    f.onsubmit = (e) => {
      e.preventDefault();
      const p1 = f.p1.value;
      if (repeat && p1.length < 8) { err.textContent = 'Нужно не меньше 8 символов'; err.hidden = false; return; }
      if (repeat && p1 !== f.p2.value) { err.textContent = 'Пароли не совпадают'; err.hidden = false; return; }
      if (!p1) return;
      done(p1);
    };
    d.showModal();
    f.p1.focus();
  });
}

const askCopyPassword = (attempt) => passwordDialog({
  title: 'Пароль от копии',
  text: attempt ? 'Пароль не подошёл. Попробуйте ещё раз.' : 'Копия зашифрована. Введите пароль, который задавали в приложении.',
});

const syncMessage = (r) => ({
  ok: 'Готово, отправлено', nothing: 'Всё уже на Диске',
  waiting: r.why === 'busy' ? 'Диск попросил подождать — продолжу позже' : 'Нет связи — отправлю позже',
  busy: 'Уже отправляется', paused: 'Отправка на паузе — проверьте копию на Диске', nokey: 'Сначала задайте пароль', off: 'Диск не подключён',
}[r.status] || r.error || 'Ошибка');

// ---------- Отправка на Диск с процентом ----------
const WAIT_WHY = {
  offline: 'Нет интернета — отправлю, когда появится.',
  busy: 'Яндекс Диск попросил подождать: много файлов подряд. Продолжу сам через пару минут.',
  net: 'Связь с Диском обрывалась. Так бывает, когда гаснет экран или приложение свёрнуто: Android отключает интернет приложениям в фоне. Нажмите «Отправить» и не сворачивайте приложение.',
};
let sendingAll = false;

function diskProgressHtml(done, all) {
  const pct = all ? Math.floor(done * 100 / all) : 100;
  return `<div class="dprog"><div class="dprog-bar"><i style="width:${pct}%"></i></div>
    <div class="small"><b>${pct}%</b> · фото на Диске: ${done} из ${all}</div></div>`;
}
function updateDiskProgress(done, all) {
  const box = $('.dprog'); if (!box) return;
  box.outerHTML = diskProgressHtml(done, all);
  const sn = $('#syncNow'); if (sn && sendingAll) sn.textContent = `Отправляю… ${Math.floor(done * 100 / all)}%`;
}

// Отправляет всё, что ждёт, держа экран включённым. Диск занят или связь мигнула — ждёт и продолжает,
// пока приложение открыто. Свернули — пауза, продолжит обычная отправка при открытии.
async function sendAll() {
  if (sendingAll) return;
  sendingAll = true;
  let lock = null;
  const takeLock = async () => { try { if (!lock || lock.released) lock = await navigator.wakeLock?.request('screen'); } catch (e) { /* экран может погаснуть */ } };
  await takeLock();
  const onVis = () => { if (!document.hidden) takeLock(); };
  document.addEventListener('visibilitychange', onVis);
  await setMeta('syncError', null);
  renderSettings();
  let r, fails = 0;
  try {
    for (;;) {
      r = await syncNow();
      updateSyncBadge();
      if (r.status !== 'waiting' && r.status !== 'busy') break;
      if (r.sent) fails = 0; else fails++;
      if (fails > 30 || !navigator.onLine) break;                // долго не идёт или нет интернета — сдаёмся
      const pause = r.status === 'busy' ? 3000 : r.why === 'busy' ? 60000 : 15000;
      await new Promise((ok) => setTimeout(ok, pause));
      while (document.hidden) await new Promise((ok) => setTimeout(ok, 5000)); // свернули — ждём возвращения
    }
  } finally {
    sendingAll = false;
    document.removeEventListener('visibilitychange', onVis);
    try { lock && lock.release(); } catch (e) { /* пусто */ }
  }
  toast(syncMessage(r));
  updateSyncBadge();
  if (location.hash.startsWith('#/settings')) renderSettings();
}

// Редко нужные разделы «Диска» свёрнуты; открытые остаются открытыми при обновлении экрана
const foldOpen = new Set();
const foldAttr = (id) => (foldOpen.has(id) ? 'open' : '');

async function renderSettings() {
  setTitle('Диск и копии');
  const s = await syncStatus();
  const clientId = (await getMeta('ydClientId')) || '';
  let est = '';
  try { const e = await navigator.storage.estimate(); est = Math.round(e.usage / 1048576) + ' МБ'; } catch (e) { /* нет данных */ }

  const lock = s.hasKey ? `
    <p class="small" style="margin-top:0">🔒 <b>Пароль задан.</b> Всё, что уходит на Яндекс Диск и в файл копии, зашифровано.
      Без пароля это не откроет ни Яндекс, ни тот, кто войдёт в ваш аккаунт.</p>
    <button class="btn sec" id="checkPw">Проверить, помню ли пароль</button>`
    : `
    <p class="small" style="margin-top:0">Задайте пароль. Им шифруется всё, что уходит с телефона: копия на Яндекс Диске и файл копии.
      Без пароля Диск ничего не получает.</p>
    <p class="small"><b>Запишите пароль</b> и храните отдельно от телефона. Если его забыть, копию на Диске и в файлах открыть будет
      нельзя никак. Данные в самом телефоне останутся.</p>
    <p class="note">Переезжаете на новый телефон? Задайте тот же пароль, что и на старом.</p>
    <button class="btn" id="setPw">Задать пароль</button>`;

  const disk = s.connected ? `
    <div class="stat">
      <span>Состояние</span><b>${s.error ? '<span class="neg">ошибка</span>' : !s.hasKey ? '<span class="neg">нужен пароль</span>' : 'подключён'}</b>
      <span>Последняя отправка</span><span>${s.lastSync ? esc(fmtDate(s.lastSync)) : '—'}</span>
      <span>Ждут отправки</span><span>${s.pendingPhotos} фото${s.dataPending ? ' + данные' : ''}</span>
    </div>
    ${s.pendingPhotos ? diskProgressHtml(s.uploadedPhotos, s.uploadedPhotos + s.pendingPhotos) : ''}
    ${s.paused ? `<div class="client-hint bad" style="margin-top:10px"><b>⏸ Отправка на паузе.</b>
      ${s.paused === 'both' ? 'Данные в телефоне и на Диске различаются — выберите, какую копию оставить.' : 'Не удалось проверить копию на Диске (нет связи или другой пароль).'}
      <br><button type="button" class="link" id="checkCopy">Проверить копию на Диске</button></div>` : ''}
    ${s.error ? `<p class="small neg">${esc(s.error)}</p>` : ''}
    ${!s.hasKey ? '<p class="small neg">Задайте пароль выше — без него на Диск ничего не отправляется.</p>' : ''}
    ${s.waiting && !s.error && !sendingAll ? `<p class="small muted">${WAIT_WHY[s.waitWhy] || WAIT_WHY.net}</p>` : ''}
    <button class="btn" id="syncNow" style="margin-top:12px" ${sendingAll ? 'disabled' : ''}>${sendingAll ? 'Отправляю…' : s.pendingPhotos > 20 ? 'Отправить всё' : 'Отправить сейчас'}</button>
    ${s.pendingPhotos > 20 ? '<p class="note" style="margin-top:0">Пока идёт отправка, экран не гаснет. Держите приложение открытым, лучше на зарядке и Wi-Fi. Свернёте — отправка встанет на паузу и продолжится, когда откроете.</p>' : ''}
    <button class="btn sec" id="fromDisk">Восстановить с Диска</button>
    <button class="btn danger" id="disconnect">Отключить Диск</button>
    <p class="note">На Диске в папке «Приложения» лежат только зашифрованные файлы <b>data.bin</b> и папка <b>Фото</b>.
      Открыть их можно только здесь, с вашим паролем. Фото, которых нет в телефоне, открываются кнопкой «на Диске» в заявке.</p>`
    : !s.hasKey ? '<p class="small">Сначала задайте пароль выше, потом здесь появится подключение.</p>' : `
    <p class="small">Подключается один раз. После этого заявки и фото сами уходят на ваш Яндекс Диск, когда есть интернет. Уходят в зашифрованном виде.</p>
    <ol class="steps">
      <li>Откройте <a href="https://oauth.yandex.ru/client/new" target="_blank" rel="noopener">oauth.yandex.ru/client/new</a> и войдите в свой Яндекс.</li>
      <li>Тип приложения: <b>Для доступа к API или отладки</b>.</li>
      <li>Название: <b>Мои заявки</b>. Почта — ваша.</li>
      <li>В поле «Название доступа» напечатайте <b>папке</b> и выберите <b>Доступ к папке приложения на Диске</b> (под ним серым <code>cloud_api:disk.app_folder</code>). Больше ничего. <b>Не</b> выбирайте «Доступ к Яндекс.Диску для приложений» (<code>yadisk:disk</code>): он открывает весь Диск и приложению не подходит.</li>
      <li>Адрес возврата не меняйте. Нажмите «Создать приложение» и скопируйте <b>ClientID</b> сюда:</li>
    </ol>
    <div class="field"><input class="input" id="cid" placeholder="ClientID" value="${esc(clientId)}" autocomplete="off"></div>
    <button class="btn sec" id="getToken">Получить ключ доступа</button>
    <p class="note">Откроется страница Яндекса. Разрешите доступ, и Яндекс покажет длинный ключ (токен).
      Скопируйте его, вернитесь сюда и вставьте:</p>
    <div class="field"><input class="input" id="token" placeholder="Ключ доступа" autocomplete="off"></div>
    <button class="btn" id="connect">Подключить Яндекс Диск</button>
    <p class="small neg" id="connErr" hidden></p>`;

  const tgLeft = Object.keys((await getMeta('tgPhotoMap')) || {}).length;
  const visitHours = Number(await getMeta('visitHours')) || 1.5;
  const ocrUrl = (await getMeta('ocrUrl')) || '';
  const ocrKey = (await getMeta('ocrKey')) || '';
  const autoPlate = (await getMeta('autoPlate')) !== false;
  const st = await streetsInfo().catch(() => null);
  const stChecked = await getMeta('streetsCheckedAt');
  const fmtDay = (d) => (d ? d.split('-').reverse().join('.') : 'старая, без даты');

  view.innerHTML = `
    ${s.hasKey ? `<div class="card"><h2>Яндекс Диск</h2>${disk}</div>
    <details class="card fold" data-fold="pw" ${foldAttr('pw')}><summary><h2>Пароль для шифрования</h2><span class="fold-note">🔒 задан</span></summary>${lock}</details>`
    : `<div class="card"><h2>Пароль для шифрования</h2>${lock}</div>
    <div class="card"><h2>Яндекс Диск</h2>${disk}</div>`}
    <details class="card fold" data-fold="backup" ${foldAttr('backup')}><summary><h2>Резервная копия без интернета</h2></summary>
      <p class="note" style="margin-top:0">Файл со всеми заявками и расходами (без фото), зашифрован вашим паролем.
        Можно отправить себе в Telegram: без пароля его никто не прочитает.</p>
      <button class="btn sec" id="share">Отправить копию…</button>
      <button class="btn sec" id="download">Скачать копию файлом</button>
      <label class="btn danger" style="margin-top:8px">Восстановить из файла<input type="file" id="restore" accept=".txt,.json,text/plain,application/json" hidden></label>
    </details>
    <details class="card fold" data-fold="csv" ${foldAttr('csv')}><summary><h2>Таблица для Excel</h2></summary>
      <p class="note" style="margin-top:0">Скачать можно только с паролем. Сам файл <b class="neg">не зашифрован</b>:
        он сохраняется в «Загрузки» этого телефона. Не пересылайте его и удалите, когда он больше не нужен.</p>
      <button class="btn sec" id="csv">🔒 Скачать таблицу заявок</button>
    </details>
    ${tgLeft ? `<div class="card"><h2>Фото из Telegram</h2>
      <p class="small" style="margin-top:0">Не дошли фото к старым заявкам: <b>${tgLeft}</b>. Выберите архив <b>фото.zip</b> из папки импорта —
        приложение само разложит снимки по заявкам. Лучше по Wi-Fi и не закрывать приложение, пока идёт.</p>
      <label class="btn sec"><span>Добавить фото из архива</span><input type="file" id="tgZip" accept=".zip,application/zip,application/x-zip-compressed" hidden></label>
      <label class="link small" style="display:block;margin-top:8px">или выбрать снимки по одному<input type="file" id="tgPhotos" accept="image/*" multiple hidden></label>
      <p class="note">После этого удалите архив из телефона: он не зашифрован.</p>
    </div>` : ''}
    <details class="card fold" data-fold="ocr" ${foldAttr('ocr')}><summary><h2>Считывание шильдиков</h2></summary>
      <p class="small" style="margin-top:0">Кнопка «Считать модель» на фото. Точно читает распознавание Яндекса через вашу функцию в Яндекс Облаке.
        По кнопке уходит только то фото, на котором вы её нажали, — без места съёмки.</p>
      <div class="field"><label>Ссылка функции</label>
        <input class="input" id="ocrUrl" inputmode="url" autocomplete="off" placeholder="https://functions.yandexcloud.net/…" value="${esc(ocrUrl)}"></div>
      <div class="field"><label>Секретный ключ <span class="muted">— тот же, что APP_KEY в функции</span></label>
        <input class="input" id="ocrKey" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(ocrKey)}">
        <label class="small muted show" style="display:flex;align-items:center;gap:6px;margin-top:6px"><input type="checkbox" id="ocrShow"> показать ключ
          <span id="ocrLen" style="margin-left:auto"></span></label></div>
      <div class="btns"><button class="btn" id="ocrSave">Сохранить</button><button class="btn sec" id="ocrTest">Проверить</button></div>
      ${ocrUrl && ocrKey ? `<label class="check" style="margin-top:12px"><input type="checkbox" id="autoPlate" ${autoPlate ? 'checked' : ''}> Сразу искать шильдик в новых фото заявки</label>
      <p class="note" style="margin-top:4px">Если в заявке нет модели или вида техники, приложение само найдёт шильдик среди добавленных фото и впишет их.
        Каждое фото сначала читается прямо в телефоне. Договоры, квитанции, фото с адресом, именем с отчеством или номером телефона в Яндекс не уходят.
        Это <b>снижает риск</b> отправки личных данных, но не исключает его полностью: телефон читает фото не идеально.</p>` : ''}
      <p class="note">${ocrUrl && ocrKey ? '✓ Настроено.' : 'Не настроено — тогда фото читается прямо в телефоне, но заметно хуже.'}
        Ключ хранится только в этом телефоне и на Диск не отправляется.</p>
    </details>
    <details class="card fold" data-fold="streets" ${foldAttr('streets')}><summary><h2>Справочник улиц</h2><span class="fold-note">${st && st.date ? 'от ' + esc(fmtDay(st.date)) : ''}</span></summary>
      ${st ? `<div class="stat" style="margin-top:0">
        <span>База от</span><b>${esc(fmtDay(st.date))}</b>
        <span>Улиц и сёл</span><span>${st.streets.toLocaleString('ru-RU')}</span>
        <span>Домов</span><span>${st.houses.toLocaleString('ru-RU')}</span>
        <span>Проверено</span><span>${stChecked ? esc(dayShort(stChecked)) + ' ' + hhmm(new Date(stChecked)) : 'ещё нет'}</span>
      </div>
      <p class="note">Источник: ${esc(st.src)}. Уфа и Уфимский район. Справочник лежит в телефоне и работает без интернета.</p>` : ''}
      <button class="btn sec" id="updStreets">Проверить обновление справочника</button>
      <p class="note">Справочник обновляется сам: раз в сутки, когда есть интернет, телефон проверяет сайт и скачивает новую базу,
        если она вышла. Кнопка — проверить прямо сейчас. На сайт ничего не уходит.</p>
    </details>
    <div class="card"><h2>Приложение</h2>
      <div class="stat">
        <span>Версия</span><b>${APP_VERSION}</b>
        <span>Занято в телефоне</span><span>${est || '—'}</span>
      </div>
      <div class="field" style="margin-top:12px"><label>Длительность выезда <span class="muted">— для предупреждения о пересечении по времени</span></label>
        <select class="input" id="visitHours">${[1, 1.5, 2, 3].map((h) => `<option value="${h}" ${h === visitHours ? 'selected' : ''}>${String(h).replace('.', ',')} ч</option>`).join('')}</select></div>
      <button class="btn sec" id="checkUpd">Проверить обновление</button>
      <p class="note">Обновление не трогает заявки, фото и пароль — они остаются в телефоне.</p>
    </div>
    <p class="note">Справочник улиц: © участники OpenStreetMap (ODbL)</p>`;

  $('#visitHours').onchange = async (e) => { await setMeta('visitHours', Number(e.target.value)); toast('Сохранено'); };
  $$('details.fold', view).forEach((d) => d.ontoggle = () => { if (d.open) foldOpen.add(d.dataset.fold); else foldOpen.delete(d.dataset.fold); });

  // Считывание шильдиков через Яндекс
  const ocrRead = () => ({ url: $('#ocrUrl').value.trim(), key: $('#ocrKey').value.trim() });
  const ocrLen = () => { const n = $('#ocrKey').value.trim().length; $('#ocrLen').textContent = n ? 'символов: ' + n : ''; };
  $('#ocrShow').onchange = (e) => { $('#ocrKey').type = e.target.checked ? 'text' : 'password'; };
  $('#ocrKey').addEventListener('input', ocrLen); ocrLen();
  const ocrOk = (c) => {
    if (c.url && !/^https:\/\/functions\.yandexcloud\.net\/[\w-]+\/?$/.test(c.url)) { toast('Ссылка должна быть вида https://functions.yandexcloud.net/…', 4000); return false; }
    if (c.url && c.key.length < 12) { toast('Ключ слишком короткий — нужен тот же, что APP_KEY в функции', 4000); return false; }
    return true;
  };
  $('#ocrSave').onclick = async () => {
    const c = ocrRead(); if (!ocrOk(c)) return;
    await setMeta('ocrUrl', c.url || null); await setMeta('ocrKey', c.url ? c.key : null);
    toast(c.url ? 'Сохранено' : 'Отключено'); renderSettings();
  };
  $('#ocrTest').onclick = async (e) => {
    const c = ocrRead(); if (!c.url || !ocrOk(c)) { if (!c.url) toast('Вставьте ссылку и ключ'); return; }
    const b = e.target; b.disabled = true; b.textContent = 'Проверяю…';
    try {
      // проверочная картинка с надписью — не фото клиента
      const cv = document.createElement('canvas'); cv.width = 900; cv.height = 260;
      const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 900, 260);
      g.fillStyle = '#000'; g.font = 'bold 64px Arial'; g.fillText('MODEL TEST-123', 40, 150);
      const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.9));
      const text = await cloudOcrText(blob, c);
      if (/123/.test(text)) { await setMeta('ocrUrl', c.url); await setMeta('ocrKey', c.key); toast('Работает: Яндекс прочитал «' + text.trim().slice(0, 30) + '». Сохранено.', 5000); renderSettings(); }
      else toast('Функция ответила, но текст не прочитан: «' + text.slice(0, 40) + '»', 5000);
    } catch (err) { toast(err.message, 6000); }
    b.disabled = false; b.textContent = 'Проверить';
  };
  const ap = $('#autoPlate'); if (ap) ap.onchange = async () => { await setMeta('autoPlate', ap.checked); toast(ap.checked ? 'Включено' : 'Выключено'); };
  $('#updStreets').onclick = async (e) => {
    const b = e.target; b.disabled = true; b.textContent = 'Проверяю…';
    try {
      const r = await updateStreets();
      await setMeta('streetsCheckedAt', Date.now());
      const day =(d) => (d ? d.split('-').reverse().join('.') : 'без даты');
      toast(r.updated ? `Справочник обновлён: база от ${day(r.after.date)}, улиц ${r.after.streets.toLocaleString('ru-RU')} (было ${r.before.streets.toLocaleString('ru-RU')})`
        : `У вас самый свежий справочник: база от ${day(r.after.date)}`, 6000);
      renderSettings();
    } catch (err) { toast(navigator.onLine ? err.message : 'Нет интернета', 5000); b.disabled = false; b.textContent = 'Проверить обновление справочника'; }
  };
  $('#checkUpd').onclick = async (e) => {
    const b = e.target; b.disabled = true; b.textContent = 'Проверяю…';
    const l = await latestVersion();
    b.disabled = false; b.textContent = 'Проверить обновление';
    if (!l) { toast('Нет связи — проверьте интернет'); return; }
    if (isNewer(l.version, APP_VERSION)) {
      if (confirm('Есть новая версия ' + l.version + (l.notes ? ':\n' + l.notes : '') + '\n\nОбновить сейчас?')) updateApp();
    } else {
      toast('У вас последняя версия ' + APP_VERSION);
    }
  };

  const sp = $('#setPw'); if (sp) sp.onclick = async () => {
    const pw = await passwordDialog({ title: 'Новый пароль', text: 'Не меньше 8 символов. Запишите его.', repeat: true });
    if (!pw) return;
    toast('Сохраняю пароль…');
    await setPassword(pw);
    toast('Пароль задан');
    updateSyncBadge(); renderSettings(); requestSync();
  };
  const cp = $('#checkPw'); if (cp) cp.onclick = async () => {
    const pw = await passwordDialog({ title: 'Проверка пароля', text: 'Введите пароль, который задавали.' });
    if (!pw) return;
    toast('Проверяю…');
    toast(await checkPassword(pw) ? '✓ Пароль верный' : '✗ Не тот пароль');
  };
  const gt = $('#getToken'); if (gt) gt.onclick = async () => {
    const id = $('#cid').value.trim();
    if (!/^[0-9a-f]{32}$/i.test(id)) { toast('ClientID — это 32 символа из букв и цифр'); return; }
    await setMeta('ydClientId', id);
    // У приложений «для доступа к API» Яндекс показывает ключ на своей странице (verification_code).
    window.open('https://oauth.yandex.ru/authorize?response_type=token&client_id=' + id, '_blank', 'noopener');
  };
  const c = $('#connect'); if (c) c.onclick = async () => {
    const errBox = $('#connErr');
    const fail = (msg) => { errBox.textContent = msg; errBox.hidden = false; c.disabled = false; c.textContent = 'Подключить Яндекс Диск'; };
    errBox.hidden = true;
    let token = $('#token').value.trim().replace(/^["'«]|["'»]$/g, '');
    const m = token.match(/access_token=([^&\s]+)/); if (m) token = m[1]; // вставили всю ссылку целиком
    if (!token) return fail('Поле «Ключ доступа» пустое. Вставьте ключ со страницы Яндекса.');
    if (token === $('#cid').value.trim() || /^[0-9a-f]{32}$/i.test(token)) {
      return fail('Это ClientID, а нужен другой, более длинный ключ. Нажмите «Получить ключ доступа», разрешите доступ и скопируйте ключ, который покажет Яндекс.');
    }
    if (token.length < 20 || /\s/.test(token)) return fail('Похоже, ключ скопирован не целиком (' + token.length + ' символов). Скопируйте его ещё раз кнопкой «Копировать» на странице Яндекса.');
    c.disabled = true; c.textContent = 'Проверяю ключ…';
    let r;
    try {
      r = await ydFetch(token, '/resources?limit=1&path=' + encodeURIComponent(ROOT));
    } catch (e) {
      if (e instanceof AuthError) return fail('Яндекс не принял ключ (ошибка 401). Нажмите «Получить ключ доступа» ещё раз и вставьте новый ключ целиком.');
      return fail(e.message + '. Проверьте интернет (и VPN: попробуйте его выключить) и нажмите ещё раз.');
    }
    // 404 — папки приложения ещё нет, она появится при первой отправке
    if (!(r.ok || r.status === 404)) {
      let d = ''; try { const j = await r.json(); d = j.message || j.description || ''; } catch (e) { /* пусто */ }
      return fail('Яндекс ответил ошибкой ' + r.status + (d ? ': ' + d : '') +
        (r.status === 403 ? '. Видимо, в приложении на oauth.yandex.ru не отмечен доступ к Диску.' : ''));
    }
    toast('Яндекс Диск подключён');
    await onDiskConnected(token);
    updateSyncBadge(); renderSettings(); requestSync();
  };
  const sn = $('#syncNow'); if (sn) sn.onclick = () => sendAll();
  const cc = $('#checkCopy'); if (cc) cc.onclick = async () => { cc.disabled = true; cc.textContent = 'Проверяю…'; await checkDiskCopy(); renderSettings(); };
  const fd = $('#fromDisk'); if (fd) fd.onclick = async () => {
    if (!confirm('Заменить данные в телефоне копией с Диска? Несохранённые на Диск изменения пропадут.')) return;
    try {
      const d = await downloadDiskDump(askCopyPassword);
      if (!d) { toast('На Диске ещё нет копии'); return; }
      const local = await buildDump();
      if (local.orders.length + local.expenses.length) await saveHistoryCopy('phone', local);
      await restoreDump(d, true);
      await setMeta('diskLayout', 2); await setMeta('syncPaused', null);
      toast('Восстановлено с Диска'); go('#/orders');
    } catch (e) { toast(e.message); }
  };
  const dc = $('#disconnect'); if (dc) dc.onclick = async () => {
    if (!confirm('Отключить Яндекс Диск? Данные в телефоне останутся.')) return;
    await setMeta('ydToken', null); await setMeta('syncError', null);
    updateSyncBadge(); renderSettings();
  };

  const dumpFile = async () => {
    if (!(await hasPassword())) { toast('Сначала задайте пароль'); return null; }
    const bytes = await encryptBytes(JSON.stringify(await buildDump()));
    const text = 'Мои заявки: зашифрованная копия. Открывается только в приложении с паролем.\n' + toBase64(bytes) + '\n';
    return new File([text], 'заявки-копия-' + toDateInput(Date.now()) + '.txt', { type: 'text/plain' });
  };
  const saveFile = (file) => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  $('#share').onclick = async () => {
    const f = await dumpFile(); if (!f) return;
    if (navigator.canShare && navigator.canShare({ files: [f] })) {
      try { await navigator.share({ files: [f], title: 'Копия заявок' }); } catch (e) { /* отменено */ }
    } else { saveFile(f); toast('Отправка недоступна — файл скачан'); }
  };
  $('#download').onclick = async () => { const f = await dumpFile(); if (f) saveFile(f); };
  $('#csv').onclick = async () => {
    // Открытая таблица — только тому, кто знает пароль (защита от чужих рук на разблокированном телефоне)
    if (!(await hasPassword())) { toast('Сначала задайте пароль выше'); return; }
    for (let attempt = 0; ; attempt++) {
      const pw = await passwordDialog({
        title: 'Пароль для таблицы',
        text: attempt ? 'Пароль не подошёл. Попробуйте ещё раз.' : 'Таблица не зашифрована. Чтобы скачать её, введите пароль приложения.',
      });
      if (pw == null) return;
      toast('Проверяю…');
      if (await checkPassword(pw)) break;
      if (attempt >= 4) { toast('Слишком много неверных попыток'); return; }
    }
    const d = await buildDump();
    saveFile(new File([ordersCsv(d.orders)], 'заявки-' + toDateInput(Date.now()) + '.csv', { type: 'text/csv' }));
  };
  $('#restore').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    if (!confirm('Заменить все данные в телефоне данными из файла?')) return;
    try {
      const txt = await f.text();
      let d;
      if (txt.trim().startsWith('{')) d = JSON.parse(txt); // старая незашифрованная копия (версия 1.0)
      else {
        const b64 = txt.split('\n').map((l) => l.trim()).filter((l) => /^[A-Za-z0-9+/=]+$/.test(l)).join('');
        if (!b64) throw new Error('Это не файл копии заявок');
        d = JSON.parse(new TextDecoder().decode(await decryptBytes(fromBase64(b64), askCopyPassword)));
      }
      await restoreDump(d, false);
      toast('Восстановлено из файла'); requestSync(); go('#/orders');
    } catch (err) { toast(err.message); }
  };

  // items: [{ name, blob() }] — из архива или выбранные по одному
  const addTgPhotos = async (items, btn) => {
    const map = (await getMeta('tgPhotoMap')) || {};
    const todo = items.filter((f) => map[f.name]);
    if (!todo.length) { toast('Здесь нет фото из импорта (или они уже добавлены)', 4000); return; }
    const label = btn.querySelector('span') || btn; const was = label.textContent;
    btn.classList.add('busy');
    let lock = null; try { lock = await navigator.wakeLock?.request('screen'); } catch (e) { /* экран может погаснуть */ }
    let done = 0;
    try {
      for (const f of todo) {
        let blob = null;
        for (const oid of [].concat(map[f.name])) {
          const o = await dbGet('orders', oid);
          if (!o) continue;
          blob = blob || await compressImage(await f.blob(), 1600, 0.75);
          if ((await dbByIndex('photos', 'orderId', o.id)).some((p) => p.tgName === f.name)) continue;   // уже добавлено до обрыва
          await dbPut('photos', { id: uid(), orderId: o.id, kind: 'extra', blob, createdAt: o.createdAt || Date.now(), uploaded: 0, from: 'telegram', tgName: f.name });
        }
        delete map[f.name];
        done++;
        label.textContent = 'Добавляю фото: ' + done + ' из ' + todo.length + '…';
        if (done % 10 === 0) await setMeta('tgPhotoMap', map);  // прервётся — продолжит с этого места
      }
    } finally {
      await setMeta('tgPhotoMap', map);
      try { lock && lock.release(); } catch (e) { /* пусто */ }
      btn.classList.remove('busy'); label.textContent = was;
    }
    await changed();
    toast('Фото добавлены: ' + done + (Object.keys(map).length ? ', ещё ждут: ' + Object.keys(map).length : ''), 5000);
    renderSettings();
  };
  const tz = $('#tgZip'); if (tz) tz.onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { await addTgPhotos(await readZipEntries(f), tz.closest('label')); } catch (err) { toast(err.message, 5000); }
  };
  const tp = $('#tgPhotos'); if (tp) tp.onchange = async (e) => {
    const files = [...e.target.files]; e.target.value = ''; if (!files.length) return;
    await addTgPhotos(files.map((f) => ({ name: f.name, blob: async () => f })), tp.closest('label'));
  };
}

// Чтение zip-архива без распаковки целиком: каждый файл берётся кусочком прямо из архива (память телефона не забивается)
async function readZipEntries(file) {
  const tailLen = Math.min(file.size, 65557);
  const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Это не zip-архив');
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true); const cdOff = tail.getUint32(eocd + 16, true);
  const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  const out = [];
  for (let p = 0, n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('Архив повреждён');
    const method = cd.getUint16(p + 10, true); const csize = cd.getUint32(p + 20, true);
    const nlen = cd.getUint16(p + 28, true); const xlen = cd.getUint16(p + 30, true); const clen = cd.getUint16(p + 32, true);
    const loc = cd.getUint32(p + 42, true);
    const path = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nlen));
    p += 46 + nlen + xlen + clen;
    const name = path.split('/').pop();
    if (!name || !/\.(jpe?g|png|webp)$/i.test(name)) continue;
    out.push({ name, blob: async () => {
      const h = new DataView(await file.slice(loc, loc + 30).arrayBuffer());
      const start = loc + 30 + h.getUint16(26, true) + h.getUint16(28, true);
      const raw = file.slice(start, start + csize, 'image/jpeg');
      if (method === 0) return raw;                                   // без сжатия — как есть
      if (method === 8) return new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
      throw new Error('Неподдерживаемый архив');
    } });
  }
  return out;
}

// ================= ЗАПУСК =================
async function handleOAuthReturn() {
  if (!location.hash.includes('access_token=')) {
    if (location.hash.includes('error=')) { toast('Яндекс не дал доступ'); history.replaceState(null, '', location.pathname + '#/settings'); }
    return;
  }
  const p = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + '#/settings');
  toast('Яндекс Диск подключён');
  await onDiskConnected(p.get('access_token'));
}

async function onDiskConnected(token) {
  await setMeta('ydToken', token);
  await setMeta('syncError', null);
  await checkDiskCopy();
}

// Копия на Диске — это более старое состояние этого же телефона? (все её заявки и расходы есть здесь, не новее)
function _isOlderCopyOfThis(disk, local) {
  const has = (list, other) => { const m = new Map(other.map((x) => [x.id, x])); return list.every((x) => m.has(x.id) && (m.get(x.id).updatedAt || 0) >= (x.updatedAt || 0)); };
  return has(disk.orders, local.orders) && has(disk.expenses || [], local.expenses);
}
const _lastEdit = (d) => Math.max(0, ...d.orders.map((o) => o.updatedAt || o.createdAt || 0), ...(d.expenses || []).map((e) => e.updatedAt || e.createdAt || 0));
const _copyLine = (d, when) => `заявок <b>${d.orders.length}</b>, расходов ${(d.expenses || []).length}${when ? ', ' + esc(when) : ''}`;

// Проверить копию на Диске перед тем, как что-то туда отправлять. Сомнение — отправка на паузе.
async function checkDiskCopy() {
  const local = await buildDump();
  const hasLocal = local.orders.length + local.expenses.length > 0;
  let d;
  try { d = await downloadDiskDump(askCopyPassword); } catch (e) {
    await setMeta('syncPaused', 'check');
    toast('Не удалось проверить копию на Диске (' + e.message + '). Отправка на паузе — «Диск» → «Проверить копию».', 7000);
    updateSyncBadge(); return;
  }
  const diskHas = d && d.orders.length + (d.expenses || []).length > 0;
  if (!diskHas) { await setMeta('syncPaused', null); if (hasLocal) await markDirty(); updateSyncBadge(); requestSync(); return; }
  if (!hasLocal) {
    await setMeta('syncPaused', null);
    if (confirm('На Диске есть копия: заявок ' + d.orders.length + '. Загрузить её в телефон?')) {
      await restoreDump(d, true); await setMeta('diskLayout', 2); toast('Восстановлено с Диска');
    }
    updateSyncBadge(); return;
  }
  if (_isOlderCopyOfThis(d, local)) { await setMeta('syncPaused', null); await markDirty(); updateSyncBadge(); requestSync(); return; }
  await setMeta('syncPaused', 'both');
  updateSyncBadge();
  await diskChoiceDialog(d, local);
}

// В телефоне и на Диске разные данные. Ничего не затираем молча: показываем обе копии, выбираете вы.
async function diskChoiceDialog(disk, local) {
  const dd = document.createElement('dialog');
  dd.className = 'pw';
  dd.innerHTML = `<div class="dlg"><h3>На Диске другая копия</h3>
    <p class="small" style="margin-top:0">Данные в телефоне и на Диске различаются. Пока вы не выберете, на Диск ничего не отправляется.</p>
    <div class="stat">
      <span>📱 В телефоне</span><span>${_copyLine(local, _lastEdit(local) ? 'правка ' + fmtDate(_lastEdit(local)) : '')}</span>
      <span>☁ На Диске</span><span>${_copyLine(disk, disk.exportedAt ? 'сохранена ' + fmtDate(new Date(disk.exportedAt).getTime()) : '')}</span>
    </div>
    <button type="button" class="btn" data-v="disk" style="margin-top:12px">Загрузить с Диска в телефон</button>
    <p class="note" style="margin-top:4px">Данные телефона сначала сохраню отдельной копией на Диске, в папке «История».</p>
    <button type="button" class="btn sec" data-v="phone">Оставить телефон, заменить Диск</button>
    <p class="note" style="margin-top:4px">Копия Диска сначала сохранится в «Историю».</p>
    <button type="button" class="btn sec" data-v="later">Решу позже</button></div>`;
  document.body.appendChild(dd);
  const choice = await new Promise((res) => {
    $$('[data-v]', dd).forEach((b) => b.onclick = () => res(b.dataset.v));
    dd.addEventListener('cancel', (e) => { e.preventDefault(); res('later'); });   // «Назад» — решу позже
    dd.showModal();
  });
  dd.close();
  dd.remove();
  try {
    if (choice === 'disk') {
      toast('Сохраняю копию телефона…');
      await saveHistoryCopy('phone', local);
      await restoreDump(disk, true);
      await setMeta('diskLayout', 2);
      await setMeta('syncPaused', null);
      toast('Загружено с Диска. Прежние данные телефона — в «Истории» на Диске.', 5000);
      route();
    } else if (choice === 'phone') {
      if (!confirm('Заменить копию на Диске данными телефона? Прежняя копия Диска сохранится в «Истории».')) { diskChoiceDialog(disk, local); return; }
      toast('Сохраняю копию Диска…');
      await saveHistoryCopy('disk');
      await setMeta('syncPaused', null);
      await markDirty();
      toast('Отправляю данные телефона на Диск', 4000);
      requestSync();
    }
  } catch (e) { toast('Не получилось: ' + e.message + '. Ничего не изменено.', 6000); }
  updateSyncBadge();
  if (location.hash.startsWith('#/settings')) renderSettings();
}

// ================= ОБНОВЛЕНИЕ ПРИЛОЖЕНИЯ =================
const _verNum = (v) => String(v || '0').split('.').map((x) => parseInt(x, 10) || 0);
function isNewer(a, b) {
  const x = _verNum(a); const y = _verNum(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

// Какая версия лежит на сайте. null — нет связи.
async function latestVersion() {
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

// Скачать новую версию и перезапустить приложение. Данные в телефоне не трогаются.
async function updateApp() {
  toast('Обновляю приложение…');
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await reg.update();
      const w = reg.installing || reg.waiting;
      if (w && w.state !== 'activated') {
        await new Promise((res) => {
          w.addEventListener('statechange', () => { if (w.state === 'activated' || w.state === 'redundant') res(); });
          setTimeout(res, 20000);
        });
      }
    }
  } catch (e) { /* перезапустим как есть */ }
  location.reload();
}

let _lastUpdateCheck = 0;
async function checkUpdateBanner(force) {
  if (!navigator.onLine || (!force && Date.now() - _lastUpdateCheck < 30 * 60 * 1000)) return;
  _lastUpdateCheck = Date.now();
  const l = await latestVersion();
  const bar = $('#updBar');
  if (!l || !isNewer(l.version, APP_VERSION)) { bar.hidden = true; return; }
  bar.innerHTML = `<span>Доступна новая версия ${esc(l.version)}${l.notes ? '<small>' + esc(l.notes) + '</small>' : ''}</span>
    <button type="button">Обновить</button>`;
  bar.hidden = false;
  $('button', bar).onclick = updateApp;
}

// Справочник улиц обновляется сам: не чаще раза в сутки, когда есть интернет.
// Если файл на сайте не менялся, заново он не скачивается (браузер только сверяет его с сайтом).
let _streetsChecking = false;
async function autoUpdateStreets() {
  if (!navigator.onLine || _streetsChecking) return;
  _streetsChecking = true;
  try {
    if (Date.now() - ((await getMeta('streetsCheckedAt')) || 0) < 864e5) return;
    const r = await updateStreets();
    await setMeta('streetsCheckedAt', Date.now());
    if (r.updated) {
      toast(`Справочник улиц обновился: база от ${r.after.date.split('-').reverse().join('.')}`, 5000);
      if (location.hash.startsWith('#/settings') && !document.activeElement?.matches('input, textarea')) renderSettings();
    }
  } catch (e) { console.warn('streets', e); } finally { _streetsChecking = false; }
}

// Дата и время в шапке: «вт 17.11 · 14:35»
const todayDateText = () => { const t = new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }); return t[0].toUpperCase() + t.slice(1); };
function tickClock() {
  const d = new Date();
  // дата и время на всех экранах — двумя строчками, чтобы заголовок не обрезался
  $('#clock').innerHTML = '<span class="c-d">' + d.toLocaleDateString('ru-RU', { weekday: 'short' }) + ' ' +
    String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '</span><span class="c-t">' + hhmm(d) + '</span>';
  const td = $('#todayDate'); if (td) td.textContent = todayDateText();
}

// Номера в старых заявках (и после восстановления копии) — к виду +7 (965) 932-45-76
async function tidyPhones() {
  let n = 0;
  for (const o of await dbAll('orders')) {
    if (!o.phone) continue;
    const f = fmtPhone(o.phone);
    if (f !== o.phone) { o.phone = f; await dbPut('orders', o); n++; }
  }
  if (n) await markDirty();
  return n;
}

async function start() {
  tickClock();
  setInterval(tickClock, 10 * 1000);
  $('#backBtn').onclick = () => (history.length > 1 ? history.back() : go('#/today'));
  try { await tidyPhones(); } catch (e) { console.warn('phones', e); }
  setTimeout(prefetchOcr, 20 * 1000); // распознавание шильдика — скачать заранее, чтобы работало без сети
  // Пока печатают (клавиатура открыта), нижние панели убираем, чтобы не закрывали поле
  const typingEl = (el) => el && el.matches && el.matches('textarea, select, input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=button])');
  document.addEventListener('focusin', (e) => { if (typingEl(e.target)) document.body.classList.add('typing'); });
  document.addEventListener('focusout', () => setTimeout(() => { if (!typingEl(document.activeElement)) document.body.classList.remove('typing'); }, 50));
  // Список проверенных фото от массового считывания (убрано в 1.25) больше не нужен
  getMeta('plateScan').then((ps) => { if (ps) setMeta('plateScan', null); });
  checkUpdateBanner(true);
  setTimeout(autoUpdateStreets, 30 * 1000); // не мешать запуску
  await handleOAuthReturn();
  window.addEventListener('hashchange', route);
  // Запуск с ярлыка (старый ярлык открывал «Заявки») — начинаем с «Сегодня»
  if (history.length <= 1 && (!location.hash || location.hash === '#/orders')) history.replaceState(null, '', location.pathname + '#/today');
  await route();
  updateSyncBadge();

  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
      if (reg.periodicSync) {
        try {
          const st = await navigator.permissions.query({ name: 'periodic-background-sync' });
          if (st.state === 'granted') await reg.periodicSync.register('disk-sync', { minInterval: 60 * 60 * 1000 });
        } catch (e) { /* не поддерживается */ }
      }
    } catch (e) { console.warn('SW', e); }
  }
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* пусто */ }

  if (syncChannel) syncChannel.onmessage = (ev) => {
    const m = ev.data || {};
    updateSyncBadge();
    if (!location.hash.startsWith('#/settings')) return;
    if (m.type === 'progress') { if (m.all) updateDiskProgress(m.done, m.all); return; }  // только полоска, без перерисовки
    if (!document.activeElement?.matches('input')) renderSettings();
  };
  window.addEventListener('online', () => { updateSyncBadge(); requestSync(); });
  window.addEventListener('offline', updateSyncBadge);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && navigator.onLine) { requestSync(); checkUpdateBanner(); autoUpdateStreets(); } });
  window.addEventListener('online', () => { checkUpdateBanner(); autoUpdateStreets(); });
  setInterval(() => { if (navigator.onLine) syncNow().then(updateSyncBadge); }, 5 * 60 * 1000);
  if (navigator.onLine) requestSync();
}

start();
