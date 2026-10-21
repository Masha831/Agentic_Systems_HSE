"""Полная сессия на реальной LLM: ответы → глава (Редактор) → возвращение после перерыва (Интервьюер).

Запуск из корня: .venv/bin/python -m backend.evals.run_session
Проверки: цитаты дословные, токены [[p:..]] только на существующих людей, после перерыва вопрос про незаконченную тему.
"""
import asyncio
import os
import re
from pathlib import Path

os.environ.setdefault("DB_PATH", "backend/data/eval_session.sqlite3")
Path(os.environ["DB_PATH"]).unlink(missing_ok=True)

from backend.app import orchestrator, store  # noqa: E402

ANSWERS = [
    "Жили мы в Вологде с мамой и младшей сестрой Ниной. Я после училища всё думала уехать, а дядя Миша, мамин брат, звал в Ленинград.",
    "Мама поплакала, конечно. А Нина сразу сказала: езжай, я тебе свой чемодан отдам. Синий такой, фанерный, с уголками.",
    "Уехала в шестьдесят третьем… нет, в шестьдесят втором, осенью. Картошку уже выкопали.",
    "В поезде напротив сидел парень, Виктор, из армии ехал. Всю ночь про Ленинград рассказывал, будто сам его построил.",
]
TOK = re.compile(r"\[\[(p|l):([^|\]]+)\|([^\]]+)\]\]")


async def main():
    s = await orchestrator.create_story({"type": "family", "title": "Как бабушка переехала в Ленинград",
                                         "narrator": "Анна Сергеевна", "relation": "бабушка"})
    sid = s["id"]
    print("Знакомство:", s["interview"]["question"]["text"])
    r = await orchestrator.answer(sid, "Анна Сергеевна меня зовут. Я родилась в Вологде.")
    st = store.get("story", sid)
    print(f"   → имя={st['narratorName']!r}, обращение={st['narratorAddress']!r}, род={st['narratorGender']!r}")
    print("Q0:", r["question"]["text"])
    for i, a in enumerate(ANSWERS, 1):
        r = await orchestrator.answer(sid, a)
        print(f"A{i}: {a}\n   + люди: {[p['name'] for p in r['added']['people'].values()]}  места: {[p['name'] for p in r['added']['places'].values()]}")
        print(f"Q{i}: {r['question']['text']}")

    ch = (await orchestrator.assemble(sid))["chapter"]
    people, places, srcs = store.list_("person", sid), store.list_("place", sid), store.list_("source", sid)
    print(f"\n=== Глава «{ch['title']}»")
    errs = []
    for b in ch["blocks"]:
        print(f"[{b['t']}] {b.get('text', '')}" + (f"  (note: {b['note']})" if b.get("note") else ""))
        for k, id, _ in TOK.findall(b.get("text", "")):
            if id not in (people if k == "p" else places):
                errs.append(f"токен на несуществующий {id}")
        if b["t"] == "quote" and b.get("src") in srcs and b["text"].strip("«»\" .").lower() not in srcs[b["src"]]["text"].lower():
            errs.append(f"цитата не дословная: {b['text']}")
    print("ошибки главы:", errs or "нет")

    q = await orchestrator.get_question(sid)
    st = store.get("story", sid)
    print(f"\n=== После перерыва\nТемы: {[(t['title'], t['status']) for t in st['topics']]}\ncontinueNote: {st['continueNote']}\nQ: {q['text']}\n   why: {q['why']}")


asyncio.run(main())
