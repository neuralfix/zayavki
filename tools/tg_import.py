"""Собирает файл импорта заявок из HTML-выгрузки канала Telegram.

    python -I tools/tg_import.py telegram импорт/telegram-import.json

Формат сообщений в канале (одно сообщение = одна заявка):
    Адрес 12-34, Имя, хк|сма|тв
    89171234567
    12000 нал, себес 2000 компрессор, 300 фрион, шредр, фильтр, закрыть на 9700, гар 30 дней
«закрыть на» = чистыми (нал − себес). «отмена» / «отказ» — заявка отменена.

Печатает только общие цифры; содержимое сообщений не выводится (кроме обезличенных строк, которые не разобрались).
Файл результата содержит данные клиентов: не публиковать, перенести на телефон кабелем и удалить после импорта.
"""
import json, os, re, sys, collections
from datetime import datetime, timezone, timedelta
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tg_parse import parse_export, mask

DEVICES = [
    ('Холодильник', r'хк|холод\w*|хол|морозил\w*|мк'),
    ('Стиральная машина', r'сма|см|стирал\w*|стир|стир\.?\s*маш\w*'),
    ('Телевизор', r'тв|телевизор\w*|телик|tv'),
]
CANCEL_RE = re.compile(r'(?i)^(отмена|отменил\w*|отказ\w*|не\s+актуально)\b')
PHONE_RE = re.compile(r'^[\d\s()+-]{10,}$')
REPORT_HINT = re.compile(r'(?i)нал|себес|закрыть|гар\b|диагност')


def parse_date(title):
    m = re.match(r'(\d\d)\.(\d\d)\.(\d{4}) (\d\d):(\d\d):(\d\d)(?: UTC([+-]\d\d):(\d\d))?', title or '')
    if not m:
        return None
    d, mo, y, h, mi, s = map(int, m.groups()[:6])
    tz = timezone(timedelta(hours=int(m.group(7) or 0), minutes=int(m.group(8) or 0) * (1 if (m.group(7) or '+')[0] == '+' else -1)))
    return int(datetime(y, mo, d, h, mi, s, tzinfo=tz).timestamp() * 1000)


def fmt_phone(p):
    d = re.sub(r'\D', '', p)
    if len(d) == 11 and d[0] in '78':
        d = '7' + d[1:]
        return '+7 %s %s-%s-%s' % (d[1:4], d[4:7], d[7:9], d[9:11])
    if len(d) == 10:
        return '+7 %s %s-%s-%s' % (d[0:3], d[3:6], d[6:8], d[8:10])
    return p.strip()


def num(s):
    s = s.replace(' ', '').replace(',', '.')
    m = re.fullmatch(r'(\d+(?:\.\d+)?)(к|k|т|тыс)?', s.lower())
    if not m:
        return None
    v = float(m.group(1)) * (1000 if m.group(2) else 1)
    return int(round(v))


def device_of(text):
    for name, rx in DEVICES:
        if re.search(r'(?i)(?<![а-яa-z])(' + rx + r')(?![а-яa-z])', text):
            return name
    return ''


def device_by_parts(text):
    """Техника по запчастям из отчёта"""
    t = text.lower().replace('ё', 'е')
    if re.search(r'фр[еи]он|компрессор|испарител|шред|оттайк|обманк|кондер|капилляр|морозил|осушит', t):
        return 'Холодильник'
    if re.search(r'подшипник|тэн|насос|сальник|ремень|щетк|манжет|амортиз', t):
        return 'Стиральная машина'
    if re.search(r'подсветк|матриц|блок питания|линз', t):
        return 'Телевизор'
    return ''


def parse_head(line):
    """«Адрес 12-34, Имя, хк» → адрес, имя, техника"""
    dev = device_of(line)
    parts = [p.strip() for p in line.split(',') if p.strip()]
    addr, name = [], ''
    for p in parts:
        if device_of(p) and len(p) <= 22 and not re.search(r'\d', p):
            continue
        words = p.split()
        if not name and not re.search(r'\d', p) and 1 <= len(words) <= 3 and all(w[:1].isupper() for w in words) and addr:
            name = p
        else:
            addr.append(p)
    return ', '.join(addr), name, dev


