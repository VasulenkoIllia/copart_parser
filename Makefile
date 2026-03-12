SHELL := /bin/bash

.PHONY: up down build rebuild ps logs logs-app logs-db scheduler \
	migrate ingest photo-sync pipeline proxy-check \
	db-reset db-drop db-shell clean-run

up:
	docker compose up -d mysql app

down:
	docker compose down

build:
	docker compose build app

rebuild:
	docker compose build --no-cache app

ps:
	docker compose ps

logs:
	docker compose logs -f app mysql

logs-app:
	docker compose logs -f app

logs-db:
	docker compose logs -f mysql

scheduler:
	docker compose up -d app

migrate:
	docker compose run --rm app node dist/index.js db:migrate

ingest:
	docker compose run --rm app node dist/index.js ingest:csv

photo-sync:
	docker compose run --rm app node dist/index.js photo:sync

pipeline:
	docker compose run --rm app node dist/index.js pipeline:run-once

proxy-check:
	docker compose run --rm app node dist/index.js proxy:check

db-reset:
	./scripts/db-reset.sh

db-drop:
	./scripts/db-drop.sh

db-shell:
	docker compose exec mysql mysql -uroot -p$$MYSQL_ROOT_PASSWORD

clean-run: db-reset ingest photo-sync
