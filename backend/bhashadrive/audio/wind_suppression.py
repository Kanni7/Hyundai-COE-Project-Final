"""Conservative, dependency-free wind-noise suppression for speech recordings.

Wind noise is usually strongest in the low-frequency part of a microphone signal,
but speech fundamentals can occupy the same region.  This module therefore uses a
soft, time-varying low-shelf attenuation instead of a hard high-pass cut.  It is
intended as a first production-friendly baseline before adding a wind-trained
neural enhancer or a two-microphone beamformer.
"""
from __future__ import annotations

from dataclasses import dataclass
import os

import numpy as np


@dataclass
class WindSuppressionSettings:
    """Runtime settings shared by ASR requests and the cockpit controls."""

    enabled: bool = True
    strength: float = 0.75
    max_attenuation_db: float = 18.0

    def normalized(self) -> "WindSuppressionSettings":
        return WindSuppressionSettings(
            enabled=bool(self.enabled),
            strength=float(np.clip(self.strength, 0.0, 1.0)),
            max_attenuation_db=float(np.clip(self.max_attenuation_db, 0.0, 36.0)),
        )


def _env_bool(name: str, default: bool) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


def default_wind_settings() -> WindSuppressionSettings:
    """Read the initial settings from the environment."""
    return WindSuppressionSettings(
        enabled=_env_bool("BD_WIND_SUPPRESSION_ENABLED", True),
        strength=_env_float("BD_WIND_SUPPRESSION_STRENGTH", 0.75),
        max_attenuation_db=_env_float("BD_WIND_SUPPRESSION_MAX_DB", 18.0),
    ).normalized()


@dataclass(frozen=True)
class WindAnalysis:
    """Frame-level wind scores returned by :func:`analyze_wind`."""

    frame_probability: np.ndarray
    mean_probability: float
    max_probability: float


def _sigmoid(value: np.ndarray) -> np.ndarray:
    value = np.clip(value, -30.0, 30.0)
    return 1.0 / (1.0 + np.exp(-value))


def _next_power_of_two(value: int) -> int:
    return 1 << max(0, int(value - 1).bit_length())


def _stft(audio: np.ndarray, sample_rate: int, frame_ms: float, hop_ms: float):
    frame_length = max(64, int(round(sample_rate * frame_ms / 1000.0)))
    hop_length = max(1, int(round(sample_rate * hop_ms / 1000.0)))
    n_fft = _next_power_of_two(frame_length)
    n_frames = max(1, int(np.ceil(max(0, audio.size - frame_length) / hop_length)) + 1)
    padded_length = (n_frames - 1) * hop_length + frame_length
    padded = np.pad(audio, (0, max(0, padded_length - audio.size)))
    frames = np.lib.stride_tricks.sliding_window_view(padded, frame_length)[::hop_length]
    window = np.hanning(frame_length).astype(np.float32)
    spectrum = np.fft.rfft(frames * window, n=n_fft, axis=1)
    frequencies = np.fft.rfftfreq(n_fft, 1.0 / sample_rate)
    return spectrum, frequencies, window, hop_length, frame_length


def _safe_band_mean(power: np.ndarray, mask: np.ndarray) -> np.ndarray:
    if not np.any(mask):
        return np.mean(power, axis=1)
    return np.mean(power[:, mask], axis=1)


def analyze_wind(audio: np.ndarray, sample_rate: int = 16000) -> WindAnalysis:
    """Estimate wind probability per frame without modifying the signal.

    The score is deliberately a heuristic, not a calibrated probability.  It
    combines low-frequency dominance, frame activity, low-band movement, and
    evidence of speech energy above the low band.
    """
    signal = np.asarray(audio, dtype=np.float32).reshape(-1)
    if signal.size == 0:
        empty = np.zeros(0, dtype=np.float32)
        return WindAnalysis(empty, 0.0, 0.0)
    if sample_rate <= 0:
        raise ValueError("sample_rate must be positive")

    signal = signal - float(np.mean(signal))
    spectrum, frequencies, _window, _hop, _frame = _stft(signal, sample_rate, 32.0, 10.0)
    power = np.square(np.abs(spectrum)).astype(np.float64)
    eps = 1e-12

    low_mask = (frequencies >= 80.0) & (frequencies <= min(350.0, sample_rate / 2.0))
    speech_mask = (frequencies >= 500.0) & (frequencies <= min(3500.0, sample_rate / 2.0))
    low_power = _safe_band_mean(power, low_mask)
    speech_power = _safe_band_mean(power, speech_mask)
    frame_power = np.mean(power, axis=1)

    ratio_db = 10.0 * np.log10((low_power + eps) / (speech_power + eps))
    ratio_score = _sigmoid((ratio_db - 2.0) / 4.0)

    frame_db = 10.0 * np.log10(frame_power + eps)
    floor_db = float(np.percentile(frame_db, 20.0))
    activity = np.clip((frame_db - floor_db + 3.0) / 18.0, 0.25, 1.0)

    low_log = np.log(low_power + eps)
    low_flux = np.abs(np.diff(low_log, prepend=low_log[:1]))
    flux_score = _sigmoid((low_flux - 0.35) / 0.6)

    # Voiced speech tends to have harmonic peaks in this band. Wind is usually
    # broader and flatter, so use spectral flatness and peakiness to avoid
    # treating a naturally low-pitched speaker as wind.
    low_bins = power[:, low_mask] if np.any(low_mask) else power
    low_flatness = np.exp(np.mean(np.log(low_bins + eps), axis=1)) / (np.mean(low_bins, axis=1) + eps)
    flat_noise_score = _sigmoid((low_flatness - 0.52) / 0.08)
    low_peakiness = np.max(low_bins, axis=1) / (np.mean(low_bins, axis=1) + eps)
    tonal_speech_score = _sigmoid((low_peakiness - 3.0) / 0.8)
    wind_shape_score = (0.10 + 0.90 * flat_noise_score) * (1.0 - 0.35 * tonal_speech_score)

    speech_evidence = speech_power / (low_power + speech_power + eps)
    scores = ratio_score * activity * (0.7 + 0.3 * flux_score) * wind_shape_score
    scores *= 1.0 - 0.55 * np.clip(speech_evidence, 0.0, 1.0)
    scores = np.clip(scores, 0.0, 1.0).astype(np.float32)

    # Smooth attack/release so the filter does not pump on every speech frame.
    smoothed = np.empty_like(scores)
    previous = float(scores[0])
    for index, value in enumerate(scores):
        alpha = 0.35 if value > previous else 0.08
        previous += alpha * (float(value) - previous)
        smoothed[index] = previous

    return WindAnalysis(smoothed, float(np.mean(smoothed)), float(np.max(smoothed)))


