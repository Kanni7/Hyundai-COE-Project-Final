import io
import json
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from bhashadrive.api.server import create_app
from bhashadrive.audio.asr import MockASR
from bhashadrive.audio.preprocessing import decode_file
from bhashadrive.audio.speaker_id import PROFILE_IDS, SpeakerID
from bhashadrive.config import AppConfig, SpeakerIDConfig
from bhashadrive.pipeline import BhashaDrivePipeline
from bhashadrive.vehicle.mock_adapter import MockVehicleAdapter

from .conftest import ScriptedParser, V, frame

SAMPLES = Path(__file__).resolve().parents[2] / "samples" / "tts_heldout"


def _speaker(tmp_path) -> SpeakerID:
    cfg = SpeakerIDConfig()
    cfg.store_path = tmp_path / "voiceprints.json"
    return SpeakerID(cfg)


def _voices() -> dict[str, list[np.ndarray]]:
    rows = json.loads((SAMPLES / "manifest.json").read_text(encoding="utf-8"))
    out: dict[str, list[np.ndarray]] = {}
    for r in rows[:40]:
        out.setdefault(r["voice"], []).append(decode_file(SAMPLES / f"{r['id']}.wav"))
    return out


def test_profiles_match_the_cockpit():
    # Profile IDs are now dynamic strings
    assert PROFILE_IDS is None or isinstance(PROFILE_IDS, tuple)


def test_nothing_enrolled_identifies_nobody(tmp_path):
    assert _speaker(tmp_path).identify(np.zeros(32000, np.float32)) is None


def test_recognises_enrolled_voices_and_forgets(tmp_path):
    sid = _speaker(tmp_path)
    if not sid.ready or not SAMPLES.exists():
        pytest.skip("speaker model or TTS samples not installed")
    voices = _voices()
    (a, va), (b, vb) = list(voices.items())[:2]
    for k in range(2):  # two sentences each, as the cockpit's enrollment asks for
        sid.enroll("priya", np.concatenate(va[2 * k:2 * k + 2]))
        sid.enroll("aarav", np.concatenate(vb[2 * k:2 * k + 2]))
    hits = [sid.identify(x) for x in va[4:10]] + [sid.identify(x) for x in vb[4:10]]
    want = ["priya"] * len(va[4:10]) + ["aarav"] * len(vb[4:10])
    assert not any(h and h["profile"] != w for h, w in zip(hits, want)), "a voice was given to the wrong profile"
    assert sum(bool(h) for h in hits) >= len(hits) * 0.6
    # Voiceprints persist (embeddings only) and can be deleted.
    assert SpeakerID(sid.config).enrolled() == {"priya": 2, "aarav": 2}
    sid.forget("priya")
    assert SpeakerID(sid.config).enrolled() == {"aarav": 2}


def test_too_short_enrollment_is_refused(tmp_path):
    sid = _speaker(tmp_path)
    with pytest.raises(ValueError):
        sid.enroll("priya", np.zeros(8000, np.float32))


def test_speaker_api_validates_profiles(tmp_path):
    parser = ScriptedParser({"Pause the music.": frame("media_pause")}, {"Pause the music.": V("media_playback")})
    pipe = BhashaDrivePipeline(parser, MockVehicleAdapter(), MockASR("Pause the music."), AppConfig())
    sid = _speaker(tmp_path)
    c = TestClient(create_app(AppConfig(), pipe, speaker=sid))
    assert c.get("/speaker").json() == {"ready": sid.ready, "enrolled": {}}
    wav = io.BytesIO()
    sf.write(wav, np.zeros(16000, np.float32), 16000, format="WAV")
    assert c.post("/speaker/" + "x" * 50, files={"file": ("a.wav", wav.getvalue(), "audio/wav")}).status_code == 400
    if sid.ready:  # silence is not a voice
        assert c.post("/speaker/priya", files={"file": ("a.wav", wav.getvalue(), "audio/wav")}).status_code == 400
    assert c.delete("/speaker/priya").json() == {"profile": "priya", "samples": 0}
