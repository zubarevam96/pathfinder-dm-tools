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

**The two bottom boxes are the tightest space on the page**, and anything
added to either is a trade against what's already there. Before adding a
control, row, heading or label to `#battle-object-panel` or
`#battle-abilities-panel`, read `references/bottom-boxes.md` — it carries
the compactness check, what each box already spends its space on, and how
the "reserve space to avoid jumping" rule is reconciled with not wasting
any.

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
| `persistentDamage` | `entityId -> [{ id, type, value, die }]` | a list — duplicate types allowed; `die: null` = flat; cleared wherever `conditions` is |
| `spellSlots` | `entityId -> { "casterKey:level": bool[] }` | `true` = spent; read with a clamp, never written back into shape |
| `inventory` | `entityId -> { items: [{name, qty}], money }` | DM-added loot and coin; **survives leaving the field**, like `appearance` |
| `adjustment` | `entityId -> "elite" \| "weak"` | absent = unadjusted; also survives leaving the field |
| `overrides` | `entityId -> { statKey: number \| null }` | DM-set numbers; absent = not overridden, `null` = a speed removed. Survives leaving the field — see "DM overrides" |
| `customObjects` | `id -> { name, monster? }` | `monster` = bestiary entry, for monsters |
| `characterIds` | `characterId[]` | which characters are in THIS battle |
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
panel tab is open (`selectedObjectTab`), Raise a Shield
(`raisedShieldIds`), and the copy/paste `clipboard`. These set a plain
module-level variable and call `render()` directly.

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

### Keyboard shortcuts, and what they must yield to

Two `keydown` listeners at `document` level: one for the Ctrl combos
(undo/redo, copy/paste), one for the unmodified map keys — **Delete** to
take the selected token off the field, **WASD** to grow the board on that
side, **Shift+WASD** to shrink it, and the **digits** to pick an instrument
by its position in the tool palette (see `references/map.md`).

Every shortcut here has to get out of the way of something:

- **Text fields.** Both listeners return early on `isTextEntry()`. Bare
  letters make this critical rather than merely polite — without it,
  typing "a" into the monster filter would grow the board.
- **Open dialogs.** A modal traps focus but `keydown` still bubbles to
  `document`, so the map keys also bail on `dialog[open]`. Otherwise
  tabbing to a dialog button and pressing "d" silently resizes the board
  behind the backdrop.
- **Modifier combos.** The map listener ignores anything with Ctrl/Meta/
  Alt held, so it can't shadow a browser shortcut.

`Delete` and the Character tab's × both call `deleteSelectedToken()` —
one event type, one piece of cleanup, no chance of the two drifting.

### Ctrl+Z must yield to text fields

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
  - **Bottom-left, `#battle-object-panel`** — everything the selected
    square *is*, as three tabs. **Character** (`renderCharacterTab()`):
    identity row, HP bar, AC, saves/Perception, conditions. **Token**
    (`renderTokenTab()`): shape, letters, colours. **Square**
    (`renderSquareTab()`): coordinates and difficult terrain. Tabs and not
    one panel because they're genuinely different subjects — a token's
    shape says nothing about a creature's Fortitude save. Only the Square
    tab has no "empty square" state; an empty square is still a square.
  - **Bottom-right, `#battle-abilities-panel`** (`renderAbilitiesPanel()`)
    — what that creature can *do*, as tabs split by when a DM reaches for
    them. **Actions** (`renderActionsTab()`): strikes, then named special
    abilities — the in-combat page. **Spells** (`renderSpellsTab()`): spell
    levels, slots and lists — also in-combat. **Proficiencies**
    (`renderProficienciesTab()`): attribute modifiers, skills and languages —
    the out-of-combat one. **Inventory** (`renderInventoryTab()`): coin and
    carried items. **Info** (`renderInfoTab()`): a monster's flavour text,
    traits and senses — the "what *is* this thing" page, and the only tab
    that answers a question about the creature rather than about the fight.
    Its tab list is built per entity by `abilityTabsFor()`. **Every tab is
    conditional** — a custom object can have nothing but Inventory — so the
    list is built in one fixed order and filtered, never reordered: a tab
    appearing must not move the ones already there. When the selection
    changes to something lacking the active tab, it falls back to the first
    tab that *is* present rather than leaving nothing selected. It reuses the
    left box's `.battle-object-tabs` markup and classes deliberately: one
    tab pattern on the page, not two.

**The `.battle-object-tabs` strip is sticky** in both bottom boxes, which
are themselves the scroll containers. Two things about that are easy to get
wrong and were both hit:

