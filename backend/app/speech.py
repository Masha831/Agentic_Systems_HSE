"""Речь: распознавание (STT) и синтез (TTS). Зона Лизы.

Провайдер выбирают STT_PROVIDER / TTS_PROVIDER (config.py): ElevenLabs (по умолчанию при ключе) или Yandex SpeechKit.
Живая расшифровка (speech_stream.py) всегда идёт через SpeechKit v3.

ElevenLabs STT: POST /v1/speech-to-text, multipart `file` + `model_id=scribe_v2`, заголовок `xi-api-key`;
принимает webm/ogg/wav/mp3/m4a напрямую (до 3 ГБ), ffmpeg-нарезка не нужна; ответ — JSON с полем `text`.
https://elevenlabs.io/docs/api-reference/speech-to-text/convert
ElevenLabs TTS: POST /v1/text-to-speech/{voice_id}?output_format=mp3_44100_128, JSON {text, model_id} → mp3.
https://elevenlabs.io/docs/api-reference/text-to-speech/convert

Yandex STT v1 (синхронный): до 30 секунд и 1 МБ на запрос, формат oggopus.
Браузер пишет webm/opus (Chrome) или ogg/opus (Firefox) — ffmpeg перепаковывает
в ogg и режет на куски по 25 с. Нужен ffmpeg в системе.
Документация: https://yandex.cloud/ru/docs/speechkit/stt/request
"""
from __future__ import annotations

import asyncio
import math
import shutil
import subprocess
import tempfile
from pathlib import Path

import httpx

from . import config

STT_URL = "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize"
TTS_URL = "https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize"
ELEVEN_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text"
ELEVEN_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
MOCK_TEXT = "Это тестовая расшифровка: включён MOCK. Мы жили в Вологде с мамой и сестрой Ниной, а потом я уехала в Ленинград."


def _headers() -> dict:
    return {"Authorization": f"Api-Key {config.YANDEX_API_KEY}"}


def audio_duration(path: Path) -> float:
    if not shutil.which("ffprobe"):
        return 0.0
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, timeout=15,
    ).stdout.strip()
    try:
        duration = float(out)
        if math.isfinite(duration) and duration > 0:
            return duration
    except ValueError:
        pass
    # MediaRecorder в Chrome создаёт WebM без duration в заголовке.
    # Декодирование восстанавливает длительность по временным меткам пакетов.
    if not shutil.which("ffmpeg"):
        return 0.0
    result = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0", "-t", "302",
         "-f", "null", "-", "-progress", "pipe:1"],
        capture_output=True, text=True, timeout=45,
    )
    if result.returncode:
        return 0.0
    durations = []
    for line in result.stdout.splitlines():
        if line.startswith("out_time_us="):
            try:
                durations.append(int(line.split("=", 1)[1]) / 1_000_000)
            except ValueError:
                pass
    return max(durations, default=0.0)


def _to_ogg_chunks(path: Path, seconds: int = 25) -> list[bytes]:
    """webm/ogg → куски ogg/opus по `seconds` секунд."""
    if not shutil.which("ffmpeg"):
        raise RuntimeError("На сервере не установлен ffmpeg")
    with tempfile.TemporaryDirectory() as tmp:
        pattern = str(Path(tmp) / "chunk%03d.ogg")
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(path), "-ac", "1", "-c:a", "libopus",
             "-b:a", "32k", "-f", "segment", "-segment_time", str(seconds), pattern],
            check=True, timeout=90, capture_output=True,
        )
        chunks = [p.read_bytes() for p in sorted(Path(tmp).glob("chunk*.ogg"))]
        if not chunks or any(not b or len(b) > 1_000_000 for b in chunks):
            raise ValueError("Не удалось подготовить аудио в пределах лимита SpeechKit")
        return chunks


async def transcribe(path: Path) -> str:
    """Запись → текст. ValueError/RuntimeError несут безопасное русское сообщение для пользователя."""
    if config.STT_MOCK:
        return MOCK_TEXT
    if config.STT_PROVIDER == "elevenlabs":
        return await _transcribe_elevenlabs(path)
    return await _transcribe_yandex(path)


