"""Flask app: static frontend, Pathbuilder proxy, sign-in, and the bot's front door.

Character/group data still lives in the browser (localStorage), and that is
still the source of truth every render path reads. What this server adds is
somewhere to *put* a copy, and a way to know whose copy it is:

- ``/sync/*`` forwards to the DM assistant bot. The browser carries its own
  bearer token there and this hop reads nothing.
- ``/auth/pair`` spends a ``/link`` code *server side* and turns it into an
  HttpOnly session cookie. This is how somebody signs in.
- ``/auth/adopt`` is the same thing for a browser already paired for sync,
  which has a token and should not be made to fetch a second code to say the
  same thing twice.
- ``/api/account/*`` is what that cookie unlocks: a durable copy of this
  browser's characters and battles.
- ``/internal/allow`` is where the bot puts somebody on the whitelist.

**There is one identity here, and it belongs to the bot.** A Telegram account
proves who you are, the bot is what checked, and a pairing code is how that
crosses into a browser. This service decides only *whether you may use it* —
``users.allowed`` — which is authorization, not identity, and is the one
question a site-specific store is the right place to answer.

There used to be a second identity system: a Keycloak realm, its Postgres, an
OIDC flow, and an account minted by the bot whose temporary password travelled
back through a Telegram chat for somebody to retype. It answered the same
question the pairing code already answered, and it did so through a password in
a chat log. Removing it deleted two Railway services, ~500 lines, and the last
password this project could have leaked.

Serving all of it from one origin is why this runs in production at all rather
than only in local dev. The site and the bot's API used to be two origins —
GitHub Pages and a Railway domain — which meant a CORS allowlist, a public API,
and the site having to be told an address. Here the browser only ever talks to
this service, and the bot is reached over Railway's private network. That is
also what keeps sign-in cheap: the server that sets the cookie is the server
that served the page, so there is no redirect protocol to run and no token for
a script on the page to find.
"""

import json
import os
import re
import secrets
from functools import wraps
from pathlib import Path

import requests
from flask import (
    Flask,
    Response,
    jsonify,
    request,
    send_from_directory,
    session,
)
from werkzeug.middleware.proxy_fix import ProxyFix

import monsters
from accounts import DOCUMENT_NAMES, Accounts

app = Flask(__name__, static_folder="static", static_url_path="")

# Railway terminates TLS at its edge and forwards to this container over plain
# HTTP, so Flask sees "http" and every URL it builds for itself comes out
# http://. That used to break sign-in outright, when the callback had to match a
# redirect_uri registered elsewhere. Nothing fails that loudly now — the URL this
# builds is the sign-in address handed to the bot, so without this somebody gets
# sent an http:// link that works and quietly downgrades them on the way in.
#
# Only the scheme is taken from the proxy. The Host header already arrives as
# the real public domain, and trusting a forwarded host would let a spoofed
# header decide where this service says it lives. x_for stays 0 deliberately:
# client_address() reads X-Forwarded-For itself, taking the last entry rather
# than the first, and ProxyFix rewriting remote_addr underneath it would make
# two different answers to the same question.
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=0, x_for=0)

PATHBUILDER_JSON_URL = "https://pathbuilder2e.com/json.php"
ID_PATTERN = re.compile(r"^\d+$")
REQUEST_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; pathfinder-dm-tools/0.1)"}

LOCAL_DIR = Path(__file__).parent / "local"
DATA_DIR = LOCAL_DIR / "data"
LEGACY_STORE_FILE = DATA_DIR / "store.json"
LEGACY_CHARACTERS_FILE = DATA_DIR / "characters.json"

