# Hyundai Verna Smart Cockpit + BhashaDrive: Feature Audit

Audit date: 2026-10-25 · Repo state: `main` @ `fffed7e` · Read-only audit. No project file was changed; this report is the only file added.

Slide numbers below assume this generic 8-slide structure, because the actual deck was not provided:
**S1** Problem/context · **S2** Solution overview & demo · **S3** Personalisation (Teach Voice) · **S4** Driver Monitor · **S5** BharatConnect · **S6** Voice AI core & safety · **S7** Architecture, tech stack & results · **S8** Limitations & roadmap. Remap these if your deck differs.

---

## Deliverable 1: Executive summary

**What the project is.** It is a browser-based digital twin of a Hyundai Verna cockpit (React + SVG) that you drive by voice or text in English, Hindi and Hinglish, with partial Tamil and Bengali. It is backed by a local FastAPI service called **BhashaDrive**, which provides speech recognition, NLU, safety policy, voice-based driver identification and the BharatConnect translation pipeline. The backend serves the built frontend at `/` and its API at `/api` (`backend/bhashadrive/api/server.py:366-369`).

**Main components**
1. A frontend cockpit simulator (`frontend/src`, about 46 files).
2. A backend voice/NLU engine (`backend/bhashadrive`, about 105 files).
3. An in-browser computer-vision Driver Monitor (MediaPipe).
4. BharatConnect, which uses local Whisper ASR with Google Cloud Translation and Text-to-Speech.
5. An optional premium cloud tier (Sarvam STT + OpenAI/Groq LLM).
6. A training and evaluation toolchain with synthetic datasets and reports.

**Distinct features identified: 36** (master list in Deliverable 2).

**Most important findings**
1. **Driver Monitor is genuinely implemented and runs fully on the device.** It covers eye-closure duration (2 s), PERCLOS, microsleeps, yawns, per-driver calibration and a head-pose gate, with an alarm, a banner and a spoken warning. It does **not** do eye-gaze tracking, and it does **not** alarm when the face is missing or turned away.
2. **Teach Voice is real speaker enrollment.** It produces CAM++ 512-d voice embeddings through sherpa-onnx, and `backend/data/profiles/voiceprints.json` already holds samples for 2 profiles. The first voice command after ignition identifies the driver and switches profile, seat fit, AC, ambient colour and drive mode. It is **not** ASR training, and it does **not** learn from everyday use.
3. **Seat height is not a saved preference.** It is computed from the driver's body height with an anthropometric formula (`profiles.ts:193-207`) and shown in a simulated side view. No real seat is moved.
4. **The time-of-day greeting is a simple implementation.** It fires on ignition (a button or the voice command "gaadi start karo"), not on detecting a person entering the car. It never invites a reply, so "respond or ignore" is not a modelled behaviour.
5. **The BharatConnect code is complete, but it depends on Google Cloud** for translation and speech. No credentials are configured in this environment (`GOOGLE_CLOUD_PROJECT` is unset and there is no `.env`), so only the transcription stage would work here.
6. **Trained NLU artifacts and the command-LLM model are not on disk** (`backend/artifacts/` and `backend/models/llm/` are absent). As a result the backend currently falls back to a **regex mock NLU** (`server.py:75`), and the cockpit badge shows "(mock)". The published accuracy numbers come from synthetic data and models that are not present.
7. **Backend tests: 312 pass and 9 fail** (6 in `test_rescorer.py`, 3 in `test_snapping.py`), with 14 integration tests deselected. I ran the suite during this audit. The README says 6 failures. The frontend has no tests.
8. There is **no real vehicle integration.** `HyundaiAdapter` raises `NotImplementedError` everywhere, and every car function is simulated.

**Coverage.** I inventoried all 386 git-tracked files plus 59 untracked/ignored non-dependency files. I read every project-authored source file that implements a user-facing feature. I sampled training/evaluation modules and tests by structure and test names, not line by line (see Deliverable 8). Dependency folders (`node_modules`, `.venv`), model weights, the build output and the WAV samples were classified but not read.

---

## Deliverable 2: Master feature catalogue

| # | Feature (label in product, or *suggested*) | Area | Status |
|---|---|---|---|
| F1 | Driver Profiles: Add / switch / delete | Personalisation | Implemented and evidenced (browser-local) |
| F2 | Memory seat & steering fit (Seats view) | Personalisation | Prototype / simulated |
| F3 | Profile preference restore (AC, ambient colour, drive mode) | Personalisation | Implemented (in simulator) |
| F4 | **Teach Voice** (speaker enrollment) | Personalisation | Implemented and evidenced |
| F5 | *Voice-based driver recognition & auto profile switch* | Personalisation | Implemented, with conditions (server ASR only) |
| F6 | *Time-of-day welcome greeting* | Personalisation | Implemented (basic) |
| F7 | *Personal voice shortcuts* ("When I say 'chill mode'…") | Personalisation | Partially implemented (not persisted in current setup) |
| F8 | **Driver Monitor**: drowsiness detection | Safety | Implemented and evidenced (untested) |
| F9 | *Head-pose / attention gate* | Safety | Partially implemented (heuristic, no gaze) |
| F10 | **BharatConnect**: driver ↔ passenger voice translation | Communication | Implemented; cloud stages unconfigured here |
| F11 | Multilingual voice/text commands (EN/HI/Hinglish; partial TA/BN) | Voice AI | Implemented and evidenced |
| F12 | *Hybrid NLU routing* (local parser → backend → LLM → cloud) | Voice AI | Implemented |
| F13 | BhashaDrive V2 NLU (ONNX encoder + trained heads) | Voice AI | Code present; models absent → mock |
| F14 | *Safety policy*: negation refusal, confirmations, validation | Voice AI | Implemented and evidenced (tested) |
| F15 | Server speech recognition (hi-hinglish-swift / Whisper) + Web/Server switch | Voice AI | Implemented (swift model present) |
| F16 | *ASR transcript refinement* (phonetic + rescoring + hypothesis voting) | Voice AI | Partially implemented (9 failing tests) |
| F17 | Command LLM fallback (fine-tuned Gemma 3 270M) | Voice AI | Present but unavailable (model file absent) |
| F18 | Premium Voice AI tier (Sarvam + OpenAI/Groq) | Voice AI | Implemented, mock-tested; keys absent |
| F19 | Wind suppression + Wind A/B test | Audio | Implemented (synthetic validation only) |
| F20 | Spoken replies & Indian voice selection | Voice UX | Implemented |
| F21 | *Multi-turn follow-ups & auto re-open mic* | Voice UX | Implemented |
| F22 | Guided Demo mode | Presentation | Implemented |
| F23 | Conversation log | Voice UX | Implemented |
| F24 | Drawn SVG cockpit, 3 scenes, 4 camera views | Simulator | Implemented |
| F25 | Climate control + airflow visualisation + vent aiming | Simulator | Prototype / simulated |
| F26 | Generative in-car music, FM radio, volume, EQ, ducking | Simulator | Prototype / simulated |
| F27 | Ambient lighting: 64 colours, 7 effects, 6 moods | Simulator | Prototype / simulated |
| F28 | Driving simulation: ignition, gears, cruise, auto-hold, indicators, wipers, windows… | Simulator | Prototype / simulated |
| F29 | Instrument cluster (incl. a drawn Blind View Monitor) | Simulator | Prototype / simulated |
| F30 | Navigation & phone calls | Simulator | Prototype / simulated (no real routing or calls) |
| F31 | Vehicle status questions | Simulator | Implemented over simulated state |
| F32 | Hyundai OEM vehicle adapter | Integration | Planned / documented only |
| F33 | Training & evaluation toolchain + reports | Engineering | Present; outputs not reproducible from repo alone |
| F34 | Backend test console, API docs, CLI, connectivity simulation | Engineering | Implemented |
| F35 | One-command launcher; backend serves cockpit | Engineering | Implemented |
| F36 | *Privacy-by-design data handling* | Cross-cutting | Implemented (code-level evidence) |

