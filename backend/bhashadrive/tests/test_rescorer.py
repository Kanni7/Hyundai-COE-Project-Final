"""Unit tests for Phonetic Retrieval + Self-Attention Context Rescorer."""
from pathlib import Path
import pytest

from bhashadrive.nlu.intent_model import IntentModel
from bhashadrive.nlu.rescorer import PhoneticAttentionRescorer, get_phonetic_candidates
from bhashadrive.pipeline_v2 import build_v2_pipeline
from bhashadrive.schemas_v2 import DecisionV2


def test_phonetic_candidate_retrieval():
    # 1. Phonetic slip 'bloer' retrieves 'blower' in top candidates
    cands_bloer = [c[0] for c in get_phonetic_candidates("bloer", top_k=5)]
    assert "blower" in cands_bloer

    # 2. Phonetic slip 'volin' retrieves 'volume' in top candidates
    cands_volin = [c[0] for c in get_phonetic_candidates("volin", top_k=5)]
    assert "volume" in cands_volin

    # 3. Phonetic slip 'kaibin' retrieves 'cabin' in top candidates
    cands_kaibin = [c[0] for c in get_phonetic_candidates("kaibin", top_k=5)]
    assert "cabin" in cands_kaibin

    # 4. Phonetic slip 'tempratur' retrieves 'temperature'
    cands_temp = [c[0] for c in get_phonetic_candidates("tempratur", top_k=5)]
    assert "temperature" in cands_temp


def test_self_attention_rescoring():
    root = Path(__file__).resolve().parents[2]
    model = IntentModel.load(root / "artifacts" / "nlu" / "runtime", root)
    rescorer = PhoneticAttentionRescorer(model)

    # Contextual resolution: in "bhai bloer thoda badha do", self-attention
    # determines "blower" is the coherent in-car candidate (fan speed up)
    rescored, meta = rescorer.rescore("bhai bloer thoda badha do")
    assert "blower" in rescored
    assert meta["rescored"] is True
    assert meta["target_word"] == "bloer"

    # Preserves clean sentences untouched
    clean = "turn on the AC"
    rescored_clean, meta_clean = rescorer.rescore(clean)
    assert rescored_clean == clean
    assert meta_clean["rescored"] is False


def test_ambient_colour_words_survive_rescoring():
    # Phonetic retrieval used to turn "blue" into "volume", "colour" into "blower" and "green" into "degree",
    # so the cockpit only heard "light" and switched it on instead of changing the colour.
    pipe = build_v2_pipeline(with_asr=False)
    for text in ["Light ko blue kar do", "Set ambient colour to green", "Light nili kar do", "Light gulaabi karo"]:
        assert pipe.refine_transcript(text) == text


def test_ranked_transcripts_keep_every_distinct_hypothesis():
    pipe = build_v2_pipeline(with_asr=False)
    hyps = ["Paz the music please.", "Pause the music please.", "Pause the music please."]
    ranked = pipe.rank_transcripts(*hyps)
    assert len(ranked) == 2 and set(ranked) == {"Paz the music please.", "Pause the music please."}  # duplicates merged
    assert ranked[0] == pipe.refine_transcript(*hyps) == "Pause the music please."


def test_pinning_to_performance_cores_is_safe():
    from bhashadrive import cpu

    cpus = cpu._windows_performance_cpus() if __import__("sys").platform == "win32" else cpu._linux_performance_cpus()
    assert all(isinstance(c, int) for c in cpus)  # [] on CPUs whose cores are all alike


def test_command_model_picks_best_asr_hypothesis():
    pipe = build_v2_pipeline(with_asr=False)
    # Hindi-mode and English-mode decodes of the same audio: keep the one the command model understands.
    assert pipe.refine_transcript("Paz the music please.", "Pause the music please.") == "Pause the music please."
    assert pipe.refine_transcript("AC band mat karna.", "Aisi band mat karna.") == "AC band mat karna."
    r = pipe.process_text("Kesat the cabin to 24 degrees.", hypotheses=["Kesat the cabin to 24 degrees.",
                                                                       "Set the cabin to twenty four degrees."])
    assert r.normalized_transcript == "Set the cabin to twenty four degrees."
    assert r.action.parameters.target_temperature_celsius == 24


def test_pipeline_integration_with_rescorer():
    pipe = build_v2_pipeline(with_asr=False)

    # When the driver says a distorted phrase, the rescorer recovers canonical words
    # and executes the intended automotive action seamlessly
    r = pipe.process_text("bhai bloer thoda badha do")
    assert r.decision == DecisionV2.EXECUTE
    assert "Fan speed" in r.action_result.message
