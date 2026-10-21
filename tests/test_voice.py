"""No paid calls: provider responses are mocked, storage is temporary."""
import asyncio
import io
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import uuid
import wave
from unittest.mock import AsyncMock, patch

TEST_DIR = tempfile.TemporaryDirectory()
os.environ['MOCK'] = '1'
os.environ['DB_PATH'] = str(Path(TEST_DIR.name) / 'test.sqlite')
os.environ['MEDIA_DIR'] = str(Path(TEST_DIR.name) / 'media')
from fastapi.testclient import TestClient
import httpx
from PIL import Image
from backend.app.main import app
from backend.app import speech, store, answer_delivery


def wav_bytes(seconds=1):
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        w.writeframes(b'\0\0' * int(16000 * seconds))
    return buf.getvalue()


class VoiceHTTPTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        r = self.client.post('/api/stories', json={'title': 'Тестовая история', 'narrator': 'Тест'})
        self.assertEqual(r.status_code, 200)
        self.sid = r.json()['id']

    @unittest.skipUnless(shutil.which('ffprobe'), 'requires ffprobe')
    def test_stt_failure_keeps_audio_retry_keeps_duration_and_story(self):
        with patch.object(speech, 'transcribe', AsyncMock(side_effect=RuntimeError('Нет связи'))):
            r = self.client.post(f'/api/stories/{self.sid}/transcribe', files={'audio': ('a.wav', wav_bytes(), 'audio/wav')})
        self.assertEqual(r.status_code, 502)
        audio = r.json()['detail']['audio']
        self.assertEqual(self.client.get(audio).content, wav_bytes())
        with patch.object(speech, 'transcribe', AsyncMock(return_value='Настоящий ответ')):
            retry = self.client.post(f'/api/stories/{self.sid}/transcribe/retry', data={'audio': audio})
        self.assertEqual(retry.json(), {'text': 'Настоящий ответ', 'audio': audio, 'dur': '0:01'})
        self.assertEqual(self.client.post('/api/stories/other/transcribe/retry', data={'audio': audio}).status_code, 404)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'requires ffmpeg')
    def test_browser_webm_without_duration_is_accepted(self):
        encoded = subprocess.run(
            ['ffmpeg', '-v', 'error', '-i', 'pipe:0', '-c:a', 'libopus', '-f', 'webm', 'pipe:1'],
            input=wav_bytes(), capture_output=True, check=True,
        ).stdout
        with patch.object(speech, 'transcribe', AsyncMock(return_value='Запись из браузера')):
            result = self.client.post(f'/api/stories/{self.sid}/transcribe', files={'audio': ('answer.webm', encoded, 'audio/webm')})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()['dur'], '0:01')

    def test_upload_checks_bytes_not_filename(self):
        fake = self.client.post('/api/uploads', files={'file': ('fake.png', b'<script>bad</script>', 'image/png')})
        self.assertEqual(fake.status_code, 400)
        buf = io.BytesIO(); Image.new('RGB', (32, 24)).save(buf, 'PNG')
        valid = self.client.post('/api/uploads', files={'file': ('photo.png', buf.getvalue(), 'image/png')})
        self.assertEqual(valid.status_code, 200)
        self.assertEqual((valid.json()['w'], valid.json()['h']), (32, 24))
        self.assertEqual(self.client.get(valid.json()['src']).content, buf.getvalue())

    def test_duplicate_answer_returns_same_source_and_rejects_changed_payload(self):
        key = str(uuid.uuid4()); headers = {'Idempotency-Key': key}
        payload = {'text': 'Вымышленная история для проверки.', 'typed': True}
        first = self.client.post(f'/api/stories/{self.sid}/answers', json=payload, headers=headers)
        again = self.client.post(f'/api/stories/{self.sid}/answers', json=payload, headers=headers)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json(), again.json())
        self.assertEqual(len(store.list_('source', self.sid)), 1)
        self.assertEqual(self.client.post(f'/api/stories/{self.sid}/answers', json={'text': 'Другой текст'}, headers=headers).status_code, 409)

    def test_agent_failure_after_source_does_not_duplicate_on_retry(self):
        async def partial(sid, **kwargs):
            store.put('source', 'saved-' + sid, {'story': sid, 'text': kwargs['text']})
            raise RuntimeError('Agent failed')
        headers = {'Idempotency-Key': str(uuid.uuid4())}
        with patch.object(answer_delivery.orchestrator, 'answer', side_effect=partial) as run:
            first = self.client.post(f'/api/stories/{self.sid}/answers', json={'text': 'Сохранить оригинал'}, headers=headers)
            again = self.client.post(f'/api/stories/{self.sid}/answers', json={'text': 'Сохранить оригинал'}, headers=headers)
        self.assertEqual(first.status_code, 502)
        self.assertEqual(again.status_code, 409)
        self.assertEqual(first.json()['detail']['sourceId'], again.json()['detail']['sourceId'])
        self.assertEqual(run.call_count, 1)

    def test_five_answers_then_chapter_reference_original_sources(self):
        ids = []
        for i in range(5):
            result = self.client.post(f'/api/stories/{self.sid}/answers', json={'text': f'Вымышленный эпизод номер {i}', 'typed': True}, headers={'Idempotency-Key': str(uuid.uuid4())})
            self.assertEqual(result.status_code, 200)
            ids.append(result.json()['sourceId'])
            self.assertTrue(result.json()['question']['text'])
        chapter = self.client.post(f'/api/stories/{self.sid}/chapters')
        self.assertEqual(chapter.status_code, 200)
        self.assertEqual(chapter.json()['chapter']['sources'], ids)
        state = self.client.get('/api/state').json()
        self.assertTrue(all(i in state['sources'] for i in ids))


class SpeechProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_timeout_is_not_reported_as_bad_key_or_empty_speech(self):
        client = AsyncMock(); client.__aenter__.return_value = client
        client.post.side_effect = httpx.ReadTimeout('private transport diagnostics')
        with patch.object(speech.config, 'MOCK', False), patch.object(speech.httpx, 'AsyncClient', return_value=client), patch.object(speech, '_to_ogg_chunks', return_value=[b'audio']):
            with self.assertRaisesRegex(RuntimeError, 'не ответил вовремя') as caught:
                await speech.transcribe(Path('fake'))
        self.assertNotIn('private', str(caught.exception))

    async def test_access_errors_have_safe_actionable_messages(self):
        for status, expected in [(401, 'отклонил ключ'), (403, 'запретил запрос'), (429, 'лимит запросов')]:
            response = httpx.Response(status, json={'detail': 'private provider diagnostics'}, request=httpx.Request('POST', speech.STT_URL))
            client = AsyncMock(); client.__aenter__.return_value = client; client.post.return_value = response
            with patch.object(speech.config, 'MOCK', False), patch.object(speech.httpx, 'AsyncClient', return_value=client), patch.object(speech, '_to_ogg_chunks', return_value=[b'audio']):
                with self.assertRaisesRegex(RuntimeError, expected) as caught:
                    await speech.transcribe(Path('fake'))
            self.assertNotIn('private', str(caught.exception))

    async def test_service_account_stt_omits_folder_and_joins_chunks(self):
        response = httpx.Response(200, json={'result': 'слова'}, request=httpx.Request('POST', speech.STT_URL))
        client = AsyncMock(); client.__aenter__.return_value = client; client.post.return_value = response
        with patch.object(speech.config, 'MOCK', False), patch.object(speech.httpx, 'AsyncClient', return_value=client), patch.object(speech, '_to_ogg_chunks', return_value=[b'one', b'two']):
            self.assertEqual(await speech.transcribe(Path('fake')), 'слова слова')
        self.assertEqual(client.post.await_count, 2)
        self.assertNotIn('folderId', client.post.call_args.kwargs['params'])

    async def test_empty_recognition_is_retryable_error(self):
        response = httpx.Response(200, json={'result': ''}, request=httpx.Request('POST', speech.STT_URL))
        client = AsyncMock(); client.__aenter__.return_value = client; client.post.return_value = response
        with patch.object(speech.config, 'MOCK', False), patch.object(speech.httpx, 'AsyncClient', return_value=client), patch.object(speech, '_to_ogg_chunks', return_value=[b'one']):
            with self.assertRaises(ValueError): await speech.transcribe(Path('fake'))

    async def test_tts_uses_full_text_without_folder_id(self):
        response = httpx.Response(200, content=b'audio', request=httpx.Request('POST', speech.TTS_URL))
        client = AsyncMock(); client.__aenter__.return_value = client; client.post.return_value = response
        with patch.object(speech.config, 'MOCK', False), patch.object(speech.httpx, 'AsyncClient', return_value=client):
            self.assertEqual(await speech.synthesize('Вопрос?'), b'audio')
            with self.assertRaises(ValueError): await speech.synthesize('x' * 5001)
        self.assertEqual(client.post.call_args.kwargs['data']['text'], 'Вопрос?')
        self.assertNotIn('folderId', client.post.call_args.kwargs['data'])


if __name__ == '__main__': unittest.main()
