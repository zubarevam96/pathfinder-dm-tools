"""One monster's statistics, fetched from Archives of Nethys when asked for.

Until now these were baked into ``local/static/monster-data/`` by a build
script, which meant the deployed site had no stats at all unless someone
remembered to upload 2.5 MB of generated JSON to a volume. Every monster panel
was empty and looked broken. This fetches them one creature at a time instead,
the first time anyone selects it, and caches the answer.

**The browser cannot do this itself, and that is not a caching problem.** AoN's
elasticsearch backend returns 403 to any request carrying an ``Origin`` header
— verified: the same URL answers 200 without one and 403 with one — and its
pages send no ``Access-Control-Allow-Origin`` at all. A browser cannot suppress
``Origin`` on a cross-origin request, so the fetch has to happen server-side.
That is the whole reason this module exists rather than a few lines of
``fetch()`` in the page.

What it does *not* do is fetch the rendered HTML page. The build script does,
for conditional skill bonuses ("Athletics +5 (+9 to Climb)") which exist
nowhere in the search document, and for Recall Knowledge DCs. That is a second
request per monster to a third party's server while somebody waits, to fill in
fields the panel treats as optional anyway. The index path is what runs here,
and it is the same index path the build script already falls back to.

The parsing below is deliberately identical to
``local/scripts/build_monster_entities.py``. If you change one, change both —
they are two callers of one format, and a monster that reads differently
depending on which fetched it is worse than either being wrong.
"""

from __future__ import annotations

import json
import re
import sqlite3
import time
import urllib.parse
from contextlib import contextmanager
from pathlib import Path

import requests

SEARCH_URL = "https://elasticsearch.aonprd.com/aon/_search"

#: Not decoration. Without a User-Agent the backend refuses the request.
REQUEST_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; pathfinder-dm-tools)"}

REQUEST_TIMEOUT_SECONDS = 12

#: Rulebooks, best first. Anything not listed (adventure paths, one-shots,
#: deluxe box sets) ranks last — those reprint statblocks that are better read
#: from the book they belong to.
SOURCE_PREFERENCE = [
    "Monster Core",
    "NPC Core",
    "Bestiary 3",
    "Bestiary 2",
    "Bestiary",
    "Book of the Dead",
    "Rage of Elements",
    "Howl of the Wild",
]

LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")  # [Agile](/Traits.aspx?ID=170) -> Agile
ACTIONS = re.compile(r'<actions string="([^"]*)"\s*/>')

#: Statblock paragraphs are blank-line separated, *except* that reaction
#: abilities are run together with the prose above them and separated by a
#: literal <br />. Splitting on blank lines alone loses them: Shield Block and
#: Reactive Strike ended up inside the preceding paragraph and never matched.
#: Strikes are unaffected — their parts are joined by single newlines, not <br />.
PARAGRAPH = re.compile(r"\n\s*\n|<br\s*/?>")

#: Spellcasting blocks — "Arcane Innate Spells DC 21", "Divine Rituals" — are
#: real statblock content a DM needs mid-fight, but they are not listed in
#: `creature_ability`, so the allowlist alone drops every one of them. This is
#: the narrowest widening that recovers them: two specific words, rather than
#: relaxing the allowlist into "any bolded label", which would promote
#: Immunities, Weaknesses and Speed into invented abilities.
SPELLCASTING = re.compile(r"\b(Spells|Rituals)\b", re.I)

#: Defensive labels that behave like abilities and are read constantly in a
#: fight, but that AoN files as statblock fields rather than in
#: `creature_ability` — so the allowlist drops them. Kept as an explicit set of
#: two rather than a pattern: every other bolded label in a statblock (Speed,
#: Immunities, Damage) is a stat the panel shows elsewhere or not at all, and
#: promoting those would fill the Actions tab with duplicated numbers.
STATBLOCK_ABILITIES = {"hardness", "regeneration"}
LEADING_LABEL = re.compile(r"^\*\*([^*]+)\*\*\s*")
STRIKE = re.compile(r"^(?P<name>.+?)\s*(?P<bonus>[+-]\d+)\s*(?:\((?P<traits>.*?)\))?\s*,?\s*$")

