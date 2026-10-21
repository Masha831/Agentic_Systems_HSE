"""Повтор HTTP-запроса не должен создавать второй Source или запускать агентов дважды."""
import asyncio
import hashlib
import json
import re
from fastapi import HTTPException
from . import store, orchestrator

# Демонстрационный сервер запускается одним процессом, без --workers.
_locks: dict[str, asyncio.Lock] = {}

async def deliver(sid: str, payload: dict, key: str):
    if not re.fullmatch(r'[A-Za-z0-9_-]{8,100}', key):
        raise HTTPException(400, 'Некорректный Idempotency-Key')
    fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    request_id = hashlib.sha256(f'{sid}:{key}'.encode()).hexdigest()
    async with _locks.setdefault(sid, asyncio.Lock()):
        existing = store.get('answer_request', request_id)
        if existing:
            if existing['fingerprint'] != fingerprint:
                raise HTTPException(409, 'Этот ключ уже использован для другого ответа')
            if existing['status'] == 'done':
                return existing['result']
            detail = {'message': 'Предыдущий запрос не завершён. Повторное создание ответа остановлено.'}
            if existing.get('sourceId'):
                detail['sourceId'] = existing['sourceId']
            raise HTTPException(409, detail)
        if not store.get('story', sid):
            raise HTTPException(404, 'История не найдена')
        before = set(store.list_('source', sid))
        record = {'fingerprint': fingerprint, 'status': 'pending', 'story': sid}
        store.put('answer_request', request_id, record)
        try:
            result = await orchestrator.answer(sid, **payload)
        except Exception:
            new_ids = set(store.list_('source', sid)) - before
            if new_ids:
                record.update(status='failed', sourceId=sorted(new_ids)[0])
                store.put('answer_request', request_id, record)
                raise HTTPException(502, {'message': 'Ответ сохранён, но обработка агентами не завершилась.', 'sourceId': record['sourceId']})
            store.delete('answer_request', request_id)
            raise HTTPException(502, 'Не удалось обработать ответ. Можно повторить.')
        record.update(status='done', result=result)
        store.put('answer_request', request_id, record)
        return result
