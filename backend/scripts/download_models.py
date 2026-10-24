"""One-time model download (needs internet). Afterwards everything runs from local files.

  python scripts/download_models.py                         # V2 runtime: hi-hinglish-swift ASR + MiniLM encoder
  python scripts/download_models.py --asr swift apex        # also the larger ASR comparison model (~1 GB)
  python scripts/download_models.py --encoder minilm e5     # also the alternative encoder for comparison
  python scripts/download_models.py --legacy                # V1 dev-only models (Whisper small + Ollama qwen2.5:3b)

Files go to ./models (git-ignored). Only the self-contained int8 ONNX files are fetched; the
`*.weights` leftovers in the Hinglish folders are not needed (see the model card).
"""
from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "models"
ASR_REPO = "parismitaglobalsolutions/indicconformer-sherpa-onnx"
ASR_VARIANTS = {
    "swift": ["hi-hinglish-swift/encoder.int8.onnx", "hi-hinglish-swift/decoder.int8.onnx", "hi-hinglish-swift/tokens.txt"],
    "apex": ["hi-hinglish-apex/encoder.int8.onnx", "hi-hinglish-apex/decoder.int8.onnx", "hi-hinglish-apex/tokens.txt"],
    # AI4Bharat IndicConformer Hindi CTC (Devanagari output), optional comparison
    "indic-hi": ["hi/model.int8.onnx", "tokens.txt"],
}
ENCODERS = {
    "minilm": "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
    "e5": "intfloat/multilingual-e5-small",
}
SPEAKER_FILENAME = "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"
SPEAKER_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    f"speaker-recongition-models/{SPEAKER_FILENAME}"
)
# Digest of the official sherpa-onnx release asset.
SPEAKER_SHA256 = "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2"


def download_speaker_model() -> Path:
    out_dir = MODELS / "speaker"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / SPEAKER_FILENAME
    if out.is_file():
        digest = hashlib.sha256(out.read_bytes()).hexdigest()
        if digest == SPEAKER_SHA256:
            print(f"  speaker: already present  {out}")
            return out
        out.unlink()

    partial = out.with_suffix(out.suffix + ".part")
    print(f"  speaker: downloading {SPEAKER_FILENAME}")
    try:
        urllib.request.urlretrieve(SPEAKER_URL, partial)
        digest = hashlib.sha256(partial.read_bytes()).hexdigest()
        if digest != SPEAKER_SHA256:
            raise RuntimeError(f"SHA-256 mismatch for {SPEAKER_FILENAME}: {digest}")
        partial.replace(out)
    finally:
        if partial.exists():
            partial.unlink()
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--asr", nargs="*", default=["swift"], choices=list(ASR_VARIANTS))
    ap.add_argument("--encoder", nargs="*", default=["minilm"], choices=list(ENCODERS))
    ap.add_argument("--speaker", action=argparse.BooleanOptionalAction, default=True,
                    help="download the local CAM++ driver voice model (default: enabled)")
    ap.add_argument("--legacy", action="store_true", help="also fetch the V1 Whisper + Ollama dev models")
    args = ap.parse_args()

    from huggingface_hub import hf_hub_download, snapshot_download

    for v in args.asr:
        for f in ASR_VARIANTS[v] + ["README.md"]:
            p = hf_hub_download(ASR_REPO, f, local_dir=MODELS / "asr")
            print(f"  asr:{v}  {p}")
    for key in args.encoder:
        repo = ENCODERS[key]
        p = snapshot_download(repo, local_dir=MODELS / "encoders" / repo.split("/")[1],
                              allow_patterns=["*.json", "*.txt", "*.model", "model.safetensors", "1_Pooling/*",
                                              "sentencepiece.bpe.model", "README.md", "LICENSE"])
        print(f"  encoder:{key}  {p}")
    if args.speaker:
        download_speaker_model()

    if args.legacy:
        from faster_whisper import WhisperModel

        WhisperModel("small", device="cpu", compute_type="int8")
        exe = shutil.which("ollama")
        if not exe:
            print("ollama not on PATH; skipping qwen2.5:3b (dev-only benchmark)", file=sys.stderr)
        else:
            subprocess.run([exe, "pull", "qwen2.5:3b"], check=True)
    print("Done. Runtime loads from ./models only and never contacts the network.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
