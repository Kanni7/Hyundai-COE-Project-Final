"""Speech synthesis for BharatConnect: Sarvam Bulbul Text-to-Speech with Google Cloud fallback. A language neither
service can voice (`Language.speech` False) is refused: the turn keeps its translation as text."""
from __future__ import annotations

import base64
import os
import threading
import time
from collections import OrderedDict
import httpx

from .errors import ServiceError, google_error
from .languages import Language, language

SERVICE = "BharatConnect Speech"
_TIERS = ("Neural2", "Wavenet", "Standard")


class GoogleTTS:
    def __init__(self, timeout_s: float = 10.0, cache_size: int = 64, client=None):
        self.timeout_s, self.cache_size = timeout_s, cache_size
        self._client = client
        self._voices: dict[str, str] = {}
        self._cache: OrderedDict[tuple[str, str], bytes] = OrderedDict()
        self._lock = threading.Lock()

    def _get_client(self):
        if self._client is None:
            try:
                from google.cloud import texttospeech
            except ImportError as exc:
                raise ServiceError("generating_audio", "google-cloud-texttospeech is not installed", 503, False) from exc
            try:
                self._client = texttospeech.TextToSpeechClient()
            except Exception as exc:
                raise google_error("generating_audio", SERVICE, exc) from exc
        return self._client

    def voice_for(self, lang: Language) -> str:
        code = lang.google_tts
        if code is None:
            raise ServiceError("generating_audio", f"{SERVICE} has no voice for {lang.name}.", 422, False)
        if code in self._voices:
            return self._voices[code]
        try:
            voices = self._get_client().list_voices(request={"language_code": code}, timeout=self.timeout_s).voices
        except ServiceError:
            raise
        except Exception as exc:
            raise google_error("generating_audio", SERVICE, exc) from exc
        names = sorted(v.name for v in voices if code in v.language_codes)
        ranked = [n for tier in _TIERS for n in names if f"-{tier}-" in n] or names
        if not ranked:
            raise ServiceError("generating_audio", f"{SERVICE} has no voice for {lang.name} ({code}).", 422, False)
        self._voices[code] = ranked[0]
        return ranked[0]

    def synthesize(self, text: str, lang_code: str) -> tuple[bytes, str, float]:
        """(audio bytes, voice name, seconds)."""
        lang = language(lang_code)
        text = " ".join(text.split())
        if not text:
            raise ServiceError("generating_audio", "Nothing to speak: the translation is empty.", 422, False)
        if not lang.speech:
            raise ServiceError("generating_audio", f"Spoken {lang.name} is not available yet; the translation is shown as text.", 422, False)
        t0 = time.perf_counter()

        # If a mock client was explicitly provided (unit tests):
        if self._client is not None:
            return self._synthesize_google(text, lang, t0)

        # Primary: Sarvam Bulbul TTS
        sarvam_key = os.environ.get("SARVAM_API_KEY")
        if sarvam_key and lang.bulbul:
            voice = f"sarvam:bulbul:v3:aditya"
            key = (voice, text)
            with self._lock:
                if key in self._cache:
                    self._cache.move_to_end(key)
                    return self._cache[key], voice, round(time.perf_counter() - t0, 3)

            try:
                payload = {
                    "inputs": [text],
                    "target_language_code": lang.sarvam,
                    "speaker": "aditya",
                    "model": "bulbul:v3"
                }
                headers = {"api-subscription-key": sarvam_key, "Content-Type": "application/json"}
                with httpx.Client(timeout=self.timeout_s) as client:
                    resp = client.post("https://api.sarvam.ai/text-to-speech", headers=headers, json=payload)
                if resp.status_code == 200:
                    audios = resp.json().get("audios", [])
                    if audios:
                        audio_content = base64.b64decode(audios[0])
                        with self._lock:
                            self._cache[key] = audio_content
                            while len(self._cache) > self.cache_size:
                                self._cache.popitem(last=False)
                        return audio_content, voice, round(time.perf_counter() - t0, 3)
                print(f"[Bharat TTS] Sarvam TTS returned {resp.status_code}: {resp.text[:100]}")
            except Exception as e:
                print(f"[Bharat TTS] Sarvam TTS failed ({e}). Falling back to Google if configured.")

        # Secondary: Google Cloud Text-to-Speech
        return self._synthesize_google(text, lang, t0)

    def _synthesize_google(self, text: str, lang: Language, t0: float) -> tuple[bytes, str, float]:
        voice = self.voice_for(lang)
        key = (voice, text)
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key], voice, round(time.perf_counter() - t0, 3)
        try:
            resp = self._get_client().synthesize_speech(request={
                "input": {"text": text}, "voice": {"language_code": lang.google_tts, "name": voice},
                "audio_config": {"audio_encoding": "MP3"}}, timeout=self.timeout_s)
        except Exception as exc:
            raise google_error("generating_audio", SERVICE, exc) from exc
        if not resp.audio_content:
            raise ServiceError("generating_audio", f"{SERVICE} returned no audio.", 502)
        with self._lock:
            self._cache[key] = resp.audio_content
            while len(self._cache) > self.cache_size:
                self._cache.popitem(last=False)
        return resp.audio_content, voice, round(time.perf_counter() - t0, 3)
