"""Память архива — интерфейс для агентов. Реализация — зона Максима.

Агенты ходят в память ТОЛЬКО через эти функции. Сигнатуры и формы ответа не менять без согласования;
внутри можно подключить что угодно (Hindsight, векторный поиск, графы).
"""
from __future__ import annotations

from . import store


def find_person(story: str, name: str) -> list[dict]:
    """Люди истории, похожие на имя: по name/full/aka/stem, без учёта регистра и падежа (по основе)."""
    q = name.lower().strip()
    out = []
    for id, p in store.list_("person", story).items():
        keys = [p["name"], p.get("full", ""), *p.get("aka", []), *p.get("stem", [])]
        if any(k and (q in k.lower() or k.lower() in q) for k in keys):
            out.append({"id": id, "name": p["name"], "role": p.get("role", ""), "aka": p.get("aka", [])})
    return out


def get_person(id: str) -> dict | None:
    """Карточка человека: роль, заметка, связи и ответы, где он упоминается."""
    p = store.get("person", id)
    if not p:
        return None
    mentions = [{"q": x["q"], "a": x["text"]} for x in store.list_("source", p["story"]).values() if id in x.get("people", [])]
    return {"id": id, "name": p["name"], "role": p.get("role", ""), "note": p.get("note", ""),
            "links": p.get("links", []), "mentions": mentions[-5:]}


def list_events(story: str) -> list[dict]:
    """Хронология истории."""
    evs = sorted(store.list_("event", story).values(), key=lambda e: e.get("sort") or 9999)
    return [{"id": e["id"], "title": e["title"], "date": e.get("date", ""), "people": e.get("people", [])} for e in evs]


def open_topics(story: str) -> list[dict]:
    """Незавершённые темы интервью (current/later) — то, к чему стоит вернуться."""
    s = store.get("story", story) or {}
    return [t for t in s.get("topics", []) if t["status"] in ("current", "later")]


def recent_answers(story: str, n: int = 6) -> list[dict]:
    """Последние ответы рассказчика по порядку."""
    xs = sorted(store.list_("source", story).values(), key=lambda x: (x["session"], x["n"]))
    return [{"session": x["session"], "q": x["q"], "a": x["text"]} for x in xs[-n:]]


# Описание инструментов для LLM (имя → описание аргументов). Вызов — memory.call(name, args, story).
TOOLS = {
    "find_person": "find_person(name) — найти уже известных людей по имени или прозвищу («Нинка», «дядя Миша»)",
    "get_person": "get_person(id) — карточка человека: роль, связи, где упоминался",
    "list_events": "list_events() — хронология событий истории",
    "open_topics": "open_topics() — незаконченные темы интервью",
}


def call(name: str, args: dict, story: str):
    if name == "find_person":
        return find_person(story, str(args.get("name", "")))
    if name == "get_person":
        return get_person(str(args.get("id", "")))
    if name == "list_events":
        return list_events(story)
    if name == "open_topics":
        return open_topics(story)
    return {"error": f"нет инструмента {name}"}
