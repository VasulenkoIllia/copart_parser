# Copart Parser

Сервіс для стабільного імпорту CSV з Copart, оновлення лотів у MySQL, парсингу фото-URL у другу БД, перевірки якості зображень, ретраїв 404 та операційного моніторингу через Telegram.

## Цілі

- Кожні 5 годин отримувати новий CSV-файл з лотами.
- Оновлювати або створювати записи в основній БД лотів.
- Тримати `copart_core.lots` як актуальний snapshot CSV (видаляти лоти, яких більше немає у фіді).
- Окремо зберігати посилання на фото у другій БД.
- Підтримувати режими роботи через проксі і без проксі.
- Коректно обробляти 404 та повторні спроби.
- Відмічати лоти без валідних фото для повторної обробки.

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
docker compose build app
docker compose up -d mysql app
docker compose run --rm app node dist/index.js db:migrate
```

Базові команди:

- `docker compose ps` — стан контейнерів.
- `docker compose logs -f app` — live логи сервісу.
- `docker compose logs -f mysql` — live логи MySQL.
- `docker compose run --rm app node dist/index.js ingest:csv` — запуск ingest в контейнері.
- `docker compose run --rm app node dist/index.js photo:sync` — запуск photo-sync в контейнері.
- `docker compose run --rm app node dist/index.js pipeline:run-once` — одноразовий повний цикл.
- `docker compose run --rm app node dist/index.js retention:cleanup` — ручний retention/housekeeping.
- `docker compose run --rm app node dist/index.js proxy:check` — перевірка проксі-пулу.
- `./scripts/fresh-test.sh` — повний чистий тестовий цикл (`db-drop -> migrate -> ingest(1000) -> photo:cluster -> SQL summary`).

## Автоматичний режим

Для бойового автооновлення кожні 5 годин:

1. Заповнити `.env`:

```bash
INGEST_CRON=0 0,5,10,15,20 * * *
PHOTO_RETRY_CRON=*/30 * * * *
SCHEDULER_RUN_ON_START=true

RETENTION_ENABLED=true
RETENTION_CRON=30 3 * * *
RETENTION_BATCH_SIZE=5000
RETENTION_PRUNE_ORPHAN_LOT_IMAGES=true
RETENTION_PHOTO_FETCH_ATTEMPTS_DAYS=30
RETENTION_INVALID_CSV_ROWS_DAYS=30
RETENTION_INGEST_RUNS_DAYS=45
RETENTION_PHOTO_RUNS_DAYS=45
RETENTION_PHOTO_CLUSTER_RUNS_DAYS=45

HTTP_MODE=proxy
PROXY_LIST_FILE=./proxies.txt
PROXY_AUTO_SELECT_FOR_PHOTO=true
PROXY_MAX_ROUTES_PER_REQUEST=5
PROXY_PREFLIGHT_TOP_N=300
PROXY_PREFLIGHT_MIN_WORKING=250

PHOTO_WORKER_TOTAL=12
PHOTO_FETCH_CONCURRENCY=150
PHOTO_PROGRESS_EVERY_LOTS=10
PHOTO_VALIDATE_BY_HEAD_FIRST=false
PHOTO_ENDPOINT_RETRIES=1
PHOTO_IMAGE_RETRIES=1
MYSQL_POOL_MAX=10

TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
TELEGRAM_SEND_SUCCESS_SUMMARY=true
TELEGRAM_SEND_ERROR_ALERTS=true
```

2. Застосувати міграції і запустити scheduler:

```bash
docker compose build app
docker compose run --rm app node dist/index.js db:migrate
docker compose up -d mysql app
```

Якщо `PHOTO_WORKER_TOTAL > 1`, scheduler тепер запускає повний pipeline як `ingest + photo:cluster`, а не одиночний `photo:sync`.

Після кожного успішного циклу в Telegram приходить один зведений summary:

- скільки лотів було в новому CSV;
- скільки було нових / updated / unchanged;
- скільки фото-посилань було опрацьовано;
- скільки лотів віддали `endpoint 404`;
- скільки лотів `ok/missing`;
- скільки фото було збережено;
- яка конфігураційна паралельність photo-stage (`workers * fetchConcurrency`);
- час `ingest`, час `photo`, загальний час оновлення.
- якщо є проблемні дані, додатково прикріплюється CSV `http_404` (усі HTTP `404` за поточний photo-run).

Для окремих retry-ранів (`PHOTO_RETRY_CRON`) в Telegram приходить окремий звіт з:

- метриками обробки retry-лотів;
- stage-міткою (`inventory_retry`) і стратегією endpoint (`inventoryv2_only`);
- `lots_without_any_photos_total` + розбивкою `missing_due_now / missing_due_future / unknown / ok_without_media`;
- CSV `lots_without_any_photos` (вже з колонками `photo_status`, `photo_404_count`, `next_photo_retry_at`, `last_seen_at`, `retry_state`);
- `endpoint_issues_total` (+ `429/403/404`, `inventory`) + CSV `endpoint_issues` за поточне вікно run.

Помилки retry-задач (`PHOTO_SYNC`) також відправляються в Telegram як error alert.

Команди для "чистого" запуску:

- `npm run db:reset` — швидке очищення runtime-таблиць (дані лотів/фото/рани).
- `npm run db:drop` — повний drop/recreate двох БД.
- `npm run ingest:csv && npm run photo:sync` — локальний clean-run без `make`.
- `./scripts/fresh-test.sh` — рекомендований відтворюваний бенч з нуля.

## Команди

- `npm run build` — компіляція TypeScript.
- `npm run db:migrate` — створення/оновлення схем і таблиць.
- `npm run ingest:csv` — стрімінговий імпорт CSV з upsert у `copart_core.lots`.
- `CSV_LOCAL_FILE=/path/file.csv npm run ingest:csv` — локальне тестування інжесту.
- `npm run photo:sync` — парсинг `lotImages`, перевірка фото, оновлення `copart_media`.
- `npm run proxy:check` — preflight перевірка проксі, відбір робочих і оцінка місткості.
- `npm run pipeline:run-once` — повний цикл: ingest + photo sync.
- `npm run scheduler:start` — планувальник (кожні 5 годин запускає повний pipeline ingest+photo; `PHOTO_RETRY_CRON` і `RETENTION_CRON` опційні).
- `npm run retention:cleanup` — ручний запуск retention/housekeeping.
- `npm run db:reset` — швидке очищення runtime-таблиць через Docker MySQL.
- `npm run db:drop` — повний drop/recreate двох БД через Docker MySQL.
- `./scripts/fresh-test.sh` — один командний сценарій чистого тесту з підсумковими SQL-метриками.
- `npm run test:photo-update` — локальний матричний тест-кейсер для перевірки photo update логіки (old/new/mix CSV + SQL-валидація після кожного run).

Швидкий стабільний старт з нуля (рекомендовано для бенчів):

```bash
./scripts/fresh-test.sh
```

`scripts/fresh-test.sh` за замовчуванням використовує benchmark-профіль:

- `INGEST_MAX_ROWS=1000`
- `PHOTO_WORKER_TOTAL=12`
- `PHOTO_FETCH_CONCURRENCY=150`
- `PHOTO_PROGRESS_EVERY_LOTS=10`
- `PROXY_AUTO_SELECT_FOR_PHOTO=true`
- `PROXY_MAX_ROUTES_PER_REQUEST=5`
- `PROXY_PREFLIGHT_TOP_N=300`
- `PROXY_PREFLIGHT_MIN_WORKING=250`
- `PHOTO_VALIDATE_BY_HEAD_FIRST=false`

Налаштування прогону через ENV (приклад):

```bash
INGEST_MAX_ROWS=1000 PHOTO_WORKER_TOTAL=12 PHOTO_FETCH_CONCURRENCY=150 PROXY_PREFLIGHT_TOP_N=300 PROXY_PREFLIGHT_MIN_WORKING=250 ./scripts/fresh-test.sh
```

## Локальний тест photo update (old/new/mix)

Для перевірки, що:

- лоти з уже наявними `hd` фото не йдуть у повторні photo-запити;
- нові лоти навпаки потрапляють у photo-обробку;
- усе логувалося в консоль по кожному run + перевірялось SQL-запитами;

використовуйте матричний раннер:

```bash
npm run test:photo-update
```

Скрипт:

1. Берe реальний CSV (або локальний через `PHOTO_TEST_SOURCE_FILE`).
2. Формує seed на 100 лотів.
3. Робить seed-run (`ingest + photo:sync`) для наповнення media.
4. Генерує матрицю кейсів `old/new` (за замовчуванням totals: `10,15`, тобто всі split-комбінації).
5. Для кожного кейсу запускає `ingest + photo:sync`, потім робить SQL-валидацію:
   - `oldDueBefore`, `oldTouched`, `oldAttempts`;
   - `newDueBefore`, `newTouched`, `newAttempts`;
   - приріст валідних `hd` у media.

Повний список кейсів і правила PASS/FAIL: [docs/photo-update-test-cases.md](docs/photo-update-test-cases.md).

Основні ENV для раннера:

- `PHOTO_TEST_DB_PREPARE=drop|reset|none` (default: `drop`).
- `PHOTO_TEST_CASE_TOTALS=10,15` (матриця totals).
- `PHOTO_TEST_OLD_POOL_SIZE=100` (розмір old seed).
- `PHOTO_TEST_SOURCE_FILE=/path/to/file.csv` (щоб не качати remote CSV).
- `PHOTO_TEST_HTTP_MODE=direct|proxy|mixed` (режим для photo stage).

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

Важливо: статус якості в системі рахується не лише по флагах. Ми робимо фактичну перевірку `width/height` і `content-length` (пороги з ENV), тому рішення про `ok/missing` базується на реальному розмірі фото.

## План реалізації (зафіксований)

### Етап 1. База і інфраструктура

- [x] Підняти MySQL у Docker для локальної розробки.
- [x] Створити 2 схеми: `copart_core` (лоти) і `copart_media` (фото).
- [x] Описати міграції і базові індекси під масові upsert.
- [x] Додати таблиці запусків (`ingest_runs`, `photo_runs`) для аудиту.

### Етап 2. Імпорт CSV (200k+ рядків)

- [x] Стрімінгове читання CSV (без завантаження всього файлу в RAM).
- [x] Батчевий `INSERT ... ON DUPLICATE KEY UPDATE` тільки для нових/змінених рядків.
- [x] Обчислення `row_hash` для виявлення реальних змін.
- [x] Збереження повного CSV-пейлоаду в `lots.csv_payload`.
- [x] Stage-таблиця `ingest_lot_stage` для prune по актуальному CSV snapshot.

### Етап 3. Обробка фото (2M+ URL)

- [x] Витягувати `lotImages` з `imageurl` по кожному лоту.
- [x] Валідувати фото за типом, роздільною здатністю і розміром.
- [x] Зберігати у `copart_media.lot_images` всі валідні full-size фото (без `thumb`/`video`), унікально по `sequence+url`.
- [x] Виставляти статус лота: `ok` / `missing`.

### Етап 4. 404 / ретраї / очищення

- [x] Логувати 404/помилки у таблицю спроб.
- [x] Експоненційний backoff для повторних запитів.
- [x] Повторно перевіряти лоти без валідних фото.

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
  - якщо існує — оновити змінені поля + `csv_payload`;
  - якщо не змінювався (`row_hash` і `csv_payload` однакові) — пропустити важкі операції.
- Відомі поля CSV пишуться окремими колонками у `copart_core.lots` з нормалізованими snake_case іменами; поля, що вже покриті core-колонками (`lot_number`, `yard_number`), окремо не дублюються. Невідомі заголовки для безпеки падають у `csv_<snake_case>`, щоб не конфліктувати з службовими колонками.
- Після завершення ingest:
  - видалити з `copart_core.lots` лоти, яких не було в поточному CSV (`NOT EXISTS` у `ingest_lot_stage`);
- Для нових лотів ingest може виставити `photo_status=ok`, якщо в `copart_media.lot_images` уже є валідні `hd + full-size` фото.

### Фото

- Парсити URL з endpoint `lotImages`: пріоритет tier-ів `full` -> `hd` -> `other`.
- У `copart_media.lot_images` зберігати тільки якісні full-size фото.
- `thumb`/`video` ігноруються.
- Додано кеш перевірки по `url_hash`: якщо URL уже був `ok + full_size`, повторний `GET` пропускається.
- У `photo_fetch_attempts` логуються тільки `404` і помилки (`error`/non-2xx), успішні `2xx/206` більше не засмічують таблицю.
- `check_status = ok`,
- `is_full_size = 1`,
- без `thumb`/`video`,
- всі унікальні good URL (накопичення між прогонами).
- Запис фото працює в merge-режимі: вже знайдені good фото не видаляються при повторних прогонах.
- Всі спроби запитів і помилки зберігати в `copart_media.photo_fetch_attempts`.
- Кандидати на `photo:sync` визначаються так: лот є в актуальному `copart_core.lots`, але для нього ще немає жодного валідного `full-size` фото (`variant in ('hd','full','unknown')`) у `copart_media.lot_images`.

### Правило "повні фото"

Лот вважається `photo_ok`, якщо:

- у `copart_media.lot_images` є хоча б одне фото з `check_status = ok`;
- це фото має `variant in ('hd', 'full', 'unknown')` і `is_full_size = 1`;
- фото пройшло поріг якості за мінімальною шириною (`PHOTO_MIN_WIDTH`).

Якщо валідних `full-size` фото ще немає, лот залишається кандидатом на повторну перевірку.

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
- `PROXY_MAX_ROUTES_PER_REQUEST=1..2`, щоб один логічний запит не пробував багато маршрутів поспіль і не створював burst.
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
- `PROXY_MAX_ROUTES_PER_REQUEST=5` — скільки top-проксі максимум пробує один HTTP-запит, щоб не було довгих "хвостів" на 300 послідовних proxy-route.

Автовідбір проксі під фото (рекомендовано для швидкості):

- `PROXY_AUTO_SELECT_FOR_PHOTO=true` — у `photo:cluster` перед стартом воркерів береться 1 реальний URL фото з БД і preflight виконується саме по ньому.
- `PROXY_AUTO_SELECT_PROBE_LOTS=20` — скільки останніх лотів перевіряти, щоб знайти валідний URL фото для benchmark.
- Рекомендований розмір робочого пулу: `PROXY_PREFLIGHT_TOP_N=250..350` (зазвичай найкращий баланс швидкості/стабільності).
- Для server benchmark-профілю в `fresh-test.sh` зафіксовано дефолт: `PROXY_PREFLIGHT_TOP_N=300`, `PROXY_PREFLIGHT_MIN_WORKING=250`, `PROXY_MAX_ROUTES_PER_REQUEST=5`.
- Після автовідбору воркери отримують тільки selected pool і працюють без повторного preflight.

Ручна перевірка пулу:

```bash
npm run proxy:check
```

У логах буде `configured`, `healthy`, `selected` і `capacityAt30PerProxy`.
Файл `proxies.txt` додано в `.gitignore`, щоб не комітити приватні проксі.
Невалідні рядки проксі не падають весь процес: вони пропускаються з WARN-логом `Invalid proxies skipped`.

### Обробка редіректів (важливо)

- URL `inventoryv2.copart.io` нормалізується перед `photo:sync`: у `direct` режимі використовується `https://`, у `proxy/mixed` — `http://` (щоб уникати `socket hang up` на частині HTTP-проксі при прямому HTTPS CONNECT).
- Для `lotImages` автоматично добудовуються обов'язкові query-параметри, якщо їх немає в CSV URL: `country=us`, `brand=cprt`, `yardNumber` (з лота, fallback `1`).
- HTTP-клієнт має fallback ручного проходження `3xx + location`, якщо провайдер/проксі віддав редірект без фінального `2xx`.
- `proxy preflight` робить fallback `HEAD -> GET` навіть коли `HEAD` падає по мережевій помилці (а не тільки при `405`), і для `https://inventoryv2...` додатково перевіряє `http://inventoryv2...`.

