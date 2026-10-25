"""Text translation for BharatConnect: Groq LPU (Qwen 27B) / Sarvam Mayura with Google Cloud fallback.
Translates conversational speech between Tamil, Hindi, Bengali, and English."""
from __future__ import annotations

import os
import threading
import time
from collections import OrderedDict
import httpx

from .errors import ServiceError, google_error
from .languages import language

SERVICE = "BharatConnect Translation"

PROMPT_SYSTEM = """You are an expert bilingual interpreter for BharatConnect.
Translate any conversational, casual, or general spoken dialogue between people:
1. Translate the true meaning into natural, polite, everyday spoken language (NOT literal word-by-word translation).
2. Use colloquial phrasing commonly used in India.
3. BharatConnect handles general everyday conversations, casual chats, questions, travel remarks, and spoken dialogue naturally.
4. Output ONLY the translated sentence in the target language's script, with no explanation or quotation marks."""


class GoogleTranslator:
    """Translation engine: uses Groq LPU (Qwen 27B) / Sarvam Mayura, falling back to Google Cloud Translation."""

    def __init__(self, project: str | None = None, timeout_s: float = 8.0, cache_size: int = 256, client=None):
        self.project, self.timeout_s, self.cache_size = project, timeout_s, cache_size
        self._client = client
        self._cache: OrderedDict[tuple[str, str, str], str] = OrderedDict()
        self._lock = threading.Lock()

    def problem(self) -> str | None:
        """Why translation cannot run, or None."""
        if self.project:
            return None
        if not self._client and (os.environ.get("GROQ_API_KEY") or os.environ.get("SARVAM_API_KEY")):
            return None
        return "GOOGLE_CLOUD_PROJECT is not set"

    def _get_client(self):
        if self._client is None:
            try:
                from google.cloud import translate_v3
            except ImportError as exc:
                raise ServiceError("translating", "google-cloud-translate is not installed", 503, False) from exc
            try:
                self._client = translate_v3.TranslationServiceClient()
            except Exception as exc:
                raise google_error("translating", SERVICE, exc) from exc
        return self._client

    def translate(self, text: str, source: str, target: str) -> dict:
        src, tgt = language(source), language(target)
        text = " ".join(text.split())
        if not text:
            raise ServiceError("translating", "Nothing to translate: the transcript is empty.", 422, False)
        t0 = time.perf_counter()
        out = {"source": src.code, "target": tgt.code, "cached": True}
        if src.code == tgt.code:
            return {**out, "text": text, "latency_s": 0.0}
        key = (src.code, tgt.code, text)
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return {**out, "text": self._cache[key], "latency_s": round(time.perf_counter() - t0, 3)}

        # If a custom client was provided (unit tests with FakeTranslate):
        if self._client is not None:
            return self._translate_google(text, src, tgt, t0, out, key)

        # 1. Primary: Groq LPU (Qwen 27B) - natural conversational translation
        groq_key = os.environ.get("GROQ_API_KEY")
        if groq_key:
            try:
                groq_payload = {
                    "model": "qwen/qwen3.8-27b",
                    "messages": [
                        {"role": "system", "content": PROMPT_SYSTEM},
                        {"role": "user", "content": f"Translate from {src.name} to {tgt.name}: {text}"}
                    ],
                    "temperature": 0.1
                }
                headers = {"Authorization": f"Bearer {groq_key}", "Content-Type": "application/json"}
                with httpx.Client(timeout=self.timeout_s) as client:
                    resp = client.post("https://api.groq.com/openai/v1/chat/completions", headers=headers, json=groq_payload)
                if resp.status_code == 200:
                    translated = resp.json()["choices"][0]["message"]["content"].strip()
                    # Strip any surrounding quotes or markdown
                    translated = translated.strip('"\'`')
                    if translated:
                        with self._lock:
                            self._cache[key] = translated
                            while len(self._cache) > self.cache_size:
                                self._cache.popitem(last=False)
                        return {**out, "text": translated, "cached": False, "latency_s": round(time.perf_counter() - t0, 3)}
            except Exception as e:
                print(f"[Bharat Translation] Groq translation failed ({e}). Trying Sarvam.")

        # 2. Secondary: Sarvam Mayura Translation
        sarvam_key = os.environ.get("SARVAM_API_KEY")
        if sarvam_key:
            try:
                payload = {
                    "input": text,
                    "source_language_code": src.tts,
                    "target_language_code": tgt.tts,
                    "model": "mayura:v1"
                }
                headers = {"api-subscription-key": sarvam_key, "Content-Type": "application/json"}
                with httpx.Client(timeout=self.timeout_s) as client:
                    resp = client.post("https://api.sarvam.ai/translate", headers=headers, json=payload)
                if resp.status_code == 200:
                    translated = resp.json().get("translated_text", "").strip()
                    if translated:
                        with self._lock:
                            self._cache[key] = translated
                            while len(self._cache) > self.cache_size:
                                self._cache.popitem(last=False)
                        return {**out, "text": translated, "cached": False, "latency_s": round(time.perf_counter() - t0, 3)}
            except Exception as e:
                print(f"[Bharat Translation] Sarvam Mayura failed ({e}).")

        # 3. Tertiary: Google Cloud Translation
        if self.project:
            return self._translate_google(text, src, tgt, t0, out, key)

        if self.problem():
            raise ServiceError("translating", f"{SERVICE} is not set up: {self.problem()}.", 503, False)

        raise ServiceError("translating", "Translation service unavailable.", 502)

    def _translate_google(self, text: str, src, tgt, t0, out, key) -> dict:
        client = self._get_client()
        try:
            resp = client.translate_text(request={
                "parent": f"projects/{self.project}/locations/global", "contents": [text], "mime_type": "text/plain",
                "source_language_code": src.code, "target_language_code": tgt.code}, timeout=self.timeout_s)
        except Exception as exc:
            raise google_error("translating", "Google Cloud Translation", exc) from exc
        translated = resp.translations[0].translated_text if resp.translations else ""
        if not translated.strip():
            raise ServiceError("translating", "Google Cloud Translation returned an empty translation.", 502)
        with self._lock:
            self._cache[key] = translated
            while len(self._cache) > self.cache_size:
                self._cache.popitem(last=False)
        return {**out, "text": translated, "cached": False, "latency_s": round(time.perf_counter() - t0, 3)}
