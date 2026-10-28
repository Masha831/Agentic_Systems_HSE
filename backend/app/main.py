"""HTTP API «Помню». Контракт описан в docs/contract.md.

Запуск: uvicorn backend.app.main:app --reload  (из корня репозитория)
"""
from __future__ import annotations

import asyncio
import logging
import os
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, Header, WebSocket
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, orchestrator, speech, store, answer_delivery, speech_stream, photo_analysis
from .agents import base as agents_base

logging.basicConfig(level=logging.INFO)
app = FastAPI(title="Помню API")
store.seed_if_empty()


class CreateStory(BaseModel):
    type: str = "family"
    title: str
    about: str = ""
    narrator: str
    relation: str = ""
    cover: Optional[dict] = None  # {src,w,h,alt} из /api/uploads


class Answer(BaseModel):
    text: str
    typed: bool = False
    edited: bool = False
    audio: Optional[str] = None   # url из /transcribe
    dur: str = "0:00"
    photo: Optional[dict] = None


class Skip(BaseModel):
    declined: bool = False


class Clarify(BaseModel):
    value: str  # "yes" | "no"


def _404(fn):
    async def wrap(*a, **kw):
        try:
            r = fn(*a, **kw)
            return await r if hasattr(r, "__await__") else r
        except KeyError as e:
            raise HTTPException(404, f"Не найдено: {e}")
        except ValueError as e:
            raise HTTPException(400, str(e))
    return wrap


@app.get("/api/health")
def health():
    # live_stt: живая расшифровка идёт только через Yandex SpeechKit v3 (speech_stream.handle).
    live_stt = bool(config.YANDEX_API_KEY) and not config.MOCK
    return {"ok": True, "version": os.getenv("GIT_SHA", "dev"), "mock": config.MOCK, "provider": config.LLM_PROVIDER,
            "model": config.LLM_MODEL, "stt": config.STT_PROVIDER, "tts": config.TTS_PROVIDER, "live_stt": live_stt,
            "fallbacks": agents_base.FALLBACKS}


@app.get("/api/state")
def state():
    """Всё состояние в формате window.POMNU — фронт подменяет им data.js."""
    return store.state()


@app.post("/api/stories")
async def create_story(body: CreateStory):
    return await orchestrator.create_story(body.model_dump())


@app.delete("/api/stories/{sid}")
def delete_story(sid: str):
    store.delete_story(sid)
    return {"ok": True}


@app.get("/api/stories/{sid}/question")
async def question(sid: str):
    return await _404(orchestrator.get_question)(sid)


@app.websocket("/api/stories/{sid}/transcribe/live")
async def live_transcribe(ws: WebSocket, sid: str):
    await speech_stream.handle(ws, sid)


@app.post("/api/stories/{sid}/transcribe")
async def transcribe(sid: str, audio: UploadFile = File(...)):
    """Аудио ответа → файл сохраняется ДО распознавания, затем STT-провайдер (ElevenLabs/SpeechKit). Ошибка распознавания не теряет запись."""
    if not store.get("story", sid):
        raise HTTPException(404, "История не найдена")
    ext = Path(audio.filename or "a.webm").suffix.lower()
    if ext not in {".webm", ".ogg", ".wav", ".mp3", ".m4a", ".mp4"}:
        raise HTTPException(400, "Неподдерживаемый формат аудио")
    name = f"{uuid.uuid4().hex}{ext}"
    path = config.MEDIA_DIR / name
    size = 0
    with path.open("wb") as output:
        while chunk := await audio.read(1024 * 1024):
            size += len(chunk)
            if size > 25 * 1024 * 1024:
                output.close(); path.unlink(missing_ok=True)
                raise HTTPException(413, "Аудио должно быть меньше 25 МБ")
            output.write(chunk)
    if not size:
        path.unlink(missing_ok=True)
        raise HTTPException(400, "Аудиофайл пуст")
    url = f"/media/{name}"
    store.put("audio", name, {"story": sid, "url": url})
    return await _transcribe_saved(path, url)


