"""Paid semantic regression: real agents, isolated temporary DB, no mock fallback.
Run: .venv/bin/python -m backend.evals.run_self_reference
Synthetic cases only; user's real transcript is not stored here.
"""
import asyncio
import json
import os
import tempfile
from pathlib import Path

_tmp = tempfile.TemporaryDirectory(prefix='pomnu-reference-eval-')
os.environ['DB_PATH'] = str(Path(_tmp.name) / 'eval.sqlite')
os.environ['MEDIA_DIR'] = str(Path(_tmp.name) / 'media')
os.environ['MOCK'] = '0'

from backend.app import config, store
from backend.app.agents.archivist import archivist
from backend.app.agents.interviewer import interviewer
from backend.app.models import Story

CASES = [
    {'id': 'self-correction', 'answer': 'На фото я со своей первой любовью, то есть с собой, ха-ха. Это автопортрет.', 'people': []},
    {'id': 'stale-memory', 'answer': 'Моя первая любовь — я сама. Я шучу: на фотографии только я.', 'people': [], 'stale': True},
    {'id': 'real-person', 'answer': 'Моя первая любовь — Лёша. Мы познакомились в школе.', 'people': ['лёш']},
    {'id': 'self-and-friend', 'answer': 'Моя первая любовь — я сама, шучу. А рядом моя подруга Нина, мы знакомы со школы.', 'people': ['нин']},
    {'id': 'metaphor', 'answer': 'Моя первая любовь — музыка, а не человек. На снимке я играю на пианино.', 'people': []},
]

async def run(case):
    sid = 'eval-' + case['id']
    question = 'Что происходит на этом снимке?'
    s = Story(id=sid, type='love', title='Первая любовь', narrator='Рассказчица', relation='я').model_dump()
    s['interview']['question'] = {'text':question,'why':'','topic':'photo','topicTitle':'Фото'}
    s['interview']['asked'] = [question]
    store.put('story', sid, s)
    store.put('source',sid+'-1',{'story':sid,'session':1,'n':1,'q':question,'text':case['answer'],'people':[],'places':[]})
    if case.get('stale'):
        store.put('person',sid+'-wrong',{'story':sid,'name':'первая любовь','role':'партнёр рассказчицы'})
    ctx = store.story_context(sid) | {'story':s,'question':question,'answer':case['answer']}
    # Direct calls intentionally fail on API errors; mock cannot pass the evaluation.
    archive = archivist.postprocess(await archivist.call_llm(archivist.build_prompt(ctx),ctx),ctx)
    errors = []
    names = [p.name.lower() for p in archive.add.people]
    if len(names) != len(case['people']) or any(not any(stem in name for name in names) for stem in case['people']):
        errors.append('wrong people extraction')
    if not case['people'] and (archive.refs.people or archive.links):
        errors.append('invented person reference or relationship')
    if not case['people'] and any(e.people for e in archive.add.events):
        errors.append('event attached to invented person')
    for p in archive.add.people:
        store.put('person',p.id,{'story':sid,'name':p.name,'role':p.role})
    ctx = store.story_context(sid) | {'story':s,'event':'Пользователь ответил: '+case['answer']}
    result = interviewer.postprocess(await interviewer.call_llm(interviewer.build_prompt(ctx),ctx),ctx)
    q = result.question.text
    if not case['people']:
        for phrase in ['этому человеку','этим человеком','когда вы были вместе','возлюблен','как его зовут','ваш партнёр']:
            if phrase in q.lower(): errors.append('invented partner in question')
    if q.count('?') != 1: errors.append('expected one question')
    output = {'case':case['id'],'people':[p.name for p in archive.add.people],
              'events':[e.title for e in archive.add.events], 'question':q,'errors':errors}
    print(json.dumps(output,ensure_ascii=False),flush=True)
    return not errors

async def main():
    if not config.YANDEX_API_KEY: raise RuntimeError('Set YANDEX_API_KEY locally')
    results = [await run(case) for case in CASES]
    print(f'{sum(results)}/{len(results)} passed; semantic questions still need human review.',flush=True)
    if not all(results): raise SystemExit(1)

if __name__ == '__main__':
    try: asyncio.run(main())
    finally: _tmp.cleanup()
