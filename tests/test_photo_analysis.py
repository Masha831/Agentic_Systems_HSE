"""Temporary storage; no network or paid requests."""
import asyncio
import io
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import AsyncMock, patch

TEST_DIR = tempfile.TemporaryDirectory()
os.environ['MOCK'] = '1'
os.environ['DB_PATH'] = str(Path(TEST_DIR.name) / 'photos.sqlite')
os.environ['MEDIA_DIR'] = str(Path(TEST_DIR.name) / 'media')
from PIL import Image
from fastapi.testclient import TestClient
from backend.app import config, store, photo_analysis as photos, orchestrator
from backend.app.main import app
from backend.app.agents.interviewer import build_interview_context, interviewer
from backend.app.models import InterviewerResult, Question

OBS = photos.Observation(summary='Красная чашка стоит на столе рядом с синей книгой.', details=['Красная чашка', 'Синяя книга'])


def image_bytes():
    b = io.BytesIO()
    img = Image.new('RGB', (2000, 1000), 'red')
    exif = Image.Exif(); exif[270] = 'private metadata'
    img.save(b, 'JPEG', exif=exif)
    return b.getvalue()


def local_photo():
    name = uuid.uuid4().hex + '.jpg'
    data = image_bytes()
    (config.MEDIA_DIR / name).write_bytes(data)
    return {'src': '/media/' + name, 'w': 2000, 'h': 1000, 'alt': ''}, data


