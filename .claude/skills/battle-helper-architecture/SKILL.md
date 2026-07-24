---
name: battle-helper-architecture
description: The event-driven state/undo-redo architecture for static/battle-helper/ code. Load this before writing or reviewing any code that changes battle-helper state (placing tokens, future moves/damage/conditions), or that touches its event log, undo/redo, or keyboard shortcuts.
---

# Battle Helper Architecture

Two rules govern all of `static/battle-helper/battle-helper.js`. Both exist
because the page needs undo/redo (Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y) over an
arbitrary, growing set of battle actions, without hand-writing an inverse
function for every action type.

## Rule 1: Everything is an event, or part of one

Any code that changes battle **state** — placing a token, removing one,
and every future action (move, damage, condition, initiative reorder,
whatever comes next) — must go through the one `dispatch()` function.
Never mutate `battleState` directly from an event handler.

```js
dispatch("place-token", `Placed ${character.name}`, (state) => {
  state.placements[squareKey(row, col)] = character.id;
});
```

`dispatch()` snapshots state before and after running the mutator, and
appends `{ type, label, before, after, at }` to `eventLog`. This is
**snapshot-based undo**, not command-pattern (no per-type `undo()` to
maintain) — deliberately, because battle state is small (a placements map
and per-character HP/temp-HP maps, currently) and cloning it is cheap. If
battle state ever grows to include something expensive (e.g. embedding
full character sheets instead of ids), revisit this — snapshotting stops
being free at that point.

