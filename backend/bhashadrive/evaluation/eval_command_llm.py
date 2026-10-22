"""Command LLM benchmark on data/command_llm/test.jsonl (phrasings never seen in training).

  python -m bhashadrive.evaluation.eval_command_llm [--parser parser_out.jsonl] [--limit N]

Runs the exported GGUF exactly as the backend does (llama.cpp, CPU, schema check) and reports exact match
(every command and value right, in order), command-type match, results per source (hand-written unseen
phrasings, V2 NLU set, multi-command, out-of-scope), latency and process memory. With --parser, the cockpit's
rule-based parser output for the same sentences (one JSON list, or {"intents": [...]}, per line) is scored alongside.
Writes reports/command_llm_eval.json.
"""
from __future__ import annotations

import argparse
import json
import statistics
import time
from collections import defaultdict
from pathlib import Path

import psutil

from ..nlu.cockpit_commands import canonical, valid

ROOT = Path(__file__).resolve().parents[2]


def kind(row: dict) -> str:
    if row["source"] == "multi":
        return "multi_command"
    if not row["intents"]:
        return "no_command"
    return "handwritten_unseen_phrasing" if row["source"].startswith("handwritten") else "nlu_v2"


def score(rows: list[dict], answers: list[list[dict]]) -> dict:
    by = defaultdict(lambda: [0, 0, 0])
    for r, a in zip(rows, answers):
        gold = [canonical(c) for c in r["intents"]]
        got = [canonical(c) for c in a if valid(c)]
        for k in ("all", kind(r)):
            by[k][0] += 1
            by[k][1] += got == gold
            by[k][2] += [c["type"] for c in got] == [c["type"] for c in gold]
    return {k: {"n": n, "exact_match": round(e / n, 4), "type_match": round(t / n, 4)} for k, (n, e, t) in sorted(by.items())}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--parser", type=Path, help="rule-based parser answers for the test sentences (JSONL)")
    ap.add_argument("--limit", type=int)
    args = ap.parse_args(argv)
    from ..config import CommandLLMConfig
    from ..nlu.command_llm import CommandLLM

    rows = [json.loads(l) for l in (ROOT / "data" / "command_llm" / "test.jsonl").read_text(encoding="utf-8").splitlines()]
    rows = rows[: args.limit] if args.limit else rows
    proc = psutil.Process()
    rss0 = proc.memory_info().rss
    t0 = time.perf_counter()
    llm = CommandLLM(CommandLLMConfig())
    load_s, rss_loaded = time.perf_counter() - t0, proc.memory_info().rss
    answers, lat = [], []
    for r in rows:
        cmds, s = llm.interpret(r["text"])
        answers.append(cmds)
        lat.append(s)
    report = {
        "model": llm.name, "n": len(rows), "threads": llm.config.threads,
        "load_s": round(load_s, 2), "rss_model_mb": round((rss_loaded - rss0) / 2**20, 1),
        "rss_peak_process_mb": round(proc.memory_info().peak_wset / 2**20, 1) if hasattr(proc.memory_info(), "peak_wset") else None,
        "latency_s": {"median": round(statistics.median(lat), 3), "p95": round(sorted(lat)[int(len(lat) * 0.95)], 3)},
        "llm": score(rows, answers),
        "errors": [{"text": r["text"], "gold": r["intents"], "got": a} for r, a in zip(rows, answers)
                   if [canonical(c) for c in a] != [canonical(c) for c in r["intents"]]][:60],
    }
    if args.parser:
        parsed = [json.loads(l) for l in args.parser.read_text(encoding="utf-8").splitlines()][: len(rows)]
        parsed = [p["intents"] if isinstance(p, dict) else p for p in parsed]  # {intents, unparsed} or a bare list
        report["rule_parser"] = score(rows, parsed)
    (ROOT / "reports" / "command_llm_eval.json").write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "errors"}, indent=1, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
