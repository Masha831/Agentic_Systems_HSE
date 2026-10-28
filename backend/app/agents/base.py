"""Базовый агент: системный промпт + контекст → pydantic-результат. Каждый запуск пишется в trace."""
from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Generic, Type, TypeVar

from pydantic import BaseModel

from .. import config, llm, store

T = TypeVar("T", bound=BaseModel)
log = logging.getLogger("agents")

# Сколько раз с запуска агент ответил заглушкой вместо LLM (видно в /api/health).
FALLBACKS = 0


class AgentFailed(RuntimeError):
    """LLM не ответила, а заглушка запрещена (AGENT_FALLBACK=0 — эвалы и проверки)."""


def dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=1)


class Agent(Generic[T]):
    name: str = "agent"
    system: str = ""
    result: Type[T]
    temperature: float = 0.2

    @property
    def model(self) -> str:
        return config.AGENT_MODELS.get(self.name, "")

    def build_prompt(self, ctx: dict) -> str:
        raise NotImplementedError

    async def call_llm(self, prompt: str, ctx: dict) -> T:
        """Один вызов LLM; агенты с инструментами переопределяют (см. Interviewer)."""
        return await llm.structured(self.system, prompt, self.result, temperature=self.temperature, model=self.model)

    def mock(self, ctx: dict) -> T:
        raise NotImplementedError

    def postprocess(self, res: T, ctx: dict) -> T:
        """Проверка и починка выхода LLM (несуществующие id, пустые поля…)."""
        return res

    async def run(self, ctx: dict) -> T:
        global FALLBACKS
        t0 = time.time()
        prompt = self.build_prompt(ctx)
        error = ""
        if config.MOCK:
            res = self.mock(ctx)
        else:
            try:
                res = await self.call_llm(prompt, ctx)
            except Exception as e:
                if not config.AGENT_FALLBACK:
                    raise AgentFailed(f"{self.name}: {e}") from e
                # Демо не должно падать из-за одного ответа LLM, но подмена видна: в журнале и в /api/health.
                log.exception("%s failed, fallback to mock: %s", self.name, e)
                FALLBACKS += 1
                error = f"{type(e).__name__}: {e}"[:300]
                res = self.mock(ctx)
        res = self.postprocess(res, ctx)
        story = (ctx.get("story") or {}).get("id")
        store.put("trace", uuid.uuid4().hex[:12], {
            "story": story, "agent": self.name, "ms": int((time.time() - t0) * 1000),
            "mock": config.MOCK, "fallback": bool(error), "error": error, "provider": config.LLM_PROVIDER, "model": self.model or config.LLM_MODEL, "prompt": prompt[:4000], "result": res.model_dump(),
            "tool_calls": ctx.get("tool_calls", []),
            "at": time.strftime("%H:%M:%S"),
        }, story=story)
        return res
