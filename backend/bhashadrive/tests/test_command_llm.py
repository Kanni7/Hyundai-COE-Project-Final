"""Command LLM contract: its command list matches the cockpit's, labels and answers obey it, the API serves it."""
import re
from pathlib import Path

from fastapi.testclient import TestClient

from bhashadrive.api.server import create_app
from bhashadrive.config import AppConfig
from bhashadrive.nlu.cockpit_commands import COMMANDS, canonical, json_schema, prompt, valid
from bhashadrive.training.command_llm_data import build

from .fakes_v2 import make_pipeline

TYPES_TS = Path(__file__).resolve().parents[3] / "frontend" / "src" / "types.ts"


def test_commands_match_the_cockpit_intents():
    union = TYPES_TS.read_text(encoding="utf-8").split("export type Intent =")[1].split("export interface")[0]
    cockpit = set(re.findall(r"type: '([\w.]+)'", union))
    assert set(COMMANDS) == cockpit - {"scene"}  # switching the picture is a UI control, not a car command


def test_valid_and_canonical():
    assert valid({"type": "climate.setTemp", "value": 22})
    assert not valid({"type": "climate.setTemp", "value": 40})  # out of range
    assert not valid({"type": "climate.setTemp"})  # missing field
    assert not valid({"type": "ambient.color", "color": "brown"})  # not a preset colour
    assert not valid({"type": "media.pause", "volume": 3})  # unknown field
    assert not valid({"type": "self.destruct"})
    assert not valid({"type": "lights.head", "on": 1})  # bool, not number
    assert list(canonical({"type": "seat.vent", "level": 2, "target": "driver"})) == ["type", "target", "level"]
    assert json_schema()["maxItems"] == 4
    assert prompt("  AC  22 ").endswith("user\nAC 22<end_of_turn>\n<start_of_turn>model\n")


def test_training_labels_obey_the_schema_and_cover_multi_commands():
    data = build(fills=1, multi=200)
    rows = [r for split in data.values() for r in split]
    assert all(valid(c) for r in rows for c in r["intents"])
    assert any(len(r["intents"]) >= 2 for r in data["test"])  # multi-command sentences are tested
    assert any(not r["intents"] for r in rows)  # and out-of-scope ones teach "no command"
    # V2 NLU rows calling a cockpit ability "unsupported" (windows, calls...) are not taught as refusals.
    assert not any(not r["intents"] and re.search(r"\b(window|khidki|call)\b", r["text"], re.I) for r in rows)


class FakeLLM:
    name = "fake-llm"

    def interpret(self, text):
        return [{"type": "climate.setTemp", "value": 22}, {"type": "mood", "mood": "romantic"}], 0.01


def test_interpret_endpoint():
    c = TestClient(create_app(AppConfig(), make_pipeline(), command_llm=FakeLLM()))
    assert c.get("/api/health").json()["llm_ready"] is True
    j = c.post("/api/interpret", json={"text": "AC 22 kar do aur mahaul romantic bana do"}).json()
    assert [i["type"] for i in j["intents"]] == ["climate.setTemp", "mood"]
    off = TestClient(create_app(AppConfig(), make_pipeline()))
    assert off.get("/api/health").json()["llm_ready"] is False
    assert off.post("/api/interpret", json={"text": "x"}).status_code == 503