def estimate_wind_probability(audio: np.ndarray, sample_rate: int = 16000) -> float:
    """Return the average heuristic wind score for a clip."""
    return analyze_wind(audio, sample_rate).mean_probability


def mix_synthetic_wind(audio: np.ndarray, sample_rate: int = 16000, level_db: float = 6.0, seed: int = 42) -> np.ndarray:
    """Mix deterministic low-frequency broadband wind into a speech recording.

    ``level_db`` is relative to the input RMS: 0 dB means approximately equal
    RMS, positive values make the wind stronger, and negative values make it
    weaker. This is used by the frontend wind test so every run is repeatable.
    """
    signal = np.asarray(audio, dtype=np.float32).reshape(-1)
    if signal.size == 0:
        return signal.copy()
    if sample_rate <= 0:
        raise ValueError("sample_rate must be positive")

    rng = np.random.default_rng(seed)
    noise = rng.standard_normal(signal.size).astype(np.float32)
    spectrum = np.fft.rfft(noise)
    frequencies = np.fft.rfftfreq(signal.size, 1.0 / sample_rate)
    spectrum[(frequencies < 40.0) | (frequencies > min(350.0, sample_rate / 2.0))] = 0.0
    wind = np.fft.irfft(spectrum, n=signal.size).astype(np.float32)
    wind -= float(np.mean(wind))
    wind_rms = float(np.sqrt(np.mean(np.square(wind))))
    if wind_rms <= 1e-8:
        return signal.copy()

    clean_rms = float(np.sqrt(np.mean(np.square(signal))))
    target_rms = max(clean_rms * (10.0 ** (float(level_db) / 20.0)), 0.02)
    time = np.arange(signal.size, dtype=np.float32) / sample_rate
    envelope = 0.55 + 0.45 * (0.5 + 0.5 * np.sin(2.0 * np.pi * 0.7 * time))
    wind = wind / wind_rms * target_rms * envelope
    return np.clip(signal + wind, -1.0, 1.0).astype(np.float32)


def reduce_wind_noise(
    audio: np.ndarray,
    sample_rate: int = 16000,
    *,
    strength: float = 0.75,
    max_attenuation_db: float = 18.0,
    low_cut_hz: float = 80.0,
    transition_hz: float = 600.0,
) -> np.ndarray:
    """Reduce wind while preserving speech above the low-frequency region.

    ``strength`` is clamped to ``0..1``.  A value of zero returns a copy of the
    input.  The output always has the same length and dtype as a float32 signal.
    """
    signal = np.asarray(audio, dtype=np.float32).reshape(-1)
    if signal.size == 0:
        return signal.copy()
    if sample_rate <= 0:
        raise ValueError("sample_rate must be positive")
    if strength <= 0.0:
        return signal.copy()
    if transition_hz <= low_cut_hz:
        raise ValueError("transition_hz must be greater than low_cut_hz")

    strength = float(np.clip(strength, 0.0, 1.0))
    max_attenuation_db = max(0.0, float(max_attenuation_db))
    spectrum, frequencies, window, hop_length, frame_length = _stft(signal, sample_rate, 32.0, 10.0)
    analysis = analyze_wind(signal, sample_rate)

    frequency_weight = np.clip(
        (transition_hz - frequencies) / (transition_hz - low_cut_hz),
        0.0,
        1.0,
    )
    frequency_weight[frequencies < low_cut_hz] = 1.0
    attenuation_db = (
        max_attenuation_db
        * strength
        * analysis.frame_probability[:, None]
        * frequency_weight[None, :]
    )
    gain = np.power(10.0, -attenuation_db / 20.0)
    filtered_spectrum = spectrum * gain
    frames = np.fft.irfft(filtered_spectrum, n=(spectrum.shape[1] - 1) * 2, axis=1)[:, :frame_length]

    output_length = (len(analysis.frame_probability) - 1) * hop_length + frame_length
    output = np.zeros(output_length, dtype=np.float64)
    normaliser = np.zeros(output_length, dtype=np.float64)
    window64 = window.astype(np.float64)
    for index, frame in enumerate(frames):
        start = index * hop_length
        end = start + frame_length
        weighted = frame.astype(np.float64) * window64
        output[start:end] += weighted
        normaliser[start:end] += np.square(window64)

    output /= np.maximum(normaliser, 1e-8)
    return output[: signal.size].astype(np.float32)
