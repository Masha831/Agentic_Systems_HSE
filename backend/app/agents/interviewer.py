"""Интервьюер — зона Маши. Выбирает следующий вопрос и ведёт план тем.

Инструкции — prompts/interviewer.md. Контекст разговора — build_interview_context().
Во время размышления агент может обращаться к памяти (memory.TOOLS) — до MAX_TOOL_CALLS раз.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, Field

from .. import config, llm, memory
from ..models import InterviewerResult, Question, Topic
from .base import Agent, dump

PROMPT = (Path(__file__).parent / "prompts" / "interviewer.md").read_text()
MAX_TOOL_CALLS = 3


class InterviewerStep(BaseModel):
    """Один шаг агента: либо вызов памяти, либо итоговый ответ."""
    tool: Optional[str] = Field(None, description="имя инструмента памяти, если нужны сведения; иначе null")
    args: dict = Field(default_factory=dict)
    final: Optional[InterviewerResult] = Field(None, description="итог, когда сведений достаточно")


def build_interview_context(story: dict, event: str) -> dict:
    """Подготовка к разговору: рассказчик, прошлые беседы, незавершённые темы, известные люди и места."""
    from .. import store
    sid = story["id"]
    people = {id: {"name": p["name"], "role": p.get("role", "")} for id, p in store.list_("person", sid).items()}
    places = {id: p["name"] for id, p in store.list_("place", sid).items()}
    return {
        "story": {"title": story["title"], "about": story.get("about") or story["title"], "type": story["type"]},
        "narrator": {"name": story["narrator"], "relation": story.get("relation") or "рассказчик",
                     "address": story.get("narratorAddress", ""),
                     "gender": {"f": "она", "m": "он"}.get(story.get("narratorGender", ""), "неизвестно")},
        "session": story["interview"]["session"],
        "past_sessions": story.get("sessions", []),
        "continue_note": story.get("continueNote", ""),
        "topics": story.get("topics", []),
        "open_topics": memory.open_topics(sid),
        "declined_topics": [t["title"] for t in story.get("topics", []) if t["status"] == "declined"],
        "people": people,
        "places": places,
        "recent_answers": memory.recent_answers(sid, 8),
        "asked_this_session": story["interview"].get("asked", []),
        "last_event": event,
    }


def tidy_question(q: str) -> str:
    """Страховка поверх промпта: без анкетного зачина и ровно один вопрос. Обращение в начале сохраняется."""
    q = q.strip()
    m = re.match(r"^(?P<addr>[^,?!.]{1,40},\s+)?(?P<ask>(Расскажите|Скажите|Подскажите),?\s+пожалуйста,?\s+)"
                 r"(?=(как|что|кто|где|когда|почему|зачем|как[а-я]+|чем|сколько)\b)", q, re.I)
    if m:
        rest = q[m.end():]
        q = (m.group("addr") or "") + (rest if m.group("addr") else rest[0].upper() + rest[1:])
    else:
        q = re.sub(r"(Расскажите|Скажите),?\s+пожалуйста,?\s+", r"\1 ", q, count=1, flags=re.I)
    first = re.split(r"(?<=\?)\s+", q)[0]
    return first if first.endswith("?") else q


class Interviewer(Agent[InterviewerResult]):
    name = "interviewer"
    system = PROMPT
    result = InterviewerResult
    temperature = 0.5

    def build_prompt(self, ctx: dict) -> str:
        c = build_interview_context(ctx["story"], ctx.get("event", "начало сессии"))
        ctx["interview_context"] = c
        return f"Контекст разговора:\n{dump(c)}"

    async def call_llm(self, prompt: str, ctx: dict) -> InterviewerResult:
        """Агентный цикл: модель может несколько раз спросить память, потом выдаёт вопрос."""
        tools = "\n".join(f"- {d}" for d in memory.TOOLS.values())
        system = f"{self.system}\n\nИнструменты памяти:\n{tools}\n\nНа каждом шаге верни либо tool+args, либо final."
        transcript = prompt
        ctx["tool_calls"] = []
        for _ in range(MAX_TOOL_CALLS):
            step = await llm.structured(system, transcript, InterviewerStep, temperature=self.temperature, model=self.model)
            if step.final:
                return step.final
            if not step.tool:
                break
            out = memory.call(step.tool, step.args, ctx["story"]["id"])
            ctx["tool_calls"].append({"tool": step.tool, "args": step.args, "result": out})
            transcript += f"\n\nВызов {step.tool}({json.dumps(step.args, ensure_ascii=False)}) вернул:\n{dump(out)}"
        return await llm.structured(self.system, transcript + "\n\nСведений достаточно — дай итог.", InterviewerResult, temperature=self.temperature, model=self.model)

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
        res.question.text = tidy_question(res.question.text)
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
