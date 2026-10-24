"""Free vs premium voice pipeline on the same recordings: WER/CER, command-intent accuracy, latency, cost.

  python -m bhashadrive.evaluation.eval_premium                        # every manifest with recordings
  python -m bhashadrive.evaluation.eval_premium --manifest samples/real/manifest.json --limit 50
  python -m bhashadrive.evaluation.eval_premium --sarvam-mode translit   # Latin-script output: script-fair WER

Pipelines (each scored against the manifest's `text` and `expected_intent`):
  local            on-device Whisper ONNX ASR -> on-device NLU (the free tier)
  sarvam+local-nlu Sarvam Saaras ASR -> the same on-device NLU (isolates the recogniser)
  premium          Sarvam Saaras ASR -> OpenAI LLM (the premium tier)
The premium pipelines run only with SARVAM_API_KEY / OPENAI_API_KEY set, and each call is billed.
References are Romanized; codemix writes Hindi words in Devanagari, which counts as errors in WER. Compare WER
with --sarvam-mode translit, intent accuracy in any mode. Synthetic TTS samples are a proxy for real cabin speech:
do not conclude either tier is better until it holds on real recordings.
"""
from __future__ import annotations

import argparse
import json
import statistics
import time
from pathlib import Path

import numpy as np

from ..audio.preprocessing import TARGET_SR, decode_file
from ..config import AppConfig
from .eval_asr import MANIFESTS, ROOT, _V2_INTENTS, edit_distance, load_items, norm_text

MANIFESTS = MANIFESTS + [(ROOT / "samples" / "tts_heldout" / "manifest.json", ROOT / "samples" / "tts_heldout")]


def label(cmds: list[dict]) -> str:
    """First cockpit command as a V2 intent label (the manifests' `expected_intent`)."""
    if not cmds:
        return "none"
    c = cmds[0]
    t, d = c["type"], c.get("delta") or 0
    return {"climate.adjustTemp": "climate_temperature_up" if d > 0 else "climate_temperature_down",
            "climate.setTemp": "climate_temperature_set",
            "climate.fan": "climate_fan_speed_up" if d > 0 else "climate_fan_speed_down",
            "climate.power": "climate_on" if c.get("on") else "climate_off",
            "media.volume": "volume_up" if d > 0 else "volume_down", "media.play": "media_play",
            "media.pause": "media_pause", "media.skip": "media_next" if c.get("dir") == 1 else "media_previous",
            "nav.start": "navigation_destination_request"}.get(t, t)


