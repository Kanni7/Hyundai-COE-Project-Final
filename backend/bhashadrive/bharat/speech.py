"""Speech recognition for BharatConnect: Sarvam Saaras v4 (primary Indian ASR)
with Google Speech API (Gemini Multimodal) and Faster-Whisper fallbacks."""
from __future__ import annotations

import base64
import io
import json
import os
import threading
import time
from pathlib import Path

import httpx
import numpy as np
import soundfile as sf

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
        has_sarvam = bool(os.environ.get("SARVAM_API_KEY"))
        has_google = bool(os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"))
        return has_sarvam or has_google or (self._asr is not None)

    @property
    def model(self) -> str:
        if self._factory is not None:
            return f"faster-whisper:{self.config.asr_model}"
        if os.environ.get("SARVAM_API_KEY"):
            return "sarvam:saaras:v4"
        if os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"):
            return "google:gemini-flash-lite-latest"
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
                    has_cloud = bool(os.environ.get("SARVAM_API_KEY") or os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"))
                    if not has_cloud:
                        raise ServiceError("transcribing", f"Speech recognition could not load: {exc}", 503, False) from exc
        return self._asr

    def _try_google_stt(self, audio: np.ndarray, wav_bytes: bytes, lang) -> str | None:
        """Transcribe speech using Google APIs (Gemini Multimodal Audio or Google Cloud Speech)."""
        google_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
        if not google_key:
            return None

        # 1. Google Gemini Multimodal Audio
        try:
            b64_audio = base64.b64encode(wav_bytes).decode("ascii")
            for model in ("gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.0-flash", "gemini-1.5-flash"):
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={google_key}"
                prompt = (
                    f"Transcribe this spoken audio verbatim in {lang.name}. "
                    f"Output ONLY the exact words spoken in {lang.name} native script "
                    f"({lang.native}). Do NOT translate. Do NOT add notes, explanations, or quotes."
                )
                payload = {
                    "contents": [{
                        "parts": [
                            {
                                "inline_data": {
                                    "mime_type": "audio/wav",
                                    "data": b64_audio
                                }
                            },
                            {
                                "text": prompt
                            }
                        ]
                    }],
                    "generationConfig": {"temperature": 0.0, "maxOutputTokens": 300}
                }
                with httpx.Client(timeout=self.config.translate_timeout_s or 12.0) as client:
                    r = client.post(url, json=payload)
                if r.status_code == 200:
                    candidates = r.json().get("candidates", [])
                    if candidates:
                        parts = candidates[0].get("content", {}).get("parts", [])
                        if parts:
                            transcript = parts[0].get("text", "").strip().strip('"\'`')
                            if "\n" in transcript:
                                transcript = transcript.split("\n")[-1].strip().strip('"\'`')
                            if transcript:
                                return transcript
        except Exception as e:
            print(f"[Bharat ASR] Google Gemini audio transcription attempt failed: {e}")

        # 2. Google Cloud Speech-to-Text v1 REST API
        try:
            pcm_bytes = (audio * 32767).astype(np.int16).tobytes()
            b64_pcm = base64.b64encode(pcm_bytes).decode("ascii")
            url = f"https://speech.googleapis.com/v1/speech:recognize?key={google_key}"
            payload = {
                "config": {
                    "encoding": "LINEAR16",
                    "sampleRateHertz": TARGET_SR,
                    "languageCode": lang.tts,
                    "enableAutomaticPunctuation": True
                },
                "audio": {
                    "content": b64_pcm
                }
            }
            with httpx.Client(timeout=self.config.translate_timeout_s or 10.0) as client:
                r = client.post(url, json=payload)
            if r.status_code == 200:
                results = r.json().get("results", [])
                if results and results[0].get("alternatives"):
                    transcript = results[0]["alternatives"][0].get("transcript", "").strip()
                    if transcript:
                        return transcript
        except Exception as e:
            print(f"[Bharat ASR] Google Cloud Speech v1 attempt failed: {e}")

        return None

    def transcribe_file(self, path: Path, lang_code: str) -> dict:
        lang = language(lang_code)
        sarvam_key = os.environ.get("SARVAM_API_KEY")
        google_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")

        # If Fake factory is provided (unit tests) or no cloud keys, use local ASR
        if self._factory is not None or (not sarvam_key and not google_key):
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

        t0 = time.perf_counter()

        # 1. Primary: Sarvam Saaras v4 (dedicated Indian language STT, ~0.3s, clean, no car biasing)
        if sarvam_key:
            try:
                headers = {"api-subscription-key": sarvam_key}
                data = {
                    "model": "saaras:v4",
                    "mode": "codemix",
                    "language_code": lang.tts
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
                print(f"[Bharat ASR] Sarvam transcription failed ({e}). Trying Google.")

        # 2. Secondary Fallback: Google Gemini Audio STT
        if google_key:
            google_text = self._try_google_stt(audio, wav_bytes, lang)
            if google_text:
                return {
                    "text": google_text,
                    "language": lang.code,
                    "status": "ok",
                    "duration_s": round(audio_s, 2),
                    "latency_s": round(time.perf_counter() - t0, 3)
                }

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
