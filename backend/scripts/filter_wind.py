"""Run the production audio preprocessor on a recording and write a WAV file.

Example:
    python scripts/filter_wind.py input.webm output.wav --strength 0.8
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import soundfile as sf

from bhashadrive.audio.preprocessing import TARGET_SR, decode_file, preprocess
from bhashadrive.audio.wind_suppression import analyze_wind


def main() -> None:
    parser = argparse.ArgumentParser(description="Reduce wind noise before speech recognition")
    parser.add_argument("input", type=Path, help="Input WAV/WebM/OGG/FLAC/MP3 file")
    parser.add_argument("output", type=Path, help="Output WAV file")
    parser.add_argument("--strength", type=float, default=None, help="Wind suppression strength from 0 to 1")
    args = parser.parse_args()

    raw = decode_file(args.input, TARGET_SR)
    stats = analyze_wind(raw, TARGET_SR)
    filtered = preprocess(raw, wind_strength=args.strength)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(args.output, filtered, TARGET_SR)

    print(json.dumps({
        "input": str(args.input),
        "output": str(args.output),
        "sample_rate": TARGET_SR,
        "duration_s": round(raw.size / TARGET_SR, 3),
        "wind_probability_mean": round(stats.mean_probability, 3),
        "wind_probability_max": round(stats.max_probability, 3),
    }, indent=2))


if __name__ == "__main__":
    main()
