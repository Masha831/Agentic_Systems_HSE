"""Заглушка вместо LLM не должна быть тихой: метка в журнале, счётчик в /api/health, ошибка в эвалах."""
import asyncio
import unittest
from unittest.mock import patch

import test_voice  # noqa: F401 — временная БД и MOCK=1 до импорта приложения
from pydantic import BaseModel

from backend.app import config, store
from backend.app.agents import base


class Out(BaseModel):
    text: str


class Broken(base.Agent[Out]):
    name = "broken"
    result = Out

    def build_prompt(self, ctx):
        return "prompt"

    async def call_llm(self, prompt, ctx):
        raise RuntimeError("provider down")

    def mock(self, ctx):
        return Out(text="заглушка")


class FallbackTest(unittest.TestCase):
    def run_agent(self):
        return asyncio.run(Broken().run({"story": {"id": "fallback-test"}}))

    def test_fallback_is_marked(self):
        before = base.FALLBACKS
        with patch.object(config, "MOCK", False), patch.object(config, "AGENT_FALLBACK", True):
            res = self.run_agent()
        self.assertEqual(res.text, "заглушка")
        self.assertEqual(base.FALLBACKS, before + 1)
        trace = list(store.list_("trace", "fallback-test").values())[-1]
        self.assertTrue(trace["fallback"])
        self.assertIn("provider down", trace["error"])

    def test_no_fallback_raises(self):
        with patch.object(config, "MOCK", False), patch.object(config, "AGENT_FALLBACK", False):
            with self.assertRaises(base.AgentFailed):
                self.run_agent()


if __name__ == "__main__":
    unittest.main()