#: Agile strikes take -4/-8 on their second and third attacks in a round;
#: everything else takes -5/-10.
MAP_AGILE = (-4, -8)
MAP_NORMAL = (-5, -10)


class MonsterError(Exception):
    """Something went wrong reaching or reading Archives of Nethys."""


# --- Cache -----------------------------------------------------------------


class Cache:
    """Fetched monsters, kept so the second selection costs nothing.

    Its own SQLite file rather than a table in the accounts database: this is
    a cache of someone else's public data and the other holds people's
    accounts. Losing this one is a slow afternoon; losing that one is a
    catastrophe, and they should not share a blast radius or a backup policy.
    """

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS monsters (
                    name       TEXT PRIMARY KEY,
                    payload    TEXT NOT NULL,
                    fetched_at REAL NOT NULL
                )
                """
            )

    @contextmanager
    def _connect(self):
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def get(self, name: str) -> dict | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload FROM monsters WHERE name = ?", (name,)
            ).fetchone()
        if row is None:
            return None
        try:
            return json.loads(row["payload"])
        except ValueError:
            # A corrupt row is a cache miss, not an outage.
            return None

    def put(self, name: str, payload: dict) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO monsters (name, payload, fetched_at) VALUES (?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    payload = excluded.payload,
                    fetched_at = excluded.fetched_at
                """,
                (name, json.dumps(payload, ensure_ascii=False), time.time()),
            )

    def count(self) -> int:
        with self._connect() as connection:
            return connection.execute("SELECT COUNT(*) FROM monsters").fetchone()[0]


# --- Archives of Nethys ----------------------------------------------------


def search(name: str) -> dict:
    query = f'name:"{name}" AND category:creature'
    url = f"{SEARCH_URL}?{urllib.parse.urlencode({'q': query})}"
    try:
        response = requests.get(url, headers=REQUEST_HEADERS, timeout=REQUEST_TIMEOUT_SECONDS)
        response.raise_for_status()
        return response.json()
    except requests.RequestException as error:
        raise MonsterError(f"Couldn't reach Archives of Nethys: {error}") from error
    except ValueError as error:
        raise MonsterError("Archives of Nethys returned something that wasn't JSON.") from error


def source_rank(candidate: dict) -> int:
    sources = candidate.get("source") or []
    ranks = [
        i
        for i, book in enumerate(SOURCE_PREFERENCE)
        for source in sources
        if source.startswith(book)
    ]
    return min(ranks) if ranks else len(SOURCE_PREFERENCE)


def choose(data: dict, name: str, aon_id: int | None = None) -> dict | None:
    """The one document that is this creature, out of everything that matched.

    ``aon_id`` settles it outright when the app has one, and it always does —
    every entry in the committed monster index carries the id its statblock
    link already points at. That matters because names are not unique: "Hydra"
    matches several documents, and picking on book preference alone returned a
    90 HP one where the index meant a 15 HP one. The build script disambiguates
    with level/HP/AC hints from a table this app doesn't have; the id is a
    better key than the hints were.

    Falls back to the build script's ordering when no id is given, and every
    filter applies only if it leaves something behind.
    """
    candidates = [
        hit["_source"]
        for hit in data.get("hits", {}).get("hits", [])
        if hit.get("_source", {}).get("category") == "creature"
        and hit["_source"].get("name", "").strip().lower() == name.strip().lower()
    ]
    if not candidates:
        return None

    if aon_id is not None:
        exact = [c for c in candidates if _aon_id(c) == aon_id]
        if exact:
            return exact[0]

    pool = [c for c in candidates if not c.get("remaster_id")] or candidates
    best = min(source_rank(c) for c in pool)
    return [c for c in pool if source_rank(c) == best][0]


# --- Parsing ---------------------------------------------------------------


def strip_markup(text: str) -> str:
    text = LINK.sub(r"\1", text)
    text = ACTIONS.sub("", text)
    return re.sub(r"\s+", " ", text).strip()


