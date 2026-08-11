# Pathfinder DM Tools

## Setup

```
py -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

## Run

```
.venv\Scripts\python app.py
```

Open http://127.0.0.1:5000. Use the "+ New" button to add a character by
Pathbuilder 2e link (e.g. `https://pathbuilder2e.com/json.php?id=123456`) or
just its numeric ID (e.g. `123456`). The character page shows the saved
Pathbuilder ID and has a Refresh button to re-fetch the latest build.
Saved characters appear in the foldable sidebar list, organized by group;
click one to view its data. If a new character's name matches one already
saved, you'll be asked whether to keep both (copy, the default) or override
the existing entry.

Use "+ New Group" to create a group, then use the group dropdown on a
character's page to assign it — a character can belong to at most one group.
Use the Delete button on a character's page to remove it (with confirmation).

The character sheet computes PF2e modifiers and DCs (DC = 10 + modifier) for
abilities, saves, perception, and skills, with Roll buttons (d20 + modifier).
Recent rolls appear in the sidebar's Roll History.

All data (characters, groups, roll history) is stored in the browser's
localStorage, so each user only sees their own characters. Character fetches
go directly to Pathbuilder from the browser (it allows CORS); when the app is
served by the local Flask server, that server also acts as a fetch fallback
and offers old server-side `data/` for a one-time import into the browser.

## Campaign sync (DM assistant bot)

The ⇅ button stores characters and battles on the companion project's Railway
service — the same one the Telegram bot runs on — so a character imported in
chat and one opened here are **the same character**, and any browser you pair
sees your data.

Identity comes from Telegram, not from a login of its own:

1. Send `/link` to the bot in a private chat. It replies with an
   eight-character code, good for five minutes and for one browser.
2. Paste the code into the ⇅ dialog. That browser gets its own token.
3. `/sessions` in Telegram lists paired browsers and signs any of them out.

There is nothing to configure: this site forwards `/sync/` to the bot itself,
so the browser stays on one origin. The bot needs `WEB_ENABLED=true`; it does
**not** need a public domain or a CORS allowlist.

(The dialog still has a "Server address" control. It's for running the pages
without this server in front of them — point it at the bot's public address if
you keep one.)

**Send to server** uploads what's here; **Get from server** brings down what's
there and reloads. Characters are matched by name, the newer copy wins, and
**nothing is ever deleted on either side** — a character that exists in only
one place stays there. Battles are stored opaquely; the bot reads nothing
inside them, and which battle is *active* stays local to the browser.

If two browsers change one battle, the server refuses the second write rather
than merging — get from the server first, then send.

This replaced a Google Drive backup, which is gone. If you set one up, the
OAuth client in Google Cloud Console is now unused and can be deleted; the
site clears what it stored in the browser by itself.

## Accounts (Keycloak)

The 👤 button is a second, separate way in — an account on this site, for
someone who has never spoken to the bot. Authentication is [Keycloak][kc],
running as its own Railway service; everything else lives in a small SQLite
file beside the monster data.

**There is no sign-up page.** Accounts are created in the Keycloak admin
console, under the `pathfinder` realm. Turning public registration on is one
setting — `registrationAllowed` in Realm settings → Login — if you ever want it.