def parse_report(line):
    """Строка отчёта → доход, расходы [{name, amount}], чистыми по записи, гарантия (дней)"""
    low = line.lower().replace('ё', 'е')
    res = {'income': None, 'costs': [], 'net': None, 'warranty': None}
    m = re.search(r'(\d[\d\s.,]*\s*(?:к|т)?)\s*нал', low)
    if m:
        res['income'] = num(m.group(1).strip())
    z = re.search(r'закрыть\s+на\s+(\d[\d\s]*)', low)
    if z:
        res['net'] = num(z.group(1).strip())
    g = re.search(r'гар\w*\s+(\d+)\s*(дн|мес|г|л)', low)
    if g:
        n = int(g.group(1)); unit = g.group(2)
        res['warranty'] = n * (30 if unit == 'мес' else 365 if unit in ('г', 'л') else 1)
    s = re.search(r'себес\w*[:\s]*(.*?)(?:,?\s*закрыть|,?\s*гар\w*\s+\d|$)', low)
    if s:
        for piece in [p.strip() for p in s.group(1).split(',') if p.strip()]:
            mm = re.match(r'^(\d[\d\s]*)\s*(.*)$', piece) or re.match(r'^(.*?)\s+(\d[\d\s]*)$', piece)
            if mm and re.match(r'\d', mm.group(1)):
                amount, name = num(mm.group(1).strip()), mm.group(2).strip()
            elif mm:
                name, amount = mm.group(1).strip(), num(mm.group(2).strip())
            else:
                amount, name = None, piece
            if amount is not None and amount > 0:
                res['costs'].append({'name': name, 'amount': amount})
            elif amount == 0:
                continue
            elif res['costs']:
                res['costs'][-1]['name'] = (res['costs'][-1]['name'] + ', ' + name).strip(', ')
            else:
                res['costs'].append({'name': name, 'amount': 0})
        res['costs'] = [c for c in res['costs'] if c['amount'] or c['name']]
    if res['income'] is None:
        first = re.match(r'^(\d[\d\s]*)', low)
        if first:
            res['income'] = num(first.group(1).strip())
    # Если по записи «закрыть на» расходы не сходятся — верим записи мастера
    if res['income'] is not None and res['net'] is not None:
        total = sum(c['amount'] for c in res['costs'])
        need = res['income'] - res['net']
        if total != need and need >= 0:
            names = ', '.join(c['name'] for c in res['costs'] if c['name']) or 'расходы'
            res['costs'] = [{'name': names, 'amount': need}] if need else []
    res['costs'] = [{'name': c['name'] or 'расходы', 'amount': c['amount']} for c in res['costs'] if c['amount']]
    return res


