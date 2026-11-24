"""Downloadable on-device models ("packs"), picked by the driver in Settings and stored under models/.

- One language pack per scheduled language: AI4Bharat IndicConformer speech recognition (sherpa-onnx INT8,
  ~188 MB each, plus a shared 66 KB vocabulary). It lets the car understand that language with no network.
- The assistant pack: Gemma 3 1B instruct (llama.cpp GGUF, Q4_K_M, ~0.8 GB) for general questions. It fits
  mid-range cockpit chips (~8 GB RAM); a 4B model (2.4 GB) would not run usably on most cars. 1B writes English.

A download streams to `<file>.part` and is renamed only when complete, so a half-downloaded file is never
loaded; a repeated download resumes where it stopped. Files come from fixed Hugging Face repos only.
"""
from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..assistant.providers import IPv4First
from ..bharat.languages import LANGUAGES

ASR_REPO = "parismitaglobalsolutions/indicconformer-sherpa-onnx"
HF = "https://huggingface.co/{repo}/resolve/main/{file}"
SMALL_LANGS = {"hi", "en"}  # understood offline by the built-in Hinglish model; no pack needed


@dataclass(frozen=True)
class Pack:
    id: str
    kind: str  # "language" | "assistant"
    name: str
    repo: str
    files: tuple[tuple[str, str], ...]  # (file in the repo, path under models/)
    mb: int


def _catalog() -> dict[str, Pack]:
    packs = [
        Pack("assistant-1b", "assistant", "Assistant (Gemma 3 1B, answers in English)", "unsloth/gemma-3-1b-it-GGUF",
             (("gemma-3-1b-it-Q4_K_M.gguf", "llm/gemma-3-1b-it-Q4_K_M.gguf"),), 769),
    ]
    for code, lang in LANGUAGES.items():
        if code == "en":
            continue
        packs.append(Pack(code, "language", f"{lang.name} ({lang.native})", ASR_REPO,
                          ((f"{code}/model.int8.onnx", f"asr/{code}/model.int8.onnx"), ("tokens.txt", "asr/tokens.txt")), 188))
    return {p.id: p for p in packs}


CATALOG = _catalog()


class PackManager:
    def __init__(self, models_dir: Path, client: httpx.Client | None = None):
        self.dir = models_dir
        self.client = client or httpx.Client(transport=IPv4First(), follow_redirects=True)
        self.progress: dict[str, dict] = {}  # pack id -> {done, total, error}
        self.active_language: str | None = None
        self._lock = threading.Lock()

    def path(self, pack_id: str) -> Path:
        """The pack's main file (model) on disk."""
        return self.dir / CATALOG[pack_id].files[0][1]

    def installed(self, pack_id: str) -> bool:
        return all((self.dir / dst).is_file() for _, dst in CATALOG[pack_id].files)

    def assistant_path(self) -> Path | None:
        """The assistant model, once its pack is installed."""
        return self.path("assistant-1b") if self.installed("assistant-1b") else None

    def status(self) -> dict:
        return {"active_language": self.active_language,
                "packs": [{"id": p.id, "kind": p.kind, "name": p.name, "mb": p.mb, "installed": self.installed(p.id),
                           "builtin": p.id in SMALL_LANGS, **self.progress.get(p.id, {})} for p in CATALOG.values()]}

    def start(self, pack_id: str) -> None:
        if pack_id not in CATALOG:
            raise HTTPException(404, {"code": "unknown_pack", "message": f"No pack '{pack_id}'."})
        with self._lock:
            if self.progress.get(pack_id, {}).get("downloading"):
                return
            self.progress[pack_id] = {"downloading": True, "done": 0, "total": CATALOG[pack_id].mb * 2**20, "error": None}
        threading.Thread(target=self._download, args=(pack_id,), daemon=True, name=f"pack-{pack_id}").start()

    def _download(self, pack_id: str) -> None:
        pack, prog = CATALOG[pack_id], self.progress[pack_id]
        token = os.environ.get("HF_TOKEN")  # optional; every catalogued repo is public
        try:
            for i, (src, dst) in enumerate(pack.files):  # progress follows file 0, the model; the rest are tiny
                out = self.dir / dst
                if out.is_file():
                    continue
                out.parent.mkdir(parents=True, exist_ok=True)
                part = out.with_name(out.name + ".part")
                have = part.stat().st_size if part.exists() else 0
                headers = {"Range": f"bytes={have}-"} if have else {}
                if token:
                    headers["Authorization"] = f"Bearer {token}"
                with self.client.stream("GET", HF.format(repo=pack.repo, file=src), headers=headers, timeout=60) as r:
                    if r.status_code not in (200, 206):
                        raise RuntimeError(f"download failed: HTTP {r.status_code}")
                    if r.status_code == 200:
                        have = 0  # server ignored the range: start over
                    if i == 0:
                        prog["total"], prog["done"] = have + int(r.headers.get("content-length", 0)), have
                    with part.open("ab" if have else "wb") as f:
                        for chunk in r.iter_bytes():  # as received: a drop loses nothing already sent
                            f.write(chunk)
                            if i == 0:
                                prog["done"] += len(chunk)
                part.replace(out)
            prog.update(downloading=False, error=None)
        except Exception as e:  # network drop, disk full: keep the .part for a resumed retry
            prog.update(downloading=False, error=str(e)[:200])

    def delete(self, pack_id: str) -> None:
        if pack_id not in CATALOG:
            raise HTTPException(404, {"code": "unknown_pack", "message": f"No pack '{pack_id}'."})
        if self.progress.get(pack_id, {}).get("downloading"):
            raise HTTPException(409, {"code": "busy", "message": "Wait for the download to finish."})
        for _, dst in CATALOG[pack_id].files:
            if dst == "asr/tokens.txt":
                continue  # shared by every language pack
            for f in (self.dir / dst, self.dir / (dst + ".part")):
                f.unlink(missing_ok=True)
        self.progress.pop(pack_id, None)
        if self.active_language == pack_id:
            self.active_language = None


class ActiveIn(BaseModel):
    language: str | None


def packs_router(m: PackManager) -> APIRouter:
    r = APIRouter(prefix="/packs")

    @r.get("")
    def status():
        return m.status()

    @r.post("/{pack_id}/download")
    def download(pack_id: str):
        m.start(pack_id)
        return m.status()

    @r.delete("/{pack_id}")
    def delete(pack_id: str):
        m.delete(pack_id)
        return m.status()

    @r.post("/active-language")
    def active(body: ActiveIn):
        """The driver's language: offline, the car listens with this language's pack."""
        if body.language is not None and body.language not in LANGUAGES:
            raise HTTPException(422, {"code": "unknown_language", "message": f"No language '{body.language}'."})
        m.active_language = body.language
        return m.status()

    return r
