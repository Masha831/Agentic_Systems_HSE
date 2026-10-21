"""Оркестратор: порядок работы агентов. Зона Маши.

Ответ пользователя → (1) сохраняем оригинал Source → (2) Архивист обновляет людей/места/события
→ (3) Интервьюер выбирает следующий вопрос. Редактор — по кнопке «Собрать главу».
"""
from __future__ import annotations

import json
import time
import uuid
from typing import Optional

from . import config, store
from .agents.archivist import archivist
from .agents.editor import editor
from .agents.interviewer import interviewer
from .models import Question, Story


def _story(sid: str) -> dict:
    s = store.get("story", sid)
    if not s:
        raise KeyError(sid)
    return Story.model_validate(s).model_dump()  # дозаполняет поля по умолчанию (interview и т.п.)


def _set_topic(s: dict, tid: Optional[str], status: str, title: str = "") -> None:
    if not tid:
        return
    for t in s["topics"]:
        if t["id"] == tid:
            if t["status"] != "declined":
                t["status"] = status
            return
    s["topics"].append({"id": tid, "title": title or "Тема", "status": status})


async def next_question(s: dict, event: str) -> dict:
    """Интервьюер → вопрос; план тем и continueNote сохраняются в историю."""
    ctx = store.story_context(s["id"]) | {"story": s, "event": event}
    res = await interviewer.run(ctx)
    s["topics"] = [t.model_dump() for t in res.topics]
    if res.continueNote:
        s["continueNote"] = res.continueNote
    q = res.question.model_dump()
    s["interview"]["question"] = q
    s["interview"]["asked"].append(q["text"])
    store.put("story", s["id"], s)
    return q


async def create_story(data: dict) -> dict:
    sid = f"n{uuid.uuid4().hex[:8]}"
    seed = json.loads(config.SEED_PATH.read_text())
    s = Story(
        id=sid, type=data.get("type", "family"), title=data["title"], about=data.get("about", ""),
        narrator=data["narrator"], relation=data.get("relation", ""), cover=data.get("cover"),
    ).model_dump()
    store.put("story", sid, s)
    if s["cover"]:
        # начали с фото — первый вопрос про него
        q = Question(text=seed["types"][s["type"]]["photoQuestion"], why="Вы начали с фото — с него и начнём.", topic="photo", topicTitle="Фото").model_dump()
        s["interview"]["question"] = q
        s["interview"]["asked"].append(q["text"])
        s["interview"]["photo"] = s["cover"]
        store.put("story", sid, s)
    else:
        await next_question(s, "Пользователь создал историю. Задай первый вопрос.")
    return store.get("story", sid)


async def get_question(sid: str) -> dict:
    s = _story(sid)
    if s["interview"].get("question"):
        return s["interview"]["question"]
    return await next_question(s, "Пользователь вернулся к истории после перерыва. Продолжи с незаконченной темы.")


async def answer(sid: str, text: str, typed: bool = False, edited: bool = False, audio: Optional[str] = None,
                 dur: str = "0:00", photo: Optional[dict] = None) -> dict:
    s = _story(sid)
    q = s["interview"].get("question") or await get_question(sid)
    s = _story(sid)
    session = s["interview"]["session"]
    n = sum(1 for x in store.list_("source", sid).values() if x["session"] == session) + 1
    src_id = f"{sid}-{session}-{n}"
    photo = photo or s["interview"].pop("photo", None)

    # 1. оригинал сохраняется до любых агентов
    src = {"story": sid, "session": session, "n": n, "date": time.strftime("%d.%m"), "q": q["text"],
           "dur": dur, "text": text, "typed": typed, "edited": edited, "audio": audio, "photo": photo,
           "people": [], "places": []}
    store.put("source", src_id, src)

    # 2. архивист
    ctx = store.story_context(sid) | {"story": s, "question": q["text"], "answer": text}
    res = await archivist.run(ctx)
    added = {"people": {}, "places": {}, "events": []}
    for p in res.add.people:
        obj = {"story": sid, "name": p.name, "full": p.name, "role": p.role, "stem": p.stem, "aka": [], "note": "", "links": []}
        store.put("person", p.id, obj)
        added["people"][p.id] = obj
    for p in res.add.places:
        obj = {"story": sid, "name": p.name, "role": p.role, "stem": p.stem, "note": ""}
        store.put("place", p.id, obj)
        added["places"][p.id] = obj
    for e in res.add.events:
        eid = e.id if not store.get("event", e.id) else f"{sid}-{e.id}-{uuid.uuid4().hex[:4]}"
        obj = e.model_dump() | {"id": eid, "story": sid, "src": [src_id]}
        store.put("event", eid, obj)
        added["events"].append(obj)
    for l in res.links:
        p = store.get("person", l.a)
        if p and not any(x["to"] == l.b and x["label"] == l.label for x in p["links"]):
            p["links"].append({"to": l.b, "label": l.label, "src": src_id})
            store.put("person", l.a, p)
    src["people"] = [i for i in dict.fromkeys(res.refs.people + [p.id for p in res.add.people])
                     if not (store.get("person", i) or {}).get("narrator")]
    src["places"] = list(dict.fromkeys(res.refs.places + [p.id for p in res.add.places]))
    store.put("source", src_id, src)
    for c in res.clarify:
        if not any(x["id"] == c.id for x in s["clarify"]):
            s["clarify"].append(c.model_dump() | {"src": src_id})

    # 3. интервьюер
    _set_topic(s, q.get("topic"), "done", q.get("topicTitle", ""))
    s["interview"]["turns"].append({"q": q["text"], "src": src_id, "topicTitle": q.get("topicTitle", "")})
    s["interview"]["question"] = None
    s["updated"] = "только что"
    store.put("story", sid, s)
    nq = await next_question(s, f"Пользователь ответил на вопрос «{q['text']}»: {text}")
    return {"sourceId": src_id, "source": src, "added": added, "question": nq, "story": store.get("story", sid)}


