"""V2 runtime pipeline (no LLM, no network):

audio -> local ASR (Whisper ONNX, Hindi + English passes) -> transcript normalisation -> intent model (ONNX encoder +
trained heads) -> personal-command matching -> dialog context / ambiguity policy ->
parameter validation -> vehicle adapter -> ResultV2.
"""
from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .audio.asr import SpeechRecognizer
from .config import AppConfig
from .nlu.intent_model import IntentModel
from .nlu.taxonomy import DESCRIPTIONS, EXECUTABLE_INTENTS, IntentV2
from .personalization.matcher import PersonalCommandMatcher, contains_phrase
from .personalization.store import PersonalCommandStore
from .personalization.teaching import TeachError, check_trigger, interpret_action_clause, parse_request
from .pipeline import normalize_transcript
from .policy.policy_v2 import ActionValidationError, PolicyV2, validate_action
from .schemas import ASRResult, ActionResult
from .schemas_v2 import DecisionV2, ResultV2, SpeechActV2, VehicleAction
from .vehicle.base import VehicleAdapter, dispatch_v2

MAX_TEXT_CHARS = 500


@dataclass
class _Pending:
    kind: str  # action | teach | delete | correct | alias
    payload: dict[str, Any]
    at: float


class DialogState:
    """Bounded state: one pending proposal, the last executed action and a few recent turns."""

    def __init__(self, pending_ttl_s: float, followup_ttl_s: float, max_turns: int, clock=time.monotonic):
        self.pending_ttl_s, self.followup_ttl_s, self._clock = pending_ttl_s, followup_ttl_s, clock
        self._pending: _Pending | None = None
        self._last: tuple[dict, float] | None = None
        self.history: deque[tuple[str, str]] = deque(maxlen=max_turns)

    @property
    def pending(self) -> _Pending | None:
        if self._pending and self._clock() - self._pending.at > self.pending_ttl_s:
            self._pending = None
        return self._pending

    def set_pending(self, kind: str | None, payload: dict | None = None) -> None:
        self._pending = _Pending(kind, payload or {}, self._clock()) if kind else None

    @property
    def last(self) -> dict | None:
        if self._last and self._clock() - self._last[1] > self.followup_ttl_s:
            self._last = None
        return self._last[0] if self._last else None

    def set_last(self, info: dict) -> None:
        self._last = (info, self._clock())

    def reset(self) -> None:
        self._pending = self._last = None
        self.history.clear()


