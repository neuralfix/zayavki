"""Разбор HTML-выгрузки канала Telegram (Telegram Desktop → «Экспорт истории чата» → HTML).

Работает только на этом компьютере. Сам по себе ничего не печатает из сообщений:
режим --inspect показывает лишь обезличенную схему (буквы → х, цифры → 0) и общие цифры.

    python -I tools/tg_parse.py --inspect telegram
"""
import html, os, re, sys, random
from html.parser import HTMLParser


class _ExportParser(HTMLParser):
    def __init__(self, fname):
        super().__init__(convert_charrefs=True)
        self.fname = fname
        self.msgs = []
        self.cur = None
        self.stack = []          # роли открытых div внутри сообщения
        self.text_depth = 0      # >0 — внутри div.text
        self.text_buf = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = a.get('class', '') or ''
        if tag == 'div':
            role = None
            mid = a.get('id', '') or ''
            if 'message' in cls.split() and mid.startswith('message'):
                self.cur = {'id': mid[len('message'):], 'file': self.fname, 'service': 'service' in cls,
                            'joined': 'joined' in cls, 'date': None, 'text': '', 'photos': [], 'files': [],
                            'reply_to': None, 'fwd': False}
                self.msgs.append(self.cur)
                role = 'message'
            elif self.cur is not None:
                c = cls.split()
                if 'date' in c and 'details' in c and a.get('title'):
                    self.cur['date'] = a['title']
                if 'text' in c and self.text_depth == 0:
                    role = 'text'; self.text_depth = 1; self.text_buf = []
                elif self.text_depth:
                    self.text_depth += 1
                if 'forwarded' in c:
                    self.cur['fwd'] = True
            self.stack.append(role)
            return
        if self.cur is None:
            return
        if self.text_depth and tag == 'br':
            self.text_buf.append('\n')
        if tag == 'a':
            href = a.get('href', '') or ''
            m = re.search(r'go_to_message(\d+)', href) or re.search(r'GoToMessage\((\d+)\)', a.get('onclick', '') or '')
            if m and not self.text_depth:
                self.cur['reply_to'] = m.group(1)
            if 'photo_wrap' in cls and href:
                self.cur['photos'].append(href)
            elif ('media_file' in cls or 'media_video' in cls or 'video_file_wrap' in cls) and href:
                self.cur['files'].append(href)

    def handle_startendtag(self, tag, attrs):
        if tag == 'br' and self.text_depth:
            self.text_buf.append('\n')
        else:
            self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag != 'div' or not self.stack:
            return
        role = self.stack.pop()
        if self.text_depth:
            self.text_depth -= 1
            if self.text_depth == 0 and self.cur is not None:
                self.cur['text'] = (self.cur['text'] + '\n' + ''.join(self.text_buf)).strip()
        if role == 'message':
            self.cur = None

    def handle_data(self, data):
        if self.text_depth:
            self.text_buf.append(data)


def _file_order(name):
    m = re.search(r'messages(\d*)\.html$', name)
    return int(m.group(1) or 1) if m else 0


def parse_export(root):
    """Все сообщения выгрузки по порядку. Пути к фото — абсолютные."""
    files = []
    for d, _, fs in os.walk(root):
        for f in fs:
            if re.match(r'messages\d*\.html$', f):
                files.append(os.path.join(d, f))
    files.sort(key=lambda p: (os.path.dirname(p), _file_order(p)))
    out = []
    for p in files:
        ps = _ExportParser(os.path.basename(p))
        ps.feed(open(p, encoding='utf-8').read())
        for m in ps.msgs:
            m['photos'] = [os.path.normpath(os.path.join(os.path.dirname(p), h)) for h in m['photos']]
            m['text'] = re.sub(r'[ \t]+\n', '\n', m['text']).strip()
        out.extend(ps.msgs)
    return out


# ---------- обезличивание для просмотра схемы ----------
KEEP = set('''взял взяла взято получил оплата оплатил итого чистыми расход расходы запчасти запчасть деталь детали
компрессор фреон термостат датчик подшипники подшипник тэн насос плата подсветка ремонт заправка диагностика выезд
холодильник холод хол стиральная стиралка стир машина машинка см телевизор тв тел телефон адрес ул улица д дом кв
пр проспект пер мкр подъезд под эт этаж домофон не морозит греет течет течёт сливает отжим крутит включается
работает шумит гудит руб р т тыс к имя модель марка нет да отказ отмена отменил перезвонить гарантия
lg samsung bosch indesit atlant атлант стинол stinol beko haier ariston whirlpool candy electrolux zanussi'''.split())


def mask(text):
    def word(m):
        w = m.group(0)
        if w.lower() in KEEP:
            return w.lower()
        return re.sub(r'[A-Za-zА-Яа-яЁё]', lambda c: 'Х' if c.group(0).isupper() else 'х', w)
    t = re.sub(r'[A-Za-zА-Яа-яЁё]+', word, text)
    return re.sub(r'\d', '0', t)


def inspect(root, n=40):
    msgs = parse_export(root)
    real = [m for m in msgs if not m['service']]
    with_text = [m for m in real if m['text']]
    print('файлов сообщений:', len({m['file'] for m in msgs}), ' сообщений:', len(real), ' служебных:', len(msgs) - len(real))
    print('с текстом:', len(with_text), ' с фото:', sum(1 for m in real if m['photos']),
          ' только фото:', sum(1 for m in real if m['photos'] and not m['text']),
          ' фото всего:', sum(len(m['photos']) for m in real))
    print('ответов (reply):', sum(1 for m in real if m['reply_to']), ' пересланных:', sum(1 for m in real if m['fwd']),
          ' «склеенных» с предыдущим:', sum(1 for m in real if m['joined']))
    dates = [m['date'][:10] for m in real if m['date']]
    if dates:
        print('первое:', dates[0], ' последнее:', dates[-1])
    print('--- длина текста: <40:', sum(1 for m in with_text if len(m['text']) < 40),
          ' 40-150:', sum(1 for m in with_text if 40 <= len(m['text']) < 150), ' 150+:', sum(1 for m in with_text if len(m['text']) >= 150))
    random.seed(7)
    idx = sorted(random.sample(range(len(real)), min(n, len(real))))
    print('--- обезличенные примеры подряд идущих сообщений (буквы→х, цифры→0) ---')
    shown = set()
    for i in idx[: n // 4]:
        for j in range(i, min(i + 4, len(real))):
            if j in shown:
                continue
            shown.add(j)
            m = real[j]
            tag = '#%d%s%s%s' % (j, ' reply→' + ('ok' if m['reply_to'] else '') if m['reply_to'] else '',
                                  ' фото×%d' % len(m['photos']) if m['photos'] else '', ' joined' if m['joined'] else '')
            print(tag)
            if m['text']:
                print('   ' + mask(m['text']).replace('\n', '\n   '))
        print('   ...')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    if len(sys.argv) >= 3 and sys.argv[1] == '--inspect':
        inspect(sys.argv[2])
    else:
        print(__doc__)
