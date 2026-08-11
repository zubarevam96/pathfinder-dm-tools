---
name: pathfinder-dm-tools
description: Guide to the pathfinder-dm-tools repository — what it is, how it's built, and the required workflow for applying changes. Load this whenever working in this repository (features, bug fixes, refactors, deployment, or any file under static/, app.py, or .github/workflows/).
---

# Pathfinder DM Tools

A browser-based character sheet viewer for Pathfinder 2e, built around
[Pathbuilder2e](https://pathbuilder2e.com/) character exports. A DM (or
player) pastes a Pathbuilder share link or numeric ID, and the app fetches
the character JSON, renders it as a readable sheet with computed PF2e
modifiers/DCs, and lets you roll checks. Characters can be organized into
groups (e.g. one per party). Everything is stored in the browser only — there
is no account system and no shared backend database.

The target user is non-technical (a DM running a game), so the UI should
stay simple and self-explanatory. The target *contributor* is a developer
who may not have touched this repo before — that's what this skill is for.

## Required workflow

**These are the most important rules in this skill.**

### Before: confirm the repo is up to date

More than one developer works on this repo. Before applying any requested
change, run:

```
bash prechange.sh
```

(`prechange.sh` lives at the repo root.) It fetches `origin`, compares your
local branch against it, and reports whether it's safe to proceed:

- **Exit 0** — up to date (or fast-forwarded cleanly, or only ahead of
  origin). Proceed with the requested change.
- **Exit 1** — environment problem (not a repo, detached HEAD, fetch
  failed, e.g. no network). Stop and surface this to the developer; don't
  guess at a fix.
- **Exit 2** — blocking situation needing a human decision: the working
  tree is dirty *and* behind origin, or local and origin have diverged.
  **Do not** pull, merge, or rebase yourself to resolve this. Stop and tell
  the developer exactly what the script reported, and let them decide how
  to reconcile it.

Run this again if a work session picks back up after a gap (e.g. a new
conversation, or after the developer mentions they or someone else pushed
changes) — don't rely on a check from earlier in a long session remaining
valid.

### After: confirm nothing else landed, then test before commit/push

After implementing a change a contributor asked for, always run:

```
bash postchange.sh
```

(`postchange.sh` lives at the repo root, alongside `prechange.sh`.) It
compares the current repo state against the baseline `prechange.sh` recorded
before you started, and reports whether anything landed while you were
working:

- **Exit 0** — clean. No local commit appeared (i.e. you didn't accidentally
  commit, and neither did the developer mid-session), and origin hasn't
  moved (no one else pushed). Proceed to the confirmation step below.
- **Exit 1** — no baseline found (`prechange.sh` wasn't run first this
  session) or the fetch failed. Not fatal, but means the check couldn't run
  properly — mention this gap to the developer rather than silently
  treating it as clean.
- **Exit 2** — drift detected: a local commit appeared since the baseline,
  and/or `origin` moved. This is a report, not necessarily an error — a
  legitimate intermediate commit (e.g. checkpointing a quality fix) can
  trigger it too — but either way, **do not commit or push past this
  without telling the developer exactly what the script found.** Never
  resolve it yourself (no auto-merge, no silent rebase); let the developer
  decide.

Then, regardless of the postchange result:

