"""On-device ASR on sherpa-onnx Whisper exports (e.g. hi-hinglish-apex), run with onnxruntime.

The `SpeechRecognizer` interface is runtime-agnostic: an Android/embedded build would
implement the same contract with the sherpa-onnx Kotlin/C++ API and the same model files.
"""
from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from pathlib import Path

import numpy as np

from ..config import SherpaASRConfig
from ..schemas import ASRResult
from .asr import ASRUnavailableError, SpeechRecognizer
from .preprocessing import TARGET_SR, is_silent, preprocess


_MODEL_FILES = ("encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt")


class SherpaWhisperASR(SpeechRecognizer):
    extra_models: list | tuple = ()

    def __init__(self, config: SherpaASRConfig | None = None):
        self.config = c = config or SherpaASRConfig()
        d = Path(c.model_dir)
        missing = [str(d / f) for f in _MODEL_FILES if not (d / f).is_file()]
        if missing:
            raise ASRUnavailableError(f"ASR model files missing: {missing}. Run `python scripts/download_models.py` once.")
        try:
            from .whisper_onnx import WhisperOnnx

            self.model = WhisperOnnx(d, threads=c.threads)
        except Exception as exc:
            raise ASRUnavailableError(f"Could not load Whisper ONNX model from {d}: {exc}") from exc
        self.extra_models, names = [], [d.name]
        for e in map(Path, c.extra_model_dirs):
            if e.resolve() == d.resolve() or not all((e / f).is_file() for f in _MODEL_FILES):
                continue
            try:
                self.extra_models.append(WhisperOnnx(e, threads=c.threads))
                names.append(e.name)
            except Exception as exc:  # optional second opinion: run without it
                print(f"[NOTE] extra ASR model {e} unavailable: {exc}")
        self.name = f"whisper-onnx:{'+'.join(names)}:int8:{c.threads}t"
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="asr")

    def _decode(self, audio: np.ndarray) -> list[str]:
        """One text per configured language and model (primary first). Per model the encoder runs once and
        the languages decode as one batch."""
        return [t for m in [self.model, *self.extra_models] for t in m.transcribe(audio, self.config.languages)]

    def transcribe_array(self, audio: np.ndarray, sample_rate: int = TARGET_SR) -> ASRResult:
        audio = np.asarray(audio, dtype=np.float32).reshape(-1) if audio is not None else np.zeros(0, np.float32)
        if audio.size == 0:
            return ASRResult(text="", status="no_audio", error="No audio samples received")
        if sample_rate != TARGET_SR:
            return ASRResult(text="", status="error", error=f"Expected {TARGET_SR} Hz audio, got {sample_rate}")
        duration = audio.shape[0] / sample_rate
        if duration > self.config.max_audio_s:
            return ASRResult(text="", status="error", duration_s=round(duration, 2),
                             error=f"Audio longer than the {self.config.max_audio_s:g}s limit")
        if is_silent(audio, self.config.min_rms):
            return ASRResult(text="", status="silence", duration_s=round(duration, 2))
        t0 = time.perf_counter()
        fut = self._pool.submit(self._decode, self.preprocess_audio(audio))
        try:
            texts = fut.result(timeout=self.config.timeout_s)
        except FutureTimeout:
            return ASRResult(text="", status="error", error=f"ASR timeout after {self.config.timeout_s:g}s",
                             duration_s=round(duration, 2))
        except Exception as exc:
            return ASRResult(text="", status="error", error=f"ASR inference failed: {exc}")
        langs = list(self.config.languages) * (1 + len(self.extra_models))
        heard = [(lang, t) for lang, t in zip(langs, texts) if t]
        if len(heard) > 1:
            # A pass with at most half the words of the longest one stopped early or emitted junk
            # ("Music" vs "Music ko pause kar do", "nan" vs "Lock the car").
            longest = max(len(t.split()) for _, t in heard)
            heard = [(lang, t) for lang, t in heard if len(t.split()) * 2 > longest]
        text, language = (heard[0][1], heard[0][0]) if heard else ("", self.config.languages[0])
        return ASRResult(text=text, hypotheses=list(dict.fromkeys(t for _, t in heard)), language=language,
                         duration_s=round(duration, 2), status="ok" if text else "silence",
                         latency_s=round(time.perf_counter() - t0, 3))
