You are building ONE editable PowerPoint slide: the technical architecture of "BhashaDrive × Verna Smart Cockpit". Create a real `.pptx` file. Do not just describe it.

## Deliverable
- Save as `technical_architecture_outputs/bhashadrive_architecture_slide.pptx`. The file must contain exactly 1 slide, 16:9 (13.333 × 7.5 in).
- Build everything from native, editable shapes: rounded rectangles, text boxes, connectors/arrows, cylinders for data stores, and simple vector icons or icon-like shapes. Do NOT insert a flattened screenshot of a diagram.
- Group each module (card + icon + text) so an editor can move or recolour it as one unit. Give shapes meaningful names (e.g. `Stage3_ASR`).
- Optional: subtle fade-in entrance animations, in stage order. The slide must be fully understandable without them.
- If a renderer is available (LibreOffice headless → PDF → PNG), export `technical_architecture_outputs/bhashadrive_architecture_slide.png` at 1920 px or wider.

## Title area (top, about 12% of the height)
- Title: "BhashaDrive × Verna Smart Cockpit — Technical Architecture"
- Subtitle: "Offline-first multilingual (English · Hindi · Hinglish) in-car voice control: on-device AI + safety policy, optional cloud tier"

## Layout (one obvious left-to-right reading path)
Bands from top to bottom:
1. **Premium Cloud Tier** strip: thin, dashed outline, tagged "OPTIONAL · subscription-gated".
2. **Main pipeline**: 7 numbered cards, the largest band.
3. **Parallel features & data**: a lower band.
4. **Tech-stack footer**: slim.

### Main pipeline cards (number badge, icon, bold title, 2–3 one-line bullets)
1. **Driver Input**: Voice (browser mic, auto-stops on pause) · Typed text & quick chips · EN · HI · Hinglish
2. **Audio Front-End**: Decode → 16 kHz mono · Adaptive wind-noise suppression · Silence & length guards
3. **On-Device Speech Recognition**: hi-hinglish-swift Whisper (INT8 ONNX) · Hindi + English passes → N hypotheses · faster-whisper small fallback
 Nested sub-card: **Speaker ID**: CAM++ voice embedding → cosine match → auto driver profile
4. **Transcript Refinement**: Normalise + remove ASR hallucinations · Phonetic candidates (RapidFuzz) · Encoder-based rescoring → ranked transcripts
5. **Hybrid NLU Router**: Negation guard (negated commands never execute) · Rule-based local parser (compound commands) · Routes: local / BhashaDrive / Command LLM
6. **BhashaDrive Intent Engine** (AI CORE: widest card, accent colour). Use 4 stacked mini-boxes joined by small down-arrows:
 a. Multilingual MiniLM encoder · INT8 ONNX
 b. 3 trained heads: Intent (18 classes) · Negation · Implicit request
 c. Personal shortcut match → Dialog context (pending confirmation)
 d. Safety Policy: scope · ambiguity · negation · confidence · range checks
 Below them, a row of 5 small decision pills: Execute · Confirm · Clarify · Reject · Saved
 Nested sub-card along the bottom edge: **Command LLM fallback**: fine-tuned Gemma 3 270M · GGUF Q8 · llama.cpp (CPU) → up to 4 commands → 44-command allowlist check
7. **Cockpit State & Response**: runIntents() → car state (climate, fan, media, ambient light, windows, seats, nav, drive mode) · Animated SVG cockpit + spoken reply

Connectors in the main band (solid, dark, with arrowheads):
- 1→2 "audio clip" · 2→3 "clean PCM" · 3→4 "N hypotheses" · 4→5 "best transcript" · 5→6 "single climate / media / nav" · 6→7 "validated intents"
- 5→7, elbow connector routed above or below the cards: "compound / out-of-domain"
- 5→Command LLM sub-card, thin: "unsure / disagree"
- 7→1, thin curved feedback connector: "question asked → mic reopens"

