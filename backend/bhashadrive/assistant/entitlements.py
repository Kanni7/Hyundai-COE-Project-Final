"""Who may use the premium voice pipeline. Decided on the server only: the client never states its own tier.

Sources, in order:
1. A bearer token listed in the entitlements file (BD_ENTITLEMENTS_FILE), written by whatever issues subscriptions:
   {"<token>": {"tier": "premium", "expires": "2026-12-31T23:59:59Z", "subject": "user-42"}}. Expired -> free.
2. Development only (BD_DEV_TIER_SWITCH=true): a tier the local UI picked, honoured for loopback requests only.
3. Otherwise free.
No payment integration exists: this is the interface a billing system would feed.
"""
from __future__ import annotations

import hmac
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from ..config import AssistantConfig

TIERS = ("free", "premium")
LOOPBACK = {"127.0.0.1", "::1", "localhost", "testclient"}


@dataclass(frozen=True)
class Entitlement:
    tier: str
    subject: str
    source: str  # token | dev | default
    expired: bool = False


class Entitlements:
    def __init__(self, config: AssistantConfig):
        self.config = config
        self._dev_tier = config.dev_default_tier if config.dev_default_tier in TIERS else "free"
        self._tokens: dict[str, dict] = {}
        self._mtime: float | None = None

    def _load(self) -> dict[str, dict]:
        f: Path | None = self.config.entitlements_file
        if f is None or not f.exists():
            return {}
        m = f.stat().st_mtime
        if m != self._mtime:  # re-read when the issuer updates the file
            data = json.loads(f.read_text(encoding="utf-8"))
            self._tokens = {str(k): v for k, v in data.items() if isinstance(v, dict)}
            self._mtime = m
        return self._tokens

    def resolve(self, authorization: str | None, client_host: str | None) -> Entitlement:
        token = authorization[7:].strip() if authorization and authorization.lower().startswith("bearer ") else ""
        if token:
            for known, rec in self._load().items():
                if hmac.compare_digest(known.encode(), token.encode()):
                    subject = str(rec.get("subject") or f"token:{known[:4]}")
                    expires = rec.get("expires")
                    expired = bool(expires) and datetime.fromisoformat(str(expires).replace("Z", "+00:00")) <= datetime.now(timezone.utc)
                    tier = rec.get("tier") if rec.get("tier") in TIERS and not expired else "free"
                    return Entitlement(tier, subject, "token", expired)
            return Entitlement("free", "anonymous", "default")  # unknown token: no premium
        if self.config.dev_tier_switch and client_host in LOOPBACK:
            return Entitlement(self._dev_tier, "dev-local", "dev")
        return Entitlement("free", "anonymous", "default")

    def set_dev_tier(self, tier: str, client_host: str | None) -> None:
        if not self.config.dev_tier_switch or client_host not in LOOPBACK:
            raise PermissionError("tier switch is disabled")
        if tier not in TIERS:
            raise ValueError(f"unknown tier {tier}")
        self._dev_tier = tier
