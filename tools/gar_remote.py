"""Чтение архива ГАР (ФНС) прямо с сайта по кусочкам: весь архив ~58 ГБ, нужна только папка региона.
Использование:
  python -I tools/gar_remote.py list 02            — какие файлы есть у региона 02 (Башкортостан) и их размер
  python -I tools/gar_remote.py get 02 <папка>     — скачать нужные файлы региона (адресные объекты, дома, иерархия)
"""
import io, json, os, sys, urllib.request, zipfile

INFO = 'https://fias.nalog.ru/WebServices/Public/GetLastDownloadFileInfo'
UA = {'User-Agent': 'street-list-builder/1.0'}
# Что нужно для справочника улиц: адресные объекты (город, село, улица), дома, административная иерархия (город → улица → дом), параметры не нужны
NEED = ('AS_ADDR_OBJ_2', 'AS_HOUSES_2', 'AS_ADM_HIERARCHY_2', 'AS_ADDR_OBJ_TYPES_', 'AS_OBJECT_LEVELS_')


class RangeFile(io.RawIOBase):
    """Файл на сервере, читаемый кусками (HTTP Range), — чтобы zipfile мог открыть его без скачивания целиком."""

    def __init__(self, url):
        self.url, self.pos = url, 0
        with urllib.request.urlopen(urllib.request.Request(url, method='HEAD', headers=UA), timeout=60) as r:
            self.size = int(r.headers['Content-Length'])

    def seekable(self): return True
    def readable(self): return True
    def tell(self): return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def read(self, n=-1):
        if n is None or n < 0: n = self.size - self.pos
        if n == 0 or self.pos >= self.size: return b''
        end = min(self.pos + n, self.size) - 1
        for attempt in range(5):
            try:
                req = urllib.request.Request(self.url, headers={**UA, 'Range': f'bytes={self.pos}-{end}'})
                with urllib.request.urlopen(req, timeout=300) as r:
                    data = r.read()
                break
            except Exception:
                if attempt == 4: raise
        self.pos += len(data)
        return data

    def readinto(self, b):
        d = self.read(len(b)); b[:len(d)] = d; return len(d)


def latest():
    with urllib.request.urlopen(urllib.request.Request(INFO, headers=UA), timeout=60) as r:
        return json.load(r)


def main():
    cmd, region = sys.argv[1], sys.argv[2]
    info = latest()
    url = info['GarXMLFullURL']
    print('ГАР от', info['Date'], url)
    z = zipfile.ZipFile(io.BufferedReader(RangeFile(url), buffer_size=1 << 20))
    names = [i for i in z.infolist() if i.filename.startswith(region + '/') or ('/' not in i.filename and i.filename.startswith(NEED[3:]))]
    want = [i for i in names if any(os.path.basename(i.filename).startswith(p) for p in NEED)]
    if cmd == 'list':
        for i in names:
            print(('* ' if i in want else '  ') + f'{i.filename:70s} {i.compress_size / 1e6:9.1f} МБ сжато, {i.file_size / 1e6:9.1f} МБ')
        return
    out = sys.argv[3]
    os.makedirs(out, exist_ok=True)
    for i in want:
        dst = os.path.join(out, os.path.basename(i.filename))
        print('скачиваю', i.filename, round(i.compress_size / 1e6, 1), 'МБ')
        with z.open(i) as src, open(dst, 'wb') as f:
            while True:
                b = src.read(1 << 20)
                if not b: break
                f.write(b)
    json.dump({'date': info['Date'], 'version': info['VersionId']}, open(os.path.join(out, 'version.json'), 'w'))
    print('готово')


if __name__ == '__main__':
    main()