class BhashaDrivePipelineV2:
    def __init__(self, intent_model: IntentModel, vehicle: VehicleAdapter, asr: SpeechRecognizer | None = None,
                 config: AppConfig | None = None, store: PersonalCommandStore | None = None,
                 matcher: PersonalCommandMatcher | None = None, profile_id: str = "default"):
        self.config = config or AppConfig()
        self.model, self.vehicle, self.asr = intent_model, vehicle, asr
        m = intent_model.manifest
        self.policy = PolicyV2(self.config.limits, m["thresholds"], m.get("negation_threshold", 0.5),
                               m.get("implicit_threshold", 0.5))
        self.store, self.matcher, self.profile_id = store, matcher, profile_id
        c = self.config.context
        self.state = DialogState(c.pending_ttl_s, c.followup_ttl_s, c.max_turns)
        try:
            from .nlu.rescorer import PhoneticAttentionRescorer
            if hasattr(self.model, "encoder") and getattr(self.model, "encoder") is not None:
                self.rescorer = PhoneticAttentionRescorer(self.model)
            else:
                self.rescorer = None
        except Exception:
            self.rescorer = None

    # ---- audio entry points -----------------------------------------------
    def process_audio_file(self, path: str | Path) -> ResultV2:
        if self.asr is None:
            raise RuntimeError("No speech recognizer configured")
        t0 = time.perf_counter()
        return self._after_asr(self.asr.transcribe_file(path), time.perf_counter() - t0)

    def process_audio_array(self, audio: np.ndarray, sample_rate: int = 16000) -> ResultV2:
        if self.asr is None:
            raise RuntimeError("No speech recognizer configured")
        t0 = time.perf_counter()
        return self._after_asr(self.asr.transcribe_array(audio, sample_rate), time.perf_counter() - t0)

    def _after_asr(self, asr: ASRResult, asr_s: float) -> ResultV2:
        timings = {"asr_s": round(asr_s, 3)}
        if asr.status != "ok" or not asr.text.strip():
            reason = {"silence": "silence", "no_audio": "no_audio", "timeout": "asr_timeout"}.get(asr.status, "asr_error")
            return ResultV2(transcript="", decision=DecisionV2.CLARIFY, reason_code=reason, asr=asr, timings_s=timings,
                            response_text="I didn't catch that. Could you repeat?")
        r = self.process_text(asr.text, timings=timings, hypotheses=asr.hypotheses)
        r.asr = asr
        if "asr_s" in r.timings_s:
            r.timings_s["end_to_end_s"] = round(r.timings_s["asr_s"] + r.timings_s["post_asr_total_s"], 3)
        return r

    # ---- text entry point ------------------------------------------------
    def refine_transcript(self, *hypotheses: str) -> str:
        """Post-ASR text: cleanup + domain snapping, then phonetic retrieval + self-attention rescoring.

        Given several ASR hypotheses of one utterance, each is refined and the command model keeps the
        one it fits best (ties keep the earliest, i.e. the primary decoding language).
        """
        ranked = self.rank_transcripts(*hypotheses)
        return ranked[0] if ranked else ""

    def rank_transcripts(self, *hypotheses: str) -> list[str]:
        """The distinct refined hypotheses, best fit for the command model first (stable on ties). The
        classifier only knows its own domain, so callers that understand more (the cockpit's parser) may
        choose among them."""
        refined = list(dict.fromkeys(r for r in map(self._refine_one, hypotheses) if r))
        if len(refined) > 1 and self.rescorer is not None:
            fit = {r: self.rescorer.fitness(r) for r in refined}
            refined.sort(key=lambda r: -fit[r])
        return refined

    def _refine_one(self, text: str) -> str:
        norm = normalize_transcript(text)[:MAX_TEXT_CHARS]
        if norm and self.rescorer is not None:
            norm, _ = self.rescorer.rescore(norm)
        return norm

    def process_text(self, text: str, timings: dict | None = None, hypotheses: list[str] | None = None) -> ResultV2:
        timings = dict(timings or {})
        t_start = time.perf_counter()
        t0 = time.perf_counter()
        norm = self.refine_transcript(*(hypotheses or [text]))
        if not norm:
            return ResultV2(transcript=text or "", decision=DecisionV2.CLARIFY, reason_code="empty_transcript",
                            response_text="I didn't catch that. Could you repeat?", timings_s=timings)
        pred, emb = self.model.predict(norm)
        _SINGLE_DOMAIN_WORDS = {
            "temperature", "cabin", "climate", "taapmaan",
            "fan", "blower", "pankha", "airflow",
            "volume", "sound", "awaaz", "aawaz", "audio",
            "music", "song", "gaana", "gana",
            "ac", "aircon", "air conditioning",
        }
        if norm.strip().lower() in _SINGLE_DOMAIN_WORDS:
            from .schemas_v2 import IntentPrediction
            pred = IntentPrediction(
                intent=IntentV2.AMBIGUOUS,
                score=0.99,
                margin=0.99,
                top_k=[(IntentV2.AMBIGUOUS.value, 0.99)],
                negation_score=0.0,
                implicit_score=0.0,
                model_version=self.model.version,
            )
        timings["nlu_s"] = round(time.perf_counter() - t0, 4)
        base = dict(transcript=text, normalized_transcript=norm, prediction=pred, intent=pred.intent,
                    confidence=pred.score, confidence_meaning=self.model.manifest.get("confidence_meaning"))

        result = (self._personalization_request(norm, base)
                  or self._dialog_followup(pred, base)
                  or self._personal_command(norm, pred, emb, base)
                  or self._builtin(norm, pred, base))
        if result.decision == DecisionV2.EXECUTE and result.action is not None:
            t1 = time.perf_counter()
            result.action_result = self._execute(result.action)
            timings["vehicle_s"] = round(time.perf_counter() - t1, 4)
            if result.action_result.success:
                self.state.set_last({"action": result.action, "source": result.source,
                                     "command_id": result.personal_match.command_id if result.personal_match else None})
            result.response_text = (f"Done: {result.action_result.message}." if result.action_result.success
                                    else f"I couldn't do that: {result.action_result.message}.")
        timings["post_asr_total_s"] = round(time.perf_counter() - t_start, 4)
        result.timings_s = timings
        self.state.history.append((norm[:200], result.response_text[:200]))
        return result

    # ---- stages ------------------------------------------------------------
    def _execute(self, action: VehicleAction) -> ActionResult:
        try:
            return dispatch_v2(self.vehicle, validate_action(action, self.config.limits), self.config.limits)
        except (ActionValidationError, NotImplementedError) as exc:
            from .schemas import Intent

            return ActionResult(success=False, intent=Intent.UNSUPPORTED, message=str(exc))

    def _personalization_request(self, norm: str, base: dict) -> ResultV2 | None:
        if self.store is None:
            return None
        req = parse_request(norm)
        if req is None:
            return None
        self.state.set_pending(None)
        common = dict(base, source="personalization", speech_act=SpeechActV2.MANAGE)
        try:
            if req.kind == "list":
                cmds = self.store.list_commands(self.profile_id)
                txt = "; ".join(f"'{c.trigger}' -> {c.action.describe()}" for c in cmds) or "You have no saved shortcuts."
                return ResultV2(**common, decision=DecisionV2.REJECT, reason_code="listed", response_text=txt)
            if req.kind == "teach":
                trig = check_trigger(req.trigger, self.model, self.policy)
                existing = self._resolve_existing(trig, allow_missing=True)
                if existing is not None:
                    raise TeachError("trigger_exists", f"'{existing.trigger}' is already saved. Say 'change {existing.trigger} to ...' to update it.")
                action = interpret_action_clause(req.action_text, self.model, self.policy)
                self.state.set_pending("teach", {"trigger": trig, "action": action})
                return ResultV2(**dict(common, speech_act=SpeechActV2.TEACH), decision=DecisionV2.ASK_CONFIRMATION,
                                reason_code="confirm_new_shortcut", action=action,
                                parameters=action.parameters.model_dump(exclude_none=True),
                                response_text=f"Should I save this: when you say '{trig}', I will {action.describe()}?")
            cmd = self._resolve_existing(req.trigger) if req.kind in ("delete", "correct") else None
            if req.kind == "delete":
                self.state.set_pending("delete", {"command_id": cmd.id})
                return ResultV2(**common, decision=DecisionV2.ASK_CONFIRMATION, reason_code="confirm_delete",
                                response_text=f"Delete the shortcut '{cmd.trigger}' ({cmd.action.describe()})?")
            if req.kind == "correct":
                action = interpret_action_clause(req.action_text, self.model, self.policy)
                self.state.set_pending("correct", {"command_id": cmd.id, "action": action})
                return ResultV2(**common, decision=DecisionV2.ASK_CONFIRMATION, reason_code="confirm_correction",
                                action=action, response_text=f"Change '{cmd.trigger}' from '{cmd.action.describe()}' to "
                                                             f"'{action.describe()}'?")
            if req.kind == "alias":
                target = self._resolve_existing(req.target)
                alias = check_trigger(req.trigger, self.model, self.policy)
                self.state.set_pending("alias", {"command_id": target.id, "phrase": alias})
                return ResultV2(**common, decision=DecisionV2.ASK_CONFIRMATION, reason_code="confirm_alias",
                                response_text=f"Should '{alias}' also do what '{target.trigger}' does ({target.action.describe()})?")
        except TeachError as e:
            return ResultV2(**common, decision=DecisionV2.CLARIFY, reason_code=e.code, response_text=e.message)
        return None

    def _resolve_existing(self, phrase: str | None, allow_missing: bool = False):
        if phrase:
            cmd = self.store.find_by_trigger(self.profile_id, phrase)
            if cmd is None and self.matcher is not None:
                emb = self.model.embed([phrase])[0]
                cands = self.matcher.candidates(self.profile_id, phrase, emb)
                good = [c for c in cands if c[2] >= self.matcher.th.min_similarity]
                if len(good) > 1 and good[0][2] - good[1][2] < self.matcher.th.min_margin:
                    raise TeachError("ambiguous_shortcut", "That matches more than one saved shortcut. Please say its exact phrase.")
                if good:
                    cmd = self.store.get(self.profile_id, good[0][0])
            if cmd is not None:
                return cmd
        if allow_missing:
            return None
        raise TeachError("unknown_shortcut", f"I couldn't find a saved shortcut called '{phrase}'.")

    def _dialog_followup(self, pred, base: dict) -> ResultV2 | None:
        pending = self.state.pending
        is_dialog = pred.intent in (IntentV2.DIALOG_CONFIRM, IntentV2.DIALOG_CANCEL) and pred.score >= 0.5
        if not is_dialog:
            if pending is not None:
                self.state.set_pending(None)  # a new request replaces the open question
            return None
        common = dict(base, source="context", speech_act=SpeechActV2.DIALOG)
        if pending is None:
            last = self.state.last
            if pred.intent == IntentV2.DIALOG_CANCEL and last and last.get("source") == "personal":
                # Never learn from a single complaint; offer an explicit, confirmed correction instead.
                return ResultV2(**common, decision=DecisionV2.CLARIFY, reason_code="personal_feedback_not_learned",
                                response_text="Okay. If that shortcut did the wrong thing, say \"change <phrase> to <action>\".")
            return ResultV2(**common, decision=DecisionV2.CLARIFY, reason_code="missing_context",
                            response_text="What would you like me to do?")
        self.state.set_pending(None)
        if pred.intent == IntentV2.DIALOG_CANCEL:
            return ResultV2(**common, decision=DecisionV2.REJECT, reason_code="cancelled_by_user", response_text="Okay, cancelled.")
        p = pending.payload
        if pending.kind == "action":
            return ResultV2(**dict(common, source=p.get("source", "builtin")), decision=DecisionV2.EXECUTE,
                            reason_code="confirmed_by_user", action=p["action"], personal_match=p.get("personal_match"),
                            parameters=p["action"].parameters.model_dump(exclude_none=True))
        model_version = self.model.version
        if pending.kind == "teach":
            emb = self.model.embed([p["trigger"]])[0]
            self.store.add_command(self.profile_id, p["trigger"], p["action"], emb, model_version)
            msg = f"Saved. Say '{p['trigger']}' to {p['action'].describe()}."
        elif pending.kind == "delete":
            self.store.delete_command(self.profile_id, p["command_id"])
            msg = "Deleted."
        elif pending.kind == "correct":
            self.store.update_action(self.profile_id, p["command_id"], p["action"])
            msg = f"Updated. It will now {p['action'].describe()}."
        else:  # alias
            emb = self.model.embed([p["phrase"]])[0]
            self.store.add_alias(self.profile_id, p["command_id"], p["phrase"], emb, model_version)
            msg = f"Okay, '{p['phrase']}' now works too."
        return ResultV2(**dict(common, source="personalization"), decision=DecisionV2.SAVED, reason_code=f"{pending.kind}_saved",
                        response_text=msg)

    def _personal_command(self, norm: str, pred, emb, base: dict) -> ResultV2 | None:
        if self.matcher is None:
            return None
        pm = self.matcher.match(self.profile_id, norm, emb)
        if pm is None:
            return None
        common = dict(base, source="personal", personal_match=pm, confidence=pm.similarity,
                      confidence_meaning="cosine similarity to the closest saved trigger phrase (not a probability)")
        if not pm.accepted:
            if pm.reason == "negated_reference":
                return ResultV2(**common, decision=DecisionV2.REJECT, reason_code="negated_no_action", negated=True,
                                response_text=f"Okay, I won't use '{pm.trigger}'.")
            q = (f"Do you want me to run your shortcut '{pm.trigger}' ({pm.action.describe()})?"
                 if pm.reason == "quoted_or_meta_reference" else "That sounds like more than one of your shortcuts. Which one?")
            if pm.reason == "quoted_or_meta_reference":
                self.state.set_pending("action", {"action": pm.action, "source": "personal", "personal_match": pm})
                return ResultV2(**common, decision=DecisionV2.ASK_CONFIRMATION, reason_code=pm.reason, response_text=q)
            return ResultV2(**common, decision=DecisionV2.CLARIFY, reason_code=pm.reason, response_text=q)
        # Arbitration with a clearly different built-in reading of the same utterance.
        th = self.policy.th
        builtin_clear = (pred.intent in EXECUTABLE_INTENTS and pred.score >= th["min_score"] and pred.margin >= th["min_margin"]
                         and pred.intent != pm.action.intent)
        if builtin_clear and not contains_phrase(norm, pm.matched_phrase):
            return ResultV2(**common, decision=DecisionV2.CLARIFY, reason_code="personal_builtin_conflict",
                            response_text=f"Did you mean your shortcut '{pm.trigger}' ({pm.action.describe()}) or to "
                                          f"{DESCRIPTIONS[pred.intent]}?")
        try:
            action = validate_action(pm.action, self.config.limits)
        except ActionValidationError as e:
            return ResultV2(**common, decision=DecisionV2.REJECT, reason_code=e.code, response_text=f"I can't do that: {e.message}.")
        return ResultV2(**dict(common, intent=action.intent), decision=DecisionV2.EXECUTE, reason_code="personal_command",
                        speech_act=SpeechActV2.DIRECT_COMMAND, action=action,
                        parameters=action.parameters.model_dump(exclude_none=True))

    def _builtin(self, norm: str, pred, base: dict) -> ResultV2:
        out = self.policy.decide(norm, pred)
        if out.decision == DecisionV2.ASK_CONFIRMATION and out.action is not None:
            self.state.set_pending("action", {"action": out.action, "source": "builtin"})
        default_text = {
            "unsupported_request": "Sorry, that's not something I can do in this car.",
            "negated_no_action": "Okay, I won't do that.",
        }
        return ResultV2(**dict(base, source="builtin"), decision=out.decision, reason_code=out.reason_code,
                        speech_act=out.speech_act, action=out.action, parameters=out.params, negated=out.negated,
                        response_text=out.question or default_text.get(out.reason_code, ""))

    def reset(self) -> None:
        self.state.reset()


