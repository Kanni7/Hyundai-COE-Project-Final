"""Fine-tune Gemma 3 270M (instruction-tuned) into the cockpit command model and export it for llama.cpp.

  python -m bhashadrive.training.command_llm_data          # dataset first (backend venv)
  python -m bhashadrive.training.train_command_llm         # GPU env: torch (CUDA) + transformers + gguf

Needs Hugging Face access to google/gemma-3-270m-it (accept the Gemma licence, then `hf auth login`).
Steps: prompt + JSON answer per row, loss on the answer only; full fine-tune of the transformer layers with
the (tied, 168M-parameter) embedding frozen, which keeps the general vocabulary and fits a 6 GB GPU;
the epoch with the best validation exact match is kept. Teacher-forced exact match equals greedy-decoding
exact match: the greedy decoder reproduces the answer iff every next-token argmax is right.
Output: models/llm/cockpit-gemma-270m/ (Hugging Face) and models/llm/cockpit-gemma-270m.q8_0.gguf.
"""
from __future__ import annotations

import argparse
import json
import math
import random
import subprocess
import sys
import time
from pathlib import Path

from ..nlu.cockpit_commands import prompt

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "command_llm"
OUT = ROOT / "models" / "llm"
BASE = "google/gemma-3-270m-it"
NAME = "cockpit-gemma-270m"


def answer(intents: list[dict]) -> str:
    return json.dumps(intents, ensure_ascii=False, separators=(",", ":")) + "<end_of_turn>"


def load(split: str) -> list[dict]:
    return [json.loads(l) for l in (DATA / f"{split}.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]


def encode(tok, rows: list[dict]) -> list[tuple[list[int], int]]:
    """(token ids, index where the answer starts) per row."""
    out = []
    for r in rows:
        p = tok(prompt(r["text"]), add_special_tokens=True).input_ids
        a = tok(answer(r["intents"]), add_special_tokens=False).input_ids
        out.append((p + a, len(p)))
    return out


def batches(items, size: int, shuffle: bool, rng: random.Random):
    # Similar lengths together, then shuffled batch order: little padding, still random.
    order = sorted(range(len(items)), key=lambda i: len(items[i][0]) + (rng.random() if shuffle else 0))
    groups = [order[i:i + size] for i in range(0, len(order), size)]
    if shuffle:
        rng.shuffle(groups)
    return groups


def run_batch(model, torch, items, idx, pad_id, device):
    """Loss and per-row exact match on the answer tokens only (logits computed just for those)."""
    seqs = [items[i] for i in idx]
    T = max(len(s) for s, _ in seqs)
    ids = torch.full((len(seqs), T), pad_id, dtype=torch.long)
    mask = torch.zeros((len(seqs), T), dtype=torch.long)
    target = torch.full((len(seqs), T), -100, dtype=torch.long)
    for b, (s, start) in enumerate(seqs):
        ids[b, :len(s)] = torch.tensor(s)
        mask[b, :len(s)] = 1
        target[b, start - 1:len(s) - 1] = torch.tensor(s[start:])  # position t predicts token t+1
    ids, mask, target = ids.to(device), mask.to(device), target.to(device)
    with torch.autocast("cuda", dtype=torch.bfloat16, enabled=device == "cuda"):
        hidden = model.model(input_ids=ids, attention_mask=mask).last_hidden_state
        sel = target != -100
        logits = model.lm_head(hidden[sel]).float()
        cap = getattr(model.config, "final_logit_softcapping", None)
        if cap:
            logits = torch.tanh(logits / cap) * cap
    gold = target[sel]
    loss = torch.nn.functional.cross_entropy(logits, gold)
    right = (logits.argmax(-1) == gold).long()
    rows = sel.nonzero()[:, 0]
    wrong_per_row = torch.zeros(len(seqs), dtype=torch.long, device=device).index_add_(0, rows, 1 - right)
    return loss, (wrong_per_row == 0).sum().item()


def train(epochs: int, lr: float, batch: int, seed: int) -> dict:
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    torch.manual_seed(seed)
    rng = random.Random(seed)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    tok = AutoTokenizer.from_pretrained(BASE)
    model = AutoModelForCausalLM.from_pretrained(BASE, dtype=torch.float32, attn_implementation="eager").to(device)
    model.model.embed_tokens.weight.requires_grad_(False)  # tied with lm_head
    params = [p for p in model.parameters() if p.requires_grad]
    tr, va = encode(tok, load("train")), encode(tok, load("val"))
    pad = tok.pad_token_id if tok.pad_token_id is not None else 0
    steps = epochs * math.ceil(len(tr) / batch)
    opt = torch.optim.AdamW(params, lr=lr, weight_decay=0.0)
    warm = max(1, steps // 30)
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda s: min(1.0, (s + 1) / warm) * 0.5 * (1 + math.cos(math.pi * min(1.0, s / steps))))
    best, dst, log = -1.0, OUT / NAME, []
    t0 = time.time()
    for ep in range(1, epochs + 1):
        model.train()
        for k, idx in enumerate(batches(tr, batch, True, rng)):
            loss, _ = run_batch(model, torch, tr, idx, pad, device)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            opt.step()
            sched.step()
            opt.zero_grad(set_to_none=True)
            if k % 100 == 0:
                print(f"epoch {ep} step {k} loss {loss.item():.4f}", flush=True)
        model.eval()
        exact = 0
        with torch.no_grad():
            for idx in batches(va, batch, False, rng):
                exact += run_batch(model, torch, va, idx, pad, device)[1]
        em = exact / len(va)
        if device == "cuda":  # a 6 GB card otherwise spills into shared memory and slows ~5x
            torch.cuda.empty_cache()
        log.append({"epoch": ep, "val_exact_match": round(em, 4), "elapsed_s": round(time.time() - t0, 1)})
        print(log[-1], flush=True)
        if em > best:
            best = em
            dst.mkdir(parents=True, exist_ok=True)
            model.save_pretrained(dst)
            copy_base_tokenizer(dst)
    info = {"base": BASE, "epochs": log, "best_val_exact_match": round(best, 4), "train_rows": len(tr),
            "lr": lr, "batch": batch, "frozen": "embed_tokens (tied lm_head)"}
    (dst / "training.json").write_text(json.dumps(info, indent=2), encoding="utf-8")
    return info


def copy_base_tokenizer(dst: Path) -> None:
    """The base model's own tokenizer files (unchanged by fine-tuning). A re-saved tokenizer lacks the
    SentencePiece `tokenizer.model` that llama.cpp's converter reads for Gemma."""
    import shutil

    from huggingface_hub import hf_hub_download

    for f in ("tokenizer.model", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "added_tokens.json"):
        shutil.copy(hf_hub_download(BASE, f), dst / f)


def export_gguf(convert_script: Path) -> Path:
    """HF checkpoint -> GGUF (q8_0) with llama.cpp's converter; 8-bit keeps a 270M model's quality."""
    out = OUT / f"{NAME}.q8_0.gguf"
    subprocess.run([sys.executable, str(convert_script), str(OUT / NAME), "--outtype", "q8_0", "--outfile", str(out)],
                   check=True)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--lr", type=float, default=5e-5)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--convert-script", type=Path, required=True, help="llama.cpp convert_hf_to_gguf.py")
    ap.add_argument("--skip-train", action="store_true", help="only export the existing checkpoint")
    args = ap.parse_args(argv)
    if not args.skip_train:
        print(json.dumps(train(args.epochs, args.lr, args.batch, args.seed), indent=2))
    print("wrote", export_gguf(args.convert_script))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
