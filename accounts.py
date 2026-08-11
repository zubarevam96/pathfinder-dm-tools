"""The account store: who has signed in, and what they asked us to keep.

SQLite, for the same reason the bot uses it: a tabletop group is a handful of
rows, and a file on the volume this service already mounts costs nothing to run.
Keycloak has Postgres because Keycloak insists; this does not.

**Keycloak owns authentication, this owns the profile.** The split matters when
deciding where a new field goes:

- Keycloak holds the password, the email as a *login credential*, and the
  session. Nothing here can read or set a password, by construction.
- This holds the row the application hangs off — ``telegram_id`` above all,
  which is the one field that has to line up with the bot's Telegram-keyed
  database later. Putting it in a Keycloak user attribute would have meant
  declaring it in Keycloak's user-profile config and reading it back out
  through a second API, to end up with the same value in a worse place.

``email`` is therefore a *mirror*: Keycloak is canonical, and this copy is
refreshed from the ID token on every sign-in and after every change. Read it
for display; never treat it as the identity. The identity is ``subject``, the
Keycloak ``sub`` claim, which never changes even when the address does.
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

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY,
    subject     TEXT    NOT NULL UNIQUE,
    email       TEXT,
    telegram_id INTEGER UNIQUE,
    created_at  REAL    NOT NULL,
    updated_at  REAL    NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id                TEXT    PRIMARY KEY,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    access_token      TEXT,
    refresh_token     TEXT,
    access_expires_at REAL    NOT NULL DEFAULT 0,
    created_at        REAL    NOT NULL,
    seen_at           REAL    NOT NULL
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
            connection.executescript(SCHEMA)

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

    def upsert_user(self, subject: str, email: str | None) -> sqlite3.Row:
        """The row for this Keycloak subject, created on first sign-in.

        ``telegram_id`` is deliberately untouched: it is not Keycloak's to
        know, and a re-sign-in must never clear a link someone has made.
        """
        now = time.time()
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO users (subject, email, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(subject) DO UPDATE SET
                    email = excluded.email,
                    updated_at = excluded.updated_at
                """,
                (subject, email, now, now),
            )
            return connection.execute(
                "SELECT * FROM users WHERE subject = ?", (subject,)
            ).fetchone()

    def user(self, user_id: int) -> sqlite3.Row | None:
        with self._connect() as connection:
            return connection.execute(
                "SELECT * FROM users WHERE id = ?", (user_id,)
            ).fetchone()

    def set_email(self, user_id: int, email: str | None) -> None:
        """Mirror an address Keycloak has already accepted. Not a change itself."""
        with self._connect() as connection:
            connection.execute(
                "UPDATE users SET email = ?, updated_at = ? WHERE id = ?",
                (email, time.time(), user_id),
            )

    def set_telegram_id(self, user_id: int, telegram_id: int | None) -> None:
        """TODO: nothing calls this yet.

        It is the join to the bot's database, whose every table keys on
        ``persons.telegram_id``. Until something proves the person here and the
        person in Telegram are the same — a code issued in chat, most likely —
        writing this would be asserting a link nobody verified.
        """
        with self._connect() as connection:
            connection.execute(
                "UPDATE users SET telegram_id = ?, updated_at = ? WHERE id = ?",
                (telegram_id, time.time(), user_id),
            )

    # -- sessions ------------------------------------------------------------

    def create_session(
        self,
        user_id: int,
        access_token: str | None,
        refresh_token: str | None,
        access_expires_at: float,
    ) -> str:
        session_id = secrets.token_urlsafe(SESSION_ID_BYTES)
        now = time.time()
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO sessions
                    (id, user_id, access_token, refresh_token,
                     access_expires_at, created_at, seen_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    user_id,
                    access_token,
                    refresh_token,
                    access_expires_at,
                    now,
                    now,
                ),
            )
        return session_id

    def session(self, session_id: str) -> sqlite3.Row | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT sessions.*, users.subject, users.email, users.telegram_id
                FROM sessions JOIN users ON users.id = sessions.user_id
                WHERE sessions.id = ?
                """,
                (session_id,),
            ).fetchone()
            if row is not None:
                connection.execute(
                    "UPDATE sessions SET seen_at = ? WHERE id = ?",
                    (time.time(), session_id),
                )
            return row

    def refresh_session(
        self, session_id: str, access_token: str, refresh_token: str | None, expires_at: float
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE sessions
                SET access_token = ?, refresh_token = ?, access_expires_at = ?
                WHERE id = ?
                """,
                (access_token, refresh_token, expires_at, session_id),
            )

    def delete_session(self, session_id: str) -> None:
        with self._connect() as connection:
            connection.execute("DELETE FROM sessions WHERE id = ?", (session_id,))

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
