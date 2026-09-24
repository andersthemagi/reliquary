"""End-to-end smoke test: the real bot, adapter and gate against a real
database, with a fake Telegram and a fake model that reports what context it
was given. Run with ./run.sh smoke (uses a throwaway database).
"""

import hashlib
import io
import logging

from . import config
from .adapter import Adapter
from .bot import Bot
from .gate import Gate
from .telegram import TelegramError

ME = {"id": 999, "is_bot": True, "first_name": "Reli", "username": "reliquary_bot"}
ANA, BEN, CAL, DEE = (
    {"id": i, "is_bot": False, "first_name": n} for i, n in [(1, "Ana"), (2, "Ben"), (3, "Cal"), (4, "Dee")]
)
GROUP = {"id": -100, "type": "group", "title": "Team"}
AGENT_TOKEN = "rlq_smoke_token"


class FakeTelegram:
    def __init__(self):
        self.members = {ANA["id"], BEN["id"]}
        self.sent: list[tuple[int, str]] = []

    def call(self, method, _http_timeout=30, **p):
        if method == "getChatMemberCount":
            return len(self.members) + 1  # + the bot
        if method == "getChatAdministrators":
            return []
        if method == "getChatMember":
            if p["user_id"] in self.members:
                return {"status": "member", "user": {"id": p["user_id"], "is_bot": False}}
            raise TelegramError(method, "user not found")
        if method == "sendMessage":
            self.sent.append((p["chat_id"], p["text"]))
            return {}
        if method == "sendChatAction":
            return True
        raise AssertionError(method)

    def send(self, chat_id, text, reply_to=None):
        self.call("sendMessage", chat_id=chat_id, text=text)

    def last(self) -> str:
        return self.sent[-1][1]


class FakeModel:
    """Answers with the context block it was shown, so tests can check it."""

    def __init__(self):
        self.seen: list[list[dict]] = []

    def answer(self, system, messages):
        self.seen.append(messages)
        return "MODEL SAW: " + messages[-1]["content"]


def dm(user):
    return {"id": user["id"], "type": "private", "first_name": user["first_name"]}


_mid = 0


def message(chat, user, text=None, **extra):
    global _mid
    _mid += 1
    msg = {"message_id": _mid, "chat": chat, "from": user, **extra}
    if text is not None:
        msg["text"] = text
    return {"update_id": _mid, "message": msg}


results: list[tuple[str, bool]] = []


def check(name: str, ok: bool) -> None:
    results.append((name, ok))


