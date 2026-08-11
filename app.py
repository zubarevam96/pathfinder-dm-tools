"""Flask app: static frontend, Pathbuilder proxy, sign-in, and the bot's front door.

Character/group data still lives in the browser (localStorage), and that is
still the source of truth every render path reads. What this server adds is
somewhere to *put* a copy — two of them, for two different ideas of who you are:

- ``/sync/*`` forwards to the DM assistant bot, where identity is a Telegram
  account and a pairing code. Unchanged, and still the path that unifies a
  character imported in chat with one opened here.
- ``/auth/*`` and ``/api/account/*`` are an account of this site's own, backed
  by Keycloak for authentication and by ``accounts.py`` for everything else.
  Nobody has a Telegram id here yet; ``users.telegram_id`` is the column where
  the two will meet, and it is empty on purpose.

Two identity systems is a cost, not a design goal. It buys the site a way in for
someone who has never spoken to the bot, and it is meant to end: once a signed-in
account can prove a Telegram id, one of these becomes a link rather than a login.

Serving all of it from one origin is why this runs in production at all rather
than only in local dev. The site and the bot's API used to be two origins —
GitHub Pages and a Railway domain — which meant a CORS allowlist, a public API,
and the site having to be told an address. Here the browser only ever talks to
this service; the bot is reached over Railway's private network, and Keycloak is
only ever reached by *this server* or by a top-level redirect, never by script.
"""

import json
import os
import re
import secrets
import time
from functools import wraps
from pathlib import Path
from urllib.parse import quote

import requests
from flask import (
    Flask,
    Response,
    jsonify,
    redirect,
    request,
    send_from_directory,
    session,
)

import oidc
from accounts import DOCUMENT_NAMES, Accounts

app = Flask(__name__, static_folder="static", static_url_path="")

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
BOT_API_URL = (os.environ.get("BOT_API_URL") or "http://127.0.0.1:8080").rstrip("/")
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
# All three of these are absent in local dev by default, and the site is built
# to be entirely usable that way: no sign-in button, no account page, and every
# /api/account route answering 503 rather than 500. The app predates having any
# server-side identity and must not start requiring one.
KEYCLOAK_ISSUER = (os.environ.get("KEYCLOAK_ISSUER") or "").rstrip("/")
KEYCLOAK_CLIENT_ID = os.environ.get("KEYCLOAK_CLIENT_ID") or "pathfinder-web"
KEYCLOAK_CLIENT_SECRET = os.environ.get("KEYCLOAK_CLIENT_SECRET") or ""

auth = oidc.Client(KEYCLOAK_ISSUER, KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET)

# Beside the monster data, on the same volume: this is the one piece of state
# the service owns, and it has to outlive a redeploy. The default is under
# local/, which is gitignored, so a dev run leaves nothing in the repo.
ACCOUNTS_DB_PATH = Path(
    os.environ.get("ACCOUNTS_DB_PATH") or LOCAL_DIR / "data" / "accounts.sqlite3"
)
accounts = Accounts(ACCOUNTS_DB_PATH)

# Signs the session cookie, which carries nothing but a random session id — the
# tokens are in the database, not in the cookie. A generated fallback means a
# dev run works with no configuration; it also means restarting the dev server
# signs everyone out, which is the right trade for not having a default secret
# that could ship to production by being forgotten.
app.secret_key = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    # Lax, not Strict: the sign-in flow comes back as a top-level navigation
    # from Keycloak's origin, and Strict would withhold the cookie on exactly
    # that request — the callback would arrive with no idea what it had started.
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

#: Where the browser comes back to. Registered in Keycloak, so it has to match
#: to the character; derived from the request rather than configured so that
#: localhost and 127.0.0.1 each get their own (they are different origins to
#: both Keycloak and the cookie jar).
CALLBACK_PATH = "/auth/callback"

#: Session keys for one in-flight sign-in. Cleared the moment it completes, so a
#: replayed callback has nothing left to match.
PENDING_KEYS = ("oidc_state", "oidc_nonce", "oidc_verifier", "oidc_return")


def client_address():
    """The browser's address, as well as this hop can know it.

    Railway's edge appends the address it saw to ``X-Forwarded-For``, so the
    *last* entry is the one entry a client cannot write for itself — reading the
    first, as the header's own definition suggests, would let anyone reset their
    rate limit by inventing a hop. The bot reads it the same way, on purpose.
    """
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        hops = [hop.strip() for hop in forwarded.split(",") if hop.strip()]
        if hops:
            return hops[-1]
    return request.remote_addr


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


