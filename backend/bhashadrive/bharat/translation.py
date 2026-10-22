"""Text translation through Google Cloud Translation (v3, official `google-cloud-translate` client).

Credentials come from Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS or gcloud), the project
from GOOGLE_CLOUD_PROJECT; nothing here reaches the frontend. Repeated phrases are served from a small cache.
"""
from __future__ import annotations

import threading
import time
from collections import OrderedDict

from .errors import ServiceError, google_error
from .languages import language

SERVICE = "Google Cloud Translation"


class GoogleTranslator:
    def __init__(self, project: str | None, timeout_s: float = 8.0, cache_size: int = 256, client=None):
        self.project, self.timeout_s, self.cache_size = project, timeout_s, cache_size
        self._client = client
        self._cache: OrderedDict[tuple[str, str, str], str] = OrderedDict()
        self._lock = threading.Lock()

    def problem(self) -> str | None:
        """Why translation cannot run, or None. (Credentials are only proven by the first real call.)"""
        return None if self.project else "GOOGLE_CLOUD_PROJECT is not set"

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
        if self.problem():
            raise ServiceError("translating", f"{SERVICE} is not set up: {self.problem()}.", 503, False)
        client = self._get_client()
        try:
            resp = client.translate_text(request={
                "parent": f"projects/{self.project}/locations/global", "contents": [text], "mime_type": "text/plain",
                "source_language_code": src.code, "target_language_code": tgt.code}, timeout=self.timeout_s)
        except Exception as exc:
            raise google_error("translating", SERVICE, exc) from exc
        translated = resp.translations[0].translated_text if resp.translations else ""
        if not translated.strip():
            raise ServiceError("translating", f"{SERVICE} returned an empty translation.", 502)
        with self._lock:
            self._cache[key] = translated
            while len(self._cache) > self.cache_size:
                self._cache.popitem(last=False)
        return {**out, "text": translated, "cached": False, "latency_s": round(time.perf_counter() - t0, 3)}
