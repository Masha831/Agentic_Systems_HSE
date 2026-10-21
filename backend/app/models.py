"""Общий контракт. Формы совпадают с frontend/assets/data.js — фронт получает их как есть.

Токены в тексте: [[p:id|текст]] — человек, [[l:id|текст]] — место.
Менять поля можно только договорившись (docs/contract.md).
"""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

TopicStatus = Literal["done", "current", "later", "declined"]


class Image(BaseModel):
    src: str
    w: int = 0
    h: int = 0
    alt: str = ""
    credit: Optional[str] = None


class Link(BaseModel):
    """Связь человека с человеком. src — Source, где это сказано (Claim)."""
    to: str
    label: str
    src: Optional[str] = None


class Person(BaseModel):
    story: str
    name: str
    full: str = ""
    role: str = ""
    stem: list[str] = Field(default_factory=list)  # основы для подсветки в тексте: «Нин», «Мам»
    aka: list[str] = Field(default_factory=list)
    note: str = ""
    links: list[Link] = Field(default_factory=list)
    narrator: bool = False
    photo: Optional[Image] = None


class Place(BaseModel):
    story: str
    name: str
    role: str = ""
    stem: list[str] = Field(default_factory=list)
    note: str = ""
    photo: Optional[Image] = None


class Event(BaseModel):
    id: str
    story: str
    title: str
    date: str = ""            # «сентябрь 1962», «детство»
    approx: bool = False
    dateNote: str = ""
    sort: float = 0           # 1962.7 — для хронологии
    people: list[str] = Field(default_factory=list)
    place: Optional[str] = None
    src: list[str] = Field(default_factory=list)


class Source(BaseModel):
    """Исходный ответ: вопрос, запись, расшифровка. Никогда не переписывается агентами."""
    story: str
    session: int
    n: int
    date: str = "сегодня"
    q: str = ""
    dur: str = "0:00"
    text: str
    typed: bool = False
    edited: bool = False
    audio: Optional[str] = None   # /media/<file>
    photo: Optional[Image] = None
    people: list[str] = Field(default_factory=list)
    places: list[str] = Field(default_factory=list)
    correction: Optional[str] = None
    intro: bool = False           # ответ на вопрос-знакомство: в главу не идёт


class Topic(BaseModel):
    id: str
    title: str
    status: TopicStatus = "later"


class Clarify(BaseModel):
    """Вопрос на подтверждение неоднозначной связи (два Михаила, сёстры ли и т.п.)."""
    id: str
    src: Optional[str] = None
    text: str
    yes: str = "Да"
    no: str = "Нет"
    yesMsg: str = "Сохранено"
    noMsg: str = "Отмечено"
    apply: dict = Field(default_factory=dict)  # {"yes": {"role": [id, role], "links": [[a, b, label]], "note": [placeId, text]}}
    resolved: Optional[str] = None


class Question(BaseModel):
    """Выход Интервьюера."""
    text: str
    why: str = ""
    topic: Optional[str] = None
    topicTitle: str = ""


class Session(BaseModel):
    n: int
    date: str
    answers: int


class InterviewState(BaseModel):
    """Состояние текущей сессии на сервере (фронт держит своё s.talk для UI)."""
    session: int = 1
    question: Optional[Question] = None
    asked: list[str] = Field(default_factory=list)   # тексты всех заданных вопросов
    turns: list[dict] = Field(default_factory=list)  # {q, src} | {q, skipped} | {q, declined}
    photo: Optional[Image] = None  # фото, о котором текущий вопрос; прикрепляется к следующему ответу


class Story(BaseModel):
    id: str
    type: Literal["family", "travel", "love", "path"] = "family"
    title: str
    about: str = ""
    narrator: str
    relation: str = ""
    narratorId: Optional[str] = None
    narratorName: str = ""       # как представился — из вопроса-знакомства
    narratorAddress: str = ""    # как к нему обращаться: «Анна Сергеевна», «Аня»
    narratorGender: Literal["f", "m", ""] = ""  # для «рассказал/рассказала»; "" — неизвестно
    cover: Optional[Image] = None
    sessions: list[Session] = Field(default_factory=list)
    updated: str = "только что"
    chapters: list[str] = Field(default_factory=list)
    continueNote: str = ""
    topics: list[Topic] = Field(default_factory=list)
    clarify: list[Clarify] = Field(default_factory=list)
    interview: InterviewState = Field(default_factory=InterviewState)


class StoryBlock(BaseModel):
    t: Literal["p", "quote", "fig", "slot"]
    src: Optional[str] = None
    text: str = ""              # для p/quote — с токенами [[p:..|..]]
    by: Optional[str] = None    # quote: id рассказчика
    dur: Optional[str] = None
    note: Optional[str] = None
    img: Optional[Image] = None
    caption: Optional[str] = None
    credit: Optional[str] = None


class Chapter(BaseModel):
    story: str
    n: int
    title: str
    sources: list[str] = Field(default_factory=list)
    blocks: list[StoryBlock] = Field(default_factory=list)
    open: Optional[str] = None
    openTopic: Optional[str] = None


# ---------- выходы агентов ----------

class NewPerson(BaseModel):
    id: str
    name: str
    role: str = ""
    stem: list[str] = Field(default_factory=list)


class NewPlace(BaseModel):
    id: str
    name: str
    role: str = ""
    stem: list[str] = Field(default_factory=list)


class NewEvent(BaseModel):
    id: str
    title: str
    date: str = ""
    approx: bool = True
    dateNote: str = ""
    sort: float = 0
    people: list[str] = Field(default_factory=list)
    place: Optional[str] = None


class Added(BaseModel):
    people: list[NewPerson] = Field(default_factory=list)
    places: list[NewPlace] = Field(default_factory=list)
    events: list[NewEvent] = Field(default_factory=list)


class Refs(BaseModel):
    people: list[str] = Field(default_factory=list)
    places: list[str] = Field(default_factory=list)


class NewLink(BaseModel):
    a: str
    b: str
    label: str  # «Сестра Анны» — как a приходится b


class ArchivistResult(BaseModel):
    """Тот же формат, что answer в data.js/scripts: add + refs + clarify (+ links)."""
    add: Added = Field(default_factory=Added)
    refs: Refs = Field(default_factory=Refs)
    links: list[NewLink] = Field(default_factory=list)
    clarify: list[Clarify] = Field(default_factory=list)


class InterviewerResult(BaseModel):
    question: Question
    topics: list[Topic] = Field(default_factory=list)  # обновлённый план интервью
    continueNote: str = ""


class IntroResult(BaseModel):
    """Разбор ответа на вопрос-знакомство."""
    name: str = Field("", description="как человек представился, полностью")
    address: str = Field("", description="как к нему обращаться; если не сказал — имя")
    gender: Literal["f", "m", ""] = Field("", description="f — она, m — он, пусто — непонятно")


class EditorResult(BaseModel):
    title: str
    blocks: list[StoryBlock]
