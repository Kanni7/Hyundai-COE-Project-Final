# BhashaDrive V2 — edge-oriented Hindi / English / Hinglish in-car voice commands

BhashaDrive maps spoken English, Hindi (Devanagari), Romanized Hindi and Hindi-English
code-switched requests onto a **finite, whitelisted set of vehicle actions**, fully offline.
V2 replaces the mandatory Qwen2.5-3B/Ollama runtime with a compact pipeline:

```
microphone / WAV
  → local ASR            sherpa-onnx + hi-hinglish-swift (Whisper-base fine-tune, INT8 ONNX)   audio/sherpa_asr.py
  → normalisation        Unicode NFC + whitespace only (never drops words)                    pipeline.py
  → intent model         multilingual sentence encoder (INT8 ONNX) + our trained linear heads nlu/intent_model.py
                         (intent, negation, implicit-request)                                  
  → personal commands    SQLite + cosine matching with calibrated thresholds                  personalization/
  → dialog context       one pending proposal (TTL), confirmations, cancellations             pipeline_v2.py
  → policy + validation  negation / ambiguity / confidence / per-intent schema / bounds       policy/policy_v2.py
  → vehicle adapter      MockVehicleAdapter (dev) · OEM adapter boundary (prod)                vehicle/
  → structured result    ResultV2 (Pydantic)                                                   schemas_v2.py
```

No LLM, cloud API or network call is used at runtime. If a required local model cannot load,
the pipeline raises a clear error and never executes a vehicle command. The V1 LLM path is kept
**only** as an opt-in development benchmark (`--legacy-llm`); it is never used as a fallback.

> Evidence status: all accuracy numbers below come from **synthetic** text and **synthetic TTS** audio
> on a development laptop. No real driver recordings and no automotive hardware were available.
> See `AUTOMOTIVE_FEASIBILITY.md` for what this does and does not show.

## Intent taxonomy (v2.0.0, `nlu/taxonomy.py`)

| intent | parameters (validated) |
|---|---|
| `climate_temperature_up` / `climate_temperature_down` | direction fixed by intent; optional `amount` small/medium/large |
| `climate_temperature_set` | **required** `target_temperature_celsius`, range-checked (16–30 °C default) |
| `climate_fan_speed_up` / `climate_fan_speed_down` | optional `amount` |
| `climate_on` / `climate_off` | — |
| `volume_up` / `volume_down` | optional `amount` |
| `media_play` / `media_pause` / `media_next` / `media_previous` | — |
| `navigation_destination_request` | **required** `destination` (length/charset-checked; search request only) |
| `dialog_confirm` / `dialog_cancel` | only meaningful with a pending proposal |
| `unsupported` | always rejected (doors, brakes, windows, calls, chit-chat …) |
| `ambiguous` | always a clarification question |

Decisions: `execute`, `ask_confirmation` (implicit requests such as "I'm freezing"), `clarify`
(ambiguous, low-confidence, missing parameter), `reject` (unsupported, negated, out-of-range), `saved`
(personalisation change committed).

