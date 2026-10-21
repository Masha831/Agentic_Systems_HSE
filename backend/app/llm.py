"""LLM-клиент (OpenAI-совместимый Chat Completions API): OpenRouter или Yandex AI Studio.

Провайдер выбирает config.LLM_PROVIDER. OpenRouter: https://openrouter.ai/docs, модель по обычному имени
(deepseek/deepseek-v4.1-flash-1017). Yandex: https://yandex.cloud/ru/docs/ai-studio/concepts/openai-compatibility,
модель адресуется как gpt://<folder_id>/<YANDEX_MODEL>.
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


def or_headers() -> dict[str, str]:
    """Необязательные заголовки атрибуции OpenRouter (HTTP-Referer, X-Title)."""
    h = {"HTTP-Referer": config.OPENROUTER_REFERER, "X-Title": config.OPENROUTER_TITLE}
    return {k: v for k, v in h.items() if v}


def make_client(provider: str, base_url: str, **kw) -> AsyncOpenAI:
    """Клиент под провайдера: у Yandex ключ + project=<folder>, у OpenRouter ключ + заголовки атрибуции."""
    if provider == "openrouter":
        return AsyncOpenAI(api_key=config.OPENROUTER_API_KEY, base_url=base_url, default_headers=or_headers(), **kw)
    return AsyncOpenAI(api_key=config.YANDEX_API_KEY, base_url=base_url, project=config.YANDEX_FOLDER_ID, **kw)


def client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = make_client(config.LLM_PROVIDER, config.LLM_BASE_URL)
    return _client


def model_uri(model: str = "", provider: str = "") -> str:
    provider = provider or config.LLM_PROVIDER
    if provider == "openrouter":
        return model or config.LLM_MODEL
    return f"gpt://{config.YANDEX_FOLDER_ID}/{model or config.LLM_MODEL}"


def extra_body() -> dict:
    """Параметры OpenRouter вне схемы OpenAI SDK; для Yandex пусто."""
    if config.LLM_PROVIDER != "openrouter":
        return {}
    # require_parameters: роутить только на провайдеров с response_format (у части хостов его нет).
    body: dict = {"provider": {"require_parameters": True}}
    if config.LLM_REASONING != "default":
        body["reasoning"] = {"effort": config.LLM_REASONING}
    return body


async def chat(system: str, user: str, temperature: float = 0.3, max_tokens: int = 2000, json_mode: bool = False, model: str = "") -> str:
    kwargs = {}
    if body := extra_body():
        kwargs["extra_body"] = body
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}
    r = await client().chat.completions.create(
        model=model_uri(model),
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        temperature=temperature,
        max_tokens=max_tokens,
        **kwargs,
    )
    if not r.choices:  # OpenRouter отдаёт ошибку провайдера как 200 без choices
        raise RuntimeError(f"LLM вернула пустой ответ: {getattr(r, 'error', None) or 'нет choices'}")
    return r.choices[0].message.content or ""


def _extract_json(text: str) -> str:
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
    text = re.sub(r"^.*?</think>", "", text, flags=re.S).strip()  # открывающий тег мог потеряться
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if m:
        text = m.group(1).strip()
    start = min([i for i in (text.find("{"), text.find("[")) if i >= 0], default=0)
    return text[start:]


async def structured(system: str, user: str, schema: Type[T], temperature: float = 0.2, retries: int = 2, model: str = "") -> T:
    """Вызов LLM с ответом строго по pydantic-схеме. При невалидном JSON — повтор с ошибкой в контексте."""
    sys = (
        f"{system}\n\nОтвечай ТОЛЬКО JSON-объектом по этой JSON Schema, без пояснений:\n"
        f"{json.dumps(schema.model_json_schema(), ensure_ascii=False)}"
    )
    last_err = ""
    for attempt in range(retries + 1):
        msg = user if not last_err else f"{user}\n\nПредыдущий ответ был невалиден: {last_err}. Исправь."
        raw = await chat(sys, msg, temperature=temperature, json_mode=True, model=model)
        try:
            return schema.model_validate_json(_extract_json(raw))
        except (ValidationError, ValueError) as e:
            last_err = str(e)[:500]
            log.warning("LLM invalid JSON (attempt %s): %s\nraw=%s", attempt, last_err, raw[:500])
    raise RuntimeError(f"LLM не вернула валидный JSON: {last_err}")
