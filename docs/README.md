# Project Documentation

Цей файл ведеться як операційний журнал проєкту: що зроблено, що протестовано, які є ризики та що в роботі.

## Як оновлювати цей файл

- Після кожного завершеного кроку оновлювати секцію `Що готово`.
- Після кожного прогону/перевірки оновлювати `Що протестовано`.
- Якщо є падіння або нестабільність — додавати запис у `Інциденти`.
- Для нових задач оновлювати `Backlog`.

## Що готово

| Дата | Компонент | Статус | Коментар |
|---|---|---|---|
| 2026-03-10 | План реалізації в кореневому README | Done | Зафіксовано етапи 1-6 |
| 2026-03-10 | ENV-базис | Done | Додано `.env.example` зі змінними для всіх модулів |
| 2026-03-10 | Документаційний шаблон | Done | Створено цей файл для ведення стану проєкту |
| 2026-03-10 | Docker MySQL bootstrap | Done | Додано `docker-compose.yml` і init-скрипт для 2 БД |
| 2026-03-10 | SQL міграції | Done | Додано `sql/migrations/001_init.sql` |
| 2026-03-10 | CLI каркас сервісу | Done | Команди `db:migrate` і `ingest:csv` |
| 2026-03-10 | CSV ingest worker v1 | Done | Stream parse CSV + batched upsert + `ingest_runs` |
| 2026-03-10 | Smoke-test ingest on local CSV | Done | Перевірено upsert у `lots` і записи в `ingest_runs` |
| 2026-03-10 | Batch dedupe fix | Done | Дублікати `lot_number` в одному батчі не спотворюють статистику |
| 2026-03-10 | Photo sync worker | Done | Endpoint `lotImages`, image checks, upsert у `copart_media.lot_images` |
| 2026-03-10 | Retry/404 logic | Done | Backoff, `photo_404_count`, cleanup лотів після 30 днів 404 |
| 2026-03-10 | Scheduler | Done | Cron jobs для ingest і photo sync |
| 2026-03-10 | Telegram notifier | Done | Success/error повідомлення по основних джобах |
| 2026-03-10 | Proxy-ready HTTP client | Done | Режими `direct/proxy/mixed` для зовнішніх HTTP запитів |
| 2026-03-10 | Реальний endpoint-check | Done | Підтверджено `lotImages[].link[].url` як джерело фото |
| 2026-03-11 | Strict quality by sequence | Done | Статус `ok` тільки якщо для кожного `sequence` є повнорозмірне не-thumb фото |
| 2026-03-11 | Media storage quality filter | Done | У `lot_images` зберігаються лише якісні full-size фото (без `thumb`/`video`) |
| 2026-03-11 | Store all good photos + merge | Done | Зберігаються всі good URL; для `partial` good-дані не перетираються на тимчасових збоях |
| 2026-03-11 | Performance mode docs (proxy) | Done | Додано рекомендації по прискоренню `photo:sync` на великих обсягах |
| 2026-03-11 | Stability roadmap docs | Done | Зафіксовано пріоритети стабільності (CSV quality gate, cache checks, alerts, retention, proxy manager) |
| 2026-03-11 | Worker scaling docs | Done | Зафіксовано підхід: multi-worker + claim + proxy-aware паралелізація |
| 2026-03-11 | Runtime load tuning docs | Done | Додано практичні правила масштабування по фактичному CPU/RAM навантаженню |
| 2026-03-11 | Optional updates docs | Done | Додано список необов'язкових покращень (runbook, rollback, SLA/SLO, backup/restore, security) |
| 2026-03-12 | Multi-worker shard mode | Done | Додано `PHOTO_WORKER_TOTAL/PHOTO_WORKER_INDEX`, шардінг `MOD(CRC32(CAST(lot_number AS CHAR)), total)` і lock per worker |
| 2026-03-12 | Proxy preflight + manual check command | Done | Додано preflight перевірку проксі, авто-відбір top-N робочих і команду `proxy:check` |
| 2026-03-12 | Proxy list file support | Done | Додано `PROXY_LIST_FILE` + файл `proxies.txt` (1 проксі на рядок, `#` коментар) |
| 2026-03-12 | Dockerized app runtime | Done | Додано `Dockerfile`, `app` service у `docker-compose`, запуск scheduler у контейнері |
| 2026-03-12 | Ops command layer | Done | Додано `Makefile` (`up/down/migrate/ingest/photo-sync/proxy-check/db-reset/db-drop/clean-run`) |
| 2026-03-12 | Photo cluster command | Done | Додано `photo:cluster` для запуску N воркерів у 1 контейнері з shard-by-worker без дублювань |
| 2026-03-12 | Fast DB cleanup scripts | Done | Додано `scripts/db-reset.sh` (truncate) і `scripts/db-drop.sh` (drop/recreate) |
| 2026-03-12 | Reproducible fresh benchmark script | Done | Додано `scripts/fresh-test.sh` + `make fresh-test` (`db-drop -> migrate -> ingest -> photo:cluster -> SQL summary`) |
| 2026-03-12 | Auto proxy selection for photo cluster | Done | `photo:cluster` може взяти 1 реальний photo URL з БД, прогнати preflight по ньому і передати воркерам тільки top-N проксі |
| 2026-03-12 | HD-only + URL-hash cache + error-only attempts | Done | Фото-пайплайн перевіряє/зберігає тільки `hd`, пропускає повторний GET при cache-hit (`ok/full_size/url_hash`), у `photo_fetch_attempts` пишуться лише 404/error |
| 2026-03-13 | Snapshot-core + persistent-media selection | Done | `copart_core.lots` став snapshot поточного CSV, `copart_media` не чиститься, `photo:sync` бере тільки лоти без валідних фото в media |
| 2026-03-13 | Remove partial photo state | Done | Активна runtime-модель спрощена до `unknown -> ok/missing`, старий `partial` прибрано з робочої схеми |
| 2026-03-13 | Remove auto cleanup from media runtime | Done | Після `404` більше немає hard-delete/cleanup з `copart_media`; media використовується як persistent store фото |
| 2026-03-13 | Benchmark defaults aligned to server profile | Done | `fresh-test.sh` за замовчуванням: `1000 lots`, `12 workers`, `150 concurrency`, `top-300 proxies`, `min-working=250` |
| 2026-03-13 | Per-request proxy route cap | Done | Один HTTP-запит більше не перебирає весь пул; для benchmark дефолт `PROXY_MAX_ROUTES_PER_REQUEST=5` |
| 2026-03-12 | Extended diagnostics logging | Done | Логи duration/progress/retry/backoff/slow HTTP для кращої діагностики |
| 2026-03-12 | Production ingest lot limit by ENV | Done | Додано `INGEST_MAX_ROWS` для контролю кількості лотів з реального CSV без локальних файлів |
| 2026-03-12 | Redirect hardening | Done | Нормалізація `inventoryv2` в `https`, ручний fallback-follow `3xx`, preflight fallback `HEAD->GET` при помилці HEAD |

