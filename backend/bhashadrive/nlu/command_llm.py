"""The cockpit command LLM: a fine-tuned Gemma 3 270M (GGUF, 8-bit) run on the CPU with llama.cpp.

It turns any sentence into the cockpit's commands (frontend `Intent` JSON). It is the fallback for sentences
the fast parser and classifier cannot read with confidence (see `route` in frontend/src/App.tsx).
Every answer is checked against the command schema before it leaves: unknown commands, missing fields and
out-of-range values are dropped, and unreadable output means "no command". Decoding is unconstrained:
a JSON-schema grammar gave the same answers but was 8x slower, since llama.cpp checks it against all
262k Gemma tokens at every step (0.4 s vs 3.4 s per command, 4 threads).
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from ..config import CommandLLMConfig
from .cockpit_commands import MAX_COMMANDS, canonical, prompt, valid


class CommandLLMUnavailableError(RuntimeError):
    pass


class CommandLLM:
    def __init__(self, config: CommandLLMConfig | None = None):
        self.config = c = config or CommandLLMConfig()
        path = Path(c.model_path)
        if not path.is_file():
            raise CommandLLMUnavailableError(f"Command LLM not found: {path}. Train it: bhashadrive.training.train_command_llm")
        try:
            from llama_cpp import Llama
        except ImportError as exc:
            raise CommandLLMUnavailableError("llama-cpp-python is not installed (see requirements.txt)") from exc
        self.llm = Llama(model_path=str(path), n_ctx=512, n_threads=c.threads, n_batch=128, verbose=False)
        self.name = path.stem

    def interpret(self, text: str) -> tuple[list[dict], float]:
        """(commands, seconds). An empty list means the sentence asks for nothing the car can do."""
        t0 = time.perf_counter()
        out = self.llm(prompt(text), max_tokens=self.config.max_tokens, temperature=0.0, stop=["<end_of_turn>"])
        try:
            cmds = json.loads(out["choices"][0]["text"])
        except json.JSONDecodeError:  # malformed or cut off at max_tokens
            cmds = []
        cmds = [canonical(c) for c in cmds if valid(c)][:MAX_COMMANDS] if isinstance(cmds, list) else []
        return cmds, time.perf_counter() - t0