- A sticky box is held in the scrollport by its **margin box**, so a
  negative `margin-top` (to close the gap under the box's padding) pushes
  its *visible* border box down by the same amount and opens a band that
  scrolled content shows through. The fix is for the box to drop its
  `padding-top`, not for the strip to cancel it. Hence
  `.battle-box-bottom-left/right { padding-top: 0 }`.
- The strip's negative margins are **horizontal only**, cancelling
  `--box-pad-x` so it spans the full width — without that, content scrolls
  visibly through the padding gutters beside it. `--box-pad-x`/`--box-pad-y`
  exist on `.battle-box` for exactly this, so the two can't drift.

The bottom boxes split by **is vs. does**, which is what decides where new
UI goes. Anything describing the selection — the creature, its token, the
ground under it — is a tab on the left. Anything it can perform belongs
right. (Square lived in its own bottom-right box until abilities needed
that space; it is a third view of the same selection, so it moved in with
the other two rather than displacing either.)

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

**Monsters can have shields too**, so `hasShield`/`shieldBonus` come from
`getAcBonuses(build)` for characters and from `stats.shieldBonus` otherwise —
everything downstream (the toggle, `raisedShieldIds`, the corner icon) was
already generic. The bonus is **read off the page, never inferred from an
item name**: all three shield-bearing monsters in the corpus print it as a
second AC (`18 (20 with shield raised)`), which `PAGE_SHIELD_AC` parses.

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

**Which characters are in a battle is battle state**, though —
`characterIds`, filled from a picker that lists them under the same groups
`renderSidebar()` uses on the main page (groups in store order, then
"Ungrouped" for anything with no group *or* a group id that no longer
resolves; keep the two in step). The roster shows only those, not everyone
in the store — a DM running one encounter shouldn't scroll past three
other parties.

Removing a character from a battle is `remove-character`, and it only
touches `characterIds` and their battle progress; the sheet is untouched
and they can be re-picked. This is why the roster's × means two different
things and spells out which in its `title`: for a battle-local entity it
deletes the thing outright, for a character it just takes them out of this
encounter.

`battleCharacterIds()` reconciles the stored list against the store on
read, dropping ids for characters deleted on the main page — the same
read-time-only fixup as `initiativeOrderIds()`, returning a corrected list
without writing one back. A save from before `characterIds` existed is
seeded in `normalizeState()` from the characters *actually placed* in that
battle, not from the whole store: anything else would refill every old
battle's roster with people who were never in it, which is the mess the
change was made to avoid.

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

## Custom objects and monsters

Battle-local entities the DM adds on this page, living in
`battleState.customObjects` rather than the character store, since they
have no existence outside this battle. Two flavours, one storage:

- **Custom objects** — name only (a trap, a hazard, a prop).
- **Monsters** — the same, plus `monster`, the bestiary entry they came
  from. Deliberately **not** a third entity kind: everything custom
  objects already do — placement, initiative, conditions, appearance,
  removal, deletion, renaming — then works for monsters with no parallel
  code paths.

`monster` is the *statblock reference*, which is not the same as `name`:
renaming "Goblin Warrior 2" to "Sneaky Pete" must keep pointing at the
same statblock, so rename spreads the existing object rather than
replacing it, and the monster count in the picker tallies by `monster`,
not by name.

**`findEntity(id)` is the one place that resolves any of them**, returning
a uniform `{ id, name, build, isCustom, monsterName }` with `build: null`
for battle-local entities. Everything generic — token drawing, initiative,
roster, the object panel, placement — goes through it rather than
`loadCharacters().find(...)`. The one exception is the HP dialog, which
only ever opens from the full character panel, so `hpDialogCharacterId`
can never hold a battle-local id.

`renderCharacterTab()` branches on `!entity.build`: name + remove button +
conditions, no HP bar or stat grid, plus a statblock button when
`monsterName` is set. Both branches share `bindRemoveButton()`.

**Naming.** `uniqueEntityName(base)` gives the first of a kind the bare
name and only numbers subsequent ones ("Goblin Warrior", "Goblin Warrior
2"), so a lone monster doesn't read as one of a set. It checks against
*every* name in the battle, characters included, so a monster can't
collide with one. Freed numbers get reused rather than counting ever
upward.

**Copy/paste** (Ctrl+C / Ctrl+V over the roster or the initiative track)
copies a *description* — base name plus statblock reference — not an
entity id, so copying something and then deleting it still pastes. The
base comes from `baseEntityName()`, which strips a trailing number, so
pasting "Goblin Warrior 4" continues the series instead of producing
"Goblin Warrior 4 2"; for a monster the base is its statblock name, so a
renamed one still pastes as its own kind.

Characters aren't duplicable — there is one Tumb, his sheet lives in the
main store, and a battle-local "Tumb 2" would be a name with no stats
behind it. Pasting a copied character instead **adds them to the current
battle**, which makes Ctrl+C/Ctrl+V the way to carry someone between
battle tabs; the clipboard deliberately survives `setActiveBattle()` for
exactly that, while the "copied" row highlight doesn't.

The shortcut only calls `preventDefault()` once it's actually going to do
something, so a Ctrl+V with an empty clipboard falls through to the
browser instead of becoming a dead key. It also defers to a non-collapsed
text selection on Ctrl+C — if the DM highlighted a name to copy, that's
what they meant.

**Renaming** works for battle-local entities only, by double-clicking a
row in the initiative track. A character's name belongs to their sheet,
and this page never writes to the character store — the row's `title`
says which case it is, so a double-click that does nothing isn't a
mystery. The listener is delegated to the `<ul>` for the same reason the
battle tabs' rename is; see "Avoiding a broken dblclick" below.

**Deleting** (the red × in the roster) is distinct from removing from the
field: removal un-places an entity but keeps the definition so it
reappears in the roster; deletion erases it for good. Its handler calls
`stopPropagation()`, since it's nested inside the `<li>` whose own click
arms the entity for placement — the monster statblock button beside it
needs the same guard for the same reason.

### Placing: two gestures, one function

A roster row can be **armed** (click it, then click a square) or **dragged**
straight onto a square. Both go through `placeEntity(entityId, key)`, which
is the point: seeding HP from the build, clearing stale temp HP and
conditions, and pushing onto the initiative track are all easy to remember
in one entry point and forget in the other. An occupied square is a no-op
in both, never a swap.

The drag is native HTML5 DnD — the same choice the initiative track makes,
and for the same reason: what's being dragged *is* an element. (The map's
own token drag is hand-rolled from mouse events only because a canvas has
no per-square element to make `draggable`.) Three things it has to get
right:

- **`dragstart` must not `render()`.** It clears `armedEntityId`, so
  re-rendering is tempting — but `render()` rebuilds the roster, and
  destroying the element a drag started from cancels the drag. The stale
  armed highlight lasts until the drag ends, moments later.
- **`dragover` must `preventDefault()`**, or the canvas isn't a drop target
  at all and the browser shows "no entry" across the whole map. It sets
  `dropEffect` too, so the cursor gives the same yes/no answer as the
  green/red square tint, where the pointer is already looking.
- **`dragend` can't be the only cleanup.** A successful drop re-renders the
  roster, and the row — now placed — is gone from it before `dragend` would
  fire. The drop clears the drag state itself; `dragend` is the backstop for
  drags that end anywhere else.

The row's handlers are bound with `querySelectorAll("li[data-entity-id]")`,
not the bare attribute selector: the delete button carries
`data-entity-id` too, and would otherwise pick up the row's arm and drag
behaviour. Making the row `draggable` also makes everything inside it a
drag handle, so both buttons need `draggable="false"` — the same opt-out
the initiative track's value button uses.

The roster drag reuses `dragHoverKey` for the target tint but never
`dragFromKey`, which is what suppresses the walked-path overlay: a token
arriving from the roster isn't walking anywhere. The two gestures can't
overlap, since starting a native drag stops `mousemove` firing.

### Statblocks come from Archives of Nethys, not from here

`local/static/monster-data/monsters.json` (built by
`local/scripts/build_monster_entities.py`) maps a monster name to an AoN
page. Clicking a monster opens that page in an iframe popup — the same
`openAonPopup()` the main app uses for spells and items, with the dialog
markup and CSS shared via `style.css`.

**Monster data is local-only and is not published.** `local/` is the
gitignored half of the repo: build scripts (`local/scripts/`), their source
tables and the AoN download cache (`local/data/`), smoke-test output
(`local/partial/`), *and* the monster JSON itself (`local/static/`). One
`.gitignore` rule covers all of it. Nothing derived from Archives of Nethys
is committed.

That used to mean the deployed site had no monster statistics at all. It no
longer does: **stats are fetched one creature at a time, on first selection**,
through `GET /api/monster` (`monsters.py`), and cached server-side. The
committed index still supplies names and AoN ids for the picker; the bulk
files are an optional, slightly richer source that wins where present.

Three things about that path are easy to get wrong:

- **The browser cannot fetch AoN itself.** Its backend 403s any request
  carrying an `Origin` header — verified, the same URL answers 200 without
  one — and no `Access-Control-Allow-Origin` is sent either. A browser cannot
  suppress `Origin`, so this is not a caching or a proxying preference; a
  direct fetch is impossible, and that is why a server route exists.
- **`monsters.py` and `local/scripts/build_monster_entities.py` parse the same
  format.** Change one and change the other, or a monster reads differently
  depending on which fetched it.
- **Only the search index is read, not the rendered page.** The build script
  reads both; the page is the only source of conditional skill bonuses and
  Recall Knowledge DCs, so those stay empty on the live path rather than
  costing a second request to a third party while somebody waits.

`loadMonsters()` still treats a failed fetch as "no monsters available", and
`monsterStats()` returning null while a fetch is in flight is the same answer
callers already handle for "this thing has no stats" — so both degrade to the
minimal panel rather than throwing.

Spell and item data are the *opposite* case — still generated by scripts in
`local/scripts/`, but written to `static/spell-data/` and
`static/item-data/` and committed, so they ship inside the image with no
volume involved. Don't "fix" the inconsistency by moving those without
asking; the split is deliberate.

Two things differ from the item pipeline:

- **Creatures aren't all on one page type.** Items resolve to a fixed page
  per category (armor → `Armor.aspx`), so the app stores only an id.
  Creatures are split across `Monsters.aspx` and `NPCs.aspx` with nothing
  in the name to say which, so the page is stored per monster. Id and page
  are always written together — a half-resolved entry would build a broken
  URL.
- **Picking the right AoN document is harder.** A creature name routinely
  matches the legacy Bestiary entry, its Monster Core replacement, and
  sometimes an adventure reprint. "Prefer no `remaster_id`" narrows it but
  doesn't finish — an adventure reprint has none either. The build script
  then filters on the source table's level/HP/AC, and finally prefers a
  core rulebook over an adventure module.

### Monster stats are baked in at build time, and this is not optional

`monsters.json` carries each creature's level, HP, AC, Fort/Ref/Will,
Perception and speed, so a monster token has a real HP pool, a real AC and
real saves that conditions modify exactly like a character's.

**Archives of Nethys cannot be read from a browser on our origin.** Its
elasticsearch backend allowlists exactly one `Origin` —
`https://2e.aonprd.com` — and answers every other one, including `null` and
its own parent domain, with **403**. The HTML pages send no
`Access-Control-Allow-Origin` at all. A browser cannot suppress or forge
the `Origin` header, so there is no client-side cache, retry or
request-coalescing scheme that makes a runtime fetch work. Don't spend time
rediscovering this; verify with a request carrying an `Origin` header if you
doubt it. (The statblock popup still works because an iframe isn't subject
to CORS — but its contents can't be read cross-origin either, so scraping
the iframe is not a way around it.)

Resolving at build time is also simply the right thing to do to someone
else's backend: the app makes **zero** requests to AoN for stats, however
many DMs open however many battles. The stats cost the build script no
extra requests either — they come out of the same response that already
resolved the statblock link, which was previously being discarded.

The level/HP/AC columns in `local/data/monsters.txt` stay *lookup hints* and are
not shipped. The resolved AoN document is the authority; publishing two
copies of the same number only invites them to disagree.

### Two data files, split by when they're needed

- **`monsters.json`** (~14 KB gzipped) — name, AoN id/page, stats. Loaded at
  startup: it drives the roster picker and every placed monster's stat panel.
- **`monster-abilities.json`** (~216 KB gzipped) — strikes, attribute
  modifiers, special abilities. Loaded **lazily**, on the first render that
  actually needs it, via a memoised promise so N renders cause one request.

Keep them apart. Merging abilities back in would put ~230 KB on the critical
path of a page whose main job is drawing a grid, for something a session
might never open. `entityAbilities()` returns the string `"loading"` — not
`null` — while the file is in flight, because "hasn't arrived" and "has none"
must render differently. A failed fetch caches an empty `Map` so it isn't
retried on every render.

### Abilities are parsed from AoN's markdown at build time

`parse_abilities()` in the build script turns AoN's pseudo-markdown
statblock into `{strikes, attributes, special}`. The format's one gift is
that it's **blank-line separated, with every strike and every ability as
exactly one paragraph** — so "split on blank lines, classify by the leading
`**Label**`" is a complete parse, not a pile of heuristics. Three things it
must keep doing:

- **Scan only from the level-2 title down.** Above it is flavour prose and
  Recall Knowledge, full of bold runs that would otherwise parse as
  abilities.
- **Use AoN's own `creature_ability` list as an allowlist** for what counts
  as an ability. The statblock's field labels vary by creature type
  (Immunities, Weaknesses, Spells, Rituals…), so a blocklist would quietly
  promote any unfamiliar label into a fake ability.
- **Compute the multiple-attack penalty**: −4/−8 for agile strikes, −5/−10
  otherwise, from the strike's traits. A DM reads it every round.

Ability text keeps AoN's `**Trigger**`/`**Effect**` bold runs. It reaches
`innerHTML`, so `abilityText()` escapes first and promotes *only* the bold
markers afterwards — that order is the whole point.

Characters' strikes come from Pathbuilder weapons instead, and deliberately
carry **no kind and no traits**: the export says neither melee/ranged nor
agile. Guessing from the weapon name would mislabel often, and a wrong agile
guess would show the wrong penalty every round.

### The rendered page is the source of truth, not the search index

Two requests per creature, doing different jobs:

1. **The elasticsearch query picks WHICH page.** A creature name routinely
   matches three documents (legacy Bestiary, Monster Core remaster, an
   adventure reprint), and the index's level/HP/AC/source fields are what
   tell them apart. This is all it's used for.
2. **The page is then parsed for every published value** (`parse_page`).

The index is not good enough to parse from, and this was measured, not
assumed. For Giant Gecko it drops: the conditional skill bonus
(`skill_markdown` says `Athletics +5` where the page says
`Athletics +5 (+9 to Climb)`, and **no** field anywhere holds that `+9`);
the printed multiple-attack penalties (`jaws +8 [+3/-2]` vs
`attack_bonus=8`); the damage expression (only `strike_damage_average`);
and Recall Knowledge DCs entirely. Don't re-derive this — check a page
against its document if in doubt.

If a page can't be fetched (about 1 creature in 60 after one retry), the
index-based extraction still runs as a fallback: the creature keeps its
core numbers and loses only the detail above.

`statblock_text()` converts `<b>` to `**…**` *before* stripping tags,
because bold is the page's only structural signal — every field label and
every ability name is bold, and nothing else is. Three things the parser
must keep doing:

- **Anchor on the `monster-statblock-name` heading.** The page opens with
  another `<h1 class="title">` above the flavour text; matching that one
  swallows paragraphs of prose and finds no statistics at all.
- **Segment on bold runs globally, not line by line.** The page emits
  consecutive strikes and abilities on a single line with no `<br>`
  between them, so a per-line parse hands the first `Damage` field the
  entire rest of the statblock — one strike with a wall of text for damage,
  and no abilities.
- **Treat lowercase bold as inline emphasis, not a label.** Statblocks bold
  condition names mid-sentence ("has a creature **grabbed** or restrained").
  Ability names are always Title Case; without this the zombie grows an
  ability called "grabbed" holding the rest of its real one.

The skills line parser additionally must **split on commas outside
brackets** (`Athletics +5 (+9 to Climb, +7 to Swim)` is one skill, not two)
and **unwrap brackets in a loop** (Magnetic Gecko ships
`Athletics +6 ((+8 to Climb))`).

A conditional bonus renders *beside* the flat one, never replacing it —
both apply, and which is live depends on what's being attempted.

**`--limit` and `--skip-lookup` write `*.partial.json`** and leave the
shipped files alone. A partial run used to overwrite 558 resolved monsters
with however many it had done, which looks fine until a panel comes up
blank.

### Downloading and parsing are separate steps

Every response — the search document and the whole statblock page — is
cached under `local/data/aon-cache/` (`index/<slug>.json`, `pages/<page>-<id>.html`),
and a build reads the cache before it reaches for the network. The first
build downloads ~1100 pages over about half an hour; every build after that
parses those same pages off disk in **seconds, sending zero requests**.

This is what makes the parser cheap to fix. Before the cache, correcting a
regex meant re-downloading the entire corpus from a third party to produce
output that differed only because the regex changed — which is both slow
enough to discourage fixing anything and rude to AoN. `--refresh` forces a
re-download, and is only needed when *AoN itself* has changed; a parser
change never needs it.

What's cached is the **full** response, not the fields extracted from it.
A parser taught to read something new — spells, immunities, resistances,
senses — picks it up straight out of the cache. The pages already on disk
carry far more than the app currently displays.

Four things this layer gets right on purpose, each of which was a way to
get it subtly wrong:

- **The politeness delay is paid per download, not per creature** (it lives
  inside `load_page()`, not at the call site). Otherwise a fully cached run
  still sleeps its way through all 560 entries for requests it isn't making.
- **A failed fetch is not cached.** Nothing is written, so the next run
  retries instead of remembering the failure forever.
- **An empty cache file counts as a miss**, so a write interrupted halfway
  gets re-fetched rather than being served as a cached empty page.
- **The cached search file records the name it was fetched for.**
  `cache_slug()` isn't injective — "Devil, Horned" and "Devil Horned" share
  a stem — and a mismatch counts as a miss. Getting this wrong hands one
  creature another's document: a *wrong* statblock, not a missing one.

The cache stays under `local/` with everything else derived from AoN. It is
also large — ~50 MB of HTML for the full corpus, against 2 MB for the JSON
parsed out of it — which is its own reason never to commit it.

A full cold build is 1116 requests over roughly half an hour. Once cached,
the same build resolves **558/560 creatures with zero index fallbacks**;
the two misses are names in `monsters.txt` with no matching AoN document at
all, not fetch failures.

Characters' skills are computed instead, from `build.proficiencies` through
`checkTotal()`, and **only trained and above** are listed — an untrained
skill is just the attribute modifier already shown above it, and eighteen
such rows would bury the handful that matter. That matches what a monster
statblock lists.

**Secondary speeds are broken out of `stats.speedText`** by `parseSpeeds()`,
which splits the prose ("20 feet, climb 20 feet, swim 20 feet") on commas
and reads an optional movement type off the front of each part. The walk
speed is seeded from `stats.speed`, not the prose, so it stays the value the
rest of the panel agrees with. Anything not matching an optional type plus a
number is **dropped** — that's what keeps the trailing special abilities the
same field carries ("; unfettered movement", "earth glide"), and the one
creature whose entry caught a page of scraped AoN navigation, from rendering
as nameless speeds. Across the corpus this yields 557 walk, 171 fly, 104
swim, 85 climb and 34 burrow, with no unrecognised types.

Condition modifiers apply to **every** speed, not just walking: PF2e's Speed
penalties hit all your Speeds, and a slowed dragon showing an unmodified fly
speed beside a modified walk speed would be the panel disagreeing with
itself.

Recall Knowledge (e.g. `"DC 15 • Humanoid (Society)"`) rides in **`stats`,
not `abilities`**, and is shown on the Character tab just above Conditions.
The split is deliberate: the Character panel renders from the index that
loads at startup, while abilities are fetched lazily per monster, and a line
on an always-visible panel must not wait on a lazy fetch to appear.

### Spells are a character-only tab

`entitySpells()` reads `build.spellCasters` / `build.focus` in the same shape
`static/app.js` does, and returns `null` — hiding the tab — for anything with
no spells. **Monsters never have any**: the build script parses strikes and
special abilities out of a statblock but not spell lists, so `entity.build`
is the gate.

Slots are keyed `"casterKey:level"`, where the caster key is its **index**,
not its name: two casters can share a name, and renaming one in Pathbuilder
must not hand its spent slots to the other. `perDay` is indexed by spell
level. Cantrips (level 0) deliberately get **no** slot pips — unlimited
casting has nothing to count down — and focus spells collapse to one row
keyed `focus`, because Focus Points are a single pool rather than per-level
slots.

Spending a slot is a `dispatch()`ed event like HP, so Ctrl+Z puts it back,
and `spellSlots` is cleared everywhere the other per-entity progress is
(place, remove, delete, remove-from-battle, resize eviction). **Refresh
deletes the entity's whole record** rather than rebuilding it full: an absent
record already reads as all-unspent, so a refresh can't bake in a slot count
from before the character levelled.

Spell names open the AoN popup via `spellUrl()`, backed by a lazily loaded,
memoised map from the committed `static/spell-data/*.json`. Until it arrives
— or if it fails — chips fall back to AoN search, which resolves a spell by
name well enough that no loading state is needed.

### Inventory is what they're carrying, not what it does

`entityInventory()` reads `build.equipment` / `weapons` / `armor` / `money`.
**Weapons and armor appear here as well as elsewhere** on purpose: a weapon
is a strike on Actions and armor is folded into AC, but those show what the
item *does*, and this tab answers "what is on them" — the question a disarm,
a loot or a hand-off raises.

Pathbuilder writes loose gear as `[name, qty, note]` **triples, not
objects**, the same shape the main app's `inventoryTable()` destructures;
anything that isn't a populated triple is skipped rather than drawn as a
blank row. Empty groups are dropped entirely instead of showing "None".

Item names resolve through `itemUrl()` and a lazily loaded map over
`static/item-data/*.json`. Unlike spells, an item's AoN *page* varies by
category (`Armor.aspx`, `Weapons.aspx`, …), so the map stores category and
id together. A weapon or armor's `display` name can carry a material or rune
prefix that resolves against nothing, so the base `name` is what's looked
up — the same split `itemNameLink()` makes in the main app.

**Anything placed can carry loot**, not just characters: `battleState
.inventory` holds DM-added items and coin for monsters, custom objects (a
chest with loot is the same idea) and characters alike. Adds, removals and
coin changes all `dispatch()`; adding the same item twice **stacks** it
rather than growing a second chip. Sheet gear has no remove control, because
this page never writes to the character store — only the DM's own additions
are removable, the same boundary that stops a character being renamed here.

Unlike HP and conditions, **`inventory` survives `remove-token`** — loot is
what a creature carries, not battle progress, so moving it off the board and
back must not empty its pockets. It is cleared only where the entity itself
goes away: outright deletion, and a character leaving the battle.

The coin row sits **at the top of the tab** and **always renders all four
denominations, zeros included**. Hiding empty ones made "no silver" and
"silver not tracked" identical, and changed the row's width whenever a purse
ran out. Battle-local coin *replaces* the sheet's once set, rather than
adding to it.

A monster's statblock `Items` line is folded in as its own group. It is
split at build time by `split_outside_parens()`, not on commas: `wooden
shield (Hardness 3, HP 12, BT 6)` is **one** item, and a naive split makes
three, two of them named "HP 12" and "BT 6".

Editing happens in `#battle-inventory-dialog`, **not** in the tab: the panel
is rebuilt on every `render()`, so an input living there would lose a
half-typed item name to any unrelated dispatch — the same reason the
roster's add-object form is static markup.

`renderAbilitiesPanel()` therefore **no longer returns early** when a
creature has no parsed abilities. It used to print "Custom object — nothing
to do." and stop, which would now make loot unreachable for exactly the
cases that need it: custom objects, and every monster on the deployed site,
where the abilities file isn't published. Actions and Proficiencies simply
don't appear; the fallback tab is the first one that *is* present, not
Actions. The strip's corner slot holds a per-tab control — refresh on
Spells, nothing elsewhere. Inventory's add button deliberately **isn't**
there: a control in the strip's far corner reads as acting on the whole tab,
so it sits beside the coin row it actually edits.

### `entityAbilities()` is a gate, not a window

It is the **only** reader of `monsterAbilitiesByName`, and it returns a
literal listing its keys — so a field it doesn't copy out cannot reach a
panel however well the build script parsed it and however many monsters
carry it. Info, Proficiencies' languages and Inventory's statblock items all
shipped blank for exactly this reason: the parser, the data file and the
render code were all correct, and the four-key return in the middle threw
the fields away.

Two habits that would have caught it, and are worth keeping:

- **Add the key to both branches**, monster and character, the character one
  as an explicit `null`/`[]`. A missing key and a null key read identically
  at the destructure, so the omission is invisible until someone extends the
  monster branch alone.
- **Verify along the real call chain.** The check that "passed" fed a Python
  mirror of `entityInfo()` straight from the JSON, which is the one path the
  app never takes. A mirror has to start where the app starts.

### Info is the monster's identity, not its numbers

`entityInfo()` pulls `flavour`, `traits` and `senses` off the abilities file,
and the tab hides when none are present — which is every character, since a
Pathbuilder build has no equivalent. Coverage across the 558 cached pages:
traits 558, senses 545, flavour 537.

**Flavour comes from the page's `<meta name="description">`**, not from the
prose above the statblock. Scraping the prose means deciding where the
description ends, and that boundary moves from page to page; the meta tag is
one unambiguous string AoN maintains for the same purpose.

### Elite and weak adjust the numbers, never the prose

The two Monster Core templates, as a three-position switch beside the level
on the Character tab. They're applied at the two normalising choke points —
`applyAdjustmentToStats()` inside `entityStatBlock()`, and
`applyAdjustmentToAbilities()` inside `entityAbilities()` — so an adjusted
monster's numbers simply *are* its numbers to the stat panel, the HP pool,
`effectiveMaxHp()`, the damage dialog and the condition pipeline. No caller
knows the feature exists.

**Structured numbers are adjusted; AoN's prose is not.** Ability text ships
verbatim, and a regex rewriting the DCs inside it would have to tell "DC 17
Fortitude" (shift it) from "DC 5 flat check" (never shift it — 24 of those
in the corpus) with nothing to go on but the words after the number.
`renderActionsTab()` prints what's left to do by hand instead of guessing.
That's also why Speed, the attribute modifiers and `shieldBonus` are
untouched: the template lists what it changes, and none of them are on it.

