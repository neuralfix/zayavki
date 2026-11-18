"""Справочник улиц для приложения из ГАР (Государственный адресный реестр ФНС) + дополнение из OpenStreetMap.
Использование:
  python -I tools/gar_remote.py get 02 <папка ГАР>                 — скачать файлы Башкортостана (~230 МБ)
  python -I tools/build_streets_gar.py <папка ГАР> <старый streets.json из OSM или -> <результат>

Берутся Уфа (город со всеми сёлами внутри) и Уфимский район. Только действующие адреса.
В результате: {v, date, src, loc: [...], s: [[улица, № места, "дом|дом|…"], …]} — тот же вид, что читает addr.js.
"""
import glob, json, os, re, sys
import xml.etree.ElementTree as ET
from collections import defaultdict

gar, osm_path, dst = sys.argv[1], sys.argv[2], sys.argv[3]
one = lambda pat: glob.glob(os.path.join(gar, pat))[0]


def rows(path, tag):
    for _, el in ET.iterparse(path, events=('end',)):
        if el.tag == tag:
            yield el.attrib
            el.clear()


# --- 1. Адресные объекты: город, село, улица ---
obj = {}   # objectid -> (name, type, level)
for a in rows(one('AS_ADDR_OBJ_2*.XML'), 'OBJECT'):
    if a.get('ISACTUAL') == '1' and a.get('ISACTIVE') == '1':
        obj[a['OBJECTID']] = (a['NAME'].strip(), a['TYPENAME'].strip().rstrip('.'), int(a['LEVEL']))
ufa = [k for k, (n, t, l) in obj.items() if n == 'Уфа' and t == 'г' and l == 5]
rn = [k for k, (n, t, l) in obj.items() if n == 'Уфимский' and t in ('р-н', 'м.р-н') and l in (2, 3)]
assert ufa and rn, (ufa, rn)
UFA, RN = set(ufa), set(rn)
print('объектов', len(obj), 'Уфа', ufa, 'район', rn)

# --- 2. Иерархия: путь каждого объекта Уфы и района ---
path = {}   # objectid -> [предки..., сам]
for a in rows(one('AS_ADM_HIERARCHY_2*.XML'), 'ITEM'):
    if a.get('ISACTIVE') != '1': continue
    p = a.get('PATH', '').split('.')
    if UFA.intersection(p) or RN.intersection(p):
        path[a['OBJECTID']] = p
print('в иерархии Уфы и района', len(path))

TYPE = {'ул': 'ул.', 'пр-кт': 'пр-т', 'пер': 'пер.', 'б-р': 'б-р', 'проезд': 'пр-д', 'пр-д': 'пр-д', 'ш': 'ш.', 'туп': 'туп.',
        'пл': 'пл.', 'наб': 'наб.', 'тракт': 'тракт', 'аллея': 'аллея', 'мкр': 'мкр', 'мкр.': 'мкр', 'кв-л': 'кв-л', 'линия': 'линия',
        'спуск': 'спуск', 'въезд': 'въезд', 'тер': 'тер.', 'тер.': 'тер.', 'снт': 'СНТ', 'тер. СНТ': 'СНТ', 'тер. ДНТ': 'ДНТ',
        'днт': 'ДНТ', 'тер. ТСН': 'ТСН', 'гск': 'ГСК', 'тер. ГСК': 'ГСК', 'платф': 'платф.', 'парк': 'парк', 'сквер': 'сквер',
        'взд': 'въезд', 'ряд': 'ряд', 'зона': 'зона', 'местность': 'местность', 'ал': 'аллея', 'рзд': 'рзд.', 'ст': 'ст.', 'промзона': 'промзона', 'дор': 'дор.', 'км': 'км'}
SKIP_TYPES = {'ГСК', 'промзона', 'км', 'платф.', 'ряд'}


def label(oid):
    n, t, _ = obj[oid]
    ab = TYPE.get(t, t)
    if ab in SKIP_TYPES: return None
    # «Лесная улица» в ГАР хранится как «Лесная» + «ул»; номерные: «1-я Лесная»
    return ab + ' ' + n


def where(p):
    """Место: «Уфа» или название села (внутри Уфы и в районе). None — не наше."""
    inside_ufa = bool(UFA.intersection(p))
    place = None
    for x in p:
        if x in obj and obj[x][2] == 6 and not (inside_ufa and obj[x][0] == 'Уфа'):
            place = obj[x][0]
    if inside_ufa: return place or 'Уфа'
    return place


