SHELL := /bin/bash
COMPOSE := docker compose

.PHONY: deploy test logs public domain reset-db

deploy: ## обновить код и пересобрать
	git pull
	$(COMPOSE) up -d --build app caddy

test: ## автотесты в образе, без платных вызовов
	docker build -t pomnu-app .
	docker run --rm -e MOCK=1 pomnu-app python -m unittest discover -s tests

logs:
	$(COMPOSE) logs -f --tail=100

public: ## поднять всё вместе с туннелем и показать адрес
	$(COMPOSE) --profile public up -d --build
	@echo "Жду адрес туннеля…"
	@for i in $$(seq 1 30); do \
	  url=$$($(COMPOSE) logs tunnel 2>&1 | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1); \
	  if [ -n "$$url" ]; then echo "$$url"; exit 0; fi; sleep 2; \
	done; echo "Адрес не появился, смотрите: $(COMPOSE) logs tunnel"; exit 1

domain: ## поднять всё с именованным туннелем на своём домене (нужен TUNNEL_TOKEN в .env)
	@grep -q '^TUNNEL_TOKEN=.\+' .env || { echo "Задайте TUNNEL_TOKEN в .env (токен туннеля Cloudflare)"; exit 1; }
	$(COMPOSE) --profile domain up -d --build

reset-db: ## удалить БД и записи (том pomnu-data)
	@read -p "Удалить ВСЕ истории, записи и фото? Введите yes: " ans; \
	if [ "$$ans" != "yes" ]; then echo "Отменено"; exit 1; fi
	$(COMPOSE) --profile public down
	docker volume rm pomnu-data
	@echo "Готово. Данные пересоздаются из seed.json при следующем запуске (make deploy)."