Підтримувані формати рядка проксі:

- `http://host:port`
- `https://host:port`
- `http://user:pass@host:port`
- `https://user:pass@host:port`
- `host:port`
- `user:pass@host:port`
- `host:port:user:pass`

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

Розподіл лотів: `MOD(CRC32(CAST(lot_number AS CHAR)), PHOTO_WORKER_TOTAL) = PHOTO_WORKER_INDEX`.

Приклад запуску 12 воркерів:

```bash
for i in $(seq 0 11); do
  PHOTO_WORKER_TOTAL=12 PHOTO_WORKER_INDEX=$i MYSQL_PORT=3307 npm run photo:sync &
done
wait
```

Запуск у **1 контейнері** (керування воркерами всередині застосунку):

```bash
docker compose run --rm \
  -e PHOTO_WORKER_TOTAL=12 \
  -e PHOTO_FETCH_CONCURRENCY=150 \
  -e PROXY_AUTO_SELECT_FOR_PHOTO=true \
  -e PROXY_MAX_ROUTES_PER_REQUEST=5 \
  -e PROXY_PREFLIGHT_TOP_N=300 \
  -e PROXY_PREFLIGHT_MIN_WORKING=250 \
  app node dist/index.js photo:cluster
```

Гарантія без дублювання лотів між воркерами:

