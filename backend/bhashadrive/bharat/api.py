"""BharatConnect HTTP routes: one per pipeline stage, so the UI shows each stage and retries only the one
that failed. Recordings are deleted after transcription; conversation text is never logged."""
from __future__ import annotations

import tempfile
from dataclasses import dataclass
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field

from ..config import BharatConfig
from .errors import ServiceError
from .languages import LANGUAGES, language
from .speech import Transcriber
from .translation import GoogleTranslator
from .tts import GoogleTTS

MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_TEXT_CHARS = 1000


@dataclass
class BharatServices:
    transcriber: Transcriber
    translator: GoogleTranslator
    tts: GoogleTTS

    @classmethod
    def from_config(cls, c: BharatConfig) -> "BharatServices":
        return cls(Transcriber(c), GoogleTranslator(c.project, c.translate_timeout_s), GoogleTTS(c.tts_timeout_s))


class TranslateIn(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    source: str
    target: str


class SpeakIn(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    language: str


def _fail(e: ServiceError | ValueError):
    if isinstance(e, ValueError):
        raise HTTPException(422, {"stage": "input", "message": str(e), "retryable": False})
    print(f"[API /bharat] {e.stage} failed: {e.message}")
    raise HTTPException(e.status, e.detail())


def bharat_router(s: BharatServices) -> APIRouter:
    r = APIRouter(prefix="/bharat")

    @r.get("/status")
    def status():
        return {"languages": [{"code": l.code, "name": l.name, "native": l.native} for l in LANGUAGES.values()],
                "asr": {"model": s.transcriber.model, "loaded": s.transcriber.loaded},
                "translation": {"problem": s.translator.problem()}}

    @r.post("/warmup")
    def warmup():
        """Load the speech model now, so the first turn is not slowed by it."""
        try:
            s.transcriber.load()
        except ServiceError as e:
            _fail(e)
        return {"loaded": True, "model": s.transcriber.model}

    @r.post("/transcribe")
    async def transcribe(file: UploadFile = File(...), language_code: str = Form(..., alias="language")):
        data = await file.read()
        if not data:
            _fail(ServiceError("transcribing", "The recording is empty.", 400, False))
        if len(data) > MAX_UPLOAD_BYTES:
            _fail(ServiceError("transcribing", "The recording is too large.", 413, False))
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / f"turn{Path(file.filename or 'audio.webm').suffix or '.webm'}"
            p.write_bytes(data)
            try:
                out = s.transcriber.transcribe_file(p, language_code)
            except (ServiceError, ValueError) as e:
                _fail(e)
        print(f"[API /bharat/transcribe] {language_code} {out['duration_s']}s audio -> '{out.get('text')}' (detected: {out.get('language')}) in {out['latency_s']}s")

        return out

    @r.post("/translate")
    def translate(body: TranslateIn):
        try:
            out = s.translator.translate(body.text, body.source, body.target)
        except (ServiceError, ValueError) as e:
            _fail(e)
        print(f"[API /bharat/translate] {body.source}->{body.target} '{body.text}' -> '{out.get('text')}' in {out['latency_s']}s"
              f"{' (cached)' if out['cached'] else ''}")
        return out

    @r.post("/speak")
    def speak(body: SpeakIn):
        try:
            language(body.language)
            audio, voice, seconds = s.tts.synthesize(body.text, body.language)
        except (ServiceError, ValueError) as e:
            _fail(e)
        print(f"[API /bharat/speak] {body.language} {len(body.text)} chars -> {len(audio)} bytes in {seconds:.2f}s")
        media_type = "audio/wav" if audio.startswith(b"RIFF") else "audio/mpeg"
        return Response(audio, media_type=media_type,
                        headers={"X-Voice": voice, "X-Latency-S": f"{seconds:.3f}", "Cache-Control": "no-store"})

    return r