def build_v2_pipeline(config: AppConfig | None = None, with_asr: bool = True, with_personalization: bool = True,
                      db_path: str | None = None) -> BhashaDrivePipelineV2:
    """Construct the real local V2 pipeline. Raises if a required local model cannot be loaded."""
    from .audio.sherpa_asr import SherpaWhisperASR
    from .personalization.matcher import MatchThresholds
    from .vehicle.mock_adapter import MockVehicleAdapter

    config = config or AppConfig()
    rt = config.runtime
    model = IntentModel.load(rt.root / rt.nlu_artifacts, rt.root, threads=rt.nlu_threads)
    asr = None
    if with_asr:
        try:
            from .audio.hybrid_asr import HybridASR
            asr = HybridASR(config)
        except Exception:
            try:
                from .audio.sherpa_asr import SherpaWhisperASR
                asr = SherpaWhisperASR(config.sherpa)
            except Exception:
                asr = None
    store = matcher = None
    if with_personalization:
        store = PersonalCommandStore(db_path or rt.root / rt.profile_db, store_correction_history=rt.store_corrections)
        matcher = PersonalCommandMatcher(store, model.embed, model.version,
                                         MatchThresholds.load(rt.root / rt.personal_thresholds))
    return BhashaDrivePipelineV2(model, MockVehicleAdapter(config.limits), asr, config, store, matcher, rt.profile_id)
