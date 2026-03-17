# Photo Update Test Cases

Цей документ описує локальний матричний набір кейсів для перевірки логіки оновлення фото.

## Мета

- Лоти зі вже наявними валідними `hd` фото не повинні запускати повторний photo-fetch.
- Нові лоти повинні проходити photo-stage і створювати/оновлювати записи в media.
- Кожен run має логуватись у консоль + перевірятись SQL-перевірками.

## Як запускати

```bash
npm run test:photo-update
```

Керування через ENV:

- `PHOTO_TEST_DB_PREPARE=drop|reset|none` (default: `drop`)
- `PHOTO_TEST_CASE_TOTALS=10,15` (матриця total-size)
- `PHOTO_TEST_OLD_POOL_SIZE=100`
- `PHOTO_TEST_SOURCE_FILE=/path/to/local.csv` (опційно, щоб не качати remote)
- `PHOTO_TEST_HTTP_MODE=direct|proxy|mixed`

## Discovery seed

Перед матрицею виконується discovery seed:

1. Беруться перші `PHOTO_TEST_OLD_POOL_SIZE` лотів.
2. Запускається `ingest:csv` + `photo:sync`.
3. У `old`-пул потрапляють тільки лоти, для яких уже є `hd + full-size` у `copart_media.lot_images`.

Ця фаза потрібна лише для побудови стабільного пулу `old`-лотів, які реально мають валідні `hd` фото.

## Ізоляція кейсів

Після появи негайного orphan-cleanup у `copart_media.lot_images` кейси більше не можуть ділити один runtime-state між собою, бо media старих лотів видаляється разом із prune з core.

Тому тепер кожен кейс виконується ізольовано:

1. Робиться `db:reset`.
2. Якщо `old > 0`, проганяється baseline CSV тільки з `old`-лотами.
3. Для baseline запускається `ingest:csv` + `photo:sync`, щоб відтворити стан "лот уже має валідні hd фото".
4. Лише після цього запускається основний CSV кейсу `old + new`.

## Матриця кейсів (default)

Для `PHOTO_TEST_CASE_TOTALS=10,15` генеруються всі split-комбінації `old/new`:

### Total = 10

1. `old=0, new=10`
2. `old=1, new=9`
3. `old=2, new=8`
4. `old=3, new=7`
5. `old=4, new=6`
6. `old=5, new=5`
7. `old=6, new=4`
8. `old=7, new=3`
9. `old=8, new=2`
10. `old=9, new=1`
11. `old=10, new=0`

### Total = 15

1. `old=0, new=15`
2. `old=1, new=14`
3. `old=2, new=13`
4. `old=3, new=12`
5. `old=4, new=11`
6. `old=5, new=10`
7. `old=6, new=9`
8. `old=7, new=8`
9. `old=8, new=7`
10. `old=9, new=6`
11. `old=10, new=5`
12. `old=11, new=4`
13. `old=12, new=3`
14. `old=13, new=2`
15. `old=14, new=1`
16. `old=15, new=0`

## Що перевіряється в кожному кейсі

Перед `photo:sync`:

- `oldDueBefore`: кількість old-лотів, що ще кандидати у photo stage.
- `newDueBefore`: кількість new-лотів, що кандидати у photo stage.

Після `photo:sync`:

- `oldTouched`: скільки old-лотів реально торкнувся photo stage.
- `oldAttempts`: кількість error/404 attempts для old-лотів у вікні цього run.
- `newTouched`, `newAttempts`: аналогічно для new.
- `oldMediaBefore/After`, `newMediaBefore/After`: приріст валідного `hd` в media.
- baseline також перевіряє, що всі `old`-лоти справді відновили `hd` перед основним run.

## Критерії PASS/FAIL

Кейс = `PASS`, якщо:

1. `oldDueBefore == 0` і `oldTouched == 0` (старі лоти з фото не перезапитуються).
2. Якщо `newDueBefore > 0`, тоді є ознаки обробки new-лотів:
   - `newTouched > 0` або
   - `newAttempts > 0` або
   - `newMediaAfter > newMediaBefore`.

Інакше кейс = `FAIL`.
