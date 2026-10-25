# Architecture Blueprint — Verna Smart Cockpit + BhashaDrive

Source of truth for both visual prompts. Every claim maps to code; paths are relative to the repo root.

## A. System overview

A browser-based Hyundai Verna cockpit (React) that the driver controls by voice or text in **English, Hindi (Devanagari) and romanised Hinglish**. A local Python backend, **BhashaDrive**, runs speech recognition and intent understanding on the device and applies a deterministic safety policy before anything changes in the car. The output is a cockpit state change (climate, fan, media, ambient light, windows, seats, navigation, drive mode and more), shown in an animated SVG cockpit, plus a spoken reply. Three side features: an optional subscription-gated **cloud tier** (Sarvam STT + OpenAI LLM), a **camera-based drowsiness monitor** that runs in the browser, and **BharatConnect**, which translates speech between driver and passenger.

Deployment: one FastAPI/Uvicorn process on `127.0.0.1:8000` serves the built React app at `/` and the API at `/` and `/api` (`backend/bhashadrive/api/server.py`, `start.ps1`). The repo has no Docker, CI or cloud deployment. A thread lock makes requests run one at a time (one conversation).

## B. End-to-end data flow (free tier, on-device)

| # | Stage | In → Out | Evidence |
|---|---|---|---|
| 1 | **Driver input**: browser mic recording (stops after a pause or at 8 s; noise suppression on, auto gain off), typed text, quick chips; optionally Chrome Web Speech | voice / text → audio blob or text | `frontend/src/App.tsx` (`toggleServerMic`, `recordAudio`), `lib/speech.ts` |
| 2 | **Audio front-end**: `POST /api/transcribe` (10 MB cap); decoded with PyAV to 16 kHz mono; adaptive low-shelf wind suppression (tunable live); silence and length guards (15 s) | audio → clean 16 kHz PCM | `audio/preprocessing.py`, `audio/wind_suppression.py`, `server.py` |
| 3 | **On-device ASR**: `hi-hinglish-swift` (Whisper-base fine-tuned on Hindi/Hinglish, INT8 ONNX on onnxruntime), one decoding pass per language (`hi`, `en`), so several hypotheses come back. faster-whisper `small` is used only if the ONNX model cannot load | PCM → N transcript hypotheses | `audio/hybrid_asr.py`, `audio/sherpa_asr.py`, `audio/whisper_onnx.py` |
| 3b | **Speaker ID** (parallel): CAM++ 512-d voice embedding (sherpa-onnx), cosine match against enrolled voiceprints (threshold + margin), then the driver profile switches automatically (seat and preferences) | PCM → profile id or null | `audio/speaker_id.py`, `App.tsx` |
| 4 | **Transcript refinement**: Unicode NFC, removal of Whisper hallucinations, fixes for Hinglish phonetic slips, domain snapping, then phonetic candidate retrieval (RapidFuzz) and **encoder-based rescoring** (the candidate the intent model fits best wins). Hypotheses are ranked by the same fitness score; the cockpit then picks the final transcript by local-parser agreement voting (`bestTranscript`) | hypotheses → ranked refined transcripts | `nlu/normalizer.py`, `nlu/rescorer.py`, `pipeline_v2.py::rank_transcripts`, `App.tsx::bestTranscript` |
| 5 | **Hybrid NLU router** (browser): a negation guard runs first, so negated commands never execute. The rule-based local parser (EN/HI/Hinglish, splits compound sentences into clauses) handles compound or out-of-domain commands itself. Single climate/fan/volume/media/navigation commands, or text it did not understand, go to BhashaDrive. The command LLM is called when the parser and classifier disagree, when the classifier is unsure or says unsupported, or when a multi-clause sentence is only partly parsed | text → route decision | `App.tsx::route`, `nlu/parser.ts`, `lib/backend.ts` |
| 6 | **BhashaDrive intent engine** (`POST /api/text`): multilingual sentence encoder (paraphrase-multilingual-MiniLM-L12-v2, INT8 ONNX, mean-pooled, L2-normalised) feeding **3 trained linear heads**: intent (softmax over 18 classes, temperature-scaled), negation (sigmoid), implicit request (sigmoid). Then personal-shortcut match, dialog context (one pending proposal, 60 s TTL), and **Policy V2**: unsupported → reject; ambiguous → clarify; negated → reject; low score/margin → clarify; slot extraction and range validation (16–30 °C, fan 0–7, volume 0–30, safe destination text); implicit request → ask confirmation; otherwise execute | text → `ResultV2` decision: execute / ask_confirmation / clarify / reject / saved | `nlu/intent_model.py`, `nlu/encoder.py`, `nlu/taxonomy.py`, `policy/policy_v2.py`, `pipeline_v2.py` |
| 6b | **Command LLM fallback** (`POST /api/interpret`): **fine-tuned Gemma 3 270M**, 8-bit GGUF, llama.cpp on the CPU. It turns one sentence into up to 4 cockpit commands, each checked against the 44-command allowlist schema (unknown commands or out-of-range values are dropped) | text → `Intent[]` JSON | `nlu/command_llm.py`, `nlu/cockpit_commands.py` |
| 7 | **Cockpit state and response**: `runIntents()` updates `CarState`; React renders the SVG cockpit; the browser speaks the reply (`speechSynthesis`) and plays a chime/toast; the mic reopens when the car asks a question. On the backend, executed actions go to `MockVehicleAdapter`; the Hyundai adapter is a documented `NotImplementedError` boundary | intents → UI + voice | `state/car.ts`, `App.tsx::finish`, `vehicle/mock_adapter.py`, `vehicle/hyundai_adapter.py` |

