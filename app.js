'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const view = $('#view');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0)) + ' ₽';
const parseMoney = (s) => { const v = parseFloat(String(s ?? '').replace(/[\s ₽]/g, '').replace(',', '.')); return isFinite(v) ? v : 0; };
const digits = (s) => String(s ?? '').replace(/\D/g, '');

const DEVICES = ['Холодильник', 'Стиральная машина', 'Телевизор', 'Другое'];
const EXP_CATS = ['Реклама', 'Бензин', 'Инструмент', 'Запчасти впрок', 'Связь', 'Прочее'];
const COST_CHIPS = ['Компрессор', 'Фреон', 'Термостат', 'Датчик', 'Подшипники', 'ТЭН', 'Насос', 'Плата', 'Подсветка'];
const STATUS = { open: 'В работе', closed: 'Закрыта', cancelled: 'Отменена' };

const state = { filter: 'open', search: '', month: monthKey(Date.now()) };
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
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
function setTitle(t, back) {
  $('#title').textContent = t;
  $('#backBtn').hidden = !back;
  document.title = t + ' — Мои заявки';
}
function setTab(name) {
  const map = { orders: 'orders', new: 'orders', edit: 'orders', order: 'orders', close: 'orders', expenses: 'expenses', expense: 'expenses', report: 'report', settings: 'settings' };
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
async function updateSyncBadge() {
  const b = $('#syncBadge');
  const s = await syncStatus();
  b.className = 'sync';
  if (!s.connected) { b.textContent = 'Диск не подключён'; b.classList.add('warn'); return; }
  if (!s.hasKey) { b.textContent = '🔒 Нужен пароль'; b.classList.add('warn'); return; }
  const pending = s.pendingPhotos + (s.dataPending ? 1 : 0) + s.pendingDeletes;
  if (s.error) { b.textContent = '⚠ Ошибка Диска'; b.classList.add('err'); return; }
  if (pending) {
    b.textContent = (navigator.onLine ? '↻ Отправка' : '⏸ Нет сети') + (s.pendingPhotos ? ' · фото ' + s.pendingPhotos : '');
    if (!navigator.onLine) b.classList.add('warn');
    return;
  }
  b.textContent = '✓ ' + (s.lastSync ? new Date(s.lastSync).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : 'на Диске');
}

// ---------- Маршруты ----------
async function route() {
  photoUrls.forEach((u) => URL.revokeObjectURL(u)); photoUrls = [];
  const h = location.hash || '#/orders';
  const [, name, id] = h.split('/');
  setTab(name);
  window.scrollTo(0, 0);
  try {
    switch (name) {
      case 'orders': return await renderOrders();
      case 'new': return await renderOrderForm(null);
      case 'edit': return await renderOrderForm(id);
      case 'order': return await renderOrder(id);
      case 'close': return await renderClose(id);
      case 'expenses': return await renderExpenses();
      case 'expense': return await renderExpenseForm(id === 'new' ? null : id);
      case 'report': return await renderReport();
      case 'settings': return await renderSettings();
      default: return go('#/orders', true);
    }
  } catch (e) {
    console.error(e);
    view.innerHTML = '<div class="empty">Что-то пошло не так: ' + esc(e.message) + '</div>';
  }
}

// ================= ЗАЯВКИ =================
function matches(o, q) {
  if (!q) return true;
  const text = [o.num, o.name, o.phone, o.address, o.device, o.model, o.problem, o.notes, o.workDone].join(' ').toLowerCase();
  if (text.includes(q)) return true;
  const dq = digits(q);
  return dq.length >= 3 && digits(o.phone).includes(dq);
}

async function renderOrders() {
  setTitle('Заявки');
  const all = await dbAll('orders');
  const cnt = { open: 0, closed: 0, all: all.length };
  all.forEach((o) => { if (o.status === 'open') cnt.open++; else cnt.closed++; });
  view.innerHTML = `
    <div class="seg">
      <button data-f="open" class="${state.filter === 'open' ? 'on' : ''}">В работе (${cnt.open})</button>
      <button data-f="closed" class="${state.filter === 'closed' ? 'on' : ''}">Закрытые (${cnt.closed})</button>
      <button data-f="all" class="${state.filter === 'all' ? 'on' : ''}">Все</button>
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
  let list = all.filter((o) => (state.filter === 'all' || (state.filter === 'open' ? o.status === 'open' : o.status !== 'open')) && matches(o, q));
  if (state.filter === 'open') {
    list.sort((a, b) => (a.visitAt || Infinity) - (b.visitAt || Infinity) || b.createdAt - a.createdAt);
  } else {
    list.sort((a, b) => (b.closedAt || b.createdAt) - (a.closedAt || a.createdAt));
  }
  const el = $('#list');
  if (!list.length) {
    el.innerHTML = `<div class="empty">${q ? 'Ничего не найдено' : state.filter === 'open' ? 'Заявок в работе нет.<br>Нажмите «+», чтобы добавить.' : 'Пока пусто'}</div>`;
    return;
  }
  el.innerHTML = list.map((o) => {
    const when = o.status === 'open'
      ? (o.visitAt ? '🕑 ' + fmtDate(o.visitAt) : 'создана ' + fmtDate(o.createdAt))
      : (o.status === 'closed' ? 'закрыта ' : 'отменена ') + fmtDate(o.closedAt || o.updatedAt, false);
    const sum = o.status === 'open' ? '' : `<span class="${orderNet(o) >= 0 ? 'pos' : 'neg'}">${orderNet(o) >= 0 ? '+' : ''}${money(orderNet(o))}</span>`;
    return `<a class="item" href="#/order/${o.id}">
      <div class="row"><b>№${o.num}</b><span class="grow">${esc([o.device, o.model].filter(Boolean).join(' '))}</span><span class="badge ${o.status}">${STATUS[o.status]}</span></div>
      <div class="row small"><span class="grow">${esc([o.name, o.address].filter(Boolean).join(' · ') || o.phone || o.notes || '—')}</span></div>
      <div class="row small muted"><span class="grow">${esc(when)}</span>${sum}</div>
    </a>`;
  }).join('');
}

async function renderOrderForm(id) {
  const o = id ? await dbGet('orders', id) : null;
  if (id && !o) return go('#/orders', true);
  setTitle(o ? 'Заявка №' + o.num : 'Новая заявка', true);
  const v = o || {};
  view.innerHTML = `
    <form id="f" autocomplete="off">
      <div class="field"><label>Телефон</label><input class="input" name="phone" type="tel" inputmode="tel" value="${esc(v.phone)}"></div>
      <div class="field"><label>Имя</label><input class="input" name="name" value="${esc(v.name)}" autocapitalize="words"></div>
      <div class="field"><label>Адрес</label><input class="input" name="address" value="${esc(v.address)}"></div>
      <div class="field"><label>Техника</label>
        <div class="chips" id="dev">${DEVICES.map((d) => `<button type="button" class="chip ${v.device === d ? 'on' : ''}" data-v="${d}">${d}</button>`).join('')}</div>
      </div>
      <div class="field"><label>Марка / модель</label><input class="input" name="model" value="${esc(v.model)}"></div>
      <div class="field"><label>Проблема</label><textarea class="input" name="problem">${esc(v.problem)}</textarea></div>
      <div class="field"><label>Когда ехать</label><input class="input" name="visitAt" type="datetime-local" value="${toDTInput(v.visitAt)}"></div>
      <div class="field"><label>Заметки</label><textarea class="input" name="notes">${esc(v.notes)}</textarea></div>
      <button class="btn" type="submit">${o ? 'Сохранить' : 'Создать заявку'}</button>
    </form>`;
  let device = v.device || '';
  $$('#dev .chip').forEach((c) => c.onclick = () => {
    device = device === c.dataset.v ? '' : c.dataset.v;
    $$('#dev .chip').forEach((x) => x.classList.toggle('on', x.dataset.v === device));
  });
  if (!o) $('[name=phone]').focus();
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const data = Object.fromEntries([...f.entries()].map(([k, val]) => [k, String(val).trim()]));
    if (!data.phone && !data.name && !data.address && !data.notes && !data.problem) { toast('Заполните хотя бы одно поле'); return; }
    const now = Date.now();
    const rec = o ? { ...o } : { id: uid(), num: await nextOrderNum(), createdAt: now, status: 'open', costs: [], income: 0 };
    Object.assign(rec, data, { device, visitAt: data.visitAt ? new Date(data.visitAt).getTime() : null, updatedAt: now });
    await dbPut('orders', rec);
    toast(o ? 'Сохранено' : 'Заявка №' + rec.num + ' создана');
    changed();
    go('#/order/' + rec.id, true);
  };
}

async function renderOrder(id) {
  const o = await dbGet('orders', id);
  if (!o) return go('#/orders', true);
  setTitle('Заявка №' + o.num, true);
  const tel = digits(o.phone);
  const costs = orderCosts(o); const net = orderNet(o);
  const report = o.status === 'open' ? '' : `
    <div class="card">
      <h2>${o.status === 'closed' ? 'Отчёт' : 'Отменена'} · ${esc(fmtDate(o.closedAt, false))}</h2>
      <div class="stat">
        <span>Взял</span><b>${money(o.income)}</b>
        ${(o.costs || []).map((c) => `<span class="muted">− ${esc(c.name || 'расход')}</span><span class="muted">${money(c.amount)}</span>`).join('')}
        <div class="sep"></div>
        <span class="em">Чистыми</span><span class="em ${net >= 0 ? 'pos' : 'neg'}">${money(net)}</span>
      </div>
      ${o.workDone ? `<p class="small" style="margin:10px 0 0">${esc(o.workDone)}</p>` : ''}
    </div>`;
  view.innerHTML = `
    ${tel ? `<div class="btns" style="margin-bottom:12px">
      <a class="btn" href="tel:${esc(o.phone.replace(/[^\d+]/g, ''))}">Позвонить</a>
      ${o.address ? `<a class="btn sec" href="https://yandex.ru/maps/?text=${encodeURIComponent(o.address)}" target="_blank" rel="noopener">Маршрут</a>` : '<span></span>'}
    </div>` : ''}
    <div class="card">
      <div class="row" style="margin-bottom:10px"><span class="grow"><b>${esc([o.device, o.model].filter(Boolean).join(' ') || 'Техника не указана')}</b></span><span class="badge ${o.status}">${STATUS[o.status]}</span></div>
      <dl class="kv">
        ${o.name ? `<dt>Имя</dt><dd>${esc(o.name)}</dd>` : ''}
        ${o.phone ? `<dt>Телефон</dt><dd>${esc(o.phone)}</dd>` : ''}
        ${o.address ? `<dt>Адрес</dt><dd>${esc(o.address)}</dd>` : ''}
        ${o.problem ? `<dt>Проблема</dt><dd>${esc(o.problem)}</dd>` : ''}
        ${o.visitAt ? `<dt>Когда</dt><dd>${esc(fmtDate(o.visitAt))}</dd>` : ''}
        ${o.notes ? `<dt>Заметки</dt><dd>${esc(o.notes)}</dd>` : ''}
        <dt>Создана</dt><dd>${esc(fmtDate(o.createdAt))}</dd>
      </dl>
      <button class="link" data-a="edit">Изменить данные</button>
    </div>
    ${report}
    <div class="card"><h2>Фото</h2><div id="photos"></div></div>
    ${o.status === 'open'
      ? `<a class="btn" href="#/close/${o.id}">Закрыть заявку — отчёт</a>
         <button class="btn danger" data-a="cancel">Отменить заявку</button>`
      : `<a class="btn sec" href="#/close/${o.id}">Изменить отчёт</a>
         <button class="btn danger" data-a="reopen">Вернуть в работу</button>`}
    <button class="btn danger" data-a="del">Удалить заявку</button>`;
  await photoWidget(o, $('#photos'));
  $('[data-a=edit]').onclick = () => go('#/edit/' + o.id);
  const act = $('[data-a=cancel]'); if (act) act.onclick = async () => {
    if (!confirm('Отменить заявку №' + o.num + '?')) return;
    Object.assign(o, { status: 'cancelled', closedAt: Date.now(), updatedAt: Date.now() });
    await dbPut('orders', o); changed(); renderOrder(id);
  };
  const re = $('[data-a=reopen]'); if (re) re.onclick = async () => {
    Object.assign(o, { status: 'open', closedAt: null, updatedAt: Date.now() });
    await dbPut('orders', o); changed(); renderOrder(id);
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
  const photos = (await dbByIndex('photos', 'orderId', o.id)).sort((a, b) => (a.kind === b.kind ? a.createdAt - b.createdAt : a.kind === 'contract' ? -1 : 1));
  const tiles = photos.map((p) => {
    if (!p.blob) return `<button type="button" class="ph remote" data-remote="${p.id}">на Диске<br>открыть</button>`;
    const u = URL.createObjectURL(p.blob); photoUrls.push(u);
    return `<button type="button" class="ph" data-id="${p.id}"><img src="${u}" alt="">
      ${p.kind === 'contract' ? '<span class="tag">договор</span>' : ''}${p.uploaded ? '' : '<span class="up">↑</span>'}</button>`;
  }).join('');
  box.innerHTML = `
    ${photos.length ? `<div class="photos">${tiles}</div>` : '<div class="note">Фото пока нет</div>'}
    <div class="add-ph">
      <label>+ Договор<input type="file" accept="image/*" multiple data-kind="contract"></label>
      <label>+ Фото<input type="file" accept="image/*" multiple data-kind="extra"></label>
    </div>
    ${photos.some((p) => !p.uploaded && p.blob) ? '<div class="note" style="margin-top:6px">↑ — ещё не отправлено на Диск</div>' : ''}`;
  $$('input[type=file]', box).forEach((inp) => inp.onchange = async () => {
    const files = [...inp.files]; if (!files.length) return;
    toast('Сохраняю фото…');
    const contract = inp.dataset.kind === 'contract';
    for (const f of files) {
      const blob = await compressImage(f, contract ? 2200 : 1600, contract ? 0.82 : 0.75);
      await dbPut('photos', { id: uid(), orderId: o.id, kind: inp.dataset.kind, blob, createdAt: Date.now(), uploaded: 0 });
    }
    toast('Фото сохранено: ' + files.length);
    await photoWidget(o, box);
    changed();
  });
  $$('.ph[data-id]', box).forEach((b) => b.onclick = () => openViewer(b.dataset.id, o, box));
  $$('.ph[data-remote]', box).forEach((b) => b.onclick = async () => {
    b.disabled = true; b.textContent = 'Загружаю…';
    try { await fetchPhoto(b.dataset.remote); await photoWidget(o, box); } catch (e) { toast(e.message); b.disabled = false; b.innerHTML = 'на Диске<br>открыть'; }
  });
}

async function openViewer(photoId, o, box) {
  const p = await dbGet('photos', photoId); if (!p || !p.blob) return;
  const u = URL.createObjectURL(p.blob);
  const v = $('#viewer');
  v.innerHTML = `<img src="${u}" alt=""><div class="bar"><button data-a="del" style="background:#3a1512;color:#ff8a80">Удалить</button><button data-a="x">Закрыть</button></div>`;
  v.hidden = false;
  const close = () => { v.hidden = true; v.innerHTML = ''; URL.revokeObjectURL(u); };
  $('[data-a=x]', v).onclick = close;
  $('[data-a=del]', v).onclick = async () => {
    if (!confirm('Удалить это фото?')) return;
    if (p.remotePath) await addPendingDelete(p.remotePath);
    await dbDel('photos', p.id);
    close(); await photoWidget(o, box); changed();
  };
}

// ---------- Закрытие заявки ----------
async function renderClose(id) {
  const o = await dbGet('orders', id);
  if (!o) return go('#/orders', true);
  const wasClosed = o.status === 'closed';
  setTitle('Отчёт · №' + o.num, true);
  const costs = (o.costs && o.costs.length) ? o.costs : [{ name: '', amount: '' }];
  view.innerHTML = `
    <form id="f" autocomplete="off">
      <div class="card">
        <div class="field"><label>Взял с клиента, ₽</label>
          <input class="input big" name="income" inputmode="decimal" placeholder="0" value="${o.income ? esc(o.income) : ''}"></div>
        <span class="label">Расходы по заявке</span>
        <div id="costs"></div>
        <button type="button" class="link" id="addCost">+ Добавить расход</button>
        <div class="chips" style="margin-top:6px">${COST_CHIPS.map((c) => `<button type="button" class="chip" data-c="${c}">${c}</button>`).join('')}</div>
        <div class="total" id="total"></div>
      </div>
      <div class="card">
        <div class="field"><label>Что сделано</label><textarea class="input" name="workDone" placeholder="Например: замена компрессора, заправка">${esc(o.workDone)}</textarea></div>
        <div class="field"><label>Дата</label><input class="input" type="date" name="date" value="${toDateInput(o.closedAt || Date.now())}"></div>
      </div>
      <div class="card"><h2>Фото: договор и детали</h2><div id="photos"></div></div>
      <button class="btn" type="submit">${wasClosed ? 'Сохранить отчёт' : 'Закрыть заявку'}</button>
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
    $('#total').innerHTML = `<span>Взял</span><span>${money(inc)}</span>
      <span>Расходы</span><span>− ${money(cs)}</span>
      <span class="sum">Чистыми</span><span class="sum ${net >= 0 ? 'pos' : 'neg'}">${money(net)}</span>`;
  };
  costs.forEach((c) => addRow(c));
  $('#addCost').onclick = () => addRow({ name: '', amount: '' }, true);
  $$('[data-c]').forEach((ch) => ch.onclick = () => {
    const empty = $$('.cost-row', box).find((r) => !$$('input', r)[0].value && !$$('input', r)[1].value);
    if (empty) { $$('input', empty)[0].value = ch.dataset.c; $$('input', empty)[1].focus(); } else addRow({ name: ch.dataset.c, amount: '' }, true);
  });
  $('#f').addEventListener('input', recalc);
  recalc();
  await photoWidget(o, $('#photos'));
  if (!wasClosed) $('[name=income]').focus();

  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const fresh = await dbGet('orders', id);
    const date = $('[name=date]').value;
    Object.assign(fresh, {
      income: parseMoney($('[name=income]').value),
      costs: readCosts(),
      workDone: $('[name=workDone]').value.trim(),
      status: 'closed',
      closedAt: fromDateInput(date, fresh.closedAt),
      updatedAt: Date.now(),
    });
    await dbPut('orders', fresh);
    toast(`№${fresh.num} закрыта · чистыми ${money(orderNet(fresh))}`);
    changed();
    go('#/order/' + id, true);
  };
}

