# Помню — истории, рассказанные голосом

Человек рассказывает голосом, агент помогает вспомнить детали. Из разговора собирается глава истории:
в тексте можно открыть любого человека, увидеть связанные события и услышать исходную запись.
Полная постановка — [docs/mvp.md](docs/mvp.md), план на сегодня — [docs/plan.md](docs/plan.md).

## Запуск

```bash
uv venv && uv pip install -r backend/requirements.txt     # или python -m venv .venv && pip install -r ...
cp .env.example .env                                     # ключи Yandex AI Studio; без ключей — MOCK
.venv/bin/uvicorn backend.app.main:app --reload --port 8000
# http://localhost:8000          — приложение
# http://localhost:8000/docs     — Swagger
```

Для распознавания речи нужен `ffmpeg` (`sudo apt install ffmpeg` / `brew install ffmpeg`).
Сбросить базу к демо-данным: удалить `backend/data/`.

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
  llm.py             Yandex AI Studio (OpenAI-совместимый API), structured output по pydantic-схеме
  speech.py          SpeechKit: STT и TTS
  store.py           SQLite
  models.py          общий контракт (Person, Place, Event, Source, Claim=Link, InterviewState, StoryBlock…)
  seed.json          демо-история (из data.js)
```

Ответ пользователя → **Source** сохраняется сразу (оригинал не теряется) → **Архивист** обновляет людей,
места, события и связи (каждая связь ссылается на Source) → **Интервьюер** выбирает следующий вопрос
с учётом плана тем, отказов и уже рассказанного. **Редактор** собирает главу по кнопке «Собрать главу».
Каждый запуск агента пишется в журнал: `GET /api/stories/{id}/trace`.

Без ключей (`MOCK=1`) агенты идут по сценарию из `seed.json` — интерфейс можно разрабатывать офлайн.