---

## Deliverable 3: Detailed feature descriptions

Each entry uses the following fields: **Desc** (plain-English description) · **Value** (user problem and value) · **Journey** · **I/O** (inputs and outputs) · **Impl** (technical implementation) · **Evidence** · **Status** · **Limits** (dependencies and limitations) · **Pitch** (presentation relevance) · **Slide** · **Demo** (demonstration material).

### A. Teach Voice & personalisation (reported feature A)

**F1 Driver Profiles**
- **Desc:** Create named drivers with height, weight, preferred AC temperature, drive mode and ambient colour. You can switch between them or delete them. A "Default" guest profile always exists.
- **Value:** A shared family car remembers each driver.
- **Journey:** Top bar ▸ ⌄ next to Teach Voice ▸ "Add New Profile" ▸ form ▸ the profile is created and switched to. The dropdown lists profiles with height/build and voice-sample count; the 🗑 button deletes a profile after a confirm dialog and also deletes its voiceprint on the server.
- **I/O:** form fields → a `Profile` object saved in `localStorage["bhashadrive-profiles"]`.
- **Impl:** An in-memory registry plus a `useSyncExternalStore` hook. The ID is the lower-cased name. Accent colours come from a palette. Build and recline are derived from height. You can also switch by voice: "Priya ka profile lagao", "main Meera hoon", "profile badlo".
- **Evidence:** `frontend/src/lib/profiles.ts:33-160`; `components/AddProfileModal.tsx:22-57`; `App.tsx:719-818`; `nlu/parser.ts:215-226,465-470`.
- **Status:** Implemented and evidenced. Profiles live in the browser only and are not synced to the backend.
- **Limits:** Per-browser storage. The name doubles as the ID, so two "Priya"s are impossible. `AddProfileModal` is rendered twice (`App.tsx:886-899`).
- **Pitch:** "One car, many drivers." **Slide:** S3. **Demo:** Add Profile modal and profile dropdown screenshot.

**F2 Memory seat & steering fit**
- **Desc:** When a profile is active, the seat height, seat slide, recline, wheel tilt and wheel reach are computed for that driver's body height and animated in a side-view "Seats" mode.
- **Value:** Shorter drivers sit higher and further forward without fiddling with controls.
- **Journey:** Switch profile (by touch, voice or voice recognition) ▸ press **Seats** view (or Z) ▸ the mannequin, seat and wheel move. The reply says "Seat 41 mm up and 120 mm back…".
- **I/O:** `heightCm`, `reclineDeg` → `Fit{liftMm, slideMm, reclineDeg, wheelTiltDeg, wheelReachMm}`.
- **Impl:** Body segments are modelled as fractions of standing height. Leg reach is solved geometrically against the pedal and hip points. Travel is clamped to 70 mm lift, 260 mm slide and 60 mm wheel reach. Seats refuse to move above 5 km/h.
- **Evidence:** `lib/profiles.ts:162-207`; `components/SeatView.tsx:1-4,130-169`; `state/car.ts:370-390` (the speed > 5 guard is at line 375).
- **Status:** Prototype / simulated. The seat position is **derived from height, not stored as a preference**, and no physical seat is actuated.
- **Limits:** You cannot set or save a personal seat height directly, and there is no voice command for seat height. Only seat *ventilation* has voice commands (`parser.ts:604-611`).
- **Pitch:** A strong visual: the seat rising and the wheel tilting when the driver is recognised. Say "seat fitted to your height", not "your saved seat height". **Slide:** S3. **Demo:** Seats view before and after a profile switch.

**F3 Profile preference restore**
- **Desc:** Switching profile applies that driver's AC temperature, ambient colour and drive mode.
- **Impl / Evidence:** `state/car.ts:386-388`.
- **I/O:** profile ID → updated `CarState.climate.temp`, `ambient.color`, `driveMode`, plus a spoken and visible summary.
- **Status:** Implemented in the simulator only.
- **Limits:** Preferences are set once at creation. Nothing updates them from later use.
- **Slide:** S3. **Demo:** a toast plus the cluster colour changing with the drive mode.

**F4 Teach Voice (speaker enrollment)**
- **Desc:** You record a short sentence for the active driver. The car stores a numeric voiceprint (not the audio) so it can recognise that driver later.
- **Value:** It enables hands-free driver identification.
- **Journey:**
  1. Pick the driver in the ⌄ menu and press **Teach Voice**.
  2. A toast reads "Listening to <name>". Speak; recording stops on a 1.4 s pause, after 9 s, or on a second tap.
  3. The backend replies "Voice learned for X. Sample N saved." The badge shows the sample count.
  4. If the Default profile is active, the Add Profile modal opens instead.
- **I/O:** WebM audio → POST `/api/speaker/{profile}` → `{samples}`.
- **Impl:**
  - Audio is preprocessed, including the wind filter. Silent 30 ms frames are dropped.
  - At least 1.5 s of speech is required.
  - The CAM++ model (`3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`) runs through `sherpa_onnx.SpeakerEmbeddingExtractor` and produces a unit-normalised 512-d embedding.
  - An outlier check rejects a new sample whose cosine similarity to the profile mean is below 0.35.
  - The newest 6 samples are kept, with an atomic write to `data/profiles/voiceprints.json`.
  - The spoken words are **not executed**.
- **Evidence:** `App.tsx:505-582`; `server.py:267-302`; `audio/speaker_id.py:27-97,130-134`; `config.py:162-175`. The model file exists at `backend/models/speaker/`. `voiceprints.json` holds samples for 2 profiles, which shows the feature has been used on this machine. Tests: `tests/test_speaker_id.py` (5 tests, passing).
- **Status:** Implemented and evidenced.
- **Limits:** This is speaker enrollment, not ASR personalisation (the README states this explicitly). The UI says "need 2s+" while the code requires 1.5 s of voiced speech. There is no liveness or anti-spoofing check.
- **Pitch:** "Teach the car your voice in one sentence; only a 512-number voiceprint is stored." **Slide:** S3. **Demo:** the Teach Voice button in its recording state, the "Voice Learned" toast, and the dropdown with sample counts.

**F5 Voice-based driver recognition & auto profile switch**
- **Desc:** On the first spoken command after ignition, the car checks who is speaking. If it is an enrolled driver, it switches to their profile (seat, AC, lights, drive mode) and greets them by name, then runs the command.
- **Journey:** Press the mic and say "AC 22 pe kar do" ▸ the backend transcribes the audio and identifies the voice ▸ the car replies "Namaste Priya, seat aapke hisaab se set. AC 22°C…".
  - If the voice is unknown, the car switches to Default and says "Voice not recognized…".
  - If the voice matches the current driver, a "Voice recognized" toast appears.
  - Recognition runs once per ignition cycle and is re-armed when the ignition goes OFF (`App.tsx:380`).
