"""Minimal Telegram Bot API client.

The bot token is part of every request URL, so nothing here ever logs or
re-raises a URL: errors carry the method name and Telegram's description only.
"""

import json
import urllib.error
import urllib.request


class TelegramError(Exception):
    def __init__(self, method: str, description: str):
        super().__init__(f"{method}: {description}")
        self.method = method
        self.description = description


class Telegram:
    def __init__(self, token: str):
        self._base = f"https://api.telegram.org/bot{token}/"

    def call(self, method: str, _http_timeout: float = 30, **params):
        body = json.dumps({k: v for k, v in params.items() if v is not None}).encode()
        req = urllib.request.Request(
            self._base + method,
            data=body,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=_http_timeout) as resp:
                data = json.load(resp)
        except urllib.error.HTTPError as e:
            try:
                description = json.load(e).get("description", f"HTTP {e.code}")
            except Exception:
                description = f"HTTP {e.code}"
            raise TelegramError(method, description) from None
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise TelegramError(method, type(e).__name__) from None
        if not data.get("ok"):
            raise TelegramError(method, data.get("description", "not ok"))
        return data["result"]

    def get_updates(self, offset: int | None, timeout: int = 50) -> list[dict]:
        return self.call(
            "getUpdates",
            _http_timeout=timeout + 10,
            offset=offset,
            timeout=timeout,
            allowed_updates=["message", "my_chat_member", "chat_member"],
        )

    def send(self, chat_id: int, text: str, reply_to: int | None = None) -> None:
        # Telegram caps messages at 4096 characters.
        for i in range(0, max(len(text), 1), 4000):
            self.call(
                "sendMessage",
                chat_id=chat_id,
                text=text[i : i + 4000],
                reply_parameters={"message_id": reply_to, "allow_sending_without_reply": True}
                if reply_to and i == 0
                else None,
            )
