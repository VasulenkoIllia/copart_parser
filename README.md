# Copart Parser

Сервіс для стабільного імпорту CSV з Copart, оновлення лотів у MySQL, парсингу фото-URL у другу БД, перевірки якості зображень, ретраїв 404 та операційного моніторингу через Telegram.

## Цілі

- Кожні 5 годин отримувати новий CSV-файл з лотами.
- Оновлювати або створювати записи в основній БД лотів.
- Окремо зберігати посилання на фото у другій БД.
- Підтримувати режими роботи через проксі і без проксі.
- Коректно обробляти 404 та повторні спроби.
- Видаляти лоти, якщо 404 триває 30 днів.
- Відмічати лоти з неякісними/неповними фото для повторної обробки.

## Поточний статус

- Стан проєкту: `Core pipeline implemented`.
- Детальний статус і журнал тестів: [docs/README.md](docs/README.md).

## Quick Start

1. Створити локальний env:

```bash
cp .env.example .env
```

2. Підняти MySQL в Docker:

```bash
docker compose up -d mysql
```

Примітка: init-файл [docker/mysql/init/00-init.sql](docker/mysql/init/00-init.sql) орієнтований на дефолтні значення з `.env.example` (`copart_core`, `copart_media`, `copart`).

3. Застосувати міграції:

```bash
npm run db:migrate
```

4. Запустити імпорт CSV:

```bash
npm run ingest:csv
```

5. Локальний smoke-test без зовнішнього CSV:

```bash
CSV_LOCAL_FILE=/tmp/copart_sample.csv MYSQL_PORT=3307 npm run ingest:csv
```

## Docker (App + MySQL)

У проєкті є повний Docker-режим: `mysql` + `app` (scheduler/CLI всередині контейнера).

Швидкий старт:

```bash
make build
make up
make migrate
```

Базові команди:

- `make ps` — стан контейнерів.
- `make logs-app` — live логи сервісу.
- `make logs-db` — live логи MySQL.
- `make ingest` — запуск ingest в контейнері.
- `make photo-sync` — запуск photo-sync в контейнері.
- `make pipeline` — одноразовий повний цикл.
- `make proxy-check` — перевірка проксі-пулу перед запуском.

Команди для "чистого" запуску:

- `make db-reset` — швидке очищення runtime-таблиць (дані лотів/фото/рани).
- `make db-drop` — повний drop/recreate двох БД.
- `make clean-run` — `db-reset -> ingest -> photo-sync`.

## Команди

- `npm run build` — компіляція TypeScript.
- `npm run db:migrate` — створення/оновлення схем і таблиць.
- `npm run ingest:csv` — стрімінговий імпорт CSV з upsert у `copart_core.lots`.
- `CSV_LOCAL_FILE=/path/file.csv npm run ingest:csv` — локальне тестування інжесту.
- `npm run photo:sync` — парсинг `lotImages`, перевірка фото, оновлення `copart_media`.
- `npm run proxy:check` — preflight перевірка проксі, відбір робочих і оцінка місткості.
- `npm run pipeline:run-once` — повний цикл: ingest + photo sync.
- `npm run scheduler:start` — планувальник (5 запусків/день + retry cron).
- `npm run db:reset` — швидке очищення runtime-таблиць через Docker MySQL.
- `npm run db:drop` — повний drop/recreate двох БД через Docker MySQL.

Контроль кількості лотів у бойовому ingest (без локальних файлів):

- `INGEST_MAX_ROWS=0` — без ліміту (дефолт).
- `INGEST_MAX_ROWS=1000` — обробити лише 1000 валідних лотів з реального CSV URL за один запуск.

## Реальна структура фото (перевірено запитом)

Перевірений endpoint:

```text
http://inventoryv2.copart.io/v1/lotImages/<lot_number>?country=us&brand=cprt&yardNumber=<yard>
```

Фактичні URL фото приходять у:

- `lotImages[].link[].url`

Тип фото визначається полями:

- `isThumbNail=true` -> `thumb`
- `isHdImage=true` -> `hd`
- `isThumbNail=false && isHdImage=false` -> `full`

Важливо: статус якості в системі рахується не лише по флагах. Ми робимо фактичну перевірку `width/height` і `content-length` (пороги з ENV), тому рішення про `ok/partial/missing` базується на реальному розмірі фото.

## План реалізації (зафіксований)

### Етап 1. База і інфраструктура

- [x] Підняти MySQL у Docker для локальної розробки.
- [x] Створити 2 схеми: `copart_core` (лоти) і `copart_media` (фото).
- [x] Описати міграції і базові індекси під масові upsert.
- [x] Додати таблиці запусків (`ingest_runs`, `photo_runs`) для аудиту.

### Етап 2. Імпорт CSV (200k+ рядків)

- [x] Стрімінгове читання CSV (без завантаження всього файлу в RAM).
- [x] Батчевий `INSERT ... ON DUPLICATE KEY UPDATE`.
- [x] Обчислення `row_hash` для виявлення реальних змін.
- [x] Поля `first_seen_at`, `last_seen_at`, `updated_at_source`.

### Етап 3. Обробка фото (2M+ URL)

- [x] Витягувати `lotImages` з `imageurl` по кожному лоту.
- [x] Валідувати фото за типом, роздільною здатністю і розміром.
- [x] Зберігати у `copart_media.lot_images` всі валідні full-size фото (без `thumb`/`video`), унікально по `sequence+url`.
- [x] Виставляти статус лота: `ok` / `partial` / `missing`.

### Етап 4. 404 / ретраї / очищення

- [x] Логувати 404/помилки у таблицю спроб.
- [x] Експоненційний backoff для повторних запитів.
- [x] Якщо 404 триває 30 днів — видаляти лот з `copart_core`.
- [x] Повторно перевіряти лоти з частково неякісними фото.

### Етап 5. Планувальник і стабільність

- [x] Запускати повний цикл 5 разів на день (кожні 5 годин).
- [x] Блокування паралельних запусків (`run lock`).
- [x] Черга повторних фото-перевірок.
- [x] Retry policy для мережевих помилок і таймаутів.

### Етап 6. Логи, моніторинг, Telegram

- [x] Структуровані логи по кожному етапу.
- [x] Telegram-сповіщення: старт/фініш/помилки/аномалії.
- [ ] Метрики: оброблено лотів, 404 rate, % full-size фото, backlog.

## Принципи обробки даних

### Лоти

- Унікальний ключ лота: `lot_number`.
- При кожному імпорті:
  - якщо лот новий — створити запис;
  - якщо існує — оновити змінені поля;
  - якщо не змінювався (`row_hash` однаковий) — пропустити важкі операції.

### Фото

- Парсити всі варіанти URL з endpoint і перевіряти їх через HEAD/GET.
- У `copart_media.lot_images` зберігати тільки якісні full-size фото:
  - `check_status = ok`,
  - `is_full_size = 1`,
  - без `thumb`/`video`,
  - всі унікальні good URL (накопичення між прогонами).
- Для `partial` лотів запис фото працює в merge-режимі: вже знайдені good фото не видаляються при тимчасових збоях джерела.
- Всі спроби запитів і помилки зберігати в `copart_media.photo_fetch_attempts`.

### Правило "повні фото"

Лот вважається `photo_ok`, якщо:

- для кожного `sequence` є хоча б одне справді велике фото (`is_full_size = 1`);
- для статусу не враховуються `thumb`/`video`;
- фото пройшли пороги якості (мін. ширина/висота і/або розмір).

Якщо хоча б одне фото неякісне або недоступне — лот позначається на повторну перевірку.

## Конфігурація (тільки через ENV)

Всі змінні зібрані у [.env.example](.env.example).

Категорії змінних:

- app/runtime
- schedule
- csv source
- mysql
- ingest
- photo quality/retry
- proxy
- telegram