## Setup (Windows or Ubuntu, Python ≥ 3.10; tested on 3.14)

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate        Linux: source .venv/bin/activate
pip install -r requirements.txt
pip install -e .
python scripts/download_models.py --asr swift apex --encoder minilm e5   # one-time, ~2.2 GB; swift+minilm only: ~0.6 GB
```

Model files go to `./models` and trained artifacts to `./artifacts` (both git-ignored). After the
download every step runs with `HF_HUB_OFFLINE=1`.

## Reproducing the results

```bash
python scripts/reproduce_v2.py          # all steps below, in order (~30 min on a 6-core laptop CPU)
```

or step by step:

```bash
python -m bhashadrive.training.prepare_dataset                       # data/nlu_v2/*.jsonl (group-split, synthetic)
python -m bhashadrive.training.export_onnx --encoder minilm e5        # ONNX fp32 + dynamic INT8, agreement check
python -m bhashadrive.training.train_classifier --encoder minilm e5 --backend torch onnx_int8   # frozen encoder + heads
python -m bhashadrive.training.finetune_encoder --encoder minilm e5   # EXPERIMENT: supervised encoder fine-tuning
python -m bhashadrive.training.export_onnx --encoder minilm-ft e5-ft
python -m bhashadrive.training.train_classifier --encoder minilm-ft e5-ft --backend onnx_fp32 onnx_int8
python -m bhashadrive.evaluation.eval_nlu_v2 --models minilm_onnx_int8 e5_onnx_int8 minilm-ft_onnx_int8 e5-ft_onnx_fp32 e5-ft_onnx_int8 --promote e5-ft_onnx_int8
python -m bhashadrive.evaluation.eval_personalization                 # calibrates artifacts/personalization.json
python -m bhashadrive.evaluation.eval_asr --models swift apex         # WER/CER, latency, memory, noise, e2e intent
```

Synthetic audio (Windows only, offline OneCore voices):
`powershell -ExecutionPolicy Bypass -File scripts\make_tts_samples.ps1 -OutDir samples\tts_v2 -Manifest scripts\tts_samples_v2.json`.
Real recordings: `python scripts/record_eval_set.py --speaker s01 --noise car_idle`, then
`python -m bhashadrive.evaluation.eval_asr --models swift apex --manifest samples/real/manifest.json`.

### Command LLM (fallback interpreter)

A fine-tuned Gemma 3 270M turns sentences the parser and classifier cannot read with confidence into
cockpit commands (several per sentence), served at `POST /interpret`. It runs on the CPU via llama.cpp
(`models/llm/cockpit-gemma-270m.q8_0.gguf`, ~290 MB); without the file the backend runs without it.
Training needs Hugging Face access to `google/gemma-3-270m-it` (accept the Gemma licence, `hf auth login`)
and a separate environment with CUDA torch, `transformers` and llama.cpp's `convert_hf_to_gguf.py`
(from the llama.cpp commit that `llama-cpp-python` vendors, with its `gguf-py`):

```bash
python -m bhashadrive.training.command_llm_data                                   # data/command_llm/*.jsonl
python -m bhashadrive.training.train_command_llm --convert-script <llama.cpp>/convert_hf_to_gguf.py
python -m bhashadrive.evaluation.eval_command_llm                                 # reports/command_llm_eval.json
```

### Wind-noise suppression

Uploaded microphone audio is passed through a conservative, single-channel wind
filter before ASR. It applies a soft adaptive low-frequency attenuation, so speech
is preserved better than with a fixed aggressive high-pass filter. Browser capture
also requests the platform noise suppressor and disables automatic gain control so
quiet wind is not amplified before the server receives it.

The filter is enabled by default. Tune it with environment variables:

```text
BD_WIND_SUPPRESSION_STRENGTH=0.75   # 0 disables the custom filter; 1 is strongest
BD_WIND_SUPPRESSION_MAX_DB=18       # maximum low-frequency attenuation
```

To inspect a recording manually and write the exact preprocessed signal used by
ASR:

```bash
python scripts/filter_wind.py input.webm recordings/input_wind_filtered.wav
```

The command prints the estimated wind score and writes a 16 kHz WAV file for
listening or comparison. The filter unit tests use deterministic speech-plus-wind
signals; real validation should also use recordings from the target microphone,
windscreen, cabin, and airflow directions.

The running API exposes `GET /api/wind-settings` and `POST /api/wind-settings`,
which the cockpit Settings menu uses for live changes. `POST /api/wind-test`
accepts one recorded utterance, adds deterministic synthetic low-frequency wind,
and returns three ASR results: clean audio, noisy audio with the custom filter
off, and the same noisy audio with the current filter settings. This makes an
A/B test possible without saving the recording on the server.

## BharatConnect (driver ↔ passenger voice translation)

Two-way push-to-talk translation in the cockpit (top bar → **BharatConnect**): the driver speaks, the
passenger hears it in their language, then the passenger replies and the driver hears the translation.
Tamil, Hindi and English in any direction (one row per language in `bharat/languages.py`).

One turn: microphone (stops on a pause, a second tap or 15 s) → `POST /bharat/transcribe` (Faster-Whisper,
in the speaker's language) → `POST /bharat/translate` (Google Cloud Translation v3) → `POST /bharat/speak`
(Google Cloud Text-to-Speech, MP3) → playback. Each stage is its own request: the UI shows the stage, a failed
turn retries from that stage, and the per-stage and end-to-end timings (end of speech → translated audio
starts) are measured in the browser and shown on every turn. Both microphones are locked while a turn is
processed or its audio plays, so the system never records its own speech.

**Google Cloud setup** (both services need it; credentials stay on the backend):

1. In a Google Cloud project, enable the **Cloud Translation API** and the **Cloud Text-to-Speech API**.
2. Create a service account with the role **Cloud Translation API User** and download a JSON key
   (keep it out of source control), or use `gcloud auth application-default login` on a developer machine.
3. Set, in the backend's environment or `.env`:

   ```
   GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\service-account.json
   GOOGLE_CLOUD_PROJECT=your-project-id
   ```

Without them the panel opens and shows what is missing; transcription still works. Optional settings:
`BD_BHARAT_ASR_MODEL` (default `small`; `large-v3-turbo` is far more accurate for Tamil, a one-time
~1.6 GB download: start once with `BD_ASR_LOCAL_ONLY=false`), `BD_BHARAT_MAX_AUDIO_S` (30),
`BD_BHARAT_TRANSLATE_TIMEOUT_S` (8), `BD_BHARAT_TTS_TIMEOUT_S` (10). Recordings are deleted after
transcription and conversation text is not logged; repeated phrases are served from small in-memory caches.

## Running

```bash
python -m bhashadrive.cli text "Bhai, AC thoda warm kar do"
python -m bhashadrive.cli file samples/tts_v2/v13_hg_volume.wav
python -m bhashadrive.cli chat        # multi-turn; try the personalisation dialogue below
python -m bhashadrive.cli mic         # push-to-talk
python -m bhashadrive.cli serve       # http://127.0.0.1:8000 (text, audio, /state, /personal)
python -m bhashadrive.cli --json text "Don't turn the AC off"
```

Personalised commands (stored in `data/profiles/bhashadrive.sqlite`, per `BD_PROFILE_ID`):

```
driver> Jab main 'chill mode' bolun, AC 22 pe set kar dena.
[SAY] Should I save this: when you say 'chill mode', I will set the cabin temperature to 22°C?
driver> haan
[SAY] Saved. Say 'chill mode' to set the cabin temperature to 22°C.
driver> Chill mode, yaar.           -> executes (personal command, re-validated)
driver> Don't use chill mode        -> rejected (negation)
driver> what does 'chill mode' do?  -> asks before running (quoted / meta reference)
driver> change 'chill mode' to set the temperature to 20   -> confirm -> updated
driver> make 'relax' do the same as 'chill mode'           -> confirm -> alias added
driver> delete 'chill mode'                                -> confirm -> deleted
driver> list my shortcuts
```

Teaching never fine-tunes a model; it writes one validated database row after explicit
confirmation. One action per shortcut; compound actions are rejected explicitly. Raw audio is not
stored. Correction history is kept only with `BD_STORE_CORRECTIONS=true`.

## Tests

```bash
pytest                    # unit/regression tests (fake model; no weights needed)
pytest -m integration     # real models: offline end-to-end audio, real-model intents, negation, personalisation
```

## Layout

| path | content |
|---|---|
| `bhashadrive/audio/` | `sherpa_asr.py` (V2), `asr.py` (interface + V1 faster-whisper), preprocessing, microphone |
| `bhashadrive/nlu/` | `taxonomy.py`, `encoder.py` (ONNX/torch), `intent_model.py`, `slots.py`; V1 LLM parser kept |
| `bhashadrive/training/` | seeds, hand-written eval set, dataset builder, ONNX export, head training, fine-tuning |
| `bhashadrive/personalization/` | SQLite store, matcher, teach/manage parsing |
| `bhashadrive/policy/` | `policy_v2.py` (V2), V1 policy kept |
| `bhashadrive/vehicle/` | adapter interface, `dispatch_v2`, mock adapter, documented OEM boundary |
| `bhashadrive/evaluation/` | NLU, personalisation and ASR benchmarks; V1 evaluation kept |
| `data/nlu_v2/` | generated dataset splits (text, synthetic) |
| `reports/` | measured results (JSON + Markdown) |

## Android / embedded path

See `AUTOMOTIVE_FEASIBILITY.md` §5. In short: the same `encoder.int8.onnx`/`decoder.int8.onnx`
run with the sherpa-onnx Android (Kotlin/JNI) or C++ API; the sentence encoder runs with ONNX
Runtime Mobile (or is converted for the SoC NPU); the linear heads are a 384×18 matrix and the
policy/validation/personalisation logic is small enough to port to Kotlin/C++ directly. The
vehicle adapter becomes an Android Automotive `CarPropertyManager`/VHAL client or an OEM
middleware client, subject to manufacturer authorisation.