- **I/O:** the command audio → `speaker:{profile, score, margin}` returned with the transcript.
- **Impl:**
  - The utterance is embedded and compared to each profile's mean voiceprint.
  - It is accepted if the best cosine score is ≥ 0.35 **and** the margin to the second-best is ≥ 0.04. At least 0.6 s of speech is required.
  - Greetings exist in English, Hindi, Tamil and Bengali.
  - Seats don't move above 5 km/h.
  - When any voice is enrolled, the app forces server ASR (`App.tsx:409`).
- **Evidence:** `App.tsx:254-303,492`; `server.py:217-224,238-259`; `speaker_id.py:104-128`; `config.py:170-173`.
- **Status:** Implemented, with conditions. It works only through the server-ASR path or the premium path.
- **Limits:**
  - No accuracy or false-accept evaluation exists in the repo.
  - The thresholds are permissive.
  - If server ASR is unavailable and the browser recogniser is used, no speaker is sent, so the first voice command switches the car to **Default** with "Voice not recognized" (`App.tsx:286-301`).
  - It does not re-identify on later commands, so a passenger's voice is not distinguished from the driver's.
- **Pitch:** The headline personalisation moment. Present it as "speaker verification among enrolled drivers (prototype)", not as secure authentication. **Slide:** S3. **Demo:** a live demo with two enrolled voices, plus the "Recognized" toast.

**F6 Time-of-day welcome greeting**
- **Desc:** Starting the car makes it say "Good morning / afternoon / evening!".
- **Journey:**
  - **Touch:** press ENGINE START STOP into ACC or ON. The car speaks and shows "Good morning!" (`App.tsx:383-402`).
  - **Voice:** "Gaadi start karo" gets the reply "Good morning! Engine started." (`state/car.ts:463-477`).
  - The greeting is a statement: the mic stays closed (`App.tsx:398`). The driver can talk next or ignore it.
- **Impl:** `getTimeGreeting()` uses the browser clock. 04:00–11:59 is morning, 12:00–16:59 afternoon, anything else evening (`state/car.ts:92-97`). "Namaste Verna" triggers a generic `greet` reply that is not time-based (`car.ts:605-606`).
- **Status:** Implemented (basic).
- **Limits:**
  - It is triggered by ignition, not by detecting that someone entered the car.
  - The time greeting doesn't include the driver's name; the name greeting comes from F5 on the first voice command.
  - 00:00–03:59 says "Good evening".
  - The Hindi variant is the same English phrase.
  - There is no dialogue that expects a reply.
- **Slide:** S3. **Demo:** press START in the cockpit and capture the greeting bubble.

**F7 Personal voice shortcuts (backend "teaching")**
- **Desc:** The driver defines a phrase that triggers an action, for example "Jab main 'chill mode' bolun, AC 22 pe set kar dena". The car asks for confirmation, then saves it. The driver can later rename, alias, delete or list shortcuts by voice.
- **Impl:**
  - Regex templates in English, Hinglish and Devanagari find the trigger and the action. The action clause goes through the intent model and validation.
  - Saving needs an explicit "haan".
  - Storage is SQLite (`personal_commands`, `command_phrases`, and an opt-in `corrections` table).
  - Matching uses cosine similarity on embeddings with calibrated thresholds.
  - Negated and quoted (meta) mentions are not executed.
  - The cockpit shows the backend's "saved" reply.
- **Evidence:** `personalization/teaching.py:1-25`; `personalization/store.py:25-48,95-196`; `personalization/matcher.py:24-85`; `pipeline_v2.py`; `README.md` (root) and `backend/README.md` dialogue; `tests/test_personalization.py` (19 tests).
- **Status:** Partially implemented in the current setup. With no trained artifacts, the server uses `make_pipeline()`, whose store is `":memory:"` (`tests/fakes_v2.py:115-120`), so **shortcuts are lost on restart**.
- **Limits:**
  - Shortcuts belong to one backend profile (`BD_PROFILE_ID`, or "test-user" in mock mode), not to the cockpit's driver profiles.
  - One action per shortcut.
  - **This is not autonomous learning.** Nothing in the code learns from everyday use; corrections are an opt-in audit log (`BD_STORE_CORRECTIONS`).
- **Slide:** S3 (as "teach your own commands") or S6. **Demo:** the chat transcript of the chill-mode dialogue.

### B. Driver Monitor (reported feature B)

**F8 Driver Monitor: drowsiness detection**
- **Desc:** A cabin-facing camera watches the driver's face. If the eyes stay closed too long, or closures become frequent, a loud alarm sounds, a red "WAKE UP!" banner appears and a voice tells the driver to take a break.
- **Value:** It addresses drowsy-driving risk on long Indian highway drives.
- **Journey:**
  1. Press **Driver Monitor** in the top bar and grant the camera permission.
  2. A panel shows the mirrored video with an eye/mouth overlay.
  3. The monitor calibrates for 8 s, then shows one of: Alert, Tired or Drowsy.
  4. Live metrics: eye state with a closure timer, PERCLOS %, blinks/min, microsleeps per 30 s, yawns per 2 min, tracking %, and pose.
  5. Controls: Recalibrate, Minimise, Close.
- **I/O:** a webcam frame at 640×480 → `DriverStatus{state, reason, metrics}` → alarm, banner and TTS.
- **Impl:**
  - MediaPipe `FaceLandmarker` runs in VIDEO mode with blendshapes, using the GPU delegate with a CPU fallback. The assets are bundled locally (`public/mediapipe/*.task, *.wasm`).
  - Eye closure is the mean of `eyeBlinkLeft/Right`. The closed threshold is adaptive: the resting level plus 0.35, with hysteresis.
  - **Rules, in order:**
    - Eyes closed ≥ **2 s** → drowsy.
    - PERCLOS ≥ 30% over a 30 s window (needs at least 10 s observed; exits at ≤ 25%) → drowsy if there was a recent long closure, otherwise tired.
    - 3 microsleeps (closures ≥ 1.2 s) within 30 s, with one in the last 8 s → drowsy.
    - PERCLOS ≥ 15% → tired.
    - 2 microsleeps → tired.
    - 2 yawns (jawOpen ≥ 0.55 for ≥ 1.2 s) in 2 min → tired.
  - The drowsy state is held for 4 s so the alarm doesn't flicker.
  - **Alerts:**
    - Drowsy: a synthesised alarm (`carAudio.alarm`), the banner, and the spoken warning repeated every 6 s.
    - Tired: a spoken hint at most every 2 min.
  - Processing runs on every new video frame through `requestAnimationFrame`, only while the panel is open.
- **Evidence:** `lib/drowsiness.ts:48-71` (thresholds), `126-165` (update/hold), `172-190` (calibration), `192-244` (decision rules), `257-284` (eyes/yawn); `components/DriverMonitor.tsx:79-91` (model load), `143-171` (frame loop), `173-189` (camera and errors), `209-227` (alerts), `237-243` (banner), `286-287` ("Video is processed on this device only"); `lib/audio.ts:548` (alarm); `App.tsx:822-823,880`.
- **Status:** Implemented and evidenced in code. There are **no automated tests** and no measured accuracy data.
- **Limits:**
  - No alarm when the face is missing or the head is turned away; the panel only shows "Driver not visible" or "Unable to assess".
  - Spoken warnings ignore the "Voice replies" mute setting.
  - It depends on a webcam and lighting; night IR is not handled.
  - Frames are not stored or uploaded (by code inspection: nothing writes or transmits frames).
  - It is assistive, not certified.
