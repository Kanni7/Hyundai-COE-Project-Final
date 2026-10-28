"""BharatConnect languages: English and the 22 scheduled languages of India, one row each, with the code each
service expects. The spoken language is detected from the audio; the listener only picks the language they hear.

Coverage (checked against the providers' docs, Oct 2026):
- Speech recognition, Sarvam Saaras v4: all 23, including language detection (`language_code="unknown"`).
- Translation: Google for 20 (`google`); Sarvam-Translate v1 for all 23, so Bodo, Kashmiri and Santali too.
- Speech output: Sarvam Bulbul v3 for 11 (`bulbul`), Google Text-to-Speech where it has a voice (`google_tts`).
  Languages with neither are translated to text only (`speech` is False).
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Language:
    code: str  # our id (ISO 639)
    name: str
    native: str
    sarvam: str  # Sarvam code: Saaras speech-to-text, Sarvam-Translate, Bulbul
    google: str | None  # Google Translate code; None = not offered by Google
    whisper: str | None  # Whisper language token (local fallback); None = Whisper has no such language
    google_tts: str | None = None  # Google Text-to-Speech BCP-47 code
    bulbul: bool = False  # Sarvam Bulbul v3 has a voice

    @property
    def speech(self) -> bool:
        """The translation can be spoken aloud, not only shown."""
        return self.bulbul or self.google_tts is not None


LANGUAGES: dict[str, Language] = {lang.code: lang for lang in (
    Language("hi", "Hindi", "हिन्दी", "hi-IN", "hi", "hi", "hi-IN", True),
    Language("en", "English", "English", "en-IN", "en", "en", "en-IN", True),
    Language("ta", "Tamil", "தமிழ்", "ta-IN", "ta", "ta", "ta-IN", True),
    Language("bn", "Bengali", "বাংলা", "bn-IN", "bn", "bn", "bn-IN", True),
    Language("te", "Telugu", "తెలుగు", "te-IN", "te", "te", "te-IN", True),
    Language("mr", "Marathi", "मराठी", "mr-IN", "mr", "mr", "mr-IN", True),
    Language("gu", "Gujarati", "ગુજરાતી", "gu-IN", "gu", "gu", "gu-IN", True),
    Language("kn", "Kannada", "ಕನ್ನಡ", "kn-IN", "kn", "kn", "kn-IN", True),
    Language("ml", "Malayalam", "മലയാളം", "ml-IN", "ml", "ml", "ml-IN", True),
    Language("pa", "Punjabi", "ਪੰਜਾਬੀ", "pa-IN", "pa", "pa", "pa-IN", True),
    Language("or", "Odia", "ଓଡ଼ିଆ", "od-IN", "or", None, None, True),
    Language("ur", "Urdu", "اردو", "ur-IN", "ur", "ur", "ur-IN"),
    Language("as", "Assamese", "অসমীয়া", "as-IN", "as", "as"),
    Language("ne", "Nepali", "नेपाली", "ne-IN", "ne", "ne"),
    Language("kok", "Konkani", "कोंकणी", "kok-IN", "gom", None),
    Language("mai", "Maithili", "मैथिली", "mai-IN", "mai", None),
    Language("doi", "Dogri", "डोगरी", "doi-IN", "doi", None),
    Language("sa", "Sanskrit", "संस्कृतम्", "sa-IN", "sa", "sa"),
    Language("sd", "Sindhi", "سنڌي", "sd-IN", "sd", "sd"),
    Language("mni", "Manipuri", "ꯃꯩꯇꯩꯂꯣꯟ", "mni-IN", "mni-Mtei", None),
    Language("brx", "Bodo", "बड़ो", "brx-IN", None, None),
    Language("ks", "Kashmiri", "كٲشُر", "ks-IN", None, None),
    Language("sat", "Santali", "ᱥᱟᱱᱛᱟᱲᱤ", "sat-IN", None, None),
)}

_BY_SARVAM = {lang.sarvam: lang for lang in LANGUAGES.values()}


def language(code: str) -> Language:
    try:
        return LANGUAGES[code]
    except KeyError:
        raise ValueError(f"Unsupported language '{code}'. Supported: {', '.join(LANGUAGES)}") from None


def detected(code: str | None) -> Language | None:
    """The language a recogniser reported, as Sarvam ("od-IN") or Whisper ("or") code; None if unknown."""
    if not code:
        return None
    return _BY_SARVAM.get(code) or LANGUAGES.get(code.split("-")[0])
