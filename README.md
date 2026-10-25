# 🚗 Hyundai Verna Smart Cockpit + BhashaDrive V2

> **AI-Powered Automotive Cockpit with Multilingual Voice Control, Real-Time Intercom (BharatConnect), and Edge Vision Safety (Safe Exit Guardian).**

---

## 🌟 Executive Overview

The **Hyundai Verna Smart Cockpit** combines a modern React/Vite in-cabin user experience with **BhashaDrive V2**, a state-of-the-art multilingual automotive NLU & voice engine. It offers:

1. **Dual-Tier Voice Assistant**:
   - **Cloud / Premium Mode (Zero Latency)**: Powered by **Sarvam AI Saaras v4** for code-mixed Indian speech recognition and **Groq LPU (Qwen 3.8 27B)** for sub-second intent classification with strict schema enforcement.
   - **Edge / Offline Mode (100% On-Device)**: Runs fully local on CPU without internet via **Sherpa-ONNX** (`hi-hinglish-swift`), **Faster-Whisper**, **INT8 Sentence Transformers**, and a fallback **Gemma 3 270M GGUF** model.
2. **BharatConnect (Two-Way Voice Intercom)**:
   - Real-time bilingual driver-to-passenger intercom supporting **Hindi (`hi-IN`)**, **Tamil (`ta-IN`)**, **Bengali (`bn-IN`)**, and **English (`en-IN`)**.
   - Built on **Sarvam Saaras v4 ASR**, ultra-low-latency **Groq Qwen 27B** conversational translation ($<200\text{ ms}$), and **Sarvam Bulbul v3 TTS** natural voice synthesis.
3. **Safe Exit Guardian**:
   - In-browser computer vision door-zone safety monitoring using Google's **MediaPipe EfficientDet Lite0**, alerting passengers to oncoming vehicles, cyclists, or pedestrians before opening doors.
4. **Driver Profile Biometrics (Speaker ID)**:
   - Voiceprint matching using **3D-Speaker CAM++** ONNX embeddings to personalize cockpit temperature, seat positions, and media shortcuts per driver.

---

## 🧠 Comprehensive Backend Model Architecture

| Capability | Engine / Model | Quantization / Format | Runtime / Provider | Latency | Purpose & Role |
|---|---|---|---|---|---|
| **Cockpit ASR (Cloud)** | **Sarvam Saaras v4** (`saaras:v4`) | Cloud API | Sarvam AI REST (`mode="codemix"`) | ~300 ms | Primary ASR for spoken English, Hindi, Hinglish, Tamil, & Bengali in-car commands with keyterm biasing. |
| **Cockpit Intent Engine (Cloud)** | **Qwen 3.8 27B** (`qwen/qwen3.8-27b`) | 8-bit / LPU Native | Groq Cloud LPU (`/chat/completions`) | ~180 ms | High-speed intent extraction, compound actions, confirmation loops, and Latin-script response mirroring. |
| **Cockpit Intent Engine (Fallback)** | **OpenAI GPT-6.1-sol** | Cloud API | OpenAI Responses API | ~800 ms | Secondary cloud reasoning engine with strict JSON schema output formatting. |
| **BharatConnect ASR** | **Sarvam Saaras v4** + Peak Normalization | Cloud API | Sarvam AI REST (`mode="codemix"`) | ~300 ms | Driver & passenger conversational speech-to-text with float32 peak normalization. |
| **BharatConnect Translation** | **Qwen 3.8 27B** (Groq LPU) | LPU Native | Groq Cloud LPU (`/chat/completions`) | ~190 ms | Ultra-low latency natural bilingual conversational interpreter across Hindi, Tamil, Bengali, and English. |
| **BharatConnect Translation (Fallbacks)** | **Sarvam Mayura v1** & **Google Cloud Translate v3** | Cloud API | Sarvam AI / Google Cloud Translation | ~500 ms | Secondary translation engines if Groq is unconfigured or rate-limited. |
| **BharatConnect TTS** | **Sarvam Bulbul v3** (`bulbul:v3`) | 22050 Hz WAV | Sarvam AI REST (speaker: `aditya`) | ~400 ms | Studio-grade human speech generation for Tamil, Hindi, Bengali, and Indian English. |
| **BharatConnect TTS (Fallbacks)** | **Google Cloud TTS** (`texttospeech_v1`) | MP3 / Neural2 | Google Cloud Platform | ~450 ms | Spoken audio fallback for Hindi, Tamil, and English. |
| **Local Offline ASR (Primary)** | **`hi-hinglish-swift`** (IndicConformer) | INT8 ONNX | Sherpa-ONNX / ONNX Runtime (CPU) | ~400 ms | Whisper-base fine-tuned for Hindi & Hinglish spoken commands; zero cloud dependency. |
| **Local Offline ASR (Secondary)** | **Whisper Small** (`whisper-small`) | INT8 CTranslate2 | Faster-Whisper (CPU/CUDA) | ~1.8 s | Robust multi-accent English and fallback offline recognition. |
| **Local Offline NLU (Primary)** | **MiniLM-L12-v2** / **e5-small** + Linear Heads | INT8 ONNX | ONNX Runtime (CPU) | ~15 ms | High-efficiency 12-intent classifier, negation detection, and slot value extractor. |
| **Local Fallback Interpreter** | **Cockpit Gemma 3 270M** (`cockpit-gemma-270m.q8_0.gguf`) | Q8_0 GGUF (~290 MB) | `llama-cpp-python` (CPU) | ~250 ms | Offline fallback interpreter for complex or conversational phrases missed by linear heads. |
| **Speaker Identification** | **3D-Speaker CAM++** | FP32 ONNX (~25 MB) | Sherpa-ONNX (CPU) | ~30 ms | 512-dimensional speaker embedding extractor for profile voiceprint verification. |
| **Vision Safe Exit Guardian** | **EfficientDet-Lite0** (`efficientdet_lite0.tflite`) | Float32 TFLite (~17 MB) | MediaPipe WebAssembly (Browser) | Real-time (30 fps) | Local webcam detection of approaching vehicles, cyclists, and pedestrians in the door safety zone. |

