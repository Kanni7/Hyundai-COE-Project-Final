"""In-car speech recognition: Sarvam Saaras v4 in the cloud, an on-device model when the cloud cannot answer.

Cloud (22 Indian languages + Indian/global English): Sarvam with the premium assistant's settings, except the
mode: `sarvam_incar_mode` (default `translate`) turns speech in any of the 22 languages into English, which the
on-device command and assistant models read best; `language` says which language was spoken.

On-device (no SARVAM_API_KEY, no network, tunnel, quota, any Sarvam error): sherpa-onnx Whisper
(SherpaASRConfig, default hi-hinglish-swift: a Whisper-base fine-tune on Hindi-English code-switched speech,
INT8, ~205 MB RAM, ~0.5 s per command on 2 CPU threads). It writes code-mixed Hinglish in Latin script
("fan ki speed thodi kam kar do"). It is loaded at start when there is no key, otherwise on the first cloud
failure, so an online car does not hold it in RAM. When the driver picked a language with an installed language
pack (local_ai/packs.py), offline speech in that language goes to its IndicConformer model instead, and the
on-device assistant translates the transcript to English when it can.
"""
from __future__ import annotations

import dataclasses
import threading

import httpx
import numpy as np

from ..assistant.providers import ProviderError, SarvamASR
from ..config import AppConfig
from ..nlu.normalizer import to_english
from ..schemas import ASRResult
from .asr import SpeechRecognizer
from .preprocessing import TARGET_SR


class CloudASR(SpeechRecognizer):
    def __init__(self, config: AppConfig | None = None, client: httpx.Client | None = None, local_factory=None,
                 packs=None, assistant=None):
        self.config = config or AppConfig()
        # No retry: a second attempt doubles the wait before the on-device model answers.
        c = dataclasses.replace(self.config.assistant, retries=0, sarvam_mode=self.config.assistant.sarvam_incar_mode)
        self.packs, self.assistant = packs, assistant
        self._packs_asr: dict[str, SpeechRecognizer] = {}
        self.sarvam = SarvamASR(c, client)
        self.cloud_name = f"sarvam:{c.sarvam_model}:{c.sarvam_mode}"
        self.name = self.cloud_name
        self._local_factory = local_factory
        self._local: SpeechRecognizer | None = None
        self._local_error: str | None = None
        self._lock = threading.Lock()
        if self.cloud_ready:
            self.sarvam.keep_warm()
        else:
            self._load_local()

    @property
    def cloud_ready(self) -> bool:
        return bool(self.sarvam.config.sarvam_api_key)

    @property
    def ready(self) -> bool:
        return self.cloud_ready or self._local is not None

    def set_wind_settings(self, settings) -> None:
        super().set_wind_settings(settings)
        if self._local is not None:
            self._local.set_wind_settings(self.get_wind_settings())

    def _load_local(self) -> SpeechRecognizer | None:
        with self._lock:
            if self._local is None and self._local_error is None:
                try:
                    if self._local_factory is None:
                        from .sherpa_asr import SherpaWhisperASR
                        self._local = SherpaWhisperASR(self.config.sherpa)
                    else:
                        self._local = self._local_factory()
                    self._local.set_wind_settings(self.get_wind_settings())
                    print(f"[OK] On-device ASR loaded: {self._local.name}")
                except Exception as e:  # missing model files: report it once, then cloud only
                    self._local_error = str(e)
                    print(f"[NOTE] On-device ASR unavailable: {e}")
        return self._local

    def transcribe_array(self, audio: np.ndarray, sample_rate: int = TARGET_SR) -> ASRResult:
        why = "SARVAM_API_KEY is not set"
        if self.cloud_ready:
            cloud_audio = self.preprocess_audio(audio) if sample_rate == TARGET_SR else audio
            try:
                t = self.sarvam.transcribe(cloud_audio, sample_rate)
                self.name = self.cloud_name
                # `raw_text` is Sarvam's exact transcript; `text` the Latin-script form the on-device NLU reads.
                return ASRResult(text=to_english(t.text), raw_text=t.text, language=t.language,
                                 raw_detected_language=t.language, duration_s=t.audio_s, latency_s=t.latency_s,
                                 status="ok" if t.text else "silence")
            except ProviderError as e:
                why = f"cloud speech recognition failed ({e.kind})"
        pack = self._pack_asr()
        if pack is not None:
            return self._transcribe_pack(pack, audio, sample_rate, why)
        local = self._load_local()
        if local is None:
            return ASRResult(text="", status="error", error=f"No speech recognition: {why}, and the on-device model "
                                                            f"could not load ({self._local_error}).")
        res = local.transcribe_array(audio, sample_rate)  # the engine applies the same preprocessing itself
        res.raw_detected_language = f"on-device ({why})"
        self.name = local.name
        return res

    def _pack_asr(self) -> SpeechRecognizer | None:
        """The driver's language pack recogniser, when one is picked, installed and not built in (hi/en)."""
        from ..local_ai.packs import SMALL_LANGS

        lang = self.packs.active_language if self.packs is not None else None
        if not lang or lang in SMALL_LANGS or not self.packs.installed(lang):
            return None
        if lang not in self._packs_asr:
            from .indic_asr import IndicConformerASR

            self._packs_asr[lang] = IndicConformerASR(self.packs.path(lang), self.packs.dir / "asr" / "tokens.txt", lang,
                                                      max_audio_s=self.config.sherpa.max_audio_s)
        return self._packs_asr[lang]

    def _transcribe_pack(self, pack: SpeechRecognizer, audio: np.ndarray, sample_rate: int, why: str) -> ASRResult:
        res = pack.transcribe_array(audio, sample_rate)
        res.raw_detected_language = f"on-device {pack.name} ({why})"
        self.name = pack.name
        if res.text and self.assistant is not None and self.assistant.model_path is not None:
            res.text = self.assistant.to_english(res.text, self.packs.active_language)["text"]  # raw_text keeps the driver's words
        return res
