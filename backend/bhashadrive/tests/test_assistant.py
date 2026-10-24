"""Premium voice assistant: providers (mocked HTTP), validation, confirmation policy, tier routing, guards."""
import io
import json
import threading
from pathlib import Path

import httpx
import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from bhashadrive.api.server import create_app
from bhashadrive.assistant.entitlements import Entitlements
from bhashadrive.assistant.providers import OpenAIInterpreter, ProviderError, SarvamASR, response_schema
from bhashadrive.assistant.service import AssistantService
from bhashadrive.audio.asr import MockASR
from bhashadrive.config import AppConfig, AssistantConfig
from bhashadrive.pipeline import BhashaDrivePipeline
from bhashadrive.vehicle.mock_adapter import MockVehicleAdapter

from .conftest import ScriptedParser, V, frame

ROOT = Path(__file__).resolve().parents[3]


def cfg(tmp_path, **kw) -> AssistantConfig:
    c = AssistantConfig()
    c.sarvam_api_key, c.openai_api_key = "test-sarvam-key", "test-openai-key"
    c.usage_log = tmp_path / "usage.jsonl"
    c.retries = 1
    for k, v in kw.items():
        setattr(c, k, v)
    return c


def llm_reply(**out) -> dict:
    full = {"status": "execute", "actions": [], "spoken_response": "Done.", "requires_confirmation": False,
            "confidence": 0.9, "confirm_pending": "none", **out}
    return {"status": "completed", "usage": {"input_tokens": 1200, "output_tokens": 80},
            "output": [{"type": "reasoning", "summary": []},
                       {"type": "message", "content": [{"type": "output_text", "text": json.dumps(full)}]}]}


def null_fields(cmd: dict) -> dict:
    """What the strict schema makes the model send: every optional parameter present, null when unused."""
    from bhashadrive.nlu.cockpit_commands import COMMANDS
    return {**{f: None for f, _, _ in COMMANDS[cmd["type"]]}, **cmd}


