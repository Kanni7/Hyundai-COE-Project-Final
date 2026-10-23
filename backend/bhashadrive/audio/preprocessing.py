"""Audio loading and light preprocessing (mono, 16 kHz, float32, peak-normalised)."""
from __future__ import annotations

import numpy as np

from .wind_suppression import WindSuppressionSettings, default_wind_settings, reduce_wind_noise

TARGET_SR = 16000


class AudioError(RuntimeError):
    pass


def _resample(audio: np.ndarray, sr: int, target: int) -> np.ndarray:
    if sr == target or audio.size == 0:
        return audio
    # Light anti-alias smoothing then linear interpolation; adequate for speech recognition.
    if sr > target:
        k = max(1, int(round(sr / target)))
        if k > 1:
            audio = np.convolve(audio, np.ones(k, dtype=np.float32) / k, mode="same")
    n_out = int(round(audio.shape[0] * target / sr))
    x_old = np.linspace(0.0, 1.0, audio.shape[0], endpoint=False)
    x_new = np.linspace(0.0, 1.0, n_out, endpoint=False)
    return np.interp(x_new, x_old, audio).astype(np.float32)


def decode_file(path, sample_rate: int = TARGET_SR) -> np.ndarray:
    """Decode an audio file to mono float32 at `sample_rate`.

    Uses libsndfile (wav/flac/ogg) first, then PyAV for compressed formats (mp3/m4a/webm).
    Our own PyAV call avoids a keyword that newer PyAV releases removed.
    """
    try:
        import soundfile as sf

        data, sr = sf.read(str(path), dtype="float32", always_2d=True)
        return _resample(data.mean(axis=1), sr, sample_rate)
    except Exception:
        pass
    try:
        import av
    except ImportError as exc:
        raise AudioError("PyAV is required for compressed audio formats") from exc
    try:
        with av.open(str(path), mode="r") as container:
            resampler = av.AudioResampler(format="flt", layout="mono", rate=sample_rate)
            chunks = []
            for frame in container.decode(audio=0):
                for out in resampler.resample(frame) or []:
                    chunks.append(out.to_ndarray().reshape(-1))
            for out in resampler.resample(None) or []:
                chunks.append(out.to_ndarray().reshape(-1))
    except Exception as exc:
        raise AudioError(f"Could not decode audio file {path}: {exc}") from exc
    return np.concatenate(chunks).astype(np.float32) if chunks else np.zeros(0, np.float32)


def highpass(audio: np.ndarray, cutoff_hz: float = 80.0, width_hz: float = 40.0, sr: int = TARGET_SR) -> np.ndarray:
    """Remove engine/road rumble below the speech band (linear ramp from cutoff-width/2 to cutoff+width/2)."""
    if audio.size < 2:
        return audio
    f = np.fft.rfftfreq(audio.size, 1 / sr)
    gain = np.clip((f - (cutoff_hz - width_hz / 2)) / width_hz, 0.0, 1.0)
    return np.fft.irfft(np.fft.rfft(audio) * gain, n=audio.size).astype(np.float32)


def preprocess(
    audio: np.ndarray,
    *,
    wind_strength: float | None = None,
    max_attenuation_db: float | None = None,
    wind_settings: WindSuppressionSettings | None = None,
) -> np.ndarray:
    """Prepare speech for ASR and apply conservative wind suppression.

    ``wind_settings`` is used by the running app. The individual keyword
    arguments remain available for scripts and tests; when omitted, the initial
    settings come from the environment.
    """
    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if audio.size:
        audio = audio - float(np.mean(audio))  # DC offset
        settings = (wind_settings or default_wind_settings()).normalized()
        if wind_strength is not None:
            settings.enabled = wind_strength > 0.0
            settings.strength = wind_strength
        if max_attenuation_db is not None:
            settings.max_attenuation_db = max_attenuation_db
        if settings.enabled:
            audio = reduce_wind_noise(audio, TARGET_SR, strength=settings.strength,
                                      max_attenuation_db=settings.max_attenuation_db)
        audio = highpass(audio)  # residual low-frequency rumble
        peak = float(np.max(np.abs(audio)))
        if peak > 1e-6:
            audio = audio / peak * 0.95
    return audio


def rms(audio: np.ndarray) -> float:
    audio = np.asarray(audio, dtype=np.float32)
    return float(np.sqrt(np.mean(np.square(audio)))) if audio.size else 0.0


def is_silent(raw_audio: np.ndarray, min_rms: float, frame: int = TARGET_SR // 10) -> bool:
    """Silence check on the raw (pre-normalisation) signal: no 100 ms frame reaches `min_rms`.

    A whole-clip RMS would call a short command inside a longer push-to-talk recording silent.
    """
    audio = np.asarray(raw_audio, dtype=np.float32).reshape(-1)
    if audio.size == 0:
        return True
    n = max(1, audio.size // frame)
    frames = audio[: n * frame].reshape(n, -1) if audio.size >= frame else audio.reshape(1, -1)
    return float(np.sqrt(np.mean(np.square(frames), axis=1)).max()) < min_rms