Failure handling: if the backend is down, the cockpit runs entirely on the local parser and checks again every 15 s. ASR returns no action on silence or timeout. If the NLU artifacts are missing, the server falls back to a deterministic mock pipeline. An LLM or cloud failure falls back to the on-device route.

## C. Core modules (diagram boxes)

1. **Driver Input**: voice, text, chips (`App.tsx`)
2. **Audio Front-End**: decoding, wind suppression, guards (`audio/`)
3. **On-Device Speech Recognition**: hi-hinglish-swift Whisper INT8 ONNX, HI+EN passes; plus **Speaker ID** (CAM++)
4. **Transcript Refinement**: normalisation, phonetic retrieval, encoder rescoring, hypothesis ranking
5. **Hybrid NLU Router**: negation guard and rule-based parser (`parser.ts`, `route()`)
6. **BhashaDrive Intent Engine (AI core)**: encoder + 3 heads, then shortcuts, dialog context and safety policy; plus **Command LLM fallback** (Gemma 3 270M)
7. **Cockpit State & Response**: `runIntents`, SVG cockpit, spoken reply

Side lanes: **Premium Cloud Tier** (optional), **Driver Drowsiness Monitor**, **BharatConnect**, **Data stores**, **Offline Training & Evaluation**.

## D. AI/ML architecture

| Component | Task | Model / method | Where it runs | Trained here? | Status |
|---|---|---|---|---|---|
| Speech recognition | Hinglish/Hindi/English STT | hi-hinglish-swift (Whisper-base fine-tune, third-party), INT8 ONNX | backend CPU (onnxruntime) | No, pretrained download | Implemented; model present locally |
| ASR load fallback | STT | faster-whisper `small` int8 (CTranslate2) | backend CPU | No | Implemented |
| Speaker ID | Identify the driver | 3D-Speaker CAM++ embeddings + cosine/margin matching | backend CPU (sherpa-onnx) | No (enrollment stores mean embeddings) | Implemented; model present |
| Rescorer | Fix misheard in-car words | RapidFuzz phonetic candidates + intent-model fitness score | backend | Rule + model | Implemented |
| Sentence encoder | Text embedding | paraphrase-multilingual-MiniLM-L12-v2 → ONNX FP32 → dynamic INT8 (multilingual-E5 also evaluated; encoder fine-tuning evaluated as an experiment) | backend CPU | Exported/quantised here | Implemented |
| Intent / negation / implicit heads | Classification | Logistic-regression linear heads, temperature scaling, thresholds calibrated on validation | backend (NumPy) | **Yes**, on synthetic data | Implemented; artifacts not in this checkout |
| Safety policy | Decide whether to act | Deterministic rules (order: scope → ambiguity → negation → confidence → slots/bounds → implicit) | backend | Rules | Implemented |
| Personal shortcuts | User-taught phrases | SQLite + cosine similarity with calibrated thresholds | backend | No (confirmed DB rows; never fine-tunes) | Implemented |
| Command LLM | Free-form sentence → multiple commands | Gemma 3 270M, full fine-tune (embeddings frozen), Q8_0 GGUF, llama.cpp | backend CPU | **Yes** (`training/train_command_llm.py`) | Implemented; GGUF not in this checkout |
| Local parser | Rule-based NLU, compound commands | Vocabulary/regex grammar | browser | Rules | Implemented |
| Drowsiness | Driver fatigue | MediaPipe Face Landmarker (blendshapes: eyeBlink, jawOpen; head pose) + PERCLOS (30 s window, 0.15 tired / 0.30 drowsy), ≥2 s eye closure, microsleeps, yawns, 8 s per-driver calibration | browser (WASM, GPU→CPU) | No | Implemented |
| Premium interpreter | Cloud NLU | Sarvam Saaras v4 STT (codemix) → OpenAI Responses API, strict JSON schema built from the same 44-command allowlist (default model `gpt-6.1-sol`, configurable; Groq-compatible) | cloud | No | Configured; needs API keys + entitlement |