# Monster stats and abilities are generated from Archives of Nethys and
# deliberately kept out of the committed site, so they can't live in static/
# and GitHub Pages never sees them. Serving them here keeps the battle
# helper's stat panels working in local dev, where the fetch resolves to the
# same /monster-data/... URL it would have had before the move.
#
# static/monster-data/ holds the committed half — the same monsters with no
# stats — which IS published. Local dev prefers the richer local copy and
# falls back to the committed one, so a fresh clone that has never run the
# build still gets a working roster instead of an empty picker.
#
# In production the generated half isn't in the image either — it's gitignored,
# so it isn't in the repo the container builds from. MONSTER_DATA_DIR points it
# at a mounted volume instead, which is the one manual step of the Railway
# deploy: upload the built files once, and again whenever the corpus is rebuilt.
MONSTER_DATA_DIR = Path(os.environ.get("MONSTER_DATA_DIR") or LOCAL_DIR / "static" / "monster-data")
PUBLIC_MONSTER_DATA_DIR = Path(app.static_folder) / "monster-data"

# The bot service. On Railway this is its private address —
# <service>.railway.internal — which is reachable only from inside the project,
# so the bot needs no public domain. Locally it's the bot's own dev port.
#
# Unset and set-to-empty are deliberately different, which `or` would have
# flattened: unset means "nobody said, assume the dev port", and empty means
# "this deployment has no bot" — which turns off sign-in and /sync/* rather than
# pointing them at a port with nothing behind it.
_BOT_API_URL = os.environ.get("BOT_API_URL")
BOT_API_URL = (
    "http://127.0.0.1:8080" if _BOT_API_URL is None else _BOT_API_URL
).rstrip("/")
PROXY_TIMEOUT_SECONDS = 15

# Set per-connection by whichever server is speaking, and meaningless to pass
# along: forwarding Connection or Transfer-Encoding hands the browser a claim
# about a hop it isn't on. Content-Length is dropped because Flask recomputes it.
HOP_BY_HOP = frozenset({
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "content-encoding",
})