# --- Signing in ------------------------------------------------------------


def callback_url():
    return request.url_root.rstrip("/") + CALLBACK_PATH


def safe_return_to(value):
    """A path on this site to come back to, or the front page.

    Whatever comes back from the query string ends up in a ``Location`` header,
    so an absolute URL here would be an open redirect: a link to this site that
    lands somewhere else, with this site's name on it. Only a path is allowed,
    and ``//evil.example`` is a path that browsers read as a host — hence the
    second check rather than just the first.
    """
    if not value or not value.startswith("/") or value.startswith("//"):
        return "/"
    return value


def begin_sign_in(action=None, return_to="/"):
    verifier = oidc.new_verifier()
    state = secrets.token_urlsafe(24)
    nonce = secrets.token_urlsafe(24)
    session["oidc_state"] = state
    session["oidc_nonce"] = nonce
    session["oidc_verifier"] = verifier
    session["oidc_return"] = return_to
    return redirect(
        auth.authorization_url(callback_url(), state, nonce, verifier, action=action)
    )


def current_session():
    """The signed-in session for this request, or None.

    Reads the store on every call rather than caching on ``g``: sign-out has to
    take effect immediately, including the sign-out that happens in another tab.
    """
    session_id = session.get("sid")
    if not session_id:
        return None
    row = accounts.session(session_id)
    if row is None:
        # The cookie outlived its row — a signed-out session, or a database that
        # was replaced. Drop it so the browser stops sending it.
        session.pop("sid", None)
        return None
    return row


def signed_in(view):
    """401 rather than a redirect: every caller is fetch(), not a navigation."""

    @wraps(view)
    def wrapped(*args, **kwargs):
        if not auth.configured:
            return jsonify(error="This site has no sign-in configured."), 503
        row = current_session()
        if row is None:
            return jsonify(error="Not signed in."), 401
        return view(row, *args, **kwargs)

    return wrapped


def access_token_for(row):
    """A live access token for this session, refreshing it if it has expired.

    Keycloak's default access token lasts five minutes, so anything that talks
    to Keycloak on the user's behalf — changing an email, say — will usually
    find an expired one. The refresh token is good for the SSO session, which
    is measured in weeks.
    """
    if row["access_token"] and row["access_expires_at"] > time.time() + 15:
        return row["access_token"]
    if not row["refresh_token"]:
        raise oidc.OidcError("This session has expired. Sign in again.")
    issued = auth.refresh(row["refresh_token"])
    token = issued.get("access_token")
    accounts.refresh_session(
        row["id"],
        token,
        issued.get("refresh_token") or row["refresh_token"],
        time.time() + float(issued.get("expires_in") or 0),
    )
    return token


@app.get("/auth/login")
def auth_login():
    if not auth.configured:
        return jsonify(error="This site has no sign-in configured."), 503
    try:
        return begin_sign_in(return_to=safe_return_to(request.args.get("next")))
    except oidc.OidcError as error:
        return jsonify(error=str(error)), 502


@app.get("/auth/password")
def auth_password():
    """Send someone to Keycloak's own change-password form and back again.

    There is no password field anywhere in this application, and this route is
    why: Keycloak collects it on Keycloak's origin, and this service never sees
    one. Signing in again on the way is not a detour — it is what makes the
    request trustworthy.
    """
    if not auth.configured:
        return jsonify(error="This site has no sign-in configured."), 503
    try:
        return begin_sign_in(action="UPDATE_PASSWORD", return_to="/account/")
    except oidc.OidcError as error:
        return jsonify(error=str(error)), 502