- **Pitch:** A very demo-able feature that runs fully on the device. Use the exact numbers: 2 s, PERCLOS 30 s, 8 s calibration. **Slide:** S4. **Demo:** live camera with eyes closed for 2 s, the WAKE UP banner, and the metrics panel screenshot.

**F9 Head-pose / attention gate**
- **Desc:** The monitor estimates yaw, pitch and roll from face landmarks. If the head is turned too far it stops judging and shows "Turn your face toward the road" or "Keep your face level with the road".
- **Impl:** A geometric heuristic using the nose position relative to the eye midpoint and the mouth (`DriverMonitor.tsx:42-61`). It treats a frame as unusable when |yaw| > 0.58 or |pitch| > 0.62 (`drowsiness.ts:167-170,246-251`). The pose label reads centred, turned or tilted.
- **Status:** Partially implemented. This is **head pose, not eye gaze**: there is no iris tracking and no "eyes on road" decision. Looking away triggers no warning.
- **Slide:** S4, as a sub-bullet only. **Demo:** the pose label in the panel.

### C. BharatConnect (reported feature C)

**F10 BharatConnect: two-way driver ↔ passenger voice translation**
- **Desc:** The driver and the passenger each pick their language and take turns pressing their own talk button. Each sentence is transcribed, translated and spoken aloud in the other person's language, with both texts shown on screen.
- **Value:** It solves the language barrier between, for example, a Tamil-speaking driver and a Hindi-speaking passenger.
- **Journey:**
  1. Top bar ▸ **BharatConnect**. The defaults are Driver = Tamil and Passenger = Hindi (`BharatConnect.tsx:27`).
  2. Tap Driver 🎤 and speak. Recording ends on a 0.9 s pause, a second tap, or 15 s.
  3. The status moves through Transcribing → Translating → Generating speech → Playing.
  4. The turn card shows the original text, the translation and per-stage timings.
  5. The passenger replies the same way. Failed turns get **Retry** from the failed stage, played turns can be **Replayed**, and **End session** clears the history.
  6. Both mics are locked while a turn is processing or playing.
- **I/O:** speech audio plus the selected source and target languages → transcript, translated text, and MP3 audio.
- **Impl:**
  - **Supported languages:** Tamil, Hindi and English, in any direction (`bharat/languages.py:20-24`).
  - **ASR:** local **faster-whisper `small`** (the model is cached on this machine), decoding in the speaker's chosen language with no auto-detect (`bharat/speech.py:43-57`).
  - **Translation:** Google Cloud Translation v3 `translate_text`, with a 256-entry LRU cache (`bharat/translation.py:41-71`).
  - **TTS:** Google Cloud Text-to-Speech returning MP3. The best voice tier for the language is chosen from the live voice list (Neural2 > Wavenet > Standard) and cached (`bharat/tts.py:18,41-83`).
  - **API routes:** `/bharat/status`, `/warmup`, `/transcribe`, `/translate`, `/speak` (`bharat/api.py:52-109`).
  - **Client orchestration:** stage-wise requests with timeouts, timing measurement, and autoplay-blocked handling (`lib/bharat.ts:106-158`).
  - **Errors:** each failure carries its stage, a message and a retryable flag (`bharat/errors.py`). The 10 MB upload limit, the 30 s audio limit and the 1,000-character limit are enforced.
  - **Privacy:** the temp recording is deleted and conversation text is not logged.
- **Evidence:** the files above; `components/BharatConnect.tsx:24-131`; `App.tsx:824-825,882`; `tests/test_bharat.py` (5 tests with fake Google clients, passing).
- **Status:** Implemented as an integrated end-to-end flow. **Cloud stages are not configured in this environment** (`GOOGLE_CLOUD_PROJECT`/credentials unset, no `.env`). The panel would show "Translation is not set up on the server…", and turns would stop at the translating stage. A successful live run cannot be verified from the repo.
- **Limits:**
  - Translation and speech need internet access and Google Cloud. Only the speech-to-text stage is offline.
  - Speakers are told apart by **which button is pressed**, not by voice.
  - Whisper `small` is weak on Tamil (the README recommends `large-v3-turbo`, a 1.6 GB download).
  - Adding a language also requires frontend type and fallback edits (`lib/bharat.ts:8`), despite the "one row" claim.
  - There is no transliteration and no text input.
- **Pitch:** Tells the India-specific story; show a Tamil ↔ Hindi turn. **Slide:** S5. **Demo:** a screenshot of a completed turn card with timings, plus the pipeline diagram (mic → Whisper → Cloud Translation → Cloud TTS → speaker).

### D. Voice AI core

**F11 Multilingual voice/text commands**
- **Desc:** You talk to or type at the car in English, Hindi (Devanagari), Romanized Hindi or Hinglish, and it controls more than 45 cockpit functions. Compound commands work, for example "Gear D mein daalo aur right indicator do".
- **Impl:**
  - A rule/lexicon parser of 790 lines (`nlu/parser.ts`) splits clauses on aur/and/phir. It normalises text, folds nuktas, fuzzy-matches colours and handles follow-up context.
  - The intent union is in `types.ts:23-70`.
  - Language detection covers Tamil, Bengali and Hindi script plus Tanglish/Banglish keywords (`parser.ts:400-424`), with reply templates in ta/bn (`state/car.ts:623-678`).
- **Status:** Implemented and evidenced. Tamil and Bengali are **partial**: the speech-language toggle offers only EN/हिं, and there are few Tamil/Bengali command words.
- **Slide:** S2/S6. **Demo:** the README command table and a demo-mode recording.

**F12 Hybrid NLU routing**
- **Desc:** Every command is routed to the fastest reliable interpreter, falling back to the next if it is unsure.
- **Impl (`App.tsx:94-140`):**
  1. A negated command is never executed; the backend still sees it.
  2. Compound or out-of-domain commands go to the local parser.
  3. Single climate, fan, volume, media or navigation commands go to backend `/api/text`. If the backend and the parser agree, the local intent (with its richer slots) is kept; if they disagree, the command LLM decides.
  4. Backend questions (confirmations, clarifications) are passed through to the driver.
  5. If the backend is offline, the app stays local-only and re-checks the backend every 15 s (`App.tsx:350-371`).
  6. Each reply is tagged with the engine that produced it.
- **Status:** Implemented. **Slide:** S6/S7. **Demo:** the conversation log with engine tags.

**F13 BhashaDrive V2 NLU**
- **Desc:** A compact on-device intent classifier for 18 whitelisted vehicle intents, with negation and "implicit request" heads.
- **Impl:** A multilingual MiniLM/e5 sentence encoder exported to INT8 ONNX, with linear heads (`nlu/intent_model.py`, `nlu/encoder.py`, `nlu/taxonomy.py`).
- **Status:** **Code present; trained artifacts absent** (`backend/artifacts/` missing). The server therefore falls back to `FakeIntentModel`, a regex model (`server.py:66-82`; `tests/fakes_v2.py`).
- **Measured results (synthetic text):** fine-tuned MiniLM reaches 0.871 accuracy on the test set (n=1314) and 0.844 on held-out unseen sentences (n=141), with median latency of about 4.5 ms (`reports/nlu_eval_v2.md`). Baselines: keyword rules 0.533, TF-IDF 0.710.
- **Slide:** S7. Label the numbers "synthetic data".