# --- 3. Улицы и дома ---
streets = defaultdict(set)   # (место, улица) -> дома
street_of = {}              # objectid улицы -> (место, улица)
for oid, p in path.items():
    o = obj.get(oid)
    if not o or o[2] not in (7, 8): continue
    lb = label(oid); loc = where(p)
    if lb and loc:
        street_of[oid] = (loc, lb); streets[(loc, lb)]


HTYPE_OK = {'1', '2', '3', '5', '10'}   # владение, дом, домовладение, здание, корпус
ADD = {'1': 'к', '2': 'с', '3': 'соор', '4': 'лит'}
n_h = 0
for a in rows(one('AS_HOUSES_2*.XML'), 'HOUSE'):
    if a.get('ISACTUAL') != '1' or a.get('ISACTIVE') != '1' or a.get('HOUSETYPE') not in HTYPE_OK: continue
    p = path.get(a['OBJECTID'])
    if not p or len(p) < 2: continue
    hn = (a.get('HOUSENUM') or '').strip()
    if not hn or len(hn) > 10: continue
    for k in ('1', '2'):
        if a.get('ADDNUM' + k):
            hn += ' ' + ADD.get(a.get('ADDTYPE' + k), '') + a['ADDNUM' + k].strip()
    parent = p[-2]
    if parent in street_of:
        streets[street_of[parent]].add(hn); n_h += 1
    elif parent in obj and obj[parent][2] == 6:          # село без улиц
        loc = where(p)
        if loc: streets[(loc, '')].add(hn); n_h += 1
print('домов из ГАР', n_h, 'улиц', len(streets))

# --- 4. Дополнение из OSM: улицы, которых нет в ГАР (по названию без типа) ---
added = 0
if osm_path != '-' and os.path.exists(osm_path):
    norm = lambda s: re.sub(r'[^0-9a-zа-я]+', ' ', s.lower().replace('ё', 'е')).strip()
    bare = lambda lb: norm(re.sub(r'^\S+\s', '', lb))
    have = {(loc, bare(lb)) for loc, lb in streets}
    gar_locs = {loc for loc, _ in streets}
    known_types = set(TYPE.values())
    d = json.load(open(osm_path, encoding='utf-8'))
    # место из OSM: то же село, что в ГАР («Фёдоровка» = «Федоровка»), или своё место с 3+ улицами (СНТ, коттеджный посёлок)
    by_norm = {norm(l): l for l in gar_locs}
    per_loc = defaultdict(int)
    for lb, li, hs in d['s']: per_loc[li] += 1
    for lb, li, hs in d['s']:
        loc = by_norm.get(norm(d['loc'][li])) or (d['loc'][li] if per_loc[li] >= 3 else None)
        # только с понятным типом улицы (без «Ул.Архитектора…», координат)
        if not loc or (lb and lb.split(' ')[0] not in known_types): continue
        key = (loc, bare(lb) if lb else '')
        if key in have:
            # та же улица: добавить дома, которых нет в ГАР
            for (l2, s2) in [(loc, x) for (l, x) in list(streets) if l == loc and bare(x) == key[1]][:1]:
                streets[(l2, s2)].update(h for h in (hs.split('|') if hs else []) if h)
            continue
        streets[(loc, lb)].update(hs.split('|') if hs else [])
        added += 1
print('улиц добавлено из OSM', added)


def hkey(h):
    m = re.match(r'(\d+)', h)
    return (int(m.group(1)) if m else 10 ** 6, h)


# Номер дома одним видом: «5А» и «5а» — один дом (буквы строчные, лишние пробелы убраны)
for k in streets:
    streets[k] = {re.sub(r'\s+', ' ', h.strip().lower()) for h in streets[k] if h and h.strip()}

locs = sorted({l for l, _ in streets}, key=lambda l: (l != 'Уфа', l))
li = {l: i for i, l in enumerate(locs)}
out_rows = [[lb, li[loc], '|'.join(sorted(hs, key=hkey))] for (loc, lb), hs in sorted(streets.items(), key=lambda kv: (li[kv[0][0]], kv[0][1]))]
ver = json.load(open(os.path.join(gar, 'version.json')))
d, m, y = ver['date'].split('.')
json.dump({'v': 2, 'date': f'{y}-{m}-{d}', 'src': 'ГАР ФНС России; © участники OpenStreetMap, ODbL', 'loc': locs, 's': out_rows},
          open(dst, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
nh = sum(len(r[2].split('|')) for r in out_rows if r[2])
print('мест', len(locs), 'улиц', len(out_rows), 'домов', nh, 'байт', os.path.getsize(dst),
      'улиц в Уфе', sum(1 for r in out_rows if r[1] == 0))
