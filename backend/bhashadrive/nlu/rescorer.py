"""Phonetic candidate retrieval and Transformer Self-Attention contextual rescorer.

1. Stage 1 (Phonetic Retrieval): Generates the top 4-5 near-sounding in-car candidate words
   for noisy, accented, or distorted ASR tokens using acoustic similarity clusters.
2. Stage 2 (Self-Attention Context Rescoring): Evaluates each candidate sentence using the
   bidirectional Transformer encoder (MiniLM self-attention layers) and selects the word
   that best fits the semantic and grammatical context of the in-car command.
"""
from __future__ import annotations

import re
from typing import Any

from .taxonomy import EXECUTABLE_INTENTS, IntentV2

# Canonical in-car lexicon and known acoustic slip clusters
# Misheard spellings only: a correctly recognised word is never rewritten into a synonym or translation.
PHONETIC_CLUSTERS: dict[str, list[str]] = {
    # Climate & Temperature
    "temperature": ["temperature", "temprature", "tempreture", "tempretur", "tamprature", "tepreture", "tempercher"],
    "cabin": ["cabin", "kaibin", "caibin", "caben", "kaybin", "kabin"],
    "climate": ["climate", "klimat", "claimeit"],
    "cooler": ["cooler"],
    "heater": ["heater"],
    "ac": ["ac"],
    # Fan & Airflow
    "blower": ["blower", "bloer", "blour", "blowr", "bloor"],
    "fan": ["fan"],
    "speed": ["speed"],
    # Volume & Audio
    "volume": ["volume", "volin", "valim", "voleum", "volum", "bolume", "valume", "valum"],
    "awaaz": ["awaaz", "aawaz", "aawaj", "awaz", "awaaj", "avaz"],
    "sound": ["sound"],
    "mute": ["mute"],
    # Media & Playback
    "music": ["music"],
    "play": ["play"],
    "pause": ["pause"],
    "next": ["next"],
    "previous": ["previous"],
    # Common Actions & Directives
    "badhao": ["badhao"],
    "kam": ["kam"],
    "on": ["on"],
    "off": ["off"],
    "window": ["window", "windo"],
}

# Correctly spelled in-car words (synonyms, Hindi/Hinglish forms). The NLU understands them as they are.
VALID_INCAR_WORDS = {
    "taapmaan", "tapman", "cooling", "cool", "heating", "warm", "aircon", "pankha", "pankhe", "panka",
    "airflow", "vent", "gati", "raftar", "audio", "speaker", "gaana", "gana", "geet", "song", "track",
    "radio", "chalao", "baja", "start", "resume", "roko", "stop", "ruk", "agla", "agle", "skip", "pichla",
    "pichle", "back", "badha", "increase", "raise", "tez", "upar", "ghatao", "ghata", "decrease", "lower",
    "dheema", "dheemi", "halka", "chalu", "enable", "band", "bandh", "disable", "khidki",
} | {
    # Ambient lighting: colour names and light words are understood by the cockpit's parser, so they must
    # reach it intact (unprotected, "blue" was retrieved as "volume", "colour" as "blower", "green" as "degree").
    "light", "lights", "lighting", "ambient", "mood", "roshni", "batti", "colour", "color", "colours", "colors",
    "rang", "shade", "red", "laal", "lal", "maroon", "blue", "neela", "neeli", "nila", "nili", "navy", "green",
    "hara", "hari", "purple", "violet", "lavender", "baingani", "baingni", "jamuni", "pink", "gulabi",
    "gulaabi", "magenta", "orange", "narangi", "naarangi", "kesari", "kesariya", "saffron", "white", "safed",
    "safaid", "yellow", "peela", "peeli", "pila", "pili", "cyan", "teal", "aqua", "turquoise", "aasmani",
    "asmani", "sky", "gold", "golden", "sunehra", "sunehri",
}

# In-car vocabulary words used for phonetic competition
INCAR_PHONETIC_LEXICON = list(PHONETIC_CLUSTERS.keys()) + [
    "lower", "door", "floor", "louder", "softer", "higher", "colder", "warmer",
    "degree", "celsius", "thand", "thanda", "garam", "garmi", "hawa",
    "rasta", "route", "navigate", "haan", "nahi"
]

_COMMON_WORDS_SKIP = {
    "the", "a", "an", "is", "in", "to", "of", "and", "or", "on", "it", "at",
    "by", "for", "with", "this", "that", "from", "bhai", "yaar", "please",
    "kar", "do", "karo", "kardo", "na", "hai", "ko", "se", "pe", "par", "me",
    "mein", "thoda", "thodi", "zara", "bahut", "kafi", "mera", "meri", "hum",
    "what", "who", "whom", "where", "when", "why", "how", "all", "any", "some",
    "no", "not", "chat", "chit", "tell", "say", "joke", "jokes", "weather",
    "about", "like", "will", "would", "can", "could", "should", "capital", "france"
}


def get_phonetic_candidates(word: str, top_k: int = 5, min_similarity: float = 0.70) -> list[tuple[str, float]]:
    """
    Stage 1: Phonetic search retrieving the top 4-5 near-sounding in-car words.
    Returns list of (candidate_word, similarity_score).
    """
    clean = word.lower().strip(".,!?;:\"'()[]{}")
    if len(clean) < 3 or clean in _COMMON_WORDS_SKIP:
        return []

    # If it's already an exact canonical match in the lexicon, no candidate expansion needed
    if clean in PHONETIC_CLUSTERS:
        return [(clean, 1.0)]

    try:
        from rapidfuzz import fuzz
    except ImportError:
        return []

    candidates: dict[str, float] = {}

    # 1. Match against known acoustic slip clusters
    for canonical, variants in PHONETIC_CLUSTERS.items():
        best_sim = max((fuzz.ratio(clean, v) / 100.0) for v in variants)
        if best_sim >= min_similarity:
            candidates[canonical] = max(candidates.get(canonical, 0.0), round(best_sim, 3))

    # 2. Match against general in-car vocabulary
    for target in INCAR_PHONETIC_LEXICON:
        if target not in candidates:
            sim = fuzz.ratio(clean, target) / 100.0
            if sim >= min_similarity:
                candidates[target] = round(sim, 3)

    # Sort descending by similarity, take top_k
    sorted_cands = sorted(candidates.items(), key=lambda x: -x[1])
    return sorted_cands[:top_k]


