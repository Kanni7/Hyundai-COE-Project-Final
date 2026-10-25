"""Text translation for BharatConnect: Google Translation API (Gemini / Cloud Translate / Neural)
with Groq LPU (Qwen 27B) and Sarvam Mayura fallbacks.
Translates conversational speech between Tamil, Hindi, Bengali, and English."""
from __future__ import annotations

import os
import threading
import time
import urllib.parse
from collections import OrderedDict
import httpx

from .errors import ServiceError, google_error
from .languages import language

SERVICE = "BharatConnect Translation"

PROMPT_SYSTEM = """You are an expert bilingual interpreter for BharatConnect.
Translate any conversational, casual, or general spoken dialogue between people:
1. Translate the true meaning into natural, fluent, everyday spoken language (NOT literal word-by-word translation).
2. Use colloquial phrasing commonly spoken in India. BharatConnect handles general everyday conversations, casual chats, travel remarks, questions, and personal dialogue.
3. Output ONLY the translated sentence in the target language's script, with no explanation, no markdown, and no quotation marks."""


class GoogleTranslator:
    """Translation engine: uses Google Translation (Gemini, Cloud Translation v2/v3, and Neural),
    falling back to Groq LPU (Qwen 27B) and Sarvam Mayura."""

    def __init__(self, project: str | None = None, timeout_s: float = 8.0, cache_size: int = 256, client=None):
        self.project, self.timeout_s, self.cache_size = project, timeout_s, cache_size
        self._client = client
        self._cache: OrderedDict[tuple[str, str, str], str] = OrderedDict()
        self._lock = threading.Lock()

    def problem(self) -> str | None:
        """Why translation cannot run, or None."""
        if self._client is not None:
            return None if self.project else "GOOGLE_CLOUD_PROJECT is not set"
        return None

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

    def _try_google(self, text: str, src, tgt) -> str | None:
        """Attempts Google translation via available Google APIs in priority order."""
        google_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or os.environ.get("GOOGLE_TRANSLATE_API_KEY")

        # 1. Google Gemini (exact translation model)
        if google_key:
            try:
                for model in ("gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.0-flash", "gemini-1.5-flash"):
                    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={google_key}"
                    payload = {
                        "system_instruction": {
                            "parts": [{
                                "text": f"You are the core translation engine of Google Translate. Translate the given spoken sentence from {src.name} to {tgt.name}. "
                                        f"Output ONLY the translated sentence in {tgt.name} script ({tgt.native}). "
                                        "Never include pronunciations, explanations, notes, markdown, or quotation marks."
                            }]
                        },
                        "contents": [{
                            "parts": [{"text": text}]
                        }],
                        "generationConfig": {"temperature": 0.0, "maxOutputTokens": 300}
                    }
                    with httpx.Client(timeout=self.timeout_s) as client:
                        r = client.post(url, json=payload)
                    if r.status_code == 200:
                        candidates = r.json().get("candidates", [])
                        if candidates:
                            parts = candidates[0].get("content", {}).get("parts", [])
                            if parts:
                                out = parts[0].get("text", "").strip().strip('"\'`')
                                # Strip conversational prefixes if any
                                if "\n" in out:
                                    out = out.split("\n")[-1].strip().strip('"\'`')
                                if out:
                                    return out
            except Exception as e:
                print(f"[Bharat Translation] Gemini translation attempt failed: {e}")

            # 2. Google Cloud Translation v2 REST
            try:
                url = f"https://translation.googleapis.com/language/translate/v2?key={google_key}"
                payload = {"q": [text], "source": src.code, "target": tgt.code, "format": "text"}
                with httpx.Client(timeout=self.timeout_s) as client:
                    r = client.post(url, json=payload)
                if r.status_code == 200:
                    translations = r.json().get("data", {}).get("translations", [])
                    if translations:
                        out = translations[0].get("translatedText", "").strip()
                        if out:
                            return out
            except Exception as e:
                print(f"[Bharat Translation] Google Cloud Translate v2 attempt failed: {e}")

        # 3. Google Cloud Translation v3 (Service Account client)
        if self.project:
            try:
                client = self._get_client()
                resp = client.translate_text(request={
                    "parent": f"projects/{self.project}/locations/global", "contents": [text], "mime_type": "text/plain",
                    "source_language_code": src.code, "target_language_code": tgt.code}, timeout=self.timeout_s)
                if resp.translations:
                    out = resp.translations[0].translated_text.strip()
                    if out:
                        return out
            except Exception as e:
                print(f"[Bharat Translation] Google Cloud v3 attempt failed: {e}")

        # 4. Google Neural Translation Engine (built-in direct endpoint from translate.google.com)
        try:
            encoded_text = urllib.parse.quote(text)
            url = f"https://translate.googleapis.com/translate_a/single?client=gtx&sl={src.code}&tl={tgt.code}&dt=t&q={encoded_text}"
            with httpx.Client(timeout=self.timeout_s) as client:
                r = client.get(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
            if r.status_code == 200:
                data = r.json()
                if data and isinstance(data, list) and data[0]:
                    out = "".join(part[0] for part in data[0] if part and part[0]).strip()
                    if out:
                        return out
        except Exception as e:
            print(f"[Bharat Translation] Google Neural Translate attempt failed: {e}")

        return None

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

        # 1. Primary: Google's Translation Engine (Gemini / Cloud Translation / Google Neural)
        google_translated = self._try_google(text, src, tgt)
        if google_translated:
            with self._lock:
                self._cache[key] = google_translated
                while len(self._cache) > self.cache_size:
                    self._cache.popitem(last=False)
            return {**out, "text": google_translated, "cached": False, "latency_s": round(time.perf_counter() - t0, 3)}

        # 2. Secondary Fallback: Groq LPU (Qwen 27B)
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
                    translated = translated.strip('"\'`')
                    if translated:
                        with self._lock:
                            self._cache[key] = translated
                            while len(self._cache) > self.cache_size:
                                self._cache.popitem(last=False)
                        return {**out, "text": translated, "cached": False, "latency_s": round(time.perf_counter() - t0, 3)}
            except Exception as e:
                print(f"[Bharat Translation] Groq fallback failed ({e}). Trying Sarvam.")

        # 3. Tertiary Fallback: Sarvam Mayura Translation
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
                print(f"[Bharat Translation] Sarvam Mayura fallback failed ({e}).")

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
