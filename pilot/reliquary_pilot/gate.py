"""Everything the bot reads or writes goes through here, as a minted session.

The minter connection turns (agent token, ticket) into a session id. The agent
connection then sets {"sid": ...} as its claims for one transaction; RLS does
the rest. Nothing in this module decides who may see what.
"""

import json
import re
import uuid
from dataclasses import dataclass
from datetime import datetime

import psycopg

STOPWORDS = {
    "the", "and", "for", "are", "was", "what", "when", "where", "who", "how",
    "does", "did", "that", "this", "with", "have", "has", "you", "your", "about",
    "que", "qué", "cuando", "cuándo", "donde", "dónde", "para", "con", "una",
    "los", "las", "del", "por", "como", "cómo",
}


@dataclass
class Entry:
    space: str
    title: str
    body: str
    kind: str
    author: str | None
    created_at: datetime


@dataclass
class ChatStatus:
    mode: str
    space: str | None
    members: int | None
    known: int
    unlinked: int


def _or_query(text: str) -> str | None:
    words = {w for w in re.findall(r"\w+", text.lower()) if len(w) > 2 and w not in STOPWORDS}
    return " | ".join(sorted(words)) or None


class Gate:
    def __init__(self, minter: psycopg.Connection, agent: psycopg.Connection, agent_token: str):
        self.minter = minter
        self.agent = agent
        self._token = agent_token

    def mint(self, ticket: uuid.UUID) -> uuid.UUID | None:
        with self.minter.transaction():
            row = self.minter.execute(
                "select session_id from app.mint_session(%s, %s)", [self._token, ticket]
            ).fetchone()
        return row[0] if row else None

    def _claims(self, sid: uuid.UUID) -> None:
        self.agent.execute(
            "select set_config('request.jwt.claims', %s, true)", [json.dumps({"sid": str(sid)})]
        )

    def retrieve(self, sid: uuid.UUID, question: str, limit: int = 12) -> list[Entry]:
        q = _or_query(question)
        with self.agent.transaction():
            self._claims(sid)
            rows = []
            if q:
                rows += self.agent.execute(
                    """
                    select s.name, e.title, e.body, e.kind, e.author_label, e.created_at, e.id
                    from app.entries e join app.spaces s on s.id = e.space_id
                    where e.tsv @@ to_tsquery('simple', %s)
                    order by ts_rank(e.tsv, to_tsquery('simple', %s)) desc
                    limit %s
                    """,
                    [q, q, limit],
                ).fetchall()
            rows += self.agent.execute(
                """
                select s.name, e.title, e.body, e.kind, e.author_label, e.created_at, e.id
                from app.entries e join app.spaces s on s.id = e.space_id
                order by e.created_at desc
                limit 8
                """
            ).fetchall()
        seen, out = set(), []
        for name, title, body, kind, author, created, entry_id in rows:
            if entry_id not in seen:
                seen.add(entry_id)
                out.append(Entry(name, title, body, kind, author, created))
        return out

    def capture(self, sid: uuid.UUID, body: str) -> bool:
        with self.agent.transaction():
            self._claims(sid)
            (entry_id,) = self.agent.execute("select app.capture_memory(%s)", [body]).fetchone()
        return entry_id is not None

    def status(self, sid: uuid.UUID) -> ChatStatus | None:
        with self.agent.transaction():
            self._claims(sid)
            row = self.agent.execute(
                "select mode, space, members, known, unlinked from app.explain_chat()"
            ).fetchone()
        return ChatStatus(*row) if row else None