1. Verify the change as best you can yourself (see "How to verify changes"
   below — local server checks, curl against endpoints, brace/paren balance
   checks for JS since there's usually no local Node).
2. **Stop before committing or pushing.** Tell the developer what changed,
   what `postchange.sh` reported, how you verified the change, and
   explicitly ask them to test it themselves (locally via `python app.py`,
   or on the deployed Railway site) and confirm it's correct.
3. Only commit and push after the developer explicitly confirms the result
   is correct. Do not commit "in the meantime" or "to save progress" — if
   asked to keep working, keep the changes staged/uncommitted and continue.

This holds even if a task looks small or obviously correct. The one
exception is if the developer has explicitly said, in the current
conversation, to skip confirmation and commit directly — that permission
does not carry over to future turns or future sessions.

## Architecture

The frontend is HTML/CSS/vanilla JS with no build step, no framework and no
bundler. That was originally because GitHub Pages can't execute server code;
Pages is gone and Railway runs a real server now, but the constraint stayed —
**every file under `static/` must still work as a plain `<script>` tag**, and
the pages must still function with the server answering nothing but files.

```
app.py                          Flask app: static files, proxies, auth routes
accounts.py                     SQLite store: users, sessions, stored documents
oidc.py                         The OpenID Connect client (Keycloak)
prechange.sh                    Run before applying changes — see "Required workflow"
postchange.sh                   Run after applying changes — see "Required workflow"
Dockerfile, railway.toml        The site's Railway service
keycloak/                       The Keycloak service: Dockerfile + realm import
static/
  index.html                    Page shell: sidebar, tabs, all <dialog> modals
  app.js                        All application logic (single file, no modules)
  style.css                     All styling (CSS custom properties for theming)
  railway-sync.js               Telegram-identified sync with the bot
  account.js                    Signed-in account: state, backup and restore
  account/                      The personal info page
.github/workflows/checks.yml    CI: syntax checks only. It deploys nothing
data/                           Legacy server-side storage (gitignored; see below)
```

- **`app.py` is the production backend now**, which it was not for most of
  this project's life. It serves the site, falls back to `POST api/fetch` for
  Pathbuilder when the browser's direct call fails, serves
  `GET api/legacy-store` for one-time import, proxies `/sync/*` to the bot, and
  runs sign-in at `/auth/*` and `/api/account/*`.
  **The rule against putting features here has not been repealed.** Everything
  above is there for one of two reasons: the browser can't do it (another
  origin, a client secret, an HttpOnly cookie) or doing it in the browser would
  mean holding a credential a script could read. A feature that could live in
  `static/` and merely *would be easier* on the server does not qualify —
  that's still a conversation to have with the developer first.
- **The site must survive an unconfigured server.** With no `KEYCLOAK_*`
  variables the 👤 button never appears and `/api/account/*` answers 503; with
  no bot the ⇅ dialog reports it; with no monster data the panels are empty.
  All three are ordinary local-dev states, and none of them may break a page.
- **`static/app.js`** holds everything: localStorage persistence, sidebar
  rendering, the character sheet renderer, roll logic, dialogs for
  add/collision/group/delete, and the Pathbuilder fetch (direct + fallback).
  It's one file by design so far — if it grows much further, ask the
  developer before splitting it into modules (this repo has no build step,
  so any module split needs to work as plain `<script>` tags or ES modules
  loaded directly by the browser).
- **`static/style.css`** uses CSS custom properties (`--bg`, `--surface`,
  `--accent`, etc.) defined in `:root` and overridden under
  `@media (prefers-color-scheme: dark)`. Keep new styling consistent with
  this token system rather than hardcoding colors, so dark mode keeps
  working automatically.

## Data model (browser localStorage)

All persistent data lives in `localStorage["pathfinder-dm-tools"]`, loaded/
saved via `loadStore()`/`persist()` in `app.js`. Shape:

```js
{
  characters: [{
    id, name, sourceId, link, data, groupId, savedAt
  }],
  groups: [{ id, name }],
  rolls: [{ name, label, die, mod, critAdjust, total, at }],
  settings: { critModifier: false },
}
```

- `data` is the full raw Pathbuilder JSON response (`{ success, build: {...} }`).
  The sheet renderer reads from `character.data.build`.
- `sourceId` is the numeric Pathbuilder ID. **It is not a permanent identity
  for one character** — Pathbuilder can reassign what a given ID points to
  over time. Because of this: the "add character" flow only auto-updates an
  existing entry in place when *both* `sourceId` and `name` match a fetch
  result; the Refresh button aborts (with an alert) rather than overwriting
  if the fetched name no longer matches the stored name. Don't relax these
  checks to `sourceId` alone.