## E. Data and API dependencies

- **Local stores**: `data/profiles/bhashadrive.sqlite` (personal shortcuts with cached embeddings), `data/profiles/voiceprints.json` (speaker embeddings only, no audio), browser `localStorage` (driver profiles), `data/usage/assistant_usage.jsonl` (premium usage/cost, no content). Recordings are deleted after processing unless `BD_STORE_AUDIO=true`.
- **Cloud (optional, outbound HTTPS from the backend only)**: Google Cloud Translation v3 + Google Cloud Text-to-Speech (BharatConnect); Sarvam Saaras STT + OpenAI Responses API (premium). Keys stay on the server.
- Chrome Web Speech mode (optional in the UI) streams audio to Google through the browser.

## F. User interaction and feedback

- Confirmation dialogs (implicit requests, consequential premium commands) and clarification questions reopen the mic for the answer.
- **Explicit personalisation**: "Jab main 'chill mode' bolun, AC 22 pe set kar dena" → confirm → one validated SQLite row (teach / alias / correct / delete / list). **No model retraining.** A complaint is not learned from (`personal_feedback_not_learned`).
- **Voice enrollment** ("Teach Voice") adds CAM++ embeddings to a profile's voiceprint.
- No feedback loop updates any model. Usage metering is analytics only.

## G. Verified technology stack

- **Frontend**: React 19, TypeScript, Vite, lucide-react, SVG-drawn cockpit, Web Audio API (synthesised music/chimes), MediaRecorder, Web Speech API (optional), speechSynthesis, localStorage
- **Computer vision**: MediaPipe Tasks Vision Face Landmarker (bundled WASM + model)
- **Backend**: Python ≥3.10, FastAPI, Uvicorn, Pydantic v2, httpx, PyAV, soundfile, NumPy
- **On-device AI**: ONNX Runtime, hi-hinglish-swift Whisper, faster-whisper/CTranslate2, multilingual MiniLM encoder, HF tokenizers, sherpa-onnx (CAM++), RapidFuzz, llama-cpp-python (Gemma 3 270M)
- **Training/eval (dev only)**: PyTorch, Transformers, sentence-transformers, scikit-learn, ONNX; pytest
- **Data**: SQLite, JSON/JSONL
- **Optional cloud**: Google Cloud Translation v3, Google Cloud TTS, Sarvam Saaras v4, OpenAI API

## H. Technical uncertainties

1. **The trained artifacts are missing from this checkout.** `backend/artifacts/` (encoder ONNX + `heads.npz` + manifest) and `models/llm/*.gguf` are git-ignored and absent. On this machine the server would start the **mock NLU** (`tests/fakes_v2.py`) with real HybridASR, and `/interpret` would be unavailable. The diagram shows the full V2 configuration that the training scripts produce and `reports/` documents.
2. **The promoted encoder variant is unclear.** The backend README promotes `e5-ft_onnx_int8`, while only MiniLM is downloaded locally and `reports/nlu_eval_v2.md` lists MiniLM-ft variants. The diagram says "multilingual MiniLM encoder".
3. **The root README's "retry on Whisper small" claim is not in the code.** It says audio is retried on Whisper small when the transcript can't be used. The code uses faster-whisper only when the ONNX model fails to load.
4. The rescorer is named "Transformer self-attention" in code comments; in practice it scores candidates by intent-model confidence and margin. The visuals describe it as "encoder-based rescoring".
5. HybridASR's cloud Whisper path (OpenAI/Groq) is off by default (`BD_HYBRID_CLOUD_ASR=false`) and left out of the diagram.
6. The V1 path (faster-whisper + Qwen2.5-3B via Ollama) is a dev-only benchmark and left out.
7. All accuracy and latency figures in `reports/` come from synthetic text and synthetic TTS audio. No metrics appear in the visuals.
8. There is no real vehicle integration: `MockVehicleAdapter` only, and the Hyundai adapter is an unimplemented boundary. The premium tier has no payment integration (entitlements JSON only).