**F14 Safety policy**
- **Desc:** The assistant never executes negated commands. It asks before acting on hints like "Garmi lag rahi hai", asks when a command is ambiguous, rejects unsupported or out-of-range requests, and refuses unsafe simulator actions while moving (park/reverse, seat moves).
- **Evidence:** `App.tsx:78,95-100`; `policy/policy_v2.py:28-127`; `config.py:179-190` (16–30 °C, fan 0–7, volume 0–30); `state/car.ts:375,501-505`; the premium tier's server-side confirmations (`assistant/service.py:22-29`). Tests: `test_policy.py`, `test_v2_core.py`, `test_anti_hallucination_*`.
- **Status:** Implemented and evidenced. **Slide:** S6.

**F15 Server speech recognition**
- **Desc:** The browser records the command, stopping on a pause, and the backend transcribes it locally.
- **Impl:**
  - `HybridASR` loads `hi-hinglish-swift` (a Whisper-base fine-tune in INT8 ONNX via sherpa-onnx, run in Hindi and English decoding passes). If that fails to load, it uses faster-whisper.
  - Optional cloud Whisper (OpenAI/Groq) is used only if `BD_HYBRID_CLOUD_ASR=true` (`audio/hybrid_asr.py:17-22,45-60`).
  - The Settings switch "Speech recogniser Web/Server" selects Chrome's Web Speech API instead. If Chrome reports a network error, the app automatically switches back to server ASR (`App.tsx:584-593`).
- **Status:** Implemented. The swift model is present in `backend/models/asr/`.
- **Contradiction:** The README says failed transcripts are "retried on Whisper small". The code keeps only the first engine that loads; no retry per utterance was found.
- **Measured results:** ASR WER is from synthetic TTS only (155 clips; the "apex" model has WER 0.32 clean and e2e intent accuracy 0.77; `reports/asr_eval.json`). The apex model is not present locally.
- **Slide:** S6/S7.

**F16 ASR transcript refinement**
- **Desc:** The system fixes near-miss words such as "bloer" → "blower" and picks the best of several transcript hypotheses.
- **Impl:** phonetic cluster retrieval plus MiniLM self-attention rescoring (`nlu/rescorer.py`, `pipeline_v2.py:128-140`). The cockpit votes across hypotheses with its own parser (`App.tsx:86-92`).
- **Status:** Partially implemented. 6 rescorer tests and 3 snapping tests **fail** (run on 2026-10-25).
- **Slide:** S7 at most, as an "in progress" item.

**F17 Command LLM fallback**
- **Desc:** A tiny fine-tuned Gemma 3 270M (GGUF, llama.cpp, CPU) turns hard sentences into several cockpit commands (`/api/interpret`).
- **Evidence:** `nlu/command_llm.py`, `nlu/cockpit_commands.py`, `training/train_command_llm.py`, `training/command_llm_data.py` (10,228 training lines). `reports/command_llm_eval.json`: exact match 0.705 vs 0.628 for the rule parser, median latency 0.12 s.
- **Status:** Present but unavailable. `models/llm/cockpit-gemma-270m.q8_0.gguf` is absent, so `llm_ready` is false and routing skips it.
- **Slide:** S7/S8, as "trained; not in the demo build".

**F18 Premium Voice AI tier**
- **Desc:** A subscriber tier that sends speech to Sarvam "Saaras v4" (code-mix STT) and the transcript, plus a small car-state snapshot, to a cloud LLM. The LLM returns allowlisted commands under a strict JSON schema.
- **Safety and metering:**
  - Consequential commands (gear, ignition off, unlocking, calls, disabling LKA, enabling cruise) always wait for a spoken "yes", enforced by the server.
  - 20 requests/min rate limit, one request in flight, and confidence below 0.5 → "please repeat".
  - The usage and cost log stores no content.
  - Entitlement comes from a bearer token in a file, or a dev-only loopback tier switch.
  - If the cloud fails, it falls back to on-device recognition and parsing.
- **Evidence:** `assistant/service.py`, `assistant/providers.py:91-340`, `assistant/entitlements.py`, `assistant/api.py`; `App.tsx:142-166,469-487,827-862`; `config.py:104-141`; `tests/test_assistant.py` (23 tests with mocked HTTP, passing).
- **Status:** Implemented and mock-tested. **API keys are absent and `BD_DEV_TIER_SWITCH` is off**, so the Free/Premium pill is hidden and the tier is inactive. There is no payment integration (`entitlements.py:8`).
- **Caution:** The configured model IDs (`gpt-6.1-sol`, `qwen/qwen3.8-27b` via Groq) were not verified against providers.
- **Slide:** S8 (business model / roadmap).

### E. Audio, voice UX and demo tooling

**F19 Wind suppression and Wind A/B test**
- **Impl:** An STFT-based adaptive low-frequency attenuation scaled by an estimated wind probability (`audio/wind_suppression.py:91-247`). It is applied to all server-side audio.
- **Settings UI:** on/off, strength 0–1, max reduction 0–36 dB, browser noise suppression, and browser AGC (`SettingsMenu.tsx:114-140`).
- **A/B test:** `POST /api/wind-test` mixes synthetic wind at −6 to +12 dB and returns three transcripts: clean, noisy unfiltered, and noisy filtered (`server.py:175-215`; `App.tsx:428-457`).
- **Status:** Implemented. Validation uses synthetic signals only (`test_wind_suppression.py`, 4 tests).
- **Slide:** S6/S7 ("robust in a noisy cabin"). **Demo:** a screenshot of the Wind test result.

**F20 Spoken replies and voice selection**
- **Impl:** Web Speech synthesis, preferring Indian or neural voices. The female/male/specific voice choice is stored in `localStorage`, with a "Test Voice" preview. Music ducks while the car speaks. Toggle: Settings ▸ Voice replies (`lib/speech.ts:93-329`).
- **Status:** Implemented.

**F21 Multi-turn follow-ups**
- **Behaviour:** Follow-ups like "aur thoda" reuse the last adjustment (`parser.ts:762-765`). When the car asks a question, the mic reopens automatically (`App.tsx:321-325`). Suggestion chips adapt to the context (`lib/intents.ts`). Backend pending proposals expire after 60 s.
- **Status:** Implemented.

**F22 Guided Demo**
- **Behaviour:** The **Demo** button plays 16 scripted Hinglish commands and auto-answers "Haan" to confirmations (`App.tsx:30-47,675-687`).
- **Status:** Implemented. This is ideal for a live judging fallback.

**F23 Conversation log**
- **Behaviour:** Settings ▸ Conversation log shows the transcript with parsed intents and engine tags (`components/Transcript.tsx`).
- **Status:** Implemented.

### F. Cockpit simulator (all prototype / simulated)