class PhotoTests(unittest.IsolatedAsyncioTestCase):
    async def test_cache_concurrent_calls_resize_strip_metadata_keep_original(self):
        photo, original = local_photo()
        with patch.object(config, 'MOCK', False), patch.object(photos, 'describe', AsyncMock(return_value=OBS)) as model:
            results = await asyncio.gather(photos.analyze(photo), photos.analyze(photo))
            self.assertEqual(model.await_count, 1)
            self.assertEqual(results[0]['status'], 'ready')
            sent = model.call_args.args[0]
        with Image.open(io.BytesIO(sent)) as im:
            self.assertEqual(im.size, (1536, 768))
            self.assertFalse(im.getexif())
        self.assertEqual((config.MEDIA_DIR / photo['src'].split('/')[-1]).read_bytes(), original)

    async def test_rejects_urls_traversal_symlinks_without_provider_call(self):
        photo, _ = local_photo()
        link = config.MEDIA_DIR / (uuid.uuid4().hex + '.jpg')
        link.symlink_to(config.MEDIA_DIR / photo['src'].split('/')[-1])
        with patch.object(config, 'MOCK', False), patch.object(photos, 'describe', AsyncMock()) as model:
            for src in ('https://example.com/a.jpg', '/media/../.env', '/media/' + link.name):
                self.assertEqual((await photos.analyze({'src': src}))['status'], 'unavailable')
            model.assert_not_awaited()

    async def test_failure_cooldown_retry_and_no_fake_observation(self):
        photo, _ = local_photo()
        with patch.object(config, 'MOCK', False), patch.object(photos, 'describe', AsyncMock(side_effect=TimeoutError('private'))) as model:
            first = await photos.analyze(photo)
            again = await photos.analyze(photo)
            self.assertEqual(model.await_count, 1)
            self.assertEqual(first, again)
            self.assertNotIn('private', str(first))
            self.assertNotIn('observation', first)
        with patch.object(config, 'MOCK', False), patch.object(photos, 'RETRY_AFTER', 0), patch.object(photos, 'describe', AsyncMock(return_value=OBS)):
            self.assertEqual((await photos.analyze(photo))['status'], 'ready')

    async def test_context_uses_server_cache_and_source_id_not_client_claims(self):
        photo, _ = local_photo()
        sid = uuid.uuid4().hex
        story = {'id': sid, 'interview': {'photo': photo}, 'title': 'Тест', 'type': 'family', 'narrator': 'Тест'}
        photo['analysis'] = {'observation': {'summary': 'Invented relative'}}
        store.put('source', sid + '-1', {'story': sid, 'photo': photo, 'text': 'Это мой снимок', 'q': 'Что это?', 'session': 1, 'n': 1})
        with patch.object(config, 'MOCK', False), patch.object(photos, 'describe', AsyncMock(return_value=OBS)):
            await photos.prepare(story)
            context = photos.interview_context(story)
            self.assertEqual(len(context), 1)
            self.assertNotIn('Invented', str(context))
            story['interview']['photo'] = None
            self.assertEqual(photos.interview_context(story)[0]['source_id'], sid + '-1')
            self.assertEqual(photos.interview_context({'id': 'different', 'interview': {}}), [])

    async def test_explicit_removal_and_replacement_clear_pending_photo(self):
        for replacement in (None, local_photo()[0]):
            old, _ = local_photo()
            s = await orchestrator.create_story({'title': 'Тест', 'narrator': 'Тест'})
            s['interview']['question'] = {'text': 'Что на снимке?', 'topic': 'photo'}
            s['interview']['photo'] = old
            store.put('story', s['id'], s)
            r = await orchestrator.answer(s['id'], 'Ответ', typed=True, photo=replacement, photo_provided=True)
            self.assertEqual((r['source']['photo'] or {}).get('src'), (replacement or {}).get('src'))
            self.assertIsNone(r['story']['interview'].get('photo'))
            r2 = await orchestrator.answer(s['id'], 'Следующий ответ', typed=True)
            self.assertIsNone(r2['source']['photo'])

    async def test_intro_photo_question_uses_analysis_and_answer_context_keeps_photo(self):
        photo, _ = local_photo()
        s = await orchestrator.create_story({'title': 'Тест', 'narrator': 'Тест', 'cover': photo})
        self.assertEqual(s['interview']['question']['topic'], 'intro')
        contexts = []
        async def ask(ctx):
            contexts.append(build_interview_context(ctx['story'], ctx['event']))
            return InterviewerResult(question=Question(text='Чем вам запомнилась эта чашка?', topic='photo'))
        with patch.object(config, 'MOCK', False), patch.object(photos, 'describe', AsyncMock(return_value=OBS)), patch.object(orchestrator, '_intro', AsyncMock(side_effect=lambda s, text: s)), patch.object(interviewer, 'run', side_effect=ask), patch.object(orchestrator.archivist, 'run', AsyncMock(return_value=orchestrator.ArchivistResult())):
            r = await orchestrator.answer(s['id'], 'Меня зовут Тест', typed=True)
            self.assertEqual(contexts[-1]['photos'][0]['observation'], OBS.model_dump())
            self.assertEqual(r['story']['interview']['photo']['src'], photo['src'])
            r = await orchestrator.answer(s['id'], 'Чашку мне подарил друг', typed=True)
            self.assertEqual(r['source']['photo']['src'], photo['src'])
            self.assertEqual(contexts[-1]['photos'][0]['source_id'], r['sourceId'])
            self.assertEqual(r['source']['text'], 'Чашку мне подарил друг')
            self.assertEqual(r['added']['people'], {})


class PhotoHTTPTests(unittest.TestCase):
    def test_upload_returns_photo_on_analysis_failure(self):
        original = image_bytes()
        with TestClient(app) as client, patch.object(config, 'MOCK', False), patch.object(photos, 'describe', AsyncMock(side_effect=RuntimeError('provider private'))):
            r = client.post('/api/uploads', files={'file': ('image.jpg', original, 'image/jpeg')})
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json()['analysis']['status'], 'unavailable')
            self.assertEqual(client.get(r.json()['src']).content, original)

    def test_demo_does_not_fake_photo_description(self):
        with TestClient(app) as client, patch.object(config, 'MOCK', True), patch.object(photos, 'describe', AsyncMock()) as model:
            r = client.post('/api/uploads', files={'file': ('image.jpg', image_bytes(), 'image/jpeg')})
            self.assertEqual(r.json()['analysis']['status'], 'disabled')
            self.assertNotIn('observation', r.json()['analysis'])
            model.assert_not_awaited()
