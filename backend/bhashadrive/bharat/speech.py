"""Speech recognition for BharatConnect: uses the exact same premium Sarvam Saaras v4 engine
as the cockpit voice assistant, with keyterms and peak-normalized audio."""
from __future__ import annotations

import io
import json
import os
import threading
import time
from pathlib import Path

import httpx
import numpy as np
import soundfile as sf

from ..assistant.providers import KEYTERMS
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
        return bool(os.environ.get("SARVAM_API_KEY")) or (self._asr is not None)

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

        # Preprocess and peak-normalize audio so faint mic input is properly recognized
        try:
            audio = decode_file(path, TARGET_SR)
            audio_s = audio.size / TARGET_SR
            if audio_s > self.config.max_audio_s:
                raise ServiceError("transcribing", f"Recording longer than {self.config.max_audio_s:g} s.", 413, False)

            # Boost quiet microphone audio up to 0.95 peak
            peak = float(np.max(np.abs(audio))) if audio.size > 0 else 0.0
            if peak > 0.005:
                audio = audio * (0.95 / peak)

            buf = io.BytesIO()
            sf.write(buf, audio, TARGET_SR, format="WAV", subtype="PCM_16")
            wav_bytes = buf.getvalue()
        except ServiceError:
            raise
        except Exception as exc:
            raise ServiceError("transcribing", f"Could not read the recording: {exc}", 400, False) from exc

        # Use the exact Sarvam Saaras v4 pipeline with keyterms from the premium feature
        try:
            t0 = time.perf_counter()
            headers = {"api-subscription-key": sarvam_key}
            data = {
                "model": "saaras:v4",
                "mode": "codemix",
                "language_code": lang.tts,
                "keyterms": json.dumps(KEYTERMS)
            }
            files = {"file": ("speech.wav", wav_bytes, "audio/wav")}
            with httpx.Client(timeout=self.config.translate_timeout_s or 10.0) as client:
                r = client.post("https://api.sarvam.ai/speech-to-text", headers=headers, data=data, files=files)

            if r.status_code == 200:
                transcript = r.json().get("transcript", "").strip()
                if transcript:
                    return {
                        "text": transcript,
                        "language": lang.code,
                        "status": "ok",
                        "duration_s": round(audio_s, 2),
                        "latency_s": round(time.perf_counter() - t0, 3)
                    }
        except Exception as e:
            print(f"[Bharat ASR] Sarvam transcription failed ({e}). Falling back to local.")

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