def _flag(name, default):
    """An environment variable read as a yes/no, with a computed default."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


# --- Accounts --------------------------------------------------------------
#
# The site is built to be entirely usable with none of this configured: no
# sign-in button, no account page, and every /api/account route answering 503
# rather than 500. The app predates having any server-side identity and must not
# start requiring one.


def _telegram_ids(raw):
    """Parse ``ALLOWED_TELEGRAM_IDS``, ignoring anything that isn't an id.

    Silently, and on purpose. This is read once at import, and a stray comma or
    a trailing newline from however the variable got pasted in must not stop the
    site booting — the cost of being strict is a deploy that dies on start, and
    the cost of being lax is one person having to ask why they can't sign in.
    """
    ids = set()
    for piece in re.split(r"[\s,]+", raw or ""):
        if piece.lstrip("-").isdigit():
            ids.add(int(piece))
    return frozenset(ids)


#: The whitelist's seed. Anyone here may sign in whether or not they have a row
#: yet, which is what makes the very first sign-in possible on a fresh database
#: — the bot cannot vouch for anybody until somebody is already inside.
#:
#: Beyond that, membership lives in ``users.allowed``. Two sources rather than
#: one because they answer different needs: this one survives the database being
#: wiped, and the table can be changed without a redeploy.
ALLOWED_TELEGRAM_IDS = _telegram_ids(os.environ.get("ALLOWED_TELEGRAM_IDS"))

# What makes /internal/* answer the bot rather than whoever reaches it. Unset
# means that route is off entirely -- an internal endpoint with no secret is an
# open one, and defaulting to a known string would be worse than defaulting to
# nothing.
BOT_SHARED_SECRET = os.environ.get("BOT_SHARED_SECRET") or ""

# Beside the monster data, on the same volume: this is the one piece of state
# the service owns, and it has to outlive a redeploy. The default is under
# local/, which is gitignored, so a dev run leaves nothing in the repo.
ACCOUNTS_DB_PATH = Path(
    os.environ.get("ACCOUNTS_DB_PATH") or LOCAL_DIR / "data" / "accounts.sqlite3"
)
accounts = Accounts(ACCOUNTS_DB_PATH)

# Deliberately a different file from the accounts database. This one holds a
# cache of somebody else's public data and can be deleted at any time; that one
# holds people's accounts. They should not share a blast radius.
MONSTER_CACHE_PATH = Path(
    os.environ.get("MONSTER_CACHE_PATH") or LOCAL_DIR / "data" / "monster-cache.sqlite3"
)
monster_cache = monsters.Cache(MONSTER_CACHE_PATH)

# Signs the session cookie, which carries nothing but a random session id — the
# tokens are in the database, not in the cookie. A generated fallback means a
# dev run works with no configuration; it also means restarting the dev server
# signs everyone out, which is the right trade for not having a default secret
# that could ship to production by being forgotten.
app.secret_key = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    # Lax, not Strict. Sign-in no longer leaves this origin, so Strict would now
    # work — but people arrive here by tapping a link the bot sent them in
    # Telegram, and Strict withholds the cookie on a navigation from another
    # site. They would land signed out, and reloading would fix it, which is a
    # bug report rather than a behaviour.
    SESSION_COOKIE_SAMESITE="Lax",
    # Secure everywhere except a plain-HTTP dev run, where setting it would
    # mean the cookie is never stored and sign-in silently never completes.
    # Several Railway variables could stand in for "deployed"; any of them
    # appearing is enough, and SESSION_COOKIE_SECURE forces it either way.
    SESSION_COOKIE_SECURE=_flag(
        "SESSION_COOKIE_SECURE",
        default=any(
            os.environ.get(name)
            for name in (
                "RAILWAY_ENVIRONMENT",
                "RAILWAY_ENVIRONMENT_NAME",
                "RAILWAY_PUBLIC_DOMAIN",
                "RAILWAY_PROJECT_ID",
            )
        ),
    ),
)

def client_address():
    """The browser's address, as well as this hop can know it.

    ``X-Forwarded-For`` is oldest first, and Railway's edge appends its own
    address — from a rotating pool, so it is a different one request to
    request. Reading that last entry, which this used to do, named the edge
    rather than the browser: the bot was handed 152.233.13.164 for a request
    that came from 79.140.146.155, and every browser landed in a fresh
    rate-limit bucket each time. 200 requests went through a budget of 120 a
    minute without one being refused.

    So it steps back over exactly the one hop the edge adds. Anything a client
    invented for itself stays to the left of that and is never reached, which
    is the property the old reading was after and had backwards. The bot reads
    it the same way, on purpose.
    """
    hops = [
        hop.strip()
        for hop in (request.headers.get("X-Forwarded-For") or "").split(",")
        if hop.strip()
    ]
    if not hops:
        return request.remote_addr
    return hops[max(len(hops) - 2, 0)]


def extract_character_id(link_or_id: str) -> str | None:
    """Pull the numeric character id out of a Pathbuilder link or raw id string."""
    link_or_id = link_or_id.strip()
    if ID_PATTERN.match(link_or_id):
        return link_or_id

    match = re.search(r"[?&]id=(\d+)", link_or_id)
    if match:
        return match.group(1)

    return None


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/battle-helper/")
def battle_helper():
    # Flask's static handler doesn't resolve directory indexes on its own
    # (unlike GitHub Pages in production), so this mirrors that behavior
    # for local dev.
    return send_from_directory(app.static_folder, "battle-helper/index.html")


@app.get("/monster-data/<path:filename>")
def monster_data(filename):
    # More specific than the catch-all static route, so Werkzeug matches it
    # first. Local build output wins where it exists, because it's the same
    # records plus the stats; otherwise this falls through to the committed
    # index. 404s cleanly when neither has the file — the battle helper
    # already treats a failed fetch as "no monsters available" rather than
    # breaking the page.
    if (MONSTER_DATA_DIR / filename).is_file():
        return send_from_directory(MONSTER_DATA_DIR, filename)
    return send_from_directory(PUBLIC_MONSTER_DATA_DIR, filename)


@app.get("/api/monster")
def monster_lookup():
    """One creature's statistics, fetched from Archives of Nethys on demand.

    This exists because the browser cannot do it: AoN's backend 403s any
    request carrying an Origin header, which a browser cannot omit. See
    monsters.py.

    Cached forever after the first fetch — a statblock is a published number in
    a printed book, not a feed. `?refresh=1` re-reads one, which is the whole
    invalidation story and enough of one.
    """
    name = (request.args.get("name") or "").strip()
    if not name:
        return jsonify(error="Which monster?"), 400

    raw_id = request.args.get("id")
    try:
        aon_id = int(raw_id) if raw_id else None
    except ValueError:
        aon_id = None

    # Keyed with the id, because names are not unique — "Hydra" resolves to
    # more than one creature, and caching by name alone would serve whichever
    # one was asked for first to everyone who asked afterwards.
    key = f"{name}#{aon_id if aon_id is not None else ''}"

    if request.args.get("refresh") != "1":
        cached = monster_cache.get(key)
        if cached is not None:
            return jsonify(cached)

    try:
        payload = monsters.fetch(name, aon_id)
    except monsters.MonsterError as error:
        # A third party being unreachable is an ordinary state: the panel falls
        # back to the minimal one, exactly as it does for a monster with no
        # stats, and the battle carries on.
        return jsonify(error=str(error)), 502

    monster_cache.put(key, payload)
    return jsonify(payload)


@app.route(
    "/sync/<path:subpath>",
    methods=["GET", "POST", "PUT", "DELETE"],
)
def sync_proxy(subpath):
    """Forward one call to the bot's API and hand back what it said.

    Deliberately dumb: it passes the method, the query string, the body and the
    Authorization header, and returns the status and body unread. The bearer
    token is the browser's, not this service's — nothing here mints, stores or
    inspects credentials, so a bug in this file cannot become an authorization
    bug in the bot.

    There is no CORS handling because there is nothing to handle: the browser
    is talking to its own origin, and this hop is server to server.
    """
    if not BOT_API_URL:
        return jsonify(error="This site has no bot service configured."), 503

    headers = {}
    authorization = request.headers.get("Authorization")
    if authorization:
        headers["Authorization"] = authorization
    if request.content_type:
        headers["Content-Type"] = request.content_type

    # Without this every browser reaches the bot wearing this service's address
    # and they all share one rate-limit bucket — the pairing budget first, so one
    # person mistyping a /link code spends everyone else's attempts.
    #
    # Exactly one entry is sent, not the chain we received appended to. The bot
    # buckets on the LAST entry, so appending our own address in the usual way
    # would name the proxy again and change nothing; and a single entry can't be
    # read wrong from either end. Any hops a client invented are dropped with it.
    caller = client_address()
    if caller:
        headers["X-Forwarded-For"] = caller

    try:
        upstream = requests.request(
            request.method,
            f"{BOT_API_URL}/{subpath}",
            params=request.args,
            data=request.get_data(),
            headers=headers,
            timeout=PROXY_TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
        # The bot being down, asleep or unreachable is an ordinary state, not a
        # crash: the site still works on local data, and the sync dialog says
        # what happened instead of hanging.
        return jsonify(error=f"Couldn't reach the bot service: {exc}"), 502

    passed = [
        (name, value)
        for name, value in upstream.headers.items()
        if name.lower() not in HOP_BY_HOP
    ]
    return Response(upstream.content, status=upstream.status_code, headers=passed)


@app.post("/internal/allow")
def internal_allow():
    """Put somebody on the whitelist, at the bot's request.

    This is the other direction from ``/sync/*``: the bot has already
    established who it is talking to in a chat, and asks this service — which
    owns the question of who may use the *site* — to let them in.

    ``telegram_id`` is *not* taken as a claim about who is asking. It is taken
    as a claim by the bot, which is the only thing here that can prove it, and
    the shared secret is what makes it the bot. Nothing about this endpoint is
    safe without that secret, so it is off entirely when none is set.

    No account is created and no credential is issued, because there is no
    longer any such thing: this writes one row saying a person is welcome, and
    they become signed in later by spending a ``/link`` code at ``/auth/pair``.
    Being on the list is not being signed in, and that separation is what lets
    the list be edited by somebody who is not the person it concerns.
    """
    if not BOT_SHARED_SECRET:
        return jsonify(error="Registration isn't configured on this deployment."), 503
    # compare_digest so a wrong secret takes the same time as a right one.
    presented = request.headers.get("X-Bot-Secret") or ""
    if not secrets.compare_digest(presented, BOT_SHARED_SECRET):
        return jsonify(error="Not for you."), 403

    payload = request.get_json(silent=True) or {}
    telegram_id = payload.get("telegram_id")
    # isinstance(True, int) is True in Python, and a JSON `true` arriving where
    # an id belongs would otherwise whitelist person number one.
    if not isinstance(telegram_id, int) or isinstance(telegram_id, bool):
        return jsonify(error="A telegram_id is required."), 400
    allowed = payload.get("allowed", True)
    if not isinstance(allowed, bool):
        return jsonify(error="`allowed` is true or false."), 400

    existing = accounts.user_by_telegram_id(telegram_id)
    was = existing is not None and bool(existing["allowed"])
    accounts.set_allowed(telegram_id, allowed)

    # Revoking takes effect on that person's very next request whatever happens
    # here — accounts.session() joins `users.allowed = 1`, and current_session()
    # re-reads on every call rather than caching. What this adds is cleaning up
    # after it: each session row holds a bot token, and a revoked person's
    # credentials should not sit in this database waiting for a mistake.
    #
    # It also means being put back on the list means signing in again. That is
    # the honest outcome rather than a chosen one: the first request they made
    # while revoked already dropped the session id from their cookie, so the row
    # was unreachable from that moment regardless.
    ended = 0
    if not allowed:
        ended = accounts.delete_sessions_for(telegram_id)
    if was != allowed:
        app.logger.info(
            "%s telegram id %s%s",
            "Whitelisted" if allowed else "Revoked",
            telegram_id,
            f" ({ended} session(s) ended)" if ended else "",
        )

    return (
        jsonify(
            telegram_id=telegram_id,
            allowed=allowed,
            already=was == allowed,
            sign_in_url=f"{request.url_root.rstrip('/')}/account/",
        ),
        200 if was == allowed else 201,
    )


# --- Signing in ------------------------------------------------------------
#
# One exchange, server side: a /link code from the bot goes in, an HttpOnly
# cookie comes out. The browser is never given the bot token that arrives with
# it, and there is no password anywhere in this file to give it instead.


def accounts_configured():
    """Whether signing in is possible on this deployment at all.

    Sign-in needs the bot, because the bot is the only thing that knows who
    anybody is. ``BOT_API_URL`` has a local-dev default, so this is normally true
    and the account button is normally there — which is a change from the
    Keycloak arrangement, where three unset variables hid it. Setting the
    variable to empty is how a deployment says it has no bot and wants no button.

    The bot merely being *down* is not this. That is an ordinary state, reported
    when somebody tries, exactly as the campaign-sync dialog has always done —
    hiding the control would tell them the feature does not exist.
    """
    return bool(BOT_API_URL)


def may_sign_in(telegram_id, row):
    """The whitelist check, in one place because it is the whole security model.

    Two ways to be on the list, and they cover different moments. The
    environment variable is how the *first* person gets in — on a fresh database
    nobody can be vouched for, because there is nobody inside to do the
    vouching. The row is how everybody after them gets in, and can be changed
    without a redeploy.

    A row that exists with ``allowed = 0`` does not block somebody named in the
    variable. That is deliberate: the variable is the operator's own way back in
    after a mistake, and having it overridable from the database it is meant to
    rescue would make it useless exactly when it is needed.
    """
    if telegram_id in ALLOWED_TELEGRAM_IDS:
        return True
    return row is not None and bool(row["allowed"])


def current_session():
    """The signed-in session for this request, or None.

    Reads the store on every call rather than caching on ``g``: sign-out has to
    take effect immediately, including the sign-out that happens in another tab,
    and so does being taken off the whitelist — ``accounts.session()`` will not
    return a row for somebody no longer allowed.
    """
    session_id = session.get("sid")
    if not session_id:
        return None
    row = accounts.session(session_id)
    if row is None:
        # The cookie outlived its row — a signed-out session, a revoked one, or
        # a database that was replaced. Drop it so the browser stops sending it.
        session.pop("sid", None)
        return None
    return row


def signed_in(view):
    """401 rather than a redirect: every caller is fetch(), not a navigation."""

    @wraps(view)
    def wrapped(*args, **kwargs):
        if not accounts_configured():
            return jsonify(error="This site has no sign-in configured."), 503
        row = current_session()
        if row is None:
            return jsonify(error="Not signed in."), 401
        return view(row, *args, **kwargs)

    return wrapped


def forwarded():
    """The one header this service adds when it calls the bot on a browser's behalf.

    Without it every browser reaches the bot wearing *this service's* address
    and they all share one rate-limit bucket — the pairing budget first, so one
    person mistyping a code spends everybody else's attempts. Exactly one entry,
    for the reason spelled out on the /sync proxy.
    """
    caller = client_address()
    return {"X-Forwarded-For": caller} if caller else {}


def person_of(upstream):
    """The person in a bot reply, or a (response, status) to send back instead.

    Both sign-in routes get the same shape from the bot — ``/auth/pair`` with a
    token beside it, ``/auth/me`` without — so both check it the same way.
    """
    try:
        body = upstream.json() or {}
        person = body["person"]
        telegram_id = person["telegram_id"]
    except (ValueError, KeyError, TypeError):
        return None, (jsonify(error="The bot service answered with something unexpected."), 502)
    if not isinstance(telegram_id, int) or isinstance(telegram_id, bool):
        return None, (jsonify(error="The bot service identified nobody."), 502)
    return (person, body), None


def start_session(person, token):
    """Whitelist-check somebody the bot has identified, and sign them in.

    Shared by both routes because the decision is the same one: how a browser
    proved whose it is has no bearing on whether that person may be here.
    """
    telegram_id = person["telegram_id"]
    existing = accounts.user_by_telegram_id(telegram_id)
    if telegram_id in ALLOWED_TELEGRAM_IDS and existing is not None and not existing["allowed"]:
        # The variable overrides the row, so the row has to be brought along or
        # the override only half works: signing in would succeed and hand back a
        # cookie, and then every request after it would fail, because sessions
        # are looked up with `users.allowed = 1` joined in. A sign-in that
        # reports success and is not signed in is the worst of both answers.
        accounts.set_allowed(telegram_id, True)
        existing = accounts.user_by_telegram_id(telegram_id)

    if not may_sign_in(telegram_id, existing):
        # Not "wrong credential" — the bot has just confirmed exactly who this
        # is. Whoever hits this is a known Telegram person who is simply not on
        # the list, so the answer says so, and says their id.
        #
        # Telling them their own id is safe (they proved it is theirs a line
        # ago) and is the one fact they cannot easily look up but need: it is
        # what goes in ALLOWED_TELEGRAM_IDS, and on a fresh deployment there is
        # nobody inside to ask on their behalf.
        app.logger.info("Refused sign-in for telegram id %s: not whitelisted", telegram_id)
        return jsonify(
            error="That Telegram account isn't on this site's list. Ask the DM to add you.",
            telegram_id=telegram_id,
        ), 403

    user = accounts.touch_user(
        telegram_id,
        person.get("display_name") if isinstance(person.get("display_name"), str) else None,
        person.get("username") if isinstance(person.get("username"), str) else None,
    )
    session["sid"] = accounts.create_session(user["id"], token if isinstance(token, str) else None)
    app.logger.info("Signed in telegram id %s", telegram_id)
    return jsonify(user=_user_json(user))


@app.post("/auth/pair")
def auth_pair():
    """Spend a /link code and start a session.

    The code is redeemed by *this server*, not by the page, and that is the
    whole reason this route exists rather than the browser calling the bot
    through ``/sync/auth/pair`` as the campaign-sync dialog does. What comes
    back is a bearer token good for everything that person owns; it goes in the
    sessions table, and the browser gets a cookie it cannot read.

    This is the way in for a browser that has *not* already been paired for
    sync. One that has needs no code at all — see /auth/adopt.

    Pairing twice is fine and is not treated as an error. Codes are single-use
    at the bot, so a second sign-in means a second code, and a second session
    row — one per browser, which is what makes signing out of one not sign out
    of the rest.
    """
    if not accounts_configured():
        return jsonify(error="This site has no sign-in configured."), 503

    payload = request.get_json(silent=True) or {}
    code = payload.get("code")
    if not isinstance(code, str) or not code.strip():
        return jsonify(error="Enter the code the bot gave you."), 400

    try:
        upstream = requests.post(
            f"{BOT_API_URL}/auth/pair",
            json={"code": code.strip(), "label": "pathfinder-dm-tools"},
            headers={"Content-Type": "application/json", **forwarded()},
            timeout=PROXY_TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
        return jsonify(error=f"Couldn't reach the bot service: {exc}"), 502

    if upstream.status_code >= 400:
        # Passed through rather than reworded. The bot already answers a bad
        # code, an expired one and too many attempts in words meant for the
        # person reading them, and it deliberately says the same thing for the
        # first two — rewriting that here could only make it leakier.
        try:
            message = (upstream.json() or {}).get("error")
        except ValueError:
            message = None
        return jsonify(error=message or "That code didn't work."), upstream.status_code

    found, refusal = person_of(upstream)
    if refusal is not None:
        return refusal
    person, body = found
    return start_session(person, body.get("token"))


@app.post("/auth/adopt")
def auth_adopt():
    """Sign in the browser that is already paired for campaign sync.

    ⇅ and 👤 asked the same question — *which Telegram person is this* — and
    made people answer it twice, with two ``/link`` codes, because the answers
    were kept in different places. This is the second one deferring to the
    first: the page hands over the token ⇅ already holds, and this service
    checks it with the bot and starts a session from it.

    **The page is not believed.** The token is presented to ``GET /auth/me``,
    and it is the bot's answer — not the page's claim — that names the person.
    A made-up token gets 401 there, and the whitelist is consulted afterwards
    exactly as it is for a redeemed code.

    Nor is anything newly exposed by accepting it. That token is already in
    ``localStorage``, put there by ``railway-sync.js``, and already travels
    through this service on every ``/sync/*`` call. What comes back is still an
    HttpOnly cookie: the account half continues to hold no credential the page
    can read, and this does not become the way tokens get *into* a browser.
    """
    if not accounts_configured():
        return jsonify(error="This site has no sign-in configured."), 503

    authorization = request.headers.get("Authorization") or ""
    if not authorization.startswith("Bearer ") or not authorization[7:].strip():
        # Not an error worth a 400: the ordinary caller is a page checking
        # whether it can skip the code form, and "no" is an ordinary answer.
        return jsonify(error="This browser isn't paired with the bot yet."), 401

    try:
        upstream = requests.get(
            f"{BOT_API_URL}/auth/me",
            headers={"Authorization": authorization, **forwarded()},
            timeout=PROXY_TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
        return jsonify(error=f"Couldn't reach the bot service: {exc}"), 502

    if upstream.status_code >= 400:
        try:
            message = (upstream.json() or {}).get("error")
        except ValueError:
            message = None
        return jsonify(error=message or "That pairing is no longer valid."), upstream.status_code

    found, refusal = person_of(upstream)
    if refusal is not None:
        return refusal
    person, _ = found
    # The token the page presented is the one stored, so signing out here and
    # unpairing ⇅ stay independent: this session holds its own copy, and
    # dropping it does not reach into localStorage.
    return start_session(person, authorization[7:].strip())


@app.post("/auth/logout")
def auth_logout():
    """End the session here. There is nowhere else to end it.

    The bot token this session held is dropped with the row rather than revoked
    at the bot. Revoking is ``/sessions`` in Telegram, which is where somebody
    can see every browser they have paired and pick — a sign-out on one machine
    should not silently cut off the others.
    """
    session_id = session.get("sid")
    if session_id:
        accounts.delete_session(session_id)
    session.clear()
    return jsonify(next="/")


# --- The account -----------------------------------------------------------


def _user_json(row):
    """A signed-in person as every page shows them.

    No email, because there is no longer anywhere for one to come from. Keycloak
    held the address as a login credential and this mirrored it; identity is now
    a Telegram id, and Telegram does not hand out addresses. What is shown
    instead is what the bot knows: a display name, a handle, or failing both the
    id itself — one of the three is always there, so the page never has to say
    "signed in as nobody".
    """
    return {
        "telegram_id": row["telegram_id"],
        "display_name": row["display_name"],
        "username": row["username"],
    }


@app.get("/api/account/me")
def account_me():
    """Who is signed in — the one auth route that answers for nobody too.

    Every page calls this on load to decide what to show, so "not signed in" is
    an ordinary answer with a 200, not a 401. A 401 here would put a red error
    in the console of a page that is working perfectly.
    """
    if not accounts_configured():
        return jsonify(configured=False, user=None)
    row = current_session()
    if row is None:
        return jsonify(configured=True, user=None)
    return jsonify(
        configured=True,
        user={**_user_json(row), "documents": accounts.summary(row["user_id"])},
    )


# --- Data kept against the account -----------------------------------------


@app.get("/api/account/data/<name>")
@signed_in
def account_get_document(row, name):
    if name not in DOCUMENT_NAMES:
        return jsonify(error="No such document."), 404
    stored = accounts.document(row["user_id"], name)
    if stored is None:
        return jsonify(name=name, body=None, updated_at=None)
    body, updated_at = stored
    # Sent as an already-encoded string rather than re-parsed and re-serialised:
    # what comes back has to be byte-for-byte what the browser sent, or a push
    # followed by a pull would quietly reorder somebody's data.
    return Response(
        json.dumps({"name": name, "body": body, "updated_at": updated_at}),
        mimetype="application/json",
    )


@app.put("/api/account/data/<name>")
@signed_in
def account_put_document(row, name):
    if name not in DOCUMENT_NAMES:
        return jsonify(error="No such document."), 404
    payload = request.get_json(silent=True) or {}
    body = payload.get("body")
    if not isinstance(body, str):
        return jsonify(error="Expected the document as a JSON string."), 400
    try:
        json.loads(body)
    except ValueError:
        # Storing something unreadable would turn a bad push into a bad *pull*
        # later, on a page that has no way to recover from it.
        return jsonify(error="That document isn't valid JSON."), 400
    updated_at = accounts.put_document(row["user_id"], name, body)
    return jsonify(name=name, updated_at=updated_at)


@app.get("/account/")
def account_page():
    return send_from_directory(app.static_folder, "account/index.html")


@app.post("/api/fetch")
def fetch_character():
    payload = request.get_json(silent=True) or {}
    link = payload.get("link", "")
    character_id = extract_character_id(link)
    if not character_id:
        return jsonify(error="Could not find a character id in that link."), 400

    try:
        response = requests.get(
            PATHBUILDER_JSON_URL,
            params={"id": character_id},
            headers=REQUEST_HEADERS,
            timeout=10,
        )
        response.raise_for_status()
        data = response.json()
    except requests.RequestException as exc:
        return jsonify(error=f"Failed to fetch character: {exc}"), 502

    if not data.get("success", True):
        return jsonify(error="Pathbuilder reported this character is not shareable."), 404

    name = data.get("build", {}).get("name") or "Unnamed character"
    return jsonify(name=name, sourceId=character_id, link=link, data=data)


@app.get("/api/legacy-store")
def legacy_store():
    """Old server-side data, offered once so the browser can import it."""
    if LEGACY_STORE_FILE.exists():
        return jsonify(json.loads(LEGACY_STORE_FILE.read_text(encoding="utf-8")))
    if LEGACY_CHARACTERS_FILE.exists():
        characters = json.loads(LEGACY_CHARACTERS_FILE.read_text(encoding="utf-8"))
        return jsonify(characters=characters, groups=[])
    return jsonify(characters=[], groups=[])


if __name__ == "__main__":
    app.run(debug=True, port=5000)
