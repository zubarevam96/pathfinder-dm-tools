# Battle Helper: the map

Everything canvas-side, split out of `SKILL.md` because it's the half of
`battle-helper.js` that has its own geometry to keep straight. Read this
before touching `drawGrid()`, the grid controls, the tool palette, or
`findPath()`. The state rules in `SKILL.md` still apply here — every
change to walls, terrain or placements goes through `dispatch()`.

## Coordinates are anchored to the board, not the viewport

`SQUARE_SIZE` is 40 logical px. The grid runs `MIN_GRID` (5) to `MAX_GRID`
(60) squares per side.

A square's key is `"row,col"` in **absolute board coordinates**, and those
never change. Growing the map on the left or top moves the *origin*
negative (`battleState.originRow` / `originCol`) instead of renumbering
anything, so the square that was `(0, 0)` stays `(0, 0)` forever and new
squares beyond it simply take negative coordinates.

This is the single most useful invariant on the page, and it was bought at
the cost of an earlier version that renumbered every key on a top/left
edit. Renumbering meant walls (whose keys mix edge indices and cell
indices — see below) had to be remapped with the asymmetry handled
correctly in both axes, and it was the fiddliest code in the file. Now
nothing moves at all: `resizeGrid()` only has to *drop* what fell off the
board.

Two consequences to respect:

- **Never derive pixels from coordinates by multiplication.** `pixelX(col)`
  and `pixelY(row)` are the only two places the origin offset is applied.
  Anything doing `col * SQUARE_SIZE` has a bug on a board that's been
  grown leftward.
- **Anything packed into a typed array must be zero-based first.**
  `findPath()`'s `stateId()` subtracts the origin before indexing, because
  a negative absolute coordinate would index outside the array.

Heavy grid lines (`GRID_MAJOR_EVERY`, every 5th) key off the **absolute**
coordinate, not the line's index from the edge, so the 5×5 blocks stay
pinned to the board. A board grown leftward can therefore show a partial
block at its edge — that's correct, the blocks belong to the board, not to
the current viewport.

## Drawing order in `drawGrid()`

Surface fill → selection tint → **terrain** → grid lines → drag feedback →
walls/doors → dragged path → tokens → selection outline.

The order encodes what's on top of what: terrain is ground (under
everything), walls are built on the ground but under creatures, tokens are
on top. Insert new layers by that logic rather than at the end.

### The canvas is bigger than the grid

`CANVAS_PAD` (5 logical px) of blank margin surrounds the grid on every
side, and the transform is translated by the same, so logical `(0, 0)` is
still the grid's top-left corner and every drawing routine can ignore it.

It exists because **strokes at the bitmap's edge get clipped, not
half-drawn** — a line at `width + 0.5` is outside `0..width` and vanishes
entirely. Walls and doors straddle the line they sit on, so one on the
outer boundary has half its width outside the grid rectangle. An earlier
fix clamped those inward by half a thickness, which stopped the clipping
but left boundary walls visibly sitting *inside* the first row of squares
rather than on the map's edge. Reserving the space instead keeps every
wall centred on its own line wherever it is, which is why `traceWall()`,
`drawEdgeShape()` and `gridLinePos()` now do no clamping at all.

Two consequences:

- **`gridPointFromEvent()` is the only inverse of this mapping**, and both
  `squareFromEvent()` and `wallActionFromEvent()` go through it. They used
  to duplicate the arithmetic, which is exactly how a canvas-sizing change
  gets applied to square picking and forgotten for wall picking.
- **`drawGrid()` must `clearRect()` the padded area.** The surface fill
  only covers the grid rectangle, so without the clear, a boundary wall's
  overhang from the previous frame ghosts in the margin — visible when a
  hover preview removes one mid-drag.

Also still true: **a 1px stroke wants a half-pixel offset; a 2px stroke
wants a whole one.** Centred on the wrong one it straddles two device
pixels and blurs. That's why `CANVAS_PAD` is a whole number — a fractional
pad would shift every line off its alignment.

The bitmap is allocated at `zoom × devicePixelRatio` and the context
scaled to match, so all drawing code works in unzoomed logical pixels and
stays crisp when zoomed in. Re-apply the transform every draw: assigning
`canvas.width` resets the context. Only assign it on an actual change,
though — that assignment reallocates and clears the bitmap, and
`drawGrid()` runs on every mousemove during a drag.

