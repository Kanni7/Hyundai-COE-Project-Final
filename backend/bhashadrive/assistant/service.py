"""Premium voice assistant: transcript -> validated cockpit commands, with the guards around the cloud calls.

The service never executes anything: it returns allowlisted commands (frontend `Intent` JSON) and the cockpit runs
them through its own state handlers. Consequential commands are held until the driver confirms, whatever the LLM
says. Conversation context and the pending confirmation live here, per entitlement subject.
"""
from __future__ import annotations

import json
import threading
import time
from collections import deque
from dataclasses import dataclass, field

from ..config import AssistantConfig
from .providers import OpenAIInterpreter, ProviderError, SarvamASR

PENDING_TTL_S = 30
MAX_STATE_CHARS = 2000


def consequential(cmd: dict) -> bool:
    """Commands that always need a spoken yes first (server policy, not the LLM's call)."""
    t = cmd["type"]
    return (t in {"gear", "phone.call"}
            or (t == "ignition" and cmd.get("mode") == "off")
            or (t == "doors.lock" and cmd.get("locked") is False)
            or (t == "adas.lka" and cmd.get("on") is False)
            or (t == "cruise" and cmd.get("on") is True))


class Busy(Exception):
    """A request for this driver is still running."""


class RateLimited(Exception):
    pass


@dataclass
class Session:
    turns: deque = field(default_factory=deque)
    pending: list[dict] | None = None
    pending_at: float = 0.0
    lock: threading.Lock = field(default_factory=threading.Lock)
    calls: deque = field(default_factory=deque)


class UsageMeter:
    """Per-call usage and estimated cost, in memory and as JSON lines (no audio, no transcripts)."""

    def __init__(self, config: AssistantConfig):
        self.config = config
        self.totals: dict[str, float] = {"asr_calls": 0, "asr_audio_s": 0.0, "llm_calls": 0, "input_tokens": 0,
                                         "output_tokens": 0, "errors": 0, "fallbacks": 0, "cost_inr": 0.0}
        self._lock = threading.Lock()

    def record(self, subject: str, kind: str, **fields) -> None:
        row = {"t": round(time.time(), 3), "subject": subject, "kind": kind, **fields}
        with self._lock:
            if kind == "asr":
                self.totals["asr_calls"] += 1
                self.totals["asr_audio_s"] += fields.get("audio_s", 0)
            elif kind == "llm":
                self.totals["llm_calls"] += 1
                self.totals["input_tokens"] += fields.get("input_tokens", 0)
                self.totals["output_tokens"] += fields.get("output_tokens", 0)
            self.totals["errors"] += bool(fields.get("error"))
            self.totals["fallbacks"] += bool(fields.get("fallback"))
            self.totals["cost_inr"] += fields.get("cost_inr", 0.0)
            try:
                self.config.usage_log.parent.mkdir(parents=True, exist_ok=True)
                with self.config.usage_log.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(row) + "\n")
            except OSError:
                pass  # metering must never break a command

    def summary(self) -> dict:
        with self._lock:
            return {k: round(v, 4) if isinstance(v, float) else v for k, v in self.totals.items()}


