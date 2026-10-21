"""Live PCM -> SpeechKit v3 -> browser. A failed stream never replaces the local recording."""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import uuid
import wave
from urllib.parse import urlsplit

# Uses the OS resolver, including local DNS/VPN settings, before grpc is imported.
os.environ.setdefault('GRPC_DNS_RESOLVER', 'native')
import grpc
from fastapi import WebSocket, WebSocketDisconnect
from yandex.cloud.ai.stt.v3 import stt_pb2 as pb, stt_service_pb2_grpc as rpc

from . import config, store

MAX_SECONDS = 300
MAX_BYTES = 10 * 1024 * 1024


class Transcript:
    def __init__(self):
        self.finals: dict[int, str] = {}
        self.partial = ''

    @property
    def final_text(self):
        return ' '.join(self.finals[i] for i in sorted(self.finals)).strip()

    def update(self, response):
        event = response.WhichOneof('Event')
        if event == 'partial':
            self.partial = response.partial.alternatives[0].text if response.partial.alternatives else ''
        elif event == 'final':
            if response.final.alternatives:
                self.finals[response.audio_cursors.final_index] = response.final.alternatives[0].text
            self.partial = ''
        elif event == 'final_refinement':
            ref = response.final_refinement
            if ref.normalized_text.alternatives:
                self.finals[ref.final_index] = ref.normalized_text.alternatives[0].text
        else:
            return None
        return {'type': 'transcript', 'final': self.final_text, 'partial': self.partial}


async def recognize(chunks, sample_rate):
    """Provider boundary: async iterator, no HTTP/browser/storage state."""
    async def requests():
        yield pb.StreamingRequest(session_options=pb.StreamingOptions(
            recognition_model=pb.RecognitionModelOptions(
                model='general',
                audio_format=pb.AudioFormatOptions(raw_audio=pb.RawAudio(
                    audio_encoding=pb.RawAudio.LINEAR16_PCM,
                    sample_rate_hertz=sample_rate, audio_channel_count=1)),
                language_restriction=pb.LanguageRestrictionOptions(
                    restriction_type=pb.LanguageRestrictionOptions.WHITELIST, language_code=['ru-RU']),
                text_normalization=pb.TextNormalizationOptions(
                    text_normalization=pb.TextNormalizationOptions.TEXT_NORMALIZATION_ENABLED,
                    literature_text=False, profanity_filter=False),
                audio_processing_type=pb.RecognitionModelOptions.REAL_TIME)))
        async for data in chunks:
            yield pb.StreamingRequest(chunk=pb.AudioChunk(data=data))
        yield pb.StreamingRequest(eou=pb.Eou())

    async with grpc.aio.secure_channel('stt.api.cloud.yandex.net:443', grpc.ssl_channel_credentials()) as channel:
        call = rpc.RecognizerStub(channel).RecognizeStreaming(
            requests(), metadata=(('authorization', f'Api-Key {config.YANDEX_API_KEY}'),), timeout=320)
        try:
            async for response in call:
                yield response
        finally:
            call.cancel()


async def handle(ws: WebSocket, sid: str):
    # Browsers must originate on this app; do not expose a cross-site paid API proxy.
    origin = urlsplit(ws.headers.get('origin', ''))
    if origin.scheme not in {'http', 'https'} or (origin.netloc != ws.headers.get('host') and origin.netloc.lower() not in config.ALLOWED_ORIGINS):
        await ws.close(code=1008)
        return
    if not store.get('story', sid):
        await ws.close(code=1008)
        return
    await ws.accept()
    path = None
    keep = False
    tasks = []
    try:
        if config.MOCK or not config.YANDEX_API_KEY:
            raise ValueError('Потоковое распознавание недоступно в деморежиме')
        first = await asyncio.wait_for(ws.receive_json(), 10)
        rate = first.get('sample_rate')
        if first.get('type') != 'start' or type(rate) is not int or rate not in {8000, 16000, 48000}:
            raise ValueError('Неподдерживаемый формат потока')
        name = f'{uuid.uuid4().hex}.wav'
        path = config.MEDIA_DIR / name
        queue = asyncio.Queue(maxsize=20)
        transcript = Transcript()
        size = 0
        stopped = False
        writer = wave.open(str(path), 'wb')
        writer.setnchannels(1); writer.setsampwidth(2); writer.setframerate(rate)

        async def chunks():
            while True:
                item = await queue.get()
                if item is None:
                    return
                yield item

        async def receive_audio():
            nonlocal size, stopped
            while True:
                message = await asyncio.wait_for(ws.receive(), 6)
                if message['type'] == 'websocket.disconnect':
                    raise WebSocketDisconnect()
                data = message.get('bytes')
                if data is not None:
                    size += len(data)
                    if not data or len(data) % 2 or len(data) > 64000 or size > min(MAX_BYTES, rate * 2 * MAX_SECONDS):
                        raise ValueError('Превышен лимит или нарушен формат потока')
                    writer.writeframesraw(data)
                    await asyncio.wait_for(queue.put(data), 2)
                elif message.get('text') and json.loads(message['text']).get('type') == 'stop':
                    stopped = True
                    await asyncio.wait_for(queue.put(None), 2)
                    return
                else:
                    raise ValueError('Неизвестное сообщение потока')

        async def forward():
            async for response in recognize(chunks(), rate):
                update = transcript.update(response)
                if update:
                    await ws.send_json(update)

        try:
            await ws.send_json({'type': 'ready'})
            receiver = asyncio.create_task(receive_audio())
            sender = asyncio.create_task(forward())
            tasks = [receiver, sender]
            async def complete():
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
                if not receiver.done():
                    raise RuntimeError('Поток распознавания завершился раньше записи')
                await asyncio.wait_for(sender, 10)
            await asyncio.wait_for(complete(), 315)
            if not stopped or not size or not transcript.final_text:
                raise ValueError('Речь в потоке не распознана')
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            writer.close()
        url = f'/media/{name}'
        store.put('audio', name, {'story': sid, 'url': url})
        keep = True
        seconds = max(1, round(size / (rate * 2)))
        await ws.send_json({'type': 'done', 'text': transcript.final_text,
                            'audio': url, 'dur': f'{seconds // 60}:{seconds % 60:02d}'})
    except WebSocketDisconnect:
        pass
    except Exception:
        # Never send provider details, credentials or partial text as a final answer.
        with contextlib.suppress(Exception):
            await ws.send_json({'type': 'error', 'message': 'Живой текст недоступен. Запись продолжится; распознаем её после остановки.'})
    finally:
        if path and not keep:
            path.unlink(missing_ok=True)
        with contextlib.suppress(Exception):
            await ws.close()
