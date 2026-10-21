"""Проверочные диалоги Интервьюера.

Запуск из корня: .venv/bin/python -m backend.evals.run_interviewer [case_id ...]
Использует отдельную БД backend/data/eval.sqlite3 и реальную LLM из .env (с MOCK=1 — сценарии-заглушки).
Автопроверки: один вопрос, нет повторов, нет запрещённых слов, есть ожидаемая зацепка. «expect» — смотреть глазами.
"""
import asyncio
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("DB_PATH", "backend/data/eval.sqlite3")
Path(os.environ["DB_PATH"]).unlink(missing_ok=True)

from backend.app import orchestrator, store  # noqa: E402

CASES = json.loads((Path(__file__).parent / "interviewer_cases.json").read_text())


def check(case: dict, q: str, asked: list[str]) -> list[str]:
    errs, low = [], q.lower()
    if q.count("?") > 2:
        errs.append("больше одного вопроса")
    if q in asked:
        errs.append("повтор вопроса")
    if low.startswith("расскажите, пожалуйста"):
        errs.append("шаблонное «Расскажите, пожалуйста»")
    if asked and q.split()[:2] == asked[-1].split()[:2]:
        errs.append("то же начало, что у прошлого вопроса")
    rel = case.get("narrator", "").lower()
    if rel and rel != "я" and low.startswith(rel):
        errs.append("обращение по родству")
    for w in case.get("must_not_mention", []):
        if w in low:
            errs.append(f"запрещено: «{w}»")
    return errs


async def run(case: dict) -> bool:
    s = await orchestrator.create_story({"type": "family", "title": case["title"], "narrator": case["narrator"], "relation": case["relation"]})
    sid, asked, ok = s["id"], [s["interview"]["question"]["text"]], True
    print(f"\n=== {case['id']}: {case['expect']}")
    print(f"  Q0: {asked[0]}")
    for i, a in enumerate(case["answers"], 1):
        print(f"  A{i}: {a}")
        if case.get("skip_declined_after") == i:
            r = await orchestrator.skip(sid, declined=True)
        else:
            r = await orchestrator.answer(sid, a)
        q = r["question"]["text"]
        errs = check(case, q, asked)
        if i == len(case["answers"]) and case.get("must_mention_any") and not any(w.lower() in q.lower() for w in case["must_mention_any"]):
            errs.append("нет ожидаемой зацепки")
        print(f"  Q{i}: {q}" + (f"   ❌ {', '.join(errs)}" if errs else "   ✓"))
        ok &= not errs
        asked.append(q)
    calls = [t.get("tool_calls") for t in store.list_("trace", sid).values() if t.get("tool_calls")]
    if calls:
        print(f"  память: {[c['tool'] for cs in calls for c in cs]}")
    return ok


async def main():
    only = set(sys.argv[1:])
    res = [await run(c) for c in CASES if not only or c["id"] in only]
    print(f"\nИтого: {sum(res)}/{len(res)} без автозамечаний")


if __name__ == "__main__":
    asyncio.run(main())
