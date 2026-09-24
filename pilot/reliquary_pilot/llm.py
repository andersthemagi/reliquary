"""The model the bot answers with. Reliquary is model-agnostic: anything with
answer(system, messages) -> str | None works here. Claude is the first one.
"""

import logging
from typing import Protocol

import anthropic

log = logging.getLogger(__name__)


class Model(Protocol):
    def answer(self, system: str, messages: list[dict]) -> str | None: ...


class Claude:
    def __init__(self, model: str, effort: str):
        self.client = anthropic.Anthropic()
        self.model = model
        self.effort = effort

    def answer(self, system: str, messages: list[dict]) -> str | None:
        try:
            response = self.client.beta.messages.create(
                model=self.model,
                max_tokens=16000,
                thinking={"type": "adaptive"},
                output_config={"effort": self.effort},
                system=system,
                messages=messages,
                # On a safety decline, re-run on Anthropic's recommended
                # fallback model instead of returning a refusal.
                betas=["server-side-fallback-2026-07-01"],
                extra_body={"fallbacks": "default"},
            )
        except anthropic.RateLimitError:
            log.warning("model rate limited")
            return None
        except anthropic.APIStatusError as e:
            log.warning("model error status=%s", e.status_code)
            return None
        except anthropic.APIConnectionError:
            log.warning("model connection error")
            return None
        if response.stop_reason == "refusal":
            return None
        text = "".join(b.text for b in response.content if b.type == "text").strip()
        return text or None