## Zoom and pan

Zoom is UI-only (`ZOOM_MIN` 0.4, `ZOOM_MAX` 3, `ZOOM_STEP` 0.2) — it
changes what you're looking at, not the battle, so it never dispatches and
undo doesn't cycle through it. It's also global rather than per-battle and
not persisted: it's a viewing preference, so switching battle tabs keeps
whatever you set. Values are rounded to whole percents so repeated steps
can't drift onto `0.9999…` and miss the limit comparisons.

The mouse wheel zooms rather than scrolling the viewport — dragging empty
space already pans, so the wheel is free for the thing with no other quick
gesture. One notch is one `ZOOM_STEP` by sign only: trackpads and mice
report wildly different `deltaY` magnitudes, and anything proportional
flies off at a flick. The listener needs `{ passive: false }`, since wheel
listeners default to passive and `preventDefault()` is ignored there — the
whole page would scroll underneath the zoom.

`setZoom(value, anchor)` takes an optional point to hold still, which the
wheel passes. Without it the canvas grows from its centre (see `margin:
auto` below) and whatever you were looking at slides away. The anchor's
position is measured in unzoomed canvas coordinates *before* the resize;
after `render()` the pan is corrected by however far that point **actually**
drifted, measured from the new rect rather than predicted. Predicting it
would mean modelling both the centring and `clampPan()`'s own correction
inside that same `render()` — two rules to keep in sync for no gain.

### Panning is a transform, not a scroll offset

`panX`/`panY` are CSS px applied as a `translate()` on the canvas, on top
of wherever the layout put it. This used to be
`mapViewport.scrollLeft`/`scrollTop`, which composed nicely with the
scrollbars but **could only move a canvas bigger than its viewport** — a
small map has no scroll range, so dragging it did nothing at all. A
transform has no such floor, so one gesture works at every size and
`#battle-map-viewport` is now `overflow: hidden` with no scrollbars.

Go through `setPan(x, y)`, never assign `panX`/`panY` directly: it applies
the transform, clamps, and refreshes the zoom controls.

`clampPan()` keeps at least `MIN_MAP_VISIBLE` (60px) of canvas inside the
viewport on each axis, so a pan can push the map most of the way off the
box but never so far that there's nothing left to drag back. It works off
**measured** rects, not predicted ones, and that's deliberate: where the
layout puts an unpanned canvas changes as it outgrows the viewport
(flexbox treats `auto` margins as 0 once free space goes negative, so a
centred map becomes a start-anchored one), and duplicating that rule in JS
would be one more thing to keep in step with the stylesheet. The
correction is a nudge derived from the current rect, so it's idempotent —
which matters, because `render()` runs it again on every draw. Note the
`Math.min(MIN_MAP_VISIBLE, rect.width)`: without it a map narrower than
the strip would be an unsatisfiable constraint.

`render()` calls `clampPan()` right after `drawGrid()` — shrinking the grid
or zooming out can strand a pan that was legal a moment earlier. Not inside
`drawGrid()` itself, which also runs on every mousemove of a token drag,
where nothing has resized.

The mousedown that arms a pan is bound to **the viewport, not the canvas**,
so the blank space around the map is a pan handle too — with a small or
panned-away map that space is most of the box. `squareFromEvent()` measures
from the canvas's own rect, so it keeps working from a viewport-level event
and simply returns `null` out there. Left button only: right-drag has no
meaning here and would leave a pan running under the context menu.

The grabbing cursor is a `.panning` class on the viewport, not an inline
style — the canvas has cursor rules of its own (`pointer`, or `crosshair`
under an edge tool) that an inline style on the *viewport* wouldn't beat,
since it isn't their element. `.battle-map-viewport.panning .battle-grid`
outspecifies both.

The map box keeps `overflow: hidden` so a panned or zoomed-in map doesn't
spill over the rest of the page, and so the four resize controls stay
pinned to the box.

The canvas is centred with `margin: auto`, which is load-bearing: because
it grows from its centre, adding a column on the left pushes the map half
a square right while the pinned +/− button stays put, which is what
produces the "the map slides away from the side I clicked" feel. Anchor
the canvas to a corner instead and the effect disappears on two of the
four sides. It's also the zero point `panX`/`panY` offset from, and what
"fit map to view" resets to.

