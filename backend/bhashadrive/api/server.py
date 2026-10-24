"""Local HTTP API, the Verna cockpit frontend and a minimal test console. Binds to 127.0.0.1 by default.

Every API route is served both at the root (test console, scripts) and under /api (cockpit frontend).
"""
from __future__ import annotations

import tempfile
import threading
from pathlib import Path

from fastapi import APIRouter, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from ..audio.preprocessing import AudioError, decode_file, preprocess
from ..audio.speaker_id import SpeakerID
from ..audio.wind_suppression import WindSuppressionSettings, default_wind_settings, mix_synthetic_wind
from ..assistant.api import assistant_router
from ..assistant.entitlements import Entitlements
from ..assistant.service import AssistantService
from ..bharat.api import BharatServices, bharat_router
from ..config import FRONTEND_DIST, AppConfig

STATIC = Path(__file__).with_name("static")
MAX_UPLOAD_BYTES = 10 * 1024 * 1024


class TextIn(BaseModel):
    text: str = Field(max_length=500)


class ConnectivityIn(BaseModel):
    offline: bool


class WindSettingsIn(BaseModel):
    enabled: bool = True
    strength: float = Field(default=0.75, ge=0.0, le=1.0)
    max_attenuation_db: float = Field(default=18.0, ge=0.0, le=36.0)


