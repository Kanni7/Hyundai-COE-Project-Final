"""Runtime configuration.

All settings come from environment variables (optionally loaded from a `.env`
file in the working directory). Nothing machine-specific is hardcoded, so model
size, device, endpoint and limits can be changed without editing source files.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # python-dotenv is optional
    pass


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _env_float(name: str, default: float) -> float:
    return float(os.environ.get(name, default))


def _env_int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


def _env_bool(name: str, default: bool) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


# Keep this short: on weak audio Whisper regurgitates prompt text as if it were spoken.
DEFAULT_INCAR_PROMPT = "In-car voice commands: AC, temperature, fan speed, volume, music, navigation."


@dataclass
class ASRConfig:
    model_size: str = field(default_factory=lambda: _env("BD_ASR_MODEL", "small"))
    device: str = field(default_factory=lambda: _env("BD_ASR_DEVICE", "cpu"))  # cpu | cuda | auto
    compute_type: str = field(default_factory=lambda: _env("BD_ASR_COMPUTE_TYPE", "int8"))
    beam_size: int = field(default_factory=lambda: _env_int("BD_ASR_BEAM_SIZE", 5))  # 5 = beam search for high accuracy
    cpu_threads: int = field(default_factory=lambda: _env_int("BD_ASR_THREADS", 4))
    # "en" keeps Hinglish in Latin script; empty = auto-detect among allowed_languages (Hindi comes out in Devanagari).
    language: str | None = field(default_factory=lambda: _env("BD_ASR_LANGUAGE", "en") or None)
    # Auto-detection is restricted to these languages; empty = any language Whisper knows.
    allowed_languages: tuple = field(default_factory=lambda: tuple(
        x.strip() for x in _env("BD_ASR_ALLOWED_LANGUAGES", "en,hi").split(",") if x.strip()))
    vad_filter: bool = field(default_factory=lambda: _env_bool("BD_ASR_VAD", True))
    vad_parameters: dict = field(default_factory=lambda: {"min_silence_duration_ms": 600, "threshold": 0.5, "speech_pad_ms": 400})
    no_speech_threshold: float = field(default_factory=lambda: _env_float("BD_ASR_NO_SPEECH_TH", 0.6))
    initial_prompt: str | None = field(default_factory=lambda: os.environ.get("BD_ASR_INITIAL_PROMPT", DEFAULT_INCAR_PROMPT) or None)
    download_root: str | None = field(default_factory=lambda: os.environ.get("BD_ASR_MODEL_DIR") or None)
    # After the one-time download, keep this true so startup never touches the network.
    local_files_only: bool = field(default_factory=lambda: _env_bool("BD_ASR_LOCAL_ONLY", True))
    sample_rate: int = 16000
    min_rms: float = field(default_factory=lambda: _env_float("BD_ASR_MIN_RMS", 0.01))
    # Segments decoded with lower average log-probability are dropped as guesses.
    min_avg_logprob: float = field(default_factory=lambda: _env_float("BD_ASR_MIN_LOGPROB", -1.0))


@dataclass
class LLMConfig:
    backend: str = field(default_factory=lambda: _env("BD_LLM_BACKEND", "ollama"))
    model: str = field(default_factory=lambda: _env("BD_LLM_MODEL", "qwen2.5:3b"))
    endpoint: str = field(default_factory=lambda: _env("BD_LLM_ENDPOINT", "http://127.0.0.1:11434"))
    timeout_s: float = field(default_factory=lambda: _env_float("BD_LLM_TIMEOUT_S", 30.0))
    temperature: float = field(default_factory=lambda: _env_float("BD_LLM_TEMPERATURE", 0.0))
    num_ctx: int = field(default_factory=lambda: _env_int("BD_LLM_NUM_CTX", 4096))
    keep_alive: str = field(default_factory=lambda: _env("BD_LLM_KEEP_ALIVE", "30m"))
    # Only loopback endpoints are allowed unless explicitly overridden.
    allow_remote_endpoint: bool = field(default_factory=lambda: _env_bool("BD_LLM_ALLOW_REMOTE", False))


@dataclass
class CommandLLMConfig:
    """V2 fallback interpreter: fine-tuned Gemma 3 270M, 8-bit GGUF, run on the CPU by llama.cpp."""

    model_path: Path = field(default_factory=lambda: _abs(_env("BD_CMD_LLM_PATH", "models/llm/cockpit-gemma-270m.q8_0.gguf")))
    threads: int = field(default_factory=lambda: _env_int("BD_CMD_LLM_THREADS", 4))
    # Room for MAX_COMMANDS commands; a longer answer is cut off and discarded.
    max_tokens: int = field(default_factory=lambda: _env_int("BD_CMD_LLM_MAX_TOKENS", 160))


@dataclass
class BharatConfig:
    """BharatConnect (driver <-> passenger voice translation): Whisper ASR, Cloud Translation, Cloud TTS."""

    # Faster-Whisper size for ta/hi/en speech. "small" is bundled; "large-v3-turbo" is far better at Tamil
    # (one-time download: set BD_ASR_LOCAL_ONLY=false for the first start).
    asr_model: str = field(default_factory=lambda: _env("BD_BHARAT_ASR_MODEL", "small"))
    max_audio_s: float = field(default_factory=lambda: _env_float("BD_BHARAT_MAX_AUDIO_S", 30.0))
    # Google Cloud project for Cloud Translation v3; credentials come from GOOGLE_APPLICATION_CREDENTIALS.
    project: str | None = field(default_factory=lambda: os.environ.get("GOOGLE_CLOUD_PROJECT") or None)
    translate_timeout_s: float = field(default_factory=lambda: _env_float("BD_BHARAT_TRANSLATE_TIMEOUT_S", 8.0))
    tts_timeout_s: float = field(default_factory=lambda: _env_float("BD_BHARAT_TTS_TIMEOUT_S", 10.0))


@dataclass
class AssistantConfig:
    """Premium voice assistant: Sarvam Saaras ASR -> OpenAI LLM. Keys are read from the server environment only."""

    sarvam_api_key: str | None = field(default_factory=lambda: os.environ.get("SARVAM_API_KEY") or None)
    sarvam_url: str = field(default_factory=lambda: _env("BD_SARVAM_STT_URL", "https://api.sarvam.ai/speech-to-text"))
    sarvam_model: str = field(default_factory=lambda: _env("BD_SARVAM_STT_MODEL", "saaras:v4"))
    # codemix: English words in Latin script, Indic words in native script (Hinglish / Tanglish).
    sarvam_mode: str = field(default_factory=lambda: _env("BD_SARVAM_STT_MODE", "codemix"))
    # "unknown" = auto-detect; or a BCP-47 code such as hi-IN, ta-IN, en-IN.
    sarvam_language: str = field(default_factory=lambda: _env("BD_SARVAM_STT_LANGUAGE", "unknown"))
    sarvam_timeout_s: float = field(default_factory=lambda: _env_float("BD_SARVAM_TIMEOUT_S", 8.0))
    # Sarvam pricing page: Speech to Text, Rs 30 per hour, billed per second.
    sarvam_inr_per_hour: float = field(default_factory=lambda: _env_float("BD_SARVAM_INR_PER_HOUR", 30.0))
    groq_api_key: str | None = field(default_factory=lambda: os.environ.get("GROQ_API_KEY") or None)
    openai_api_key: str | None = field(default_factory=lambda: os.environ.get("OPENAI_API_KEY") or os.environ.get("GROQ_API_KEY") or None)
    openai_url: str = field(default_factory=lambda: _env("BD_OPENAI_RESPONSES_URL", "https://api.openai.com/v1/responses"))
    openai_model: str = field(default_factory=lambda: _env("BD_OPENAI_MODEL", "gpt-6.1-sol"))
    # Lowest effort the model accepts: spoken commands need a fast answer, not deep reasoning.
    openai_reasoning_effort: str = field(default_factory=lambda: _env("BD_OPENAI_REASONING_EFFORT", "low"))
    openai_timeout_s: float = field(default_factory=lambda: _env_float("BD_OPENAI_TIMEOUT_S", 10.0))
    # USD per 1M tokens (OpenAI model page for gpt-6.1-sol).
    openai_usd_per_m_input: float = field(default_factory=lambda: _env_float("BD_OPENAI_USD_PER_M_INPUT", 2.0))
    openai_usd_per_m_output: float = field(default_factory=lambda: _env_float("BD_OPENAI_USD_PER_M_OUTPUT", 10.0))
    usd_to_inr: float = field(default_factory=lambda: _env_float("BD_USD_TO_INR", 88.0))
    # One retry for transient provider errors (timeouts, 429, 5xx): both calls only read, so retrying is safe.
    retries: int = field(default_factory=lambda: _env_int("BD_ASSISTANT_RETRIES", 1))
    max_audio_s: float = field(default_factory=lambda: _env_float("BD_ASSISTANT_MAX_AUDIO_S", 20.0))  # Sarvam REST: 30 s
    rate_per_min: int = field(default_factory=lambda: _env_int("BD_ASSISTANT_RATE_PER_MIN", 20))
    context_turns: int = field(default_factory=lambda: _env_int("BD_ASSISTANT_CONTEXT_TURNS", 4))
    min_confidence: float = field(default_factory=lambda: _env_float("BD_ASSISTANT_MIN_CONFIDENCE", 0.5))
    # Entitlements: JSON file {"<token>": {"tier": "premium", "expires": "2026-12-31T23:59:59Z"}} (server-side).
    entitlements_file: Path | None = field(default_factory=lambda: _abs(os.environ["BD_ENTITLEMENTS_FILE"]) if os.environ.get("BD_ENTITLEMENTS_FILE") else None)
    # Development only: lets the local UI switch its tier (loopback requests only). Never enable in production.
    dev_tier_switch: bool = field(default_factory=lambda: _env_bool("BD_DEV_TIER_SWITCH", False))
    dev_default_tier: str = field(default_factory=lambda: _env("BD_DEV_DEFAULT_TIER", "free"))
    usage_log: Path = field(default_factory=lambda: _abs(_env("BD_ASSISTANT_USAGE_LOG", "data/usage/assistant_usage.jsonl")))
    # Development only: keep transcripts in the server log for debugging. Off in production.
    log_transcripts: bool = field(default_factory=lambda: _env_bool("BD_ASSISTANT_LOG_TRANSCRIPTS", False))

    def problems(self) -> list[str]:
        """Configuration errors, checked at startup (the premium tier is disabled while any remain)."""
        out = []
        if not self.sarvam_api_key:
            out.append("SARVAM_API_KEY not set")
        if not self.openai_api_key:
            out.append("OPENAI_API_KEY not set")
        if self.sarvam_mode not in {"transcribe", "translate", "verbatim", "translit", "codemix"}:
            out.append(f"BD_SARVAM_STT_MODE invalid: {self.sarvam_mode}")
        if self.openai_reasoning_effort not in {"low", "medium", "high", "xhigh", "max"}:
            out.append(f"BD_OPENAI_REASONING_EFFORT invalid: {self.openai_reasoning_effort}")
        if not 0 < self.max_audio_s <= 30:
            out.append("BD_ASSISTANT_MAX_AUDIO_S must be in (0, 30] (Sarvam REST limit)")
        if self.dev_default_tier not in {"free", "premium"}:
            out.append(f"BD_DEV_DEFAULT_TIER invalid: {self.dev_default_tier}")
        return out


@dataclass
class SpeakerIDConfig:
    """Driver recognition by voice: 3D-Speaker CAM++ embeddings (zh/en, sherpa-onnx), matched to enrolled profiles."""

    model_path: Path = field(default_factory=lambda: _abs(_env("BD_SPEAKER_MODEL", "models/speaker/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx")))
    # Voiceprints (embeddings only, no audio) of the enrolled profiles.
    store_path: Path = field(default_factory=lambda: _abs(_env("BD_SPEAKER_STORE", "data/profiles/voiceprints.json")))
    threads: int = field(default_factory=lambda: _env_int("BD_SPEAKER_THREADS", 2))
    # Cosine similarity to accept the best voiceprint, and its lead over the runner-up.
    threshold: float = field(default_factory=lambda: _env_float("BD_SPEAKER_THRESHOLD", 0.35))
    margin: float = field(default_factory=lambda: _env_float("BD_SPEAKER_MARGIN", 0.04))
    min_identify_s: float = field(default_factory=lambda: _env_float("BD_SPEAKER_MIN_S", 0.6))
    min_enroll_s: float = field(default_factory=lambda: _env_float("BD_SPEAKER_MIN_ENROLL_S", 1.5))
    max_samples: int = field(default_factory=lambda: _env_int("BD_SPEAKER_MAX_SAMPLES", 6))
    min_rms: float = field(default_factory=lambda: _env_float("BD_SPEAKER_MIN_RMS", 0.005))


@dataclass
class VehicleLimits:
    temp_min_c: float = field(default_factory=lambda: _env_float("BD_TEMP_MIN_C", 16.0))
    temp_max_c: float = field(default_factory=lambda: _env_float("BD_TEMP_MAX_C", 30.0))
    fan_min: int = field(default_factory=lambda: _env_int("BD_FAN_MIN", 0))
    fan_max: int = field(default_factory=lambda: _env_int("BD_FAN_MAX", 7))
    volume_min: int = field(default_factory=lambda: _env_int("BD_VOLUME_MIN", 0))
    volume_max: int = field(default_factory=lambda: _env_int("BD_VOLUME_MAX", 30))
    # Step sizes for qualitative amounts.
    temp_steps: dict = field(default_factory=lambda: {"small": 1.0, "medium": 2.0, "large": 3.0})
    fan_steps: dict = field(default_factory=lambda: {"small": 1, "medium": 2, "large": 3})
    volume_steps: dict = field(default_factory=lambda: {"small": 2, "medium": 4, "large": 8})
    max_destination_chars: int = 120


@dataclass
class ContextConfig:
    max_turns: int = field(default_factory=lambda: _env_int("BD_CONTEXT_MAX_TURNS", 6))
    pending_ttl_s: float = field(default_factory=lambda: _env_float("BD_PENDING_TTL_S", 60.0))
    followup_ttl_s: float = field(default_factory=lambda: _env_float("BD_FOLLOWUP_TTL_S", 120.0))


_ROOT = Path(__file__).resolve().parents[1]


def _abs(p: str) -> Path:
    """Relative paths in settings are resolved against the project root, not the CWD."""
    return Path(p) if Path(p).is_absolute() else _ROOT / p


# Built Verna cockpit (`npm run build` in ../frontend), served at / by the API server.
FRONTEND_DIST = _abs(_env("BD_FRONTEND_DIST", "../frontend/dist"))


@dataclass
class SherpaASRConfig:
    """V2 on-device ASR (sherpa-onnx Whisper export). Only local files are read."""

    model_dir: Path = field(default_factory=lambda: _abs(_env("BD_SHERPA_MODEL_DIR", "models/asr/hi-hinglish-swift")))
    # Extra recognisers run on the same audio; their hypotheses join the primary's for the NLU to choose from.
    # A second model makes different mistakes (eval_asr, 432 graded commands: 311 -> 327 understood).
    # A listed model whose files are missing is skipped.
    extra_model_dirs: tuple = field(default_factory=lambda: tuple(
        _abs(x.strip()) for x in _env("BD_SHERPA_EXTRA_MODEL_DIRS", "").split(",") if x.strip()))
    # One greedy decoding pass per language on the same loaded model; the NLU keeps the hypothesis
    # it understands best. "hi" keeps Hinglish words right, "en" spells English words better.
    languages: tuple = field(default_factory=lambda: tuple(
        x.strip() for x in _env("BD_SHERPA_LANGUAGES", "hi,en").split(",") if x.strip()))
    threads: int = field(default_factory=lambda: _env_int("BD_ASR_THREADS", 4))
    timeout_s: float = field(default_factory=lambda: _env_float("BD_ASR_TIMEOUT_S", 10.0))
    max_audio_s: float = field(default_factory=lambda: _env_float("BD_MAX_AUDIO_S", 15.0))
    min_rms: float = field(default_factory=lambda: _env_float("BD_ASR_MIN_RMS", 0.01))


@dataclass
class RuntimeConfig:
    """V2 semantic runtime: trained NLU artifacts, personalisation storage."""

    root: Path = field(default_factory=lambda: Path(_env("BD_ROOT", str(_ROOT))))
    nlu_artifacts: str = field(default_factory=lambda: _env("BD_NLU_ARTIFACTS", "artifacts/nlu/runtime"))
    nlu_threads: int = field(default_factory=lambda: _env_int("BD_NLU_THREADS", 2))
    profile_db: str = field(default_factory=lambda: _env("BD_PROFILE_DB", "data/profiles/bhashadrive.sqlite"))
    profile_id: str = field(default_factory=lambda: _env("BD_PROFILE_ID", "default"))
    personal_thresholds: str = field(default_factory=lambda: _env("BD_PERSONAL_THRESHOLDS", "artifacts/personalization.json"))
    # Opt-in: keep an audit trail of old -> new mappings when the user corrects a shortcut.
    store_corrections: bool = field(default_factory=lambda: _env_bool("BD_STORE_CORRECTIONS", False))


@dataclass
class AppConfig:
    asr: ASRConfig = field(default_factory=ASRConfig)
    sherpa: SherpaASRConfig = field(default_factory=SherpaASRConfig)
    runtime: RuntimeConfig = field(default_factory=RuntimeConfig)
    command_llm: CommandLLMConfig = field(default_factory=CommandLLMConfig)
    bharat: BharatConfig = field(default_factory=BharatConfig)
    speaker: SpeakerIDConfig = field(default_factory=SpeakerIDConfig)
    assistant: AssistantConfig = field(default_factory=AssistantConfig)
    llm: LLMConfig = field(default_factory=LLMConfig)
    limits: VehicleLimits = field(default_factory=VehicleLimits)
    context: ContextConfig = field(default_factory=ContextConfig)
    # Keep inference on the fast cores of hybrid CPUs (see cpu.py); a no-op where all cores are alike.
    pin_performance_cores: bool = field(default_factory=lambda: _env_bool("BD_PIN_PERFORMANCE_CORES", True))
    store_audio: bool = field(default_factory=lambda: _env_bool("BD_STORE_AUDIO", False))
    audio_store_dir: Path = field(default_factory=lambda: Path(_env("BD_AUDIO_STORE_DIR", "recordings")))
    api_host: str = field(default_factory=lambda: _env("BD_API_HOST", "127.0.0.1"))
    api_port: int = field(default_factory=lambda: _env_int("BD_API_PORT", 8000))