def build(root):
    msgs = [m for m in parse_export(root) if not m['service']]
    for m in msgs:
        m['ts'] = parse_date(m['date'])

    # Фото → к ближайшему по времени сообщению с текстом в той же цепочке (или в пределах 10 минут)
    chains = []
    for m in msgs:
        if not m['joined'] or not chains:
            chains.append([])
        chains[-1].append(m)
    texts = [m for m in msgs if m['text']]
    photo_owner = {}
    for c in chains:
        ct = [m for m in c if m['text']]
        for m in c:
            if m['text'] or not m['photos']:
                continue
            pool = ct or [t for t in texts if m['ts'] and t['ts'] and abs(t['ts'] - m['ts']) <= 10 * 60 * 1000]
            if not pool:
                continue
            owner = min(pool, key=lambda t: (abs((t['ts'] or 0) - (m['ts'] or 0)), -(t['ts'] or 0)))
            for p in m['photos']:
                photo_owner[p] = owner['id']
        for m in ct:
            for p in m['photos']:
                photo_owner[p] = m['id']

    now = max((m['ts'] or 0) for m in msgs)
    orders, unparsed, stat = [], [], collections.Counter()
    for m in texts:
        lines = [l.strip() for l in m['text'].split('\n') if l.strip()]
        head, phone, reports, cancel, other = '', '', [], False, []
        for i, l in enumerate(lines):
            pm = re.match(r'^\+?[\d\s()-]{10,}', l)
            if pm and len(re.sub(r'\D', '', pm.group(0))) >= 10:
                rest = l[len(pm.group(0)):].strip(' ,.-')
                if not phone:
                    phone = pm.group(0)
                else:
                    other.append('доп. телефон ' + fmt_phone(pm.group(0)))  # второй номер — не отчёт
                if rest:
                    other.append(rest)  # «89…, не морозит» — это описание проблемы
            elif CANCEL_RE.match(l):
                cancel = True
            elif re.match(r'\d', l) and (i > 0 or REPORT_HINT.search(l)) and (REPORT_HINT.search(l) or i > 0):
                reports.append(l)
            elif not head:
                head = l
            else:
                other.append(l)
        if not head and not phone:
            stat['пропущено: нет адреса и телефона'] += 1
            unparsed.append(mask(m['text'])[:120])
            continue
        address, name, dev = parse_head(head) if head else ('', '', '')
        dev = dev or device_of(' '.join(other)) or device_by_parts(' '.join(reports + other))
        o = {'id': 'tg-' + m['id'], 'createdAt': m['ts'], 'updatedAt': m['ts'], 'phone': fmt_phone(phone) if phone else '',
             'name': name, 'address': address, 'device': dev, 'model': '', 'problem': ' / '.join(other), 'visitAt': None,
             'notes': 'Из Telegram:\n' + m['text'], 'income': 0, 'costs': [], 'source': 'telegram'}
        if reports:
            r = parse_report(reports[0])
            for extra in reports[1:]:  # доп. строки с суммой — как расходы/доход, если явно указаны
                r2 = parse_report(extra)
                if r['income'] is None and r2['income'] is not None:
                    r = r2
            if r['income'] is not None and r['income'] > 500000:  # не сумма, а что-то вроде номера
                stat['подозрительная сумма → 0'] += 1
                unparsed.append(mask(reports[0])[:120])
                r['income'] = None
            o['income'] = r['income'] or 0
            o['costs'] = r['costs']
            o['workDone'] = reports[0]
            if r['warranty']:
                o['warrantyDays'] = r['warranty']
            o['status'] = 'cancelled' if cancel and not o['income'] else 'closed'
            o['closedAt'] = m['ts']
            stat['закрыта' if o['status'] == 'closed' else 'отменена'] += 1
            if r['income'] is None:
                stat['отчёт без суммы'] += 1
                unparsed.append(mask(reports[0])[:120])
        elif cancel:
            o['status'] = 'cancelled'; o['closedAt'] = m['ts']; stat['отменена'] += 1
        elif now - (m['ts'] or now) > 30 * 86400 * 1000:
            o['status'] = 'cancelled'; o['closedAt'] = m['ts']
            o['notes'] = 'Импорт: в Telegram не было отчёта.\n' + o['notes']
            stat['без отчёта, старше 30 дней → отменена'] += 1
        else:
            o['status'] = 'open'; stat['без отчёта, свежая → в работе'] += 1
        if not dev: stat['техника не определена'] += 1
        if not name: stat['имя не найдено'] += 1
        if not phone: stat['без телефона'] += 1
        orders.append(o)

    photo_map = {}
    ids = {o['id'] for o in orders}
    for path, mid in photo_owner.items():
        if 'tg-' + mid in ids:
            photo_map[os.path.basename(path)] = 'tg-' + mid
    return orders, photo_map, stat, unparsed


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    src, dst = sys.argv[1], sys.argv[2]
    orders, photo_map, stat, unparsed = build(src)
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    json.dump({'app': 'master-zayavki', 'kind': 'telegram-import', 'format': 1, 'orders': orders, 'photoMap': photo_map},
              open(dst, 'w', encoding='utf-8'), ensure_ascii=False)
    closed = [o for o in orders if o['status'] == 'closed']
    inc = sum(o['income'] for o in closed); cost = sum(sum(c['amount'] for c in o['costs']) for o in closed)
    print('заявок:', len(orders), dict(stat))
    print('закрытых: выручка %d, расходы %d, чистыми %d' % (inc, cost, inc - cost))
    by_month = collections.Counter()
    for o in closed:
        d = datetime.fromtimestamp(o['createdAt'] / 1000)
        by_month['%04d-%02d' % (d.year, d.month)] += 1
    print('закрытых по месяцам:', dict(sorted(by_month.items())))
    print('фото привязано:', len(photo_map), ' к заявкам:', len(set(photo_map.values())))
    print('техника:', dict(collections.Counter(o['device'] or '—' for o in orders)))
    print('не разобрано (обезличено):', len(unparsed))
    for u in unparsed[:15]:
        print('   ', u.replace('\n', ' / '))
    print('файл:', dst, round(os.path.getsize(dst) / 1024), 'КБ')
