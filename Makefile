.PHONY: help up down restart ps logs setup cli monitor debrid debrid-url cron-linux cron-windows

help:
	@echo "Kimberly Docker helpers"
	@echo
	@echo "Usage: make <target>"
	@echo
	@echo "Core:"
	@echo "  up           -> docker compose up -d"
	@echo "  down         -> docker compose down"
	@echo "  ps           -> docker compose ps"
	@echo "  logs         -> docker compose logs -f --tail=200"
	@echo
	@echo "Wizard / runs:"
	@echo "  setup        -> docker compose run --rm crawler-setup"
	@echo "  cli          -> docker compose run --rm crawler-cli"
	@echo "  monitor      -> docker compose run --rm crawler-monitor"
	@echo "  debrid       -> docker compose run --rm crawler-cli node src/bin/debrid-cli.js"
	@echo "  debrid-url   -> make debrid-url URL=\"https://boxd.it/xxxx\""
	@echo
	@echo "Cron scripts (inside docker):"
	@echo "  cron-linux   -> docker compose run --rm crawler-cli npm run cron:linux"
	@echo "  cron-windows -> docker compose run --rm crawler-cli npm run cron:windows"

up:
	docker compose up -d

down:
	docker compose down

restart: down up

ps:
	docker compose ps

logs:
	docker compose logs -f --tail=200

setup:
	docker compose run --rm crawler-setup

cli:
	docker compose run --rm crawler-cli

monitor:
	docker compose run --rm crawler-monitor

debrid:
	docker compose run --rm crawler-cli node src/bin/debrid-cli.js

debrid-url:
	@if [ -z "$(URL)" ]; then echo "Missing URL. Example: make debrid-url URL=\"https://boxd.it/xxxx\""; exit 2; fi
	docker compose run --rm crawler-cli node src/bin/debrid-cli.js "$(URL)"

cron-linux:
	docker compose run --rm crawler-cli npm run cron:linux

cron-windows:
	docker compose run --rm crawler-cli npm run cron:windows
