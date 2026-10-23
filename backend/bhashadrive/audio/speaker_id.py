"""Who is speaking: matches a voice against the voiceprints of the cockpit's driver profiles.

A voiceprint is the mean of a profile's enrollment embeddings (CAM++ speaker model, 512-d, run by
sherpa-onnx on the CPU: ~30 ms per utterance). Only embeddings are stored, never the audio; they are
biometric data, so they stay on this machine (data/profiles, git-ignored) and `forget` deletes them.
"""
from __future__ import annotations

import json
import threading
from pathlib import Path

import numpy as np

from ..config import SpeakerIDConfig
# Profile IDs are now dynamic; no fixed whitelist
from .preprocessing import TARGET_SR

# Profile IDs are dynamic: any string accepted.
PROFILE_IDS: None = None  # kept for import compat; no longer filters


def _unit(v: np.ndarray) -> np.ndarray:
    return v / (np.linalg.norm(v) + 1e-9)


class SpeakerID:
    def __init__(self, config: SpeakerIDConfig):
        self.config = config
        self._extractor = None  # loaded on first use
        self._lock = threading.Lock()
        self._samples: dict[str, list[list[float]]] = {}
        if config.store_path.exists():
            data = json.loads(config.store_path.read_text(encoding="utf-8"))
            self._samples = {p: s for p, s in data.get("samples", {}).items() if p}

    @property
    def ready(self) -> bool:
        return self.config.model_path.exists()

    def _embed(self, audio: np.ndarray) -> np.ndarray:
        if self._extractor is None:
            import sherpa_onnx

            self._extractor = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=str(self.config.model_path), num_threads=self.config.threads))
        stream = self._extractor.create_stream()
        stream.accept_waveform(TARGET_SR, np.ascontiguousarray(audio, dtype=np.float32))
        stream.input_finished()
        return _unit(np.asarray(self._extractor.compute(stream), dtype=np.float32))

    def _voiced(self, audio: np.ndarray) -> np.ndarray:
        """Drop silent 30 ms frames, so pauses don't dilute the voice (and length checks count speech only)."""
        n = 480
        frames = audio[: len(audio) // n * n].reshape(-1, n)
        if not len(frames):
            return audio[:0]
        rms = np.sqrt((frames ** 2).mean(axis=1))
        return frames[rms > max(self.config.min_rms, rms.max() * 0.05)].reshape(-1)

    def _load(self) -> None:
        if self.config.store_path.exists():
            try:
                data = json.loads(self.config.store_path.read_text(encoding="utf-8"))
                self._samples = {p: s for p, s in data.get("samples", {}).items() if p}
            except Exception:
                pass

    def enrolled(self) -> dict[str, int]:
        self._load()
        return {p: len(s) for p, s in self._samples.items() if s}

    def enroll(self, profile: str, audio: np.ndarray) -> int:
        """Add one utterance to the profile's voiceprint; returns its number of samples."""
        speech = self._voiced(audio)
        if len(speech) < self.config.min_enroll_s * TARGET_SR:
            raise ValueError(f"Need at least {self.config.min_enroll_s:g} s of speech; please say the whole sentence.")
        emb = self._embed(speech)
        with self._lock:
            existing = self._samples.get(profile, [])
            # Reject outlier: if there are existing samples, the new one must be similar
            # to the mean of the existing ones (i.e. same person).
            if existing:
                mean_emb = _unit(np.mean(existing, axis=0))
                sim = float(mean_emb @ emb)
                print(f"[Speaker ID] Enroll {profile}: new sample similarity to existing mean = {sim:.3f}")
                if sim < 0.35:
                    raise ValueError(
                        f"This voice sample doesn't match {profile}'s existing voiceprint "
                        f"(similarity {sim:.2f}). Please make sure the same person is speaking, "
                        f"or clear the voice first and re-enroll."
                    )
            # The newest samples win, so re-enrolling in a new cabin or with a cold tracks the voice.
            samples = (existing + [emb.round(5).tolist()])[-self.config.max_samples:]
            self._samples[profile] = samples
            self._save()
        return len(samples)

    def forget(self, profile: str) -> None:
        with self._lock:
            self._samples.pop(profile, None)
            self._save()

    def identify(self, audio: np.ndarray) -> dict | None:
        """The enrolled profile this voice belongs to, or None when unsure (too short, too far from every
        voiceprint, or too close to two of them). Scores are cosine similarities."""
        self._load()
        prints = {p: _unit(np.mean(s, axis=0)) for p, s in self._samples.items() if s}
        speech = self._voiced(audio)
        if not prints:
            return None
        speech_s = len(speech) / TARGET_SR
        if speech_s < self.config.min_identify_s:
            print(f"[Speaker ID] Voice clip too short: {speech_s:.2f}s of speech (minimum {self.config.min_identify_s:.2f}s)")
            return None
        emb = self._embed(speech)
        scores = sorted(((float(v @ emb), p) for p, v in prints.items()), reverse=True)
        best, who = scores[0]
        margin = best - scores[1][0] if len(scores) > 1 else best
        print(f"[Speaker ID] Evaluated: best={who} score={best:.3f} margin={margin:.3f} all={scores}")
        if best < self.config.threshold:
            print(f"[Speaker ID] -> REJECTED: best score {best:.3f} < threshold {self.config.threshold}")
            return None
        if margin < self.config.margin:
            print(f"[Speaker ID] -> REJECTED: margin {margin:.3f} < min_margin {self.config.margin} (ambiguous with {scores[1][1]})")
            return None
        print(f"[Speaker ID] -> RECOGNIZED: {who} (score={best:.3f}, margin={margin:.3f})")
        return {"profile": who, "score": round(best, 3), "margin": round(margin, 3)}

    def _save(self) -> None:
        self.config.store_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.config.store_path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"model": self.config.model_path.name, "samples": self._samples}), encoding="utf-8")
        tmp.replace(self.config.store_path)
