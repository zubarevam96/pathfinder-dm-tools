"""Flask app: static frontend + Pathbuilder 2e fetch proxy.

Character/group data lives in the browser (localStorage), so each user only
sees their own characters. The server keeps nothing; it only proxies fetches
to Pathbuilder (which browsers can't call directly due to CORS) and serves a
one-time export of the old server-side store for migration.
"""

import json
import re
from pathlib import Path

import requests
from flask import Flask, jsonify, request, send_from_directory

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
MONSTER_DATA_DIR = LOCAL_DIR / "static" / "monster-data"
PUBLIC_MONSTER_DATA_DIR = Path(app.static_folder) / "monster-data"


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
