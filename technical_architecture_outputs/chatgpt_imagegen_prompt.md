Create ONE wide 16:9 landscape technical architecture infographic, about 1920×1080, for a hackathon technical judging round. If I attached a reference image, copy only its visual approach: numbered left-to-right stages, clear arrows, a distinct AI section and a tech-stack strip at the bottom. Do not copy its module names, topics or technologies. Render only the diagram: no surrounding explanation and no extra images. Spell every label exactly as written below.

TITLE (top-left, bold, dark navy): "BhashaDrive × Verna Smart Cockpit — Technical Architecture"
SUBTITLE (one line, grey): "Offline-first multilingual (English · Hindi · Hinglish) in-car voice control: on-device AI + safety policy, optional cloud tier"

LAYOUT: three horizontal bands plus a footer.
- Top band (thin, dashed border, labelled "OPTIONAL · subscription-gated"): Premium Cloud Tier.
- Middle band (largest, about 55% of the height): the main pipeline, 7 numbered rounded cards left to right, joined by solid dark arrows.
- Bottom band: parallel features and data stores.
- Footer strip: the grouped technology stack.

MAIN PIPELINE. Each card has a number badge, a small line icon, a bold title and 2–3 short bullet lines.

① Driver Input. Icon: microphone + keyboard. Pale blue.
 • Voice (browser mic, auto-stops on pause)
 • Typed text · quick chips
 • EN · HI · Hinglish
Arrow label to ②: "audio clip"

② Audio Front-End. Icon: waveform. Pale blue.
 • Decode → 16 kHz mono
 • Adaptive wind-noise suppression
 • Silence & length guards
Arrow label to ③: "clean PCM"

③ On-Device Speech Recognition. Icon: speech bubble with chip. Pale teal.
 • hi-hinglish-swift Whisper (INT8 ONNX)
 • Hindi + English decoding passes → N hypotheses
 • faster-whisper small = fallback
 A small nested sub-card at the bottom of ③: "Speaker ID: CAM++ voice embedding → cosine match → auto driver profile"
Arrow label to ④: "N hypotheses"

④ Transcript Refinement. Icon: magic wand / text-correct. Pale teal.
 • Normalise + remove ASR hallucinations
 • Phonetic candidate retrieval (RapidFuzz)
 • Encoder-based rescoring → ranked transcripts
Arrow label to ⑤: "best transcript"

⑤ Hybrid NLU Router. Icon: branching fork. Pale amber.
 • Negation guard ("don't…", "mat karo" never executes)
 • Rule-based local parser (compound commands)
 • Routes: local · BhashaDrive · Command LLM
From ⑤ draw three short labelled branch arrows: "compound / out-of-domain → straight to ⑦"; "single climate · media · nav → ⑥"; "unsure / disagree → Command LLM sub-card".

⑥ BhashaDrive Intent Engine. AI CORE: make this the largest card, with an accent border in deep violet and a pale lavender fill, and a small "AI CORE" tag. Draw a mini vertical flow inside:
 [Multilingual MiniLM encoder · INT8 ONNX]
 ↓
 [3 trained heads: Intent (18 classes) · Negation · Implicit request]
 ↓
 [Personal shortcut match → Dialog context]
 ↓
 [Safety Policy: scope · ambiguity · negation · confidence · range checks]
 ↓
 Decision chips in a row: "Execute" · "Confirm" · "Clarify" · "Reject" · "Saved"
 A nested sub-card on the lower edge of ⑥: "Command LLM fallback: fine-tuned Gemma 3 270M · GGUF Q8 · llama.cpp (CPU) → up to 4 commands → allowlist schema check (44 commands)"
Arrow label to ⑦: "validated intents"

⑦ Cockpit State & Response. Icon: car dashboard. Pale green.
 • runIntents() → Car state
 • Climate · fan · media · ambient light · windows · seats · nav · drive mode
 • Animated SVG cockpit + spoken reply