---

## 📂 Repository Layout

```
Hyundai-COE-Project/
├── backend/                             # BhashaDrive V2 FastAPI Engine
│   ├── bhashadrive/
│   │   ├── assistant/                  # Premium Cloud Voice Assistant (Sarvam + Groq/OpenAI)
│   │   │   ├── api.py                  # POST /api/assistant/interact route
│   │   │   ├── providers.py            # Sarvam Saaras ASR + Groq Qwen 27B / OpenAI LLM clients
│   │   │   └── service.py              # Assistant lifecycle, usage tracking, context history
│   │   ├── audio/                      # Audio preprocessing, Sherpa-ONNX ASR, Faster-Whisper, Speaker ID
│   │   │   ├── asr.py                  # Faster-Whisper wrapper
│   │   │   ├── sherpa_asr.py           # Sherpa-ONNX Swift/Apex engine
│   │   │   └── speaker_id.py           # 3D-Speaker CAM++ profile identifier
│   │   ├── bharat/                     # BharatConnect Two-Way Voice Intercom
│   │   │   ├── api.py                  # BharatConnect endpoints (/asr, /translate, /tts, /exchange)
│   │   │   ├── languages.py            # Hindi, Tamil, Bengali, English language metadata
│   │   │   ├── speech.py               # Sarvam Saaras v4 STT + normalization
│   │   │   ├── translation.py          # Groq Qwen 27B natural conversational translation
│   │   │   └── tts.py                  # Sarvam Bulbul v3 TTS synthesis
│   │   ├── nlu/                        # Intent schemas, taxonomy, mock NLU, Gemma fallback
│   │   ├── server.py                   # FastAPI server & route orchestration
│   │   └── tests/                      # Pytest test suite (36 unit tests)
│   ├── models/                         # Local downloaded weights (git-ignored)
│   │   ├── asr/                        # hi-hinglish-swift INT8 ONNX files
│   │   ├── encoders/                   # MiniLM / E5 sentence encoders
│   │   ├── llm/                        # Gemma 3 270M GGUF model
│   │   └── speaker/                    # 3D-Speaker CAM++ ONNX model
│   ├── scripts/                        # Model downloaders and benchmark tools
│   │   ├── download_models.py          # Script to download offline weights
│   │   └── check_setup.py              # Environment and model diagnostics
│   ├── requirements.txt                # Full offline training and inference dependencies
│   └── requirements-app.txt            # Minimal production runtime dependencies
├── frontend/                            # React 19 + TypeScript + Vite Verna Cockpit
│   ├── public/mediapipe/               # EfficientDet Lite0 TFLite model & wasm assets
│   ├── src/
│   │   ├── components/                 # Cockpit panels, BharatConnect, SafeExitGuardian
│   │   ├── lib/                        # Backend API clients, BharatConnect client, object tracker
│   │   └── nlu/                        # Client-side heuristic parser
│   ├── package.json
│   └── vite.config.ts
├── start.ps1                            # Windows unified startup script
├── start.sh                             # Linux/macOS unified startup script
└── README.md
```

