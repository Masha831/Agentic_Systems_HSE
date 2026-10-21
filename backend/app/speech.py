"""Yandex SpeechKit: распознавание (STT) и синтез (TTS). Зона Лизы.

STT v1 (синхронный): до 30 секунд и 1 МБ на запрос, формат oggopus.
Браузер пишет webm/opus (Chrome) или ogg/opus (Firefox) — ffmpeg перепаковывает
в ogg и режет на куски по 25 с. Нужен ffmpeg в системе.
Документация: https://yandex.cloud/ru/docs/speechkit/stt/request
"""
from __future__ import annotations

import asyncio
import shutil
import subprocess
import tempfile
from pathlib import Path

import httpx

from . import config

STT_URL = "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize"
TTS_URL = "https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize"


def _headers() -> dict:
    return {"Authorization": f"Api-Key {config.YANDEX_API_KEY}"}


def audio_duration(path: Path) -> float:
    if not shutil.which("ffprobe"):
        return 0.0
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    ).stdout.strip()
    try:
        return float(out)
    except ValueError:
        return 0.0


def _to_ogg_chunks(path: Path, seconds: int = 25) -> list[bytes]:
    """webm/ogg → куски ogg/opus по `seconds` секунд."""
    with tempfile.TemporaryDirectory() as tmp:
        pattern = str(Path(tmp) / "chunk%03d.ogg")
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(path), "-ac", "1", "-c:a", "libopus",
             "-b:a", "32k", "-f", "segment", "-segment_time", str(seconds), pattern],
            check=True,
        )
        return [p.read_bytes() for p in sorted(Path(tmp).glob("chunk*.ogg"))]


async def transcribe(path: Path) -> str:
    if config.MOCK:
        return "Это тестовая расшифровка: включён MOCK. Мы жили в Вологде с мамой и сестрой Ниной, а потом я уехала в Ленинград."
    chunks = await asyncio.to_thread(_to_ogg_chunks, path)
    parts = []
    async with httpx.AsyncClient(timeout=60) as c:
        for chunk in chunks:
            r = await c.post(
                STT_URL,
                params={"folderId": config.YANDEX_FOLDER_ID, "lang": "ru-RU", "format": "oggopus"},
                headers=_headers(), content=chunk,
            )
            r.raise_for_status()
            parts.append(r.json().get("result", ""))
    return " ".join(p for p in parts if p).strip()


async def synthesize(text: str) -> bytes:
    """Озвучка вопроса → mp3."""
    if config.MOCK:
        raise RuntimeError("TTS недоступен в MOCK — фронт использует speechSynthesis браузера")
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(
            TTS_URL, headers=_headers(),
            data={"text": text[:4900], "lang": "ru-RU", "voice": config.TTS_VOICE,
                  "format": "mp3", "folderId": config.YANDEX_FOLDER_ID},
        )
        r.raise_for_status()
        return r.content
