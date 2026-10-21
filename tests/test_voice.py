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
        self.assertEqual(chapter.json()['chapter']['sources'], ids[1:])
        self.assertTrue(store.get('source', ids[0])['intro'])
        state = self.client.get('/api/state').json()
        self.assertTrue(all(i in state['sources'] for i in ids))


# Эти тесты проверяют Yandex-путь независимо от ключей в окружении.
YANDEX_SPEECH = patch.multiple(speech.config, STT_MOCK=False, TTS_MOCK=False, STT_PROVIDER='yandex', TTS_PROVIDER='yandex')


class SpeechProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_timeout_is_not_reported_as_bad_key_or_empty_speech(self):
        client = AsyncMock(); client.__aenter__.return_value = client
        client.post.side_effect = httpx.ReadTimeout('private transport diagnostics')
        with YANDEX_SPEECH, patch.object(speech.httpx, 'AsyncClient', return_value=client), patch.object(speech, '_to_ogg_chunks', return_value=[b'audio']):
            with self.assertRaisesRegex(RuntimeError, 'не ответил вовремя') as caught:
                await speech.transcribe(Path('fake'))
        self.assertNotIn('private', str(caught.exception))

    async def test_access_errors_have_safe_actionable_messages(self):
        for status, expected in [(401, 'отклонил ключ'), (403, 'запретил запрос'), (429, 'лимит запросов')]:
            response = httpx.Response(status, json={'detail': 'private provider diagnostics'}, request=httpx.Request('POST', speech.STT_URL))
            client = AsyncMock(); client.__aenter__.return_value = client; client.post.return_value = response
            with YANDEX_SPEECH, patch.object(speech.httpx, 'AsyncClient', return_value=client), patch.object(speech, '_to_ogg_chunks', return_value=[b'audio']):
                with self.assertRaisesRegex(RuntimeError, expected) as caught:
                    await speech.transcribe(Path('fake'))
            self.assertNotIn('private', str(caught.exception))

    async def test_service_account_stt_omits_folder_and_joins_chunks(self):
        response = httpx.Response(200, json={'result': 'слова'}, request=httpx.Request('POST', speech.STT_URL))
        client = AsyncMock(); client.__aenter__.return_value = client; client.post.return_value = response
        with YANDEX_SPEECH, patch.object(speech.httpx, 'AsyncClient', return_value=client), patch.object(speech, '_to_ogg_chunks', return_value=[b'one', b'two']):
            self.assertEqual(await speech.transcribe(Path('fake')), 'слова слова')
        self.assertEqual(client.post.await_count, 2)
        self.assertNotIn('folderId', client.post.call_args.kwargs['params'])

    async def test_empty_recognition_is_retryable_error(self):
        response = httpx.Response(200, json={'result': ''}, request=httpx.Request('POST', speech.STT_URL))
        client = AsyncMock(); client.__aenter__.return_value = client; client.post.return_value = response
        with YANDEX_SPEECH, patch.object(speech.httpx, 'AsyncClient', return_value=client), patch.object(speech, '_to_ogg_chunks', return_value=[b'one']):
            with self.assertRaises(ValueError): await speech.transcribe(Path('fake'))

    async def test_tts_uses_full_text_without_folder_id(self):
        response = httpx.Response(200, content=b'audio', request=httpx.Request('POST', speech.TTS_URL))
        client = AsyncMock(); client.__aenter__.return_value = client; client.post.return_value = response
        with YANDEX_SPEECH, patch.object(speech.httpx, 'AsyncClient', return_value=client):
            self.assertEqual(await speech.synthesize('Вопрос?'), b'audio')
            with self.assertRaises(ValueError): await speech.synthesize('x' * 5001)
        self.assertEqual(client.post.call_args.kwargs['data']['text'], 'Вопрос?')
        self.assertNotIn('folderId', client.post.call_args.kwargs['data'])



def eleven_client(response=None, error=None):
    client = AsyncMock(); client.__aenter__.return_value = client
    if error: client.post.side_effect = error
    else: client.post.return_value = response
    return client


ELEVEN = dict(STT_MOCK=False, TTS_MOCK=False, STT_PROVIDER='elevenlabs', TTS_PROVIDER='elevenlabs',
              ELEVENLABS_API_KEY='test-only-placeholder', ELEVENLABS_VOICE_ID='voice-1',
              ELEVENLABS_STT_MODEL='scribe_v2', ELEVENLABS_TTS_MODEL='eleven_multilingual_v2')


class ElevenLabsSpeechTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.audio = Path(TEST_DIR.name) / 'eleven.webm'
        self.audio.write_bytes(b'webm-bytes')
        patcher = patch.multiple(speech.config, **ELEVEN)
        patcher.start(); self.addCleanup(patcher.stop)

    def reply(self, status, **kw):
        return httpx.Response(status, request=httpx.Request('POST', speech.ELEVEN_STT_URL), **kw)

    async def transcribe(self, client):
        with patch.object(speech.httpx, 'AsyncClient', return_value=client):
            return await speech.transcribe(self.audio)

    async def test_stt_sends_file_directly_with_scribe_v2_and_returns_text(self):
        client = eleven_client(self.reply(200, json={'text': ' Мы жили в Вологде. ', 'language_code': 'rus', 'words': []}))
        self.assertEqual(await self.transcribe(client), 'Мы жили в Вологде.')
        call = client.post.call_args
        self.assertEqual(call.args[0], speech.ELEVEN_STT_URL)
        self.assertEqual(call.kwargs['headers'], {'xi-api-key': 'test-only-placeholder'})
        self.assertEqual(call.kwargs['data']['model_id'], 'scribe_v2')
        self.assertEqual(call.kwargs['data']['language_code'], 'rus')
        self.assertEqual(call.kwargs['files']['file'][1], b'webm-bytes')

    async def test_empty_text_is_retryable_value_error(self):
        for body in ({'text': ''}, {'text': '   '}, {}):
            with self.assertRaisesRegex(ValueError, 'Речь не распознана'):
                await self.transcribe(eleven_client(self.reply(200, json=body)))

    async def test_http_errors_are_safe_and_actionable(self):
        for status, expected in [(401, 'отклонил ключ'), (402, 'кредиты'), (403, 'запретил запрос'),
                                 (429, 'лимит запросов'), (500, 'вернул ошибку')]:
            with self.assertRaisesRegex(RuntimeError, expected) as caught:
                await self.transcribe(eleven_client(self.reply(status, json={'detail': 'private provider diagnostics'})))
            self.assertNotIn('private', str(caught.exception))
            self.assertNotIn('test-only-placeholder', str(caught.exception))

    async def test_401_with_quota_or_permission_reason_is_not_reported_as_bad_key(self):
        for status, expected in [('quota_exceeded', 'закончились кредиты'), ('missing_permissions', 'нет нужных прав')]:
            body = {'detail': {'status': status, 'message': 'private provider diagnostics'}}
            with self.assertRaisesRegex(RuntimeError, expected) as caught:
                await self.transcribe(eleven_client(self.reply(401, json=body)))
            self.assertNotIn('private', str(caught.exception))

    async def test_timeout_connection_and_garbage_body(self):
        with self.assertRaisesRegex(RuntimeError, 'не ответил вовремя') as caught:
            await self.transcribe(eleven_client(error=httpx.ReadTimeout('private transport diagnostics')))
        self.assertNotIn('private', str(caught.exception))
        with self.assertRaisesRegex(RuntimeError, 'Нет соединения'):
            await self.transcribe(eleven_client(error=httpx.ConnectError('private')))
        with self.assertRaisesRegex(RuntimeError, 'непонятный ответ'):
            await self.transcribe(eleven_client(self.reply(200, content=b'<html>')))

    async def test_tts_returns_mp3_bytes_and_uses_voice_and_model(self):
        client = eleven_client(self.reply(200, content=b'ID3audio'))
        with patch.object(speech.httpx, 'AsyncClient', return_value=client):
            self.assertEqual(await speech.synthesize('Вопрос?'), b'ID3audio')
            with self.assertRaises(ValueError): await speech.synthesize('x' * 5001)
        call = client.post.call_args
        self.assertEqual(call.args[0], 'https://api.elevenlabs.io/v1/text-to-speech/voice-1')
        self.assertEqual(call.kwargs['params'], {'output_format': 'mp3_44100_128'})
        self.assertEqual(call.kwargs['json'], {'text': 'Вопрос?', 'model_id': 'eleven_multilingual_v2'})
        self.assertEqual(call.kwargs['headers'], {'xi-api-key': 'test-only-placeholder'})

    async def test_tts_failures_raise_safe_errors(self):
        with patch.object(speech.httpx, 'AsyncClient', return_value=eleven_client(self.reply(401, json={'detail': 'private'}))):
            with self.assertRaisesRegex(RuntimeError, 'отклонил ключ') as caught: await speech.synthesize('Вопрос?')
        self.assertNotIn('private', str(caught.exception))
        with patch.object(speech.config, 'ELEVENLABS_VOICE_ID', ''):
            with self.assertRaisesRegex(RuntimeError, 'ELEVENLABS_VOICE_ID'): await speech.synthesize('Вопрос?')

    async def test_mock_returns_test_text_and_tts_unavailable(self):
        with patch.multiple(speech.config, STT_MOCK=True, TTS_MOCK=True):
            self.assertEqual(await speech.transcribe(self.audio), speech.MOCK_TEXT)
            with self.assertRaises(RuntimeError): await speech.synthesize('Вопрос?')

    def test_tts_endpoint_maps_any_failure_to_503(self):
        client = TestClient(app)
        with patch.object(speech, 'synthesize', AsyncMock(side_effect=RuntimeError('private'))):
            r = client.get('/api/tts', params={'text': 'Вопрос?'})
        self.assertEqual(r.status_code, 503)
        self.assertNotIn('private', r.text)
        with patch.object(speech, 'synthesize', AsyncMock(return_value=b'ID3')):
            r = client.get('/api/tts', params={'text': 'Вопрос?'})
        self.assertEqual((r.status_code, r.headers['content-type'], r.content), (200, 'audio/mpeg', b'ID3'))


