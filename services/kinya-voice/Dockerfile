# Muhazi Medical Clinic — Kinyarwanda voice server (0165). CPU only; ~2 GB image.
# Runs as-is on Hugging Face Spaces (Docker, port 7860), Render, Fly.io or any Docker host.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 MODEL_DIR=/app/model PORT=7860
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends libsndfile1 espeak-ng git \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.txt

# the model files, downloaded once at build time (CC-BY-SA 4.0, Digital Umuganda)
RUN python -c "from huggingface_hub import snapshot_download; snapshot_download('DigitalUmuganda/KinyarwandaTTS_female_voice', local_dir='/app/model')"

COPY app.py .
# Spaces run as a non-root user with this id
RUN useradd -m -u 1000 user && chown -R user /app
USER user
EXPOSE 7860
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
