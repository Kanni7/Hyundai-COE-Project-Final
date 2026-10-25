"""Speech recognition for BharatConnect: uses the EXACT same SarvamASR (Saaras v4) engine
from the premium voice assistant feature, with Faster-Whisper fallback."""
from __future__ import annotations

import os
import threading
from pathlib import Path

from ..assistant.providers import ProviderError, SarvamASR
from ..audio.preprocessing import TARGET_SR, decode_file
from ..config import ASRConfig, AssistantConfig, BharatConfig
from .errors import ServiceError
from .languages import language


class Transcriber:
    def __init__(self, config: BharatConfig, factory=None):
        self.config = config
        self._factory = factory
        self._asr = None
        self._lock = threading.Lock()
        self._assistant_asr: SarvamASR | None = None

    @property
    def assistant_asr(self) -> SarvamASR:
        if self._assistant_asr is None:
            self._assistant_asr = SarvamASR(AssistantConfig())
        return self._assistant_asr

    @property
    def loaded(self) -> bool:
        has_sarvam = bool(os.environ.get("SARVAM_API_KEY"))
        return has_sarvam or (self._asr is not None)

    @property
    def model(self) -> str:
        if self._factory is not None:
            return f"faster-whisper:{self.config.asr_model}"
        if os.environ.get("SARVAM_API_KEY"):
            return "sarvam:saaras:v4"
        return f"faster-whisper:{self.config.asr_model}"

    def load(self):
        with self._lock:
            if self._asr is None:
                cfg = ASRConfig()
                cfg.model_size = self.config.asr_model
                try:
                    if self._factory is None:
                        from ..audio.asr import FasterWhisperASR
                        self._factory = FasterWhisperASR
                    self._asr = self._factory(cfg)
                except Exception as exc:
                    if not os.environ.get("SARVAM_API_KEY"):
                        raise ServiceError("transcribing", f"Speech recognition could not load: {exc}", 503, False) from exc
        return self._asr

    def transcribe_file(self, path: Path, lang_code: str) -> dict:
        lang = language(lang_code)
        sarvam_key = os.environ.get("SARVAM_API_KEY")

        # If Fake factory is provided (unit tests) or no Sarvam key, use local ASR
        if self._factory is not None or not sarvam_key:
            return self._transcribe_local(path, lang)

        try:
            audio = decode_file(path, TARGET_SR)
            audio_s = audio.size / TARGET_SR
            if audio_s > self.config.max_audio_s:
                raise ServiceError("transcribing", f"Recording longer than {self.config.max_audio_s:g} s.", 413, False)
        except ServiceError:
            raise
        except Exception as exc:
            raise ServiceError("transcribing", f"Could not read the recording: {exc}", 400, False) from exc

        # Primary: The EXACT same SarvamASR engine used by the premium assistant
        try:
            transcript = self.assistant_asr.transcribe(audio, TARGET_SR)
            text = transcript.text.strip()
            return {
                "text": text,
                "language": lang.code,
                "status": "ok" if text else "silence",
                "duration_s": round(audio_s, 2),
                "latency_s": transcript.latency_s
            }
        except ProviderError as e:
            print(f"[Bharat ASR] Premium SarvamASR failed ({e}). Falling back to local.")
        except Exception as e:
            print(f"[Bharat ASR] Sarvam transcription error ({e}). Falling back to local.")

        return self._transcribe_local(path, lang)

    def _transcribe_local(self, path: Path, lang) -> dict:
        try:
            audio = decode_file(path, TARGET_SR)
        except Exception as exc:
            raise ServiceError("transcribing", f"Could not read the recording: {exc}", 400, False) from exc
        if audio.size / TARGET_SR > self.config.max_audio_s:
            raise ServiceError("transcribing", f"Recording longer than {self.config.max_audio_s:g} s.", 413, False)
        asr = self.load()
        with self._lock:
            res = asr.transcribe_verbatim(audio, lang.whisper)
        if res.status == "error":
            raise ServiceError("transcribing", res.error or "Speech recognition failed.", 502)
        return {"text": res.text, "language": lang.code, "status": res.status,
                "duration_s": res.duration_s, "latency_s": res.latency_s}
