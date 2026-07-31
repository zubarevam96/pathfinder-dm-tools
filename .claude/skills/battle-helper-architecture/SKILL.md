---
name: battle-helper-architecture
description: The event-driven state/undo-redo architecture for static/battle-helper/ code. Load this before writing or reviewing any code that changes battle-helper state (placing tokens, moves, damage, conditions, terrain), or that touches its event log, undo/redo, page layout, or keyboard shortcuts.
---

# Battle Helper Architecture

Two rules govern all of `static/battle-helper/battle-helper.js`. Both exist
because the page needs undo/redo (Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y) over an
arbitrary, growing set of battle actions, without hand-writing an inverse
function for every action type.

**Canvas work** — `drawGrid()`, coordinates, the tool palette, walls,
doors, terrain, pathfinding, token drawing, drag-and-drop — lives in
`references/map.md`. Read that too before touching any of it.

## Rule 1: Everything is an event, or part of one

Any code that changes battle **state** must go through the one
`dispatch()` function. Never mutate `battleState` directly from an event
handler.

```js
dispatch("place-token", `Placed ${character.name}`, (state) => {
  state.placements[squareKey(row, col)] = character.id;
});
```

`dispatch()` snapshots state before and after running the mutator, and
appends `{ type, label, before, after, at }` to `eventLog`. This is
**snapshot-based undo**, not command-pattern — no per-type `undo()` to
maintain. That trade holds because battle state is small and holds only
ids and primitives (see below); if it ever grows to embed something
expensive, like full character sheets instead of ids, revisit this.
Snapshotting stops being free at that point.

### What's in `battleState`

Everything `emptyBattleState()` returns, and nothing else:

| key | shape | notes |
|---|---|---|
| `placements` | `squareKey -> entityId` | one entity per square |
| `hp`, `tempHp` | `entityId -> number` | never max HP — see "State separation" |
| `conditions` | `entityId -> { conditionId: { active, value } }` | |
| `customObjects` | `id -> { name }` | |
| `initiative` | `entityId -> number` | the *number* |
| `initiativeOrder` | `entityId[]` | the *display order*, independent |
| `appearance` | `entityId -> { shape, letters, textColor, shapeColor }` | survives removal |
| `walls` | `edgeKey -> "wall" \| "door"` | keyed by edge, not square |
| `terrain` | `squareKey -> "difficult"` | keyed by square |
| `cols`, `rows`, `originRow`, `originCol` | numbers | the board's size and anchor |

`normalizeState()` spreads a stored state over a fresh empty one, so a
battle saved before a field existed still gets it. New fields therefore
need no migration — just a sensible empty value in `emptyBattleState()`.

### Labels are computed before dispatching, not inside the mutator

The mutator only touches the live `battleState` and returns nothing, so
anything the log line needs to say about the *old* state has to be read
first — `applyHpDelta()` reads `battleState.tempHp[characterId]` up front
to write `"took 12 damage (6 to temp HP, 6 to HP)"`. That's safe because
nothing can mutate state between the read and the mutator seeing the same
value; JS is single-threaded.

### One action, one dispatch

Damage/heal is the canonical example: every `hp-action-*` button computes
a delta and calls one shared `applyHpDelta(delta, kind)` doing a single
`dispatch("adjust-hp", ...)` — not one event type per button. `kind`
(`"half"`/`"double"`) only affects the label.