def score(items: list[dict], rows: dict[str, dict]) -> dict:
    we = wn = ce = cn = 0
    lat, ok, cost = [], [], 0.0
    for it in items:
        r = rows.get(it["id"])
        if r is None:
            continue
        ref, hyp = norm_text(it["text"]), norm_text(r["text"])
        we += edit_distance(ref.split(), hyp.split())
        wn += len(ref.split())
        ce += edit_distance(list(ref.replace(" ", "")), list(hyp.replace(" ", "")))
        cn += len(ref.replace(" ", ""))
        lat.append(r["latency_s"])
        cost += r.get("cost_inr", 0.0)
        if it.get("expected_intent") in _V2_INTENTS:
            ok.append(r["intent"] == it["expected_intent"])
    n = len(lat)
    return {"n": n, "wer": round(we / max(1, wn), 4), "cer": round(ce / max(1, cn), 4),
            "intent_accuracy": round(sum(ok) / len(ok), 4) if ok else None, "intent_n": len(ok),
            "latency_s_median": round(statistics.median(lat), 3) if lat else None,
            "latency_s_p95": round(float(np.percentile(lat, 95)), 3) if lat else None,
            "cost_inr_total": round(cost, 4), "cost_inr_per_command": round(cost / max(1, n), 5)}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifest", help="extra manifest JSON (wavs next to it)")
    ap.add_argument("--limit", type=int, default=0, help="first N recordings only (cloud calls are billed)")
    ap.add_argument("--sarvam-mode", help="override BD_SARVAM_STT_MODE for this run")
    ap.add_argument("--out", default=str(ROOT / "reports" / "premium_eval.json"))
    args = ap.parse_args(argv)

    manifests = list(MANIFESTS) + ([(Path(args.manifest), Path(args.manifest).parent)] if args.manifest else [])
    items = load_items(manifests)
    items = items[: args.limit] if args.limit else items
    if not items:
        print("No recordings found.")
        return 1
    config = AppConfig()
    if args.sarvam_mode:
        config.assistant.sarvam_mode = args.sarvam_mode
    from ..pipeline_v2 import build_v2_pipeline

    pipe = build_v2_pipeline(config, with_asr=True, with_personalization=False)
    local_asr = getattr(pipe.asr, "_local_asr", None) or pipe.asr

    def nlu(text: str, hyps=None) -> str:
        if not text:
            return "none"
        pipe.reset()
        res = pipe.process_text(text, hypotheses=hyps)
        return res.intent.value if res.intent is not None else "none"

    audio = {it["id"]: decode_file(it["path"], TARGET_SR) for it in items}
    runs: dict[str, dict[str, dict]] = {"local": {}}
    for it in items:
        t0 = time.perf_counter()
        res = local_asr.transcribe_array(audio[it["id"]], TARGET_SR)
        lat = time.perf_counter() - t0
        hyps = pipe.rank_transcripts(*(res.hypotheses or [res.text])) if res.text else []
        text = hyps[0] if hyps else ""
        runs["local"][it["id"]] = {"text": text, "latency_s": round(lat, 3), "intent": nlu(text, hyps)}

    a = config.assistant
    if a.sarvam_api_key:
        from ..assistant.providers import OpenAIInterpreter, ProviderError, SarvamASR

        sarvam = SarvamASR(a)
        llm = OpenAIInterpreter(a) if a.openai_api_key else None
        runs["sarvam+local-nlu"], errors = {}, 0
        if llm:
            runs["premium"] = {}
        for it in items:
            try:
                t = sarvam.transcribe(audio[it["id"]], TARGET_SR)
            except ProviderError as e:
                errors += 1
                print(f"[sarvam] {it['id']}: {e}")
                continue
            runs["sarvam+local-nlu"][it["id"]] = {"text": t.text, "latency_s": t.latency_s, "cost_inr": t.cost_inr,
                                                 "intent": nlu(t.text), "language": t.language}
            if llm and t.text:
                try:
                    out = llm.interpret(t.text, [], {})
                except ProviderError as e:
                    print(f"[openai] {it['id']}: {e}")
                    continue
                cmds = out.actions if out.status in ("execute", "confirm") else []
                runs["premium"][it["id"]] = {"text": t.text, "latency_s": round(t.latency_s + out.latency_s, 3),
                                             "cost_inr": t.cost_inr + out.cost_inr, "intent": label(cmds)}
        if errors:
            print(f"[sarvam] {errors} recordings failed")
    else:
        print("SARVAM_API_KEY not set: premium pipelines skipped (only the free tier was measured).")

    report = {"recordings": len(items), "sarvam_mode": a.sarvam_mode, "sarvam_model": a.sarvam_model,
              "llm_model": a.openai_model,
              "note": "Synthetic TTS recordings unless --manifest points at real ones. WER is script-sensitive "
                      "(codemix -> Devanagari); compare WER with --sarvam-mode translit.",
              "pipelines": {k: score(items, v) for k, v in runs.items()},
              "transcripts": {k: {i: r["text"] for i, r in v.items()} for k, v in runs.items()}}
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{'pipeline':18} {'n':>4} {'WER':>6} {'CER':>6} {'intent':>7} {'lat p50':>8} {'lat p95':>8} {'Rs/cmd':>8}")
    for k, s in report["pipelines"].items():
        acc = f"{s['intent_accuracy']:.1%}" if s["intent_accuracy"] is not None else "-"
        print(f"{k:18} {s['n']:>4} {s['wer']:>6.1%} {s['cer']:>6.1%} {acc:>7} {s['latency_s_median']!s:>8} "
              f"{s['latency_s_p95']!s:>8} {s['cost_inr_per_command']:>8.4f}")
    print(f"Report: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
