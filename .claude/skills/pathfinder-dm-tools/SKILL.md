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
   or by trying the deployed GitHub Pages site) and confirm it's correct.
3. Only commit and push after the developer explicitly confirms the result
   is correct. Do not commit "in the meantime" or "to save progress" — if
   asked to keep working, keep the changes staged/uncommitted and continue.

This holds even if a task looks small or obviously correct. The one
exception is if the developer has explicitly said, in the current
conversation, to skip confirmation and commit directly — that permission
does not carry over to future turns or future sessions.

## Architecture

The whole app is static — HTML/CSS/vanilla JS, no build step, no framework,
no bundler. This is intentional: it needs to run on GitHub Pages, which
can't execute server code.

```
app.py                          Flask app — dev convenience + fetch fallback only
prechange.sh                    Run before applying changes — see "Required workflow"
postchange.sh                   Run after applying changes — see "Required workflow"
static/
  index.html                    Page shell: sidebar, tabs, all <dialog> modals
  app.js                        All application logic (single file, no modules)
  style.css                     All styling (CSS custom properties for theming)
.github/workflows/deploy.yml    CI: syntax checks, then deploy static/ to GitHub Pages
data/                           Legacy server-side storage (gitignored; see below)
```

- **`app.py`** is not the production backend — GitHub Pages serves the
  static files directly with no server involved. `app.py` exists only for
  local development (`python app.py` → http://127.0.0.1:5000) and as a CORS
  fallback: normally the browser calls `pathbuilder2e.com/json.php`
  directly (Pathbuilder allows CORS), but if that ever fails, `app.js`
  falls back to `POST api/fetch` on this Flask server. It also serves
  `GET api/legacy-store`, a one-time export of old server-side data (see
  Data model) for browsers to import. Do not add real application features
  to `app.py` — if a feature needs a real server, that's a bigger
  architectural conversation to have with the developer first, not a
  default to reach for.
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
- Since storage is per-browser, there is no cross-device sync and no way for
  one user to see another's characters. This is deliberate (privacy by
  isolation), not a gap to "fix" by adding a backend unless the developer
  asks for that explicitly.
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

## Deployment (GitHub Pages)

`static/` is published to GitHub Pages by `.github/workflows/deploy.yml` on
every push to `master`/`main`. Things learned the hard way, worth knowing
before touching this workflow:

- The `deploy-pages` action caps its internal timeout at 600000ms (10 min)
  — raising it further does nothing, GitHub silently clamps it.
- **Never use "Re-run failed jobs" / "Re-run all jobs"** on a deploy run.
  Re-running reuses the same run ID, and `upload-pages-artifact` doesn't
  replace the previous attempt's artifact — it adds another one. Once a run
  has more than one `github-pages` artifact, `deploy-pages` fails with
  "Multiple artifacts... unexpectedly found." Always trigger a fresh run
  instead (push a commit, or Actions → this workflow → "Run workflow").
- `concurrency: { group: pages, cancel-in-progress: true }` is intentional:
  a new deploy cancels any older one still in flight, so deploys never race.
- If a deploy gets stuck at `deployment_queued` for the full timeout with no
  GitHub status-page incident, the fix that has worked is toggling
  Settings → Pages → Source to **None** and back to **GitHub Actions** —
  this resets GitHub's internal Pages deployment state.

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