class Script:
    """httpx transport answering from a list of responses (or exceptions), recording the requests."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        a = self.answers.pop(0)
        if isinstance(a, Exception):
            raise a
        status, body = a
        return httpx.Response(status, json=body)

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self))


def service(tmp_path, llm: Script | None = None, asr: Script | None = None, **kw) -> AssistantService:
    c = cfg(tmp_path, **kw)
    return AssistantService(c, asr=SarvamASR(c, (asr or Script()).client()), llm=OpenAIInterpreter(c, (llm or Script()).client()))


def ask(svc: AssistantService, text: str, state=None) -> dict:
    s = svc.begin("driver")
    try:
        return svc.interpret("driver", s, text, state)
    finally:
        svc.end(s)


# ---------------------------------------------------------------- Sarvam ASR


def test_sarvam_request_and_parse(tmp_path):
    asr = Script((200, {"request_id": "r1", "transcript": " AC konjam kammi pannu ", "language_code": "ta-IN"}))
    svc = service(tmp_path, asr=asr)
    t = svc.transcribe("driver", np.zeros(32000, np.float32))
    assert t.text == "AC konjam kammi pannu" and t.language == "ta-IN" and t.audio_s == 2.0
    assert t.cost_inr == pytest.approx(2 / 3600 * 30, abs=1e-5)
    req = asr.requests[0]
    assert req.url == "https://api.sarvam.ai/speech-to-text"
    assert req.headers["api-subscription-key"] == "test-sarvam-key"
    body = req.content.decode("latin-1")
    for field, value in (("model", "saaras:v4"), ("mode", "codemix"), ("language_code", "unknown")):
        assert f'name="{field}"\r\n\r\n{value}' in body
    assert 'name="keyterms"' in body and '"AC"' in body


@pytest.mark.parametrize("status,body,kind", [
    (403, {"error": {"code": "invalid_api_key_error"}}, "auth"),
    (429, {"error": {"code": "insufficient_quota_error"}}, "quota"),
    (400, {"error": {"code": "invalid_request_error"}}, "bad_request"),
])
def test_sarvam_errors_are_classified(tmp_path, status, body, kind):
    svc = service(tmp_path, asr=Script((status, body)))
    with pytest.raises(ProviderError) as e:
        svc.transcribe("driver", np.zeros(16000, np.float32))
    assert e.value.kind == kind and "test-sarvam-key" not in str(e.value)


def test_transient_errors_are_retried_once(tmp_path):
    asr = Script(httpx.ReadTimeout("slow"), (200, {"transcript": "AC 22 kar do"}))
    assert service(tmp_path, asr=asr).transcribe("d", np.zeros(16000, np.float32)).text == "AC 22 kar do"
    asr = Script((503, {}), (503, {}))
    with pytest.raises(ProviderError) as e:
        service(tmp_path, asr=asr).transcribe("d", np.zeros(16000, np.float32))
    assert e.value.kind == "unavailable" and len(asr.requests) == 2


def test_overlong_audio_is_refused_before_upload(tmp_path):
    asr = Script()
    with pytest.raises(ProviderError) as e:
        service(tmp_path, asr=asr).transcribe("d", np.zeros(16000 * 25, np.float32))
    assert e.value.kind == "bad_audio" and not asr.requests


# ---------------------------------------------------------------- LLM interpretation


def test_schema_is_strict_and_covers_the_allowlist():
    from bhashadrive.nlu.cockpit_commands import COMMANDS
    s = response_schema()
    variants = s["properties"]["actions"]["items"]["anyOf"]
    assert {v["properties"]["type"]["enum"][0] for v in variants} == set(COMMANDS)
    assert all(v["additionalProperties"] is False and set(v["required"]) == set(v["properties"]) for v in variants)


@pytest.mark.parametrize("transcript,actions", [
    ("Hey, set the AC to 22.", [{"type": "climate.setTemp", "value": 22}]),
    ("AC konjam kammi pannu", [{"type": "climate.adjustTemp", "delta": -1}]),
    ("Volume konjam increase pannu", [{"type": "media.volume", "delta": 2}]),
    ("Thoda gaana chalao aur light neeli kar do", [{"type": "media.play"}, {"type": "ambient.color", "color": "blue"}]),
    ("It's too hot in here.", [{"type": "climate.adjustTemp", "delta": -2, "feeling": "hot"}]),
    ("Go back to the home screen.", [{"type": "screen", "page": "home"}]),
    ("Navigate to the nearest petrol station", [{"type": "nav.start", "destination": "nearest petrol station"}]),
])
def test_valid_commands_pass_through(tmp_path, transcript, actions):
    llm = Script((200, llm_reply(actions=[null_fields(a) for a in actions])))
    out = ask(service(tmp_path, llm=llm), transcript, state={"climate": {"temp": 24}})
    assert out["status"] == "execute" and out["actions"] == actions
    sent = json.loads(llm.requests[0].content)
    assert sent["model"] == "gpt-6.1-sol" and sent["text"]["format"]["strict"] is True and sent["store"] is False
    assert json.loads(sent["input"][0]["content"])["transcript"] == transcript
    assert llm.requests[0].headers["authorization"] == "Bearer test-openai-key"


def test_unsupported_and_out_of_range_commands_are_dropped(tmp_path):
    bad = [{"type": "launch.rocket"}, null_fields({"type": "climate.setTemp", "value": 45}),
           {"type": "screen", "page": "../../etc"}]
    out = ask(service(tmp_path, llm=Script((200, llm_reply(actions=bad, spoken_response="Done!")))), "do it")
    assert out["status"] == "unsupported" and out["actions"] == [] and out["dropped_actions"] == 3
    assert "can't" in out["spoken_response"]  # never claims success


def test_invalid_json_and_refusal_are_errors(tmp_path):
    broken = {"status": "completed", "usage": {}, "output": [{"type": "message", "content": [{"type": "output_text", "text": "{nope"}]}]}
    with pytest.raises(ProviderError) as e:
        ask(service(tmp_path, llm=Script((200, broken))), "AC on")
    assert e.value.kind == "invalid_response"
    incomplete = {"status": "incomplete", "output": []}
    with pytest.raises(ProviderError):
        ask(service(tmp_path, llm=Script((200, incomplete))), "AC on")


def test_low_confidence_asks_to_repeat(tmp_path):
    reply = llm_reply(actions=[null_fields({"type": "climate.power", "on": True})], confidence=0.2)
    out = ask(service(tmp_path, llm=Script((200, reply))), "ac mm hm")
    assert out["status"] == "clarify" and out["actions"] == [] and out["spoken_response"].endswith("?")


def test_ambiguous_request_is_clarified(tmp_path):
    reply = llm_reply(status="clarify", spoken_response="Temperature up or down?")
    out = ask(service(tmp_path, llm=Script((200, reply))), "AC ka kuch karo")
    assert out == {**out, "status": "clarify", "actions": [], "spoken_response": "Temperature up or down?"}


def test_consequential_commands_wait_for_yes(tmp_path):
    call = null_fields({"type": "phone.call", "contact": "Rohan"})
    llm = Script((200, llm_reply(actions=[call], spoken_response="Calling Rohan.")),  # LLM forgot to ask
                 (200, llm_reply(confirm_pending="yes", spoken_response="Calling now.")))
    svc = service(tmp_path, llm=llm)
    first = ask(svc, "Rohan ko call karo")
    assert first["status"] == "confirm" and first["actions"] == [] and first["requires_confirmation"]
    assert first["pending_actions"] == [{"type": "phone.call", "contact": "Rohan"}] and first["spoken_response"].endswith("?")
    second = ask(svc, "haan")
    assert second["status"] == "execute" and second["actions"] == [{"type": "phone.call", "contact": "Rohan"}]
    # The pending question is part of the context the model saw.
    assert {"assistant_waiting_for_yes_no": True} in json.loads(json.loads(llm.requests[1].content)["input"][0]["content"])["recent_turns"]


def test_no_cancels_and_yes_without_question_does_nothing(tmp_path):
    gear = null_fields({"type": "gear", "gear": "R"})
    llm = Script((200, llm_reply(status="confirm", actions=[gear], requires_confirmation=True, spoken_response="Reverse?")),
                 (200, llm_reply(confirm_pending="no", spoken_response="")),
                 (200, llm_reply(confirm_pending="yes", spoken_response="")))
    svc = service(tmp_path, llm=llm)
    assert ask(svc, "reverse mein daalo")["status"] == "confirm"
    assert ask(svc, "vendaam")["status"] == "cancelled"
    late = ask(svc, "yes")  # nothing pending any more
    assert late["actions"] == [] and late["status"] == "unsupported"


def test_usage_is_metered_without_content(tmp_path):
    svc = service(tmp_path, llm=Script((200, llm_reply(actions=[null_fields({"type": "media.pause"})]))))
    ask(svc, "gaana band karo")
    u = svc.usage.summary()
    assert u["llm_calls"] == 1 and u["input_tokens"] == 1200 and u["cost_inr"] > 0
    log = (tmp_path / "usage.jsonl").read_text()
    assert "gaana" not in log and "test-openai-key" not in log


# ---------------------------------------------------------------- guards


def test_overlapping_requests_are_refused_and_rate_limited(tmp_path):
    from bhashadrive.assistant.service import Busy, RateLimited
    svc = service(tmp_path, rate_per_min=3)
    s = svc.begin("d")
    with pytest.raises(Busy):
        svc.begin("d")
    svc.end(s)
    svc.end(svc.begin("d"))
    with pytest.raises(RateLimited):
        svc.begin("d")


# ---------------------------------------------------------------- entitlements and API


def entitlements_file(tmp_path) -> Path:
    f = tmp_path / "entitlements.json"
    f.write_text(json.dumps({"tok-premium": {"tier": "premium", "subject": "u1", "expires": "2999-01-01T00:00:00Z"},
                             "tok-expired": {"tier": "premium", "subject": "u2", "expires": "2020-01-01T00:00:00Z"}}))
    return f


def app(tmp_path, llm=None, asr=None, **kw):
    parser = ScriptedParser({"Pause the music.": frame("media_pause")}, {"Pause the music.": V("media_playback")})
    pipe = BhashaDrivePipeline(parser, MockVehicleAdapter(), MockASR("Pause the music."), AppConfig())
    kw.setdefault("entitlements_file", entitlements_file(tmp_path))
    kw.setdefault("dev_tier_switch", False)
    svc = service(tmp_path, llm=llm, asr=asr, **kw)
    cfg = AppConfig()
    cfg.assistant.dev_tier_switch = kw["dev_tier_switch"]
    return TestClient(create_app(cfg, pipe, assistant=svc, entitlements=Entitlements(svc.config))), svc


def wav(seconds=1.0) -> bytes:
    b = io.BytesIO()
    sf.write(b, np.zeros(int(16000 * seconds), np.float32), 16000, format="WAV")
    return b.getvalue()


def test_tier_comes_from_the_server_not_the_client(tmp_path):
    c, _ = app(tmp_path)
    # A client claiming premium in headers or body stays free.
    r = c.post("/assistant/interpret", json={"text": "AC on", "tier": "premium"}, headers={"X-Tier": "premium"})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "premium_required"
    assert c.get("/assistant/entitlement").json()["tier"] == "free"
    assert c.post("/assistant/dev-tier", json={"tier": "premium"}).status_code == 403  # switch disabled
    # A valid subscription token is premium; an expired one is not; an unknown one is free.
    assert c.get("/assistant/entitlement", headers={"Authorization": "Bearer tok-premium"}).json()["tier"] == "premium"
    r = c.post("/assistant/interpret", json={"text": "AC on"}, headers={"Authorization": "Bearer tok-expired"})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "subscription_expired"
    assert c.get("/assistant/entitlement", headers={"Authorization": "Bearer guess"}).json()["tier"] == "free"


def test_dev_tier_switch_and_premium_interpret(tmp_path):
    llm = Script((200, llm_reply(actions=[null_fields({"type": "climate.setTemp", "value": 22})])))
    c, _ = app(tmp_path, llm=llm, dev_tier_switch=True)
    assert c.get("/assistant/entitlement").json()["tier"] == "free"
    assert c.post("/assistant/dev-tier", json={"tier": "premium"}).json()["premium_available"] is True
    r = c.post("/assistant/interpret", json={"text": "Hey, set the AC to 22."}).json()
    assert r["actions"] == [{"type": "climate.setTemp", "value": 22}]


def test_premium_needs_keys(tmp_path):
    c, svc = app(tmp_path, dev_tier_switch=True, dev_default_tier="premium")
    svc.config.openai_api_key = None
    e = c.get("/assistant/entitlement").json()
    assert e["premium_available"] is False and e["problems"] == ["OPENAI_API_KEY not set"]
    assert c.post("/assistant/interpret", json={"text": "AC on"}).json()["detail"]["code"] == "premium_unconfigured"


def test_llm_outage_tells_the_cockpit_to_fall_back(tmp_path):
    c, _ = app(tmp_path, llm=Script(httpx.ConnectError("offline"), httpx.ConnectError("offline")),
               dev_tier_switch=True, dev_default_tier="premium")
    r = c.post("/assistant/interpret", json={"text": "AC on"})
    assert r.status_code == 503 and r.json()["detail"] == {"code": "llm_network", "message": "Cloud assistant unavailable.", "fallback": "local"}


def test_premium_transcribe_and_local_fallback(tmp_path):
    asr = Script((200, {"transcript": "AC 22 pe kar do", "language_code": "hi-IN"}), httpx.ConnectError("x"), httpx.ConnectError("x"))
    c, svc = app(tmp_path, asr=asr, dev_tier_switch=True, dev_default_tier="premium")
    r = c.post("/assistant/transcribe", files={"file": ("a.wav", wav(), "audio/wav")}).json()
    assert r["text"] == "AC 22 pe kar do" and r["engine"] == "saaras:v4" and r["fallback"] is None
    r = c.post("/assistant/transcribe", files={"file": ("a.wav", wav(), "audio/wav")}).json()
    assert r["fallback"] == "network" and r["text"] == "Pause the music."  # the on-device recogniser answered
    assert svc.usage.summary()["fallbacks"] == 1


def test_transcribe_rejects_bad_audio(tmp_path):
    c, _ = app(tmp_path, dev_tier_switch=True, dev_default_tier="premium")
    assert c.post("/assistant/transcribe", files={"file": ("a.wav", b"not audio", "audio/wav")}).json()["detail"]["code"] == "bad_audio"
    assert c.post("/assistant/transcribe", files={"file": ("a.wav", wav(25), "audio/wav")}).json()["detail"]["code"] == "audio_too_long"


def test_busy_request_gets_409(tmp_path):
    c, svc = app(tmp_path, dev_tier_switch=True, dev_default_tier="premium")
    held = svc.begin("dev-local")  # a command still running
    try:
        assert c.post("/assistant/interpret", json={"text": "AC on"}).status_code == 409
    finally:
        svc.end(held)


def test_free_tier_cockpit_keeps_working(tmp_path):
    c, _ = app(tmp_path)
    assert c.post("/text", json={"text": "Pause the music."}).status_code == 200
    assert c.post("/transcribe", files={"file": ("a.wav", wav(), "audio/wav")}).json()["text"] == "Pause the music."


# ---------------------------------------------------------------- key exposure


def test_keys_never_reach_clients_or_the_frontend(tmp_path):
    c, _ = app(tmp_path, dev_tier_switch=True, dev_default_tier="premium")
    for path in ("/assistant/entitlement", "/assistant/usage", "/health"):
        assert "test-sarvam-key" not in c.get(path).text and "test-openai-key" not in c.get(path).text
    src = ROOT / "frontend" / "src"
    for f in list(src.rglob("*.ts")) + list(src.rglob("*.tsx")):
        text = f.read_text(encoding="utf-8")
        assert "SARVAM_API_KEY" not in text and "OPENAI_API_KEY" not in text and "api.openai.com" not in text, f
        assert "api.sarvam.ai" not in text, f
    example = (ROOT / "backend" / ".env.example").read_text(encoding="utf-8")
    for line in example.splitlines():
        if line.startswith(("SARVAM_API_KEY", "OPENAI_API_KEY")):
            assert line.split("=", 1)[1].split("#")[0].strip() in ("", "your-key-here"), line