// ================= РАСХОДЫ =================
async function renderExpenses() {
  setTitle('Расходы');
  const all = (await dbAll('expenses')).sort((a, b) => b.date - a.date);
  if (!all.length) {
    view.innerHTML = `<div class="empty">Здесь расходы не по заявкам:<br>реклама, бензин, инструмент…<br><br>Нажмите «+», чтобы добавить.</div><a class="fab" href="#/expense/new">+</a>`;
    return;
  }
  const groups = new Map();
  all.forEach((e) => { const k = monthKey(e.date); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); });
  view.innerHTML = [...groups].map(([k, list]) => `
    <div class="row" style="margin:14px 2px 8px"><b class="grow" style="text-transform:capitalize">${monthName(k)}</b><b class="neg">${money(list.reduce((s, e) => s + e.amount, 0))}</b></div>
    <div class="list">${list.map((e) => `<a class="item" href="#/expense/${e.id}">
      <div class="row"><b class="grow">${esc(e.category)}</b><span>${money(e.amount)}</span></div>
      <div class="row small muted"><span class="grow">${esc(e.comment || '')}</span><span>${esc(fmtDate(e.date, false))}</span></div>
    </a>`).join('')}</div>`).join('') + '<a class="fab" href="#/expense/new" aria-label="Новый расход">+</a>';
}

