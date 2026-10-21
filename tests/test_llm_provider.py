"""Выбор LLM-провайдера, адресация модели и правила MOCK. Конфиг читается при импорте — перечитываем в изолированном окружении."""
import importlib.util
import os
import unittest
from unittest.mock import patch

from backend.app import config, llm

KEYS = ("MOCK", "LLM_PROVIDER", "OPENROUTER_API_KEY", "YANDEX_API_KEY", "YANDEX_FOLDER_ID", "LLM_MODEL", "LLM_BASE_URL",
        "YANDEX_MODEL", "VISION_PROVIDER", "VISION_MODEL", "LLM_REASONING", "INTERVIEWER_MODEL")


def load_config(**env):
    """Загрузить свежую копию config с чистым окружением (реальный модуль не трогаем: на нём держатся другие тесты);
    .env подавлен, чтобы тест не зависел от локальных ключей."""
    clean = {k: v for k, v in os.environ.items() if k not in KEYS}
    with patch.dict(os.environ, clean, clear=True), patch("dotenv.load_dotenv", lambda *a, **k: False):
        os.environ.update(env)
        spec = importlib.util.spec_from_file_location("backend.app._config_under_test", config.__file__)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod


class ProviderTests(unittest.TestCase):
    def use(self, **env):
        """Подменить config внутри llm на свежую копию на время теста."""
        c = load_config(**env)
        p = patch.object(llm, "config", c)
        p.start()
        self.addCleanup(p.stop)
        return c

    def test_default_by_key(self):
        self.assertEqual(load_config(OPENROUTER_API_KEY="x").LLM_PROVIDER, "openrouter")
        self.assertEqual(load_config().LLM_PROVIDER, "yandex")
        self.assertEqual(load_config(YANDEX_API_KEY="y", YANDEX_FOLDER_ID="f").LLM_PROVIDER, "yandex")

    def test_explicit_override(self):
        c = load_config(OPENROUTER_API_KEY="x", YANDEX_API_KEY="y", YANDEX_FOLDER_ID="f", LLM_PROVIDER="yandex")
        self.assertEqual((c.LLM_PROVIDER, c.LLM_MODEL, c.LLM_BASE_URL), ("yandex", c.YANDEX_MODEL, c.YANDEX_LLM_BASE_URL))
        self.assertEqual(load_config(LLM_PROVIDER="openrouter").LLM_PROVIDER, "openrouter")
        with self.assertRaises(ValueError):
            load_config(LLM_PROVIDER="nope")

    def test_openrouter_defaults_and_overrides(self):
        c = load_config(OPENROUTER_API_KEY="x")
        self.assertEqual(c.LLM_MODEL, "deepseek/deepseek-v4.1-flash-1017")
        self.assertEqual(c.LLM_BASE_URL, "https://openrouter.ai/api/v1")
        self.assertEqual((c.VISION_PROVIDER, c.VISION_MODEL), ("openrouter", c.LLM_MODEL))
        c = load_config(OPENROUTER_API_KEY="x", LLM_MODEL="deepseek/deepseek-v4.1-flash", YANDEX_MODEL="ignored")
        self.assertEqual((c.LLM_MODEL, c.VISION_MODEL), ("deepseek/deepseek-v4.1-flash",) * 2)

    def test_yandex_names_keep_working(self):
        c = load_config(YANDEX_API_KEY="y", YANDEX_FOLDER_ID="f", YANDEX_MODEL="aliceai-llm/latest")
        self.assertEqual((c.LLM_MODEL, c.VISION_PROVIDER, c.VISION_MODEL), ("aliceai-llm/latest", "yandex", "qwen3.6-35b-a3b"))
        self.assertEqual(load_config(YANDEX_API_KEY="y", YANDEX_FOLDER_ID="f", VISION_MODEL="m").VISION_MODEL, "m")

    def test_mock_rules(self):
        self.assertTrue(load_config().MOCK)
        self.assertFalse(load_config(OPENROUTER_API_KEY="x").MOCK)
        self.assertTrue(load_config(OPENROUTER_API_KEY="x", MOCK="1").MOCK)
        self.assertTrue(load_config(YANDEX_API_KEY="y").MOCK)  # yandex: нужны ключ и folder
        self.assertFalse(load_config(YANDEX_API_KEY="y", YANDEX_FOLDER_ID="f").MOCK)
        # выбран yandex, а ключ только от openrouter -> мок
        self.assertTrue(load_config(OPENROUTER_API_KEY="x", LLM_PROVIDER="yandex").MOCK)

    def test_model_uri_per_provider(self):
        self.use(OPENROUTER_API_KEY="x")
        self.assertEqual(llm.model_uri(), "deepseek/deepseek-v4.1-flash-1017")
        self.assertEqual(llm.model_uri("vendor/m"), "vendor/m")
        self.use(YANDEX_API_KEY="y", YANDEX_FOLDER_ID="fid")
        self.assertEqual(llm.model_uri(), "gpt://fid/yandexgpt-5.1/latest")
        self.assertEqual(llm.model_uri("aliceai-llm/latest"), "gpt://fid/aliceai-llm/latest")
        self.assertEqual(llm.model_uri("vendor/m", "openrouter"), "vendor/m")

    def test_request_extras_per_provider(self):
        self.use(OPENROUTER_API_KEY="x")
        self.assertEqual(llm.extra_body(), {"provider": {"require_parameters": True}, "reasoning": {"effort": "none"}})
        self.assertEqual(llm.or_headers()["X-Title"], "Pomnu")
        self.use(OPENROUTER_API_KEY="x", LLM_REASONING="default")
        self.assertNotIn("reasoning", llm.extra_body())
        self.use(YANDEX_API_KEY="y", YANDEX_FOLDER_ID="f")
        self.assertEqual(llm.extra_body(), {})

    def test_client_per_provider(self):
        self.use(OPENROUTER_API_KEY="x")
        c = llm.make_client("openrouter", llm.config.LLM_BASE_URL)
        self.assertIsNone(c.project)
        self.assertIn("HTTP-Referer", c.default_headers)
        self.use(YANDEX_API_KEY="y", YANDEX_FOLDER_ID="fid")
        c = llm.make_client("yandex", llm.config.LLM_BASE_URL)
        self.assertEqual(c.project, "fid")

    def test_extract_json_strips_think(self):
        raw = '<think>hmm {"a": 0}</think>\n```json\n{"a": 1}\n```'
        self.assertEqual(llm._extract_json(raw), '{"a": 1}')
        self.assertEqual(llm._extract_json('reasoning...</think>{"a": 2}'), '{"a": 2}')


if __name__ == "__main__":
    unittest.main()