### The reset button fits, it doesn't go to 100%

`fitMapToView()` sets the zoom to `fitZoom()` and the pan back to 0. 100%
was the wrong target: on a big board it shows a fraction of the map, and on
a small one it wastes most of the box, so "show me all of it" is the useful
reset — landing above or below 100% depending on the map.

`fitZoom()` is `min(viewW / canvasW, viewH / canvasH)`, **floored** to a
whole percent and clamped to `[ZOOM_MIN, ZOOM_MAX]`. Floored, never
rounded: rounding up half a percent is enough to push the last row of
squares back out of the box, which is the one thing the button is for. The
clamp means a very large map can still overflow at `ZOOM_MIN` — panning
covers that, as before.

It can't route through `setZoom()`, which returns early on an unchanged
value: a map already at fit zoom but panned away still needs re-centring.
For the same reason the button stays enabled whenever `panX`/`panY` are
non-zero, not just when the zoom is off.

## Tools

`activeTool` is UI-only. Four instruments:

| tool | click does |
|---|---|
| `select` | inspect a square; drag a token; drag anywhere else to pan |
| `wall` | toggle a wall on the nearest cell edge, or cycle a diagonal |
| `door` | toggle a door on the nearest cell edge |
| `terrain` | toggle difficult terrain on the whole square |

`isEdgeTool()` is wall-or-door (the two that target edges and want the
hover preview); `isMapEditTool()` adds terrain (everything that wants the
crosshair cursor, `.battle-grid.tool-edit`). Switching tools disarms any
roster entity armed for placement and clears the hover preview — both
would otherwise fire on the first click after the switch, doing something
the current tool doesn't advertise. Both the palette buttons and the digit
hotkeys go through `selectTool()`, so that cleanup can't be done by one and
forgotten by the other.

The digits pick a tool by its **position in the palette**
(`toolButtons[n - 1]`), not from a key-to-tool table. The row of keys then
maps onto the row of buttons by construction: adding or reordering an
instrument moves its hotkey with it, and there's no second list to fall out
of step. Digits past the end of the palette do nothing.

Only the edge tools get a hover preview, and that asymmetry is deliberate:
edge targeting is ambiguous (which of four edges, or the centre?), while a
square is just the square under the cursor.

## Walls and doors

Walls sit on the **lines between** cells, so they're keyed by edge, not by
square:

- `"h,row,col"` — the **top** edge of cell `(row, col)`
- `"v,row,col"` — the **left** edge of cell `(row, col)`
- `"b,row,col"` / `"f,row,col"` — a `\` or `/` diagonal **inside** the cell

Canonicalising to top/left only is what stops one wall being storable
under two names (the top of `(3,4)` is the bottom of `(2,4)`).

**The asymmetry that bites everywhere:** for an `"h"` key the row is an
*edge* index running `originRow .. originRow + rows` inclusive — one more
value than there are cells — while its col is an ordinary cell index. `"v"`
is the mirror image. Diagonals sit inside a cell, so both components are
cell indices. `pruneWalls()` is where this has to be exactly right.

The map is keyed to a **state**, not to `true`: `EDGE_WALL` or
`EDGE_DOOR`. Rebuilding it with `true` anywhere would quietly demote every
door to a wall — which is why `pruneWalls()` iterates entries, not keys.

There is deliberately **no "double door" state.** A double door is two
doors on the adjacent edges of two neighbouring cells, and it emerges from
that adjacency at draw time: `drawEdgeShape()` checks the neighbouring
cell's matching edge and slides the two 80%-length panels together to meet
on the shared boundary, putting all 20% of each cell's wall stub on the
outer side. One cell holds at most one door.

The centre zone of a cell (`WALL_CENTRE_ZONE`, 0.3 — leaving the middle
~40% as the target) cycles a diagonal: none → the orientation that fits →
the other one → none. Three states rather than two so the same spot that
changes direction also clears it. Doors have no action there — there's no
sensible doorway through a corner-to-corner diagonal.

### Which way a new diagonal runs

A diagonal is only ever meant to close off a corner, so `preferredDiagonal()`
picks the orientation whose two ends meet something. Drawn the other way it
leaves a gap at both ends and crosses the middle of the cell for nothing —
the reported symptom was a `\` proposed in a cell whose neighbours were at
the *other* two corners.

`cornerLinks()` counts what ends at one grid **corner**: the four edges
meeting there (`"h"` left and right of it, `"v"` above and below) plus the
four diagonals that could end there, which belong to the four cells the
corner touches. That last part is why diagonals chain — run a `\` and the
next cell down-right proposes `\` too, while the cell to its right proposes
`/`, meeting it at the shared corner.

Two things it must not do, both load-bearing:

- **The cell's own two diagonals never vote** (`skipRow`/`skipCol`). They're
  what's being chosen between, so letting them count would make the answer
  depend on the answer — and would make the preference flip mid-cycle, so
  clicking would jump between states instead of advancing.
- **Count connections, not corners.** A wall along the cell's own top edge
  ends at *both* top corners, one belonging to each orientation, so it
  abstains — which is right, and falls out of counting per corner without
  a special case. Ties keep `\`, so a diagonal in open space is unchanged.

The preference chooses where the cycle **starts**, not what it contains, so
both orientations stay reachable from empty however the neighbours look. A
suggestion the DM can't override would be a bug; fixing the order at
`\ → / → none` and only choosing the first would make `\` unreachable in
any cell where `/` is preferred.

The cost of that, accepted knowingly: a wall added at a corner *after* the
diagonal can leave that diagonal in the cycle's second slot, so the next
click clears it rather than turning it. Clearing is a sane thing for a cycle
to do, and the alternative costs the reachability above.

There's exactly one call site, in `wallActionFromEvent()` — which is what
makes the hover preview incapable of proposing a diagonal the click won't
place.

### The hover preview, and one rendering trap

`wallHoverPos` stores a cursor *position*, not a resolved action, so the
preview re-derives from current state on every draw — after a click, the
preview under a stationary cursor updates to show what the *next* click
would do, with no extra bookkeeping.

The trap, found the hard way: **an edge the preview is about to repaint
must be skipped in the solid pass entirely.** Drawing it solid and then
tinting over it cannot work, because overlaying paint makes a stroke *more*
prominent, never less. This covers removal and also in-place change (a wall
becoming a door), which would otherwise leave the old state at full opacity
under a ghosted new one. The symptom when this is wrong is subtle — it
showed up as "the diagonal preview always has the same angle".

The preview also draws against a hypothetical `effective` walls map (current
walls plus the pending change), which is what lets an existing door visibly
slide over to meet the one being previewed beside it.

## Difficult terrain

`battleState.terrain[squareKey] = "difficult"` — keyed by **square**, like
placements, not by edge. A kind per square rather than `true`, so greater
difficult terrain later is a data change rather than a second parallel map.

It's a property of the ground, so tokens arriving, leaving or being deleted
never touch it. Only a grid shrink prunes it, with the same `cellInside()`
test placements use — none of the edge-index care `pruneWalls()` needs.

Drawn as three uneven triangles at `TERRAIN_ALPHA` (0.35). Scattered and
off-centre on purpose: a neat centred symbol reads as something placed *on*
the square rather than as what the square is made of. A flat tint wasn't
available — whole-square washes are already spoken for by the selection
highlight and the green/red drop feedback, and a third stacked on those is
unreadable.

## Pathfinding

`findPath(fromKey, toKey)` returns `[{ row, col, feet }]` with `feet`
cumulative from the start, or `null` if unreachable. It's Dijkstra, not
BFS, because steps aren't equal cost — and the state is **(cell, diagonal
parity, entry direction)**, not just the cell:

- **parity**, because PF2e's diagonals alternate 5/10 ft, so the cost of
  the next one depends on how many the route has already spent;
- **entry direction**, because a diagonal wall blocks *transit* rather than
  presence — whether it stops you depends on which side you came in by. A
  `\` separates `{N, NE, E}` from `{S, SW, W}`; its own NW/SE corners block
  nothing. You can always *enter* a cell with a diagonal wall.

Step cost is `(diagonal ? (parity ? 10 : 5) : 5)` plus 5 for difficult
terrain. Three things about the terrain part:

- It's charged by the square being **entered**, so the square you start on
  is free and the destination always pays. Cost is therefore *directional*
  — into rough ground costs 5 more than the trip back out — and the
  "cost is symmetric" property only holds between two clean squares.
- It does **not** advance the parity. It's extra cost, not an extra
  diagonal.
- +5 happens to be exactly what a two-diagonal way around one rough square
  costs, so the router is indifferent between crossing and skirting a lone
  patch. That's the boundary at which detouring starts to pay.

Tokens don't block — you can move through allies in PF2e, and the drop
target is checked separately.

A diagonal step is open if *either* way round it is open
(`diagonalStepOpen`), which is what lets a token move diagonally against a
single wall; it's blocked only when both ways round are shut.

## Tokens

`battleState.appearance[id] = { shape, letters, textColor, shapeColor }`,
all optional. `getAppearance(entityId, name)` is the one place a stored
override merges with computed defaults (the same "default unless tracked"
pattern as `currentHp()`): `shape` defaults to `"circle"`; `letters` to
`defaultInitials(name)` — one letter from each of the first two words, or
the first two letters of a single word (`"Tumb Kamneshit"` → `"TK"`,
`"Goblin"` → `"GO"`); the colours default to the live
`--accent-contrast`/`--accent` theme values, so an uncustomised token keeps
following light/dark mode and only an explicit override breaks from it.

**Unlike HP/temp-HP/initiative/conditions, appearance is not reset on
`remove-token`.** It's a visual identity, not battle progress — a token
pulled off the field and placed again keeps looking the way it was set up,
the same way its name does. Only `delete-custom-object` clears it.

`traceTokenShape(shape, cx, cy, radius)` traces into the current path but
does **not** fill; the caller sets `fillStyle` first. Keeping tracing and
colouring separate is what lets `drawGrid()`'s token loop stay one small
block instead of a shape × colour cross-product of draw calls.
`traceWall()` and `traceDifficultTerrain()` follow the same split.

The Token tab (`renderTokenTab()`) drives all four controls through one
`updateAppearance(entityId, patch, label)` helper, one `dispatch(
"update-appearance", ...)` per committed change. Inputs listen for
`change`, **not** `input` — `input` fires continuously while dragging a
colour wheel and would flood the undo log with one event per intermediate
value. Clearing the letters field passes `letters: undefined`, which
`updateAppearance()` treats specially: `undefined` **deletes** the key
(reverting to the computed default) rather than storing literally. A real
`undefined` would work in memory but vanish on the next
`JSON.stringify` round-trip, so deleting explicitly keeps in-memory state
consistent with what's actually persisted rather than relying on that
quirk.

## Moving a token by drag-and-drop

The map is a single `<canvas>` — no per-square element to hang native
`draggable="true"` on the way the initiative track does — so dragging is
hand-rolled from `mousedown`/`mousemove`/`mouseup`. The move itself
(`moveToken()`) is a `dispatch("move-token", ...)`; everything before the
drop is UI-only.

**Distinguishing a drag from a click on the same element** is the subtle
part. `mousedown` only *arms* a potential drag; `mousemove` flips
`dragMoved` once the cursor passes `DRAG_THRESHOLD` (4px); the `click`
handler bails out if `dragMoved` is set, because `mouseup` and `click` both
fire in sequence on a normal press-drag-release and a completed drag would
otherwise *also* run the select/place logic.

`mouseup` is on `window`, not the canvas, so a drag ending outside the grid
still resolves cleanly instead of leaving `dragFromKey` stuck. But that
means `click` might never fire to reset `dragMoved`, so `mouseup` schedules
a `setTimeout(() => { dragMoved = false; }, 0)` backstop, timed to run
after any same-target click has had its chance to see it. Panning uses the
identical pattern with `panMoved`.

While dragging, `drawGrid()` dims the origin square, tints the hovered one
green (valid, empty) or red (occupied), and draws the route from
`findPath()` with each step labelled by cumulative feet. All of it is drawn
*before* the token loop, so the dragged token visibly stays at its origin
square for the whole drag — it only jumps once the drop commits.
`mousemove` calls `drawGrid()` directly rather than the full `render()`:
nothing but the drag visuals changed, and the path is only recomputed when
the hovered *square* changes, not on every pixel.

`moveToken()` logs distance via `pf2eDistanceFeet()` (alternating-diagonal,
see the `pf2e-battle-grid` skill) alongside both squares' coordinates, e.g.
`"Moved Grog 15 ft, from (3, 2) to (5, 3)"` — coordinates written
`(col, row)` throughout the log. Note this is the straight-line PF2e
distance, **not** `findPath()`'s walked cost; the dashed path on the canvas
is what shows the latter.