async function renderExpenseForm(id) {
  const e0 = id ? await dbGet('expenses', id) : null;
  if (id && !e0) return go('#/expenses', true);
  setTitle(e0 ? 'Расход' : 'Новый расход', true);
  let cat = e0 ? e0.category : 'Реклама';
  view.innerHTML = `
    <form id="f" autocomplete="off">
      <div class="field"><label>Категория</label>
        <div class="chips" id="cats">${EXP_CATS.map((c) => `<button type="button" class="chip ${c === cat ? 'on' : ''}" data-v="${c}">${c}</button>`).join('')}</div></div>
      <div class="field"><label>Сумма, ₽</label><input class="input big" name="amount" inputmode="decimal" placeholder="0" value="${e0 ? esc(e0.amount) : ''}"></div>
      <div class="field"><label>Комментарий</label><input class="input" name="comment" placeholder="Например: Авито, продвижение" value="${esc(e0?.comment)}"></div>
      <div class="field"><label>Дата</label><input class="input" type="date" name="date" value="${toDateInput(e0 ? e0.date : Date.now())}"></div>
      <button class="btn" type="submit">Сохранить</button>
      ${e0 ? '<button class="btn danger" type="button" id="del">Удалить</button>' : ''}
    </form>`;
  $$('#cats .chip').forEach((c) => c.onclick = () => { cat = c.dataset.v; $$('#cats .chip').forEach((x) => x.classList.toggle('on', x === c)); });
  if (!e0) $('[name=amount]').focus();
  $('#f').onsubmit = async (ev) => {
    ev.preventDefault();
    const amount = parseMoney($('[name=amount]').value);
    if (!amount) { toast('Введите сумму'); return; }
    const rec = { ...(e0 || { id: uid(), createdAt: Date.now() }), category: cat, amount,
      comment: $('[name=comment]').value.trim(), date: fromDateInput($('[name=date]').value, e0?.date), updatedAt: Date.now() };
    await dbPut('expenses', rec);
    toast('Расход сохранён'); changed(); go('#/expenses', true);
  };
  const d = $('#del'); if (d) d.onclick = async () => {
    if (!confirm('Удалить расход?')) return;
    await dbDel('expenses', e0.id); changed(); go('#/expenses', true);
  };
}