- **F24 Drawn cockpit and views:** a full SVG Verna interior traced from a photo (`drawn/*`), Live/Night/Day scenes (`scenes.ts`), and Cabin/Dashboard/Screen/Seats camera views (`App.tsx:23`). Keyboard shortcuts: Space = talk, Z = view, / = type.
- **F25 Climate:** 16–30 °C, fan levels, AUTO, recirculation, defrost and seat ventilation (0–3). Air streams are coloured by temperature, and the vents can be aimed by dragging (`components/Airflow.tsx`, `lib/ventAim.ts`, `drawn/ClimatePanel.tsx`).
- **F26 Media:** music synthesised live with Web Audio in 5 genres (no audio files), FM radio, volume/mute, EQ bars, a horn and chimes (`lib/audio.ts`).
- **F27 Ambient lighting:** 10 named colours, a 64-colour palette, 7 effects (static, breathe, flow, music-sync, drive-mode, rainbow, dual) and 6 moods (`lib/ambient.ts`, `lib/ambientFx.ts`, `drawn/Ambient.tsx`).
- **F28 Driving simulation:**
  - Ignition OFF/ACC/ON, with auto-wake to ACC when a command needs power (`car.ts:672-690`).
  - An engine sound model, revving, keyboard throttle and brake, and P-R-N-D gears refused while rolling.
  - Eco/Normal/Sport drive modes, Smart Cruise (cancelled on braking), Auto Hold, and indicators/hazards with relay ticks.
  - Wipers with rain, windows, sunroof, headlights, cabin light, door lock and lane-keep toggle (`lib/engine.ts`, `state/car.ts`).
- **F29 Cluster:** speedometer/tachometer, gear ratio, fuel and coolant, and trip/tyre pages. The **Blind View Monitor** is a drawn illustration, not a camera (`drawn/Cluster.tsx:72-75`). Tyre pressures are hard-coded (`car.ts:86`).
- **F30 Navigation and phone:** a stylised fake city map ("Not real geography", `MapView.tsx:1`), fixed places (home, office, airport, petrol, hospital, EV charger) and fixed contacts (`parser.ts:205-233`). No real routing or calling.
- **F31 Queries:** temperature, fuel, current song, time, speed and tyres, answered from the simulated state (`car.ts:576-604`).
- **Slide:** S2 (one collage), as "a full digital-twin cockpit to demonstrate the voice AI". Don't present these as vehicle integrations.

### G. Integration and engineering

- **F32 Hyundai OEM adapter:** a documented boundary for climate, media and navigation services through VHAL/SOME-IP. Every method raises `NotImplementedError` ("THIS IS NOT CONNECTED TO ANY VEHICLE", `vehicle/hyundai_adapter.py:1-15`). `MockVehicleAdapter` is used instead. **Status:** Planned only. **Slide:** S8.
- **F33 Training and evaluation toolchain:**
  - Dataset builders and data: 6,266 training / 1,314 test / 141 held-out sentences in `data/nlu_v2`.
  - ONNX INT8 export, head training, encoder fine-tuning, and command-LLM data and training.
  - Evaluators for NLU, ASR, personalisation and the premium tier.
  - 155 synthetic TTS WAVs (`samples/`), a real-recording script (`scripts/record_eval_set.py`), and `scripts/reproduce_v2.py`.
  - 28 reports, including Qwen-3B V1 iterations v1–v8.
  - **Status:** Present. The outputs (artifacts) are not in the repo. **Slide:** S7.
- **F34 Developer surfaces:** the `/console` test page (text and audio tests, state, reset, and a **simulated online/offline connectivity toggle**, used only in the console via `/connectivity`); `/docs` OpenAPI; and the CLI `text|file|mic|chat|serve` (`cli.py:94-99`).
- **F35 One-command start:** `start.ps1` and `start.sh` create the venv, build the frontend and serve everything on :8000.
- **F36 Privacy by design:**
  - Uploaded audio goes to temp directories that are deleted after use. `BD_STORE_AUDIO` defaults to false.
  - Only voice embeddings are stored, and `forget` deletes them.
  - BharatConnect text is not logged.
  - Premium usage logs hold no content, and API keys stay on the server (with a test: `test_keys_never_reach_clients_or_the_frontend`).
  - Camera frames stay in the browser.
  - Profiles and usage data are git-ignored (`backend/.gitignore`).
  - **Slide:** S7/S8.

---

## Deliverable 4: Coverage and evidence matrix

| Feature | Status | Main evidence | User-facing value | Related | Slide |
|---|---|---|---|---|---|
| F1 Profiles | Implemented | `lib/profiles.ts`, `AddProfileModal.tsx` | Multi-driver car | F2-F5 | S3 |
| F2 Seat fit | Simulated | `profiles.ts:193`, `SeatView.tsx` | Automatic ergonomic seat | F1,F5 | S3 |
| F3 Prefs restore | Implemented (sim) | `car.ts:370-390` | Comfort on switch | F1,F5 | S3 |
| F4 Teach Voice | Implemented | `App.tsx:505`, `speaker_id.py`, `voiceprints.json` | One-sentence enrollment | F5 | S3 |
| F5 Voice ID | Implemented (conditional) | `App.tsx:255-303`, `speaker_id.py:104` | Hands-free personalisation | F1-F4 | S3 |
| F6 Greeting | Implemented (basic) | `car.ts:92`, `App.tsx:383` | Warm welcome | F5 | S3 |
| F7 Shortcuts | Partial | `personalization/*` | Own voice macros | F13,F14 | S3/S6 |
| F8 Driver Monitor | Implemented (untested) | `drowsiness.ts`, `DriverMonitor.tsx` | Prevent drowsy crashes | F9 | S4 |
| F9 Head pose | Partial | `DriverMonitor.tsx:42` | Tracking quality | F8 | S4 |
| F10 BharatConnect | Implemented; cloud unconfigured | `bharat/*`, `BharatConnect.tsx` | Cross-language rides | F15 | S5 |
| F11 Multilingual commands | Implemented | `parser.ts`, `types.ts` | Natural Hinglish control | F12 | S2/S6 |
| F12 Hybrid routing | Implemented | `App.tsx:94-166` | Fast and safe understanding | F11-F18 | S6/S7 |
| F13 V2 NLU | Code only (mock running) | `intent_model.py`, `nlu_eval_v2.md` | On-device accuracy | F12 | S7 |
| F14 Safety policy | Implemented, tested | `policy_v2.py`, `App.tsx:78` | Never acts on "don't" | F12 | S6 |
| F15 Server ASR | Implemented | `hybrid_asr.py`, `sherpa_asr.py` | Offline Hinglish speech | F16,F19 | S6/S7 |
| F16 Refinement | Partial (9 failing tests) | `rescorer.py` | Fewer mishearings | F15 | S7 |
| F17 Command LLM | Model absent | `command_llm.py`, `command_llm_eval.json` | Complex sentences | F12 | S7/S8 |
| F18 Premium tier | Mock-tested; keys absent | `assistant/*` | Better Tanglish and context | F12,F15 | S8 |
| F19 Wind suppression | Implemented (synthetic) | `wind_suppression.py`, `server.py:175` | Works with windows down | F15 | S6/S7 |
| F20 Spoken replies | Implemented | `speech.ts` | Eyes-free feedback | F21 | S2 |
| F21 Follow-ups | Implemented | `parser.ts`, `App.tsx:321` | Natural dialogue | F14 | S6 |
| F22 Demo mode | Implemented | `App.tsx:30-47` | Reliable stage demo | all | S2 |
| F23 Conversation log | Implemented | `Transcript.tsx` | Transparency | F12 | S7 |
| F24-F31 Simulator | Simulated | `drawn/*`, `car.ts`, `engine.ts`, `audio.ts` | Tangible demo surface | F11 | S2 |
| F32 OEM adapter | Planned | `hyundai_adapter.py` | Path to the real car | F14 | S8 |
| F33 ML toolchain | Present | `training/*`, `evaluation/*`, `reports/*` | Reproducible results | F13,F17 | S7 |
| F34 Dev surfaces | Implemented | `api/static/index.html`, `cli.py` | Testing | — | backup |
| F35 Launcher | Implemented | `start.ps1`, `start.sh` | Easy setup | — | backup |
| F36 Privacy | Implemented | see F36 | Trust | F4,F8,F10 | S7/S8 |

