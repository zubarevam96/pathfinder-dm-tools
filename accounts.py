"""The account store: who may use this site, and what they asked us to keep.

SQLite, for the same reason the bot uses it: a tabletop group is a handful of
rows, and a file on the volume this service already mounts costs nothing to run.

**The bot owns identity; this owns access.** The split is what decides where a
new field goes:

- The bot knows *who* somebody is. Telegram proved it to them, and spending a
  ``/link`` code at ``POST /auth/pair`` is how that proof reaches a browser.
  Nothing in this file can establish who anybody is, by construction.
- This knows *whether they may use this site* — the ``allowed`` flag — and holds
  the row the application hangs its documents off.

``telegram_id`` is the identity, and it is the same integer the bot keys every
one of its own tables on. That is the point: a character imported in a chat and
one opened here are the same character because they are the same person, and
this column is where that stops being a coincidence.

**It is never taken from the browser.** The only writer is a pairing code
redeemed *server side*, in the one exchange where the bot is the thing saying
who this is. A telegram_id a page claimed would be somebody else's characters
handed over on request.

``display_name`` and ``username`` mirror whatever Telegram last told the bot.
Show them; never key on them. People rename themselves and give up handles, and
the id never changes.
"""

from __future__ import annotations

import json
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

#: Names ``documents`` will accept. A closed set on purpose: the store is a
#: per-user key/value of opaque JSON, and without this it would grow into a
#: place to put anything, with no schema and no way to tell live keys from
#: abandoned ones. Both mirror a localStorage key the two pages already own.
DOCUMENT_NAMES = frozenset({"characters", "battles"})

#: Long enough that guessing is not a strategy: 32 bytes, URL-safe.
SESSION_ID_BYTES = 32

