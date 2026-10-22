"""Speech recognition for BharatConnect: the backend's Faster-Whisper integration, decoding in the speaker's
language. The model is loaded once (on first use or warm-up) and shared by every request."""
from __future__ import annotations

import threading
from pathlib import Path

from ..audio.preprocessing import TARGET_SR, decode_file
from ..config import ASRConfig, BharatConfig
from .errors import ServiceError
from .languages import language


class Transcriber:
    def __init__(self, config: BharatConfig, factory=None):
        self.config = config
        self._factory = factory
        self._asr = None
        self._lock = threading.Lock()

    @property
    def loaded(self) -> bool:
        return self._asr is not None

    @property
    def model(self) -> str:
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
                    raise ServiceError("transcribing", f"Speech recognition could not load: {exc}", 503, False) from exc
        return self._asr

    def transcribe_file(self, path: Path, lang_code: str) -> dict:
        lang = language(lang_code)
        try:
            audio = decode_file(path, TARGET_SR)
        except Exception as exc:
            raise ServiceError("transcribing", f"Could not read the recording: {exc}", 400, False) from exc
        if audio.size / TARGET_SR > self.config.max_audio_s:
            raise ServiceError("transcribing", f"Recording longer than {self.config.max_audio_s:g} s.", 413, False)
        asr = self.load()
        with self._lock:  # one decode at a time on the shared model
            res = asr.transcribe_verbatim(audio, lang.whisper)
        if res.status == "error":
            raise ServiceError("transcribing", res.error or "Speech recognition failed.", 502)
        return {"text": res.text, "language": lang.code, "status": res.status,
                "duration_s": res.duration_s, "latency_s": res.latency_s}