Temp HP absorbing damage before real HP happens *inside* that same
mutator, touching `state.hp` and `state.tempHp` together, so undo reverts
both pools as one event rather than needing two paired events kept in
sync. Granting temp HP is separately `dispatch("adjust-temp-hp", ...)`,
which *replaces* the value (temp HP doesn't stack with itself) unlike
damage/heal's additive deltas.

`resizeGrid()` is the same idea at a larger scale: one dispatch covering
the new size, the new origin, the pruned walls and terrain, and any tokens
evicted by a removed row — so a single Ctrl+Z restores all of it rather
than leaving a half-undone board.

### What does *not* dispatch

Anything that only changes *what the UI is showing*: selection
(`selectedSquareKey`), the active tool, zoom, pan, hover previews, which
panel tab is open (`selectedObjectTab`), and Raise a Shield
(`raisedShieldIds`). These set a plain module-level variable and call
`render()` directly.

The test: **if it wouldn't surprise a player to see it silently reappear
after an undo, it's not an event.** Raise a Shield is the interesting case
— it's situational and would be expected to reset, so it's UI-only despite
changing a number on screen. It has to be module-level rather than local
to a render function, since those rebuild their `innerHTML` on every
`render()`, including ones triggered by unrelated dispatches.

Dialog staging is also not an event: the HP dialog's steppers and number
input only stage the value the action buttons will use.

Clearing the event log is a related but distinct case — see Rule 2.
Battle-tab operations are another — see "Multiple battles".

## Rule 2: The event log drives undo/redo

`eventLog` plus a `cursor` (index of the last *applied* event, `-1` if
none) is the only state undo/redo needs:

- **Undo**: if `cursor >= 0`, restore `eventLog[cursor].before`, decrement.
- **Redo**: if `cursor < eventLog.length - 1`, increment, restore
  `eventLog[cursor].after`.
- **New event while not at the end**: truncate everything after `cursor`
  before pushing. The old redo branch is gone, as in any undo stack.

The buttons are **hidden**, not disabled, when there's nothing in that
direction.

### The keyboard shortcut must yield to text fields

Ctrl+Z is wired at `document` level, but it returns early — **before**
`preventDefault()` — when the event target is a text-entry control, so the
browser's own undo can take back half-typed text. Battle undo would
otherwise reach past the field and revert the last real action, with
nothing on screen connecting the keystroke to what it did (the typing was
never an event, per Rule 1).

`isTextEntry()` deliberately **excludes** checkboxes, colour swatches and
range inputs: they hold no text and have no history for the browser to
step back through, so swallowing the shortcut there would just make it
dead while a token's colour picker happens to have focus. If you add an
input type to the page, check which side of that line it falls on.

### Clearing the log

The "Clear" button empties `eventLog` and resets `cursor` directly, no
confirmation — matching `static/app.js`'s `clearRollHistory()`. It is
deliberately **not** a dispatch: `eventLog` isn't part of `battleState`,
and undo/redo work by walking it, so clearing the thing undo depends on
isn't something undo could sensibly reverse. Battle state is untouched;
only the history goes.

The log renders newest-first, one short line per entry, like the main
app's Roll History — so the app feels consistent rather than
battle-helper inventing its own log language. Entries past the cursor are
marked `.undone` so the log stays honest about current state.

## Multiple battles

`battles` is `[{ id, name, state, eventLog, cursor }]`, each a fully
independent encounter with its own undo history, so undoing in one can
never reach into another. The module-level `battleState`/`eventLog`/
`cursor` stay exactly what they always were — the *active* battle's live
values — which is why `dispatch()`, `undo()`, `redo()` and every render
function needed no changes for this feature. `persistBattleStore()` syncs
those live values back into the active entry before writing.

Creating, switching, renaming and closing a battle are deliberately **not**
dispatched, even though they change what's on screen: `dispatch()`
snapshots `battleState` only, and undo/redo walk a single battle's
`eventLog` — a tab operation sits *above* that layer, so there's no
coherent way for a per-battle undo stack to undo it. Same reasoning as the
log's Clear button.

`setActiveBattle()` resets UI-only state rather than carrying it over:
square keys and entity ids mean something different, or nothing, in the
battle being opened.

## Page layout: "boxing"

A fixed set of boxes (`.battle-box`), not a freeform layout. Keep new UI
inside this structure rather than adding top-level regions.

- **Tab strip** across the top (`.battle-tabs`) — one tab per battle. A
  top-level region rather than a box, because the boxing below it is
  per-battle and this strip is what scopes all of it.
- **Left, full height**: roster (top) and event log (bottom), one box split
  by `.battle-box-section`. The "add custom object" form is static markup
  in `index.html`, not regenerated by `renderRoster()`, so a name being
  typed survives unrelated `render()` calls. The log header is
  left-aligned in reading order — Clear, "Event Log", then Undo/Redo
  beside the title they act on — not `space-between`.
- **Right, full height**: initiative track.
- **Centre column**: the map on top, then a bottom row split in two:
  - **Bottom-left, `#battle-object-panel`** — the *object* on the selected
    square, as two tabs. **Character** (`renderCharacterTab()`): identity
    row, HP bar, AC, saves/Perception, conditions. **Token**
    (`renderTokenTab()`): shape, letters, colours. They're tabs and not
    one panel because they're genuinely different subjects — a token's
    shape says nothing about a creature's Fortitude save.
  - **Bottom-right, `#battle-square-panel`** (`renderSquarePanel()`) — the
    *square* itself: coordinates in the heading, difficult terrain under
    them. No "empty square" state; an empty square is still a square.

The bottom boxes split by **subject** (object vs. ground), which is what
decides where new UI goes. A property of whoever is standing there belongs
left; a property of the ground belongs right.

Inside the Character tab, the header row is two clusters pinned to
opposite edges (`space-between`), *not* one row where the HP bar stretches
to fill the gap: `.battle-stat-left` (remove ×, name, level, speed) and
`.battle-stat-right` (HP bar, then AC). When both clusters are narrower
than the row, the empty centre is intentional. The HP bar has three
segments — HP, temp HP, and dark grey "absent" — sized as percentages of
`maxHp + tempHp`, not just `maxHp`, so temp HP visibly eats into the same
fixed-width bar rather than growing it. Below the header, a fixed 2×2 grid
of saves/Perception sits left at its natural width with conditions taking
the rest; the grid is `repeat(2, ...)` rather than `auto-fit`, which would
reflow between 1 and 4 columns as the panel resized and move tiles under
the cursor.

Because the sidebars are full-height flex children of the same row as the
centre column, they stretch to match its height for free.

`.battle-layout` is pinned to exactly `height: 100vh` with `overflow:
hidden` (not `min-height`), so the page fits the viewport with no
page-level scrollbar. Regions that can overflow scroll internally via their
own `overflow`. If a new box's content can grow unboundedly, give *that
box* `overflow: auto` — don't relax the page-level `hidden`.

`battle-helper.js` only ever queries by **id**, never by a box's class
names, so layout can be restyled without touching JS as long as the ids
stay put. When a box's *subject* changes, though, rename its id to match —
leaving `#battle-appearance-panel` rendering square info would have been a
trap for the next reader.

## Avoiding layout jumps

Panels re-render on every `render()` — every dispatch and every selection
change — and several controls only make sense conditionally. It's tempting
to omit the element with a ternary (`` hasShield ? `<button>…` : "" ``),
but that changes how many children a flex box has, which changes its size,
which visibly shifts *everything else on the page*. That's the bug this
project calls **jumping**.

**Always render the element; toggle a class instead of its presence.**
Three techniques, and picking the wrong one reintroduces a subtler version
of the same bug:

**1. One element in a box sized by its children** → `.invisible`
(`visibility: hidden; pointer-events: none;`). Keeps the layout slot, just
invisible and unclickable. The shield toggle inside `.battle-stat-ac` uses
this, plus `tabindex="-1"` / `aria-hidden="true"` when hidden, and only
attaches its listener when there's a shield. Using `visibility` here is
load-bearing — `hidden`/`display:none` would bring the jump back.

**2. Two mutually-exclusive button groups that should each look centred in
the same space** → stack them, don't put them side by side. Side-by-side at
equal `flex: 1` only centres each group within *its own half*, which reads
as depending on the other group's presence. Instead: `position: relative`
with a **fixed height** on the parent, `position: absolute; inset: 0` on
each group with its own `justify-content: center`. Both now centre within
the entire row independently, and the fixed height means neither resizes
the dialog.

Two things bite specifically here, both from a real regression:

- **Hide the group, not its children.** An empty group is still a
  full-size positioned box stacked on top, and it intercepts pointer
  events over its area with nothing painted in it — silently swallowing
  clicks meant for the visible group underneath.
- **`hidden` loses to the group's own `display: flex`.** Author CSS beats
  the user-agent `[hidden] { display: none }` rule regardless of
  specificity, so an explicit `.hp-action-group[hidden] { display: none; }`
  is required. This only matters for elements that declare their own
  `display`.

**3. Give the box a fixed `width`/`height`** so content can't size it at
all. `.battle-stat-ac` is a fixed square, which is *why* its shield-icon
corner badge can safely be a plain present-or-absent ternary. It's a single
`<button>` always, `disabled` when there's no shield, so the whole square
is the click target rather than a small icon inside it.

Skip all of this for elements whose absence genuinely shouldn't reserve
space — the roster/initiative "nothing here yet" rows replace the whole
list rather than sitting alongside real ones.

## Overriding the global `button:hover`

`style.css`'s global `button:hover` (`border-color: var(--accent);
background: var(--accent-soft);`) applies to every button on this page,
including ones with their own background set for a purpose. The
translucent tint stacks on top and wrecks contrast, or silently *replaces*
a solid background with a near-white one.

**The cascade resolves per property, not per rule.** A
`.battle-remove-btn:hover { filter: brightness(1.1); }` has higher
specificity but doesn't declare `background` at all — so for that property
the global rule is the only declaration in the running and applies anyway.
Any custom `:hover` on a button with its own background must **re-declare
every property the global rule sets** (`background`, `border-color`), not
just the ones you're adding.

Two corollaries:

- Keep the effect light once contrast is safe — a border-colour shift for
  panel-style buttons, `filter: brightness(1.1)` for solid-fill ones.
- **`:not(:disabled):hover` needs a matching `:disabled:hover` reset.** It
  only stops *your* rule matching a disabled control; it can't cancel the
  global rule, which has no such guard and matches regardless (`:hover`
  isn't blocked by `disabled`, only click handling is). Without the reset,
  a disabled control still lights up, sourced entirely from the global
  rule leaking through.

## State separation from the main app

Battle state persists to its own localStorage key
(`pathfinder-dm-tools:battle`), separate from the main app's
`pathfinder-dm-tools` character store. `battle-helper.js` only ever
**reads** the character store — never writes to it.

Characters aren't copied into battle state either: a placement stores an
`id` and looks the character back up at render time, so battle-helper
always reflects the current sheet rather than a stale copy. This is also
why **max HP is never stored** — it's recomputed live every render, so if
the sheet changes, the bar's max follows. (Drained complicates this; see
"Conditions".)

HP, temp HP, initiative and conditions are keyed by **entity id, not
square**, so they survive a move. All are cleared on `remove-token` and
`place-token` — leaving the field is a full reset. `currentHp()` /
`currentTempHp()` default to max/0 for any untracked id, which is how a
fresh placement gets full HP with no separate initialisation step. This
"reconcile on read, don't write back" pattern recurs:
`initiativeOrderIds()` and `getAppearance()` both use it, and none of them
mutate outside `dispatch()`.

**Appearance is the exception** — it survives `remove-token` (see
`references/map.md`).

## Custom objects

Name-only entities the DM adds on this page (a trap, a hazard, a prop),
living in `battleState.customObjects` rather than the character store,
since they have no existence outside this battle.

**`findEntity(id)` is the one place that resolves either kind**, returning
a uniform `{ id, name, build, isCustom }` with `build: null` for custom
objects. Everything generic — token drawing, initiative, roster, the
object panel, placement — goes through it rather than
`loadCharacters().find(...)`, so a custom object behaves exactly like a
character everywhere without a parallel set of code paths. The one
exception is the HP dialog, which only ever opens from the full character
panel, so `hpDialogCharacterId` can never hold a custom object's id.

`renderCharacterTab()` branches on `!entity.build`: a custom object (or,
defensively, a character missing sheet data) gets name + remove button +
conditions, no HP bar or stat grid. Both branches share
`bindRemoveButton()` so removal behaves identically.

**Deleting** a custom object (the red × in the roster) is distinct from
removing it from the field: removal un-places it but keeps the definition
so it reappears in the roster; deletion erases it for good. Only custom
objects get this — real characters are managed on the main page. Its
handler calls `stopPropagation()`, since it's nested inside the `<li>`
whose own click arms the entity for placement.

## Initiative track

Two pieces of state, deliberately not derived from each other:

- **`initiative`** (`id -> number`) — the number, set via a dialog opened
  from the small value box on a row (shows `—` when unset; submitting
  empty *clears* it, so `—` is a reachable state, not just a default).
  Purely informational, and works for any placed entity.
- **`initiativeOrder`** (`id[]`) — the display order. This is what controls
  the list, **not** a sort by the number. Sorting would fight manual
  drag-and-drop on every render, snapping any reorder straight back.

Reordering uses the native HTML5 DnD API (unlike the map — see
`references/map.md` for why that one is hand-rolled) and commits via
`dispatch("reorder-initiative", ...)` on drop: real battle state, not a UI
convenience.

The value button lives *inside* the draggable `<li>`, which needs two
guards: `draggable="false"` on the button, so clicking it doesn't start a
drag; and the handler loop must query `"li[data-entity-id]"`, not the bare
attribute — the button carries the same attribute and the unscoped
selector would attach drag handlers to it too.

**Selection is shared both ways** with the map, and stays UI-only.
Clicking a row resolves the entity's square via `squareKeyForEntity()`;
the other direction needs no code at all, since `renderInitiative()`
already reads `selectedSquareKey` every render.

## Conditions

`battleState.conditions[entityId][conditionId] = { active, value }`.
`active` is the checkbox — a condition can be applied but suppressed,
which is how a DM parks something that isn't currently biting without
losing its tier. `value` exists only for valued conditions.

The dictionary and all the effect maths live in `static/pf2e-conditions.js`
(loaded as a plain global before `battle-helper.js`, like `pf2e-math.js`),
which stays free of DOM code. Three ideas there are worth knowing before
touching any of it:

- **Stacking is per type.** Only the worst penalty of a given type applies
  (and the best bonus), while untyped ones always stack. Frightened 2 +
  Sickened 1 is −2, not −3; Frightened 2 + Flat-Footed really is −4 to AC.
  `combineModifierTerms()` keeps the losing terms with `applied: false`
  rather than dropping them, so a tooltip can explain itself.
- **AC is a DC**, so "all checks and DCs" conditions reach it. One umbrella
  key in `PF2E_STAT_SOURCES` does that instead of every entry listing five
  stats.
- **Conditions impose other conditions, transitively** — Encumbered →
  Clumsy 1, Dying → Unconscious → Blinded + Flat-Footed.
  `resolveConditions()` expands the graph breadth-first with a visited
  guard: the data is acyclic today, but a cycle would hang `render()`.

Imposed conditions are **derived on every read, never stored.** Removing
Encumbered has to take its Clumsy with it and must not disturb a Clumsy
applied separately, and deriving is the only way that stays true without a
bookkeeping pass on every add/remove. They render as italic rows with a
disabled ticked checkbox naming their source.

Effects on rolls this page doesn't make (Enfeebled's melee penalties,
Clumsy's skills) stay prose-only in the summary **on purpose** — a
half-modelled penalty a DM leans on is worse than none. Same for
conditional ones whose trigger the page can't know, like Blinded's −4
Perception "if vision was your only precise sense". If you add effects,
add them for stats the panel actually shows.

Drained breaks the "max HP is never stored, just recomputed" rule's
simplicity by *lowering* max HP, so everything that clamps HP goes through
`effectiveMaxHp()` — the panel and the damage/heal dialog both, so healing
can't exceed the reduced cap. A stat a condition moved renders red with the
arithmetic in its tooltip; an untouched stat renders exactly as before, so
red always means a live condition.

## Verifying changes here

There's usually no Node and no browser automation available locally, so
UI behaviour genuinely cannot be confirmed from the agent side — say so
rather than claiming it works, and ask the developer to click through it
(this is what step 2 of the `pathfinder-dm-tools` workflow is for).

What *can* be checked locally, and has caught real bugs:

- **Brace/paren balance** on edited JS, and `{`/`}` plus `/*`/`*/` counts
  on the CSS. CI's `node --check` is the real syntax gate, but it only
  runs after a push.
- **Cross-checks between files** — every class the JS emits exists in the
  CSS, every id the JS queries exists in the HTML, every `data-*` value
  matches its constant.
- **Python mirrors of the pure logic.** The condition resolver, the
  pathfinder, the door-magnet geometry and the anchored-coordinate resize
  all have executable mirrors that parse their data out of the shipped
  source rather than copying it, so they can't drift. When a mirror
  disagrees with an expectation, check which one is wrong before "fixing"
  the code — several times the code was right and the test's assumed route
  or symmetry was not.
