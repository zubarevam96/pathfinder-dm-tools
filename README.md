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

## Telling the table (battle helper)

The 💬 button in the battle helper's header sends a line into a campaign's
Telegram chats — "round 3, Vex is up" — without leaving the fight. It uses the
same pairing as ⇅ Sync, so a browser that can sync can already do this; one
that isn't paired is told to pair rather than offered a second way to.

You pick a **table**, not a chat. A campaign can answer in several chats and
topics, and the bot delivers to all of them, which is how everything else it
announces already works. Tables with no chat linked are listed but can't be
posted to, and say so.

Two things are worth knowing before using it:

- **Every message carries your name**, because it arrives in the bot's voice
  and an unattributed message there would borrow the bot's authority.
- **What you type is text, never markup.** It's escaped before sending, so a
  link or a @handle in the box arrives as the characters you typed.

Anyone at the table can send, not only the DM — they can all already talk in
that chat. Somebody who is *not* at the table gets the same answer as for a
campaign that doesn't exist. Ten messages a minute per browser.

The bot needs to be running with `WEB_ENABLED=true`, as for sync; an API built
without a Telegram connection answers 503 here and serves everything else.

## Accounts

The 👤 button signs a browser in, so this browser's characters and battles have
somewhere to live that isn't this browser. Everything it stores is a small
SQLite file beside the monster data.

**Who you are comes from the bot.** Send `/link` in a private Telegram chat, and
paste the eight-character code it replies with into the 👤 dialog. The *server*
spends that code against the bot's `POST /auth/pair`, keeps the token it gets
back, and hands the browser nothing but an HttpOnly session cookie. So identity
here is a Telegram id — the same integer the bot keys all of its own tables on,
which is what lets a character imported in a chat and one opened here be the
same character.

**A browser already paired for ⇅ needs no code at all.** ⇅ and 👤 were asking
the same question and making people answer it twice. Now the page offers the
token ⇅ already holds to `POST /auth/adopt`, which checks it against the bot's
`GET /auth/me` — the bot's answer, not the page's claim, is what names the
person — and signs them in. It happens on page load, so pairing once is enough.

If that comes back refused, the message names the Telegram id it refused. That
is the id which goes in `ADMIN_TELEGRAM_ID`, or the one to hand the admin for
`/whitelist add`. On a fresh deployment it is the only way to find out what to
put there.

**Whether you may use it is this site's own question**, and the answer is
`users.allowed`. One person decides: `ADMIN_TELEGRAM_ID`, below.

The admin may always sign in, whatever the table says. That is what makes the
first sign-in possible on an empty database — nobody can be vouched for when
there is nobody inside to do the vouching — and what makes a mistaken
revocation recoverable. A list nobody can get back into is a locked door with
the key inside.

Everybody else is added by the admin, from a private chat with the bot:

```
/whitelist                  who may use it
/whitelist add @handle      let somebody in
/whitelist remove @handle    take them off
```

A numeric id works in place of a @handle, and is the only way to name somebody
who has never written to the bot — Telegram gives bots no way to resolve a
handle they have not seen.

**The bot does not decide who may run that.** It reports who typed the command
as `X-Actor-Telegram-Id`, and this service checks it against `ADMIN_TELEGRAM_ID`
— the list is the site's, so who may edit it is the site's question, and a copy
of the answer in the bot would be a copy to drift. The bot is trusted for one
thing only: honestly saying who is talking to it.

Taking somebody off the list ends the sessions they already have on their very
next request, and keeps everything they had stored. Putting them back means
pairing again. The admin cannot be taken off at all — that is refused rather
than performed and quietly undone.

**There is no password anywhere in this project.** Not stored, not hashed, not
temporary, and not in a chat log — there is none to leak or reset. A pairing
code is single-use, expires in five minutes, and is rationed ten attempts per
ten minutes. The same is true of tokens as far as the page is concerned: it
never receives one.

