# The bottom boxes are full — treat every addition as a trade

`#battle-object-panel` (bottom-left) and `#battle-abilities-panel`
(bottom-right) are the two most constrained regions on the page, and the
constraint is structural rather than a styling accident. `.battle-layout` is
pinned to exactly `height: 100vh` with `overflow: hidden`, the map takes the
centre column's upper half, and what's left is split between two boxes about
220px tall and roughly a third of the viewport wide each. Nothing grows to fit.

**The default answer to "where does this go" is: in place of something, or
inside something already there.** Read this before adding any control, row,
heading or label to either box.

## The compactness check

Run all five before adding anything. Each has caught a real regression.

1. **Does it need a heading?** A heading costs a full line plus its margin,
   and the boxes are measured in lines. Two sections side by side share the
   vertical budget of one; stacked, they each pay.
2. **Does it need its own row?** Most things don't. Speed became icon+number
   chips on the identity row. The statblock link stopped being a button beside
   Speed and became the name itself. Level stacked above the name in a column,
   which costs the row zero width.
3. **Can it ride a fixed-width column?** Anything pinned under the saves grid
   is free horizontally — the grid already set that column's width. That is
   exactly why Recall Knowledge moved from above the conditions (where it was
   setting the width of the *wider*, flexible column) to under the grid.
4. **Does it reserve space it isn't using?** An empty section that still draws
   a heading is worse than no section. But see the jumping rule below — the fix
   is usually to drop the *contents*, not the box.
5. **Will it move something when it appears?** If so, give it a fixed
   fraction or a fixed size now, not after someone reports the jump.

## What each box already spends its space on

**Bottom-left (`renderCharacterTab`)** — the tightest thing on the page:

- Header row: remove ×, level-above-name, speed chips | HP bar, AC square.
  Treated as **full**; the architecture skill has a whole section on it.
- Body row: a fixed-width column (2×2 saves grid + Recall Knowledge under it)
  beside a flexible one (`.battle-afflictions` — conditions | persistent
  damage, two `1fr` columns).

**Bottom-right (`renderAbilitiesPanel`)** — five conditional tabs sharing one
sticky strip, with a single corner slot for a per-tab control. The strip is the
scarce resource there: it's why Inventory's add button sits beside the coin row
it edits rather than in the corner, and why the corner holds at most one
control per tab.

## Techniques that have worked here

- **Columns instead of stacks** for two short lists. Conditions and persistent
  damage were stacked and cost two headings' worth of height; side by side they
  cost one row and neither list was wide enough to miss the space. Keep them
  *siblings* under a layout wrapper, though — nesting one inside the other to
  get the columns makes the outer block's name claim something false about its
  contents.
- **Fold a mode into an existing control, don't add one for it.** Persistent
  damage went from `dice` + `die` + `flat` fields (two always noise), to a
  Die/Flat tab strip over one `Value` field, to just putting "flat" at the top
  of the `Die` select. The tab strip was a control whose only job was hiding
  another control. Ask whether the mode is really a *value* of something
  already on screen — "no die" is a die option, not a mode.
- **Chips instead of rows.** Persistent damage entries, speed, coins. A chip
  wraps, a row doesn't, and five chips fit where two rows would.
- **Abbreviate the label, not the number.** `FORT`/`REF`/`WILL`/`PERC` —
  spelling out "PERCEPTION" was what set the tile width. The four aren't
  ambiguous against anything else in the panel.
- **Make an existing element the control.** A monster's name *is* the statblock
  link. No new element, no new width.
- **Stack in a column where the row is tight but the box isn't.** Level above
  name. Vertical space is scarce too, but a 2-line column inside an existing
  row often costs nothing because a neighbour (the HP bar) is already taller.
- **Icons at ~10px, with the shapes checked.** Fine detail does not survive.
  Rasterize before trusting it (see the elite/weak switch).

## The tension with the jumping rule

"Always render the element, toggle a class" and "don't waste space" pull in
opposite directions, and picking the wrong side causes a different bug each
way. The resolution used here:

- **Reserve space for something that toggles on the same selection** — a shield
  icon, a stepper, a column that fills as the fight goes on. The persistent
  damage column is always rendered at `1fr` for exactly this reason: applying
  the first bleed must not reflow the conditions beside it.
- **Don't reserve space for something that differs between selections** — the
  Info tab, a monster's Recall Knowledge line. Selecting a different creature
  legitimately redraws the panel, and holding a slot for a tab this entity
  doesn't have is pure waste.

The test: *would this element appearing be caused by an action inside this
panel?* If yes, reserve. If it only differs because a different thing is
selected, don't.

## Where to put things that genuinely don't fit

In order of preference:

1. **Inside an existing row or tab** — see the techniques above.
2. **A dialog.** Editing belongs in one anyway: the panels rebuild on every
   `render()`, so an input living in one loses half-typed text to any unrelated
   dispatch. `#battle-inventory-dialog` and `#battle-persistent-dialog` both
   exist for this reason.
3. **A tooltip.** The `title` on a chip or tile carries the rules text, the
   full stat name, the condition arithmetic — everything a DM needs
   occasionally but not at a glance.
4. **A new tab in the bottom-right.** Cheap: the strip already exists and tabs
   are filtered per entity. This is the escape hatch when something genuinely
   needs its own page.

**Not** a new top-level region, and not relaxing `.battle-layout`'s
`overflow: hidden`. If a box's content can grow unboundedly, give *that box*
`overflow: auto` — both bottom boxes already scroll internally.
