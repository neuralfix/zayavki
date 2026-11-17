"""Частые слова в строках отчёта и в коротких строках (без данных клиентов: только слова, встречающиеся ≥5 раз,
и только из строк, которые начинаются с суммы). Плюс статистика групп сообщений с фото."""
import re, sys, collections
sys.path.insert(0, __file__.rsplit('\\', 1)[0].rsplit('/', 1)[0])
from tg_parse import parse_export, mask

sys.stdout.reconfigure(encoding='utf-8')
msgs = [m for m in parse_export(sys.argv[1]) if not m['service']]

rep = collections.Counter(); short = collections.Counter(); first_last = collections.Counter()
line_shapes = collections.Counter(); nlines = collections.Counter()
for m in msgs:
    if not m['text']:
        continue
    lines = [l.strip() for l in m['text'].split('\n') if l.strip()]
    nlines[len(lines)] += 1
    for i, l in enumerate(lines):
        kind = 'phone' if re.fullmatch(r'[\d\s()+-]{10,}', l) else ('num' if re.match(r'\d', l) else 'txt')
        line_shapes[(i, kind)] += 1
        if kind == 'num':
            for w in re.findall(r'[А-Яа-яЁёA-Za-z%]+', l.lower()):
                rep[w] += 1
        if i > 0 and kind == 'txt' and len(l) < 25:
            short[l.lower()] += 1
    # последнее слово первой строки (техника)
    if lines and not re.match(r'\d', lines[0]):
        last = re.split(r'[,\s]+', lines[0].strip(' ,.'))[-1].lower()
        first_last[last] += 1

print('строк в сообщении:', dict(sorted(nlines.items())))
print('вид строк (номер строки, тип):', dict(sorted(line_shapes.items())))
print('--- слова в строках с суммой (≥5 раз):')
print(', '.join('%s:%d' % (w, c) for w, c in rep.most_common() if c >= 5))
print('--- короткие строки (≥5 раз):')
print(', '.join('%s:%d' % (w, c) for w, c in short.most_common() if c >= 5))
print('--- последнее слово первой строки (≥5 раз):')
print(', '.join('%s:%d' % (w, c) for w, c in first_last.most_common() if c >= 5))

# Группы: цепочка = сообщение без joined + следующие joined
chains = []
for m in msgs:
    if not m['joined'] or not chains:
        chains.append([])
    chains[-1].append(m)
ct = collections.Counter((sum(1 for x in c if x['text']), min(sum(len(x['photos']) for x in c), 9)) for c in chains)
print('--- цепочек:', len(chains), ' (текстов, фото) → сколько:')
print(dict(sorted(ct.items())))
pos = collections.Counter()
for c in chains:
    t = [i for i, x in enumerate(c) if x['text']]
    if len(t) == 1 and len(c) > 1:
        pos['текст первым' if t[0] == 0 else ('текст последним' if t[0] == len(c) - 1 else 'текст в середине')] += 1
print('где текст в цепочке с фото:', dict(pos))
