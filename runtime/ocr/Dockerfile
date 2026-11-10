FROM python:3.12.13-slim-bookworm@sha256:4766d8b510c428e595d74b9cc5bbb2fae8e26316fffb4adc89908d79aacd58a2
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OPENBLAS_NUM_THREADS=1 \
    HYPER_OCR_MODELS=/models HYPER_OCR_BIND_HOST=0.0.0.0
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libgl1 libglib2.0-0 poppler-utils \
    && rm -rf /var/lib/apt/lists/*
COPY runtime/ocr/requirements.txt ./
RUN pip install --no-cache-dir --only-binary=:all: -r requirements.txt && pip check
COPY runtime/ocr/prepare_models.py ./
# RapidTable creates its package model directory at first import, even with an explicit model path.
RUN python -c "import rapid_table" && python prepare_models.py /models
COPY runtime/ocr/page.py runtime/ocr/recognizer.py runtime/ocr/service.py ./
COPY docs/OCR.md /app/OCR.md
USER 10001:10001
EXPOSE 3122
CMD ["python", "service.py"]
