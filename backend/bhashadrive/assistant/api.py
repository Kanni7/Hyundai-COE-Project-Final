"""HTTP routes of the premium voice assistant (mounted under / and /api with the rest of the API).

  GET  /assistant/entitlement   tier for this request (server-decided) and whether premium can run
  POST /assistant/dev-tier      development only: switch the local tier (BD_DEV_TIER_SWITCH, loopback)
  POST /assistant/transcribe    audio -> Sarvam Saaras transcript (local ASR if the cloud fails)
  POST /assistant/interpret     transcript -> validated cockpit commands (OpenAI); 503 -> use the local pipeline
  GET  /assistant/usage         aggregate usage and estimated cost (no content)
"""
from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Callable

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from ..audio.preprocessing import TARGET_SR, AudioError, decode_file
from .entitlements import Entitlement, Entitlements
from .providers import ProviderError
from .service import AssistantService, Busy, RateLimited

MAX_UPLOAD_BYTES = 5 * 1024 * 1024


class InterpretIn(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    # Small snapshot of the cockpit (temperature, volume, screen...) so "thoda aur" resolves; size-capped server-side.
    state: dict | None = None


class TierIn(BaseModel):
    tier: str


def assistant_router(service: AssistantService, entitlements: Entitlements,
                     local_transcribe: Callable[[Path], tuple[str, str | None]],
                     identify: Callable[[Path], dict | None]) -> APIRouter:
    r = APIRouter(prefix="/assistant")

    def who(req: Request) -> Entitlement:
        return entitlements.resolve(req.headers.get("authorization"), req.client.host if req.client else None)

    def premium(req: Request) -> Entitlement:
        e = who(req)
        if e.tier != "premium":
            raise HTTPException(403, {"code": "subscription_expired" if e.expired else "premium_required",
                                      "message": "Premium voice is not active for this account."})
        if service.problems:
            raise HTTPException(503, {"code": "premium_unconfigured", "message": "Premium voice is not configured on the server."})
        return e

    def guarded(e: Entitlement):
        try:
            return service.begin(e.subject)
        except RateLimited:
            raise HTTPException(429, {"code": "rate_limited", "message": "Too many voice requests. Please wait a moment."})
        except Busy:
            raise HTTPException(409, {"code": "busy", "message": "Still working on the previous command."})

    @r.get("/entitlement")
    def entitlement(req: Request):
        e = who(req)
        return {"tier": e.tier, "source": e.source, "expired": e.expired,
                "premium_available": e.tier == "premium" and not service.problems,
                # Names of missing settings only, never their values.
                "problems": service.problems if e.tier == "premium" else [],
                "dev_tier_switch": service.config.dev_tier_switch, **service.info()}

    @r.post("/dev-tier")
    def dev_tier(body: TierIn, req: Request):
        try:
            entitlements.set_dev_tier(body.tier, req.client.host if req.client else None)
        except PermissionError:
            raise HTTPException(403, {"code": "forbidden", "message": "Tier switch is disabled."})
        except ValueError as e:
            raise HTTPException(422, {"code": "bad_tier", "message": str(e)})
        return entitlement(req)

    @r.post("/transcribe")
    async def transcribe(req: Request, file: UploadFile = File(...)):
        e = premium(req)
        data = await file.read()
        if not data:
            raise HTTPException(400, {"code": "no_audio", "message": "No audio received."})
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, {"code": "audio_too_large", "message": "Recording too large."})
        s = guarded(e)
        try:  # blocking work (decoding, HTTPS, local ASR) off the event loop
            return await run_in_threadpool(_transcribe, e, data, file.filename)
        finally:
            service.end(s)

    def _transcribe(e: Entitlement, data: bytes, filename: str | None) -> dict:
        with tempfile.TemporaryDirectory() as d:  # deleted right after: recordings are not stored
            p = Path(d) / f"speech{Path(filename or 'a.webm').suffix or '.webm'}"
            p.write_bytes(data)
            try:
                audio = decode_file(p, TARGET_SR)
            except AudioError:
                raise HTTPException(400, {"code": "bad_audio", "message": "Could not read the recording."})
            if len(audio) > service.config.max_audio_s * TARGET_SR:
                raise HTTPException(413, {"code": "audio_too_long", "message": f"Please keep commands under {service.config.max_audio_s:g} s."})
            speaker = identify(p)
            try:
                t = service.transcribe(e.subject, audio)
                return {"text": t.text, "hypotheses": [t.text] if t.text else [], "language": t.language,
                        "engine": service.config.sarvam_model, "fallback": None, "latency_s": t.latency_s,
                        "speaker": speaker, "status": "ok" if t.text else "silence",
                        "error": None if t.text else "No speech heard. Try again."}
            except ProviderError as err:
                # Cloud ASR down, out of quota or offline: the on-device recogniser still works.
                text, engine = local_transcribe(p)
                service.usage.record(e.subject, "fallback", fallback=err.kind)
                return {"text": text, "hypotheses": [text] if text else [], "language": None, "engine": engine,
                        "fallback": err.kind, "latency_s": None, "speaker": speaker,
                        "status": "ok" if text else "silence", "error": None if text else "No speech heard. Try again."}

    @r.post("/interpret")
    def interpret(body: InterpretIn, req: Request):
        e = premium(req)
        s = guarded(e)
        try:
            return service.interpret(e.subject, s, body.text, body.state)
        except ProviderError as err:
            # The cockpit falls back to its on-device understanding; nothing was executed.
            raise HTTPException(503, {"code": f"llm_{err.kind}", "message": "Cloud assistant unavailable.", "fallback": "local"})
        finally:
            service.end(s)

    @r.get("/usage")
    def usage():
        return service.usage.summary()

    return r
