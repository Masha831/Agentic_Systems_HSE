"""Архивист — зона Максима. Извлекает людей, места, события и связи из ответа,
сопоставляет с уже известными, неоднозначное отправляет на подтверждение (clarify)."""
from __future__ import annotations

import json
import re

from .. import config
from ..models import ArchivistResult
from .base import Agent, dump

SYSTEM = """Ты — архивист семейной истории. Тебе дают один новый ответ рассказчика и всё, что уже известно:
людей, места и события с их id. Извлеки из ответа структурированные сведения.

Правила:
- refs — id УЖЕ ИЗВЕСТНЫХ людей и мест, которые упомянуты в ответе (в любой форме: «мама», «Нинка», «дядя Миша»).
- add.people / add.places — только ДЕЙСТВИТЕЛЬНО НОВЫЕ. id — латиница через дефис (например "galya", "aunt-shura").
  name — как называет рассказчик («тётя Шура»), role — кем приходится рассказчику или роль в истории.
  stem — 1–3 основы слова для поиска в тексте с учётом падежей: «Нина» → ["Нин"], «тётя Шура» → ["тётя Шура", "Шур"].
- Рассказчика в people не добавляй.
- Если новое имя совпадает с известным, но по смыслу это может быть другой человек (два Михаила: дядя и мастер) —
  НЕ объединяй молча: добавь нового человека и вопрос в clarify.
- add.events — значимые события из ответа. date — как сказано («осень 1962», «детство»), approx=true если неточно,
  dateNote — на чём основана дата («картошку уже выкопали»), sort — число для сортировки (1962.7; 0 если неизвестно).
  people/place — id (известные или из add).
- links — связи между людьми, ЯВНО сказанные в ответе: a, b — id, label — кем a приходится b («Сестра Анны»).
  Если рассказчик есть в известных людях (narrator=true), используй его id.
- clarify — вопросы для подтверждения неоднозначного: id "c-…", text — вопрос пользователю, yes/no — подписи кнопок,
  yesMsg/noMsg — что показать после ответа, apply.yes / apply.no — что применить:
  {"role": [personId, "новая роль"]} и/или {"links": [[a, b, "label"]]}.
- Ничего не выдумывай: только то, что сказано в ответе."""


def _slug_ok(s: str) -> str:
    s = re.sub(r"[^a-z0-9-]+", "-", s.lower()).strip("-")
    return s or "x"


class Archivist(Agent[ArchivistResult]):
    name = "archivist"
    system = SYSTEM
    result = ArchivistResult

    def build_prompt(self, ctx: dict) -> str:
        people = {id: {k: p.get(k) for k in ("name", "full", "role", "aka", "narrator") if p.get(k)} for id, p in ctx["people"].items()}
        places = {id: {"name": p["name"], "role": p.get("role", "")} for id, p in ctx["places"].items()}
        events = [{"id": e["id"], "title": e["title"], "date": e.get("date", "")} for e in ctx["events"]]
        s = ctx["story"]
        return (
            f"История: «{s['title']}». Рассказывает: {s['narrator']} ({s.get('relation') or 'рассказчик'}).\n\n"
            f"Известные люди:\n{dump(people)}\n\nИзвестные места:\n{dump(places)}\n\nСобытия:\n{dump(events)}\n\n"
            f"Вопрос: {ctx['question']}\nНОВЫЙ ОТВЕТ: {ctx['answer']}"
        )

    def mock(self, ctx: dict) -> ArchivistResult:
        """Без LLM — берём заготовленный ответ из сценария, если вопрос оттуда."""
        s = ctx["story"]
        seed = json.loads(config.SEED_PATH.read_text())
        script = seed["scripts"].get(s["id"]) or seed["scripts"].get(s["type"], [])
        for q in script:
            if q["text"] == ctx["question"]:
                return ArchivistResult.model_validate(q.get("answer", {}))
        return ArchivistResult()

    def postprocess(self, res: ArchivistResult, ctx: dict) -> ArchivistResult:
        """Новые id делаем уникальными глобально; ссылки на несуществующее выкидываем."""
        from .. import store
        all_people, all_places = store.list_("person"), store.list_("place")
        sid = ctx["story"]["id"]
        rename: dict[str, str] = {}

        def fresh(raw: str, taken: dict) -> str:
            base = _slug_ok(raw)
            cand = base if base not in taken else f"{sid}-{base}"
            i = 2
            while cand in taken or cand in rename.values():
                cand = f"{sid}-{base}-{i}"
                i += 1
            return cand

        for p in res.add.people:
            new = fresh(p.id, all_people)
            rename[p.id] = new
            p.id = new
        for p in res.add.places:
            new = fresh(p.id, all_places)
            rename[p.id] = new
            p.id = new
        known_p = set(ctx["people"]) | {p.id for p in res.add.people}
        known_l = set(ctx["places"]) | {p.id for p in res.add.places}
        r = lambda i: rename.get(i, i)  # noqa: E731
        res.refs.people = [r(i) for i in res.refs.people if r(i) in known_p]
        res.refs.places = [r(i) for i in res.refs.places if r(i) in known_l]
        for e in res.add.events:
            e.people = [r(i) for i in e.people if r(i) in known_p]
            e.place = r(e.place) if e.place and r(e.place) in known_l else None
        res.links = [l for l in res.links if r(l.a) in known_p and r(l.b) in known_p]
        for l in res.links:
            l.a, l.b = r(l.a), r(l.b)
        for c in res.clarify:
            for ap in c.apply.values():
                if "role" in ap:
                    ap["role"][0] = r(ap["role"][0])
                if "links" in ap:
                    ap["links"] = [[r(a), r(b), lab] for a, b, lab in ap["links"]]
        return res


archivist = Archivist()
