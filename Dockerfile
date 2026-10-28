FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1

# ffmpeg (+ffprobe) нужен для распознавания речи
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install -r backend/requirements.txt

COPY backend backend
COPY frontend frontend
COPY tests tests

# БД и записи лежат в backend/data — это том; каталог принадлежит непривилегированному пользователю
RUN useradd --create-home --uid 1000 app \
    && mkdir -p backend/data && chown -R app:app backend/data
USER app

# Какой коммит в образе — видно в /api/health (make deploy передаёт IMAGE_TAG)
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4)"

# Один процесс: идемпотентность ответов (answer_delivery) рассчитана на него, --workers не добавлять
CMD ["uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8000"]