## Що протестовано

| Дата | Що перевіряли | Результат | Примітка |
|---|---|---|---|
| 2026-03-10 | Документаційні зміни | Passed | Структура додана, лінки валідні в рамках workspace |
| 2026-03-10 | `npm run build` | Passed | TypeScript компіляція успішна |
| 2026-03-10 | `node dist/index.js --help` | Passed | CLI команди відображаються коректно |
| 2026-03-10 | `docker compose up -d mysql` | Passed | MySQL 8.4 стартує, status `healthy` |
| 2026-03-10 | `MYSQL_PORT=3307 npm run db:migrate` | Passed | Міграція `001_init.sql` застосована |
| 2026-03-10 | `MYSQL_PORT=3307 CSV_LOCAL_FILE=... npm run ingest:csv` | Passed | 2 унікальні лоти в `copart_core.lots`, статистика ранiв коректна |
| 2026-03-10 | `MYSQL_PORT=3307 npm run photo:sync` | Passed | Фото записані в `copart_media.lot_images`, статуси лотів оновлені |
| 2026-03-10 | Реальний `lotImages` HTTP запит | Passed | Отримано JSON з `imgCount` і `lotImages` |
| 2026-03-10 | `MYSQL_PORT=3307 CSV_LOCAL_FILE=... npm run pipeline:run-once` | Passed | Оркестрація ingest + photo sync працює |
| 2026-03-11 | `npm run build` після змін sequence-логіки | Passed | Компіляція без помилок |
| 2026-03-11 | `MYSQL_PORT=3307 npm run photo:sync` (форс 1 лота) | Passed | `lotsScanned=1`, `lotsOk=1`, збережено всі доступні good URL для лота |
| 2026-03-11 | SQL-перевірка `copart_media.lot_images` | Passed | Для тестового лота тільки `is_full_size=1`, `check_status=ok`, без `thumb` |
| 2026-03-11 | `MYSQL_PORT=3307 npm run db:migrate` з `003_lot_images_store_all_good.sql` | Passed | Додано `url_hash`, унікальність `lot_number+sequence+url_hash` |
| 2026-03-11 | Ретеншн-тест good фото при фейлі endpoint | Passed | При форсованому фейлі лота `photo_status`->`missing`, але `lot_images` не очищується |
| 2026-03-11 | E2E smoke: reset DB + first 10 lots from source CSV | Passed | Ingest: `rows_inserted=10`; Photo sync: `lots_ok=5`, `lots_partial=5`, `images_upserted=115` |
| 2026-03-11 | Runtime snapshot during photo processing | Observed | CPU ~12-15% (12 vCPU), RAM ~0.7/15.2 GB: запас великий, можна піднімати concurrency поступово |
| 2026-03-12 | Benchmark 1000 lots, 1 worker (`PHOTO_FETCH_CONCURRENCY=30`) | Passed | `photo:sync real=582.86s` (~103 лоти/хв), `lots_ok=280`, `lots_partial=578`, `lots_missing=142` |
| 2026-03-12 | Benchmark 1000 lots, 12 workers, 1 IP (single build + `node dist`) | Observed | `wall=672s` (повільніше за 1 воркер), причина: мережеві retry/timeout і нерівномірний shard-розподіл |
| 2026-03-12 | `npm run proxy:check` (без PROXY_LIST) | Passed | Не падає в `direct` mode; команда готова для preflight на реальному пулі проксі |
| 2026-03-12 | `PROXY_LIST_FILE=... npm run proxy:check` | Passed | Проксі коректно читаються з файлу (рядок=проксі, `#`=коментар) |
| 2026-03-12 | `npm run build` після Docker/diagnostics змін | Passed | TypeScript компіляція без помилок |
| 2026-03-12 | `docker compose build app` | Passed | App image збирається успішно після Dockerfile змін |
| 2026-03-12 | `docker compose up -d mysql app` | Passed | `copart-mysql` + `copart-parser` стартують, scheduler лог присутній |
| 2026-03-12 | `make db-reset` | Passed | Швидке очищення runtime-таблиць працює |
| 2026-03-12 | `make db-drop && make migrate` | Passed | Повний drop/recreate і повторна міграція БД працюють |
| 2026-03-12 | `make proxy-check` | Passed | Команда керування з контейнера працює коректно |
| 2026-03-12 | `npm run build` після redirect hardening | Passed | TypeScript компіляція успішна |
| 2026-03-12 | `bash -n scripts/fresh-test.sh` | Passed | Синтаксис нового сценарію clean benchmark валідний |
| 2026-03-13 | `CSV_LOCAL_FILE=/tmp/copart_small_a.csv INGEST_MAX_ROWS=0 npm run ingest:csv` | Passed | Snapshot ingest зберіг тільки поточний CSV у core, media не чистилась |
| 2026-03-13 | `CSV_LOCAL_FILE=/tmp/copart_small_b.csv INGEST_MAX_ROWS=0 npm run ingest:csv` | Passed | Другий snapshot prune прибрав відсутній лот тільки з core; media лишилась без cleanup |
| 2026-03-13 | Isolated verify DB scenario (`copart_core_verify` / `copart_media_verify`) | Passed | Після seed одного media-лота кандидатом лишився тільки лот без фото; після нового CSV core став snapshot, media зберегла старий лот |