def main() -> None:
    log_buffer = io.StringIO()
    logging.basicConfig(level=logging.INFO, stream=log_buffer)

    owner = config.connect("owner")
    with owner.transaction():
        (token_id,) = owner.execute(
            "insert into app.agent_tokens (name, token_hash) values ('smoke', %s) returning id",
            [hashlib.sha256(AGENT_TOKEN.encode()).hexdigest()],
        ).fetchone()
        owner.execute("insert into app.spaces (name, is_public) values ('team', false), ('pub', true)")
        for m in ("Ana", "Ben", "Cal"):
            owner.execute("insert into app.members (display_name) values (%s)", [m])
        owner.execute(
            "insert into app.space_members (space_id, member_id, role) "
            "select s.id, m.id, 'collaborator' from app.spaces s, app.members m "
            "where s.name = 'team' and m.display_name in ('Ana', 'Ben')"
        )
        owner.execute(
            "insert into app.agent_token_spaces (token_id, space_id, can_read, can_capture) "
            "select %s, id, true, name = 'team' from app.spaces",
            [token_id],
        )
        owner.execute(
            "insert into app.entries (space_id, title, body, kind, author_label) "
            "select id, 'Standup', 'Standup is at 10:00 in room B', 'canon', 'Andrés' from app.spaces where name = 'team' "
            "union all "
            "select id, 'Venue', 'The venue opens at 9', 'canon', 'Andrés' from app.spaces where name = 'pub'"
        )
        for code, name in [("ANACODE1", "Ana"), ("BENCODE1", "Ben")]:
            owner.execute(
                "insert into app.link_codes (code_hash, member_id) "
                "select %s, id from app.members where display_name = %s",
                [hashlib.sha256(code.encode()).hexdigest(), name],
            )

    tg, model = FakeTelegram(), FakeModel()
    adapter = Adapter(config.connect("adapter"), tg, ME, str(token_id))
    gate = Gate(config.connect("minter"), config.connect("agent"), AGENT_TOKEN)
    bot = Bot(tg, adapter, gate, model)

    # Linking
    bot.handle(message(dm(ANA), ANA, "/link anacode1"))
    check("link: Ana links in a DM", tg.last() == "Linked. Welcome.")
    bot.handle(message(dm(BEN), BEN, "/link BENCODE1"))
    bot.handle(message(dm(BEN), BEN, "/link BENCODE1"))
    check("link: a code works once", tg.last().startswith("That code didn't work"))
    bot.handle(message(GROUP, ANA, "/link ANACODE1"))
    check("link: refused in a group", "private chat" in tg.last())

    # Unbound group: public only
    bot.handle(message(GROUP, ANA, "@reliquary_bot when is standup?"))
    check("unbound group: sees public", "venue opens at 9" in tg.last())
    check("unbound group: not the team space", "Standup is at 10" not in tg.last())

    with owner.transaction():
        owner.execute(
            "update app.chats set space_id = (select id from app.spaces where name = 'team') "
            "where external_chat_id = %s",
            [str(GROUP["id"])],
        )

    bot.handle(message(GROUP, ANA, "@reliquary_bot when is standup?"))
    check("bound, complete group: sees team space", "Standup is at 10" in tg.last())

    bot.handle(message(GROUP, BEN, "/status"))
    check("status: explains full access", "Everyone here is linked" in tg.last())

    bot.handle(message(GROUP, BEN, "/remember pizza on Friday after the talk"))
    check("remember: noted in a complete group", tg.last().startswith("Noted"))
    bot.handle(message(GROUP, ANA, "@reliquary_bot anything about pizza?"))
    check("remember: recalled with its author",
          "pizza on Friday" in tg.last() and 'author="Ben"' in tg.last())

    bot.handle(message(dm(ANA), ANA, "pizza plans?"))
    check("DM: Ana, who heard it, recalls it privately", "pizza on Friday" in tg.last())

    # Cal (unlinked) joins
    tg.members.add(CAL["id"])
    bot.handle(message(GROUP, CAL, new_chat_members=[CAL]))
    bot.handle(message(GROUP, ANA, "@reliquary_bot when is standup and what about pizza?"))
    answer = tg.last()
    check("joiner: unlinked member drops the group to public",
          "Standup is at 10" not in answer and "pizza on Friday" not in answer and "venue" in answer)
    earlier = [m["content"] for m in model.seen[-1][:-1]]
    check("joiner: history from before Cal joined is not replayed",
          not any("Standup" in c or "pizza" in c for c in earlier))
    bot.handle(message(GROUP, ANA, "/remember secret plan"))
    check("joiner: remember refused while someone is unlinked", "can't note that" in tg.last())
    bot.handle(message(GROUP, ANA, "/status"))
    check("status: says why", "haven't linked" in tg.last())

    # Unlinked person in a DM
    bot.handle(message(dm(DEE), DEE, "when is standup?"))
    check("unlinked DM: public only", "Standup is at 10" not in tg.last() and "venue" in tg.last())

    # Ben leaves; Cal leaves: group is complete again (Ana alone + bot)
    tg.members -= {BEN["id"], CAL["id"]}
    bot.handle(message(GROUP, BEN, left_chat_member=BEN))
    bot.handle(message(GROUP, CAL, left_chat_member=CAL))
    bot.handle(message(GROUP, ANA, "@reliquary_bot pizza?"))
    check("leave: Ana alone sees the team space again", "Standup is at 10" in tg.last())
    check("leave: Ben's remark was said to Ana and Ben, so Ana alone still sees it",
          "pizza on Friday" in tg.last())

    logs = log_buffer.getvalue()
    check("logs: no entry text, message text or token",
          not any(s in logs for s in ("Standup", "pizza", "venue", AGENT_TOKEN, "ANACODE1")))

    width = max(len(n) for n, _ in results)
    for name, ok in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name:{width}}")
    failed = sum(not ok for _, ok in results)
    print(f"\n{len(results) - failed}/{len(results)} passed")
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
