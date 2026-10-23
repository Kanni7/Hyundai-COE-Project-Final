"""The cockpit's command format (frontend/src/types.ts `Intent`), shared by the command LLM's training and runtime.

Dependency-free on purpose: the training environment imports it without the backend's packages.
`COMMANDS` lists each command's fields as (name, JSON schema, required). Key order matters: llama.cpp's
JSON-schema grammar emits required fields first, then optional ones, so `canonical` orders every training
target the same way the grammar will at runtime.
"""
from __future__ import annotations

_COLORS = ["blue", "red", "green", "purple", "pink", "orange", "white", "yellow", "cyan", "gold"]
_ZONE = {"enum": ["driver", "passenger", "both"]}
_BOOL = {"type": "boolean"}


def _int(lo: int, hi: int) -> dict:
    return {"type": "integer", "minimum": lo, "maximum": hi}


def _num(lo: float, hi: float) -> dict:
    return {"type": "number", "minimum": lo, "maximum": hi}


COMMANDS: dict[str, list[tuple[str, dict, bool]]] = {
    "climate.setTemp": [("value", _num(16, 30), True)],
    "climate.adjustTemp": [("delta", _int(-3, 3), True), ("feeling", {"enum": ["hot", "cold"]}, False)],
    "climate.power": [("on", _BOOL, True)],
    "climate.fan": [("value", _int(0, 7), False), ("delta", _int(-3, 3), False)],
    "climate.auto": [],
    "climate.recirc": [("on", _BOOL, False)],
    "climate.defrost": [("on", _BOOL, False)],
    "media.play": [("genre", {"enum": ["lofi", "romantic", "party", "devotional", "retro"]}, False),
                   ("radio", _BOOL, False), ("freq", _num(87.5, 108), False)],
    "media.pause": [],
    "media.skip": [("dir", {"enum": [1, -1]}, True)],
    "media.volume": [("value", _int(0, 30), False), ("delta", _int(-8, 8), False), ("mute", _BOOL, False)],
    "ambient.color": [("color", {"enum": _COLORS}, True)],
    "ambient.power": [("on", _BOOL, True)],
    "ambient.brightness": [("delta", _num(-0.4, 0.4), True)],
    "ambient.mode": [("mode", {"enum": ["static", "breathe", "flow", "music", "drive", "rainbow", "dual"]}, True),
                     ("color2", {"enum": _COLORS}, False)],
    "ambient.hue": [("hue", _int(0, 63), True)],
    "mood": [("mood", {"enum": ["party", "relax", "romantic", "focus", "energy", "cozy"]}, True)],
    "wipers": [("mode", {"enum": ["off", "slow", "fast"]}, True), ("rain", _BOOL, False)],
    "window": [("target", _ZONE, True), ("open", _int(0, 100), True)],
    "sunroof": [("open", _BOOL, True), ("fresh", _BOOL, False)],
    "seat.vent": [("target", _ZONE, True), ("level", _int(0, 3), False), ("delta", _int(-3, 3), False)],
    "nav.start": [("destination", {"type": "string", "minLength": 1, "maxLength": 60}, True)],
    "nav.stop": [],
    "profile": [("id", {"type": "string", "minLength": 1}, False)],
    "phone.call": [("contact", {"type": "string", "minLength": 1, "maxLength": 40}, True)],
    "phone.end": [],
    "drive.mode": [("mode", {"enum": ["eco", "normal", "sport"]}, True)],
    "lights.head": [("on", _BOOL, True)],
    "lights.hazard": [("on", _BOOL, True)],
    "ignition": [("mode", {"enum": ["off", "acc", "on"]}, True)],
    "rev": [],
    "gear": [("gear", {"enum": ["P", "R", "N", "D"]}, True)],
    "indicator": [("dir", {"enum": ["off", "left", "right"]}, True)],
    "lights.cabin": [("on", _BOOL, True)],
    "doors.lock": [("locked", _BOOL, True)],
    "autohold": [("on", _BOOL, False)],
    "screen": [("page", {"enum": ["home", "nav", "media", "climate", "lights", "phone", "vehicle"]}, True)],
    "cluster.view": [("view", {"enum": ["drive", "trip", "tyres"]}, False), ("dir", {"enum": [1, -1]}, False)],
    "adas.lka": [("on", _BOOL, True)],
    "cruise": [("on", _BOOL, True), ("speed", _int(30, 180), False), ("delta", _int(-20, 20), False)],
    "query": [("topic", {"enum": ["temp", "fuel", "music", "time", "speed", "tyres"]}, True)],
    "greet": [],
    "help": [],
    "thanks": [],
}
MAX_COMMANDS = 4


def _ordered(name: str) -> list[tuple[str, dict, bool]]:
    fields = COMMANDS[name]
    return [f for f in fields if f[2]] + [f for f in fields if not f[2]]


def json_schema() -> dict:
    """Schema of the model's whole answer: a list of up to MAX_COMMANDS commands (empty = nothing to do)."""
    variants = []
    for name in COMMANDS:
        fields = _ordered(name)
        variants.append({
            "type": "object",
            "properties": {"type": {"const": name}, **{f: s for f, s, _ in fields}},
            "required": ["type"] + [f for f, _, req in fields if req],
            "additionalProperties": False,
        })
    return {"type": "array", "items": {"oneOf": variants}, "maxItems": MAX_COMMANDS}


def canonical(cmd: dict) -> dict:
    """The command with its keys in grammar order (type, required fields, optional fields)."""
    return {"type": cmd["type"], **{f: cmd[f] for f, _, _ in _ordered(cmd["type"]) if f in cmd}}


def valid(cmd: object) -> bool:
    """A known command with every required field, no unknown field, and values inside the schema's limits."""
    if not isinstance(cmd, dict) or cmd.get("type") not in COMMANDS:
        return False
    fields = {f: (s, req) for f, s, req in COMMANDS[cmd["type"]]}
    if set(cmd) - {"type"} - set(fields) or any(req and f not in cmd for f, (_, req) in fields.items()):
        return False
    for f, v in cmd.items():
        if f == "type":
            continue
        s = fields[f][0]
        if "enum" in s and v not in s["enum"]:
            return False
        if s.get("type") == "boolean" and not isinstance(v, bool):
            return False
        if s.get("type") in ("integer", "number"):
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not s["minimum"] <= v <= s["maximum"]:
                return False
            if s["type"] == "integer" and v != int(v):
                return False
        if s.get("type") == "string" and not (isinstance(v, str) and s["minLength"] <= len(v) <= s["maxLength"]):
            return False
    return True


def prompt(text: str) -> str:
    """Gemma chat turn for one sentence. The tokenizer adds <bos>; the answer ends with <end_of_turn>."""
    return f"<start_of_turn>user\n{' '.join(text.split())[:300]}<end_of_turn>\n<start_of_turn>model\n"
