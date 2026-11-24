"""On-device speech recognition for one Indian language: AI4Bharat IndicConformer (CTC), sherpa-onnx INT8.

Loaded from a language pack (local_ai/packs.py). Writes the language's own script ("ஏசி கொஞ்சம் குறை").
"""
from __future__ import annotations

import time
from pathlib import Path

import numpy as np

from ..schemas import ASRResult
from .asr import ASRUnavailableError, SpeechRecognizer
from .preprocessing import TARGET_SR, is_silent


class IndicConformerASR(SpeechRecognizer):
    def __init__(self, model: Path, tokens: Path, language: str, threads: int = 2, max_audio_s: float = 20.0):
        try:
            import sherpa_onnx

            self.recognizer = sherpa_onnx.OfflineRecognizer.from_nemo_ctc(
                model=str(model), tokens=str(tokens), num_threads=threads, decoding_method="greedy_search")
        except Exception as exc:
            raise ASRUnavailableError(f"Could not load the {language} speech model {model}: {exc}") from exc
        self.language, self.max_audio_s = language, max_audio_s
        self.name = f"indicconformer:{language}:int8:{threads}t"

    def transcribe_array(self, audio: np.ndarray, sample_rate: int = TARGET_SR) -> ASRResult:
        audio = np.asarray(audio, dtype=np.float32).reshape(-1)
        duration = audio.size / sample_rate
        if audio.size == 0:
            return ASRResult(text="", status="no_audio", error="No audio samples received")
        if duration > self.max_audio_s:
            return ASRResult(text="", status="error", duration_s=round(duration, 2),
                             error=f"Audio longer than the {self.max_audio_s:g}s limit")
        if is_silent(audio, 0.01):  # same threshold as the Hinglish model (BD_ASR_MIN_RMS default)
            return ASRResult(text="", status="silence", duration_s=round(duration, 2))
        t0 = time.perf_counter()
        stream = self.recognizer.create_stream()
        stream.accept_waveform(sample_rate, self.preprocess_audio(audio) if sample_rate == TARGET_SR else audio)
        self.recognizer.decode_stream(stream)
        text = stream.result.text.strip()
        return ASRResult(text=text, raw_text=text, language=self.language, duration_s=round(duration, 2),
                         status="ok" if text else "silence", latency_s=round(time.perf_counter() - t0, 3))