Details that are load-bearing:

- **HP is keyed off the *starting* level**, before the level itself moves.
  Reading it off the adjusted level puts every creature on a table boundary
  in the wrong band.
- **Current HP moves with max HP.** `placeEntity()` writes a real number into
  `state.hp` the moment anything is placed, so nothing on the field is ever
  "untracked" — without an explicit shift, a 30/30 creature made elite reads
  30/45, having grown a bigger body and taken 15 damage in one click. What
  survives the change is the *wound*: 22/30 becomes 37/45. This is the reason
  `baseStatBlock()` is split out of `entityStatBlock()` — the shift needs the
  max HP the entity is **about to** have, which the adjusted result can't
  give you. It's computed outside the mutator, which sees only live state,
  and floored at 0 rather than 1, since a creature made weak while nearly
  dead can legitimately drop to dying.
- **The level rules aren't plain ±1.** Elite takes −1 and 0 up by *two*;
  weak takes 1 down to *−1*. Max HP is floored at 1, or a weak level −1
  creature arrives dead.
- **Strike damage moves by 2 once**, on the leading dice term only — "plus
  1d6 fire" is a rider, not a second thing to adjust. `DAMAGE_HEAD` keeps
  its whitespace **inside** the optional modifier group; outside it, the 71
  strikes with no flat modifier lose the space before their damage type
  ("1d6+2piercing"). AoN writes 14 negative modifiers with an en dash, so
  the sign is read as text rather than parsed.
