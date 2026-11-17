"""Общие цифры по строкам отчёта: нал / себес / «закрыть на» (без данных клиентов)."""
import re, sys, statistics, collections
sys.path.insert(0, __file__.rsplit('\\', 1)[0].rsplit('/', 1)[0])
from tg_parse import parse_export

sys.stdout.reconfigure(encoding='utf-8')
msgs = [m for m in parse_export(sys.argv[1]) if not m['service'] and m['text']]
rows = []
for m in msgs:
    for l in m['text'].split('\n'):
        low = l.lower()
        if 'нал' in low or 'себес' in low or 'закрыть' in low:
            nal = re.search(r'(\d[\d\s]*)\s*нал', low)
            zak = re.search(r'закрыть\s+на\s+(\d[\d\s]*)', low)
            seb = 0
            s = re.search(r'себес(.*?)(закрыть|гар|$)', low)
            if s:
                seb = sum(int(x.replace(' ', '')) for x in re.findall(r'\d[\d ]*\d|\d', s.group(1)) if len(x.replace(' ', '')) <= 6)
            rows.append((int(nal.group(1).replace(' ', '')) if nal else None, seb, int(zak.group(1).replace(' ', '')) if zak else None))
print('строк отчёта:', len(rows), ' с «нал»:', sum(1 for r in rows if r[0] is not None), ' с «закрыть на»:', sum(1 for r in rows if r[2] is not None))
both = [r for r in rows if r[0] and r[2] is not None]
c = collections.Counter('закрыть = нал' if z == n else ('закрыть < нал' if z < n else 'закрыть > нал') for n, s, z in both)
print('сравнение:', dict(c))
print('закрыть = нал − себес:', sum(1 for n, s, z in both if z == n - s))
ratios = [z / n for n, s, z in both if n]
if ratios:
    print('доля закрыть/нал: медиана %.2f, 25%% %.2f, 75%% %.2f' % (statistics.median(ratios), *statistics.quantiles(ratios, n=4)[0::2]))
dif = [n - s - z for n, s, z in both]
print('нал − себес − закрыть: медиана', statistics.median(dif) if dif else '-')
nals = [r[0] for r in rows if r[0]]
print('сумма «нал» по всем отчётам:', sum(nals), ' себес:', sum(r[1] for r in rows), ' закрыть:', sum(r[2] for r in rows if r[2]))