def _eleven_error(e: Exception) -> RuntimeError:
    """Сообщения без ключей и тел ответов провайдера."""
    if isinstance(e, httpx.TimeoutException):
        return RuntimeError("ElevenLabs не ответил вовремя. Запись сохранена; попробуйте распознать её позже.")
    if isinstance(e, httpx.HTTPStatusError):
        # ElevenLabs отдаёт и квоту, и нехватку прав с кодом 401: различаем по detail.status (берём только известные значения).
        try:
            reason = (e.response.json().get("detail") or {}).get("status")
        except (ValueError, AttributeError):
            reason = None
        if reason == "quota_exceeded":
            return RuntimeError("В ElevenLabs закончились кредиты или лимит ключа. Проверьте подписку и лимит ключа.")
        if reason == "missing_permissions":
            return RuntimeError("У ключа ElevenLabs нет нужных прав (Speech to Text / Text to Speech). Выдайте их в настройках ключа.")
        messages = {
            401: "ElevenLabs отклонил ключ. Проверьте ELEVENLABS_API_KEY на сервере.",
            402: "В ElevenLabs закончились кредиты или тариф не позволяет запрос. Проверьте подписку.",
            403: "ElevenLabs запретил запрос. Проверьте права ключа и статус аккаунта.",
            429: "Достигнут лимит запросов ElevenLabs. Подождите и повторите.",
        }
        return RuntimeError(messages.get(e.response.status_code, "ElevenLabs вернул ошибку. Запись сохранена; повторите позже."))
    if isinstance(e, httpx.RequestError):
        return RuntimeError("Нет соединения с ElevenLabs. Запись сохранена; проверьте сеть сервера и повторите.")
    return RuntimeError("ElevenLabs вернул непонятный ответ. Запись сохранена; повторите позже.")


async def _transcribe_elevenlabs(path: Path) -> str:
    data = await asyncio.to_thread(path.read_bytes)
    form = {"model_id": config.ELEVENLABS_STT_MODEL, "language_code": "rus",
            "tag_audio_events": "false", "diarize": "false"}
    try:
        async with httpx.AsyncClient(timeout=120) as c:
            r = await c.post(ELEVEN_STT_URL, headers={"xi-api-key": config.ELEVENLABS_API_KEY}, data=form,
                             files={"file": (path.name, data, "application/octet-stream")})
            r.raise_for_status()
        text = str(r.json().get("text") or "").strip()
    except (httpx.HTTPError, ValueError) as e:  # ValueError — не JSON в ответе
        raise _eleven_error(e) from e
    if not text:
        raise ValueError("Речь не распознана. Проверьте громкость и попробуйте снова")
    return text


async def _transcribe_yandex(path: Path) -> str:
    chunks = await asyncio.to_thread(_to_ogg_chunks, path)
    parts = []
    async with httpx.AsyncClient(timeout=60) as c:
        for chunk in chunks:
            try:
                r = await c.post(
                    STT_URL,
                    params={"lang": "ru-RU", "format": "oggopus"},
                    headers=_headers(), content=chunk,
                )
                r.raise_for_status()
            except httpx.TimeoutException as e:
                raise RuntimeError("SpeechKit не ответил вовремя. Запись сохранена; попробуйте распознать её позже.") from e
            except httpx.HTTPStatusError as e:
                messages = {
                    401: "SpeechKit отклонил ключ. Проверьте YANDEX_API_KEY на сервере.",
                    403: "SpeechKit запретил запрос. Проверьте права ключа, сервисного аккаунта и статус платёжного аккаунта.",
                    429: "Достигнут лимит запросов SpeechKit. Подождите и повторите распознавание.",
                }
                raise RuntimeError(messages.get(e.response.status_code, "SpeechKit вернул ошибку. Запись сохранена; повторите распознавание позже.")) from e
            except httpx.RequestError as e:
                raise RuntimeError("Нет соединения с SpeechKit. Запись сохранена; проверьте сеть сервера и повторите.") from e
            parts.append(r.json().get("result", ""))
    text = " ".join(p for p in parts if p).strip()
    if not text:
        raise ValueError("Речь не распознана. Проверьте громкость и попробуйте снова")
    return text


async def synthesize(text: str) -> bytes:
    """Озвучка вопроса → mp3."""
    if config.TTS_MOCK:
        raise RuntimeError("TTS недоступен в MOCK — фронт использует speechSynthesis браузера")
    if not text.strip() or len(text) > 5000:
        raise ValueError("Для озвучки нужен текст от 1 до 5000 символов")
    if config.TTS_PROVIDER == "elevenlabs":
        return await _synthesize_elevenlabs(text)
    return await _synthesize_yandex(text)


async def _synthesize_elevenlabs(text: str) -> bytes:
    if not config.ELEVENLABS_VOICE_ID:
        raise RuntimeError("Не задан ELEVENLABS_VOICE_ID: голос для озвучки не выбран")
    try:
        async with httpx.AsyncClient(timeout=60) as c:
            r = await c.post(
                ELEVEN_TTS_URL.format(voice_id=config.ELEVENLABS_VOICE_ID),
                params={"output_format": "mp3_44100_128"},
                headers={"xi-api-key": config.ELEVENLABS_API_KEY},
                json={"text": text, "model_id": config.ELEVENLABS_TTS_MODEL},
            )
            r.raise_for_status()
    except httpx.HTTPError as e:
        raise _eleven_error(e) from e
    if not r.content:
        raise RuntimeError("ElevenLabs вернул пустое аудио")
    return r.content


async def _synthesize_yandex(text: str) -> bytes:
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(
            TTS_URL, headers=_headers(),
            data={"text": text, "lang": "ru-RU", "voice": config.TTS_VOICE,
                  "format": "mp3"},
        )
        r.raise_for_status()
        return r.content
