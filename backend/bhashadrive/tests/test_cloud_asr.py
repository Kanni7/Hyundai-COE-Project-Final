import httpx
import numpy as np

from bhashadrive.audio.asr import MockASR
from bhashadrive.audio.cloud_asr import CloudASR
from bhashadrive.config import AppConfig


def _asr(handler, key="k", local=lambda: MockASR("volume badha do")):
    cfg = AppConfig()
    cfg.assistant.sarvam_api_key = key
    return CloudASR(cfg, httpx.Client(transport=httpx.MockTransport(handler)), local_factory=local)


AUDIO = np.zeros(16000, dtype=np.float32)


def test_in_car_speech_is_translated_to_english_and_reports_the_language():
    sent = {}

    def handler(req):
        sent["body"] = req.content
        return httpx.Response(200, json={"transcript": "Reduce the AC a little.", "language_code": "ta-IN"})

    res = _asr(handler).transcribe_array(AUDIO)
    assert b"saaras:v4" in sent["body"] and b"translate" in sent["body"] and b"unknown" in sent["body"]
    assert res.status == "ok" and res.text == "Reduce the AC a little." and res.language == "ta-IN"


def test_tamil_passes_through_unchanged():
    res = _asr(lambda r: httpx.Response(200, json={"transcript": "AC konjam கம்மி பண்ணு", "language_code": "ta-IN"})).transcribe_array(AUDIO)
    assert res.raw_text == res.text == "AC konjam கம்மி பண்ணு" and res.language == "ta-IN"


def test_ipv4_first_falls_back_when_ipv4_cannot_connect():
    from bhashadrive.assistant.providers import IPv4First

    def no_v4(req):
        raise httpx.ConnectError("no IPv4 route")

    ok = httpx.MockTransport(lambda r: httpx.Response(200, text="v6"))
    assert httpx.Client(transport=IPv4First(httpx.MockTransport(no_v4), ok)).get("https://x").text == "v6"
    v4 = httpx.MockTransport(lambda r: httpx.Response(200, text="v4"))
    assert httpx.Client(transport=IPv4First(v4, httpx.MockTransport(no_v4))).get("https://x").text == "v4"


def test_offline_or_no_key_falls_back_to_on_device_model():
    calls = []

    def down(req):
        calls.append(req.method)
        raise httpx.ConnectError("tunnel")

    online = _asr(down)
    assert online._local is None  # an online car does not hold the local model in RAM
    res = online.transcribe_array(AUDIO)
    assert res.status == "ok" and res.text == "volume badha do" and "network" in res.raw_detected_language
    assert calls.count("POST") == 1  # no retry before falling back (GETs are the keep-warm)
    no_key = _asr(down, key=None)
    assert no_key._local is not None and no_key.transcribe_array(AUDIO).text == "volume badha do" and calls.count("POST") == 1


def test_no_cloud_and_no_local_model_reports_error():
    def missing():
        raise FileNotFoundError("models/asr/hi-hinglish-swift")

    res = _asr(None, key=None, local=missing).transcribe_array(AUDIO)
    assert res.status == "error" and "hi-hinglish-swift" in res.error


def test_server_dropped_kept_alive_connection_is_retried_not_failed():
    from bhashadrive.assistant.providers import IPv4First
    seen = []

    def v4(req):
        seen.append(1)
        if len(seen) == 1:
            raise httpx.RemoteProtocolError("Server disconnected without sending a response.")
        return httpx.Response(200, text="ok")

    assert httpx.Client(transport=IPv4First(httpx.MockTransport(v4), httpx.MockTransport(v4))).post("https://x", content=b"a").text == "ok"
    assert len(seen) == 2


def test_offline_uses_the_drivers_language_pack_and_translates_to_english(tmp_path):
    from bhashadrive.local_ai.packs import PackManager

    class Translator:
        model_path = tmp_path / "gemma.gguf"

        def to_english(self, text, lang):
            assert lang == "ta"
            return {"text": "reduce the AC a little"}

    packs = PackManager(tmp_path)
    packs.active_language = "ta"
    for f in ("asr/ta/model.int8.onnx", "asr/tokens.txt"):
        (tmp_path / f).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / f).write_bytes(b"x")

    def down(req):
        raise httpx.ConnectError("tunnel")

    cfg = AppConfig()
    cfg.assistant.sarvam_api_key = "k"
    asr = CloudASR(cfg, httpx.Client(transport=httpx.MockTransport(down)), local_factory=lambda: MockASR("wrong model"),
                   packs=packs, assistant=Translator())
    asr._packs_asr["ta"] = MockASR("ஏசி கொஞ்சம் குறை")  # the IndicConformer model itself is exercised in a live check
    res = asr.transcribe_array(AUDIO)
    assert res.text == "reduce the AC a little" and "network" in res.raw_detected_language
    packs.active_language = "hi"  # built into the Hinglish model: no pack
    assert asr.transcribe_array(AUDIO).text == "wrong model"
