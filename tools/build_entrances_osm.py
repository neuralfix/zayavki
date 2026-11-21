"""Подъезды с номерами квартир для подсказки «подъезд, этаж» — из OpenStreetMap (© участники OpenStreetMap, ODbL).
Использование:
  python -I tools/build_entrances_osm.py entrances.json
Берутся дома Уфы, у подъездов которых на карте подписаны квартиры (addr:flats).
Результат: {v: 2, date, src, h: {"улица|дом": [этажей или 0, [[№ подъезда или 0, первая кв., последняя кв.], …]]}}
Ноль означает, что на карте номер подъезда не указан или не является целым числом.
Ключ улицы — название без типа («улица Менделеева» → «менделеева»), как его считает addr.js.
"""
import datetime, json, re, sys, time, urllib.parse, urllib.request

BBOX = '54.55,55.75,54.98,56.25'   # Уфа с окрестностями
Q = f"""[out:json][timeout:240];
node["entrance"]["addr:flats"]({BBOX})->.e;
way(bn.e)["building"]["addr:housenumber"];
out body;
.e out body;"""
SERVERS = ['https://overpass.private.coffee/api/interpreter', 'https://overpass-api.de/api/interpreter',
           'https://overpass.kumi.systems/api/interpreter']
UA = {'User-Agent': 'street-list-builder/1.0'}

TYPE_WORDS = {'ул', 'улица', 'пр', 'пр-т', 'просп', 'проспект', 'пер', 'переулок', 'б', 'р', 'б-р', 'бульвар', 'пр-д', 'проезд',
              'ш', 'шоссе', 'туп', 'тупик', 'пл', 'площадь', 'наб', 'набережная', 'мкр', 'микрорайон', 'тракт', 'аллея', 'линия'}
norm = lambda s: re.sub(r'[^0-9a-zа-я]+', ' ', (s or '').lower().replace('ё', 'е')).strip()


def street_key(s):
    value = re.sub(r'^\s*пр[-–—](?:кт|т)\.?(?=\s|$)', 'проспект', s or '', flags=re.I)
    return ' '.join(t for t in norm(value).split(' ') if t and t not in TYPE_WORDS)


def house_key(h):
    value = (h or '').lower().replace('ё', 'е').replace('–', '-').replace('—', '-')
    value = re.sub(r'^(?:дом|д)\.?\s*(?=\d)', '', value.strip())
    value = re.sub(r'(корпус|корп|к|строение|стр|с|литера|лит)\.?\s*(?=\d)',
                   lambda m: {'корпус': 'к', 'корп': 'к', 'строение': 'с', 'стр': 'с', 'литера': 'лит'}.get(m[1], m[1]), value)
    return re.sub(r'\s+', '', value)


def ranges(flats):
    out = []
    for part in re.split(r'[;,]', flats or ''):
        m = re.match(r'^\s*(\d+)\s*(?:[-–—]\s*(\d+))?\s*$', part)
        if m:
            a = int(m.group(1)); b = int(m.group(2) or a)
            if 0 < a <= b < 5000: out.append((a, b))
    return out


def build_houses(data):
    nodes = {e['id']: e.get('tags', {}) for e in data['elements'] if e['type'] == 'node'}
    houses = {}
    for w in (e for e in data['elements'] if e['type'] == 'way'):
        t = w.get('tags', {})
        city = (t.get('addr:city') or 'Уфа').strip()
        if city.casefold() != 'уфа' or not t.get('addr:street') or not t.get('addr:housenumber'):
            continue
        key = street_key(t['addr:street']) + '|' + house_key(t['addr:housenumber'])
        lv = t.get('building:levels', '')
        levels = int(lv) if re.fullmatch(r'[0-9]+', lv) and 1 < int(lv) < 60 else 0
        ents = set()
        for nid in w.get('nodes', []):
            nt = nodes.get(nid, {})
            ref = re.fullmatch(r'\s*(?:№\s*)?([1-9][0-9]*)\s*', nt.get('ref', ''))
            number = int(ref[1]) if ref else 0
            ents.update((number, a, b) for a, b in ranges(nt.get('addr:flats')))
        if not ents:
            continue
        if key in houses:
            old_levels, old_ents = houses[key]
            ents.update(old_ents)
            if levels != old_levels:
                levels = 0
        houses[key] = [levels, sorted(ents, key=lambda x: (x[1], x[2], x[0]))]
    return dict(sorted(houses.items()))


def main(dst):
    query = urllib.parse.urlencode({'data': Q}).encode()
    for attempt in range(6):
        url = SERVERS[attempt % len(SERVERS)]
        try:
            req = urllib.request.Request(url, data=query, headers=UA)
            with urllib.request.urlopen(req, timeout=90) as r:
                data = json.load(r)
            houses = build_houses(data)
            if houses:
                break
            raise ValueError('выгрузка не содержит домов')
        except (OSError, ValueError, KeyError) as e:
            print('сервер', url, 'не ответил:', e, flush=True)
            if attempt < 5:
                time.sleep(10 * (attempt + 1))
    else:
        sys.exit('Overpass не ответил')

    with open(dst, 'w', encoding='utf-8') as output:
        json.dump({'v': 2, 'date': datetime.date.today().isoformat(), 'src': '© участники OpenStreetMap, ODbL', 'h': houses},
                  output, ensure_ascii=False, separators=(',', ':'))
    print('домов', len(houses), 'диапазонов квартир', sum(len(v[1]) for v in houses.values()),
          'без номера подъезда', sum(ref == 0 for _, ranges in houses.values() for ref, _, _ in ranges))


if __name__ == '__main__':
    main(sys.argv[1])
