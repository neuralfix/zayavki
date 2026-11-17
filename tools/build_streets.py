"""Собирает streets.json для приложения из выгрузок OpenStreetMap (Overpass).
Использование: python build.py <папка с json> <файл результата>"""
import json, math, re, sys, os
from collections import defaultdict, Counter

src, dst = sys.argv[1], sys.argv[2]
load = lambda n: json.load(open(os.path.join(src, n + '.json'), encoding='utf-8'))['elements']

def center(e):
    if 'center' in e: return e['center']['lat'], e['center']['lon']
    if 'lat' in e: return e['lat'], e['lon']
    return None

def dist(a, b):
    k = math.cos(math.radians(54.7))
    return math.hypot((a[0] - b[0]) * 111.0, (a[1] - b[1]) * 111.0 * k)

TYPES = [  # (слово в OSM, сокращение)
    ('улица', 'ул.'), ('проспект', 'пр-т'), ('переулок', 'пер.'), ('бульвар', 'б-р'), ('проезд', 'пр-д'),
    ('шоссе', 'ш.'), ('тупик', 'туп.'), ('площадь', 'пл.'), ('набережная', 'наб.'), ('тракт', 'тракт'),
    ('аллея', 'аллея'), ('микрорайон', 'мкр'), ('квартал', 'кв-л'), ('линия', 'линия'), ('спуск', 'спуск'),
    ('въезд', 'въезд'), ('территория', 'тер.'),
]
TYPE_RE = re.compile(r'(?i)(?<![\w-])(' + '|'.join(t for t, _ in TYPES) + r')(?![\w-])')
ABBR = dict(TYPES)

def pretty(name):
    """«Лесная улица» → «ул. Лесная», «улица Ленина» → «ул. Ленина». Без типа — None."""
    m = TYPE_RE.search(name)
    if not m: return None
    rest = (name[:m.start()] + name[m.end():]).strip(' ,')
    rest = re.sub(r'\s+', ' ', rest)
    if not rest: return None
    return ABBR[m.group(1).lower()] + ' ' + rest

def clean_name(n):
    """Убирает невидимые символы, «(дублёр)» и т. п.; «A;B» → ["A", "B"]."""
    n = re.sub('[​-‏⁠﻿ ]', ' ', n or '')
    out = []
    for part in n.split(';'):
        part = re.sub(r'\s*\([^)]*\)', '', part)
        part = re.sub(r'\s+', ' ', part).strip(' ,')
        if part: out.append(part)
    return out

def clean_city(c):
    c = re.sub(r'(?i)^(город|г\.|село|с\.|деревня|д\.|посёлок|поселок|пос\.|п\.|рабочий посёлок)\s*', '', (c or '').strip())
    return c.strip()

places = {}
for area in ('u', 'r'):
    pts = []
    for e in load('places_' + area):
        c = center(e); n = e['tags'].get('name')
        if c and n and e['tags'].get('place') in ('town', 'village', 'hamlet', 'isolated_dwelling', 'allotments'):
            pts.append((n, c))
    places[area] = pts

def nearest_place(area, c, maxkm):
    best = None
    for n, pc in places[area]:
        d = dist(c, pc)
        if d <= maxkm and (best is None or d < best[0]): best = (d, n)
    return best[1] if best else None

# Улицы: сырое имя -> список центров отрезков
segs = {a: defaultdict(list) for a in ('u', 'r')}
for area in ('u', 'r'):
    for e in load('streets_' + area):
        c = center(e)
        if c and e['tags'].get('highway') not in ('platform', 'proposed', 'bus_stop', 'raceway'):
            for n in clean_name(e['tags'].get('name')):
                segs[area][n].append(c)

# Дома
houses = {a: [] for a in ('u', 'r')}
place_houses = defaultdict(set)  # сёла без улиц: addr:place
for area in ('u', 'r'):
    for e in load('addr_' + area):
        t = e['tags']; c = center(e); hn = t.get('addr:housenumber', '').strip()
        hn = re.sub(r'\s+', ' ', hn.replace('​', ''))
        if not c or not hn or len(hn) > 10 or re.search(r'(?i)оф|кв|пом|;|,', hn): continue
        if t.get('addr:street') and clean_name(t['addr:street']):
            houses[area].append((clean_name(t['addr:street'])[0], hn, clean_city(t.get('addr:city') or t.get('addr:place')), c))
        elif t.get('addr:place'):
            place_houses[clean_city(t['addr:place'])].add(hn)

# Улица = (area, сырое имя, кластер) ; разбиваем одноимённые улицы по сёлам
streets = {}  # (loc, pretty) -> set(houses)
def loc_for(area, c, hint=None):
    if area == 'u':
        if hint and hint.lower() != 'уфа': return hint
        p = nearest_place('u', c, 1.2)
        return p or 'Уфа'
    if hint: return hint
    return nearest_place('r', c, 4.0) or 'Уфимский р-н'

seg_loc = {}
for area in ('u', 'r'):
    for raw, cs in segs[area].items():
        pr = pretty(raw)
        if not pr: continue
        for c in cs:
            loc = loc_for(area, c)
            seg_loc.setdefault((area, raw), []).append((c, loc))
            streets.setdefault((loc, pr), set())

unmatched = 0
for area in ('u', 'r'):
    for raw, hn, city, c in houses[area]:
        pr = pretty(raw) or raw
        cand = seg_loc.get((area, raw))
        if cand:
            d, loc = min(((dist(c, sc), l) for sc, l in cand), key=lambda x: x[0])
            if city and area == 'r': loc = city
            if area == 'u' and city and city.lower() != 'уфа': loc = city
        else:
            loc = loc_for(area, c, city)
        streets.setdefault((loc, pr), set()).add(hn)

# Сёла без улиц
for p, hs in place_houses.items():
    if p: streets.setdefault((p, ''), set()).update(hs)

def hkey(h):
    m = re.match(r'(\d+)', h)
    return (int(m.group(1)) if m else 10**6, h)

locs = sorted({l for l, _ in streets}, key=lambda l: (l != 'Уфа', l))
li = {l: i for i, l in enumerate(locs)}
rows = []
for (loc, pr), hs in sorted(((k, v) for k, v in streets.items() if not re.search(r'Вход|квартал$', k[0])), key=lambda kv: (li[kv[0][0]], kv[0][1])):
    rows.append([pr, li[loc], '|'.join(sorted(hs, key=hkey))])

json.dump({'v': 1, 'src': '© участники OpenStreetMap, ODbL', 'loc': locs, 's': rows},
          open(dst, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
nh = sum(len(r[2].split('|')) for r in rows if r[2])
print('locs', len(locs), 'streets', len(rows), 'houses', nh, 'bytes', os.path.getsize(dst))
print('ufa streets', sum(1 for r in rows if r[1] == 0))