async def skip(sid: str, declined: bool) -> dict:
    s = _story(sid)
    q = s["interview"].get("question") or {}
    _set_topic(s, q.get("topic"), "declined" if declined else "later", q.get("topicTitle", ""))
    s["interview"]["turns"].append({"q": q.get("text", ""), "skipped": not declined, "declined": declined})
    s["interview"]["question"] = None
    store.put("story", sid, s)
    ev = "Пользователь отказался обсуждать эту тему" if declined else "Пользователь отложил вопрос"
    nq = await next_question(s, f"{ev}: «{q.get('text', '')}»")
    return {"question": nq, "story": store.get("story", sid)}


def resolve_clarify(sid: str, cid: str, value: str) -> dict:
    s = _story(sid)
    c = next((x for x in s["clarify"] if x["id"] == cid), None)
    if not c:
        raise KeyError(cid)
    c["resolved"] = value
    ap = (c.get("apply") or {}).get(value) or {}
    if ap.get("role"):
        pid, role = ap["role"]
        p = store.get("person", pid)
        if p:
            store.put("person", pid, p | {"role": role})
    for a, b, label in ap.get("links", []):
        p = store.get("person", a)
        if p and store.get("person", b):
            p["links"].append({"to": b, "label": label, "src": c.get("src")})
            store.put("person", a, p)
    if ap.get("note"):
        pid, note = ap["note"]
        pl = store.get("place", pid)
        if pl:
            store.put("place", pid, pl | {"note": note})
    store.put("story", sid, s)
    return {"story": s, "people": store.list_("person", sid), "places": store.list_("place", sid)}


async def assemble(sid: str) -> dict:
    s = _story(sid)
    session = s["interview"]["session"]
    srcs = {id: x for id, x in store.list_("source", sid).items() if x["session"] == session}
    if not srcs:
        raise ValueError("В этой сессии ещё нет ответов")
    ctx = store.story_context(sid) | {"story": s, "session_sources": srcs}
    res = await editor.run(ctx)
    k = len(s["chapters"]) + 1
    cid = f"{sid}-ch{k}"
    open_topic = next((t for t in s["topics"] if t["status"] in ("current", "later")), None)
    ch = {"story": sid, "n": k, "title": res.title, "sources": list(srcs),
          "blocks": [b.model_dump(exclude_none=True) for b in res.blocks],
          "open": f"Тема «{open_topic['title']}» ещё не рассказана — агент спросит о ней в следующей сессии." if open_topic else None,
          "openTopic": open_topic["id"] if open_topic else None}
    store.put("chapter", cid, ch)
    s["chapters"].append(cid)
    s["sessions"].append({"n": session, "date": time.strftime("%d.%m"), "answers": len(srcs)})
    s["interview"] = {"session": session + 1, "question": None, "asked": [], "turns": []}
    s["updated"] = "только что"
    store.put("story", sid, s)
    return {"chapterId": cid, "chapter": ch, "story": s}
