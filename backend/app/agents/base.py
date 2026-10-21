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


def dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=1)


class Agent(Generic[T]):
    name: str = "agent"
    system: str = ""
    result: Type[T]
    temperature: float = 0.2

    def build_prompt(self, ctx: dict) -> str:
        raise NotImplementedError

    def mock(self, ctx: dict) -> T:
        raise NotImplementedError

    def postprocess(self, res: T, ctx: dict) -> T:
        """Проверка и починка выхода LLM (несуществующие id, пустые поля…)."""
        return res

    async def run(self, ctx: dict) -> T:
        t0 = time.time()
        prompt = self.build_prompt(ctx)
        if config.MOCK:
            res = self.mock(ctx)
        else:
            try:
                res = await llm.structured(self.system, prompt, self.result, temperature=self.temperature)
            except Exception as e:  # демо не должно падать из-за одного ответа LLM
                log.exception("%s failed, fallback to mock: %s", self.name, e)
                res = self.mock(ctx)
        res = self.postprocess(res, ctx)
        story = (ctx.get("story") or {}).get("id")
        store.put("trace", uuid.uuid4().hex[:12], {
            "story": story, "agent": self.name, "ms": int((time.time() - t0) * 1000),
            "mock": config.MOCK, "prompt": prompt[:4000], "result": res.model_dump(),
            "at": time.strftime("%H:%M:%S"),
        }, story=story)
        return res