- `groupId` is a single value or `null` — a character belongs to at most one
  group, by construction (there's no multi-group data structure to misuse).
- Storage is per-browser, and **localStorage stays the single source of
  truth.** One user cannot see another's characters, and no code path writes
  to storage behind a running page. Adding a backend that the app reads
  through, rather than syncs with, is a much bigger conversation than it
  looks — have it with the developer first.
- **`static/railway-sync.js` is the one sanctioned exception**, added at the
  developer's explicit request. It stores characters and battles on the
  companion `roleplaying-dm-assistant-bot` service, so there *is* cross-device
  sync now — but only when someone asks for it, and only for browsers they
  have paired. Its rules:
  - **Both directions are a button, never automatic.** Last-write-wins across
    two devices is exactly how a session's battle gets overwritten by a stale
    tab, and it was rejected for that reason. A pull **reloads** the page,
    because `app.js` and `battle-helper.js` both read storage once at startup
    and hold live state in module-level variables — a page left running would
    disagree with what was just written under it.
  - **Nothing is ever deleted on either side.** Characters merge by name with
    the newer copy winning; a character that exists in only one place stays
    there. Battles use optimistic concurrency: the server refuses a second
    write with **409** rather than merging, and that status has to reach the
    browser intact — see the proxy note below.
  - It is self-contained (no file imports from it, it imports from none) and
    reaches storage by key exactly as the two pages do, which is what makes it
    impossible for it to change how either behaves.
- **`static/account.js` is the second exception**, and the two are not rivals.
  It stores whole documents against an account of this site's own, in the
  SQLite file `accounts.py` owns. Backup and restore, not a merge: unlike the
  bot, there is no second writer here to reconcile with, and inventing a merge
  for one would lose data rather than protect it.
- **There are two identity systems, on purpose and temporarily.** `railway-sync.js`
  asks *which Telegram person is this*, and that answer is what unifies a
  character with one the bot imported. `account.js` asks *which account on this
  site is this*, which is the only way in for someone who has never spoken to
  the bot. They are meant to meet at `users.telegram_id` — currently always
  NULL, and `set_telegram_id()` has no callers. Do not fill that column in from
  anything a browser claims; it is a join to the bot's Telegram-keyed database,
  and writing it unverified would hand someone else's characters away.
- **No token and no password ever reaches the page.** The server runs the
  OpenID Connect flow (`oidc.py`) and hands back an HttpOnly session cookie;
  tokens live in the `sessions` table. Passwords are only ever typed on
  Keycloak's origin, reached by redirect — `/auth/password` sends someone there
  and back. If you find yourself adding a password field to this app, stop.
  The ID token's signature is deliberately *not* verified, which is safe for
  exactly one reason spelled out in `oidc.py`'s docstring: it arrives on this
  server's own authenticated connection to the token endpoint. That reason
  evaporates if a token ever starts arriving from anywhere else.
- **`app.py` proxies `/sync/*` to the bot** over Railway's private network, so
  the browser never leaves one origin — no CORS anywhere in the path, and the
  bot needs no public domain. The proxy is deliberately dumb: it forwards the
  method, query, body and `Authorization` header and returns the status unread,
  so a bug there cannot become an authorization bug in the bot. The one header
  it adds is `X-Forwarded-For`, as a **single entry**, because the bot buckets
  rate limits on the last entry and without it every browser shares one bucket.
  This is the exception to "don't add real features to `app.py`", and it earns
  it by holding no state and making no decisions.
- `data/` (server-side JSON) is a legacy artifact from before storage moved
  to the browser. It's gitignored and only read by `GET api/legacy-store`
  for one-time migration. Don't build new features on it.

## PF2e rules conventions used throughout

- Ability modifier: `floor((score - 10) / 2)`.
- Any proficiency-based total (`checkTotal` in `app.js`): ability modifier +
  proficiency rank (0/2/4/6/8 = untrained/trained/expert/master/legendary)
  + character level, but **only add level if proficiency > 0** (untrained
  never gets the level bonus). This applies uniformly to skills, saves,
  perception, class DC, and spell attack/DC — reuse `checkTotal`, don't
  reimplement this math per-section.
- DC for any check = `10 + total modifier`.
- Roll buttons roll `d20 + modifier`. If Options → "critical rolls" is
  enabled, a natural 20 adds +10 and a natural 1 subtracts 10 from the
  total (a shorthand for crit success/failure margins, off by default).
- AC shown is the character's static AC; a shield or a weapon with the
  Parry trait gets a small toggle button next to the AC value (only shown
  if applicable) that adds/removes that situational bonus without touching
  the underlying data.

## How to verify changes

There's no automated test suite. Verification is manual:

- **Backend/logic changes**: run `.venv\Scripts\python app.py` (create the
  venv first if needed: `py -m venv .venv` then
  `.venv\Scripts\pip install -r requirements.txt`), then hit endpoints with
  `curl` or a small Python script using `urllib.request` (this has been the
  pattern throughout — see git history for examples). Kill stray background
  Python processes before starting a fresh server; check
  `Get-NetTCPConnection -LocalPort 5000` to confirm only one process is
  listening before trusting test output — multiple leftover servers racing
  on the same port has caused confusing false failures before.
- **Frontend JS**: there is usually no local Node available to run
  `node --check`. As a cheap sanity check, verify brace/paren/backtick
  counts balance in the edited file. The CI `check` job runs
  `node --check static/app.js` as the real syntax gate — but that only runs
  after a push, so don't rely on it as your only check before asking the
  developer to test.
- **UI behavior** (dialogs, rendering, rolls, toggles): cannot be driven
  from here — there's no browser automation available. Say so explicitly
  rather than claiming it works, and ask the developer to click through it.
  This is exactly the kind of thing step 2 of the workflow above exists for.

## Deployment (Railway)

Railway builds from the `Dockerfile` on every push to `master`. GitHub Actions
runs syntax checks (`.github/workflows/checks.yml`) and deploys nothing.

One Railway project, four services: this site, the DM assistant bot, Keycloak,
and Keycloak's Postgres. `README.md` has the topology and every variable; what
matters when changing code here:

- **The browser only ever talks to this service.** `/sync/*` is proxied to the
  bot over the private network, and Keycloak is reached by this server or by a
  top-level redirect — never by script. Anything that would make the page fetch
  another origin is reintroducing the CORS problem all of this removed.
- **Railway's private network is IPv6-only.** A service that binds `0.0.0.0`
  is unreachable from its neighbours while its public domain works perfectly.
  That cost the bot a production outage; it is the first thing to check when
  one service can't reach another.
- **The volume at `/data` holds the account database.** Monster data on it is
  regenerable; `accounts.sqlite3` is not. A change that rewrites it wants a
  copy taken first.
- Two new files ship with the image and are easy to forget in the `Dockerfile`:
  `accounts.py` and `oidc.py` are copied by name, not by wildcard.

GitHub Pages was retired when the site moved here. If it ever comes back, note
that the page it serves has no server: sign-in, `/sync/*` and monster data all
fail there, in ways that look like bugs rather than absence.

## Conventions to follow when adding to the UI

- New modals follow the existing `<dialog>` pattern in `index.html`
  (`showModal()` / `.close()`, a `.dialog-status` paragraph for errors, a
  `.dialog-actions` button row). Reuse this rather than inventing a new
  modal approach.
- New rollable values follow the `checkRow()` / `.roll-btn` pattern
  (`data-mod`, `data-label` attributes, wired up via `rollCheck()`), so they
  automatically get history logging and the crit-modifier option for free.
- New sheet sections follow the `.sheet-section` + `<h3>` pattern already
  used for Abilities/Skills/Spells/Weapons/etc. — keep new sections
  consistent with that rhythm rather than one-off layouts.
- Escape any Pathbuilder-sourced text inserted into HTML with `escapeHtml()`
  before interpolating it into a template string — character names, spell
  names, etc. come from external JSON and are rendered via `innerHTML`.
