"""Streaming contract tests without paid calls."""
import asyncio
import io
import unittest
import wave
from unittest.mock import patch

import test_voice
from backend.app import config, speech_stream as live, store
from yandex.cloud.ai.stt.v3 import stt_pb2 as pb
from starlette.websockets import WebSocketDisconnect


def event(kind, text, index=0):
    response = pb.StreamingResponse()
    response.audio_cursors.final_index = index
    if kind == 'final_refinement':
        response.final_refinement.final_index = index
        response.final_refinement.normalized_text.alternatives.add(text=text)
    else:
        getattr(response, kind).alternatives.add(text=text)
    return response


class TranscriptTests(unittest.TestCase):
    def test_partials_replace_and_refinement_updates_without_duplicate_or_losing_new_partial(self):
        t = live.Transcript()
        t.update(event('partial', 'В сад'))
        self.assertEqual(t.update(event('partial', 'В саду'))['partial'], 'В саду')
        t.update(event('final', 'В саду'))
        t.update(event('partial', 'Бабушка'))
        update = t.update(event('final_refinement', 'В саду.'))
        self.assertEqual(update, {'type':'transcript', 'final':'В саду.', 'partial':'Бабушка'})
        t.update(event('final', 'Бабушка Нина.', 1))
        self.assertEqual(t.final_text, 'В саду. Бабушка Нина.')


class StreamingHTTPTests(unittest.TestCase):
    def setUp(self):
        # Reuse only setup, not inherited tests.
        test_voice.VoiceHTTPTests.setUp(self)
        self.settings = patch.multiple(config, MOCK=False, YANDEX_API_KEY='test-only-placeholder')
        self.settings.start(); self.addCleanup(self.settings.stop)
        self.headers = {'origin':'http://testserver'}

    def connect(self):
        return self.client.websocket_connect(f'/api/stories/{self.sid}/transcribe/live', headers=self.headers)

    def test_text_arrives_before_stop_and_final_audio_is_saved(self):
        received = []
        async def recognize(chunks, rate):
            async for data in chunks:
                received.append(data)
                yield event('partial', 'В саду')
            yield event('final', 'В саду')
            yield event('final_refinement', 'В саду.')
        pcm = b'\1\0' * 1600
        with patch.object(live, 'recognize', recognize), self.connect() as ws:
            ws.send_json({'type':'start','sample_rate':16000})
            self.assertEqual(ws.receive_json()['type'],'ready')
            ws.send_bytes(pcm)
            self.assertEqual(ws.receive_json()['partial'], 'В саду')
            ws.send_json({'type':'stop'})
            messages = [ws.receive_json(), ws.receive_json(), ws.receive_json()]
        done = messages[-1]
        self.assertEqual(done['type'],'done')
        self.assertEqual(done['text'],'В саду.')
        self.assertEqual(received,[pcm])
        raw = self.client.get(done['audio']).content
        with wave.open(io.BytesIO(raw)) as wav:
            self.assertEqual(wav.getframerate(),16000)
            self.assertEqual(wav.readframes(wav.getnframes()),pcm)
        self.assertEqual(store.get('audio',done['audio'].split('/')[-1])['story'],self.sid)

    def test_provider_failure_never_reports_partial_as_saved(self):
        before = set(config.MEDIA_DIR.glob('*.wav'))
        async def broken(chunks, rate):
            async for _ in chunks:
                yield event('partial','Неполная фраза')
                raise RuntimeError('sensitive provider diagnostic')
        with patch.object(live,'recognize',broken), self.connect() as ws:
            ws.send_json({'type':'start','sample_rate':16000}); ws.receive_json()
            ws.send_bytes(b'\0\0'*1600)
            self.assertEqual(ws.receive_json()['type'],'transcript')
            error=ws.receive_json()
            self.assertEqual(error['type'],'error')
            self.assertNotIn('sensitive',str(error))
        self.assertEqual(set(config.MEDIA_DIR.glob('*.wav')),before)

    def test_cancel_cancels_provider_and_removes_incomplete_audio(self):
        before=set(config.MEDIA_DIR.glob('*.wav')); cancelled=[]
        async def recognize(chunks,rate):
            try:
                async for _ in chunks:
                    yield event('partial','Начало')
            finally: cancelled.append(True)
        with patch.object(live,'recognize',recognize):
            with self.connect() as ws:
                ws.send_json({'type':'start','sample_rate':16000}); ws.receive_json()
                ws.send_bytes(b'\0\0'*1600); ws.receive_json()
        self.assertTrue(cancelled)
        self.assertEqual(set(config.MEDIA_DIR.glob('*.wav')),before)

    def test_invalid_rate_rejected_before_provider(self):
        with self.connect() as ws:
            ws.send_json({'type':'start','sample_rate':44100})
            self.assertEqual(ws.receive_json()['type'],'error')

    def test_cross_origin_rejected(self):
        with self.assertRaises(WebSocketDisconnect):
            with self.client.websocket_connect(f'/api/stories/{self.sid}/transcribe/live',headers={'origin':'https://other.example'}): pass

    def test_oversized_or_odd_pcm_rejected(self):
        async def recognize(chunks,rate):
            async for _ in chunks:
                yield event('partial','')
        with patch.object(live,'recognize',recognize), self.connect() as ws:
            ws.send_json({'type':'start','sample_rate':16000}); ws.receive_json()
            ws.send_bytes(b'odd')
            self.assertEqual(ws.receive_json()['type'],'error')
