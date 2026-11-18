"""Ежемесячное обновление справочника улиц на компьютере мастера (Планировщик Windows, задача «Справочник улиц»).
Работает в отдельной копии проекта (%USERPROFILE%\\.zayavki-streets\\repo), рабочую папку не трогает:
  git pull → у ФНС база новее нашей? → скачать файлы региона 02 → собрать → проверить → отправить streets.json.
Запуск вручную:  python -I tools/streets_auto.py [--force]     (--force — собрать, даже если база не новее)
Журнал: %USERPROFILE%\\.zayavki-streets\\log.txt
GitHub сам это делать не может: сайт ФНС не отвечает зарубежным серверам.
"""
import datetime, json, os, shutil, subprocess, sys, traceback, urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOME = os.path.join(os.path.expanduser('~'), '.zayavki-streets')
LOG = os.path.join(HOME, 'log.txt')
GAR = os.path.join(HOME, 'gar')
OUT = os.path.join(HOME, 'streets.json')
INFO = 'https://fias.nalog.ru/WebServices/Public/GetLastDownloadFileInfo'
NOWIN = getattr(subprocess, 'CREATE_NO_WINDOW', 0)   # без мигающих окон при запуске из Планировщика


def log(*a):
    line = datetime.datetime.now().strftime('%Y-%m-%d %H:%M') + '  ' + ' '.join(str(x) for x in a)
    try: print(line)
    except Exception: pass
    with open(LOG, 'a', encoding='utf-8') as f: f.write(line + '\n')


def run(*cmd, cwd=REPO):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, encoding='utf-8', errors='replace', creationflags=NOWIN)
    out = (r.stdout + r.stderr).strip()
    if r.returncode:
        raise RuntimeError(' '.join(cmd[:3]) + ' → ошибка ' + str(r.returncode) + '\n' + out[-2000:])
    return out


def py(script, *args):
    # -I: не подхватывать чужой код из рабочей папки; -X utf8: русский вывод без искажений
    return run(sys.executable, '-I', '-X', 'utf8', os.path.join(REPO, 'tools', script), *args)


def main():
    force = '--force' in sys.argv
    run('git', 'pull', '--ff-only', '-q')
    cur = json.load(open(os.path.join(REPO, 'streets.json'), encoding='utf-8'))
    with urllib.request.urlopen(urllib.request.Request(INFO, headers={'User-Agent': 'street-list-builder/1.0'}), timeout=120) as r:
        d, m, y = json.load(r)['Date'].split('.')
    gar_date = f'{y}-{m}-{d}'
    if gar_date <= (cur.get('date') or '') and not force:
        log('база ФНС от', gar_date, '— не новее нашей, ничего не делаю')
        return
    log('база ФНС от', gar_date, ', у нас от', cur.get('date'), '— собираю')
    try:
        py('gar_remote.py', 'get', '02', GAR)
        log(py('build_streets_gar.py', GAR, os.path.join(REPO, 'tools', 'streets_osm.json'), OUT).splitlines()[-1])
        new = json.load(open(OUT, encoding='utf-8'))
        n_new, n_old = len(new['s']), len(cur['s'])
        # защита от обрезанной или пустой выгрузки
        if not (new.get('v') == 2 and new.get('date') and new.get('loc')): raise RuntimeError('неверный формат справочника')
        if n_new < 3000 or n_new < 0.9 * n_old: raise RuntimeError(f'слишком мало улиц: {n_new} (было {n_old}), не заменяю')
        if new['date'] < (cur.get('date') or ''): raise RuntimeError('собранная база старее текущей')
        shutil.copyfile(OUT, os.path.join(REPO, 'streets.json'))
        if not run('git', 'status', '--porcelain', '--', 'streets.json'):
            log('справочник не изменился')
            return
        run('git', 'add', 'streets.json')
        run('git', 'commit', '-q', '-m', f'Справочник улиц: ГАР от {new["date"]} (автообновление)')
        run('git', 'push', '-q')
        log('отправлено на сайт: улиц', n_new, '(было', str(n_old) + '), база от', new['date'])
    finally:
        shutil.rmtree(GAR, ignore_errors=True)
        if os.path.exists(OUT): os.remove(OUT)


if __name__ == '__main__':
    os.makedirs(HOME, exist_ok=True)
    try:
        main()
    except Exception:
        log('ОШИБКА:', traceback.format_exc().strip())
        sys.exit(1)
    finally:   # журнал не растёт бесконечно
        lines = open(LOG, encoding='utf-8').read().splitlines()
        if len(lines) > 400: open(LOG, 'w', encoding='utf-8').write('\n'.join(lines[-300:]) + '\n')
