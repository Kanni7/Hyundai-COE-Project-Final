FROM python:3.11-slim

# Install system dependencies for audio decoding and building packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Upgrade pip
RUN pip install --no-cache-dir --upgrade pip

# Copy minimal runtime requirements first (leverage Docker cache)
COPY requirements-app.txt .
RUN pip install --no-cache-dir -r requirements-app.txt --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu

# Copy source code & pre-trained NLU artifacts
COPY . .

# Install package in editable mode
RUN pip install --no-cache-dir -e .

# Cloud Mode Configuration for Render Free Tier (RAM: ~68 MB, strictly <512 MB)
# All speech recognition, LLM reasoning, translation and TTS are offloaded to
# high-speed Free Tier Cloud APIs (Groq Whisper, Groq Qwen 3.8, Sarvam Saaras & Bulbul).
ENV BD_API_HOST=0.0.0.0
ENV BD_CLOUD_ONLY=true
ENV BD_HYBRID_CLOUD_ASR=true
ENV BD_DEV_DEFAULT_TIER=premium
ENV BD_DEV_TIER_SWITCH=true
ENV BD_NLU_ARTIFACTS=artifacts/nlu/runtime
ENV BD_PERSONAL_THRESHOLDS=artifacts/personalization.json
ENV BD_PROFILE_DB=data/profiles/bhashadrive.sqlite

EXPOSE 8000

# Render injects $PORT dynamically
CMD ["sh", "-c", "uvicorn bhashadrive.api.server:create_app --factory --host 0.0.0.0 --port ${PORT:-8000}"]
