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

# Pre-download local edge models during build so the container starts instantly
RUN python scripts/download_models.py --asr swift --encoder minilm
RUN python -m bhashadrive.training.export_onnx --encoder minilm
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('small', compute_type='int8')"

# Default runtime configuration (optimized for Render Free Tier 512MB RAM)
ENV BD_API_HOST=0.0.0.0
ENV BD_LOCAL_ASR=swift
ENV BD_ASR_MODEL=small
ENV BD_ASR_DEVICE=cpu
ENV BD_ASR_COMPUTE_TYPE=int8
ENV BD_ASR_LOCAL_ONLY=true
ENV BD_HYBRID_CLOUD_ASR=true
ENV BD_SHERPA_EXTRA_MODEL_DIRS=""
ENV BD_DEV_DEFAULT_TIER=premium
ENV BD_NLU_ARTIFACTS=artifacts/nlu/runtime
ENV BD_PERSONAL_THRESHOLDS=artifacts/personalization.json
ENV BD_PROFILE_DB=data/profiles/bhashadrive.sqlite

EXPOSE 8000

# Render injects $PORT dynamically
CMD ["sh", "-c", "uvicorn bhashadrive.api.server:create_app --factory --host 0.0.0.0 --port ${PORT:-8000}"]