---

## ⚙️ Prerequisites

Before getting started, ensure you have the following installed on your host machine:

- **Python**: `3.10` or higher (Python `3.11` or `3.12` recommended; tested up to `3.14`).
- **Node.js**: `20.x` or higher (includes `npm`).
- **Git**: Installed and configured on your system PATH.
- *(Optional)* **FFmpeg** / **libsndfile**: Required for custom audio formats on certain Linux distros.

---

## 🔑 Environment Configuration (`.env`)

Create a `.env` file inside the `backend/` directory (or workspace root). Configure the keys according to your desired operation mode:

```env
# ==============================================================================
# BhashaDrive V2 - Environment Settings
# ==============================================================================

# 1. Cloud AI Services (Recommended for best performance and latency)
# ------------------------------------------------------------------------------
# Groq API Key (Powers Qwen 3.8 27B for ultra-fast Cockpit NLU & BharatConnect Translation)
GROQ_API_KEY="your-groq-api-key-here"

# Sarvam AI Key (Powers Saaras v4 STT and Bulbul v3 TTS for Hindi, Tamil, Bengali, English)
SARVAM_API_KEY="your-sarvam-api-key-here"

# (Optional) OpenAI API Key (Only if using OpenAI GPT-6.1-sol instead of Groq)
# OPENAI_API_KEY="sk-..."

# (Optional) Google Cloud Credentials (Only if using Google Cloud Translation or TTS fallbacks)
# GOOGLE_APPLICATION_CREDENTIALS="path/to/gcp-service-account.json"
# GOOGLE_CLOUD_PROJECT="your-gcp-project-id"

# 2. Cockpit Assistant Configuration
# ------------------------------------------------------------------------------
BD_DEV_TIER_SWITCH=true                 # Allows switching between Free (Offline) and Premium in UI
BD_DEV_DEFAULT_TIER="premium"           # "premium" (Cloud Groq+Sarvam) or "free" (Local ONNX)
BD_SARVAM_STT_MODE="codemix"            # "codemix" maintains natural Hinglish/Tanglish terms
BD_ASSISTANT_MAX_AUDIO_S=20.0

# 3. Local On-Device ASR Configuration
# ------------------------------------------------------------------------------
BD_LOCAL_ASR="swift"                    # "swift" (sherpa-onnx, ~0.4s) or "whisper" (faster-whisper)
BD_ASR_MODEL="small"
BD_ASR_DEVICE="cpu"                     # "cpu" or "cuda"
BD_ASR_COMPUTE_TYPE="int8"
BD_ASR_LOCAL_ONLY=true                  # Prevents network access at startup once models are cached
```

> [!NOTE]
> All sensitive API keys are read strictly on the server and are never exposed to the frontend browser bundle.

---

## 📥 Model Installation & Weight Download Guide

### 1. Cloud-Accelerated Mode (Instant Setup)
If you provide `GROQ_API_KEY` and `SARVAM_API_KEY` in your `.env`, **no large model downloads are mandatory!** The backend immediately leverages:
- Sarvam Saaras v4 for STT
- Groq Qwen 27B for Cockpit NLU and BharatConnect Translation
- Sarvam Bulbul v3 for TTS

### 2. Local Offline Edge Models (Full On-Device Setup)
To enable zero-network, 100% on-device operation, download the local INT8 ONNX and Whisper weights:

```bash
# 1. Navigate to the backend directory and activate your virtual environment
cd backend
# Windows:
.venv\Scripts\activate
# Linux/macOS:
# source .venv/bin/activate

# 2. Download the Sherpa-ONNX Swift ASR model, MiniLM Sentence Encoder, and CAM++ Speaker model (~600 MB)
python scripts/download_models.py --asr swift --encoder minilm

# 3. (Optional) Download alternative larger models for benchmarking (~2.2 GB)
# python scripts/download_models.py --asr swift apex indic-hi --encoder minilm e5

# 4. Cache the Faster-Whisper Small INT8 model (~480 MB)
python -c "from faster_whisper import WhisperModel; WhisperModel('small', compute_type='int8')"
```

> [!TIP]
> Running `python scripts/download_models.py --asr swift --encoder minilm` also installs the local **3D-Speaker CAM++** model used by the driver profile **Teach Voice** feature. Voice teaching enrolls a local 512-dimensional biometric embedding without requiring model fine-tuning.

