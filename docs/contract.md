# Контракт API

Формы объектов — `backend/app/models.py`, они же лежат в `frontend/assets/data.js`.
Менять поля — только договорившись в чате команды и обновив этот файл.

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| GET | `/api/health` | | `{ok, mock, model}` |
| GET | `/api/state` | | весь `window.POMNU`: `{user, types, stories[], people{}, places{}, events[], sources{}, chapters{}}` |
| POST | `/api/stories` | `{type, title, about, narrator, relation, cover?}` | `Story` (с `interview.question` — первым вопросом) |
| DELETE | `/api/stories/{sid}` | | `{ok}` — удаляет историю и все материалы |
| GET | `/api/stories/{sid}/question` | | `Question {text, why, topic, topicTitle}` — текущий или новый после перерыва |
| POST | `/api/stories/{sid}/transcribe` | multipart `audio` (webm/ogg/wav/mp3/m4a/mp4, до 25 МБ и 5 минут) | `{text, audio, dur}`; при ошибке `502 {detail:{message, audio}}` — запись сохранена |
| POST | `/api/stories/{sid}/transcribe/retry` | form `audio=<url>` | `{text, audio, dur}` |
| POST | `/api/stories/{sid}/answers` | `{text, typed, edited, audio?, dur, photo?}` | `{sourceId, source, added:{people{}, places{}, events[]}, question, story}` |
| POST | `/api/stories/{sid}/skip` | `{declined}` | `{question, story}` |
| POST | `/api/stories/{sid}/clarify/{cid}` | `{value: "yes"\|"no"}` | `{story, people, places}` |
| POST | `/api/stories/{sid}/chapters` | | `{chapterId, chapter, story}` — сессия закрывается, `story.interview.session += 1` |
| GET | `/api/stories/{sid}/trace` | | журнал запусков агентов `[{agent, ms, prompt, result, at}]` |
| PATCH | `/api/{people\|places\|chapters\|sources\|events\|stories}/{id}` | частичный объект | обновлённый объект |
| POST | `/api/uploads` | multipart `file` (JPEG/PNG/WebP, до 10 МБ и 40 Мп) | `{src, w, h, alt}` |
| GET | `/api/tts?text=` | | `audio/mpeg`; 503 — озвучка недоступна; кнопка временно скрыта в UI |

## Ключевые формы

- `Story.interview` — серверное состояние разговора: `{session, question, asked[], turns[]}`.
- `Story.topics[]` — план интервью `{id, title, status: done|current|later|declined}`.
- `Story.clarify[]` — вопросы Архивиста на подтверждение `{id, src, text, yes, no, yesMsg, noMsg, apply:{yes:{role|links|note}}, resolved}`.
- `Person.links[]` — `{to, label, src}`: связь ВСЕГДА со ссылкой на Source, где она сказана (это наш Claim).
- `Chapter.blocks[]` — `StoryBlock {t: p|quote|fig|slot, src, text, by, dur, note, img, caption}`.
  В тексте — токены `[[p:id|слово]]` (человек) и `[[l:id|слово]]` (место).
- id новых сущностей уникальны глобально (Архивист добавляет префикс истории при совпадении).

## Повтор сохранения ответа

Фронт передаёт `Idempotency-Key` в `POST /answers` и хранит ключ вместе с неизменным
снимком ответа в IndexedDB. Повтор с тем же ключом возвращает тот же результат;
другое тело с прежним ключом возвращает 409. После неизвестного результата запроса
текст временно доступен только для чтения, чтобы повтор не отправил другие данные.

Если Source уже записан, а один из агентов упал, ответ — 502 с
`detail: {message, sourceId}`. Фронт перечитывает `/api/state`, не создавая ответ повторно.
Последующий повтор такого ключа — 409 с `sourceId`. Это не означает, что материалы
архивиста готовы: UI сообщает об ошибке и предлагает продолжить с новым вопросом.
Защита рассчитана на один процесс сервера (без `--workers`). После аварийного
завершения процесса запрос в состоянии pending требует ручной сверки; автоматически
повторять работу агентов небезопасно.

При ошибке STT сервер возвращает ссылку на сохранённый файл. `/transcribe/retry`
принимает только точный URL записи, ранее загруженной для этой истории. Это проверка
принадлежности записи истории, а не авторизация пользователей: демо остаётся однопользовательским.


## Живая расшифровка

`WS /api/stories/{sid}/transcribe/live` — тот же origin, что у приложения.

1. Клиент: JSON `{type:"start", sample_rate:16000}` (также поддерживаются 8000/48000).
2. Сервер: `{type:"ready"}`. Это готовность транспорта, не подтверждение результата STT.
3. Клиент: бинарный mono PCM signed 16-bit little-endian, обычно по 100 мс.
4. Сервер: `{type:"transcript", final:"Уже завершённые фразы", partial:"Текущая фраза"}`.
   Каждый пакет заменяет отображаемый снимок, а не добавляется к нему.
5. Клиент после сброса остатка AudioWorklet: `{type:"stop"}`.
6. Сервер: `{type:"done", text, audio, dur}` с окончательным текстом и сохранённым WAV.
   Далее обычный `POST /answers`, без изменения формы Answer/Source.

`{type:"error", message}` или обрыв соединения переводят UI на распознавание локальной
записи после stop. Промежуточные слова не считаются сохранённым ответом. Отмена закрывает
WebSocket, отменяет gRPC и удаляет незавершённый временный WAV. На успешном пути URL
WAV зарегистрирован для этой истории и пригоден для `/transcribe/retry`.