## Режим прискорення (проксі)

Якщо мета — максимально пришвидшити `photo:sync` на великих обсягах, використовуйте такий профіль:

- `PHOTO_FETCH_CONCURRENCY=30` як старт, далі піднімати поступово (`80`, `120`) з моніторингом timeout/429/403.
- `HTTP_MODE=proxy` або `HTTP_MODE=mixed`, заповнити `PROXY_LIST` або `PROXY_LIST_FILE` (рекомендовано файл `./proxies.txt`).
- Ліміт запитів на 1 проксі (рекомендовано 2-5 одночасно) і health-check/blacklist нестабільних проксі.
- `PHOTO_VALIDATE_BY_HEAD_FIRST=false` для зменшення кількості HTTP-запитів на фото.
- Зменшити навантаження на MySQL: логувати тільки помилки (404/error), а не всі `image_head/image_get`.
- Не робити повторних важких перевірок там, де URL не змінився і фото вже валідоване як `ok`.

Практично: 1000 проксі не дають 1000x приріст. Головний ефект дає керований паралелізм + стабільний пул проксі + зниження зайвих HTTP/DB операцій.

### Proxy preflight (перед запуском)

Перед `photo:sync` сервіс може автоматично перевіряти проксі і брати тільки робочі:
перевірка виконується на старті кожного `photo:sync` запуску.

- `PROXY_LIST_FILE=./proxies.txt`
- `PROXY_PREFLIGHT_ENABLED=true`
- `PROXY_PREFLIGHT_TOP_N=20` (для старту брати 20 найстабільніших)
- `PROXY_PREFLIGHT_CONCURRENCY=100`
- `PROXY_PREFLIGHT_TIMEOUT_MS=7000`
- `PROXY_PREFLIGHT_MIN_WORKING=5`
- `PROXY_PREFLIGHT_STRICT=false` (`true` -> падати, якщо робочих менше `MIN_WORKING`)

Ручна перевірка пулу:

```bash
npm run proxy:check
```

У логах буде `configured`, `healthy`, `selected` і `capacityAt30PerProxy`.
Файл `proxies.txt` додано в `.gitignore`, щоб не комітити приватні проксі.

Щоб цілитись у `30` одночасних запитів на проксі:

- `total_parallel_requests = selected_proxies * 30`
- для `20` проксі це `600`, отже ставте `PHOTO_FETCH_CONCURRENCY=600`

### Діагностичне логування

Додані ENV для глибшої діагностики таймаутів/помилок:

- `INGEST_PROGRESS_EVERY_ROWS` — крок progress-логів ingest.
- `PHOTO_PROGRESS_EVERY_LOTS` — крок progress-логів photo sync.
- `HTTP_LOG_SLOW_REQUEST_MS` — поріг "повільного" HTTP-запиту.
- `HTTP_LOG_RETRY_ATTEMPTS` — логувати retry/backoff/error по HTTP-маршрутах.

У логах тепер фіксується:

- `durationMs` для ingest/photo/pipeline/scheduler-job;
- `lotsPerMin`/`rowsPerSec`;
- retry/backoff, route (`direct` або конкретний proxy), timeout/error.

### Горизонтальне масштабування (воркери)

Підтримується шардінг воркерів через ENV:

- `PHOTO_WORKER_TOTAL` — скільки воркерів запускається паралельно.
- `PHOTO_WORKER_INDEX` — індекс конкретного воркера (`0..PHOTO_WORKER_TOTAL-1`).

Розподіл лотів: `MOD(lot_number, PHOTO_WORKER_TOTAL) = PHOTO_WORKER_INDEX`.

Приклад запуску 12 воркерів:

```bash
for i in $(seq 0 11); do
  PHOTO_WORKER_TOTAL=12 PHOTO_WORKER_INDEX=$i MYSQL_PORT=3307 npm run photo:sync &
done
wait
```