def create_app(config: AppConfig | None = None, pipeline=None, legacy: bool = False, mock: bool = False,
               frontend_dir: Path | None = FRONTEND_DIST, command_llm=None, bharat=None, speaker=None,
               assistant=None, entitlements=None) -> FastAPI:
    config = config or AppConfig()
    speaker = speaker or SpeakerID(config.speaker)  # model loads on first use
    bharat = bharat or BharatServices.from_config(config.bharat)  # services load lazily: free until used
    if command_llm is None and pipeline is None and not (mock or legacy):
        try:
            from ..nlu.command_llm import CommandLLM

            command_llm = CommandLLM(config.command_llm)
            print(f"[OK] Command LLM loaded: {command_llm.name}")
        except Exception as e:  # optional fallback interpreter: the cockpit runs without it
            print(f"[NOTE] Command LLM unavailable: {e}")
    if pipeline is None:
        if mock:
            from ..audio.asr import MockASR
            from ..tests.fakes_v2 import make_pipeline

            pipeline = make_pipeline()
            pipeline.asr = MockASR("pause the music")
        elif legacy:  # V1 dev-only benchmark path
            from ..pipeline import build_default_pipeline

            pipeline = build_default_pipeline(config, with_asr=True)
        else:
            try:
                from ..pipeline_v2 import build_v2_pipeline

                pipeline = build_v2_pipeline(config, with_asr=True)
            except Exception as e:
                import sys
                print(f"[NOTE] Model weights not found ({e}). Falling back to mock pipeline for test console.", file=sys.stderr)
                from ..audio.asr import MockASR
                from ..tests.fakes_v2 import make_pipeline

                pipeline = make_pipeline()
                try:
                    from ..audio.hybrid_asr import HybridASR
                    pipeline.asr = HybridASR(config)
                    print(f"[OK] HybridASR initialized: {pipeline.asr.name}")
                except Exception as asr_err:
                    print(f"[NOTE] HybridASR init error: {asr_err}")
                    pipeline.asr = None
    is_v2 = hasattr(pipeline, "model")
    lock = threading.Lock()  # one conversation, processed sequentially
    wind_settings = default_wind_settings()
    if pipeline.asr is not None:
        pipeline.asr.set_wind_settings(wind_settings)
    app = FastAPI(title="BhashaDrive (local prototype)", docs_url="/docs")
    api = APIRouter()

    @app.get("/console", response_class=HTMLResponse)
    def console():
        return (STATIC / "index.html").read_text(encoding="utf-8")

    @api.get("/health")
    def health():
        nlu = pipeline.model.version if is_v2 else getattr(pipeline.parser, "name", "?")
        return {"nlu": nlu, "asr": getattr(pipeline.asr, "name", None),
                "asr_ready": pipeline.asr is not None and getattr(pipeline.asr, "ready", True),
                "llm": getattr(command_llm, "name", None), "llm_ready": command_llm is not None,
                "vehicle": pipeline.vehicle.name, "mock": str(nlu).startswith("fake")}

    @api.post("/interpret")
    def interpret(body: TextIn):
        """Fallback understanding: any sentence -> cockpit commands (frontend `Intent` JSON), by the command LLM."""
        if command_llm is None:
            raise HTTPException(503, "Command LLM not loaded")
        with lock:
            intents, seconds = command_llm.interpret(body.text)
        print(f"[API /interpret] {seconds:.2f}s '{body.text}' -> {intents}")
        return {"intents": intents, "latency_s": round(seconds, 3), "model": command_llm.name}

    @api.post("/text")
    def text(body: TextIn):
        with lock:
            res = pipeline.process_text(body.text)
            from ..nlu.normalizer import to_english
            if getattr(res, "transcript", None):
                res.transcript = to_english(res.transcript)
            print(f"[API /text] input='{body.text}' -> intent='{getattr(res, 'intent', None)}' decision='{getattr(res, 'decision', None)}'")
            return res.model_dump(mode="json")

    async def _upload(file: UploadFile, d: str) -> tuple[Path, bytes]:
        if pipeline.asr is None:
            raise HTTPException(503, "Speech recognition not loaded")
        data = await file.read()
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "Audio too large")
        suffix = Path(file.filename or "audio.webm").suffix or ".webm"
        p = Path(d) / f"upload{suffix}"
        p.write_bytes(data)
        return p, data

    def _wind_payload() -> dict:
        return {
            "enabled": wind_settings.enabled,
            "strength": round(wind_settings.strength, 3),
            "max_attenuation_db": round(wind_settings.max_attenuation_db, 1),
        }

    @api.get("/wind-settings")
    def get_wind_settings():
        """Current runtime wind suppression settings used by server ASR."""
        return _wind_payload()

    @api.post("/wind-settings")
    def update_wind_settings(body: WindSettingsIn):
        """Update wind suppression without restarting the backend."""
        nonlocal wind_settings
        next_settings = WindSuppressionSettings(
            enabled=body.enabled,
            strength=body.strength,
            max_attenuation_db=body.max_attenuation_db,
        ).normalized()
        with lock:
            wind_settings = next_settings
            if pipeline.asr is not None:
                pipeline.asr.set_wind_settings(wind_settings)
        return _wind_payload()

    def _asr_summary(result) -> dict:
        return {
            "text": result.text or "",
            "status": result.status,
            "error": result.error,
            "language": result.language,
            "latency_s": result.latency_s,
        }

    @api.post("/wind-test")
    async def wind_test(file: UploadFile = File(...), wind_level_db: float = Form(6.0)):
        """Compare clean, synthetic-wind, and filtered ASR output for one recording."""
        asr = pipeline.asr
        if asr is None:
            raise HTTPException(503, "Speech recognition not loaded")
        data = await file.read()
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "Audio too large")

        with tempfile.TemporaryDirectory() as d:
            suffix = Path(file.filename or "audio.webm").suffix or ".webm"
            p = Path(d) / f"wind-test{suffix}"
            p.write_bytes(data)
            try:
                clean = decode_file(p)
            except AudioError as exc:
                raise HTTPException(400, f"Could not read the recording: {exc}") from exc

        if clean.size == 0:
            raise HTTPException(400, "The recording was empty")
        level = max(-12.0, min(18.0, float(wind_level_db)))
        noisy = mix_synthetic_wind(clean, level_db=level)
        active = wind_settings
        disabled = WindSuppressionSettings(enabled=False, strength=active.strength,
                                           max_attenuation_db=active.max_attenuation_db)
        with lock:
            try:
                asr.set_wind_settings(disabled)
                clean_result = asr.transcribe_array(clean)
                noisy_result = asr.transcribe_array(noisy)
                asr.set_wind_settings(active)
                filtered_result = asr.transcribe_array(noisy)
            finally:
                asr.set_wind_settings(active)
        return {
            "wind_level_db": level,
            "settings": _wind_payload(),
            "clean": _asr_summary(clean_result),
            "noisy_without_suppression": _asr_summary(noisy_result),
            "noisy_with_suppression": _asr_summary(filtered_result),
        }

    def _identify(p: Path) -> dict | None:
        if not (speaker.ready and speaker.enrolled()):
            return None
        try:
            return speaker.identify(preprocess(decode_file(p), wind_settings=wind_settings))
        except Exception as e:  # driver recognition is a bonus: never lose the command over it
            print(f"[API] speaker ID failed: {e}")
            return None

    def _local_transcribe(p: Path) -> tuple[str, str | None]:
        """The on-device recogniser only (premium fallback): never a cloud engine."""
        asr = getattr(pipeline.asr, "_local_asr", None) or pipeline.asr
        if asr is None:
            return "", None
        with lock:
            res = asr.transcribe_file(p)
            text = res.text or ""
            ranked = pipeline.rank_transcripts(*(res.hypotheses or [text])) if is_v2 and text else [text]
        return (ranked[0] if ranked else ""), getattr(asr, "name", None)

    @api.post("/transcribe")
    async def transcribe(file: UploadFile = File(...)):
        """Speech to text only. The cockpit routes the transcript itself (backend or local parser).

        `text` is the ASR output after phonetic retrieval and self-attention rescoring (the same text the
        NLU sees); `hypotheses` every distinct refined decoding pass, `text` first, for a caller that can
        judge them better (the classifier only knows its own domain); `asr_text` is the recogniser's own output.
        """
        asr = pipeline.asr
        who = None
        with tempfile.TemporaryDirectory() as d:
            p, _ = await _upload(file, d)
            with lock:
                res = asr.transcribe_file(p)
                asr_text = res.text or ""
                ranked = pipeline.rank_transcripts(*(res.hypotheses or [asr_text])) if is_v2 and asr_text else [asr_text]
                if asr_text:
                    who = _identify(p)
        text = ranked[0] if ranked else ""
        name = getattr(getattr(asr, "_local_asr", None) or asr, "name", None)
        print(f"[API /transcribe] {name} {res.latency_s}s status={res.status} asr={res.hypotheses or [asr_text]} -> refined={ranked}")
        return {"text": text, "hypotheses": ranked, "asr_text": asr_text, "asr_hypotheses": res.hypotheses,
                "status": res.status, "error": res.error, "engine": name, "speaker": who}

    def _profile(profile: str) -> str:
        if not profile or len(profile) > 40:
            raise HTTPException(400, f"Invalid profile id: {profile!r}")
        return profile

    @api.get("/speaker")
    def speaker_status():
        """Driver recognition: whether the speaker model is installed and which profiles have a voiceprint."""
        return {"ready": speaker.ready, "enrolled": speaker.enrolled()}

    @api.post("/speaker/{profile}")
    async def speaker_enroll(profile: str, file: UploadFile = File(...)):
        """Add one spoken sentence to a profile's voiceprint. The audio is deleted right after; only the embedding is kept."""
        _profile(profile)
        if not speaker.ready:
            raise HTTPException(503, "Speaker model not installed")
        data = await file.read()
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "Audio too large")
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / f"enroll{Path(file.filename or 'a.webm').suffix or '.webm'}"
            p.write_bytes(data)
            try:
                audio = preprocess(decode_file(p), wind_settings=wind_settings)
            except AudioError:
                raise HTTPException(400, "Could not read the recording")
        try:
            with lock:
                samples = speaker.enroll(profile, audio)
        except ModuleNotFoundError as e:
            if e.name == "sherpa_onnx":
                raise HTTPException(503, "Speaker runtime is not installed; install backend requirements-app.txt") from e
            raise
        except ValueError as e:
            raise HTTPException(400, str(e))
        return {"profile": profile, "samples": samples}

    @api.delete("/speaker/{profile}")
    def speaker_forget(profile: str):
        with lock:
            speaker.forget(_profile(profile))
        return {"profile": profile, "samples": 0}

    @api.post("/audio")
    async def audio(file: UploadFile = File(...)):
        with tempfile.TemporaryDirectory() as d:  # deleted immediately unless BD_STORE_AUDIO is enabled
            p, data = await _upload(file, d)
            with lock:
                result = pipeline.process_audio_file(p)
                from ..nlu.normalizer import to_english
                if getattr(result, "transcript", None):
                    result.transcript = to_english(result.transcript)
                if getattr(result, "normalized_transcript", None):
                    result.normalized_transcript = to_english(result.normalized_transcript)
                asr_res = getattr(result, "asr", None)
                raw_text = (getattr(asr_res, "raw_text", None) or getattr(asr_res, "text", "")) if asr_res else ""
                print(f"[API /audio] {len(data)} bytes ({file.filename}) -> raw='{raw_text}' -> english='{result.transcript}' -> intent='{getattr(result, 'intent', None)}' decision='{getattr(result, 'decision', None)}'")
            if config.store_audio:
                config.audio_store_dir.mkdir(parents=True, exist_ok=True)
                (config.audio_store_dir / p.name).write_bytes(data)
        return result.model_dump(mode="json")

    @api.get("/state")
    def state():
        if is_v2:
            pend = pipeline.state.pending
            return {"vehicle": pipeline.vehicle.get_state(),
                    "context": {"pending": pend.kind if pend else None, "history": list(pipeline.state.history)}}
        return {"vehicle": pipeline.vehicle.get_state(), "context": pipeline.context.summary()}

    @api.get("/personal")
    def personal():
        if not is_v2 or pipeline.store is None:
            return []
        return [{"id": c.id, "trigger": c.trigger, "phrases": c.phrases, "action": c.action.model_dump(mode="json"),
                 "updated_at": c.updated_at} for c in pipeline.store.list_commands(pipeline.profile_id)]

    @api.get("/connectivity")
    def get_connectivity():
        if hasattr(pipeline.asr, "get_status"):
            return pipeline.asr.get_status()
        return {"is_offline": False, "active_engine": getattr(pipeline.asr, "name", "unknown")}

    @api.post("/connectivity")
    def set_connectivity(body: ConnectivityIn):
        if hasattr(pipeline.asr, "set_offline_mode"):
            pipeline.asr.set_offline_mode(body.offline)
            return pipeline.asr.get_status()
        return {"is_offline": body.offline, "note": "ASR engine does not support dynamic toggle"}

    @api.post("/reset")
    def reset():
        if is_v2:
            pipeline.reset()
        else:
            pipeline.context.reset()
        if hasattr(pipeline.vehicle, "reset"):
            pipeline.vehicle.reset()
        return {"ok": True}

    api.include_router(bharat_router(bharat))
    assistant = assistant or AssistantService(config.assistant)
    if assistant.problems and config.assistant.dev_tier_switch:
        print(f"[NOTE] Premium voice disabled until configured: {', '.join(assistant.problems)}")
    api.include_router(assistant_router(assistant, entitlements or Entitlements(config.assistant), _local_transcribe, _identify))
    app.include_router(api)
    app.include_router(api, prefix="/api")
    if frontend_dir is not None and (frontend_dir / "index.html").is_file():
        app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")  # after the API routes
    else:
        @app.get("/", include_in_schema=False)
        def index():
            return RedirectResponse("/console")

    return app


def run(config: AppConfig | None = None, host: str | None = None, port: int | None = None, legacy: bool = False, mock: bool = False) -> None:
    import uvicorn

    config = config or AppConfig()
    if config.pin_performance_cores:
        from ..cpu import pin_to_performance_cores

        cpus = pin_to_performance_cores()
        if cpus:
            print(f"[OK] Inference pinned to performance cores {cpus}")
    uvicorn.run(create_app(config, legacy=legacy, mock=mock), host=host or config.api_host, port=port or config.api_port)