async def _transcribe_saved(path: Path, url: str):
    try:
        dur = await asyncio.to_thread(speech.audio_duration, path)
        if dur > 301:
            raise ValueError("Один ответ должен быть не длиннее пяти минут")
        if dur <= 0:
            raise ValueError("Не удалось прочитать аудио. Проверьте файл и наличие ffmpeg/ffprobe на сервере")
        text = await speech.transcribe(path)
        seconds = max(1, round(dur))
        return {"text": text, "audio": url, "dur": f"{seconds // 60}:{seconds % 60:02d}"}
    except Exception as e:
        message = str(e) if isinstance(e, (ValueError, RuntimeError)) else "Сервис распознавания недоступен. Попробуйте повторить."
        raise HTTPException(502, detail={"message": message, "audio": url})


@app.post("/api/stories/{sid}/transcribe/retry")
async def transcribe_retry(sid: str, audio: str = Form(...)):
    name = Path(audio).name
    meta = store.get("audio", name)
    if not meta or meta.get("story") != sid or audio != meta.get("url"):
        raise HTTPException(404, "Запись этой истории не найдена")
    path = config.MEDIA_DIR / name
    if not path.exists():
        raise HTTPException(404, "Запись не найдена")
    return await _transcribe_saved(path, audio)


@app.post("/api/stories/{sid}/answers")
async def answer(sid: str, body: Answer, idempotency_key: str | None = Header(default=None)):
    """Сохранить ответ → Архивист → Интервьюер. Возвращает новый Source, добавленное и следующий вопрос."""
    if not body.text.strip():
        raise HTTPException(400, "Ответ не может быть пустым")
    payload = body.model_dump() | {"photo_provided": "photo" in body.model_fields_set}
    if idempotency_key:
        return await answer_delivery.deliver(sid, payload, idempotency_key)
    return await _404(orchestrator.answer)(sid, **payload)


@app.post("/api/stories/{sid}/skip")
async def skip(sid: str, body: Skip):
    return await _404(orchestrator.skip)(sid, body.declined)


@app.post("/api/stories/{sid}/clarify/{cid}")
async def clarify(sid: str, cid: str, body: Clarify):
    return await _404(orchestrator.resolve_clarify)(sid, cid, body.value)


@app.post("/api/stories/{sid}/chapters")
async def assemble(sid: str):
    """Редактор собирает главу из ответов текущей сессии; сессия закрывается."""
    return await _404(orchestrator.assemble)(sid)


@app.get("/api/stories/{sid}/trace")
def trace(sid: str):
    """Журнал запусков агентов по истории — для демо и отладки промптов."""
    return list(store.list_("trace", sid).values())


KIND = {"people": "person", "places": "place", "chapters": "chapter", "sources": "source", "events": "event", "stories": "story"}


@app.patch("/api/{coll}/{id}")
def patch(coll: str, id: str, body: dict):
    """Ручные правки пользователя: имя/роль человека, абзац главы, расшифровка и т.п."""
    kind = KIND.get(coll)
    obj = kind and store.get(kind, id)
    if not obj:
        raise HTTPException(404, "Не найдено")
    return store.put(kind, id, obj | body)


@app.post("/api/uploads")
async def upload(file: UploadFile = File(...)):
    from io import BytesIO
    from PIL import Image, UnidentifiedImageError
    data = await file.read(10 * 1024 * 1024 + 1)
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(413, "Фото должно быть меньше 10 МБ")
    try:
        with Image.open(BytesIO(data)) as img:
            if img.format not in {"JPEG", "PNG", "WEBP"}:
                raise ValueError("format")
            w, h = img.size
            if w * h > 40_000_000:
                raise ValueError("size")
            ext = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp"}[img.format]
            img.verify()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise HTTPException(400, "Нужно корректное изображение JPEG, PNG или WebP до 40 мегапикселей")
    name = f"{uuid.uuid4().hex}{ext}"
    (config.MEDIA_DIR / name).write_bytes(data)
    photo = {"src": f"/media/{name}", "w": w, "h": h, "alt": ""}
    return photo | {"analysis": await photo_analysis.analyze(photo)}


@app.get("/api/tts")
async def tts(text: str):
    try:
        return Response(await speech.synthesize(text), media_type="audio/mpeg")
    except Exception as e:
        raise HTTPException(503, "Озвучка недоступна; можно использовать голос браузера")



app.mount("/media", StaticFiles(directory=config.MEDIA_DIR), name="media")


@app.get("/")
def index():
    return FileResponse(config.FRONTEND_DIR / "index.html")


app.mount("/", StaticFiles(directory=config.FRONTEND_DIR), name="frontend")
