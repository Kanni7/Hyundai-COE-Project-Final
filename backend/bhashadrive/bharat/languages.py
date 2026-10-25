"""BharatConnect languages: one row per language, with the code each service expects.

Adding a language is one row here, provided Whisper/Sarvam, Translation and Text-to-Speech all
support it.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Language:
    code: str  # our id, also the Cloud Translation code (ISO 639-1)
    name: str
    native: str
    whisper: str  # Whisper language token
    tts: str  # Cloud Text-to-Speech BCP-47 code


LANGUAGES: dict[str, Language] = {lang.code: lang for lang in (
    Language("ta", "Tamil", "தமிழ்", "ta", "ta-IN"),
    Language("hi", "Hindi", "हिन्दी", "hi", "hi-IN"),
    Language("en", "English", "English", "en", "en-IN"),
    Language("bn", "Bengali", "বাংলা", "bn", "bn-IN"),
)}


def language(code: str) -> Language:
    try:
        return LANGUAGES[code]
    except KeyError:
        raise ValueError(f"Unsupported language '{code}'. Supported: {', '.join(LANGUAGES)}") from None