class PhoneticAttentionRescorer:
    """
    Post-ASR Rescorer:
    Combines Acoustic/Phonetic Candidate Generation with Transformer Self-Attention scoring.
    """

    def __init__(self, intent_model: Any):
        self.model = intent_model
        self.exec_classes = {i.value for i in EXECUTABLE_INTENTS}

    def _score_sentence_attention(self, text: str) -> tuple[float, str]:
        """
        Evaluate candidate sentence coherence via the Transformer self-attention network.
        Higher score indicates stronger alignment with coherent, executable automotive commands.
        """
        try:
            pred, _ = self.model.predict(text)
            it_val = pred.intent.value
            is_exec = it_val in self.exec_classes

            # Base confidence in predicted intent
            score = pred.score
            # Executable command bonus and margin bonus
            exec_bonus = 0.30 if is_exec else 0.0
            margin_bonus = min(0.30, pred.margin * 0.30)
            # Penalty if the self-attention network flags it as unsupported
            unsupported_penalty = 0.40 if it_val == "unsupported" else 0.0

            attn_fit = max(0.01, score + exec_bonus + margin_bonus - unsupported_penalty)
            return round(attn_fit, 4), it_val
        except Exception:
            return 0.5, "error"

    def fitness(self, text: str) -> float:
        """How well a whole sentence reads as a coherent in-car command (used to pick between ASR hypotheses)."""
        return self._score_sentence_attention(text)[0]

    def rescore(self, text: str) -> tuple[str, dict[str, Any]]:
        """
        Rescore the utterance:
        1. Find words with near-sounding in-car candidate alternatives.
        2. Form candidate sentences.
        3. Use Transformer self-attention to evaluate contextual fit.
        4. Select candidate sentence with highest joint acoustic-attention score.
        """
        words = text.split()
        if not words:
            return text, {"rescored": False, "reason": "empty"}

        # Find candidate substitutions
        slot_candidates: list[tuple[int, str, list[tuple[str, float]]]] = []
        for idx, w in enumerate(words):
            clean = w.lower().strip(".,!?;:\"'()[]{}")
            if clean in _COMMON_WORDS_SKIP or clean in PHONETIC_CLUSTERS or clean in VALID_INCAR_WORDS \
                    or clean in INCAR_PHONETIC_LEXICON:
                continue
            cands = get_phonetic_candidates(w, top_k=5)
            # Only consider if there's an imperfect phonetic match that could be rescored
            if cands and cands[0][1] >= 0.60:
                slot_candidates.append((idx, w, cands))

        if not slot_candidates:
            return text, {"rescored": False, "reason": "no_candidates"}

        # Baseline attention score of the original transcript
        baseline_fit, baseline_intent = self._score_sentence_attention(text)
        best_sentence = text
        best_fitness = baseline_fit
        rescore_log = []

        # Evaluate candidate alternatives for the highest-confidence slot
        slot_candidates.sort(key=lambda s: -s[2][0][1])  # highest phonetic match first
        target_idx, original_word, candidates = slot_candidates[0]

        # Gating: only compare candidates in the top acoustic tier
        top_sim = candidates[0][1]
        viable_candidates = [c for c in candidates if c[1] >= max(0.65, top_sim - 0.20)]

        # Extract surrounding punctuation to preserve it
        prefix = original_word[:len(original_word) - len(original_word.lstrip(".,!?;:\"'()[]{}"))]
        suffix = original_word[len(original_word.rstrip(".,!?;:\"'()[]{}")):]

        for cand_word, phonetic_sim in viable_candidates:
            # Reconstruct word preserving original capitalization
            formatted_word = cand_word
            if original_word.isupper():
                formatted_word = formatted_word.upper()
            elif original_word and original_word[0].isupper():
                formatted_word = formatted_word.capitalize()
            cand_token = f"{prefix}{formatted_word}{suffix}"

            # Construct candidate sentence
            cand_words = list(words)
            cand_words[target_idx] = cand_token
            cand_sentence = " ".join(cand_words)

            # Score sentence via Transformer self-attention
            attn_fit, predicted_intent = self._score_sentence_attention(cand_sentence)

            # Joint fitness: combination of acoustic similarity and attention contextual fit
            joint_fitness = (phonetic_sim ** 1.5) * attn_fit

            rescore_log.append({
                "candidate": cand_token,
                "phonetic_similarity": phonetic_sim,
                "attention_fit": attn_fit,
                "predicted_intent": predicted_intent,
                "joint_fitness": round(joint_fitness, 3),
                "sentence": cand_sentence,
            })

            if joint_fitness > best_fitness:
                best_fitness = joint_fitness
                best_sentence = cand_sentence

        metadata = {
            "rescored": best_sentence != text,
            "original_text": text,
            "chosen_text": best_sentence,
            "target_word": original_word,
            "baseline_fit": baseline_fit,
            "best_fitness": round(best_fitness, 3),
            "candidates_evaluated": rescore_log,
        }
        return best_sentence, metadata
