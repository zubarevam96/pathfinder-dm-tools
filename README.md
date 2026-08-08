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

## Google Drive backup (optional)

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

## Deployment (GitHub Pages)

The app is fully static, so it deploys to GitHub Pages via GitHub Actions
(`.github/workflows/deploy.yml`): every push to `master`/`main` runs syntax
checks and publishes the `static/` folder.

One-time setup after pushing the repo to GitHub: in the repository settings,
under **Pages**, set **Source** to **GitHub Actions**.