---

## Deliverable 5: Architecture and tech stack

```
                       Browser (React 19 + TypeScript + Vite)                         
 ┌────────────────────────────────────────────────────────────────────────────────────┐
 │ App.tsx ── Cockpit/SVG simulator ◄── runIntents() ◄── CarState (state/car.ts)       │
 │   │ voice: MediaRecorder (recordAudio) │ Web Speech API (optional) │ text / chips      │
 │   ▼                                                                                  │
 │ nlu/parser.ts (local) ── route(): negation guard → local │ backend │ LLM │ cloud      │
 │ Driver Monitor: getUserMedia → MediaPipe FaceLandmarker (WASM, local) → drowsiness   │
 │ BharatConnect UI → lib/bharat.ts (stage-by-stage requests)                           │
 │ Profiles: localStorage │ TTS: speechSynthesis │ Music/alarm: Web Audio               │
 └───────────────┬────────────────────────────────────────────────────────────────────┘
                 │ HTTP /api/* (same origin; Vite dev proxy → :8000)
 ┌───────────────▼────────────────────────────────────────────────────────────────────┐
 │ FastAPI (api/server.py)                                                             │
 │  /transcribe → wind filter → HybridASR(sherpa hi-hinglish-swift │ faster-whisper)    │
 │               → rank_transcripts (rescorer) + SpeakerID.identify (CAM++)           │
 │  /text → PipelineV2: IntentModel (ONNX) **or FakeIntentModel (current)**           │
 │          → personal shortcuts (SQLite) → dialog state → PolicyV2 → MockVehicleAdapter│
 │  /speaker/{id} enroll/forget → data/profiles/voiceprints.json                       │
 │  /interpret → CommandLLM (llama.cpp GGUF; absent)                                  │
 │  /bharat/* → faster-whisper ─► Google Cloud Translation v3 ─► Google Cloud TTS      │
 │  /assistant/* → Sarvam STT ─► OpenAI/Groq LLM (premium; keys absent)               │
 │  /wind-settings, /wind-test, /state, /personal, /reset, /connectivity, /health      │
 │  StaticFiles "/" → frontend/dist                                                    │
 └────────────────────────────────────────────────────────────────────────────────────┘
```

- **Verified by code:** every arrow above.
- **Active in this environment:** the browser parts, the swift ASR, faster-whisper `small` (cached in HF), the CAM++ speaker model and the mock NLU.
- **Configured but inactive:** Google Cloud, Sarvam/OpenAI/Groq, the command LLM, the trained NLU and the apex ASR.
- **Shared components:**
  - `recordAudio` serves commands, Teach Voice, BharatConnect and the wind test.
  - `preprocess`/the wind filter serves ASR, enrollment and identification.
  - `carAudio` serves music, the alarm and chimes.
  - `speak()` serves replies and Driver Monitor warnings.
- **Configuration:** environment variables and `.env` via python-dotenv (`config.py`). User preferences live in browser `localStorage`. Voiceprints and shortcuts live in the backend `data/profiles`.
- **Tech stack (verified from manifests and code):**
  - **Frontend:** React 19.2, TypeScript ~6.0, Vite 8, lucide-react, `@mediapipe/tasks-vision` 0.10.21, oxlint.
  - **Backend:** FastAPI 0.143, Uvicorn, Pydantic 2, NumPy, soundfile, PyAV, onnxruntime 1.31, sherpa-onnx 1.13.8, faster-whisper 1.2.1/CTranslate2, llama-cpp-python 0.3.19, google-cloud-translate 3.28, google-cloud-texttospeech 2.38, httpx, SQLite, python-dotenv, pytest.
  - **Training:** torch 2.14, transformers 5.20, sentence-transformers 6.1, scikit-learn, onnx, rapidfuzz.

---

## Deliverable 6: Do not present as fully working without verification

1. **BharatConnect translation and speech output.** Google Cloud is not configured here, and no successful run is recorded. Configure it and rehearse.
2. **Trained NLU accuracy (0.87 / 0.84).** The models are not on disk, the running backend uses a regex mock, and the data is synthetic.
3. **Command LLM and premium cloud tier.** The model file and API keys are absent, and the tier toggle is hidden.
4. **Speaker-recognition accuracy or security.** There is no evaluation, the thresholds are permissive and there is no anti-spoofing. Say "recognises enrolled drivers".
5. **"Learns from everyday use".** Not implemented. Only explicit teaching (Teach Voice, voice shortcuts) exists.
6. **"Saved seat height" or real seat actuation.** The seat position is computed from height and shown in a simulation.
7. **Gaze or "looking at the road" detection.** Only a head-pose heuristic exists, and looking away raises no alarm.
8. **Driver Monitor accuracy.** It is untested and has no metrics. Present it as a working prototype.
9. **Greeting "when the user enters the car" / reply-or-ignore dialogue.** The greeting is ignition-triggered and has no dialogue.
10. **Tamil and Bengali cockpit commands.** Partial support only. BharatConnect is the proper Tamil feature.
11. **ASR "Whisper small retry".** Not found in the code.
12. **Transcript rescoring.** 9 tests fail.
13. **Real vehicle control, navigation, calls, Blind View camera and tyre data.** All simulated or hard-coded.
14. **"No cloud or network at runtime"** (backend README). This is true only for the free command path, not for BharatConnect or the premium tier.

**Gaps and contradictions found:**
- `AddProfileModal` is rendered twice (`App.tsx:886-899`).
- The frontend README says "everything runs locally… no backend", which is outdated.
- `AUTOMOTIVE_FEASIBILITY.md` describes the V1 Qwen/Ollama stack and cites a missing `reports/benchmark.json`.
- The README says 6 failing tests; 9 actually fail.
- The enrollment toast says "2s+" while the code requires 1.5 s.
- Driver Monitor warnings ignore the TTS mute setting.
- Shortcuts are not tied to cockpit profiles and use an in-memory store in mock mode.
- Using browser ASR resets the profile to Default on the first voice command.
- BharatConnect's language list is hard-coded in the frontend types.
- The connectivity toggle exists only in `/console`.
- The frontend has no tests.
- `test_transcribe.py` at the repo root is an ad-hoc manual script.

---

## Deliverable 7: Slide-ready content

