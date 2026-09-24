"""Settings from the environment, and one database connection per role.

The bot process holds three connections, each logged in as its own role
(adapter, minter, agent). They share a process, so this separation guards
against bugs, not a compromised process: a code path holding the agent
connection cannot issue tickets or change membership. Splitting the adapter
into its own process later makes it a real trust boundary.
"""

import os
from dataclasses import dataclass

import psycopg


def _env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if not value:
        raise SystemExit(f"missing setting: {name}")
    return value


@dataclass(frozen=True)
class Settings:
    telegram_token: str
    agent_token: str
    token_id: str
    model: str
    effort: str

    @classmethod
    def load(cls) -> "Settings":
        return cls(
            telegram_token=_env("TELEGRAM_BOT_TOKEN"),
            agent_token=_env("RELIQUARY_AGENT_TOKEN"),
            token_id=_env("RELIQUARY_TOKEN_ID"),
            model=_env("RELIQUARY_MODEL", "claude-opus-5"),
            effort=_env("RELIQUARY_EFFORT", "low"),
        )


def connect(role: str) -> psycopg.Connection:
    """role is 'adapter', 'minter', 'agent' or 'owner' (admin CLI only)."""
    user = "postgres" if role == "owner" else f"reliquary_{role}"
    return psycopg.connect(
        host=_env("PGHOST", "127.0.0.1"),
        port=int(_env("PGPORT", "54329")),
        dbname=_env("PGDATABASE", "reliquary"),
        user=user,
        password=_env(f"PG_{role.upper()}_PASSWORD"),
        autocommit=False,
    )
