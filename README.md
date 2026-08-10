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

(The dialog still has a "Server address" control. It's for the copy served
from GitHub Pages, which has no proxy — point that one at the bot's public
address if you keep one.)

**Send to server** uploads what's here; **Get from server** brings down what's
there and reloads. Characters are matched by name, the newer copy wins, and
**nothing is ever deleted on either side** — a character that exists in only
one place stays there. Battles are stored opaquely; the bot reads nothing
inside them, and which battle is *active* stays local to the browser.

If two browsers change one battle, the server refuses the second write rather
than merging — get from the server first, then send.

This replaces the Google Drive backup below, which will be removed once sync
has been proven working.

## Google Drive backup (being retired)

Characters and battles live in your browser's `localStorage`. The cloud
button on either page backs both up to a **Pathfinder DM Tools** folder in
your own Drive, as `characters.json` and `battles.json`, and restores them
onto another browser.

It is backup and restore, not background sync: nothing uploads on its own,
and a restore asks before replacing what's here, then reloads the page.

**After the first time, it reconnects by itself.** Consent has to be given
once with a real click — no page is allowed to open that window on its own,
and one that tried would simply be blocked. From then on the token is
re-issued silently in the background on page load, with no window at all, and
the cloud button turns green when it's connected. If the silent path is
blocked (Safari's tracking prevention and Chrome's third-party cookie
restrictions can stop it even with a valid grant), opening the dialog
reconnects instead — the click it takes to open it is enough.

Because the site is static there's no server to hold a client secret, so it
uses Google's browser token flow — which needs an OAuth client of your own.
One-time setup in [Google Cloud Console](https://console.cloud.google.com/):

1. Create a project, and enable the **Google Drive API** for it.
2. Configure the **OAuth consent screen** (External is fine). While the app
   is unverified, add your own Google account under **Test users** — an
   unverified app shows a "Google hasn't verified this app" warning and is
   limited to 100 test users, which is plenty for personal use.
3. Create credentials → **OAuth client ID** → **Web application**.
4. Under **Authorized JavaScript origins**, add every origin you'll open the
   app from. These must match exactly — `localhost` and `127.0.0.1` count as
   different origins:
   - `https://<your-username>.github.io`
   - `http://localhost:5000`
   - `http://127.0.0.1:5000`
5. Copy the client ID and paste it into the dialog behind the cloud button.

The client ID is **not a secret** — for this flow there is no secret to
have, and it's visible in the page source of every app that uses it. What
keeps it yours is the authorized-origins list, which stops the ID working
from anyone else's site. If you'd rather commit it than paste it per
browser, set `DEFAULT_CLIENT_ID` at the top of `static/google-drive.js`.

The only scope requested is `drive.file`, which lets the app see **only the
files it created itself**. It cannot read anything else in your Drive.

## Deployment (Railway)

The site runs as a second service in the same Railway project as the DM
assistant bot. `app.py` serves the static files and forwards `/sync/*` to the
bot over Railway's **private** network, so the browser only ever talks to one
origin. That is the whole point of running a server at all: no CORS, no
address to configure, and the bot's API needs no public domain.

```
browser ──► pathfinder…up.railway.app       app.py: static site + /sync/* proxy
                    │  private network
                    ▼
            dm-bot.railway.internal:8080     no public domain needed
```

Setting it up:

1. In the **same Railway project** as the bot: New → GitHub Repo → this one.
   It builds from the `Dockerfile`.
2. Variables:
   - `BOT_API_URL` = `http://<bot-service-name>.railway.internal:8080`
   - `MONSTER_DATA_DIR` = `/data/monster-data` (see below)
3. Settings → Networking → **Generate Domain**, port **8080**.
4. On the *bot* service you can now remove the public domain, and
   `WEB_CORS_ORIGINS` stops mattering — the proxy is server-to-server, so no
   `Origin` header is involved.

**Monster data needs a volume.** `local/static/monster-data/` is gitignored, so
it isn't in the repo and can't be in the image. Mount a volume (e.g. at
`/data`), upload the generated files once, and point `MONSTER_DATA_DIR` at
them. Skip this and the site still works — the battle helper treats missing
monster data as "no monsters available" — but every monster stat panel is
empty, which is exactly what GitHub Pages has always done.

Railway's private network is IPv6-only. If `BOT_API_URL` can't be reached,
check that first before suspecting the proxy.

## Deployment (GitHub Pages)

The app is fully static, so it deploys to GitHub Pages via GitHub Actions
(`.github/workflows/deploy.yml`): every push to `master`/`main` runs syntax
checks and publishes the `static/` folder.

One-time setup after pushing the repo to GitHub: in the repository settings,
under **Pages**, set **Source** to **GitHub Actions**.