def parse_strike(paragraph: str, kind: str) -> dict | None:
    """One **Melee**/**Ranged** paragraph -> a strike."""
    action = ACTIONS.search(paragraph)
    body = LEADING_LABEL.sub("", strip_markup(paragraph))

    damage = None
    parts = re.split(r"\*\*Damage\*\*", body, maxsplit=1)
    if len(parts) == 2:
        body, damage = parts[0], parts[1].strip()
    match = STRIKE.match(body.strip())
    if not match:
        return None

    traits = [t.strip() for t in (match.group("traits") or "").split(",") if t.strip()]
    bonus = int(match.group("bonus"))
    step = MAP_AGILE if any(t.lower() == "agile" for t in traits) else MAP_NORMAL
    return {
        "kind": kind,
        "action": action.group(1) if action else None,
        "name": match.group("name").strip(),
        "bonus": bonus,
        "map": [bonus + step[0], bonus + step[1]],
        "traits": traits,
        "damage": damage,
    }


def _word_prefix(longer: str, shorter: str) -> bool:
    """True when `shorter` is `longer` up to a word boundary, not mid-word."""
    return (
        len(shorter) >= 3
        and len(longer) > len(shorter)
        and longer.startswith(shorter)
        and longer[len(shorter)] == " "
    )


def is_ability(name: str, known_lower: set[str]) -> bool:
    """Whether a bolded statblock label names an ability, or is just a field.

    The allowlist is `creature_ability`, AoN's own list for this creature, and
    an exact match is not enough for three reasons found in real data:

    - Its entries carry the same mangling the statblock has. The aoyin's is
      literally ``"Driven by Hunger    Trigger"`` — the action tag stripped to
      whitespace with the next label run on — so the parsed label is a *prefix*
      of the allowlisted one.
    - Defensive labels like Hardness and Regeneration are statblock fields, not
      entries in `creature_ability`, and are often creature-specific
      ("Hydra Regeneration"). Matched on the word, so both spellings land.
    - Spellcasting blocks are in neither list.

    Everything else stays excluded, which is the point: Speed, Immunities and
    Damage are stats shown elsewhere, and promoting them would fill the Actions
    tab with duplicated numbers.
    """
    collapsed = re.sub(r"\s+", " ", name).strip().lower()
    if not collapsed:
        return False
    if collapsed in known_lower:
        return True
    # A whole-word prefix, in either direction. The boundary is load-bearing:
    # without it the attribute line's "**Con** +9" matched "Constrict" and
    # invented an ability called Con on every creature that constricts.
    if any(_word_prefix(known, collapsed) or _word_prefix(collapsed, known) for known in known_lower):
        return True
    if STATBLOCK_ABILITIES & set(collapsed.split()):
        return True
    return bool(SPELLCASTING.search(collapsed))


def extract_stats(source: dict) -> dict | None:
    """The numbers the battle helper's stat panel shows, and only those."""

    def number(field):
        value = source.get(field)
        return value if isinstance(value, (int, float)) else None

    speed = source.get("speed") or {}
    land = speed.get("land")
    if land is None:
        land = speed.get("max")

    stats = {
        "level": number("level"),
        "hp": number("hp"),
        "ac": number("ac"),
        "perception": number("perception"),
        "fortitude": number("fortitude_save"),
        "reflex": number("reflex_save"),
        "will": number("will_save"),
        "speed": land if isinstance(land, (int, float)) else None,
        "speedText": (source.get("speed_raw") or "").strip() or None,
        # Both only ever come off the rendered page, which this path doesn't
        # fetch. The keys are carried with empty values so the app reads one
        # shape whichever path produced it.
        "recallKnowledge": None,
        "shieldBonus": 0,
    }
    # shieldBonus is always 0 here, so it can't be what makes a creature look
    # like it has stats.
    return stats if any(v for k, v in stats.items() if k != "shieldBonus") else None