#: Bumped whenever the tables below change shape, and a bump **drops and
#: rebuilds** rather than migrating -- see :meth:`Accounts._apply_schema`.
#:
#: That is a deliberate trade, not laziness. Everything here is either a copy of
#: data the browser holds canonically (``documents``) or something one ``/link``
#: code rebuilds in ten seconds (``users``, ``sessions``). Against that, a
#: migration is more code than the data is worth and strictly more ways to be
#: subtly wrong. If this ever stores something the browser cannot recreate, that
#: reasoning expires and this needs to become a real migration.
#:
#: Version 2 dropped Keycloak: ``users`` was keyed on the OIDC ``sub`` claim
#: with an email beside it, and is now keyed on ``telegram_id``.
SCHEMA_VERSION = 2

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY,
    telegram_id  INTEGER NOT NULL UNIQUE,
    display_name TEXT,
    username     TEXT,
    allowed      INTEGER NOT NULL DEFAULT 1,
    created_at   REAL    NOT NULL,
    updated_at   REAL    NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bot_token  TEXT,
    created_at REAL    NOT NULL,
    seen_at    REAL    NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS documents (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL,
    body       TEXT    NOT NULL,
    updated_at REAL    NOT NULL,
    PRIMARY KEY (user_id, name)
);
"""

#: Dropped in dependency order, so the foreign keys above never refuse.
DROP = """
DROP TABLE IF EXISTS documents;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
"""


class Accounts:
    """Every read and write the account store does.

    A connection is opened per operation rather than held. SQLite connections
    are not safe to share across threads, and gunicorn serves this from several
    — a pool would be the usual answer, but at this traffic the open costs less
    than the bugs a pool's lifetime rules would introduce.
    """

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            # WAL so a reader never blocks on the writer. The site polls nothing,
            # but a push and a page load can still overlap.
            connection.execute("PRAGMA journal_mode = WAL")
            self._apply_schema(connection)

    @staticmethod
    def _apply_schema(connection: sqlite3.Connection) -> None:
        """Bring the file up to :data:`SCHEMA_VERSION`, rebuilding if it is behind.

        ``user_version`` is SQLite's own four bytes of header set aside for
        exactly this and costs no table to read. A fresh file reports 0, so a
        first run takes the same path as an upgrade — the drops are all
        ``IF EXISTS`` and do nothing on an empty file, which means there is one
        code path here rather than one that runs and one that only ever runs in
        production.
        """
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version < SCHEMA_VERSION:
            connection.executescript(DROP)
        connection.executescript(SCHEMA)
        # Not a parameter: PRAGMA does not take one. Safe because the value is
        # this module's own integer constant and never comes from outside.
        connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    @contextmanager
    def _connect(self):
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        # Off by default in SQLite, and the ON DELETE CASCADE above is the whole
        # reason sign-out-everywhere and account deletion stay one statement.
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    # -- users ---------------------------------------------------------------

    def user_by_telegram_id(self, telegram_id: int) -> sqlite3.Row | None:
        """The row for a Telegram person, or None if they have never been here.

        None is not the same as "not allowed": the whitelist is consulted by the
        caller, which also has an environment variable to check. This only says
        whether a row exists.
        """
        with self._connect() as connection:
            return connection.execute(
                "SELECT * FROM users WHERE telegram_id = ?", (telegram_id,)
            ).fetchone()

    def touch_user(
        self, telegram_id: int, display_name: str | None, username: str | None
    ) -> sqlite3.Row:
        """The row for this person, created on first pairing, names refreshed.

        ``allowed`` is deliberately **not** in the UPDATE. This runs on every
        sign-in, and letting it write that column would mean each pairing quietly
        re-granted access that may have been taken away — the revocation would
        last exactly until its owner tried again.

        A row created here defaults to allowed, which is safe only because the
        caller has already decided this person may be here. Nothing calls this
        before that check.
        """
        now = time.time()
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO users (telegram_id, display_name, username, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(telegram_id) DO UPDATE SET
                    display_name = excluded.display_name,
                    username     = excluded.username,
                    updated_at   = excluded.updated_at
                """,
                (telegram_id, display_name, username, now, now),
            )
            return connection.execute(
                "SELECT * FROM users WHERE telegram_id = ?", (telegram_id,)
            ).fetchone()

    def everyone(self) -> list[sqlite3.Row]:
        """Every row, allowed or not, for the admin to read the list back.

        Revoked people are included rather than filtered. A whitelist you can
        only see the *allowed* half of cannot answer "did that removal work?",
        which is the question somebody asks immediately after making one.
        """
        with self._connect() as connection:
            return connection.execute(
                """
                SELECT * FROM users
                ORDER BY allowed DESC, COALESCE(display_name, username, ''), telegram_id
                """
            ).fetchall()

    def set_allowed(self, telegram_id: int, allowed: bool) -> sqlite3.Row:
        """Put somebody on the list, or take them off, without touching their data.

        A flag rather than a DELETE because ``documents`` cascades: removing
        access should not also throw away the characters somebody backed up, and
        the day a revocation turns out to be a mistake is the day that matters.
        """
        now = time.time()
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO users (telegram_id, allowed, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(telegram_id) DO UPDATE SET
                    allowed    = excluded.allowed,
                    updated_at = excluded.updated_at
                """,
                (telegram_id, 1 if allowed else 0, now, now),
            )
            return connection.execute(
                "SELECT * FROM users WHERE telegram_id = ?", (telegram_id,)
            ).fetchone()

    # -- sessions ------------------------------------------------------------

    def create_session(self, user_id: int, bot_token: str | None) -> str:
        """Start a signed-in session and return the id the cookie will carry.

        ``bot_token`` is this browser's token for the bot's API, kept here rather
        than handed to the page. The page never needs it — every call it makes
        goes through this service — and a token in ``localStorage`` is readable
        by any script that ever gets onto the page, permanently.
        """
        session_id = secrets.token_urlsafe(SESSION_ID_BYTES)
        now = time.time()
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO sessions (id, user_id, bot_token, created_at, seen_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (session_id, user_id, bot_token, now, now),
            )
        return session_id

    def session(self, session_id: str) -> sqlite3.Row | None:
        """The session behind a cookie, or None if it is over.

        ``users.allowed = 1`` is part of the lookup rather than something the
        caller checks afterwards. Taking somebody off the whitelist has to end
        the sessions they already have — otherwise a revocation does nothing at
        all until an open browser happens to sign out — and the caller reads this
        on every request precisely so that takes effect on the next one.

        Revoked and expired are answered identically, and by design: they call
        for the same thing from whoever is looking at the screen, and telling a
        stranger which of the two they hit says more than it needs to.
        """
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT sessions.*, users.telegram_id, users.display_name,
                       users.username, users.allowed
                FROM sessions JOIN users ON users.id = sessions.user_id
                WHERE sessions.id = ? AND users.allowed = 1
                """,
                (session_id,),
            ).fetchone()
            if row is not None:
                connection.execute(
                    "UPDATE sessions SET seen_at = ? WHERE id = ?",
                    (time.time(), session_id),
                )
            return row

    def delete_session(self, session_id: str) -> None:
        with self._connect() as connection:
            connection.execute("DELETE FROM sessions WHERE id = ?", (session_id,))

    def delete_sessions_for(self, telegram_id: int) -> int:
        """End every session this person has, and return how many there were.

        Called when somebody is taken off the whitelist. The join filter in
        :meth:`session` has already made those rows unusable, so this is not what
        enforces the revocation — it is what stops the rows *outliving* it. Each
        one holds a bot token, and leaving a revoked person's credentials in this
        database indefinitely is the kind of thing that is nobody's bug until it
        is everybody's.
        """
        with self._connect() as connection:
            cursor = connection.execute(
                """
                DELETE FROM sessions WHERE user_id IN (
                    SELECT id FROM users WHERE telegram_id = ?
                )
                """,
                (telegram_id,),
            )
            return cursor.rowcount

    # -- documents -----------------------------------------------------------

    def document(self, user_id: int, name: str) -> tuple[str, float] | None:
        """The stored blob and when it was written, or None if never written."""
        with self._connect() as connection:
            row = connection.execute(
                "SELECT body, updated_at FROM documents WHERE user_id = ? AND name = ?",
                (user_id, name),
            ).fetchone()
        return None if row is None else (row["body"], row["updated_at"])

    def put_document(self, user_id: int, name: str, body: str) -> float:
        """Replace the blob wholesale and return the time it was written.

        Whole documents, not chosen fields: the two pages grow keys of their own
        (persistent damage and monster adjustments both arrived this way), and a
        store that understood the shape would silently drop the ones it was
        written before.
        """
        if name not in DOCUMENT_NAMES:
            raise ValueError(f"Unknown document {name!r}")
        now = time.time()
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO documents (user_id, name, body, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id, name) DO UPDATE SET
                    body = excluded.body,
                    updated_at = excluded.updated_at
                """,
                (user_id, name, body, now),
            )
        return now

    def summary(self, user_id: int) -> dict[str, dict[str, object]]:
        """What is stored for this account, without sending it all back.

        The account page needs to say "23 characters, saved on Tuesday" without
        moving a megabyte of build JSON to do it.
        """
        out: dict[str, dict[str, object]] = {}
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT name, body, updated_at FROM documents WHERE user_id = ?",
                (user_id,),
            ).fetchall()
        for row in rows:
            out[row["name"]] = {
                "updated_at": row["updated_at"],
                "bytes": len(row["body"]),
                "count": _count_of(row["name"], row["body"]),
            }
        return out


def _count_of(name: str, body: str) -> int | None:
    """How many things are in a stored blob, for a one-line summary.

    Best-effort by design: the blob is the browser's shape, not this file's, so
    anything unrecognised counts as "can't say" rather than raising. A store
    that refused to describe itself because a key moved would be worse than one
    that shrugs.
    """
    try:
        parsed = json.loads(body)
    except ValueError:
        return None
    if name == "characters" and isinstance(parsed, dict):
        characters = parsed.get("characters")
        return len(characters) if isinstance(characters, list) else None
    if name == "battles" and isinstance(parsed, dict):
        battles = parsed.get("battles")
        return len(battles) if isinstance(battles, list) else None
    return None
