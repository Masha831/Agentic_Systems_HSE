# Помню — истории, рассказанные голосом

Человек рассказывает голосом, агент помогает вспомнить детали. Из разговора собирается глава истории:
в тексте можно открыть любого человека, увидеть связанные события и услышать исходную запись.
Полная постановка — [docs/mvp.md](docs/mvp.md), план на сегодня — [docs/plan.md](docs/plan.md).

## Запуск

```bash
uv venv && uv pip install -r backend/requirements.txt     # или python -m venv .venv && pip install -r ...
cp .env.example .env                                     # OPENROUTER_API_KEY (или ключи Yandex AI Studio); без ключей — MOCK
.venv/bin/uvicorn backend.app.main:app --reload --port 8000
# http://localhost:8000          — приложение
# http://localhost:8000/docs     — Swagger
```

Для распознавания речи нужен `ffmpeg` (`sudo apt install ffmpeg` / `brew install ffmpeg`).
Сбросить базу к демо-данным: удалить `backend/data/`.

## Запуск в Docker

Нужны Docker и Docker Compose. Внутри: приложение (один процесс uvicorn, ffmpeg в образе) и Caddy с паролем на весь сайт.

```bash
cp .env.example .env && chmod 600 .env   # заполнить OPENROUTER_API_KEY, ELEVENLABS_API_KEY (и при желании YANDEX_*), MOCK=0, BASIC_AUTH_USER, BASIC_AUTH_HASH
docker run --rm caddy:2 caddy hash-password   # хэш пароля для BASIC_AUTH_HASH — в одинарных кавычках
make deploy                                    # git pull → образ pomnu-app:<коммит> → бэкап → запуск → проверка; сайт на http://127.0.0.1:8080
make public                                    # то же + публичный адрес через Cloudflare quick tunnel, URL печатается в консоль
```

- Данные (SQLite, записи, фото) лежат в томе `pomnu-data` и переживают `make deploy`. `make reset-db` удаляет том после подтверждения — база вернётся к демо-данным.
- `make test` — автотесты в отдельном образе `pomnu-app:test` (`MOCK=1`, без платных вызовов), `make logs` — логи. Те же тесты гоняет GitHub Actions на каждый PR (`.github/workflows/ci.yml`).
- `.env` не попадает в образ и в git; ключи сервисов читает только контейнер `app`, Caddy получает лишь логин и хэш пароля.
- Свой домен: в панели Cloudflare Zero Trust создайте туннель (Networks → Tunnels → Cloudflared), добавьте Public hostname → `HTTP` → `caddy:8080`, токен положите в `.env` как `TUNNEL_TOKEN`, имя домена — в `ALLOWED_ORIGINS`, затем `make domain`. Домен должен быть в Cloudflare DNS; IP-адрес машины для этого не нужен.
- Без пароля: `CADDYFILE=./Caddyfile.open` в `.env` и `make deploy`. Платные API (LLM, голос) тогда доступны всем, у кого есть адрес, поэтому включайте это ненадолго.
- Не добавляйте `--workers` к uvicorn: защита от повторной отправки ответа (`answer_delivery`) рассчитана на один процесс.
- Quick tunnel Cloudflare обрывает обычный HTTP-ответ примерно через 100 с, поэтому длинную запись (несколько минут) проверьте до демо. Запасной вариант — ngrok: `ngrok http 8080`. Если прокси подменяет заголовок Host, перечислите свой хост в `ALLOWED_ORIGINS`.
- Свой сервер с публичным IP, без домена и Cloudflare: в `.env` добавить `COMPOSE_FILE=docker-compose.yml:docker-compose.sslip.yml` и `PUBLIC_HOST=1-2-3-4.sslip.io` (IP через дефисы), открыть порты 80 и 443, `make deploy`. Caddy сам получит сертификат Let's Encrypt, микрофон работает по HTTPS. За домашним роутером без проброса портов не заработает — там нужен туннель.

## Релизы и откат

Каждый `make deploy` собирает образ `pomnu-app:<коммит>`, перед запуском снимает бэкап БД и медиа в `backups/`, после запуска проверяет `/api/health` (отвечает и не в MOCK). Не прошло — сам возвращает предыдущий образ. Какой коммит сейчас на сайте — поле `version` в `/api/health`.