- **A skill's conditional bonus is a full alternative total** ("+9 to
  Climb"), so it moves by the same 2 as the flat one.
- **The switch's icons are rank marks, not arithmetic signs** — a crown, a
  dot, a downward chevron. They render at roughly 10px, which rules out the
  prettier pairing (a crown and a *cracked* crown: the crack disappears and
  the two become one shape in two colours) and killed a first crown drawn as
  sharp spikes over a tall base, which rasterized to a rectangle with a fuzzy
  top. Points must be blunt and tall, notches wide. Rasterize the polygon at
  14×9 before trusting any icon at this size — it takes a scanline
  point-in-polygon test and no dependencies.
- **The `(elite)` suffix in the initiative track is drawn, never stored.**
  Baked into the name it would flow through rename, `uniqueEntityName()` and
  the copy/paste base name, and pasting an elite goblin would produce
  "Goblin (elite) 2".

The usual mirror discipline applies and paid for itself here: a throwaway
Python mirror that lifts `DAMAGE_HEAD` and both HP tables **out of** the
shipped JS with a regex — rather than restating them — and runs the rewriter
over all 1100 strike damage strings in the corpus. It asserts the lifted
tables against the ones Monster Core prints, that the tail past the dice term
survives byte-for-byte, and that +2 then −2 round-trips. That is what caught
the swallowed space.