| Feature | Value proposition (1 line) | Detail (2–4 sentences) | For technical judges | Visual | Qualifier |
|---|---|---|---|---|---|
| **Teach Voice** | Teach the car your voice in one sentence. | The driver records a short sentence, and the car stores a 512-number voiceprint (never the audio). On the first command of each drive it recognises the voice and switches to that driver's profile. | CAM++ speaker embeddings via sherpa-onnx on CPU; cosine match against enrolled means (threshold 0.35, margin 0.04); outlier-checked enrollment; newest 6 samples kept. | Teach Voice button, toast, dropdown counts | Recognises enrolled drivers; not biometric security; no accuracy study yet |
| **Personal Profiles & Seat Fit** | Every driver gets their own car. | Profiles hold height and preferences. Switching restores AC temperature, ambient colour and drive mode, and fits the seat and wheel to the driver's height in the Seats view. | Anthropometric reach model (`fitFor`); motion blocked above 5 km/h. | Seats view animation | Seat position derived from height; simulated |
| **Smart Welcome** | The car greets you for the time of day. | Starting the car gives "Good morning/afternoon/evening". A recognised driver is greeted by name, in Hindi, English, Tamil or Bengali. | Browser clock; ignition-triggered. | Greeting bubble | Triggered by ignition, not occupancy |
| **Driver Monitor** | Wakes a drowsy driver before it's too late. | A cabin camera tracks the eyes on the device. Eyes closed for 2 s, frequent closures (PERCLOS) or microsleeps trigger an alarm, a WAKE UP banner and a voice warning. Yawning raises a "tired" hint. | MediaPipe FaceLandmarker blendshapes (WASM/GPU); 8 s per-driver calibration; PERCLOS over 30 s at 15%/30%; microsleeps ≥ 1.2 s; 4 s alarm hold; no frames leave the browser. | Live panel plus banner | Prototype; head pose, not gaze; no alert when the face is missing |
| **BharatConnect** | A driver and passenger with no common language can talk. | Each person picks a language (Tamil, Hindi or English) and presses their own talk button. The sentence is transcribed, translated and spoken in the other language, with both texts on screen and per-stage timings. | Local faster-whisper → Google Cloud Translation v3 → Cloud TTS (best voice tier, MP3); stage-wise retry; mic lock; caches; no logs. | Turn card with timings; pipeline graphic | Needs internet and Google Cloud for translation and speech |
| **Hinglish Voice Control** | Talk to your Verna the way you talk. | English, Hindi, Romanized Hindi and Hinglish, including compound commands, follow-ups and questions, across 45+ cockpit functions. | Local lexicon parser plus backend ONNX classifier routing; LLM fallback design. | Demo mode recording | Tamil/Bengali partial; backend runs a mock NLU without the trained artifacts |
| **Safety-first assistant** | It never acts on "don't". | Negated commands are refused, implicit requests are confirmed first, ambiguous ones are clarified, and limits are enforced. | Negation head and regex guard; policy whitelist; range validation; server-side confirmation for consequential cloud commands. | "AC band mat karo" exchange | — |
| **Offline Hinglish ASR & wind filter** | Works without internet, even with the windows down. | Speech is recognised locally by a Hinglish-tuned Whisper model, and an adaptive filter removes wind rumble. A built-in A/B test proves the effect. | sherpa-onnx INT8 Whisper-base fine-tune; STFT low-band attenuation; wind-test endpoint. | Wind test result | WER figures are from synthetic TTS |
| **Results** | Measured, not assumed. | Fine-tuned MiniLM: 87.1% test / 84.4% unseen accuracy at about 4.5 ms; command LLM 70.5% exact match vs 62.8% for rules; 312 unit tests pass. | `reports/*` | Results table | Synthetic data; models not in this build; 9 tests failing |
| **Premium tier (roadmap)** | Cloud brains when online, on-device when not. | Sarvam code-mix STT plus an LLM with a strict schema, with allowlisted commands, confirmations, rate limits and cost metering, falling back to on-device. | `assistant/*`, 23 mocked tests. | Architecture strip | Not configured; no billing |
| **Digital-twin cockpit** | See every command happen. | A full SVG Verna interior with working climate, music, 64-colour ambient lighting, gears, cruise, cluster, wipers and windows. | React/SVG, Web Audio synth, engine model. | Cabin screenshot collage | Simulation; no vehicle bus |
| **OEM integration path** | Ready to plug into the real car. | A defined adapter boundary for Hyundai climate, media and navigation services via VHAL/SOME-IP, with no safety-critical access. | `HyundaiAdapter` contract. | Boundary diagram | Not implemented |

---

## Deliverable 8: Audit checklist

**Inventory**
- 386 git-tracked files.
- 59 untracked or ignored non-dependency files: `frontend/dist` build output, `backend/models/*` weights, `voiceprints.json`, `egg-info`, and the 3 existing `technical_architecture_outputs/*.md` files.
- Dependency folders: `backend/.venv` (418 MB), `frontend/node_modules` (158 MB) and `backend/models` (657 MB).

**Read in full or in the relevant parts**
- All frontend `App.tsx`, `lib/*`, `state/car.ts`, the parser entry and language sections, the DriverMonitor, BharatConnect, AddProfileModal, Settings and Seat components.
- Backend `api/server.py`, `bharat/*`, `audio/speaker_id.py`, `hybrid_asr.py`, `config.py`, `assistant/*` (structure plus key functions), `personalization/*` (structure), `vehicle/hyundai_adapter.py`, and `tests/fakes_v2.py`.
- READMEs, `AUTOMOTIVE_FEASIBILITY.md` (part), `.env.example`, manifests, start scripts and reports (summaries).

**Inspected by structure, signatures and headers rather than line by line**
- `drawn/*` SVG parts, `Infotainment.tsx`, `Cluster.tsx`, `engine.ts`, `audio.ts` (except the alarm), and `index.css`.
- Backend `training/*`, `evaluation/*`, V1 `pipeline.py`/`semantic_parser.py`/`local_llm.py`, `nlu/rescorer.py`/`normalizer.py`/`slots.py`/`encoder.py`, `policy/*`, `schemas*.py`, `scripts/*`.
- Test files (by test names).
- Reason: these are visual-only or offline training/V1 code, and nothing in them is needed to establish the reported features. They are the first place to look if you want deeper numbers.

**Not read (classified only)**
- 155 WAV samples (synthetic TTS inputs).
- Model weights (`*.onnx`, `*.task`, `*.wasm`, `model.safetensors`).
- Images (Verna photos and the Hyundai logo, used as cockpit backgrounds).
- Dataset JSONL contents (line counts only).
- The `dist/` bundle, `.venv` and `node_modules`.

**Executed during the audit (read-only):** `pytest -p no:cacheprovider` → **312 passed, 9 failed, 14 deselected**. The frontend was not built or run; building writes `dist/`.

**Not accessible:** nothing was blocked. Environment variables were checked for presence only, in this shell.

**Remaining uncertainties**
- Whether your demo machine has Google Cloud credentials, trained artifacts or the GGUF model elsewhere (for example in a `.env` you keep outside the repo).
- Real-world accuracy of speaker ID, the Driver Monitor and BharatConnect for Tamil.
- Live UI behaviour (not exercised in a browser).

**What I need from you**
1. Your 8-slide outline, so the slide mapping can be corrected.
2. Whether BharatConnect and premium will be configured for the live demo.
3. Any real test runs or screenshots you already have.
