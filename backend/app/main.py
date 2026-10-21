"""HTTP API «Помню». Контракт описан в docs/contract.md.

Запуск: uvicorn backend.app.main:app --reload  (из корня репозитория)
"""
from __future__ import annotations

import logging
import shutil
import struct
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, orchestrator, speech, store

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
    return {"ok": True, "mock": config.MOCK, "model": config.YANDEX_MODEL}


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


@app.post("/api/stories/{sid}/transcribe")
async def transcribe(sid: str, audio: UploadFile = File(...)):
    """Аудио ответа → файл сохраняется ДО распознавания, затем SpeechKit. Ошибка распознавания не теряет запись."""
    ext = Path(audio.filename or "a.webm").suffix or ".webm"
    name = f"{sid}-{uuid.uuid4().hex[:8]}{ext}"
    path = config.MEDIA_DIR / name
    with path.open("wb") as f:
        shutil.copyfileobj(audio.file, f)
    dur = speech.audio_duration(path)
    url = f"/media/{name}"
    try:
        text = await speech.transcribe(path)
    except Exception as e:
        logging.exception("STT failed")
        raise HTTPException(502, detail={"message": f"Не получилось расшифровать: {e}", "audio": url})
    return {"text": text, "audio": url, "dur": f"{int(dur // 60)}:{int(dur % 60):02d}"}


@app.post("/api/stories/{sid}/transcribe/retry")
async def transcribe_retry(sid: str, audio: str = Form(...)):
    path = config.MEDIA_DIR / Path(audio).name
    if not path.exists():
        raise HTTPException(404, "Запись не найдена")
    return {"text": await speech.transcribe(path), "audio": audio}


@app.post("/api/stories/{sid}/answers")
async def answer(sid: str, body: Answer):
    """Сохранить ответ → Архивист → Интервьюер. Возвращает новый Source, добавленное и следующий вопрос."""
    return await _404(orchestrator.answer)(sid, **body.model_dump())


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
    ext = Path(file.filename or "f.jpg").suffix.lower() or ".jpg"
    name = f"{uuid.uuid4().hex[:12]}{ext}"
    path = config.MEDIA_DIR / name
    data = await file.read()
    path.write_bytes(data)
    w, h = _image_size(data)
    return {"src": f"/media/{name}", "w": w, "h": h, "alt": ""}


@app.get("/api/tts")
async def tts(text: str):
    try:
        return Response(await speech.synthesize(text), media_type="audio/mpeg")
    except Exception as e:
        raise HTTPException(503, f"TTS недоступен: {e}")


def _image_size(b: bytes) -> tuple[int, int]:
    """Размер JPEG/PNG без Pillow."""
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", b[16:24])
    i = 2
    while i < len(b) - 9 and b[:2] == b"\xff\xd8":
        if b[i] != 0xFF:
            break
        marker, size = b[i + 1], struct.unpack(">H", b[i + 2:i + 4])[0]
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            h, w = struct.unpack(">HH", b[i + 5:i + 9])
            return w, h
        i += 2 + size
    return 0, 0


app.mount("/media", StaticFiles(directory=config.MEDIA_DIR), name="media")


@app.get("/")
def index():
    return FileResponse(config.FRONTEND_DIR / "index.html")


app.mount("/", StaticFiles(directory=config.FRONTEND_DIR), name="frontend")
