"""Редактор — собирает главу из ответов сессии. Зона Маши (вторая очередь)."""
from __future__ import annotations

import re

from ..models import EditorResult, StoryBlock
from .base import Agent, dump

SYSTEM = """Ты — литературный редактор семейной истории. Из ответов рассказчика собери читаемую главу.

Правила:
- Называй рассказчика по имени (как в «Рассказывает»), не «рассказчица» и не «рассказчик».
  Согласуй глаголы с родом рассказчика («уехала» / «уехал»); если род неизвестен — строй фразы без рода.
- Если рассказчик поправился, в тексте только исправленный вариант, а сама оговорка — в "note".
- Это пересказ, а не стенограмма: пиши от третьего лица о рассказчике (от первого — только если relation="я").
  Не копируй ответ целиком. «Мама поплакала, конечно» → «Мама, конечно, поплакала».
- Сохраняй выражения и словечки рассказчика; самые яркие фразы — дословно в кавычках «…».
- Ничего не выдумывай: только факты из ответов. Не добавляй дат, имён и деталей, которых нет.
- Каждый абзац — блок {"t":"p","src":"<id ответа, на котором он основан>","text":"..."}.
- Людей и места в тексте размечай токенами: [[p:<id>|слово как в тексте]] и [[l:<id>|слово]].
  Используй только id из списков ниже. Размечай первое упоминание в абзаце.
- Добавь 1–2 цитаты: {"t":"quote","src":"<id ответа>","by":"<id рассказчика или null>","text":"<ДОСЛОВНАЯ фраза из ответа>"}.
- title — короткое название главы (2–4 слова)."""

TOK = re.compile(r"\[\[(p|l):([^|\]]+)\|([^\]]+)\]\]")


class Editor(Agent[EditorResult]):
    name = "editor"
    system = SYSTEM
    result = EditorResult
    temperature = 0.4

    def build_prompt(self, ctx: dict) -> str:
        s = ctx["story"]
        srcs = [{"id": id, "q": x["q"], "a": x["text"]} for id, x in ctx["session_sources"].items()]
        people = {id: {"name": p["name"], "role": p.get("role", "")} for id, p in ctx["people"].items()}
        places = {id: p["name"] for id, p in ctx["places"].items()}
        return (
            f"История: «{s['title']}». Рассказывает: {s['narrator']} (relation={s.get('relation') or ''}, id={s.get('narratorId')}, "
            f"род: {({'f': 'она', 'm': 'он'}).get(s.get('narratorGender', ''), 'неизвестен')}).\n\n"
            f"Люди:\n{dump(people)}\n\nМеста:\n{dump(places)}\n\nОтветы этой сессии:\n{dump(srcs)}"
        )

    def mock(self, ctx: dict) -> EditorResult:
        """Как в прототипе: абзац = ответ с автоподсветкой имён, плюс цитата из первого ответа."""
        blocks: list[StoryBlock] = []
        for id, x in ctx["session_sources"].items():
            if x.get("photo"):
                blocks.append(StoryBlock(t="fig", img=x["photo"], caption="Фото из разговора.", credit="Загружено вами"))
            blocks.append(StoryBlock(t="p", src=id, text=autolink(x, ctx)))
        first = next(((id, x) for id, x in ctx["session_sources"].items() if not x.get("typed")), None)
        if first:
            sent = (re.match(r"[^.!?…]+[.!?…]", first[1]["text"]) or [first[1]["text"]])[0].strip().rstrip(".")
            blocks.insert(min(1, len(blocks)), StoryBlock(t="quote", src=first[0], by=ctx["story"].get("narratorId"), text=sent))
        turns = [t for t in ctx["story"]["interview"].get("turns", []) if t.get("topicTitle")]
        return EditorResult(title=turns[0]["topicTitle"] if turns else f"Глава {len(ctx['chapters']) + 1}", blocks=blocks)

    def postprocess(self, res: EditorResult, ctx: dict) -> EditorResult:
        srcs = ctx["session_sources"]

        def fix(m):
            k, id, label = m.groups()
            ok = id in (ctx["people"] if k == "p" else ctx["places"])
            return m.group(0) if ok else label
        for b in res.blocks:
            b.text = TOK.sub(fix, b.text or "")
            if b.src and b.src not in srcs:
                b.src = next(iter(srcs), None)
            if b.t == "quote" and b.src and not b.dur:
                b.dur = srcs[b.src].get("dur", "0:10") if b.src in srcs else "0:10"
        return res


def autolink(x: dict, ctx: dict) -> str:
    text, found = x["text"], []

    def try_add(kind, id, ent):
        stems = ent.get("stem") or [w for w in ent["name"].split() if w[:1].isupper()][:1]
        for st in stems:
            m = re.search(rf"(^|[^А-Яа-яЁё])({re.escape(st)}[а-яё]*)", text)
            if m:
                a, b = m.start(2), m.end(2)
                if not any(a < f[1] and b > f[0] for f in found):
                    found.append((a, b, kind, id))
                return
    for id in x.get("people", []):
        if id in ctx["people"]:
            try_add("p", id, ctx["people"][id])
    for id in x.get("places", []):
        if id in ctx["places"]:
            try_add("l", id, ctx["places"][id])
    out, pos = "", 0
    for a, b, k, id in sorted(found):
        out += f"{text[pos:a]}[[{k}:{id}|{text[a:b]}]]"
        pos = b
    return out + text[pos:]


editor = Editor()