## В роботі

| Задача | Пріоритет | Власник | Статус |
|---|---|---|---|
| Фінальна БД без `missing` лотів | High | TBD | Planned |
| CSV quality gate (`max_invalid_%`) | High | TBD | Planned |
| Кеш перевірок фото по URL hash | High | TBD | Planned |
| Alerting по аномаліях (invalid/404/duration) | High | TBD | Planned |
| Claim-based balancing для multi-worker | High | TBD | Planned |
| Health/metrics endpoint | Medium | TBD | Planned |
| Retention policy для `photo_fetch_attempts` | Medium | TBD | Planned |
| Proxy pool health tracking | Medium | TBD | Planned |

## Backlog

- Бізнес-правило аукціону: при `404` прибирати лот з фінальної БД одразу, але залишати в `copart_core` для ретраїв; hard-delete через 30 днів безуспішних перевірок.
- Зберігати биті CSV-рядки в окрему таблицю для повторного аналізу.
- Логувати в `photo_fetch_attempts` тільки помилки (`404/error`) або робити sampling для success.
- Додати concurrency guard на 1 проксі (щоб не спалювати весь пул).
- Замінити MOD-sharding на `claim`-бронювання пачок (кращий баланс навантаження між воркерами).
- Дедуплікація фото і контроль змін URL.
- Стратегія перевірки `HEAD` + fallback на частковий `GET`.
- Агреговані щоденні Telegram звіти.
- Метрики продуктивності для великих обсягів (200k+ / 2M+).

## Додаткові необов'язкові оновлення

- Runbook оновлення/деплою з чітким порядком дій та перевірок.
- Rollback policy і критерії аварійного відкату.
- Data quality guardrails для аномалій у CSV/обсягах.
- Захист від масових хибних видалень при аномальному фіді.
- Формалізація SLA/SLO для `ingest` і `photo:sync`.
- Розширені incident playbooks по ключових типах збоїв.
- Capacity matrix для різної кількості воркерів.
- Backup/restore policy з перевіркою відновлення.
- Політика retention для технічних таблиць.
- Security/Secrets policy (зберігання/ротація ключів).
- ADR/change-log для критичних архітектурних рішень.

## Інциденти

| Дата | Severity | Симптом | Причина | Дія |
|---|---|---|---|---|
| - | - | - | - | - |

## Рішення / ADR (коротко)

| Дата | Рішення | Чому |
|---|---|---|
| 2026-03-10 | Конфігурація тільки через ENV | Спрощує деплой, тестування та перемикання режимів (proxy/direct) |
| 2026-03-10 | Окремий doc-файл для статусу | Прозоре ведення готовності та тестів |
| 2026-03-10 | CSV зберігається як нормалізовані поля лота + `row_hash` | Дає швидке визначення змін і менший обсяг core-таблиці |