### Premium Cloud Tier strip (dashed, grey-violet)
Three small cards: **Sarvam Saaras v4 STT (code-mix)** → **OpenAI LLM · strict JSON schema (same 44-command allowlist)** → **Server guards: spoken-yes for risky commands · rate limit · usage/cost meter**
Dashed connectors: card 1 ↑ to Sarvam "premium audio"; guards ↓ to card 7 "allowlisted actions"; strip ↓ to cards 3/5 "on failure → on-device fallback".

### Parallel features & data band
- **Driver Drowsiness Monitor (in-browser)**: Cabin camera → MediaPipe Face Landmarker → eye closure · PERCLOS · microsleeps · yawns · head pose → Alert / Tired / Drowsy → alarm + voice warning
- **BharatConnect: Driver ↔ Passenger Translation**: Tamil · Hindi · English: faster-whisper → Google Cloud Translation v3 → Google Cloud TTS → playback
- Three small cylinders: **Personal Shortcuts (SQLite)**, **Voiceprints (embeddings only)**, **Driver Profiles (browser storage)**. Dashed connector from card 6 to Personal Shortcuts: "confirmed shortcut, no retraining". Dashed connector from Speaker ID to Voiceprints.
- Dashed card **Offline Training & Evaluation (dev-time)**: Synthetic multilingual dataset → ONNX export + INT8 → train & calibrate heads · fine-tune Gemma 3 270M → GGUF. Dotted connector up to card 6: "model artifacts".

### Tech-stack footer (light grey strip, 6 groups, small but legible)
Frontend: React 19 · TypeScript · Vite · SVG · Web Audio · Web Speech | Backend: Python · FastAPI · Uvicorn · Pydantic · NumPy | On-Device AI: ONNX Runtime · Whisper · faster-whisper · MiniLM · sherpa-onnx · llama.cpp · MediaPipe | Training: PyTorch · Transformers · scikit-learn | Data: SQLite · JSON | Cloud (optional): Google Cloud Translation & TTS · Sarvam · OpenAI
Caption under the strip (tiny, grey): "Runs locally: one FastAPI server (127.0.0.1:8000) serves the cockpit and /api."

## Design system
- Background #FFFFFF. Text #1E2A3A (titles #0F1B2D). Minimum 9 pt for footer text, 10–11 pt for bullets, 12–13 pt bold for card titles, 26–28 pt for the title. Use one sans-serif family (e.g. Segoe UI or Inter).
- Layer fills (darker pastels) with matching 1 pt borders: input/audio #DCE8F7, speech #D5EFEC, router #FBE9C8, AI core #E6DDF7 with a 2 pt #5B3FA8 border, output #DDF0DA, parallel features #F7DDE2, cloud/offline #ECEAF2 with a dashed border.
- Corner radius about 0.12 in on every card; even spacing (about 0.15 in gutters); main-row cards share a top line and height.
- Connectors: 1.25 pt dark grey solid for the primary flow; 1 pt dashed for optional/cloud/fallback; 1 pt dotted for offline. Use elbow connectors to avoid crossing cards, and keep connector labels at 8–9 pt on a white label background.
- Number badges: small filled circles in the layer's darker tone, with white numerals.
- Do not rely on colour alone: the dashed/dotted line styles and the "OPTIONAL", "AI CORE" and "dev-time" tags carry the meaning too.
- No emojis, stock photos, decorative backgrounds, gradients, code snippets or source filenames.

## Accuracy rules
Use only the components, models, services and labels listed above. Do not add metrics, percentages, latency numbers, Docker/Kubernetes, vector databases, GPUs, real CAN-bus/vehicle integration, or any self-learning/retraining loop. The vehicle is simulated, and personalisation is explicit and user-confirmed, never model retraining.

## Quality assurance (do all of these before replying)
1. Re-open the file and confirm it exists and has exactly 1 slide.
2. Render it to PNG (or an equivalent visual check) and inspect it for clipped or overflowing text, overlapping shapes, connectors that miss their targets or cross cards, misalignment, uneven spacing, low contrast and text below 9 pt. Fix anything you find and re-render.
3. Check every card, connector and label against the lists above: 7 stages in this order, the same arrow relationships, and the same technology names.
4. Report the output path(s) and any limitation honestly. For example, if PNG export was not possible, say so; do not claim it succeeded.
