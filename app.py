"""Flask app: static frontend, Pathbuilder proxy, and the bot API's front door.

Character/group data lives in the browser (localStorage). This server keeps
nothing of its own; it serves the site, proxies fetches to Pathbuilder (which
browsers can't always call directly), serves the monster data that is kept out
of the committed site, and forwards ``/sync/*`` to the DM assistant bot.

That last one is why this runs in production at all now rather than only in
local dev. The site and the bot's API used to be two origins — GitHub Pages
and a Railway domain — which meant a CORS allowlist, a public API, and the
site having to be told an address. Serving both from here makes them one
origin: the browser only ever talks to this service, and the bot is reached
over Railway's private network, so its API needs no public domain at all.
"""

import json
import os
import re
from pathlib import Path

import requests
from flask import Flask, Response, jsonify, request, send_from_directory

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