### One stat block, two kinds of entity

`entityStatBlock(entity)` normalises a character's Pathbuilder build and a
monster's published stats into one shape (`level`, `maxHp`, `ac`,
`fortitude`, `reflex`, `will`, `perception`, `speed`, `speedText`,
`recallKnowledge`, `shieldBonus`). A
character's values need PF2e's proficiency math (`checkTotal`,
`computeMaxHp`); a monster's are already finished totals. Everything
downstream — the stat panel, the HP pool, `effectiveMaxHp()`, the
damage/heal dialog, the condition pipeline — consumes the normalised shape,
so there is no monster branch beside every stat.

`renderCharacterTab()` therefore branches on **having stats**, not on being
a character. A statted monster renders through the identical code; custom
objects, a monster AoN had nothing for, and (defensively) a character with
no sheet data fall through to the minimal panel.

Two consequences worth keeping:

- **A missing stat stays `null` all the way to the panel**, which shows a
  muted em dash. Defaulting to 0 would print "+0", and an unknown Will save
  is not a zero Will save. `.unknown` is deliberately muted rather than
  red — missing information is not a penalty and must not read as one.
- **Anything that resolves an HP pool must use `findEntity()`**, not
  `loadCharacters()`. The damage/heal and temp-HP handlers looked only in
  the character store, which would silently no-op every button in that
  dialog for a monster.

