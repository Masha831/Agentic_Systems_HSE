SHELL := /bin/bash
COMPOSE := docker compose
# Тег образа = короткий хэш коммита. Текущий и предыдущий релизы записаны в .release-current / .release-previous
SHA = $(shell git rev-parse --short HEAD)
CUR = $(shell cat .release-current 2>/dev/null || echo latest)
VOL = pomnu-data
STG = APP_PORT=8001 CADDY_PORT=8081 DATA_VOLUME=pomnu-staging-data IMAGE_TAG=$(SHA) $(COMPOSE) -p pomnu-staging

.PHONY: deploy release rollback releases build-release provider backup restore smoke staging staging-down test logs public domain reset-db

deploy: ## обновить код → образ pomnu-app:<sha> → бэкап → запуск → проверка; при провале сам откатывается
	git pull --ff-only
	@# отдельный make: SHA должен считаться уже после git pull
	$(MAKE) release

release: ## выкатить текущий коммит без git pull (то же, что deploy)
	IMAGE_TAG=$(SHA) $(COMPOSE) build app
	@# первый деплой по-новому: то, что крутилось до него, сохраняем как pomnu-app:before-rollback-setup
	@if [ ! -f .release-current ] && docker image inspect pomnu-app:latest >/dev/null 2>&1; then \
	  docker tag pomnu-app:latest pomnu-app:before-rollback-setup && echo before-rollback-setup > .release-current; fi
	$(MAKE) backup
	@[ "$$(cat .release-current 2>/dev/null)" = "$(SHA)" ] || cp -f .release-current .release-previous 2>/dev/null || true
	@echo $(SHA) > .release-current
	IMAGE_TAG=$(SHA) $(COMPOSE) up -d --no-build --wait app caddy || { $(MAKE) rollback; exit 1; }
	$(MAKE) smoke || { echo "Проверка не прошла — откатываюсь"; $(MAKE) rollback; exit 1; }
	docker tag pomnu-app:$(SHA) pomnu-app:latest
	@echo "Релиз $(SHA) работает. Откат: make rollback"

rollback: ## make rollback [TO=<sha|тег>] — по умолчанию предыдущий релиз; образ не пересобирается
	@to=$${TO:-$$(cat .release-previous 2>/dev/null)}; \
	[ -n "$$to" ] || { echo "Не знаю предыдущий релиз. Укажите TO=..., список: make releases"; exit 1; }; \
	docker image inspect pomnu-app:$$to >/dev/null 2>&1 || { echo "Нет образа pomnu-app:$$to (make releases; для тега git: make build-release TO=$$to)"; exit 1; }; \
	cur=$$(cat .release-current 2>/dev/null); \
	IMAGE_TAG=$$to $(COMPOSE) up -d --no-build --wait app && docker tag pomnu-app:$$to pomnu-app:latest && \
	{ [ "$$cur" = "$$to" ] || echo $$cur > .release-previous; echo $$to > .release-current; echo "Откат на $$to. Вернуться: make rollback"; }

releases: ## какие образы есть для отката
	@docker images pomnu-app --format '{{.Tag}}\t{{.CreatedSince}}'
	@echo "сейчас: $(CUR)   предыдущий: $$(cat .release-previous 2>/dev/null || echo —)"

build-release: ## make build-release TO=v0.2-docker — собрать образ из тега git, не трогая рабочую копию
	@test -n "$(TO)" || { echo "Укажите TO=<тег или коммит>"; exit 1; }
	git fetch --tags
	rm -rf /tmp/pomnu-$(TO) && git worktree add --detach /tmp/pomnu-$(TO) $(TO)
	docker build --build-arg GIT_SHA=$(TO) -t pomnu-app:$(TO) /tmp/pomnu-$(TO); s=$$?; git worktree remove --force /tmp/pomnu-$(TO); exit $$s

provider: ## откат конфигом: make provider P=yandex (LLM, STT, TTS на Яндекс) | P=auto (как в .env.example)
	@case "$(P)" in yandex) v=yandex;; auto) v=;; *) echo "P=yandex или P=auto"; exit 1;; esac; \
	touch .env; for k in LLM_PROVIDER STT_PROVIDER TTS_PROVIDER; do \
	  if grep -q "^$$k=" .env; then sed -i "s/^$$k=.*/$$k=$$v/" .env; else echo "$$k=$$v" >> .env; fi; done
	@# restart не перечитывает .env — только пересоздание контейнера
	IMAGE_TAG=$(CUR) $(COMPOSE) up -d --no-build --force-recreate --wait app
	$(MAKE) smoke

backup: ## снимок БД и медиа в ./backups (хранятся 10 последних)
	@mkdir -p backups; ts=$$(date +%Y%m%d-%H%M%S)-$$(cat .release-current 2>/dev/null || echo na); \
	docker run --rm -v $(VOL):/data:ro -v "$$PWD/backups":/backup python:3.12-slim python -c \
	  "import os,sys,sqlite3; p='/data/pomnu.sqlite3'; os.path.exists(p) or sys.exit(print('БД ещё нет — пропускаю')); s=sqlite3.connect('file:'+p+'?mode=ro',uri=True); d=sqlite3.connect('/backup/pomnu-$$ts.sqlite3'); s.backup(d); d.close(); print(s.execute('select count(*) from docs').fetchone()[0],'документов → backups/pomnu-$$ts.sqlite3')" \
	&& docker run --rm -v $(VOL):/data:ro -v "$$PWD/backups":/backup alpine sh -c "[ ! -d /data/media ] || tar czf /backup/media-$$ts.tgz -C /data media"
	@ls -1t backups/pomnu-*.sqlite3 2>/dev/null | tail -n +11 | xargs -r rm -f; ls -1t backups/media-*.tgz 2>/dev/null | tail -n +11 | xargs -r rm -f

