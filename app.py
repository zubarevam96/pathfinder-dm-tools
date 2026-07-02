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

DATA_DIR = Path(__file__).parent / "data"
LEGACY_STORE_FILE = DATA_DIR / "store.json"
LEGACY_CHARACTERS_FILE = DATA_DIR / "characters.json"


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