### DM overrides sit on top of the stat block, never inside it

A DM needs a creature's numbers to be whatever they say they are — a boss
already wounded before the party arrives, a goblin in armour it found, an
NPC given a swim speed for one encounter. `battleState.overrides` is a thin
layer over the sheet or the statblock, and the source is never written to:
the character store is read-only from this page, and a monster's statblock
isn't ours to change.

`overrides[entityId][key] = value`, with flat string keys so one map covers
stats from three different renderers:

| key | read back through |
|---|---|
| `maxHp` `ac` `fortitude` `reflex` `will` `perception` | `applyStatOverrides()`, in `entityStatBlock()` |
| `attr:<abbr>`, `skill:<name>` | `applyAbilityOverrides()`, in `entityAbilities()` |
| `speed:<kind>` | `effectiveSpeeds()`; `speed:walk` also lands on `stats.speed` |

Five rules hold this together:

- **`key in overrides`, never truthiness.** `null` means "this speed is
  gone", and 0 is a perfectly good AC to force. Absent, null and zero are
  three different things.
- **Applied last** — after elite/weak, after the sheet's arithmetic. A typed
  number is the answer, not a base for a template to scale again. Conditions
  still stack on top, because those are the fight happening *to* the
  creature rather than what it is.
- **Each key stands alone.** Raising Dexterity does not ripple into AC or
  Reflex. Rippling would mean reimplementing character building for one
  source and guessing at it for the other; the save has its own right-click.