def skills_from_index(source: dict) -> list[dict]:
    """Flat modifiers, no conditional bonuses — those are page-only."""
    mods = source.get("skill_mod") or {}
    if not isinstance(mods, dict):
        return []
    return [
        {"name": name.replace("_", " ").title(), "modifier": value, "notes": []}
        for name, value in sorted(mods.items())
        if isinstance(value, (int, float))
    ]


def parse_abilities(source: dict) -> dict | None:
    """Strikes, attribute modifiers and named special abilities."""
    markdown = source.get("markdown") or ""
    start = markdown.find('<title level="2"')
    if start != -1:
        markdown = markdown[start:]

    # An allowlist of the names AoN itself calls this creature's abilities,
    # rather than blocklisting the statblock's field labels: the label set
    # varies by creature type, and a blocklist would quietly promote any
    # unfamiliar one into a fake ability.
    known = source.get("creature_ability") or []
    if isinstance(known, str):
        known = [known]
    known_lower = {n.strip().lower() for n in known if n and n.strip()}

    strikes = []
    special = []
    for paragraph in PARAGRAPH.split(markdown):
        paragraph = paragraph.strip()
        if not paragraph.startswith("**"):
            continue
        # Resolve links and lift out action tags before reading the label.
        # Reactions arrive as **[Shield Block](/MonsterAbilities.aspx?ID=75)**,
        # and a few creatures have AoN's own malformed markup with the tag
        # inside the bold — **Driven by Hunger <actions string="Reaction" /> **.
        # Either way the raw label is not the ability's name, and looking it up
        # in the allowlist fails.
        label = LEADING_LABEL.match(ACTIONS.sub("", LINK.sub(r"\1", paragraph)))
        if not label:
            continue
        name = label.group(1).strip()

        if name in ("Melee", "Ranged"):
            strike = parse_strike(paragraph, name)
            if strike:
                strikes.append(strike)
        elif is_ability(name, known_lower):
            action = ACTIONS.search(paragraph)
            text = LEADING_LABEL.sub("", strip_markup(paragraph)).strip()
            special.append(
                {
                    "name": name,
                    "action": action.group(1) if action else None,
                    "text": text or None,
                }
            )

    def modifier(field):
        value = source.get(field)
        return value if isinstance(value, (int, float)) else None

    attributes = {
        "str": modifier("strength"),
        "dex": modifier("dexterity"),
        "con": modifier("constitution"),
        "int": modifier("intelligence"),
        "wis": modifier("wisdom"),
        "cha": modifier("charisma"),
    }

    if not strikes and not special and not any(v is not None for v in attributes.values()):
        return None
    return {
        "strikes": strikes,
        "attributes": attributes,
        "special": special,
        "skills": skills_from_index(source),
    }


def extract_info(source: dict) -> dict | None:
    """The Info tab: what this thing *is*, rather than what it can do."""
    traits = source.get("trait") or []
    if isinstance(traits, str):
        traits = [traits]
    senses = source.get("sense") or []
    if isinstance(senses, str):
        senses = [senses]

    info = {
        "flavour": (source.get("summary") or "").strip() or None,
        "traits": [t for t in traits if t],
        "senses": [s for s in senses if s],
        "languages": [],
        "items": [],
    }
    return info if any(info.values()) else None


def fetch(name: str, aon_id: int | None = None) -> dict:
    """Everything the app wants about one creature, by name.

    Raises MonsterError when AoN can't be reached. Returns a payload with
    ``stats: null`` when AoN simply has no such creature, which is an answer
    rather than a failure — the app renders the minimal panel for it.
    """
    document = choose(search(name), name, aon_id)
    if document is None:
        return {"name": name, "found": False, "stats": None, "abilities": None, "info": None}
    return {
        "name": name,
        "found": True,
        "aonId": _aon_id(document),
        "stats": extract_stats(document),
        "abilities": parse_abilities(document),
        "info": extract_info(document),
    }


def _aon_id(document: dict) -> int | None:
    """The Monsters.aspx id, so the statblock link keeps working."""
    match = re.search(r"ID=(\d+)", document.get("url") or "")
    return int(match.group(1)) if match else None
