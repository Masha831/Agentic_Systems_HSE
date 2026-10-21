"""Хранилище: SQLite, одна таблица документов (kind, id, story, data JSON).

Зона Максима: можно нормализовать в таблицы, но интерфейс (get/put/list/delete/state)
должны сохраниться — на нём сидят агенты и API.
"""
from __future__ import annotations

import json
import sqlite3
import threading
from typing import Any, Optional

from . import config

KINDS = ("story", "person", "place", "event", "source", "chapter")

_lock = threading.Lock()
_conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
_conn.execute(
    "CREATE TABLE IF NOT EXISTS docs (kind TEXT, id TEXT, story TEXT, data TEXT, "
    "seq INTEGER PRIMARY KEY AUTOINCREMENT, UNIQUE(kind, id))"
)
_conn.commit()


def get(kind: str, id: str) -> Optional[dict]:
    row = _conn.execute("SELECT data FROM docs WHERE kind=? AND id=?", (kind, id)).fetchone()
    return json.loads(row[0]) if row else None


def put(kind: str, id: str, data: dict, story: Optional[str] = None) -> dict:
    story = story or data.get("story") or (id if kind == "story" else None)
    with _lock:
        _conn.execute(
            "INSERT INTO docs (kind, id, story, data) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(kind, id) DO UPDATE SET story=excluded.story, data=excluded.data",
            (kind, id, story, json.dumps(data, ensure_ascii=False)),
        )
        _conn.commit()
    return data


def list_(kind: str, story: Optional[str] = None) -> dict[str, dict]:
    if story is None:
        rows = _conn.execute("SELECT id, data FROM docs WHERE kind=? ORDER BY seq", (kind,))
    else:
        rows = _conn.execute("SELECT id, data FROM docs WHERE kind=? AND story=? ORDER BY seq", (kind, story))
    return {id: json.loads(d) for id, d in rows.fetchall()}


def delete(kind: str, id: str) -> None:
    with _lock:
        _conn.execute("DELETE FROM docs WHERE kind=? AND id=?", (kind, id))
        _conn.commit()


def delete_story(story: str) -> None:
    with _lock:
        _conn.execute("DELETE FROM docs WHERE story=?", (story,))
        _conn.commit()


def seed_if_empty() -> None:
    if _conn.execute("SELECT 1 FROM docs LIMIT 1").fetchone():
        return
    d = json.loads(config.SEED_PATH.read_text())
    for s in d["stories"]:
        s.setdefault("interview", {"session": len(s["sessions"]) + 1, "question": None, "asked": [], "turns": []})
        put("story", s["id"], s)
    for id, p in d["people"].items():
        put("person", id, p)
    for id, p in d["places"].items():
        put("place", id, p)
    for e in d["events"]:
        put("event", e["id"], e)
    for id, x in d["sources"].items():
        put("source", id, x)
    for id, c in d["chapters"].items():
        put("chapter", id, c)


def story_context(story: str) -> dict[str, Any]:
    """Всё, что известно об истории, — контекст для агентов."""
    return {
        "story": get("story", story),
        "people": list_("person", story),
        "places": list_("place", story),
        "events": list(list_("event", story).values()),
        "sources": list_("source", story),
        "chapters": list_("chapter", story),
    }


def state() -> dict[str, Any]:
    """Полное состояние в формате window.POMNU (frontend/assets/data.js)."""
    d = json.loads(config.SEED_PATH.read_text())
    stories = list(list_("story").values())
    stories.reverse()  # новые сверху
    return {
        "user": d["user"],
        "types": d["types"],
        "stories": stories,
        "people": list_("person"),
        "places": list_("place"),
        "events": list(list_("event").values()),
        "sources": list_("source"),
        "chapters": list_("chapter"),
    }