| Что сломалось | Что делать |
|---|---|
| Провайдер: качество, деньги, сбой OpenRouter или ElevenLabs | `make provider P=yandex` — LLM, распознавание и озвучка на Яндекс (нужны `YANDEX_API_KEY` и `YANDEX_FOLDER_ID`, иначе MOCK); назад — `make provider P=auto` |
| Код: падает, сломан интерфейс | `make rollback` — предыдущий релиз; `make rollback TO=<коммит>` — любой из `make releases`. Повторный `make rollback` возвращает обратно |
| Нужна версия до OpenRouter/ElevenLabs | `make build-release TO=v0.2-docker`, затем `make rollback TO=v0.2-docker` |
| Испорчены данные | `make restore B=backups/pomnu-<время>.sqlite3 [M=backups/media-<время>.tgz]`, затем при необходимости `make rollback` |

- `make backup` — снимок вручную; хранятся 10 последних. Раз в неделю копируйте `backups/` на другую машину.
- `make staging` — текущий коммит рядом с продом на http://127.0.0.1:8001 с копией последнего бэкапа и своим томом; `make staging-down` — убрать.
- Откат образа не меняет git. Чтобы следующий `make deploy` не вернул плохой код, отмените его в PR: `git revert <коммит>` (не `reset` и не force-push).
- Теги в git (`v0.1-mvp`, `v0.2-docker`, `v0.3-openrouter-elevenlabs`, дальше `v0.4…`) и [релизы на GitHub](https://github.com/Masha831/Agentic_Systems_HSE/releases) — проверенные точки. После удачного деплоя: `git tag -a v0.N -m "что внутри" && git push origin v0.N`.
- Не запускайте `docker compose up --build` руками: он пересоберёт `pomnu-app:latest` из рабочей копии в обход истории релизов.

## Голос
- Запись по кнопке → текст: ElevenLabs Scribe v2 (`STT_PROVIDER=elevenlabs`, нужен `ELEVENLABS_API_KEY`); файл уходит как есть, ffmpeg нужен только для длительности.
- Озвучка вопроса `GET /api/tts`: ElevenLabs (`TTS_PROVIDER`, `ELEVENLABS_VOICE_ID`, модель `ELEVENLABS_TTS_MODEL`). Кнопка озвучки в интерфейсе скрыта; без голоса или ключа endpoint отвечает 503.
- Без явных `STT_PROVIDER`/`TTS_PROVIDER` берётся ElevenLabs при ключе, иначе Yandex SpeechKit; переключатель `yandex` возвращает прежнее поведение.
- Остаётся на Yandex SpeechKit v3: живой текст во время записи (WebSocket). Без `YANDEX_API_KEY` `GET /api/health` отдаёт `live_stt: false`, и интерфейс просто расшифровывает запись после остановки.
- Агенты (LLM) и анализ фото: OpenRouter или Yandex AI Studio, см. `LLM_PROVIDER`.

## Архитектура

```
frontend/            дизайн-прототип (vanilla JS), состояние берёт из GET /api/state
  assets/data.js     демо-данные и формат состояния (window.POMNU)
  assets/api.js      все вызовы бэкенда
  assets/app.js      экраны: главная, разговор, главы, люди и события
backend/app/
  main.py            HTTP API (docs/contract.md)
  orchestrator.py    порядок работы агентов
  agents/
    interviewer.py   Интервьюер — следующий вопрос и план тем
    archivist.py     Архивист — люди, места, события, связи, вопросы на уточнение
    editor.py        Редактор — глава из ответов сессии
  llm.py             OpenRouter (DeepSeek V4.1 Flash) или Yandex AI Studio — переключатель LLM_PROVIDER; structured output по схеме
  speech.py          STT и TTS: ElevenLabs или SpeechKit
  store.py           SQLite
  models.py          общий контракт (Person, Place, Event, Source, Claim=Link, InterviewState, StoryBlock…)
  seed.json          демо-история (из data.js)
```

Ответ пользователя → **Source** сохраняется сразу (оригинал не теряется) → **Архивист** обновляет людей,
места, события и связи (каждая связь ссылается на Source) → **Интервьюер** выбирает следующий вопрос
с учётом плана тем, отказов и уже рассказанного. **Редактор** собирает главу по кнопке «Собрать главу».
Каждый запуск агента пишется в журнал: `GET /api/stories/{id}/trace`.

Без ключей (`MOCK=1`) агенты идут по сценарию из `seed.json` — интерфейс можно разрабатывать офлайн.
