"""Запрос к Overpass API с повторами. Использование: python fetch.py <файл-запроса> <файл-ответа>"""
import sys, time, json, urllib.request, urllib.parse

EPS = ['https://overpass-api.de/api/interpreter',
       'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
       'https://overpass.private.coffee/api/interpreter']

q = open(sys.argv[1], encoding='utf-8').read()
body = urllib.parse.urlencode({'data': q}).encode()
for attempt in range(8):
    ep = EPS[attempt % len(EPS)]
    try:
        req = urllib.request.Request(ep, data=body, headers={'User-Agent': 'street-list-builder/1.0'})
        with urllib.request.urlopen(req, timeout=300) as r:
            data = r.read()
        json.loads(data)
        open(sys.argv[2], 'wb').write(data)
        print('ok', ep, len(data))
        sys.exit(0)
    except Exception as e:
        print('fail', ep, str(e)[:120])
        time.sleep(10)
sys.exit(1)