Важливо: на 1 IP масштабування має межу. Реальний тест (1000 лотів, 12 воркерів, `PHOTO_FETCH_CONCURRENCY=30`) не дав прискорення (`1 воркер: 582.86s`, `12 воркерів: 672s`), бо вузьке місце — мережеві retry/timeout на джерелі.
Для подальшого прискорення потрібні проксі + rate-limit на проксі.

### Практичний тюнінг по навантаженню

Якщо під час `photo:sync` бачите низьке серверне навантаження (наприклад, CPU ~12-15% і RAM < 1 GB на хості з 12 CPU / 15 GB), це означає, що система не впирається в CPU/RAM.

У такому випадку:

1. Піднімайте `PHOTO_FETCH_CONCURRENCY` поступово: `30 -> 50 -> 80`.
2. Після кожного кроку перевіряйте:
   - `timeout`, `429/403`, `404` rate;
   - час повного `photo:sync`;
   - latency/IOPS MySQL.
3. Якщо метрики стабільні, переходьте до 2+ воркерів.
4. Зупиняйте ріст паралелізму, якщо ростуть помилки або деградує MySQL.

Орієнтир безпечного масштабування: CPU < 70%, RAM < 70%, без різкого росту HTTP помилок.

## Стабільність (Roadmap)

Пріоритетні покращення для продакшен-стабільності:

1. `CSV` контроль якості:
   - зберігати биті рядки в окрему таблицю (`line/error/raw`);
   - пороги `max_invalid_rows`/`max_invalid_percent` з fail-run при перевищенні.
2. Фото-пайплайн:
   - кеш перевірок по `image_url_hash` (не перевіряти повторно незмінні `ok` URL);
   - зменшити DB-навантаження: логувати переважно `404/error`.
3. Proxy manager:
   - health-score, cooldown, blacklist нестабільних проксі;
   - ліміти одночасних запитів на 1 проксі.
4. Моніторинг/алерти:
   - метрики швидкості і якості (`rows/sec`, `invalid_rate`, `404_rate`, `run_duration`);
   - Telegram alert при аномаліях.
5. Retention/обслуговування:
   - автоочистка `photo_fetch_attempts`;
   - періодична перевірка індексів під великий обсяг.
6. Бізнес-логіка фінальної БД:
   - `missing/404` не показувати у фінальній видачі одразу;
   - у `copart_core` тримати для ретраїв до 30 днів, потім hard-delete.

## Ближчі кроки

1. Додати обмеження швидкості та батчовий контроль для фото-запитів по проксі-пулах.
2. Додати окремий retention-job для очищення старих `photo_fetch_attempts`.
3. Додати health endpoint і базові runtime метрики (uptime, last successful runs).
4. Додати правило для фінальної БД: лоти зі статусом `missing`/`404` прибирати з фінальної видачі одразу; у `copart_core` лишати для ретраїв і hard-delete після 30 днів.

## Додаткові необов'язкові оновлення

1. Runbook оновлення/деплою: `backup -> migrate -> ingest -> photo:sync -> verify -> rollback`.
2. Rollback policy: чіткі умови і кроки відкату після невдалого релізу або міграції.
3. Data quality gates: пороги `invalid CSV %` і контроль різких відхилень кількості лотів.
4. Guardrails від масових видалень: стоп-сценарії при аномально малому фіді.
5. SLA/SLO: цільовий час ранiв і допустимі рівні `missing/partial`.
6. Розширені моніторинг/алерти: пороги, канали, відповідальні за реакцію.
7. Incident playbooks: окремі сценарії для `масові 404`, `пошкоджений CSV`, `MySQL overload`, `proxy ban`.
8. Capacity matrix: рекомендації ресурсів для 1/2/4+ воркерів.
9. Backup/restore policy: частота бекапів, RPO/RTO, перевірка відновлення.
10. Retention policy для технічних таблиць: строки зберігання і авто-очистка.
11. Security/Secrets policy: зберігання і ротація `authKey`/proxy credentials.
12. ADR/change log: журнал ключових рішень по статусах, retry і видаленню.