class AssistantService:
    def __init__(self, config: AssistantConfig, asr: SarvamASR | None = None, llm: OpenAIInterpreter | None = None):
        self.config = config
        self.asr = asr or SarvamASR(config)
        self.llm = llm or OpenAIInterpreter(config)
        self.usage = UsageMeter(config)
        self._sessions: dict[str, Session] = {}
        self._guard = threading.Lock()

    @property
    def problems(self) -> list[str]:
        return self.config.problems()

    def session(self, subject: str) -> Session:
        with self._guard:
            return self._sessions.setdefault(subject, Session())

    def begin(self, subject: str) -> Session:
        """Rate limit and one-request-at-a-time per driver. Call `end` when done."""
        s = self.session(subject)
        now = time.monotonic()
        with self._guard:
            while s.calls and now - s.calls[0] > 60:
                s.calls.popleft()
            if len(s.calls) >= self.config.rate_per_min:
                raise RateLimited()
            s.calls.append(now)
        if not s.lock.acquire(blocking=False):
            raise Busy()
        return s

    @staticmethod
    def end(s: Session) -> None:
        s.lock.release()

    def transcribe(self, subject: str, audio, sample_rate: int = 16000):
        try:
            t = self.asr.transcribe(audio, sample_rate)
        except ProviderError as e:
            self.usage.record(subject, "asr", error=e.kind)
            raise
        self.usage.record(subject, "asr", audio_s=t.audio_s, latency_s=t.latency_s, cost_inr=t.cost_inr,
                          language=t.language)
        if self.config.log_transcripts:
            print(f"[assistant] transcript ({t.language}): {t.text}")
        return t

    def interpret(self, subject: str, s: Session, transcript: str, state: dict | None) -> dict:
        state_json = json.dumps(state or {}, ensure_ascii=False)
        if len(state_json) > MAX_STATE_CHARS:
            state = {}
        if s.pending is not None and time.monotonic() - s.pending_at >= PENDING_TTL_S:
            s.pending = None  # an old question no longer counts
        context = list(s.turns)[-self.config.context_turns:]
        if s.pending is not None:
            context.append({"assistant_waiting_for_yes_no": True})
        try:
            it = self.llm.interpret(transcript[:500], context, state)
        except ProviderError as e:
            self.usage.record(subject, "llm", error=e.kind)
            raise
        self.usage.record(subject, "llm", input_tokens=it.input_tokens, output_tokens=it.output_tokens,
                          latency_s=it.latency_s, cost_inr=it.cost_inr, status=it.status, dropped=it.dropped)

        status, actions, spoken = it.status, it.actions, it.spoken_response
        held, s.pending = s.pending, None  # a question is answered (or dropped) by the next turn
        if held is not None and it.confirm_pending in ("yes", "no"):
            status, actions = ("execute", held) if it.confirm_pending == "yes" else ("cancelled", [])
            spoken = spoken or ("Okay." if status == "execute" else "Okay, cancelled.")
        elif status in ("execute", "confirm") and not actions:
            # Nothing allowlisted survived validation: say so rather than pretend.
            status, spoken = "unsupported", "Sorry, I can't do that in this car."
        elif status in ("execute", "confirm") and it.confidence < self.config.min_confidence:
            status, actions, spoken = "clarify", [], "Sorry, I didn't get that. Could you say it again?"
        elif status in ("execute", "confirm") and (it.requires_confirmation or status == "confirm" or any(map(consequential, actions))):
            status = "confirm"
            s.pending, s.pending_at = actions, time.monotonic()
            spoken = spoken if spoken.endswith("?") else f"{spoken} Shall I go ahead?".strip()
        elif status != "execute":
            actions = []

        s.turns.append({"driver": transcript[:200], "assistant": spoken, "status": status})
        while len(s.turns) > self.config.context_turns:
            s.turns.popleft()
        return {
            "status": status,
            # Executed now by the cockpit; a held confirmation's commands are only shown.
            "actions": actions if status == "execute" else [],
            "pending_actions": actions if status == "confirm" else [],
            "spoken_response": spoken,
            "requires_confirmation": status == "confirm",
            "confidence": round(it.confidence, 3),
            "dropped_actions": it.dropped,
            "latency_s": it.latency_s,
            "cost_inr": it.cost_inr,
        }

    def info(self) -> dict:
        is_groq = bool((self.config.openai_api_key or "").startswith("gsk_") or self.config.groq_api_key)
        model = "qwen/qwen3.8-27b (Groq)" if is_groq else self.config.openai_model
        return {"asr_model": self.config.sarvam_model, "asr_mode": self.config.sarvam_mode,
                "llm_model": model, "configured": not self.problems}