**Personal info** (`/account/`) shows which Telegram account you are signed in
as. There is nothing to edit — the name and handle are Telegram's, and follow
you here when you change them there.

**Send to account** and **Get from account** store and restore whole documents,
unlike ⇅'s per-character merge. Nothing uploads on its own; a restore asks
first, then reloads.

| Variable | What it is |
|---|---|
| `ADMIN_TELEGRAM_ID` | The one Telegram id that runs this site. **Set this to your own before deploying, or nobody can get in and nobody can let them.** It overrides the table, so it is also the way back in after a revocation that shouldn't have happened |
| `SECRET_KEY` | Signs the session cookie. Any long random string; changing it signs everyone out |
| `ACCOUNTS_DB_PATH` | `/data/accounts.sqlite3` — **on the volume**, or accounts vanish on redeploy |
| `BOT_SHARED_SECRET` | Shared with the bot as its `ACCOUNTS_API_SECRET`. Unset means `/internal/allow` answers 503 — an internal endpoint with no secret is an open one |

Sign-in needs the bot, since the bot is the only thing that knows who anybody
is. `BOT_API_URL` set to an empty string says this deployment has no bot: the
👤 button disappears, `/sync/*` answers 503, and everything else works exactly
as it always did. Unset is different — it falls back to the local dev port.

## Deployment (Railway)

Railway is the only place this deploys now. One project, two services:

```
                    browser
                       │
                       ▼
           pathfinder…up.railway.app
                       │  app.py: site, /sync/* proxy,
                       │  /auth/pair, /api/account/*
       private network │      volume: /data
                       ▼      monster-data + accounts.sqlite3
        dm-bot.railway.internal:8080
              no public domain needed
```

**The browser only ever talks to one origin.** `/sync/*` and sign-in are both
proxied to the bot by this server over Railway's private network, so there is no
CORS anywhere, the bot needs no public domain, and the browser is never sent
somewhere else and back.

It used to be four services. A Keycloak realm and a Postgres of its own answered
the question "which account on this site is this", which the bot's pairing code
already answered — and answered without a password. Removing them took ~81% off
the monthly bill; the JVM alone sat at a flat 537 MB serving nobody, because its
heap floor is a percentage of the container rather than of the work.

**The site:**

1. In the **same Railway project** as the bot: New → GitHub Repo → this one.
   It builds from the root `Dockerfile`.
2. Variables:
   - `BOT_API_URL` = `http://<bot-service-name>.railway.internal:8080`
   - `MONSTER_DATA_DIR` = `/data/monster-data` (see below)
   - `ACCOUNTS_DB_PATH` = `/data/accounts.sqlite3`
   - `ADMIN_TELEGRAM_ID`, `SECRET_KEY` and `BOT_SHARED_SECRET` from the
     Accounts section
3. Settings → Networking → **Generate Domain**, port **8080**.
4. On the *bot* service you can now remove the public domain, and
   `WEB_CORS_ORIGINS` stops mattering — the proxy is server-to-server, so no
   `Origin` header is involved.

**Monster statistics no longer need the volume.** The battle helper fetches
each creature from Archives of Nethys the first time you select it, through
`GET /api/monster` on this server, and caches the answer in
`MONSTER_CACHE_PATH` (put it on the volume so a redeploy doesn't re-fetch).
The committed index still supplies the picker's names and AoN ids.

That request has to go through the server: AoN's backend returns 403 to any
request carrying an `Origin` header, and a browser cannot omit one — so no
amount of client-side cleverness makes a direct fetch work.

Uploading the generated `monster-data/` files is still supported and still
slightly better where it exists: the build script also reads each creature's
rendered page, which is the only place conditional skill bonuses
("Athletics +5 (+9 to Climb)") and Recall Knowledge DCs appear. The live path
skips that second request, so those two fields stay empty. Where the bulk file
has a creature, it wins and nothing is fetched.

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
