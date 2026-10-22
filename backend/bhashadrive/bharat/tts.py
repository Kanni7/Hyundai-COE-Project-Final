"""Speech synthesis through Google Cloud Text-to-Speech (official `google-cloud-texttospeech` client).

Translation and speech are separate services: Cloud Translation only returns text. Before a language is
spoken, the live voice list is checked for a voice in it (best quality tier first); the answer is cached.
Uses the same Application Default Credentials as translation.
"""
from __future__ import annotations

import threading
import time
from collections import OrderedDict

from .errors import ServiceError, google_error
from .languages import Language, language

SERVICE = "Google Cloud Text-to-Speech"
# Voice families by quality, best first ("ta-IN-Wavenet-A", "hi-IN-Neural2-B", ...).
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
        """The voice used for `lang`; raises if the service has none for it."""
        if lang.tts in self._voices:
            return self._voices[lang.tts]
        try:
            voices = self._get_client().list_voices(request={"language_code": lang.tts}, timeout=self.timeout_s).voices
        except ServiceError:
            raise
        except Exception as exc:
            raise google_error("generating_audio", SERVICE, exc) from exc
        names = sorted(v.name for v in voices if lang.tts in v.language_codes)
        ranked = [n for tier in _TIERS for n in names if f"-{tier}-" in n] or names
        if not ranked:
            raise ServiceError("generating_audio", f"{SERVICE} has no voice for {lang.name} ({lang.tts}).", 422, False)
        self._voices[lang.tts] = ranked[0]
        return ranked[0]

    def synthesize(self, text: str, lang_code: str) -> tuple[bytes, str, float]:
        """(MP3 bytes, voice name, seconds)."""
        lang = language(lang_code)
        text = " ".join(text.split())
        if not text:
            raise ServiceError("generating_audio", "Nothing to speak: the translation is empty.", 422, False)
        t0 = time.perf_counter()
        voice = self.voice_for(lang)
        key = (voice, text)
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key], voice, time.perf_counter() - t0
        try:
            resp = self._get_client().synthesize_speech(request={
                "input": {"text": text}, "voice": {"language_code": lang.tts, "name": voice},
                "audio_config": {"audio_encoding": "MP3"}}, timeout=self.timeout_s)
        except Exception as exc:
            raise google_error("generating_audio", SERVICE, exc) from exc
        if not resp.audio_content:
            raise ServiceError("generating_audio", f"{SERVICE} returned no audio.", 502)
        with self._lock:
            self._cache[key] = resp.audio_content
            while len(self._cache) > self.cache_size:
                self._cache.popitem(last=False)
        return resp.audio_content, voice, time.perf_counter() - t0
