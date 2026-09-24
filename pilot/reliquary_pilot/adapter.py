"""The Telegram adapter: the only code that says who is speaking and who is in
a chat. Everything it asserts comes from updates pulled from Telegram over TLS,
never from message text.

Telegram can't list a group's members, only count them. So the adapter builds
the participant list from people it can verify with getChatMember (every
linked person, admins, anyone seen speaking or joining) and reports the
platform's count alongside it. If the two don't match, the gate treats the
group as public-only.
"""

import logging
import time
import uuid

import psycopg

from .telegram import Telegram, TelegramError

log = logging.getLogger(__name__)

CHANNEL = "telegram"
RESYNC_SECONDS = 5 * 60
MAX_PRESENCE_CHECKS = 200
PRESENT = {"creator", "administrator", "member"}


def ext(user_id: int) -> str:
    return f"tg:{user_id}"


class Adapter:
    def __init__(self, conn: psycopg.Connection, tg: Telegram, me: dict, token_id: str):
        self.conn = conn
        self.tg = tg
        self.me = me
        self.token_id = token_id
        self._synced_at: dict[int, float] = {}
        self._seen_humans: dict[int, set[int]] = {}
        self._seen_bots: dict[int, set[int]] = {}
        self._versions: dict[int, int] = {}
        self._last_synced: dict[int, tuple[frozenset, frozenset]] = {}

    def version(self, chat_id: int) -> int:
        """Changes whenever a chat's participant list changes, so callers can
        drop conversation history that was said to a different audience."""
        return self._versions.get(chat_id, 0)

    def register(self, chat: dict) -> None:
        kind = "dm" if chat["type"] == "private" else "group"
        title = chat.get("title") or chat.get("first_name") or str(chat["id"])
        with self.conn.transaction():
            self.conn.execute(
                "select app.register_chat(%s, %s, %s, %s, %s)",
                [CHANNEL, str(chat["id"]), kind, title, self.token_id],
            )

    def note_membership(self, chat_id: int, joined: list[dict], left: list[dict]) -> None:
        humans = self._seen_humans.setdefault(chat_id, set())
        bots = self._seen_bots.setdefault(chat_id, set())
        for user in joined:
            (bots if user.get("is_bot") else humans).add(user["id"])
        for user in left:
            humans.discard(user["id"])
            bots.discard(user["id"])
        self._synced_at.pop(chat_id, None)

    def sync(self, chat: dict, sender_id: int, force: bool = False) -> None:
        chat_id = chat["id"]
        self._seen_humans.setdefault(chat_id, set()).add(sender_id)
        fresh = time.monotonic() - self._synced_at.get(chat_id, float("-inf")) < RESYNC_SECONDS
        if fresh and not force:
            return

        if chat["type"] == "private":
            humans, bots, count = [sender_id], [self.me["id"]], None
        else:
            humans, bots, count = self._verify_group(chat_id, sender_id)

        with self.conn.transaction():
            self.conn.execute(
                "select app.sync_chat(%s, %s, %s::text[], %s::text[], %s::int)",
                [CHANNEL, str(chat_id), [ext(h) for h in humans], [ext(b) for b in bots], count],
            )
        self._seen_humans[chat_id] = set(humans)
        self._seen_bots[chat_id] = set(bots)
        now = (frozenset(humans), frozenset(bots))
        if self._last_synced.get(chat_id) != now:
            self._last_synced[chat_id] = now
            self._versions[chat_id] = self.version(chat_id) + 1
        self._synced_at[chat_id] = time.monotonic()
        log.info("synced chat=%s humans=%d bots=%d count=%s", chat_id, len(humans), len(bots), count)

    def _verify_group(self, chat_id: int, sender_id: int) -> tuple[list[int], list[int], int]:
        count = self.tg.call("getChatMemberCount", chat_id=chat_id)
        candidates = set(self._seen_humans.get(chat_id, ())) | set(self._seen_bots.get(chat_id, ()))
        with self.conn.transaction():
            for (linked,) in self.conn.execute("select app.linked_ids(%s)", [CHANNEL]):
                if linked.startswith("tg:"):
                    candidates.add(int(linked[3:]))
        try:
            for admin in self.tg.call("getChatAdministrators", chat_id=chat_id):
                candidates.add(admin["user"]["id"])
        except TelegramError as e:
            log.warning("getChatAdministrators failed chat=%s: %s", chat_id, e.description)

        # Telegram just delivered the sender's message from this chat, which
        # is proof enough that they're in it.
        humans, bots = [sender_id], [self.me["id"]]
        for user_id in list(candidates - {sender_id, self.me["id"]})[:MAX_PRESENCE_CHECKS]:
            try:
                m = self.tg.call("getChatMember", chat_id=chat_id, user_id=user_id)
            except TelegramError:
                # Unverifiable means not counted: the count check then fails
                # closed to public-only.
                continue
            present = m["status"] in PRESENT or (m["status"] == "restricted" and m.get("is_member"))
            if present:
                (bots if m["user"].get("is_bot") else humans).append(user_id)
        return humans, bots, count

    def issue_ticket(self, chat_id: int, sender_id: int, message_id: int) -> uuid.UUID:
        with self.conn.transaction():
            (ticket,) = self.conn.execute(
                "select app.issue_ticket(%s, %s, %s, %s, %s)",
                [CHANNEL, str(chat_id), self.token_id, ext(sender_id), f"{chat_id}:{message_id}"],
            ).fetchone()
        return ticket

    def link(self, sender_id: int, code: str) -> bool:
        with self.conn.transaction():
            (ok,) = self.conn.execute(
                "select app.link_identity(%s, %s, %s)", [CHANNEL, ext(sender_id), code]
            ).fetchone()
        return bool(ok)
