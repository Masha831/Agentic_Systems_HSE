import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")

YANDEX_API_KEY = os.getenv("YANDEX_API_KEY", "")
YANDEX_FOLDER_ID = os.getenv("YANDEX_FOLDER_ID", "")
YANDEX_MODEL = os.getenv("YANDEX_MODEL", "yandexgpt-5.1/latest")
YANDEX_LLM_BASE_URL = os.getenv("YANDEX_LLM_BASE_URL", "https://llm.api.cloud.yandex.net/v1")
YANDEX_VISION_BASE_URL = os.getenv("YANDEX_VISION_BASE_URL", "https://ai.api.cloud.yandex.net/v1")
YANDEX_VISION_MODEL = os.getenv("YANDEX_VISION_MODEL", "qwen3.6-35b-a3b")

# OpenRouter (проверено 2026-10-21 по https://openrouter.ai/api/v1/models и https://openrouter.ai/deepseek/deepseek-v4.1-flash):
# deepseek/deepseek-v4.1-flash-1017 — снимок DeepSeek V4.1 Flash от 17.10.2026; вход text+image, поддерживает
# response_format/structured_outputs и reasoning (по умолчанию включён, effort=high; допустимы max|high|low|none).
# Плавающий алиас без даты — deepseek/deepseek-v4.1-flash. Базовый URL — https://openrouter.ai/api/v1.
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_MODEL = "deepseek/deepseek-v4.1-flash-1017"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
OPENROUTER_REFERER = os.getenv("OPENROUTER_REFERER") or "http://localhost:8000"
OPENROUTER_TITLE = os.getenv("OPENROUTER_TITLE") or "Pomnu"  # ASCII: значение уходит HTTP-заголовком
# Рассуждение DeepSeek: none (по умолчанию, быстрые ответы и весь max_tokens идёт в JSON) | low | high | max | default
LLM_REASONING = (os.getenv("LLM_REASONING") or "none").lower()

LLM_PROVIDER = (os.getenv("LLM_PROVIDER") or ("openrouter" if OPENROUTER_API_KEY else "yandex")).lower()
if LLM_PROVIDER not in ("openrouter", "yandex"):
    raise ValueError(f"LLM_PROVIDER должен быть openrouter или yandex, получено {LLM_PROVIDER!r}")
_OR = LLM_PROVIDER == "openrouter"
LLM_BASE_URL = os.getenv("LLM_BASE_URL") or (OPENROUTER_BASE_URL if _OR else YANDEX_LLM_BASE_URL)
LLM_MODEL = os.getenv("LLM_MODEL") or (OPENROUTER_MODEL if _OR else YANDEX_MODEL)
# Своя модель для агента (пусто — LLM_MODEL)
AGENT_MODELS = {a: os.getenv(f"{a.upper()}_MODEL", "") for a in ("interviewer", "archivist", "editor")}

# Фото-анализ: DeepSeek V4.1 Flash принимает изображения, поэтому для openrouter модель та же, что у агентов.
VISION_PROVIDER = (os.getenv("VISION_PROVIDER") or LLM_PROVIDER).lower()
_VOR = VISION_PROVIDER == "openrouter"
VISION_MODEL = os.getenv("VISION_MODEL") or ((LLM_MODEL if _OR else OPENROUTER_MODEL) if _VOR else YANDEX_VISION_MODEL)
VISION_BASE_URL = os.getenv("VISION_BASE_URL") or (OPENROUTER_BASE_URL if _VOR else YANDEX_VISION_BASE_URL)
TTS_VOICE = os.getenv("TTS_VOICE", "alena")

# Доп. хосты для Origin у WebSocket живой расшифровки (через запятую, например "pomnu.example.com").
# Пусто — только тот же хост, что в заголовке Host.
ALLOWED_ORIGINS = {h.strip().lower() for h in os.getenv("ALLOWED_ORIGINS", "").split(",") if h.strip()}

LLM_HAS_KEY = bool(OPENROUTER_API_KEY) if _OR else bool(YANDEX_API_KEY and YANDEX_FOLDER_ID)
MOCK = os.getenv("MOCK", "0") == "1" or not LLM_HAS_KEY

# --- Голос: ElevenLabs (Scribe v2 + TTS) / Yandex SpeechKit (переключатель) -------------------
# Документация: https://elevenlabs.io/docs/api-reference/speech-to-text/convert
#               https://elevenlabs.io/docs/api-reference/text-to-speech/convert
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "")  # TTS без голоса недоступен (UI берёт голос браузера)
ELEVENLABS_STT_MODEL = os.getenv("ELEVENLABS_STT_MODEL") or "scribe_v2"
ELEVENLABS_TTS_MODEL = os.getenv("ELEVENLABS_TTS_MODEL") or "eleven_multilingual_v2"


def _voice_provider(name: str) -> str:
    """elevenlabs|yandex; пусто или неизвестное → elevenlabs при ключе ElevenLabs, иначе yandex."""
    name = os.getenv(name, "").strip().lower()
    return name if name in ("elevenlabs", "yandex") else ("elevenlabs" if ELEVENLABS_API_KEY else "yandex")


STT_PROVIDER = _voice_provider("STT_PROVIDER")
TTS_PROVIDER = _voice_provider("TTS_PROVIDER")


def _voice_mock(provider: str) -> bool:
    """Заглушка речи: MOCK=1 или у выбранного провайдера нет ключа (независимо от ключей LLM)."""
    if os.getenv("MOCK", "0") == "1":
        return True
    return not (ELEVENLABS_API_KEY if provider == "elevenlabs" else YANDEX_API_KEY and YANDEX_FOLDER_ID)


STT_MOCK = _voice_mock(STT_PROVIDER)
TTS_MOCK = _voice_mock(TTS_PROVIDER)
# ----------------------------------------------------------------------------------------------

DB_PATH = ROOT / os.getenv("DB_PATH", "backend/data/pomnu.sqlite3")
MEDIA_DIR = ROOT / os.getenv("MEDIA_DIR", "backend/data/media")
FRONTEND_DIR = ROOT / "frontend"
SEED_PATH = Path(__file__).with_name("seed.json")

DB_PATH.parent.mkdir(parents=True, exist_ok=True)
MEDIA_DIR.mkdir(parents=True, exist_ok=True)
