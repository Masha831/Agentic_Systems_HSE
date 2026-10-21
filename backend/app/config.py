import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")

YANDEX_API_KEY = os.getenv("YANDEX_API_KEY", "")
YANDEX_FOLDER_ID = os.getenv("YANDEX_FOLDER_ID", "")
YANDEX_MODEL = os.getenv("YANDEX_MODEL", "yandexgpt-5.1/latest")
# Своя модель для агента (пусто — YANDEX_MODEL)
AGENT_MODELS = {a: os.getenv(f"{a.upper()}_MODEL", "") for a in ("interviewer", "archivist", "editor")}
YANDEX_LLM_BASE_URL = os.getenv("YANDEX_LLM_BASE_URL", "https://llm.api.cloud.yandex.net/v1")
TTS_VOICE = os.getenv("TTS_VOICE", "alena")

MOCK = os.getenv("MOCK", "0") == "1" or not (YANDEX_API_KEY and YANDEX_FOLDER_ID)

DB_PATH = ROOT / os.getenv("DB_PATH", "backend/data/pomnu.sqlite3")
MEDIA_DIR = ROOT / os.getenv("MEDIA_DIR", "backend/data/media")
FRONTEND_DIR = ROOT / "frontend"
SEED_PATH = Path(__file__).with_name("seed.json")

DB_PATH.parent.mkdir(parents=True, exist_ok=True)
MEDIA_DIR.mkdir(parents=True, exist_ok=True)
