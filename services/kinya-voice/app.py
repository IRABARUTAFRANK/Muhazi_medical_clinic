"""
Muhazi Medical Clinic — Kinyarwanda voice server (0165).

A small HTTP service that turns a Kinyarwanda sentence into speech with an open Kinyarwanda
text-to-speech model, for the waiting-room screen ("Umurwayi witwa Mugiraneza Jean, urakenewe
muri deparitoma yo gusuzuma, ukenewe na muganga Habineza"). The app's edge function rw-voice
calls it once per sentence and keeps the audio, so this service is asked rarely.

Model: DigitalUmuganda/KinyarwandaTTS_female_voice (Coqui YourTTS, CC-BY-SA 4.0 — credit
Digital Umuganda). The files are downloaded at build time (see the Dockerfile).

  POST /tts   { "text": "…" }   header X-Key: <VOICE_SERVER_KEY>   → audio/wav (16-bit mono)
  GET  /health                                                      → { "ok": true }

Environment: VOICE_SERVER_KEY (required: the same secret the edge function sends),
PORT (default 7860, the port Hugging Face Spaces expects), MODEL_DIR (default ./model).
"""
from __future__ import annotations

import hashlib
import io
import os
import re
import threading
import time
import wave

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

MODEL_DIR = os.environ.get("MODEL_DIR", "./model")
KEY = os.environ.get("VOICE_SERVER_KEY", "")
MAX_CHARS = 300

app = FastAPI(title="Muhazi Kinyarwanda voice")
_lock = threading.Lock()
_synth = None


def synthesizer():
    """The Coqui synthesizer, loaded once (a few seconds) and kept."""
    global _synth
    if _synth is None:
        from TTS.utils.synthesizer import Synthesizer  # imported late: a slow import

        _synth = Synthesizer(
            tts_checkpoint=os.path.join(MODEL_DIR, "model.pth"),
            tts_config_path=os.path.join(MODEL_DIR, "config.json"),
            tts_speakers_file=os.path.join(MODEL_DIR, "speakers.pth"),
            encoder_checkpoint=os.path.join(MODEL_DIR, "SE_checkpoint.pth.tar"),
            encoder_config=os.path.join(MODEL_DIR, "config_se.json"),
            use_cuda=False,
        )
    return _synth


def clean(text: str) -> str:
    """The sentence the model reads: one line, plain letters, no stray symbols."""
    t = re.sub(r"\s+", " ", text).strip()
    t = t.replace("’", "'").replace("—", ",").replace("–", ",")
    return t[:MAX_CHARS]


class Ask(BaseModel):
    text: str


@app.get("/health")
def health():
    return {"ok": True, "model": os.path.basename(MODEL_DIR)}


@app.post("/tts")
def tts(ask: Ask, x_key: str | None = Header(default=None)):
    if not KEY or x_key != KEY:
        raise HTTPException(status_code=401, detail="bad key")
    text = clean(ask.text)
    if not text:
        raise HTTPException(status_code=422, detail="empty text")
    started = time.time()
    with _lock:  # one sentence at a time on a small CPU
        s = synthesizer()
        wav = s.tts(
            text,
            speaker_wav=[os.path.join(MODEL_DIR, "conditioning_audio.wav"),
                         os.path.join(MODEL_DIR, "conditioning_audio2.wav")],
        )
        rate = int(s.output_sample_rate)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(int(max(-1.0, min(1.0, x)) * 32767).to_bytes(2, "little", signed=True) for x in wav))
    body = buf.getvalue()
    return Response(
        content=body,
        media_type="audio/wav",
        headers={
            "X-Took-Ms": str(int((time.time() - started) * 1000)),
            "X-Text-Hash": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        },
    )


@app.exception_handler(Exception)
def on_error(_, exc: Exception):
    return JSONResponse(status_code=500, content={"error": str(exc)[:300]})