- **Reconciled on read, never written back.** Lowering max HP below current
  HP needs no clamp write — `currentHp()` already clamps on read, so the
  stored value climbs back when the override is reset.
- **It survives leaving the field**, like `appearance`/`inventory`/
  `adjustment` and unlike `hp`/`conditions`. It says what the creature *is*.
  Cleared only where the entity itself is deleted (`delete-custom-object`,
  `remove-character`) — never beside the `spellSlots` cleanups, which mark
  the remove-from-field path.

`publishedStatBlock()` and `publishedAbilities()` exist purely so an
overridden number can name what it replaced — in the panel's tooltip and in
the Set dialog's hint. Without that, Reset is a mystery an hour later.

The mark is `.overridden`: a dotted underline, not a colour. Every colour on
these numbers already means something else (red a penalty, green a bonus,
grey "not published", the accent a raised shield), an override is orthogonal
to all four, and underlining costs no layout — so gaining the mark can't
nudge the tile it sits in.

**A custom object still can't be given stats.** `baseStatBlock()` returns
null for it, so `renderCharacterTab()` takes the minimal branch, which has
nothing carrying `data-stat` to right-click. Same for a monster AoN
published nothing for. Fixing that means synthesising a stat block from
overrides alone *and* finding a place to set the first one from.

### The right-click menu is a list of items, not a set of actions

One `#battle-context-menu`, static markup at **body level**. Every region it
opens from — both bottom panels, the initiative track — is rebuilt by
`render()`, so a menu inside any of them would be destroyed between the
click that opened it and the click that chose from it. The listeners are
delegated to the box ids for the same reason.

`openContextMenu(x, y, items)` takes items that each carry their own
behaviour as a closure. There's no action-name registry to keep in step with
the builders, and a right-click with nothing to offer produces no items and
lets the browser's own menu through. `data-index` indexes the item array
directly, so a `{ separator: true }` entry costs nothing.

Three things that were each a real bug:

- **Read the item before `closeContextMenu()`** — it empties the array the
  index points into.
- **`contextTarget()`, not `event.target`.** A *disabled* button doesn't
  receive the event; the browser dispatches it on an ancestor. That covers
  the AC square whenever there's no shield to raise — most creatures — and
  the HP bar of a creature with no published HP, which are precisely the
  stats a DM wants to fill in. It falls back to `elementFromPoint()`, and
  tries `event.target` first so a keyboard menu key (no coordinates) works.
- **The map-keys `keydown` listener must bail while it's open.** The menu
  traps no focus at all, so "d" over it would grow the board.

Closes on pointerdown outside (capturing, so it's gone before a canvas drag
reacts), Escape, scroll, resize and blur — a menu pinned to viewport
coordinates lies the moment anything moves under it.

Editing lands in a dialog, for the reason every other editor here is one: the
panels rebuild on every `render()`, so a field living in one loses half-typed
text to any unrelated dispatch. Two of them:

- **`#battle-stat-dialog`** — one number, for every scalar stat. Title, a
  hint naming the published value, one field.
- **`#battle-speeds-dialog`** — all five movement types at once, each with a
  switch, a number and a reset. A creature's speeds are one decision, not
  five, and the per-chip menu it replaced needed eight items to change two
  numbers (Set/Reset/Remove for the chip, plus an Add for each type it
  lacked) with "add a fly speed" reachable only by right-clicking some
  *other* speed.

The speeds dialog **stages**: nothing reaches battle state until Save, and
then as one `set-speeds` dispatch, so a single Ctrl+Z puts a creature's
movement back the way it was. Per-row Reset restages the published values
rather than dispatching, which is the same "dialog staging is not an event"
rule the HP dialog's steppers follow. Its log line names the single change
when there is one and summarises when there are several — `Set Hydra's
speeds` says nothing when the only edit was trimming its walk speed.

**`style.css`'s dialog rules are written for stacked text fields**, and they
reach every control in every dialog on this page:

```css
dialog label { display: block; font-weight: 600; margin-bottom: 0.5rem; }
dialog input, dialog select { width: 100%; padding: 0.5rem; font-size: 1rem;
                              border: 1px solid …; background: …; }
```

`width: 100%` on a **checkbox** is what that looks like when it goes wrong:
the box stretches across its whole flex line, shoves the label into wrapping,
and does it by a different amount in each row depending on how long that
row's text is. Any non-text control added to a dialog has to re-declare every
property those two rules set — they're two type selectors deep, so a single
class beats them, but only for the properties it actually names. This is the
per-property cascade point that the `button:hover` section makes, in a
second place.

Three details the row model rests on:

- **A row's number field is `disabled` and not `required` while its switch is
  off**, so "switch it on and leave the box empty" can't happen and an off
  row can't fail validation.
- **An off row still shows the published number**, muted. It's what switching
  the row back on restores, and a DM deciding whether to ground a dragon
  wants to see what they're taking.
- **Save rewrites every `speed:*` key** from the rows and carries non-speed
  overrides through untouched — otherwise a type switched off would keep a
  stale number underneath it.

### The Character panel's header row is tight — treat it as full

Left cluster (remove ×, name, level, speed) and right cluster (HP bar, AC)
sit at opposite ends of a `space-between` row inside a box that is only as
wide as the bottom-left region. It has no spare room; adding a control there
pushes something else off the end.

- **The level stacks above the name**, centred on it, in a
  `.battle-stat-name-block` column — not a "Lvl N" label beside it, which
  was spending horizontal space the row doesn't have. Stacking costs the row
  no width at all, which is what an earlier `<sup>` on the name was for; the
  column replaced it and is why `.battle-stat-name-wrap` no longer has to
  avoid `display: flex`. The level is a *sibling* of the name, never a
  child — inside the monster case's `<button>` it would join the click
  target. It carries its own `"lvl "` prefix, because a name that may itself
  end in a number ("Giant Gecko 4") sits directly beneath it.