class ProviderSelectionTests(unittest.TestCase):
    """Значения по умолчанию задаёт config при импорте — проверяем в чистом процессе."""
    def resolve(self, **env):
        import json, subprocess, sys
        # config.py сам подгружает .env из корня; пустое значение в окружении его перекрывает (load_dotenv не переопределяет),
        # поэтому ключи и провайдеры обнуляем, а не удаляем — тест не должен зависеть от локального .env
        base = {k: v for k, v in os.environ.items() if not k.startswith(('ELEVENLABS_', 'STT_', 'TTS_', 'YANDEX_', 'MOCK', 'OPENROUTER_', 'LLM_'))}
        base |= {k: '' for k in ('ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'STT_PROVIDER', 'TTS_PROVIDER',
                                 'YANDEX_API_KEY', 'YANDEX_FOLDER_ID', 'OPENROUTER_API_KEY', 'LLM_PROVIDER', 'MOCK')}
        code = ("import json; from backend.app import config as c; "
                "print(json.dumps([c.STT_PROVIDER, c.TTS_PROVIDER, c.STT_MOCK, c.TTS_MOCK, c.ELEVENLABS_STT_MODEL]))")
        root = Path(__file__).resolve().parents[1]
        out = subprocess.run([sys.executable, '-c', code], cwd=root, env=base | env, capture_output=True, text=True, check=True)
        return json.loads(out.stdout)

    def test_defaults(self):
        self.assertEqual(self.resolve(), ['yandex', 'yandex', True, True, 'scribe_v2'])
        self.assertEqual(self.resolve(ELEVENLABS_API_KEY='k'), ['elevenlabs', 'elevenlabs', False, False, 'scribe_v2'])
        self.assertEqual(self.resolve(ELEVENLABS_API_KEY='k', MOCK='1')[2:4], [True, True])

    def test_explicit_switch_and_per_provider_key(self):
        self.assertEqual(self.resolve(ELEVENLABS_API_KEY='k', STT_PROVIDER='yandex', TTS_PROVIDER='elevenlabs'),
                         ['yandex', 'elevenlabs', True, False, 'scribe_v2'])
        self.assertEqual(self.resolve(YANDEX_API_KEY='k', YANDEX_FOLDER_ID='f', STT_PROVIDER='elevenlabs')[2], True)
        self.assertEqual(self.resolve(YANDEX_API_KEY='k', YANDEX_FOLDER_ID='f', STT_PROVIDER='bogus')[:3], ['yandex', 'yandex', False])


class HealthLiveSttTests(unittest.TestCase):
    def test_live_stt_only_with_yandex_key_and_no_mock(self):
        client = TestClient(app)
        for key, mock, expected in [('', False, False), ('k', True, False), ('k', False, True)]:
            with patch.multiple(speech.config, YANDEX_API_KEY=key, MOCK=mock):
                self.assertIs(client.get('/api/health').json()['live_stt'], expected)


if __name__ == '__main__': unittest.main()
