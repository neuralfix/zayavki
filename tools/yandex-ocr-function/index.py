# Посредник «Мои заявки» → Yandex Vision OCR. Облачная функция, Python 3.12, точка входа index.handler.
# Переменные окружения: FOLDER_ID — ID каталога, APP_KEY — секретный ключ (тот же вписывается в приложение).
import base64, json, os, urllib.error, urllib.request

OCR_URL = 'https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText'
ORIGINS = ('https://neuralfix.github.io', 'http://localhost:8765')


def _cors(event):
    origin = (event.get('headers') or {}).get('Origin') or (event.get('headers') or {}).get('origin') or ''
    return {'Access-Control-Allow-Origin': origin if origin in ORIGINS else ORIGINS[0],
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-App-Key',
            'Access-Control-Max-Age': '86400', 'Vary': 'Origin'}


def _answer(event, code, body):
    h = _cors(event); h['Content-Type'] = 'application/json; charset=utf-8'
    return {'statusCode': code, 'headers': h, 'body': json.dumps(body, ensure_ascii=False)}


def handler(event, context):
    if event.get('httpMethod') == 'OPTIONS':
        return {'statusCode': 204, 'headers': _cors(event), 'body': ''}
    headers = {k.lower(): v for k, v in (event.get('headers') or {}).items()}
    key = os.environ.get('APP_KEY', '')
    if len(key) < 12 or headers.get('x-app-key') != key:
        return _answer(event, 403, {'error': 'Неверный ключ'})
    body = event.get('body') or ''
    if event.get('isBase64Encoded'):
        body = base64.b64decode(body).decode('utf-8')
    try:
        image = json.loads(body).get('image', '')
    except ValueError:
        image = ''
    if not image or len(image) > 3_000_000:
        return _answer(event, 400, {'error': 'Нет фото или оно слишком большое'})
    req = urllib.request.Request(OCR_URL, method='POST', data=json.dumps({
        'mimeType': 'JPEG', 'languageCodes': ['ru', 'en'], 'model': 'page', 'content': image}).encode(), headers={
        'Content-Type': 'application/json', 'Authorization': 'Bearer ' + context.token['access_token'],
        'x-folder-id': os.environ['FOLDER_ID'],
        'x-data-logging-enabled': 'false'})  # Яндекс не сохраняет фото для своих нужд
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            raw = r.read().decode('utf-8')
    except urllib.error.HTTPError as e:
        return _answer(event, 502, {'error': 'Распознавание ответило ошибкой ' + str(e.code), 'detail': e.read().decode('utf-8', 'replace')[:300]})
    texts, lines = [], []
    for part in raw.splitlines() or [raw]:   # ответ может прийти несколькими кусками
        if not part.strip():
            continue
        ta = (json.loads(part).get('result') or {}).get('textAnnotation') or {}
        texts.append(ta.get('fullText', ''))
        lines += [ln.get('text', '') for b in ta.get('blocks', []) for ln in b.get('lines', [])]
    return _answer(event, 200, {'text': '\n'.join(texts), 'lines': lines})
