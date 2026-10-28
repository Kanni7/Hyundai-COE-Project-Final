"""Hybrid In-Car ASR: Cloud Speech API when online with seamless fallback to offline FasterWhisper (Base INT8)."""
from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any
import numpy as np

from ..config import AppConfig
from ..schemas import ASRResult
from .asr import SpeechRecognizer, FasterWhisperASR
from .preprocessing import TARGET_SR, decode_file
from .wind_suppression import WindSuppressionSettings


def _cloud_key() -> str | None:
    """Cloud Whisper is opt-in (BD_HYBRID_CLOUD_ASR=true): OPENAI_API_KEY is also the premium tier's LLM key,
    and its presence alone must not send free-tier audio to a paid cloud service."""
    if os.environ.get("BD_HYBRID_CLOUD_ASR", "true").strip().lower() not in {"1", "true", "yes", "on"}:
        return None
    return os.environ.get("OPENAI_API_KEY") or os.environ.get("GROQ_API_KEY")


class HybridASR(SpeechRecognizer):
    """
    Automotive Dual-Mode ASR:
    - Mode 1: Cloud API (when online and simulated connectivity is ON)
    - Mode 2: In-Car Local FasterWhisper (Base INT8) (when offline, in tunnels, or simulated offline)
    """

    def __init__(self, config: AppConfig | None = None, force_offline: bool = False):
        self.config = config or AppConfig()
        self.simulate_offline = force_offline
        self.local_engine_name = "faster-whisper:base:cpu:int8"
        self._local_asr: SpeechRecognizer | None = None
        if self.simulate_offline or not _cloud_key():
            self._init_local_asr()
        self._update_name()

    def set_wind_settings(self, settings: WindSuppressionSettings) -> None:
        super().set_wind_settings(settings)
        if self._local_asr is not None:
            self._local_asr.set_wind_settings(self.get_wind_settings())

    def _init_local_asr(self):
        # BD_LOCAL_ASR picks the order: "sherpa" (default: the V2 hi-hinglish model, trained on
        # code-switched speech, decoded in Hindi and English passes) or "whisper" (generic
        # faster-whisper, BD_ASR_*). Only the first that loads is kept; the other is a load fallback.
        order = ["whisper", "sherpa"] if os.environ.get("BD_LOCAL_ASR", "sherpa") == "whisper" else ["sherpa", "whisper"]
        for engine in order:
            try:
                if engine == "sherpa":
                    from .sherpa_asr import SherpaWhisperASR
                    self._local_asr = SherpaWhisperASR(self.config.sherpa)
                else:
                    self._local_asr = FasterWhisperASR(self.config.asr)
                self._local_asr.set_wind_settings(self.get_wind_settings())
                self.local_engine_name = self._local_asr.name
                return
            except Exception as e:
                print(f"[NOTE] local ASR '{engine}' unavailable: {e}")

    def _update_name(self):
        local = self.local_engine_name if self._local_asr is not None else "no local model"
        active = f"Offline ({local})" if self.simulate_offline else f"Online (Cloud API + {local})"
        self.name = f"hybrid:{active}"

    @property
    def ready(self) -> bool:
        """True when some engine can transcribe: a local model, or a cloud key while online."""
        cloud = bool(_cloud_key())
        return self._local_asr is not None or (cloud and not self.simulate_offline)

    def set_offline_mode(self, offline: bool) -> None:
        self.simulate_offline = offline
        if offline and self._local_asr is None:
            self._init_local_asr()
        self._update_name()

    def get_status(self) -> dict[str, Any]:
        return {
            "is_offline": self.simulate_offline,
            "active_mode": "offline" if self.simulate_offline else "online",
            "active_engine": self.local_engine_name if self.simulate_offline else "cloud-speech-api",
            "local_engine": self.local_engine_name,
            "cloud_engine": "cloud-speech-api (OpenAI / Sarvam / Hybrid)",
        }

    def _call_cloud_asr(self, audio: np.ndarray, sample_rate: int) -> ASRResult | None:
        """Call external cloud speech API if configured (e.g. OpenAI Whisper or Groq)."""
        import io
        import soundfile as sf
        from ..nlu.normalizer import to_english

        api_key = _cloud_key()
        if not api_key:
            return None  # No cloud key configured, proceed to fast local fallback

        try:
            import httpx

            buf = io.BytesIO()
            sf.write(buf, audio, sample_rate, format="WAV")
            buf.seek(0)

            t0 = time.perf_counter()
            headers = {"Authorization": f"Bearer {api_key}"}
            url = "https://api.openai.com/v1/audio/transcriptions"
            model = "whisper-1"

            if os.environ.get("GROQ_API_KEY"):
                url = "https://api.groq.com/openai/v1/audio/transcriptions"
                model = "whisper-large-v3"

            files = {"file": ("audio.wav", buf, "audio/wav")}
            data = {"model": model}
            if self.config.asr.language:
                data["language"] = self.config.asr.language
            if self.config.asr.initial_prompt:
                data["prompt"] = self.config.asr.initial_prompt

            with httpx.Client(timeout=4.0) as client:
                resp = client.post(url, headers=headers, files=files, data=data)
                if resp.status_code == 200:
                    raw_text = resp.json().get("text", "").strip()
                    text = to_english(raw_text)
                    latency = round(time.perf_counter() - t0, 3)
                    return ASRResult(
                        text=text,
                        raw_text=raw_text,
                        language=self.config.asr.language,
                        latency_s=latency,
                        status="ok" if text else "silence",
                        raw_detected_language="cloud",
                    )
        except Exception:
            pass  # On cloud network error/timeout, fall through to local ASR
        return None

    def transcribe_array(self, audio: np.ndarray, sample_rate: int = TARGET_SR) -> ASRResult:
        t0 = time.perf_counter()

        # 1. If Online Mode is requested and not simulating offline tunnel:
        if not self.simulate_offline:
            # Local ASR applies preprocessing inside its engine.  The cloud path
            # bypasses that code, so clean the same way before uploading it.
            cloud_audio = self.preprocess_audio(audio) if sample_rate == TARGET_SR else audio
            cloud_res = self._call_cloud_asr(cloud_audio, sample_rate)
            if cloud_res and cloud_res.text:
                cloud_res.raw_detected_language = "cloud_api"
                return cloud_res

        # 2. Local In-Car Offline Mode (Faster-Whisper Base / Sherpa-ONNX):
        if self._local_asr is not None:
            res = self._local_asr.transcribe_array(audio, sample_rate)
            res.raw_detected_language = (
                "local_faster_whisper_offline" if self.simulate_offline else "local_faster_whisper_fallback"
            )
            return res

        # 3. If local ASR is still loading, attempt re-init
        self._init_local_asr()
        if self._local_asr is not None:
            res = self._local_asr.transcribe_array(audio, sample_rate)
            res.raw_detected_language = "local_faster_whisper"
            return res

        return ASRResult(
            text="",
            status="error",
            error="ASR engine not available (local models still loading and no cloud connection)",
        )

    def transcribe_file(self, path: str | Path) -> ASRResult:
        path = Path(path)
        if not path.exists() or path.stat().st_size == 0:
            return ASRResult(text="", status="no_audio", error=f"Audio file missing or empty: {path}")
        try:
            raw = decode_file(path, TARGET_SR)
        except Exception as exc:
            return ASRResult(text="", status="error", error=f"Could not decode audio: {exc}")
        return self.transcribe_array(raw, TARGET_SR)
