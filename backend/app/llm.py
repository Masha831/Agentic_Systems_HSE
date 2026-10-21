"""Клиент Yandex AI Studio (OpenAI-совместимый Completions API).

Документация: https://yandex.cloud/ru/docs/ai-studio/concepts/openai-compatibility
Модель адресуется как gpt://<folder_id>/<YANDEX_MODEL>.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Type, TypeVar

from openai import AsyncOpenAI
from pydantic import BaseModel, ValidationError

from . import config

log = logging.getLogger("llm")
T = TypeVar("T", bound=BaseModel)

_client: AsyncOpenAI | None = None


def client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(
            api_key=config.YANDEX_API_KEY,
            base_url=config.YANDEX_LLM_BASE_URL,
            project=config.YANDEX_FOLDER_ID,
        )
    return _client


def model_uri() -> str:
    return f"gpt://{config.YANDEX_FOLDER_ID}/{config.YANDEX_MODEL}"


async def chat(system: str, user: str, temperature: float = 0.3, max_tokens: int = 2000, json_mode: bool = False) -> str:
    kwargs = {}
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}
    r = await client().chat.completions.create(
        model=model_uri(),
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        temperature=temperature,
        max_tokens=max_tokens,
        **kwargs,
    )
    return r.choices[0].message.content or ""


def _extract_json(text: str) -> str:
    text = text.strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if m:
        text = m.group(1).strip()
    start = min([i for i in (text.find("{"), text.find("[")) if i >= 0], default=0)
    return text[start:]


async def structured(system: str, user: str, schema: Type[T], temperature: float = 0.2, retries: int = 2) -> T:
    """Вызов LLM с ответом строго по pydantic-схеме. При невалидном JSON — повтор с ошибкой в контексте."""
    sys = (
        f"{system}\n\nОтвечай ТОЛЬКО JSON-объектом по этой JSON Schema, без пояснений:\n"
        f"{json.dumps(schema.model_json_schema(), ensure_ascii=False)}"
    )
    last_err = ""
    for attempt in range(retries + 1):
        msg = user if not last_err else f"{user}\n\nПредыдущий ответ был невалиден: {last_err}. Исправь."
        raw = await chat(sys, msg, temperature=temperature, json_mode=True)
        try:
            return schema.model_validate_json(_extract_json(raw))
        except (ValidationError, ValueError) as e:
            last_err = str(e)[:500]
            log.warning("LLM invalid JSON (attempt %s): %s\nraw=%s", attempt, last_err, raw[:500])
    raise RuntimeError(f"LLM не вернула валидный JSON: {last_err}")
