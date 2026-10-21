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
| POST | `/api/stories/{sid}/transcribe` | multipart `audio` (webm/ogg) | `{text, audio, dur}`; при ошибке `502 {detail:{message, audio}}` — запись сохранена |
| POST | `/api/stories/{sid}/transcribe/retry` | form `audio=<url>` | `{text, audio}` |
| POST | `/api/stories/{sid}/answers` | `{text, typed, edited, audio?, dur, photo?}` | `{sourceId, source, added:{people{}, places{}, events[]}, question, story}` |
| POST | `/api/stories/{sid}/skip` | `{declined}` | `{question, story}` |
| POST | `/api/stories/{sid}/clarify/{cid}` | `{value: "yes"\|"no"}` | `{story, people, places}` |
| POST | `/api/stories/{sid}/chapters` | | `{chapterId, chapter, story}` — сессия закрывается, `story.interview.session += 1` |
| GET | `/api/stories/{sid}/trace` | | журнал запусков агентов `[{agent, ms, prompt, result, at}]` |
| PATCH | `/api/{people\|places\|chapters\|sources\|events\|stories}/{id}` | частичный объект | обновлённый объект |
| POST | `/api/uploads` | multipart `file` | `{src, w, h, alt}` |
| GET | `/api/tts?text=` | | `audio/mpeg`; 503 — фронт падает обратно на `speechSynthesis` |

## Ключевые формы

- `Story.interview` — серверное состояние разговора: `{session, question, asked[], turns[], photo}`.
  `photo` — фото, о котором текущий вопрос (история начата с фото); прикрепляется к следующему ответу.
- Первый вопрос новой истории — всегда знакомство (`topic: "intro"`): имя, обращение, «он»/«она».
  Ответ заполняет `Story.narratorName`, `narratorAddress`, `narratorGender` (`f`|`m`|`""`) и создаёт
  карточку рассказчика (`Person.narrator=true`, `Story.narratorId`). В главу этот ответ не идёт (`Source.intro=true`).
  Если история начата с фото, вопрос про фото — вторым.
- Тексты фиксированных вопросов и событий для Интервьюера — `backend/app/agents/prompts/texts.json`.
- `Story.topics[]` — план интервью `{id, title, status: done|current|later|declined}`.
- `Story.clarify[]` — вопросы Архивиста на подтверждение `{id, src, text, yes, no, yesMsg, noMsg, apply:{yes:{role|links|note}}, resolved}`.
- `Person.links[]` — `{to, label, src}`: связь ВСЕГДА со ссылкой на Source, где она сказана (это наш Claim).
- `Chapter.blocks[]` — `StoryBlock {t: p|quote|fig|slot, src, text, by, dur, note, img, caption}`.
  В тексте — токены `[[p:id|слово]]` (человек) и `[[l:id|слово]]` (место).
- id новых сущностей уникальны глобально (Архивист добавляет префикс истории при совпадении).
