"""The on-device general assistant: Gemma 3 1B instruct (the assistant pack, llama.cpp, CPU) for questions the car
commands do not cover, and for turning offline transcripts in the driver's language into English. No cloud LLM.
1B answers in English: replies in Hindi, Tamil and Bengali come from the cockpit's own templates.

Car facts (route, fuel, cabin) are never invented here: those questions are answered by the cockpit from
live data; this model sees only a small snapshot of the car's state and is told to say when it does not know.
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..bharat.languages import LANGUAGES
from .packs import PackManager

SYSTEM = ("You are the voice assistant of a Hyundai Verna car, running on the car's own computer with no internet. "
          "The driver is driving: answer in at most three short sentences, plain text, no lists or markdown. "
          "Answer in English. Car state right now: {state}. For live facts you do not have (news, weather, "
          "prices, traffic), say you cannot check that offline. Never claim to have changed a car setting.")


class LocalAssistant:
    def __init__(self, packs: PackManager, threads: int = 4):
        self.packs, self.threads = packs, threads
        self._llm, self._path = None, None
        self._lock = threading.Lock()

    @property
    def model_path(self) -> Path | None:
        return self.packs.assistant_path()

    def _model(self):
        path = self.model_path
        if path is None:
            raise HTTPException(503, {"code": "no_assistant", "message": "Download an assistant pack in Settings first."})
        if self._path != path:  # first use after the pack was installed
            from llama_cpp import Llama

            self._llm = Llama(model_path=str(path), n_ctx=2048, n_threads=self.threads, verbose=False)
            self._path = path
        return self._llm

    def _chat(self, system: str, user: str, max_tokens: int) -> tuple[str, float]:
        with self._lock:  # one llama.cpp context: one request at a time
            llm = self._model()
            t0 = time.perf_counter()
            # Gemma's chat template has no system role: the instructions lead the user turn.
            out = llm.create_chat_completion(messages=[{"role": "user", "content": f"{system}\n\n{user}"}],
                                             max_tokens=max_tokens, temperature=0.3)
            return out["choices"][0]["message"]["content"].strip(), round(time.perf_counter() - t0, 2)

    def ask(self, text: str, state: dict) -> dict:
        answer, s = self._chat(SYSTEM.format(state=json.dumps(state)[:600]), text, 200)
        return {"answer": answer, "language": "en", "latency_s": s, "model": self._path.stem}

    def to_english(self, text: str, lang: str) -> dict:
        """A transcript in the driver's language (offline speech) in English, for the command model."""
        name = LANGUAGES[lang].name if lang in LANGUAGES else "an Indian language"
        out, s = self._chat(f"Translate this {name} sentence into English. Keep numbers, names and units. "
                            "Reply with the translation only.", text, 200)
        return {"text": out, "language": "en", "latency_s": s}


class AskIn(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    state: dict = Field(default_factory=dict)


def local_ai_router(a: LocalAssistant) -> APIRouter:
    r = APIRouter(prefix="/local-ai")

    @r.get("/status")
    def status():
        p = a.model_path
        return {"ready": p is not None, "model": p.stem if p else None}

    @r.post("/ask")
    def ask(body: AskIn):
        return a.ask(body.text.strip(), body.state)

    return r