@app.get(CALLBACK_PATH)
def auth_callback():
    if not auth.configured:
        return jsonify(error="This site has no sign-in configured."), 503

    expected_state = session.get("oidc_state")
    verifier = session.get("oidc_verifier")
    nonce = session.get("oidc_nonce")
    return_to = safe_return_to(session.get("oidc_return"))
    for key in PENDING_KEYS:
        session.pop(key, None)

    # Keycloak's own refusal (a cancelled login, a required action declined)
    # comes back here as a query parameter, not as an HTTP error.
    if request.args.get("error"):
        return _auth_failed(
            request.args.get("error_description") or request.args["error"]
        )

    code = request.args.get("code")
    if not code or not expected_state or not verifier:
        return _auth_failed("That sign-in didn't start here. Try again.")
    if not secrets.compare_digest(request.args.get("state", ""), expected_state):
        return _auth_failed("That sign-in didn't match the one that started here.")

    try:
        issued = auth.exchange_code(code, callback_url(), verifier)
        claims = auth.claims_of(issued["id_token"], nonce)
    except (oidc.OidcError, KeyError) as error:
        return _auth_failed(
            str(error) if isinstance(error, oidc.OidcError) else "Keycloak sent no ID token."
        )

    subject = claims.get("sub")
    if not subject:
        return _auth_failed("That sign-in identified nobody.")

    user = accounts.upsert_user(subject, claims.get("email"))
    session["sid"] = accounts.create_session(
        user["id"],
        issued.get("access_token"),
        issued.get("refresh_token"),
        time.time() + float(issued.get("expires_in") or 0),
    )
    # The ID token is kept only to hand back as id_token_hint on the way out, so
    # Keycloak knows which session to end without asking.
    session["id_token"] = issued["id_token"]

    # Keycloak reports the outcome of an application-initiated action — the
    # change-password form — on the callback, which is not a page anyone sees.
    # Carry it to the one that does, or "Change password" would always look
    # like it silently did nothing.
    status = request.args.get("kc_action_status")
    if status:
        separator = "&" if "?" in return_to else "?"
        return_to = f"{return_to}{separator}kc_action_status={quote(status, safe='')}"
    return redirect(return_to)


def _auth_failed(message):
    """Say what went wrong on the page, not in a JSON body nobody will see.

    The callback is a top-level navigation: whatever this returns is what the
    person is looking at.
    """
    return redirect("/?auth_error=" + quote(message, safe=""))


@app.post("/auth/logout")
def auth_logout():
    """Sign out here first, then at Keycloak.

    In that order deliberately: if the redirect to Keycloak fails, or someone
    closes the tab mid-way, the session that mattered — the one this site
    accepts — is already gone.
    """
    session_id = session.get("sid")
    if session_id:
        accounts.delete_session(session_id)
    id_token = session.get("id_token")
    session.clear()

    if not auth.configured:
        return jsonify(next="/")
    try:
        return jsonify(next=auth.end_session_url(id_token, request.url_root))
    except oidc.OidcError:
        # Keycloak being unreachable must not leave someone stuck signed in.
        return jsonify(next="/")


# --- The account -----------------------------------------------------------


@app.get("/api/account/me")
def account_me():
    """Who is signed in — the one auth route that answers for nobody too.

    Every page calls this on load to decide what to show, so "not signed in" is
    an ordinary answer with a 200, not a 401. A 401 here would put a red error
    in the console of a page that is working perfectly.
    """
    if not auth.configured:
        return jsonify(configured=False, user=None)
    row = current_session()
    if row is None:
        return jsonify(configured=True, user=None)
    return jsonify(
        configured=True,
        user={
            "email": row["email"],
            "telegram_id": row["telegram_id"],
            "documents": accounts.summary(row["user_id"]),
        },
    )


@app.put("/api/account/email")
@signed_in
def account_set_email(row):
    """Change the address, at Keycloak, then mirror what it accepted.

    Keycloak is asked first and its answer is final: it owns uniqueness, format
    and whatever verification the realm turns on. Writing here first would mean
    a local row claiming an address the login system rejected.
    """
    payload = request.get_json(silent=True) or {}
    email = (payload.get("email") or "").strip()
    if "@" not in email or " " in email:
        return jsonify(error="That doesn't look like an email address."), 400

    try:
        token = access_token_for(row)
        response = requests.post(
            f"{auth.issuer}/account/",
            json={"email": email},
            headers={"Authorization": f"Bearer {token}"},
            timeout=oidc.TIMEOUT_SECONDS,
        )
    except oidc.OidcError as error:
        return jsonify(error=str(error)), 401
    except requests.RequestException as error:
        return jsonify(error=f"Couldn't reach the sign-in service: {error}"), 502

    if response.status_code >= 400:
        return jsonify(error=_account_api_error(response)), response.status_code

    accounts.set_email(row["user_id"], email)
    return jsonify(email=email)


def _account_api_error(response):
    """Keycloak's account API reports field errors in its own shape."""
    try:
        body = response.json()
    except ValueError:
        return f"The sign-in service refused that address ({response.status_code})."
    if isinstance(body, list) and body:
        first = body[0]
        if isinstance(first, dict) and first.get("errorMessage"):
            return first["errorMessage"]
    if isinstance(body, dict):
        for key in ("errorMessage", "error_description", "error"):
            if body.get(key):
                return str(body[key])
    return f"The sign-in service refused that address ({response.status_code})."


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