### 3. (Optional) Command LLM Fallback (Gemma 3 270M)
For edge conversational interpretation when simple linear intent heads are uncertain, place the quantized GGUF weights into `backend/models/llm/`:
```
backend/models/llm/cockpit-gemma-270m.q8_0.gguf
```
*(If omitted, the server gracefully continues without the fallback LLM).*

### 4. Safe Exit Guardian Model (Browser Vision)
The EfficientDet Lite0 model is already pre-bundled in the frontend repository:
```
frontend/public/mediapipe/efficientdet_lite0.tflite (17 MB)
```
When you run `npm run build`, it is automatically placed into `frontend/dist/mediapipe/`.

---

## 🚀 Complete Guide to Start the Application

### Option A: One-Command Startup (Production Mode)

This script automatically sets up the Python virtual environment (`.venv`), installs all backend dependencies, builds the Vite production frontend, and serves the complete application from `http://127.0.0.1:8000`:

#### On Windows (PowerShell):
```powershell
powershell -ExecutionPolicy Bypass -File start.ps1
```
*To rebuild the frontend after modifying code, simply pass `-Rebuild`:*
```powershell
powershell -ExecutionPolicy Bypass -File start.ps1 -Rebuild
```

#### On Linux / macOS:
```bash
chmod +x start.sh
./start.sh
```

---

### Option B: Dual-Terminal Developer Mode (Hot Reload)

For active frontend and backend development with live code reloading:

#### Terminal 1 — FastAPI Backend:
```bash
cd backend

# Create and activate virtual environment (if not already done)
python -m venv .venv
# Windows:
.venv\Scripts\activate
# Linux/macOS:
# source .venv/bin/activate

# Install requirements
pip install -r requirements-app.txt
pip install -e .

# Launch FastAPI development server on port 8000
python -m bhashadrive.cli serve --port 8000
```
- API Base: `http://127.0.0.1:8000/api`
- Interactive Swagger Docs: `http://127.0.0.1:8000/docs`
- Legacy Diagnostics Console: `http://127.0.0.1:8000/console`

#### Terminal 2 — React/Vite Frontend:
```bash
cd frontend

# Install node dependencies
npm install

# Start Vite hot-reload server (proxies /api requests to :8000)
npm run dev
```
- Open your browser at **`http://localhost:5173`**.

---

## 🧪 Verification & Testing

Ensure that all modules, translation pipelines, and assistant capabilities are fully validated:

### 1. Backend Test Suite (36/36 Unit Tests)
```bash
cd backend
pytest bhashadrive/tests/test_bharat.py bhashadrive/tests/test_assistant.py
```
*Output: All 36 tests pass verifying Sarvam ASR, Groq NLU, speaker biometrics, and BharatConnect translation routes.*

### 2. Frontend Type-Check & Build
```bash
cd frontend
npm run build
```
*Output: Validates TypeScript typing, builds assets, and outputs production bundles cleanly.*

### 3. Frontend Safe Exit Unit Tests
```bash
cd frontend
npm test
```
*Output: Tests image-space object tracking, bounding box smoothing, and door danger zone heuristics.*

---

## 🎙️ Using the Features

### 1. Cockpit Voice Assistant
- Click the microphone button in the top bar or use the speech chips.
- Try mixed-language commands:
  - *"AC 22 degree pe kardo"* (Sets climate temperature)
  - *"Gaana play karo"* (Resumes music playback)
  - *"Fan speed thoda kam karo"* (Lowers ventilation fan)
  - *"Don't turn off the AC"* (Safety refusal: negated commands are rejected)

### 2. BharatConnect Two-Way Intercom
- Navigate to the **BharatConnect** tab in the cockpit.
- Select driver language (e.g., Hindi) and passenger language (e.g., Tamil).
- Speak naturally into the microphone.
- The pipeline transcribes your voice with Sarvam Saaras v4, translates it in real-time via Groq Qwen 27B into colloquial target phrasing, and reads it aloud with Sarvam Bulbul v3 TTS.

### 3. Safe Exit Guardian
- Navigate to the **Safe Exit** tab.
- Click **Start Camera** to enable local webcam detection.
- Point the camera towards an entryway. Moving objects entering the configurable door collision zone trigger immediate visual safety warnings.

---

## 🛡️ License & Acknowledgements
- Developed for the **Hyundai COE Project**.
- Speech models powered by **Sarvam AI** and **Sherpa-ONNX**.
- Ultra-low latency inference powered by **Groq Cloud LPUs**.
- Computer vision built on **Google MediaPipe**.