restore: ## make restore B=backups/pomnu-<ts>.sqlite3 [M=backups/media-<ts>.tgz]
	@test -f "$(B)" || { echo "Укажите B=backups/pomnu-....sqlite3 (ls backups)"; exit 1; }
	@read -p "Заменить БД на $(B)? Введите yes: " a; [ "$$a" = yes ] || exit 1
	$(MAKE) backup
	$(COMPOSE) stop app
	docker run --rm -v $(VOL):/data -v "$$PWD/backups":/backup alpine sh -c \
	  'rm -f /data/pomnu.sqlite3 /data/pomnu.sqlite3-journal /data/pomnu.sqlite3-wal /data/pomnu.sqlite3-shm && cp /backup/$(notdir $(B)) /data/pomnu.sqlite3 && chown 1000:1000 /data/pomnu.sqlite3'
	@[ -z "$(M)" ] || docker run --rm -v $(VOL):/data -v "$$PWD/backups":/backup alpine sh -c \
	  'rm -rf /data/media && tar xzf /backup/$(notdir $(M)) -C /data && chown -R 1000:1000 /data/media'
	IMAGE_TAG=$(CUR) $(COMPOSE) up -d --no-build --wait app
	@echo "Проверьте число историй: пустая БД молча заполняется демо-историями из seed.json"

smoke: ## /api/health отвечает и не в MOCK (ALLOW_MOCK=1 — разрешить заглушки)
	@for i in $$(seq 1 20); do h=$$(curl -fsS http://127.0.0.1:$${APP_PORT:-8000}/api/health) && break; sleep 2; done; \
	echo "$$h"; \
	echo "$$h" | grep -q '"ok":true' || { echo "health не отвечает"; exit 1; }; \
	[ "$(ALLOW_MOCK)" = 1 ] || echo "$$h" | grep -q '"mock":false' || { echo "Сайт в MOCK: нет ключей LLM в .env?"; exit 1; }

staging: ## текущий коммит рядом с продом: http://127.0.0.1:8001, копия последнего бэкапа, свой том
	IMAGE_TAG=$(SHA) $(COMPOSE) build app
	docker volume create pomnu-staging-data >/dev/null
	@b=$$(ls -1t backups/pomnu-*.sqlite3 2>/dev/null | head -1); [ -z "$$b" ] || docker run --rm -v pomnu-staging-data:/data -v "$$PWD/backups":/backup alpine sh -c "cp /backup/$$(basename $$b) /data/pomnu.sqlite3 && mkdir -p /data/media && chown -R 1000:1000 /data"
	$(STG) up -d --no-build --wait app caddy
	@echo "staging: http://127.0.0.1:8001 (с паролем: :8081). Расходует те же ключи API, что и прод."

staging-down:
	$(STG) down -v

test: ## автотесты в отдельном образе :test (рабочий образ не трогается), без платных вызовов
	docker build -t pomnu-app:test .
	docker run --rm -e MOCK=1 pomnu-app:test python -m unittest discover -s tests

logs:
	$(COMPOSE) logs -f --tail=100

public: ## поднять всё вместе с туннелем и показать адрес
	@docker image inspect pomnu-app:$(CUR) >/dev/null 2>&1 || IMAGE_TAG=$(CUR) $(COMPOSE) build app
	IMAGE_TAG=$(CUR) $(COMPOSE) --profile public up -d --no-build
	@echo "Жду адрес туннеля…"
	@for i in $$(seq 1 30); do \
	  url=$$($(COMPOSE) logs tunnel 2>&1 | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1); \
	  if [ -n "$$url" ]; then echo "$$url"; exit 0; fi; sleep 2; \
	done; echo "Адрес не появился, смотрите: $(COMPOSE) logs tunnel"; exit 1

domain: ## поднять всё с именованным туннелем на своём домене (нужен TUNNEL_TOKEN в .env)
	@grep -q '^TUNNEL_TOKEN=.\+' .env || { echo "Задайте TUNNEL_TOKEN в .env (токен туннеля Cloudflare)"; exit 1; }
	@# без --build: иначе после make rollback туннель поднял бы свежесобранный код
	@docker image inspect pomnu-app:$(CUR) >/dev/null 2>&1 || IMAGE_TAG=$(CUR) $(COMPOSE) build app
	IMAGE_TAG=$(CUR) $(COMPOSE) --profile domain up -d --no-build

reset-db: ## удалить БД и записи (том pomnu-data); перед этим снимается бэкап
	@read -p "Удалить ВСЕ истории, записи и фото? Введите yes: " ans; \
	if [ "$$ans" != "yes" ]; then echo "Отменено"; exit 1; fi
	$(MAKE) backup
	$(COMPOSE) --profile public --profile domain down
	docker volume rm $(VOL)
	@echo "Готово. Бэкап — в backups/. Данные пересоздаются из seed.json при следующем запуске (make deploy)."
