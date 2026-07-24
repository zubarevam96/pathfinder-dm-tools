---
name: pf2e-battle-grid
description: Pathfinder 2e tactical grid/encounter rules (squares, distance, creature size and space, reach, flanking, cover) and the feature roadmap for this repo's battle-helper page. Load this whenever working on static/battle-helper/ or any encounter-tracking feature.
---

# PF2e Battle Grid Rules

Reference for building `static/battle-helper/`, a tactical encounter map.
Sourced from Archives of Nethys's official rules pages (linked per section)
— check the source before relying on a detail not covered here, rules text
changes with errata.

## Grid basics

- One square = 5 feet, always (Core Rulebook grid convention).
  [Grid Movement](https://2e.aonprd.com/Rules.aspx?ID=2356)
- **Diagonal movement alternates 5/10 ft.** The first diagonal square in a
  turn costs 5 ft, the second costs 10 ft, then it alternates — not a flat
  5 ft like some other systems. Moving 4 squares diagonally costs
  5+10+5+10 = 30 ft, not 20 ft. The count resets at the end of each turn.
  [Diagonal Movement](https://2e.aonprd.com/Rules.aspx?ID=2357)
- Optional alternative grids exist (hex, offset-square) specifically to
  avoid the diagonal-counting complexity above — worth knowing exists, but
  square grid is the default and what this page targets.

## Creature size and space

From Table 9-1, Player Core ([Size, Space, and Reach](https://2e.aonprd.com/Rules.aspx?ID=2359)):

| Size | Space | Reach (tall) | Reach (long) |
|------|-------|--------------|--------------|
| Tiny | < 5 ft | 0 ft | 0 ft |
| Small | 5 ft (1 square) | 5 ft | 5 ft |
| Medium | 5 ft (1 square) | 5 ft | 5 ft |
| Large | 10 ft (2×2 squares) | 10 ft | 5 ft |
| Huge | 15 ft (3×3 squares) | 15 ft | 10 ft |
| Gargantuan | 20 ft+ (4×4+ squares) | 20 ft | 15 ft |

- Small/Medium and larger creatures each occupy their own square(s) and
  generally can't share a space with another Small-or-larger creature.
- Multiple Tiny creatures *can* share one square — at least 4 fit in a
  single square per the rules (GM discretion for more).
- "Tall" reach applies to bipeds; "long" reach (usually shorter) applies to
  quadruped-shaped creatures — the distinction matters for token/reach
  tooling later, not for the current plain-grid MVP.

## Flanking

[Flanking](https://2e.aonprd.com/Rules.aspx?ID=2375) — two creatures flank
a target when a line between the centers of their spaces passes through
opposite sides or opposite corners of the target's space, both are able to
act and attack in melee, and both have the target in reach. A flanked
creature is off-guard (−2 circumstance penalty to AC) against melee attacks
from the flankers. For 3D cases (elevation), the rules explicitly say to
have the GM call it rather than measure exactly — not something to model
precisely in tooling.

## Cover

[Cover](https://2e.aonprd.com/Rules.aspx?ID=2372) — being behind an
obstacle grants a circumstance bonus to AC, Reflex vs. area effects, and
Stealth to avoid detection:
- Lesser cover (typically from a creature, not terrain): +1
- Standard cover: +2
- Greater cover (via the Take Cover action): +4

## Feature roadmap for `static/battle-helper/`

Current state: a plain square-grid `<canvas>`, click-to-select a square,
nothing else. Per the project owner's stated end goal ("work through a
full battle from begin to end"), likely future layers, roughly in the
order they'd naturally get built:

1. **Tokens** — place a character/monster on a square, sized per the table
   above (a Large creature's token should occupy and select as a 2×2
   block, not one square).
2. **Distance/movement** — given the diagonal 5/10 rule above, a "how far
   is square A from square B" or "can this token reach that square with
   its Speed" helper is the natural next feature, and must implement the
   alternating diagonal count correctly, not simple Chebyshev/Euclidean
   distance.
3. **Initiative tracker** — turn order list, tied to placed tokens.
4. **HP/condition tracking per token** — likely reusing this repo's
   existing character data (`store.characters`) so a token can link back
   to a full character sheet already in the app instead of being a bare
   placeholder.
5. **Reach/flanking helpers** — highlight threatened squares from a
   token's reach, flag flanking per the rule above.
6. **Terrain/cover markers** — mark squares as difficult terrain or
   cover-granting, feeding into the AC/Reflex bonuses above.

None of this is built yet — this list exists so future work has the rules
groundwork already laid out instead of re-deriving it each time.