What an account holds: an email (Keycloak's, mirrored here for display) and a
**Telegram id, which is empty and does nothing yet**. That column is where this
account system and the bot's Telegram-keyed database are meant to meet; until
something can prove the person signed in here is the person in that chat,
filling it in would be asserting a link nobody checked. Both ways in stay.

**Personal info** (`/account/`) changes the email and starts a password change.
The password form is Keycloak's own, on Keycloak's origin — this site has no
password field anywhere in it, and never receives one.

**Send to account** and **Get from account** store and restore whole documents,
unlike ⇅'s per-character merge. Nothing uploads on its own; a restore asks
first, then reloads.

The browser never holds a token. The server runs the OpenID Connect flow and
sets an HttpOnly session cookie the page cannot read, so there is nothing on
the page for a script to steal.

Variables this service needs for any of it to work — with all three absent, the
👤 button doesn't appear and everything else behaves exactly as before:

| Variable | What it is |
|---|---|
| `KEYCLOAK_ISSUER` | `https://<keycloak-host>/realms/pathfinder` |
| `KEYCLOAK_CLIENT_ID` | `pathfinder-web` unless you renamed it |
| `KEYCLOAK_CLIENT_SECRET` | From the client's **Credentials** tab, after first boot |
| `SECRET_KEY` | Signs the session cookie. Any long random string; changing it signs everyone out |
| `ACCOUNTS_DB_PATH` | `/data/accounts.sqlite3` — **on the volume**, or accounts vanish on redeploy |

[kc]: https://www.keycloak.org/

## Deployment (Railway)

Railway is the only place this deploys now. One project, four services:

```
                    browser
                       │
         ┌─────────────┴──────────────┐
         │ redirect only, at sign-in  │
         ▼                            ▼
  keycloak.up.railway.app     pathfinder…up.railway.app
         │                            │  app.py: site, /sync/* proxy,
         ▼                            │  /auth/*, /api/account/*
     Postgres                         │
   (Keycloak's own)     private network│      volume: /data
                                       ▼      monster-data + accounts.sqlite3
                        dm-bot.railway.internal:8080
                              no public domain needed
```

The site's server is what makes that one origin for the browser: `/sync/*` is
proxied to the bot, and Keycloak is reached by *this server*, never by script.
The only time the browser leaves is the sign-in redirect itself.

**The site:**

1. In the **same Railway project** as the bot: New → GitHub Repo → this one.
   It builds from the root `Dockerfile`.
2. Variables:
   - `BOT_API_URL` = `http://<bot-service-name>.railway.internal:8080`
   - `MONSTER_DATA_DIR` = `/data/monster-data` (see below)
   - `ACCOUNTS_DB_PATH` = `/data/accounts.sqlite3`
   - the three `KEYCLOAK_*` variables and `SECRET_KEY` from the Accounts section
3. Settings → Networking → **Generate Domain**, port **8080**.
4. On the *bot* service you can now remove the public domain, and
   `WEB_CORS_ORIGINS` stops mattering — the proxy is server-to-server, so no
   `Origin` header is involved.

**Keycloak:**

1. Add a **Postgres** service (Railway's own, from the New menu). Railway names
   it something like `Postgres-f0lP`; **rename it to `Postgres` first**, before
   writing any variable that refers to it. See the warning below.
2. New → GitHub Repo → this one *again*, and set **Root Directory** to
   `keycloak/`. One repository, two services, two Dockerfiles. Without the
   root directory it silently builds the *site's* Dockerfile instead and comes
   up as a second copy of the site — gunicorn in the logs where Keycloak should
   be is the tell.
3. Variables: see the comment block at the top of `keycloak/railway.toml` —
   it lists every one, including the `${{Postgres.*}}` references.
4. Generate a domain for it, port **8080**, and set `KC_HOSTNAME` to that
   domain **as a full URL** (`https://…up.railway.app`). Keycloak builds its
   own redirect URLs from it, so a wrong value fails at the *end* of a login
   rather than the start, once the password has already been accepted.

> **A reference to a service that doesn't exist resolves to an empty string,
> not an error.** Write `${{Postgres.PGHOST}}` while the service is still
> called `Postgres-f0lP` and you get `jdbc:postgresql://:/` — no warning
> anywhere, and Keycloak fails at boot with a database error naming no host.
>
> Renaming the service afterwards does **not** repair it. Re-enter every
> affected variable.
>
> There is no way to spot this by reading the variables back: `railway
> variables --json` prints *resolved* values, so a live reference and a dead
> literal look identical. If in doubt, set it again.
5. First boot imports `keycloak/realm-pathfinder.json`. Then, in the console:
   read the `pathfinder-web` client's secret from **Credentials** into the
   site's `KEYCLOAK_CLIENT_SECRET`, and create yourself a user under **Users**.

Don't add a Railway healthcheck to this service. Keycloak's `/health/ready`
is on the management port (9000), not the port Railway routes to, so a check
against it fails for its whole retry window and marks a working deploy failed
— with no error in the logs, because nothing was wrong.

Editing `realm-pathfinder.json` is riskier than it looks: the importer rejects
any field it doesn't recognise, a rejected import aborts the import, and a
failed import **stops the server booting at all**. Post-logout redirect URIs
are the trap worth naming — they are the client *attribute*
`post.logout.redirect.uris`, not a `postLogoutRedirectUris` array, which reads
perfectly plausibly and takes the whole service down. The error names every
field it does know, so the log is the reference when this happens.

The realm file's redirect URIs name
`pathfinder-dm-tools-production.up.railway.app`. If your domain differs, fix
them in the console — a redirect URI Keycloak doesn't recognise is refused at
the very end of an otherwise successful login.

**The volume holds two things now.** `local/static/monster-data/` is gitignored,
so it isn't in the repo and can't be in the image: mount a volume at `/data`,
upload the generated files once, and point `MONSTER_DATA_DIR` at them. The
account database goes on the same volume — and unlike the monster data, losing
it loses something nobody can regenerate, so it is the one that makes backups
worth taking.

Skipping the monster data still leaves a working site; the battle helper treats
missing monster data as "no monsters available", so only the stat panels are
empty.

Railway's private network is IPv6-only. If `BOT_API_URL` can't be reached,
check that first before suspecting the proxy.

GitHub Actions still runs syntax checks on push (`.github/workflows/checks.yml`)
but no longer publishes anything. If GitHub Pages is still enabled for this
repository, turn it off in Settings → Pages — the last-published copy will
otherwise sit there serving a version with no server behind it, where sign-in
and sync both fail in confusing ways.
