"""BharatConnect services and routes, with stand-in Google clients (no network, no credentials)."""
from pathlib import Path
from types import SimpleNamespace as NS

import pytest
from fastapi.testclient import TestClient
from google.api_core import exceptions as gx

from bhashadrive.api.server import create_app
from bhashadrive.bharat.api import BharatServices
from bhashadrive.bharat.errors import ServiceError
from bhashadrive.bharat.languages import LANGUAGES, detected, language
from bhashadrive.bharat.speech import Transcriber
from bhashadrive.bharat.translation import GoogleTranslator
from bhashadrive.bharat.tts import GoogleTTS
from bhashadrive.config import AppConfig, BharatConfig
from bhashadrive.schemas import ASRResult

from .fakes_v2 import make_pipeline

WAV = Path(__file__).resolve().parents[2] / "samples" / "tts" / "s01_freezing_en.wav"


class FakeTranslate:
    def __init__(self, fail=None):
        self.calls, self.fail = [], fail

    def translate_text(self, request, timeout):
        if self.fail:
            raise self.fail
        self.calls.append(request)
        return NS(translations=[NS(translated_text=f"[{request['target_language_code']}] {request['contents'][0]}")])


class FakeTTS:
    def list_voices(self, request, timeout):
        code = request["language_code"]
        return NS(voices=[NS(name=f"{code}-Standard-A", language_codes=[code]), NS(name=f"{code}-Wavenet-B", language_codes=[code])])

    def synthesize_speech(self, request, timeout):
        return NS(audio_content=b"ID3mp3:" + request["voice"]["name"].encode())


class FakeWhisper:
    def __init__(self, cfg):
        self.cfg = cfg

    def transcribe_verbatim(self, audio, lang):
        if lang is None:  # detect: this speaker talks Tamil
            return ASRResult(text="vanakkam", language="ta", status="ok", duration_s=1.7, latency_s=0.1)
        return ASRResult(text="" if lang == "en" else f"spoken in {lang}", status="silence" if lang == "en" else "ok",
                         duration_s=1.7, latency_s=0.1)


def test_language_table():
    assert len(LANGUAGES) == 23 and all(l.sarvam for l in LANGUAGES.values())  # English + 22 scheduled
    assert language("ta").google_tts == "ta-IN" and language("or").sarvam == "od-IN" and language("kok").google == "gom"
    assert {l.code for l in LANGUAGES.values() if l.google is None} == {"brx", "ks", "sat"}
    assert language("or").speech and not language("sat").speech
    with pytest.raises(ValueError):
        language("fr")


def test_detected_language_codes():
    assert detected("od-IN").code == "or" and detected("en-IN").code == "en" and detected("hi").code == "hi"
    assert detected("brx-IN").code == "brx" and detected(None) is None and detected("fr-FR") is None


def test_translation_calls_v3_once_per_phrase_and_maps_errors():
    client = FakeTranslate()
    t = GoogleTranslator("my-project", client=client)
    out = t.translate("  vanakkam   anna ", "ta", "hi")
    assert out["text"] == "[hi] vanakkam anna" and out["cached"] is False
    assert client.calls[0]["parent"] == "projects/my-project/locations/global"
    assert client.calls[0]["source_language_code"] == "ta" and client.calls[0]["mime_type"] == "text/plain"
    assert t.translate("vanakkam anna", "ta", "hi")["cached"] is True and len(client.calls) == 1  # no duplicate call
    assert t.translate("hello", "en", "en")["text"] == "hello" and len(client.calls) == 1  # same language: no call
    with pytest.raises(ServiceError) as e:
        t.translate("   ", "ta", "hi")
    assert e.value.status == 422
    assert GoogleTranslator(None, client=client).problem() == "GOOGLE_CLOUD_PROJECT is not set"
    for exc, status in ((gx.ResourceExhausted("quota"), 429), (gx.DeadlineExceeded("slow"), 504),
                        (gx.PermissionDenied("api off"), 503)):
        with pytest.raises(ServiceError) as e:
            GoogleTranslator("p", client=FakeTranslate(fail=exc)).translate("x", "hi", "ta")
        assert e.value.status == status and e.value.stage == "translating"


def test_tts_picks_best_voice_and_caches():
    tts = GoogleTTS(client=FakeTTS())
    audio, voice, _ = tts.synthesize("नमस्ते", "hi")
    assert voice == "hi-IN-Wavenet-B" and audio.startswith(b"ID3")


def test_tts_refuses_language_without_voice():
    class NoTamil(FakeTTS):
        def list_voices(self, request, timeout):
            return NS(voices=[])
    with pytest.raises(ServiceError) as e:
        GoogleTTS(client=NoTamil()).synthesize("vanakkam", "ta")
    assert e.value.status == 422 and not e.value.retryable


def test_tts_refuses_language_with_no_voice_service():
    with pytest.raises(ServiceError) as e:
        GoogleTTS(client=FakeTTS()).synthesize("johar", "sat")
    assert e.value.status == 422 and not e.value.retryable and "text" in e.value.message


def test_turn_pipeline_routes():
    services = BharatServices(Transcriber(BharatConfig(), factory=FakeWhisper),
                              GoogleTranslator("p", client=FakeTranslate()), GoogleTTS(client=FakeTTS()))
    c = TestClient(create_app(AppConfig(), make_pipeline(), bharat=services))
    langs = c.get("/api/bharat/status").json()["languages"]
    assert len(langs) == 23 and {"code": "sat", "name": "Santali", "native": "ᱥᱟᱱᱛᱟᱲᱤ", "speech": False} in langs
    # No language sent: the spoken one is detected and reported.
    auto = c.post("/api/bharat/transcribe", files={"file": ("a.wav", WAV.read_bytes(), "audio/wav")}).json()
    assert auto["text"] == "vanakkam" and auto["language"] == "ta"
    heard = c.post("/api/bharat/transcribe", files={"file": ("a.wav", WAV.read_bytes(), "audio/wav")}, data={"language": "ta"}).json()
    assert heard["text"] == "spoken in ta" and heard["status"] == "ok"
    said = c.post("/api/bharat/translate", json={"text": heard["text"], "source": "ta", "target": "hi"}).json()
    assert said["text"] == "[hi] spoken in ta" and said["target"] == "hi"
    audio = c.post("/api/bharat/speak", json={"text": said["text"], "language": "hi"})
    assert audio.status_code == 200 and audio.headers["content-type"] == "audio/mpeg" and audio.content.startswith(b"ID3")
    # Silence comes back empty, and an empty transcript is never translated.
    quiet = c.post("/api/bharat/transcribe", files={"file": ("a.wav", WAV.read_bytes(), "audio/wav")}, data={"language": "en"}).json()
    assert quiet["text"] == "" and quiet["status"] == "silence"
    assert c.post("/api/bharat/translate", json={"text": "", "source": "en", "target": "ta"}).status_code == 422
    bad = c.post("/api/bharat/transcribe", files={"file": ("a.wav", b"", "audio/wav")}, data={"language": "ta"})
    assert bad.status_code == 400 and bad.json()["detail"]["stage"] == "transcribing"
    assert c.post("/api/bharat/speak", json={"text": "x", "language": "fr"}).status_code == 422