- кожен воркер читає свій shard: `MOD(CRC32(CAST(lot_number AS CHAR)), PHOTO_WORKER_TOTAL) = PHOTO_WORKER_INDEX`;
- один і той самий `lot_number` не потрапляє в 2 воркери в одному прогоні;
- lock також розділений по воркеру: `photo_sync_worker_<index>`.

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

### Тест-режим для цілі 1000 лотів/хв

Базовий контрольний прогін (без локальних CSV-файлів, тільки бойовий URL):

```bash
# 1) Завантажити в core перші 1000 лотів
docker compose run --rm \
  -e HTTP_MODE=direct \
  -e INGEST_MAX_ROWS=1000 \
  app node dist/index.js ingest:csv

# 2) Прогнати фото на ці 1000 лотів (приклад стартових параметрів)
docker compose run --rm \
  -e HTTP_MODE=proxy \
  -e PROXY_LIST_FILE=./proxies.txt \
  -e PROXY_PREFLIGHT_TOP_N=20 \
  -e PHOTO_BATCH_SIZE=1000 \
  -e PHOTO_FETCH_CONCURRENCY=600 \
  -e PHOTO_LOG_LOT_RESULTS=false \
  app node dist/index.js photo:sync
```

Швидкість дивитись по фінальному логу `Photo sync finished`:

- `lotsPerMin` — цільовий KPI.
- `http404Count`, `lotsMissing`, `imagesPerMin` — контроль якості джерела/мережі.

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
   - автоочистка технічних таблиць (`photo_fetch_attempts`, `invalid_csv_rows`, історія run'ів);
   - orphan-cleanup у `copart_media.lot_images` (для лотів, яких вже немає в `copart_core.lots`);
   - періодична перевірка індексів під великий обсяг.
6. Бізнес-логіка фінальної БД:
   - `missing/404` не показувати у фінальній видачі одразу;
   - у `copart_core` тримати для ретраїв до 30 днів, потім hard-delete.

## Ближчі кроки

1. Додати обмеження швидкості та батчовий контроль для фото-запитів по проксі-пулах.
2. Налаштувати retention-періоди під ваш прод-обсяг і SLA.
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
