"""Интервьюер — зона Маши. Выбирает следующий вопрос и ведёт план тем."""
from __future__ import annotations

import json

from .. import config
from ..models import InterviewerResult, Question, Topic
from .base import Agent, dump

SYSTEM = """Ты — бережный интервьюер, который помогает человеку рассказать его воспоминания.
Ты получаешь контекст истории: о чём она, кто рассказывает, план тем, уже известных людей, места, события,
все прошлые вопросы и ответы. Твоя задача — выбрать ОДИН следующий вопрос и обновить план тем.

Правила:
- Спрашивай по одному. Вопрос короткий, тёплый, разговорный, на «вы».
- Развивай конкретный эпизод, о котором человек только что рассказал, если в нём есть что раскрыть
  (кто был рядом, что видел, что почувствовал, чем закончилось).
- Не повторяй уже заданные вопросы и не спрашивай то, на что уже ответили.
- «Не помню» и «не хочу обсуждать» принимай спокойно. Темы со статусом declined больше не поднимай.
- Не подсказывай вымышленные детали и не задавай наводящих вопросов («Наверное, было холодно?» — нельзя).
- Не допрашивай о точных датах: «примерно когда» достаточно.
- Если человек упомянул нового человека или место мимоходом — это хороший повод для следующего вопроса.
- Если пользователь вернулся к истории после перерыва, начни с незаконченной темы и напомни, на чём остановились.

Статусы тем: done — рассказана, current — обсуждаем сейчас (ровно одна), later — на потом, declined — отказ.
topics — ПОЛНЫЙ обновлённый список тем (старые с новыми статусами + новые). id тем — латиница, через дефис.
question.topic — id текущей темы, question.topicTitle — её название, question.why — одна фраза,
почему задаёшь этот вопрос (её видит пользователь).
continueNote — одна фраза на случай, если разговор прервётся: что осталось нерассказанным."""


class Interviewer(Agent[InterviewerResult]):
    name = "interviewer"
    system = SYSTEM
    result = InterviewerResult
    temperature = 0.5

    def build_prompt(self, ctx: dict) -> str:
        s = ctx["story"]
        people = {id: {"name": p["name"], "role": p.get("role", "")} for id, p in ctx["people"].items()}
        places = {id: {"name": p["name"], "role": p.get("role", "")} for id, p in ctx["places"].items()}
        history = [
            {"session": x["session"], "q": x["q"], "a": x["text"]}
            for x in sorted(ctx["sources"].values(), key=lambda x: (x["session"], x["n"]))
        ]
        return (
            f"История: «{s['title']}». О чём: {s.get('about') or s['title']}. Тип: {s['type']}.\n"
            f"Рассказывает: {s['narrator']} ({s.get('relation') or 'рассказчик'}).\n"
            f"Сессия разговора №{s['interview']['session']}.\n\n"
            f"План тем:\n{dump(s.get('topics', []))}\n\n"
            f"Известные люди:\n{dump(people)}\n\nМеста:\n{dump(places)}\n\n"
            f"Вопросы и ответы (по порядку):\n{dump(history[-15:])}\n\n"
            f"Уже заданные вопросы в этой сессии:\n{dump(s['interview'].get('asked', []))}\n\n"
            f"Последнее действие пользователя: {ctx.get('event', 'начало сессии')}"
        )

    def mock(self, ctx: dict) -> InterviewerResult:
        """Без LLM — идём по сценарию из seed.json (scripts), как в прототипе."""
        s = ctx["story"]
        seed = json.loads(config.SEED_PATH.read_text())
        script = seed["scripts"].get(s["id"]) or seed["scripts"].get(s["type"], [])
        asked = set(s["interview"].get("asked", [])) | {x["q"] for x in ctx["sources"].values()}
        declined = {t["id"] for t in s.get("topics", []) if t["status"] == "declined"}
        for q in script:
            if q["text"] in asked or q.get("topic") in declined:
                continue
            if q.get("requires") and q["requires"] not in ctx["people"] and f"{s['id']}-{q['requires']}" not in ctx["people"]:
                continue
            return InterviewerResult(question=Question(text=q["text"], why=q.get("why", ""), topic=q.get("topic"), topicTitle=q.get("topicTitle", "")))
        return InterviewerResult(question=Question(text="Что ещё вам хочется вспомнить об этом времени?", why="Сценарий закончился — свободный вопрос.", topic="free", topicTitle="Свободный рассказ"))

    def postprocess(self, res: InterviewerResult, ctx: dict) -> InterviewerResult:
        s = ctx["story"]
        topics = res.topics or [Topic(**t) for t in s.get("topics", [])]
        # declined от пользователя не может перезаписать агент
        declined = {t["id"] for t in s.get("topics", []) if t["status"] == "declined"}
        for t in topics:
            if t.id in declined:
                t.status = "declined"
        q = res.question
        if q.topic and not any(t.id == q.topic for t in topics):
            topics.append(Topic(id=q.topic, title=q.topicTitle or "Тема", status="current"))
        for t in topics:
            if t.id == q.topic and t.status != "declined":
                t.status = "current"
            elif t.status == "current":
                t.status = "later"
        res.topics = topics
        return res


interviewer = Interviewer()
