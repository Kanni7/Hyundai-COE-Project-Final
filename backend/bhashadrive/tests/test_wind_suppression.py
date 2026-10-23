import numpy as np

from bhashadrive.audio.preprocessing import preprocess
from bhashadrive.audio.wind_suppression import analyze_wind, reduce_wind_noise


SR = 16000


def _band_energy(audio: np.ndarray, low_hz: float, high_hz: float) -> float:
    spectrum = np.fft.rfft(audio)
    frequencies = np.fft.rfftfreq(audio.size, 1.0 / SR)
    mask = (frequencies >= low_hz) & (frequencies <= high_hz)
    return float(np.mean(np.square(np.abs(spectrum[mask]))))


def _speech_plus_wind() -> tuple[np.ndarray, np.ndarray]:
    time = np.arange(3 * SR, dtype=np.float32) / SR
    speech = 0.12 * np.sin(2 * np.pi * 900 * time) + 0.08 * np.sin(2 * np.pi * 1800 * time)
    rng = np.random.default_rng(42)
    broadband = rng.normal(0.0, 1.0, size=time.size).astype(np.float32)
    spectrum = np.fft.rfft(broadband)
    frequencies = np.fft.rfftfreq(broadband.size, 1.0 / SR)
    spectrum[(frequencies < 40.0) | (frequencies > 350.0)] = 0.0
    broadband = np.fft.irfft(spectrum, n=broadband.size).astype(np.float32)
    broadband /= np.sqrt(np.mean(np.square(broadband))) + 1e-8
    gust = 0.45 + 0.25 * np.sin(2 * np.pi * 0.7 * time)
    wind = 0.45 * gust * broadband
    return speech, (speech + wind).astype(np.float32)


def test_wind_suppression_reduces_low_band_and_keeps_speech_band():
    speech, noisy = _speech_plus_wind()
    filtered = reduce_wind_noise(noisy, SR, strength=1.0)

    low_before = _band_energy(noisy, 80, 350)
    low_after = _band_energy(filtered, 80, 350)
    speech_before = _band_energy(speech, 700, 2200)
    speech_after = _band_energy(filtered, 700, 2200)

    assert low_after < low_before * 0.65
    assert speech_after > speech_before * 0.75


def test_clean_speech_is_not_strongly_attenuated():
    speech, _noisy = _speech_plus_wind()
    filtered = reduce_wind_noise(speech, SR, strength=1.0)

    assert np.linalg.norm(filtered) > np.linalg.norm(speech) * 0.9


def test_wind_analysis_is_empty_and_zero_safe():
    empty = analyze_wind(np.zeros(0, dtype=np.float32), SR)
    assert empty.mean_probability == 0.0
    assert empty.max_probability == 0.0
    assert reduce_wind_noise(np.zeros(0, dtype=np.float32), SR).size == 0


def test_preprocess_can_disable_custom_wind_filter():
    _speech, noisy = _speech_plus_wind()
    filtered = preprocess(noisy, wind_strength=0.0)

    assert filtered.shape == noisy.shape
    assert np.isfinite(filtered).all()
    assert float(np.max(np.abs(filtered))) <= 0.95 + 1e-5