- **`min-width: 0` has to continue down the whole chain** —
  `.battle-stat-left`, `.battle-stat-identity`, `.battle-stat-name-block`,
  `.battle-stat-name-wrap`. A flex item's default `min-width` is
  `min-content`, so the name's ellipsis only works if every step allows
  shrinking.
- **Speeds are icon + number chips**, one per movement type
  (`.battle-stat-speeds` / `.battle-speed`), not the words "Speed 25 ft".
  All of them are `flex-shrink: 0`; the name is what gives way.
- **A monster's name IS the statblock link** (`.battle-stat-name-link`, a
  `<button>` styled back down to look like the text it replaces). A separate
  icon button beside Speed used to do this and was crowding the row. Its
  tooltip names the *statblock*, not the token: "Giant Gecko 4" is this
  particular gecko, and the page it opens is Giant Gecko's.
- **Only the name gives way.** `.battle-stat-left`, `.battle-stat-identity`
  and `.battle-stat-name-wrap` all set `min-width: 0` — a flex item's default
  min-width is `min-content`, so `overflow: hidden` further in does nothing
  unless every step of the chain allows shrinking. The right cluster and
  Speed are `flex-shrink: 0`. Before this, both clusters refused to shrink
  and a long name simply ran underneath the HP bar.
- **The AC square is fixed at 2.5rem.** Fixed is load-bearing — it's what
  lets the shield icon be present-or-absent with nothing jumping (see
  "Avoiding layout jumps"). Shrinking it is the lever for giving the rest of
  the row room, not making it content-sized.

### Avoiding a broken dblclick

Any list whose rows are replaced on every `render()` **cannot** carry its
own `dblclick` handler. The first click re-renders (selecting an entity,
switching a battle), so the two clicks land on different nodes and the
browser dispatches `dblclick` on their nearest common ancestor instead of
the row. Delegate to the stable parent — `tabList` for battles,
`initiativeList` for the track — and attach it once, outside the render
function.

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

### Persistent damage is next to the conditions, not one of them

It renders **beside** the conditions, as the second column of
`.battle-afflictions` — a wrapper that holds `conditionsSectionHtml()` and
`persistentSectionHtml()` as **siblings**. It was briefly nested inside the
conditions block, which made that block's name a lie about its contents;
persistent damage is not a condition. Two columns rather than two stacked
sections because stacking cost a second heading's worth of height in a box
with none to spare, and neither list is wide enough to miss half the width
(`references/bottom-boxes.md`). The empty column still holds its `1fr`, so the
first bleed applied doesn't reflow the conditions beside it.

**An entry is either dice or a flat amount, never both** — `{ value, die }`
with a null `die` meaning flat. The dialog is three controls: `Value`, `Die`,
`Type`. **"flat" is the first option in the Die select**, not a mode switch
above it — flat damage *is* the no-die case, so folding it in removed a whole
control and the tab state behind it while losing nothing. `Value` is the
number of dice when a die is picked and the amount itself when "flat" is,
which is why it isn't labelled "Dice".

This arrived in two steps worth not repeating: first as separate `dice`,
`die` and `flat` fields (two of the three were always noise), then as a
Die/Flat tab strip over one `Value` (a control whose only job was to hide
another control). Seeding an existing entry must restore the **die**, or
reopening a flat 3 and saving would quietly turn it into 3d6.

**It's a list, and two sources of the same type are legal.** PF2e applies only
the highest of a given type, but that's a judgement about which source is live,
and a DM who just landed a second bleed needs both on screen to make it —
collapsing them would also silently discard a source when a smaller one is
applied after a bigger one. So `addPersistentDamage()` always appends, and
`edit`/`remove` work by **row id**: with duplicates allowed, a damage type
identifies nothing. Repeats of one type get a dashed border and a "source 2 of
3" tooltip — marked, never resolved.

`entityPersistentDamage()` sorts by `PF2E_DAMAGE_TYPES` order, and relies on
JS's sort being stable (guaranteed since ES2019) to keep same-type rows in the
order they were applied. That adjacency is the point: comparing same-type
sources is exactly the call being left to the DM.

Two older shapes are **reconciled on read** and never written back, the same
way `initiativeOrderIds()` and `getAppearance()` handle theirs — an object
keyed by damage type (the type doubles as the row id, unique because that shape
allowed only one per type), and `{ count, die, flat }` per entry, where dice
win over a flat term because that's the part a DM rolled. The mutator in
`updatePersistentDamage()` receives the *normalised array*, so the first write
converts a legacy record and no writer ever sees the old shape.

**It is deliberately not in `PF2E_CONDITIONS`.** It has no tier, takes part in
no imposed-condition graph, and moves no stat the panel shows — so it lives in
its own `battleState.persistentDamage` map rather than being bent into a
dictionary built for a different shape. It *is* cleared everywhere
`conditions` is (place, remove, delete, remove-character, resize eviction);
those five sites must stay in step, and the pairing is worth checking
mechanically rather than by eye.

**Keyed by damage type, one entry each.** The rule is that persistent damage
of different types all applies but only the highest of a given type does, so
one entry per type makes the illegal state unrepresentable instead of leaving
a DM to reconcile two fire rows. Setting a type that already exists replaces
it, and the dialog seeds its fields from whatever that type currently has —
which is what makes it the edit form as well as the add form. Changing the
type re-seeds, or the preview would offer to apply a number read off a
different type.

`PF2E_DAMAGE_TYPES` is the remaster list: vitality replaced positive, void
replaced negative, spirit replaced the four alignment types. **Precision is
deliberately absent** — it's a damage type, but never a persistent one.

**The token's blood drop is one mark for any type**, drawn last so it sits
over the letters. It's filled dark red and *stroked white*: the token's colour
is the DM's to choose, and a red drop on a red goblin is invisible without an
outline that survives whatever is underneath. One closed bezier path rather
than a circle plus a triangle, so the stroke traces the silhouette instead of
showing a seam where the two met.

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