Damage/heal (`hp-action-*` buttons in the HP dialog) is the second real
example of this pattern: the buttons compute a delta and call one shared
`applyHpDelta(delta, kind)`, which does one `dispatch("adjust-hp", ...)` —
not one event type per button. `kind` (`"half"`/`"double"`, omitted for
full damage/heal) only affects the log label text (`"... damage (half)"`),
not the mutation itself. Temporary HP absorbs damage before real HP does
(PF2e's actual rule) — that reduction happens *inside* the same
`adjust-hp` mutator, touching both `state.hp` and `state.tempHp` in one
event, so undo/redo reverts both pools together rather than needing two
paired events kept in sync. The log line reflects that split too (e.g.
`"... took 12 damage (6 to temp HP, 6 to HP)"`), computed in
`applyHpDelta()` by reading `battleState.tempHp[characterId]` *before*
calling `dispatch()` — safe because nothing else can mutate state between
that read and the mutator seeing the same value, JS being single-threaded;
the label has to be a plain string handed to `dispatch()`, not something
computed from inside the mutator, since the mutator only touches the live
`battleState` and doesn't return anything back out. Granting temp HP itself
is a separate
`dispatch("adjust-temp-hp", ...)` from `applyTempHp()` — it replaces
`state.tempHp[characterId]` outright (temp HP doesn't stack with itself)
rather than adding, unlike damage/heal which are additive deltas. The
dialog's stepper buttons (+1/+5/-1/-5) and the number input only stage the
value those buttons will use; staging isn't a battle change, so — like
selection — it doesn't dispatch.

Raise a Shield (the shield toggle next to AC) is UI-only, the same way
selection is: it's situational and would be expected to reset, not survive
undo, so it's a plain `raisedShieldIds` Set keyed by character id — never
`dispatch()`ed. It has to be module-level state rather than local to
`renderStatPanel()` because that function's `innerHTML` gets rebuilt on
every `render()`, including ones triggered by unrelated dispatches.

**What does *not* go through `dispatch()`:** anything that only changes
*what the UI is showing*, not the actual battle — selecting a square to
inspect it, hovering, opening/closing a panel. These set a plain local
variable (e.g. `selectedSquare`) and call `render()` directly. If it
wouldn't surprise a player to see it silently reappear after an undo, it's
not an event.

## Rule 2: The event log drives undo/redo, and is shown like Roll History

`eventLog` + a `cursor` index (pointing at the last *applied* event, -1 if
none) is the only state needed for undo/redo:

- **Undo** (Ctrl+Z): if `cursor >= 0`, restore `eventLog[cursor].before`,
  decrement `cursor`.
- **Redo** (Ctrl+Shift+Z or Ctrl+Y): if `cursor < eventLog.length - 1`,
  increment `cursor`, restore `eventLog[cursor].after`.
- **New event while not at the end of the log** (i.e. the player undid,
  then did something new): truncate everything after `cursor` before
  pushing — the old redo branch is gone, same as any standard undo stack.

Both keyboard shortcuts are wired at `document` level with
`event.preventDefault()` (there's no text input on this page to conflict
with). The undo/redo buttons in the UI are hidden (not just disabled) when
there's nothing in that direction — `cursor < 0` for undo,
`cursor >= eventLog.length - 1` for redo.

The log itself renders as a list styled and behaving like `static/app.js`'s
Roll History list (`renderRollHistory`) — same "newest first, short
one-line description per entry" convention, so the whole app feels
consistent rather than battle-helper inventing its own log UI language.

## Page layout: "boxing"

The page is a fixed set of boxes (`.battle-box`), not a freeform layout —
keep new UI inside this structure rather than adding new top-level
regions:

- **Left, full page height**: roster (top half) and event log (bottom
  half), stacked in one box (`.battle-box-left`, split by
  `.battle-box-section`).
- **Right, full page height**: initiative track (`.battle-box-right`).
- **Center column**, between the two sidebars: the map on top
  (`.battle-box-map`), then a bottom row split in two:
  - **Bottom-left**: the selected-object info panel (`#battle-stat-panel`)
    — header row is two clusters pinned to opposite edges
    (`justify-content: space-between`), *not* one row where the HP bar
    stretches to fill the gap: `.battle-stat-left` (remove ×, name, level)
    and `.battle-stat-right` (HP bar, then the AC panel). The HP bar has
    three segments — HP (green/red), temp HP (blue, immediately to the
    right of the HP segment), and dark grey "absent" for the rest — sized
    as percentages of `maxHp + tempHp`, not just `maxHp`, so temp HP visibly
    eats into the HP/absent portions of the *same fixed-width bar* rather
    than growing the bar; see `renderStatPanel()`'s comment for the exact
    math. The `current / max (+temp)` text is centered inside the bar
    ("sticks to" the HP number, not pinned separately at an edge). The AC
    panel is a small square button sized to its content (raises the shield
    on click, disabled when there's no shield to raise) with the shield
    icon as a decorative corner badge, not a separate inner button. When
    both clusters are narrower than the row, the empty center is
    intentional, not a bug — then the remaining checks (Fortitude/Reflex/Will/
    Perception/Speed) in a grid below.
  - **Bottom-right**: reserved, currently just a placeholder
    (`.battle-box-bottom-right`) — no assigned purpose yet, don't
    repurpose it without checking with the project owner first.

Because the sidebars are full-height flex children of the same row as the
center column, they naturally stretch to match its height (map + bottom
row) — no explicit height math needed, and the bottom-left box ends up
flush against the left sidebar's right edge for free.

`.battle-layout` is pinned to exactly `height: 100vh` with `overflow:
hidden` (not `min-height: 100vh`) so the whole page fits the viewport with
no page-level scrollbar. Individual regions that can overflow (roster,
event log, initiative list, the map box) each scroll internally via their
own `overflow-y`/`overflow: auto` — that's the only place scrolling should
ever happen on this page. If a new box's content can grow unboundedly, give
*that box* `overflow: auto`, don't relax the page-level `overflow: hidden`.

Every box element IDs the JS reads (`battle-grid`, `battle-roster`,
`battle-initiative`, `battle-log`, `battle-undo`, `battle-redo`,
`battle-stat-panel`) are stable regardless of which box wraps them —
`battle-helper.js` only ever queries by id, never by the box's class
names, so layout can be restyled without touching JS as long as those ids
stay put.

## Avoiding layout jumps

Panels on this page get re-rendered constantly (every `render()`, i.e.
every dispatch and every selection change), and several controls only make
sense conditionally — the shield toggle only for a character with a
shield, each HP-dialog action button only for the current sign of the
staged value. It's tempting to solve that with a template-literal ternary
that omits the element entirely (`` hasShield ? `<button>...` : "" ``), but
that changes how many children the flex box has, which changes its size,
which — because these boxes stretch to fill a row alongside siblings
(`#battle-stat-panel`'s header, `.hp-action-row`) — visibly shifts
*everything else on the page*, not just the element in question. That's
the bug this project calls "jumping": selecting a shield-less character
made the whole stat panel shorter than a shielded one; changing the HP
dialog's sign re-centered the remaining action buttons into new slots.

The fix is the same idea both times — **always render the element; toggle
a class instead of the element's presence** — but there are two different
techniques depending on *what* would otherwise resize, and picking the
wrong one reintroduces a subtler version of the same bug:

- **A single element inside a box whose own size depends on its children**
  (the shield-toggle `<button>` inside `.battle-stat-ac`, a flex column
  with no fixed height): use `.invisible` (`visibility: hidden;
  pointer-events: none;` in `battle-helper.css`). This keeps the element
  occupying its layout slot — same box, same space reserved — just
  invisible and unclickable. `renderStatPanel()` always renders the
  button, only adding `.invisible` (plus `tabindex="-1"` /
  `aria-hidden="true"`) when `!hasShield`, and only attaches its click
  listener when `hasShield`. Because the button's slot is always there,
  `.battle-stat-ac`'s height is now identical for every character, shield
  or not — using `visibility` here is *load-bearing*, not cosmetic:
  swapping it for `hidden`/`display:none` would bring the jump back.
- **Two mutually-exclusive groups of buttons that should each be centered
  in the same space** (the damage trio vs. the heal/temp-HP pair in
  `.hp-action-row`): don't lay them out side by side, even at equal
  `flex: 1` — that only centers each group within *its own half* of the
  row, which visually reads as depending on the other group's width/
  presence (exactly the "like they know of each other" symptom). Instead,
  stack both groups on top of each other: `.hp-action-row` is
  `position: relative` with a **fixed `height`**, and each
  `.hp-action-group` is `position: absolute; inset: 0;` with its own
  `justify-content: center`. Both groups now center within the *entire*
  row independently — being stacked, not neighbors, one group's content
  has no way to affect the other's centering — and because the row's
  height is fixed rather than derived from content, whichever group is
  showing (or neither, at value `0`) never resizes the row or the dialog.

  Two things bite you specifically with stacked-and-hidden groups, both
  learned from a real regression here — hide the whole **group**, not its
  individual buttons, and make sure `hidden` actually wins:
  - Hiding only the individual buttons inside the *inactive* group (via
    `hidden` on each `.hp-action`, group itself untouched) breaks
    clicking on the *active* group entirely: an empty group is still a
    full-size box stacked on top, and a positioned box intercepts pointer
    events over its area even with nothing visible painted inside it —
    the inactive group silently swallows clicks meant for the buttons
    underneath. Toggle `hidden` on `#hp-action-group-damage` /
    `#hp-action-group-heal` themselves (`updateHpActionVisibility()`),
    not their children.
  - Once you hide the group element itself, its own `display: flex`
    (needed for the stacking/centering above) fights the browser's
    built-in `[hidden] { display: none }` rule — and **wins**, since
    author CSS beats user-agent CSS regardless of specificity. `hidden`
    would silently do nothing without an explicit
    `.hp-action-group[hidden] { display: none; }` override (present in
    `battle-helper.css`). This only matters for elements that declare
    their own `display` — it's why `.hp-action` itself never needed this
    (no `display` override) but `.hp-action-group` does.

When adding new conditional UI here, ask which situation applies: one
element whose own box has no fixed size → `.invisible`; two (or more)
alternative button sets that should each look centered in the same slot →
stack via `position: absolute; inset: 0;` inside a fixed-height
`position: relative` parent, hide via `hidden` on the *group* (with a
`[hidden] { display: none; }` override if the group sets its own
`display`). Either way, the rule is the same: never let `condition ? html :
""` change how many
children a box has, or how a sibling group's layout is computed, when that
box's size or position affects something else on screen. It's fine to skip
all of this for elements whose absence genuinely shouldn't reserve space
(e.g. the roster/initiative "nothing here yet" placeholder rows, which
replace the whole list rather than living alongside other real rows).

A simpler third option, used for `.battle-stat-ac`: give the box a **fixed
`width`/`height`** instead of letting content determine its size at all.
The AC panel is a square (`3.2rem` × `3.2rem` — small, sized to its actual
content rather than the much larger box tried initially, which left
visibly dead space) whether or not the character has a shield — the shield
icon is an `aria-hidden` corner decoration that's simply present-or-absent
(`hasShield ? html : ""`), which is safe here specifically *because* the
panel's size doesn't come from its children. The panel is a single
`<button>` always, `disabled` when `!hasShield` (rather than a conditional
`<div>`/`<button>` tag swap or an `.invisible`-style inner toggle button)
so the whole square — not a small icon inside it — is the click target for
raising the shield.

## Overriding the global `button:hover`

`style.css`'s global `button:hover` rule (`border-color: var(--accent);
background: var(--accent-soft);`) applies to every `<button>` on this page
by default, including ones with their own background/text color set for a
specific purpose — `#battle-hp-bar` (white text over a dark/colored fill),
`.battle-stat-ac` (accent background when raised), and `.battle-remove-btn`
(a solid `--danger` circle). The translucent accent tint stacks on top and
can wreck contrast (this is what made the HP number "almost unreadable" on
hover) or, worse, silently *replace* a solid background with a near-white
one (what made the remove button's hover look "too strong" — a jarring
color swap, not a gentle highlight — even though the actual override rule
only touched `filter`).

The CSS lesson behind both bugs: **the cascade resolves per property, not
per rule.** `.battle-remove-btn:hover { filter: brightness(1.1); }` has
higher specificity than `button:hover`, but it doesn't declare
`background` at all — so for the `background` property specifically,
`button:hover`'s declaration is the only one in the running and applies
regardless of the other rule's higher specificity elsewhere. Any custom
`:hover` (or `.active:hover`) rule on a button with its own background
must **explicitly re-declare every property the global rule sets**
(`background`, `border-color`) that you don't want overridden, not just
the properties you're trying to add.

Once contrast is safe, keep the actual hover *effect* light — a single
border-color shift to `var(--accent)` for panel-style buttons with a
visible border (`.battle-hp-bar`, `.battle-stat-ac`), or
`filter: brightness(1.1)` alone for solid-fill buttons
(`.battle-remove-btn`, `.battle-stat-ac.active`). Skip the hover rule
entirely for controls that aren't actually clickable right now (e.g.
`.battle-stat-ac:not(:disabled):hover`, not `.battle-stat-ac:hover`) —
otherwise hovering a disabled control shows an affordance that lies about
what will happen on click.

`:not(:disabled):hover` only stops *your own* rule from matching a
disabled control — it doesn't cancel the global `button:hover` rule, which
has no `:not(:disabled)` guard and matches every button regardless (CSS
`:hover` isn't blocked by the `disabled` attribute, only click handling
is). Without an explicit `.battle-stat-ac:disabled:hover` resetting things
back to the base look, a disabled AC panel (no shield) still highlighted
on hover, sourced entirely from the global rule leaking through. Any
`:not(:disabled):hover` override on a button needs a matching
`:disabled:hover` reset alongside it, not just the positive-case rule.

## State separation from the main app

Battle state (placements, per-character HP/temp-HP, event log) persists to
its own localStorage key (`pathfinder-dm-tools:battle`), separate from the
main app's `pathfinder-dm-tools` character store. `battle-helper.js` only
ever **reads** the character store (to populate the roster and the stat
panel) — it never writes to it. Characters aren't copied into battle state
either; a placement stores a character `id` and looks the character back
up from the store at render time, so battle-helper always reflects a
character's current sheet rather than a stale copy — this is also why max
HP is never stored, only current HP (`battleState.hp[characterId]`): max HP
is recomputed live from the character's build every render via
`computeMaxHp()`, so if the character sheet changes, the HP bar's max
follows it.

Current HP and temp HP are both keyed by character id, not by square —
they need to survive a future "move" event without resetting. Both are
deleted on `remove-token` (leaving the field means a full reset, not
persistent-through-removal tracking) and reset on `place-token` — HP to
max, temp HP cleared outright (`currentHp()`/`currentTempHp()` default to
max/0 respectively for any id with no tracked entry, which is how a fresh
placement gets full HP and no temp HP without a separate initialization
step).