// ================= ОТЧЁТ =================
function monthStats(orders, expenses, key) {
  const done = orders.filter((o) => o.status !== 'open' && o.closedAt && monthKey(o.closedAt) === key);
  const closed = done.filter((o) => o.status === 'closed');
  const income = done.reduce((s, o) => s + (Number(o.income) || 0), 0);
  const parts = done.reduce((s, o) => s + orderCosts(o), 0);
  const exps = expenses.filter((e) => monthKey(e.date) === key);
  const byCat = {};
  exps.forEach((e) => { byCat[e.category] = (byCat[e.category] || 0) + e.amount; });
  const other = exps.reduce((s, e) => s + e.amount, 0);
  return { done, closed, cancelled: done.length - closed.length, income, parts, net: income - parts, byCat, other, profit: income - parts - other };
}

async function renderReport() {
  setTitle('Отчёт');
  const orders = await dbAll('orders');
  const expenses = await dbAll('expenses');
  const key = state.month;
  const s = monthStats(orders, expenses, key);
  const avg = s.closed.length ? s.closed.reduce((a, o) => a + (Number(o.income) || 0), 0) / s.closed.length : 0;
  const byDev = {};
  s.closed.forEach((o) => { const d = o.device || 'Не указано'; byDev[d] = byDev[d] || { n: 0, net: 0 }; byDev[d].n++; byDev[d].net += orderNet(o); });
  const months = [-5, -4, -3, -2, -1, 0].map((k) => shiftMonth(key, k));
  const profits = months.map((m) => monthStats(orders, expenses, m).profit);
  const maxAbs = Math.max(1, ...profits.map(Math.abs));
  const openNow = orders.filter((o) => o.status === 'open').length;
  const short = (n) => Math.abs(n) >= 1000 ? Math.round(n / 1000) + 'к' : Math.round(n);

  view.innerHTML = `
    <div class="month-nav"><button id="prev">‹</button><b>${monthName(key)}</b><button id="next">›</button></div>
    <div class="card">
      <h2>Прибыль за месяц</h2>
      <div class="big-num ${s.profit >= 0 ? 'pos' : 'neg'}">${money(s.profit)}</div>
      <div class="stat" style="margin-top:12px">
        <span>Взял с клиентов</span><b>${money(s.income)}</b>
        <span>Запчасти и расходы по заявкам</span><span>− ${money(s.parts)}</span>
        <span>Чистыми с заявок</span><b>${money(s.net)}</b>
        ${Object.entries(s.byCat).map(([c, v]) => `<span class="muted">− ${esc(c)}</span><span class="muted">${money(v)}</span>`).join('')}
        <div class="sep"></div>
        <span class="em">Итого прибыль</span><span class="em ${s.profit >= 0 ? 'pos' : 'neg'}">${money(s.profit)}</span>
      </div>
    </div>
    <div class="card">
      <h2>Заявки</h2>
      <div class="stat">
        <span>Выполнено</span><b>${s.closed.length}</b>
        <span>Средний чек</span><b>${money(avg)}</b>
        ${s.cancelled ? `<span>Отменено</span><span>${s.cancelled}</span>` : ''}
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
        <div class="row small"><b>№${o.num}</b><span class="grow">${esc([o.device, o.name].filter(Boolean).join(' · '))}</span>
        <span class="${orderNet(o) >= 0 ? 'pos' : 'neg'}">${money(orderNet(o))}</span></div></a>`).join('')}</div></div>` : ''}`;
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
  ok: 'Готово, отправлено', nothing: 'Всё уже на Диске', waiting: 'Нет связи — отправлю позже',
  busy: 'Уже отправляется', nokey: 'Сначала задайте пароль', off: 'Диск не подключён',
}[r.status] || r.error || 'Ошибка');

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
    ${s.error ? `<p class="small neg">${esc(s.error)}</p>` : ''}
    ${!s.hasKey ? '<p class="small neg">Задайте пароль выше — без него на Диск ничего не отправляется.</p>' : ''}
    ${s.waiting && !s.error ? '<p class="small muted">Нет связи — отправлю, когда появится интернет.</p>' : ''}
    <button class="btn" id="syncNow" style="margin-top:12px">Отправить сейчас</button>
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

  view.innerHTML = `
    <div class="card"><h2>Пароль для шифрования</h2>${lock}</div>
    <div class="card"><h2>Яндекс Диск</h2>${disk}</div>
    <div class="card"><h2>Резервная копия без интернета</h2>
      <p class="note" style="margin-top:0">Файл со всеми заявками и расходами (без фото), зашифрован вашим паролем.
        Можно отправить себе в Telegram: без пароля его никто не прочитает.</p>
      <button class="btn sec" id="share">Отправить копию…</button>
      <button class="btn sec" id="download">Скачать копию файлом</button>
      <label class="btn danger" style="margin-top:8px">Восстановить из файла<input type="file" id="restore" accept=".txt,.json,text/plain,application/json" hidden></label>
    </div>
    <div class="card"><h2>Таблица для Excel</h2>
      <p class="note" style="margin-top:0"><b class="neg">Не зашифрована.</b> Сохраняется только в «Загрузки» этого телефона.
        Не пересылайте её, если в ней есть телефоны и адреса клиентов.</p>
      <button class="btn sec" id="csv">Скачать таблицу заявок</button>
    </div>
    <p class="note">Занято в телефоне: ${est || '—'}. Версия 1.4</p>`;

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
  const sn = $('#syncNow'); if (sn) sn.onclick = async () => {
    sn.disabled = true; sn.textContent = 'Отправляю…';
    await setMeta('syncError', null);
    toast(syncMessage(await syncNow()));
    updateSyncBadge(); renderSettings();
  };
  const fd = $('#fromDisk'); if (fd) fd.onclick = async () => {
    if (!confirm('Заменить данные в телефоне копией с Диска? Несохранённые на Диск изменения пропадут.')) return;
    try {
      const d = await downloadDiskDump(askCopyPassword);
      if (!d) { toast('На Диске ещё нет копии'); return; }
      await restoreDump(d, true);
      await setMeta('diskLayout', 2);
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
  const hasLocal = (await dbAll('orders')).length + (await dbAll('expenses')).length > 0;
  if (hasLocal) { await markDirty(); return; } // при первом подключении отправить всё
  // Телефон пустой — возможно, это новый телефон, а копия уже есть на Диске.
  try {
    const d = await downloadDiskDump(askCopyPassword);
    if (d && confirm('На Диске есть копия: заявок ' + d.orders.length + '. Загрузить её в телефон?')) {
      await restoreDump(d, true);
      await setMeta('diskLayout', 2);
      toast('Восстановлено с Диска');
    }
  } catch (e) { toast(e.message); }
}

async function start() {
  $('#backBtn').onclick = () => (history.length > 1 ? history.back() : go('#/orders'));
  await handleOAuthReturn();
  window.addEventListener('hashchange', route);
  await route();
  updateSyncBadge();

  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      if (reg.periodicSync) {
        try {
          const st = await navigator.permissions.query({ name: 'periodic-background-sync' });
          if (st.state === 'granted') await reg.periodicSync.register('disk-sync', { minInterval: 60 * 60 * 1000 });
        } catch (e) { /* не поддерживается */ }
      }
    } catch (e) { console.warn('SW', e); }
  }
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* пусто */ }

  if (syncChannel) syncChannel.onmessage = () => { updateSyncBadge(); if (location.hash.startsWith('#/settings') && !document.activeElement?.matches('input')) renderSettings(); };
  window.addEventListener('online', () => { updateSyncBadge(); requestSync(); });
  window.addEventListener('offline', updateSyncBadge);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && navigator.onLine) requestSync(); });
  setInterval(() => { if (navigator.onLine) syncNow().then(updateSyncBadge); }, 5 * 60 * 1000);
  if (navigator.onLine) requestSync();
}

start();