Draw a thin curved arrow from ⑦ back to ① labelled "question asked → mic reopens for yes / no".

TOP BAND: Premium Cloud Tier (dashed outlines, light grey-violet, cloud icon). Three small cards left to right:
 "Sarvam Saaras v4 STT (code-mix)" → "OpenAI LLM · strict JSON schema (same 44-command allowlist)" → "Server guards: spoken-yes for risky commands · rate limit · usage & cost meter"
Dashed arrows: from ① up to Sarvam ("premium audio"); from the guards card down to ⑦ ("allowlisted actions"). A dashed arrow from the top band down to ③/⑤ labelled "on failure → on-device fallback".

BOTTOM BAND, left to right:
1. Card "Driver Drowsiness Monitor (in-browser)", camera icon, soft rose:
 "Cabin camera → MediaPipe Face Landmarker → eye closure · PERCLOS · microsleeps · yawns · head pose → Alert / Tired / Drowsy → alarm + voice warning"
2. Card "BharatConnect: Driver ↔ Passenger Translation", globe icon, soft rose:
 "Tamil · Hindi · English: faster-whisper → Google Cloud Translation v3 → Google Cloud TTS → playback"
3. Three small cylinder (database) icons labelled: "Personal Shortcuts (SQLite)", "Voiceprints (embeddings only)", "Driver Profiles (browser storage)". Draw a thin dashed arrow from ⑥ to "Personal Shortcuts" labelled "confirmed shortcut, no retraining", and from Speaker ID to "Voiceprints".
4. A small dashed-outline card "Offline Training & Evaluation (dev-time)": "Synthetic multilingual dataset → ONNX export + INT8 → train & calibrate heads · fine-tune Gemma 3 270M → GGUF". A dotted arrow up to ⑥ labelled "model artifacts".

FOOTER TECH STACK. One slim strip with a light grey background, 6 labelled groups separated by thin dividers, small text:
 Frontend: React 19 · TypeScript · Vite · SVG · Web Audio · Web Speech
 Backend: Python · FastAPI · Uvicorn · Pydantic · NumPy
 On-Device AI: ONNX Runtime · Whisper · faster-whisper · MiniLM · sherpa-onnx · llama.cpp · MediaPipe
 Training: PyTorch · Transformers · scikit-learn
 Data: SQLite · JSON
 Cloud (optional): Google Cloud Translation & TTS · Sarvam · OpenAI
Under the strip, a tiny grey caption: "Runs locally: one FastAPI server (127.0.0.1:8000) serves the cockpit and /api."

VISUAL STYLE
- White background, a disciplined grid, generous gutters and equal card heights in the main row.
- Restrained pastel layer colours: blue = input/audio, teal = speech, amber = routing, violet = AI core, green = output, rose = parallel features, grey = cloud/offline. Keep all text dark (#1E2A3A or darker) for high contrast.
- Rounded cards (about 12 px radius), 1 px subtle borders, very soft shadows, simple consistent line icons.
- Line styles: solid dark arrows for the primary flow, dashed for optional/cloud/fallback paths, dotted for offline artifacts. Arrowheads must point in the direction the data flows.
- Text hierarchy: title > card titles (bold) > bullets (regular) > footer (smallest, still readable). No paragraphs inside cards.
- Avoid glows, heavy gradients, glossy 3D, decorative people or cars, random icons, pseudo-code and microtext.

ACCURACY RULES (strict)
- Do NOT add any component, model, API, database, cloud service, metric, percentage, latency number or feature that is not listed above.
- Do NOT add Kubernetes, Docker, vector databases, GPUs, Kafka or "real-time CAN bus". The car is simulated, and the system does not retrain itself.
- Do not duplicate cards, and do not change the arrow relationships described.
- Prioritise correctness and legibility over decoration; if space is tight, shorten bullets rather than drop a stage.
