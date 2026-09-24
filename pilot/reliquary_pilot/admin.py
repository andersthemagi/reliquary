"""Admin CLI for the pilot. Runs as the database owner, never inside the bot.

    python -m reliquary_pilot.admin <command> [args]

Stand-in for the dashboard: people, spaces, grants, chat bindings and
approved (canon) entries. Adding an entry here is the human approval.
"""

import argparse
import hashlib
import secrets
import string

from . import config

CODE_ALPHABET = "".join(c for c in string.ascii_uppercase + string.digits if c not in "0O1IL")


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def one(conn, sql: str, params=(), what: str = "row"):
    rows = conn.execute(sql, params).fetchall()
    if len(rows) != 1:
        raise SystemExit(f"expected exactly one {what}, found {len(rows)}")
    return rows[0]


def member_id(conn, name: str):
    return one(conn, "select id from app.members where display_name = %s", [name], f"member '{name}'")[0]


def space_id(conn, name: str):
    return one(conn, "select id from app.spaces where name = %s", [name], f"space '{name}'")[0]


def chat_id(conn, ref: str):
    return one(
        conn,
        "select id from app.chats where external_chat_id = %s or title = %s",
        [ref, ref],
        f"chat '{ref}'",
    )[0]


def main() -> None:
    p = argparse.ArgumentParser(prog="admin")
    sub = p.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("create-bot", help="create the bot's agent token (printed once)")
    b.add_argument("name")
    s = sub.add_parser("add-space")
    s.add_argument("name")
    s.add_argument("--public", action="store_true")
    m = sub.add_parser("add-member")
    m.add_argument("name")
    j = sub.add_parser("join", help="add a member to a space")
    j.add_argument("space")
    j.add_argument("member")
    j.add_argument("--role", default="collaborator", choices=["owner", "collaborator", "viewer"])
    l = sub.add_parser("link-code", help="one-time code a member sends the bot with /link")
    l.add_argument("member")
    g = sub.add_parser("grant", help="let the bot read a space (and optionally capture into it)")
    g.add_argument("space")
    g.add_argument("--capture", action="store_true")
    bd = sub.add_parser("bind", help="bind a group chat to a space")
    bd.add_argument("chat", help="chat title or Telegram chat id")
    bd.add_argument("space")
    e = sub.add_parser("add-entry", help="add an approved (canon) entry")
    e.add_argument("space")
    e.add_argument("title")
    e.add_argument("body")
    e.add_argument("--by", default="admin", help="approver shown with the entry")
    sub.add_parser("chats", help="list chats, bindings and gate inputs")
    le = sub.add_parser("entries")
    le.add_argument("space")
    args = p.parse_args()

    conn = config.connect("owner")
    with conn.transaction():
        if args.cmd == "create-bot":
            token = "rlq_" + secrets.token_urlsafe(32)
            (tid,) = conn.execute(
                "insert into app.agent_tokens (name, token_hash) values (%s, %s) returning id",
                [args.name, sha256(token)],
            ).fetchone()
            print(f"RELIQUARY_TOKEN_ID={tid}")
            print(f"RELIQUARY_AGENT_TOKEN={token}")
        elif args.cmd == "add-space":
            conn.execute("insert into app.spaces (name, is_public) values (%s, %s)", [args.name, args.public])
            print(f"space {args.name} added")
        elif args.cmd == "add-member":
            conn.execute("insert into app.members (display_name) values (%s)", [args.name])
            print(f"member {args.name} added")
        elif args.cmd == "join":
            conn.execute(
                "insert into app.space_members (space_id, member_id, role) values (%s, %s, %s) "
                "on conflict (space_id, member_id) do update set role = excluded.role",
                [space_id(conn, args.space), member_id(conn, args.member), args.role],
            )
            print(f"{args.member} is {args.role} in {args.space}")
        elif args.cmd == "link-code":
            code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
            conn.execute(
                "insert into app.link_codes (code_hash, member_id) values (%s, %s)",
                [sha256(code), member_id(conn, args.member)],
            )
            print(f"Send the bot, in a private chat:  /link {code}   (valid 24h, single use)")
        elif args.cmd == "grant":
            (tid,) = one(conn, "select id from app.agent_tokens where revoked_at is null", what="active bot token")
            conn.execute(
                "insert into app.agent_token_spaces (token_id, space_id, can_read, can_capture) "
                "values (%s, %s, true, %s) on conflict (token_id, space_id) "
                "do update set can_read = true, can_capture = excluded.can_capture",
                [tid, space_id(conn, args.space), args.capture],
            )
            print(f"bot can read {args.space}" + (" and capture into it" if args.capture else ""))
        elif args.cmd == "bind":
            conn.execute(
                "update app.chats set space_id = %s where id = %s and kind = 'group'",
                [space_id(conn, args.space), chat_id(conn, args.chat)],
            )
            print(f"{args.chat} bound to {args.space}")
        elif args.cmd == "add-entry":
            conn.execute(
                "insert into app.entries (space_id, title, body, kind, author_label) "
                "values (%s, %s, %s, 'canon', %s)",
                [space_id(conn, args.space), args.title, args.body, args.by],
            )
            print("entry added")
        elif args.cmd == "chats":
            rows = conn.execute(
                """
                select c.kind, c.external_chat_id, c.title, s.name, c.reported_member_count,
                       count(p.*) filter (where not p.is_bot),
                       count(p.*) filter (where not p.is_bot and i.member_id is null),
                       c.members_synced_at
                from app.chats c
                left join app.spaces s on s.id = c.space_id
                left join app.chat_participants p on p.chat_id = c.id
                left join app.identities i
                  on i.channel = c.channel and i.external_id = p.external_id
                group by c.id, s.name order by c.kind, c.title
                """
            ).fetchall()
            for kind, ext, title, space, count, humans, unlinked, synced in rows:
                print(f"{kind:5} {ext:>15}  {title!s:24} space={space or '-':12} "
                      f"members={count if count is not None else '-'} humans={humans} "
                      f"unlinked={unlinked} synced={synced:%H:%M}")
        elif args.cmd == "entries":
            for title, kind, author, created in conn.execute(
                "select title, kind, author_label, created_at from app.entries "
                "where space_id = %s order by created_at desc",
                [space_id(conn, args.space)],
            ):
                print(f"{created:%Y-%m-%d} {kind:11} {author or '-':10} {title}")


if __name__ == "__main__":
    main()
