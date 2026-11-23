import time

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from bhashadrive.local_ai.assistant import LocalAssistant, local_ai_router
from bhashadrive.local_ai.packs import CATALOG, PackManager, packs_router

BLOB = b"m" * 5000


def _wait(m: PackManager, pid: str) -> dict:
    for _ in range(200):
        if not m.progress[pid].get("downloading"):
            return m.progress[pid]
        time.sleep(0.01)
    raise AssertionError("download did not finish")


def test_catalog_has_every_scheduled_language_and_the_1b_assistant_only():
    langs = [p for p in CATALOG.values() if p.kind == "language"]
    assert len(langs) == 22 and {"ta", "bn", "sat", "ks"} <= {p.id for p in langs}
    assert [p.id for p in CATALOG.values() if p.kind == "assistant"] == ["assistant-1b"]


def test_download_resumes_after_a_drop_and_delete_keeps_shared_vocab(tmp_path):
    calls = []

    def handler(req):
        calls.append(req.headers.get("range"))
        start = int(req.headers["range"][6:-1]) if req.headers.get("range") else 0
        if len(calls) == 1:  # first attempt: the connection drops halfway
            return httpx.Response(200, headers={"content-length": str(len(BLOB))}, stream=_Dropping(BLOB[:2000]))
        body = BLOB[start:]
        return httpx.Response(206 if start else 200, content=body, headers={"content-length": str(len(body))})

    m = PackManager(tmp_path, httpx.Client(transport=httpx.MockTransport(handler)))
    m.start("ta")
    assert _wait(m, "ta")["error"] and not m.installed("ta")
    m.start("ta")  # retry resumes from the .part file
    assert _wait(m, "ta")["error"] is None and m.installed("ta")
    assert calls[1] == "bytes=2000-" and (tmp_path / "asr/ta/model.int8.onnx").read_bytes() == BLOB
    m.delete("ta")
    assert not m.installed("ta") and (tmp_path / "asr/tokens.txt").exists()


def test_api_and_assistant_without_a_model(tmp_path):
    m = PackManager(tmp_path, httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(404))))
    app = FastAPI()
    app.include_router(packs_router(m))
    app.include_router(local_ai_router(LocalAssistant(m)))
    c = TestClient(app)
    assert c.post("/packs/active-language", json={"language": "ta"}).json()["active_language"] == "ta"
    assert c.post("/packs/active-language", json={"language": "xx"}).status_code == 422
    assert c.post("/packs/nope/download").status_code == 404
    assert c.get("/local-ai/status").json() == {"ready": False, "model": None}
    assert c.post("/local-ai/ask", json={"text": "who are you"}).status_code == 503
    (tmp_path / "llm").mkdir()
    (tmp_path / "llm/gemma-3-1b-it-Q4_K_M.gguf").write_bytes(b"x")
    assert c.get("/local-ai/status").json() == {"ready": True, "model": "gemma-3-1b-it-Q4_K_M"}


class _Dropping(httpx.SyncByteStream):
    def __init__(self, first: bytes):
        self.first = first

    def __iter__(self):
        yield self.first
        raise httpx.ReadError("connection dropped")
