// Battle Helper: a square grid where characters can be placed/removed.
// Architecture (event-driven state + snapshot undo/redo) is documented in
// the battle-helper-architecture skill — read that before changing how
// dispatch()/undo()/redo() work or adding a new event type. PF2e grid
// rules (5 ft/square, diagonal movement, creature size) are documented in
// the pf2e-battle-grid skill.

const STORE_KEY = "pathfinder-dm-tools";
const BATTLE_STORE_KEY = "pathfinder-dm-tools:battle";

const canvas = document.getElementById("battle-grid");
const ctx = canvas.getContext("2d");
const mapViewport = document.getElementById("battle-map-viewport");
const objectPanel = document.getElementById("battle-object-panel");
const abilitiesPanel = document.getElementById("battle-abilities-panel");
const rosterList = document.getElementById("battle-roster");
const initiativeList = document.getElementById("battle-initiative");
const logList = document.getElementById("battle-log");
const undoBtn = document.getElementById("battle-undo");
const redoBtn = document.getElementById("battle-redo");

const hpDialog = document.getElementById("battle-hp-dialog");
const hpDialogName = document.getElementById("battle-hp-dialog-name");
const hpInput = document.getElementById("battle-hp-input");
const hpCloseBtn = document.getElementById("battle-hp-close");

const initiativeDialog = document.getElementById("battle-initiative-dialog");
const initiativeDialogName = document.getElementById("battle-initiative-dialog-name");
const initiativeForm = document.getElementById("battle-initiative-form");
const initiativeInput = document.getElementById("battle-initiative-input");
const initiativeCloseBtn = document.getElementById("battle-initiative-close");

const conditionDialog = document.getElementById("battle-condition-dialog");
const conditionDialogTitle = document.getElementById("battle-condition-dialog-name");
const conditionFilter = document.getElementById("battle-condition-filter");
const conditionOptions = document.getElementById("battle-condition-options");
const conditionCloseBtn = document.getElementById("battle-condition-close");

const characterDialog = document.getElementById("battle-character-dialog");
const characterFilter = document.getElementById("battle-character-filter");
const characterOptions = document.getElementById("battle-character-options");
const characterCloseBtn = document.getElementById("battle-character-close");

const monsterDialog = document.getElementById("battle-monster-dialog");
const monsterFilter = document.getElementById("battle-monster-filter");
const monsterOptions = document.getElementById("battle-monster-options");
const monsterCloseBtn = document.getElementById("battle-monster-close");

const entityRenameDialog = document.getElementById("battle-entity-rename-dialog");
const entityRenameForm = document.getElementById("battle-entity-rename-form");
const entityRenameInput = document.getElementById("battle-entity-rename-input");
const entityRenameCloseBtn = document.getElementById("battle-entity-rename-close");

const inventoryDialog = document.getElementById("battle-inventory-dialog");
const inventoryDialogName = document.getElementById("battle-inventory-dialog-name");
const inventoryAddForm = document.getElementById("battle-inventory-add-form");
const inventoryItemInput = document.getElementById("battle-inventory-item");
const inventoryQtyInput = document.getElementById("battle-inventory-qty");
const inventoryMoneyForm = document.getElementById("battle-inventory-money-form");
const inventoryCoinInputs = {
  pp: document.getElementById("battle-inventory-pp"),
  gp: document.getElementById("battle-inventory-gp"),
  sp: document.getElementById("battle-inventory-sp"),
  cp: document.getElementById("battle-inventory-cp"),
};
const inventoryCloseBtn = document.getElementById("battle-inventory-close");

const aonDialog = document.getElementById("aon-dialog");
const aonDialogTitle = document.getElementById("aon-dialog-title");
const aonDialogBody = document.getElementById("aon-dialog-body");
const aonDialogOpenTab = document.getElementById("aon-dialog-open-tab");
const aonDialogClose = document.getElementById("aon-dialog-close");

const addObjectForm = document.getElementById("battle-add-object-form");
const addObjectNameInput = document.getElementById("battle-add-object-name");
const addCharacterBtn = document.getElementById("battle-add-character");
const addMonsterBtn = document.getElementById("battle-add-monster");
const logClearBtn = document.getElementById("battle-log-clear");

const tabList = document.getElementById("battle-tab-list");
const tabAddBtn = document.getElementById("battle-tab-add");
const renameDialog = document.getElementById("battle-rename-dialog");
const renameForm = document.getElementById("battle-rename-form");
const renameInput = document.getElementById("battle-rename-input");
const renameCloseBtn = document.getElementById("battle-rename-close");
const deleteBattleDialog = document.getElementById("battle-delete-dialog");
const deleteBattleMessage = document.getElementById("battle-delete-message");
const deleteBattleCancelBtn = document.getElementById("battle-delete-cancel");
const deleteBattleConfirmBtn = document.getElementById("battle-delete-confirm");

const SQUARE_SIZE = 40; // px — each square is 5 ft per PF2e's grid convention

// The grid is resizable per battle (battleState.cols/rows, driven by the
// four +/- controls around the map), so its dimensions are state, not
// constants. 5x5 is both the starting size and the floor. The ceiling
// isn't a design limit — it's there so holding "+" can't allocate a canvas
// big enough to hang the tab (60x60 is already 2400px square).
const MIN_GRID = 5;
const MAX_GRID = 60;

// Every nth grid line is drawn heavier, so squares can be counted in
// blocks rather than one at a time. 5 squares is 25 ft, which is also
// roughly a Speed's worth of movement.
const GRID_MAJOR_EVERY = 5;

function clampDimension(value) {
  return Math.min(MAX_GRID, Math.max(MIN_GRID, Number(value) || MIN_GRID));
}

// Which instrument clicks on the map act with. UI-only, like zoom and
// selection — the chosen tool isn't part of the battle, so it never
// dispatches and undo doesn't cycle back through it.
//   select  — click to inspect a square, drag a token to move it (default)
//   wall    — click near a cell edge to toggle a wall on that edge
//   door    — the same, placing a door instead
//   terrain — click a square to toggle difficult terrain on it
const TOOL_SELECT = "select";
const TOOL_WALL = "wall";
const TOOL_DOOR = "door";
const TOOL_TERRAIN = "terrain";
let activeTool = TOOL_SELECT;

// Both the wall and door tools edit edges and want the same crosshair and
// hover preview; only their click cycles differ.
function isEdgeTool() {
  return activeTool === TOOL_WALL || activeTool === TOOL_DOOR;
}

// Every tool whose click edits the map instead of selecting or dragging.
// The terrain tool isn't an edge tool — it targets a whole square, so it
// needs no hover preview to disambiguate which edge is meant — but it does
// want the same "a click here changes the map" crosshair.
function isMapEditTool() {
  return isEdgeTool() || activeTool === TOOL_TERRAIN;
}

// What occupies an edge. Mutually exclusive states of one edge, so
// battleState.walls maps a key to ONE of these rather than to `true`.
//
// There is deliberately no "double door" state: a double door is TWO
// doors, on the adjacent edges of two neighbouring cells, and it emerges
// from that adjacency at draw time (see drawEdgeShape) rather than being
// a thing you place. One cell can only ever hold one door.
const EDGE_WALL = "wall";
const EDGE_DOOR = "door";

// How thick a wall is drawn, in logical (unzoomed) px.
const WALL_THICKNESS = 5;

// Blank margin around the grid, in logical px. Walls and doors straddle
// the line they sit on, so one on the outer boundary has half its width
// outside the grid rectangle. Without room for that overhang the bitmap
// clips it, and the old fix — nudging boundary walls inward by half a
// thickness — made them visibly sit inside the first row of squares
// instead of on the edge. Reserving the space instead keeps every wall
// centred on its own line, wherever it is.
//
// Sized for the widest thing that can overhang: a door panel is
// DOOR_THICKNESS across plus a DOOR_BORDER stroke centred on its edge.
// Kept a whole number so it can't knock the half-pixel grid-line
// alignment off.
const CANVAS_PAD = 5;

// A door spans 80% of its cell edge. On its own it sits centred, leaving a
// 10% wall stub at each end. When the neighbouring cell's matching edge
// also has a door, the two slide together ("magnet") to meet on the shared
// cell boundary, which puts all 20% of that cell's wall on the outer side
// and reads as one double door across two cells. The door itself is always
// 80% — only its offset within the cell changes.
//
// Panels are drawn as thin rectangles outlined with a noticeably thinner
// stroke than a wall, so a doorway reads as an opening with a panel in it
// rather than as more wall.
const DOOR_LENGTH = 0.8;
const DOOR_THICKNESS = 7;
const DOOR_BORDER = 1.5;

// Terrain sits IN squares, not on the lines between them, so it's keyed by
// the same "row,col" square key as placements — not by wallKey(). Like
// walls, a square maps to a terrain *kind* rather than to `true`, so
// adding greater difficult terrain later is a data change rather than a
// second parallel map.
const TERRAIN_DIFFICULT = "difficult";

// PF2e: entering a square of difficult terrain costs 5 extra feet. It's the
// square being ENTERED that charges — leaving one is free — which is why
// this is added to the step cost in findPath() rather than to the square's
// own arrival total.
const DIFFICULT_TERRAIN_FEET = 5;

// Drawn as a low-contrast scatter of small triangles ("rubble") rather
// than a flat tint: whole-square tints are already spoken for by the
// selection highlight and the drag-drop feedback, and a shape still reads
// underneath both of those where another wash of colour would not.
const TERRAIN_ALPHA = 0.35;

// How far from an edge still counts as "the centre" (fraction of a
// square), i.e. the zone that places a diagonal rather than an edge wall.
// 0.3 leaves the middle ~40% of the cell as the diagonal target, which is
// a comfortable click area without crowding the four edge zones.
const WALL_CENTRE_ZONE = 0.3;

// Last cursor position over the map while the wall tool is active, used to
// recompute the hover preview. Stored as a position rather than a resolved
// action so the preview re-derives itself from current state on every
// draw — after a click changes the walls, the preview under a stationary
// cursor updates to show what the NEXT click would do, with no extra
// bookkeeping.
let wallHoverPos = null;
let wallHoverSig = null; // signature of the previewed action, to skip no-op redraws on mousemove

function wallActionSignature(action) {
  return action ? `${action.remove}|${action.add}` : null;
}

function clearWallHover() {
  if (!wallHoverPos && wallHoverSig === null) return;
  wallHoverPos = null;
  wallHoverSig = null;
  drawGrid();
}

// Walls sit on the LINES BETWEEN cells, not in cells, so they're keyed by
// edge rather than by square:
//   "h,row,col" — horizontal wall along the TOP edge of cell (row, col),
//                 i.e. between cells (row-1, col) and (row, col)
//   "v,row,col" — vertical wall along the LEFT edge of cell (row, col),
//                 i.e. between cells (row, col-1) and (row, col)
// Canonicalising to top/left only is what stops one wall being storable
// under two names (the top of (3,4) is the bottom of (2,4)).
//
// The consequence that matters everywhere below: for an "h" wall the ROW
// is an edge index running 0..rows (one more value than there are cells),
// while its col is an ordinary cell index 0..cols-1 — and "v" is the
// mirror image. See pruneWalls() for why that asymmetry needs care.
function wallKey(type, row, col) {
  return `${type},${row},${col}`;
}

// Zoom is UI-only, like selection — it changes what you're looking at, not
// the battle, so it never dispatches (undoing a zoom would be baffling).
// It's also deliberately global rather than per-battle and not persisted:
// it's a viewing preference, so switching tabs keeps whatever you set.
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.2;
let zoom = 1;

// How the map is panned, in CSS px, on top of wherever the layout puts the
// canvas (.battle-grid's margin: auto — see the CSS). Panning used to be
// mapViewport.scrollLeft/scrollTop, which composed nicely with the
// scrollbars but could only move a canvas *bigger* than its viewport: a
// small map had no scroll range, so dragging it did nothing at all. A
// transform has no such floor, so one gesture now works at every size, and
// the viewport no longer scrolls (or needs scrollbars) at all.
let panX = 0;
let panY = 0;

// Enough of the canvas to grab hold of again. Panning is unbounded in the
// sense that you can push the map most of the way off the box, but never so
// far that there's nothing left on screen to drag back.
const MIN_MAP_VISIBLE = 60;

function applyPan() {
  canvas.style.transform = panX || panY ? `translate(${panX}px, ${panY}px)` : "";
}

// Pulls the pan back until the canvas still overlaps the viewport, and is
// also what keeps a pan honest after the map shrinks or the zoom drops.
//
// Works off measured rects rather than predicted ones deliberately: where
// the layout puts an unpanned canvas changes as it outgrows the viewport
// (flexbox treats auto margins as 0 once free space goes negative, so a
// centred map becomes a start-anchored one), and duplicating that rule here
// would be one more thing to keep in sync with the stylesheet.
function clampPan() {
  const rect = canvas.getBoundingClientRect();
  const view = mapViewport.getBoundingClientRect();
  if (!rect.width || !view.width) return;
  const keepX = Math.min(MIN_MAP_VISIBLE, rect.width);
  const keepY = Math.min(MIN_MAP_VISIBLE, rect.height);
  let dx = 0;
  let dy = 0;
  if (rect.right < view.left + keepX) dx = view.left + keepX - rect.right;
  else if (rect.left > view.right - keepX) dx = view.right - keepX - rect.left;
  if (rect.bottom < view.top + keepY) dy = view.top + keepY - rect.bottom;
  else if (rect.top > view.bottom - keepY) dy = view.bottom - keepY - rect.top;
  if (!dx && !dy) return;
  panX += dx;
  panY += dy;
  applyPan();
}

function setPan(x, y) {
  panX = x;
  panY = y;
  applyPan();
  clampPan();
  // The reset button's enabled state depends on the pan, not just the zoom
  // — a centred map at fit zoom is the only state it can't improve on.
  renderZoomControls();
}

// `anchor` is an optional { clientX, clientY } to hold still — the point
// under the mouse wheel. Without it a zoom grows the canvas from its
// centre (see .battle-grid's margin: auto) and whatever you were looking
// at slides away, which makes wheel-zoom feel like it's fighting you.
function setZoom(value, anchor = null) {
  // Rounded to whole percents so repeated +/- steps can't drift onto
  // values like 0.9999999999 and miss the ZOOM_MIN/MAX comparisons.
  const next = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value)) * 100) / 100;
  if (next === zoom) return;

  // Where the anchor sits in unzoomed canvas coordinates, measured BEFORE
  // the canvas is resized.
  let hold = null;
  if (anchor) {
    const rect = canvas.getBoundingClientRect();
    hold = {
      x: (anchor.clientX - rect.left) / zoom,
      y: (anchor.clientY - rect.top) / zoom,
      clientX: anchor.clientX,
      clientY: anchor.clientY,
    };
  }

  zoom = next;
  render();

  if (hold) {
    // Put the same canvas point back under the cursor, by correcting the
    // pan by however far it actually drifted. Measuring the drift beats
    // predicting it: the prediction would have to model both the centring
    // above and clampPan()'s correction inside that render().
    const rect = canvas.getBoundingClientRect();
    setPan(panX + hold.clientX - (rect.left + hold.x * zoom),
           panY + hold.clientY - (rect.top + hold.y * zoom));
  }
}

// The zoom at which the whole map fits the viewport — what the reset button
// aims for. Not 100%: on a big board 100% shows a fraction of it, and on a
// small one it wastes most of the box, so "show me all of it" is the useful
// reset and it lands above or below 100% depending on the map.
function fitZoom() {
  const width = gridCols() * SQUARE_SIZE + CANVAS_PAD * 2;
  const height = gridRows() * SQUARE_SIZE + CANVAS_PAD * 2;
  const view = mapViewport.getBoundingClientRect();
  if (!view.width || !view.height) return zoom;
  const raw = Math.min(view.width / width, view.height / height);
  // Floored to a whole percent, never rounded: rounding up is enough to
  // push the last row of squares back out of the box, which is the one
  // thing this is for. The clamps mean a huge map can still overflow at
  // ZOOM_MIN — panning covers that case, as it did before.
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.floor(raw * 100) / 100));
}

// Can't go through setZoom(): the pan has to be reset even when the zoom is
// already right (a panned-away map at fit zoom still needs re-centring),
// and setZoom() returns early on an unchanged value.
function fitMapToView() {
  const next = fitZoom();
  if (next !== zoom) {
    zoom = next;
    render();
  }
  setPan(0, 0);
}

// ---------------------------------------------------------------------------
// Battle state: the only things that live behind dispatch()/undo()/redo().
// Everything else below (selectedSquareKey, armedEntityId) is UI-only —
// see the battle-helper-architecture skill for why that split matters.

function emptyBattleState() {
  return { placements: {}, hp: {}, tempHp: {}, customObjects: {}, characterIds: [], initiative: {}, initiativeOrder: [], appearance: {}, conditions: {}, spellSlots: {}, inventory: {}, walls: {}, terrain: {}, cols: MIN_GRID, rows: MIN_GRID, originRow: 0, originCol: 0 };
}

// Multiple battles, browser-tab style. Each entry is a fully independent
// encounter — its own placements/HP/custom objects AND its own event log
// and undo cursor, so undoing in one battle can never reach into another.
// battleState/eventLog/cursor below stay exactly what they always were:
// the *active* battle's live values, which is why dispatch(), undo(),
// redo() and every render function needed no changes for this feature.
// persistBattleStore() is what syncs those live values back into the
// active entry before writing.
//
// Creating, switching, renaming and closing a battle are deliberately NOT
// dispatch()ed, even though they change what's on screen: dispatch()
// snapshots battleState only, and undo/redo work by walking a single
// battle's eventLog — a tab operation sits *above* that layer, so there's
// no coherent way for a per-battle undo stack to undo it. This is the same
// reasoning that keeps the log's own "Clear" button out of dispatch()
// (see the battle-helper-architecture skill, Rule 2).
let battles = []; // [{ id, name, state, eventLog, cursor }]
let activeBattleId = null;

let battleState = emptyBattleState();
// hp/tempHp/initiative: entity id -> value; customObjects: id -> { name };
// initiativeOrder: entity ids in the order the initiative track displays
// them — manually reorderable by drag-and-drop, independent of the
// initiative numbers; appearance: entity id -> { shape, letters,
// textColor, shapeColor } (all optional — see getAppearance()). Unlike
// hp/tempHp/initiative, appearance is NOT reset on remove-token: it's a
// visual identity for the entity, not battle progress, so it should
// survive being pulled off and put back on the field.
// (see the battle-helper-architecture skill's "Token appearance" section)
let eventLog = []; // [{ type, label, before, after, at }]
let cursor = -1; // index into eventLog of the last applied event

let selectedSquareKey = null; // square the player clicked to inspect
let armedEntityId = null; // roster character or custom object about to be placed
let hpDialogCharacterId = null; // character the HP dialog is currently open for (never a custom object — they have no HP dialog)
let initiativeDialogEntityId = null; // entity the initiative dialog is currently open for (character or custom object)

// Map drag-and-drop (mouse-based, not native HTML5 DnD — canvas has no
// sub-element to attach draggable="true" to). All UI-only until a real
// drop happens; the drop itself is a dispatch(), same as any other move.
let dragFromKey = null; // square a token drag started from, or null
let dragHoverKey = null; // square currently under the cursor mid-drag
let dragStartPos = null; // {x,y} client coords at mousedown — distinguishes a real drag from a simple click
let dragMoved = false; // true once mouse movement crossed DRAG_THRESHOLD — suppresses the click handler that would otherwise also fire
let dragPath = null; // shortest route from dragFromKey to dragHoverKey, or null if unreachable
const DRAG_THRESHOLD = 4; // px

// A roster row being dragged onto the map. Native HTML5 DnD rather than the
// mouse-based gesture above, because here the thing dragged is a real
// element. It reuses dragHoverKey for the green/red target tint — the two
// gestures can't overlap, since starting a native drag stops mousemove
// firing — but never dragFromKey, which is what suppresses the walked-path
// overlay: a token being placed is coming from off the board, not walking.
let rosterDragId = null;

// Panning: grabbing the map by an empty square — or by the blank space
// around it — and dragging the view. Distinct from the token drag above —
// that moves a piece, this moves the camera — so it gets its own state and
// its own click-suppression flag, but the same press/threshold/release
// shape. Moves panX/panY (see setPan()), which unlike a scroll offset works
// however small the map is.
let panFrom = null; // { x, y } pan offset captured at mousedown
let panStartPos = null; // {x,y} client coords at mousedown
let panMoved = false; // true once movement crossed DRAG_THRESHOLD — suppresses the click that would otherwise select a square

// Raise a Shield is situational, like the main app's AC toggle — it isn't
// baked into the sheet and wouldn't surprise anyone by disappearing on
// undo, so it's UI-only state, not battle state. Kept across renders (a
// plain Set, not rebuilt from HTML) since renderObjectPanel() re-renders on
// every selection change.
let raisedShieldIds = new Set();

function createBattle(name) {
  return { id: `battle-${crypto.randomUUID()}`, name, state: emptyBattleState(), eventLog: [], cursor: -1 };
}

// Spreads a stored state over a fresh empty one so a battle saved before a
// given field existed (e.g. appearance) still gets it.
//
// Grids saved before they were resizable have no cols/rows at all. Those
// don't get the 5x5 default a new battle gets — the old fixed grid was
// 24x16, so tokens can sit well outside 5x5 and would be stranded
// off-canvas, unreachable and invisible. Instead the grid is sized to fit
// whatever placements are actually there, with the same 5x5 floor: an
// empty old battle still lands on 5x5, a populated one keeps everyone
// on the field.
function normalizeState(raw) {
  const state = { ...emptyBattleState(), ...raw };

  if (raw?.cols == null || raw?.rows == null) {
    let maxRow = -1;
    let maxCol = -1;
    for (const key of Object.keys(state.placements)) {
      const [row, col] = key.split(",").map(Number);
      if (Number.isFinite(row)) maxRow = Math.max(maxRow, row);
      if (Number.isFinite(col)) maxCol = Math.max(maxCol, col);
    }
    state.rows = maxRow + 1;
    state.cols = maxCol + 1;
  }

  state.rows = clampDimension(state.rows);
  state.cols = clampDimension(state.cols);
  // Boards saved before coordinates were anchored started at (0, 0) with
  // no origin recorded, which is exactly an origin of zero — so they need
  // no conversion, only the defaults.
  state.originRow = Number.isFinite(state.originRow) ? Math.trunc(state.originRow) : 0;
  state.originCol = Number.isFinite(state.originCol) ? Math.trunc(state.originCol) : 0;

  // Walls were once a plain { key: true } set; an edge now carries a state
  // so doors can share the same map. Anything non-string is a wall from
  // before doors existed. "double" was a short-lived one-cell double-door
  // state, since replaced by two adjacent doors — it collapses to a single
  // door rather than being dropped, so a map built with it keeps its
  // doorways.
  const walls = {};
  for (const [key, value] of Object.entries(state.walls ?? {})) {
    if (!value) continue;
    if (typeof value !== "string") walls[key] = EDGE_WALL;
    else if (value === "double") walls[key] = EDGE_DOOR;
    else walls[key] = value;
  }
  state.walls = walls;

  // The roster used to list every character in the main app's store.
  // It now lists only the ones added to this battle, so a save from before
  // that needs seeding — with the characters actually in play, not with
  // everything. Anything else would refill the roster of every old battle
  // with people who were never in it, which is the mess the change was
  // made to avoid. A placed character has to be in the list, or removing
  // them from the field would strand them with no way back on.
  if (!Array.isArray(raw?.characterIds)) {
    const customIds = new Set(Object.keys(state.customObjects ?? {}));
    state.characterIds = [...new Set(Object.values(state.placements))].filter((id) => !customIds.has(id));
  } else {
    state.characterIds = raw.characterIds.filter((id) => typeof id === "string");
  }

  return state;
}

// Reads the store into a { battles, activeBattleId } shape, normalizing
// whatever's there. Saves written before this feature existed were a
// single battle (`{ state, eventLog, cursor }` at the top level) — those
// get wrapped into the first tab rather than discarded, so an in-progress
// encounter survives the upgrade. There is always at least one battle.
function loadBattleStore() {
  let raw;
  try {
    raw = JSON.parse(localStorage.getItem(BATTLE_STORE_KEY)) ?? {};
  } catch {
    raw = {};
  }

  const rawBattles = Array.isArray(raw.battles)
    ? raw.battles
    : [{ name: "Battle 1", state: raw.state, eventLog: raw.eventLog, cursor: raw.cursor }];

  const battles = rawBattles.filter(Boolean).map((b, i) => ({
    id: b.id ?? `battle-${crypto.randomUUID()}`,
    name: b.name ?? `Battle ${i + 1}`,
    state: normalizeState(b.state),
    eventLog: b.eventLog ?? [],
    cursor: b.cursor ?? -1,
  }));

  if (!battles.length) battles.push(createBattle("Battle 1"));

  const active = battles.some((b) => b.id === raw.activeBattleId) ? raw.activeBattleId : battles[0].id;
  return { battles, activeBattleId: active };
}

// Syncs the live active-battle values back into their entry before
// writing, so every existing persistBattleStore() call site (dispatch,
// undo, redo, clear log) keeps working untouched.
function persistBattleStore() {
  const active = battles.find((b) => b.id === activeBattleId);
  if (active) {
    active.state = battleState;
    active.eventLog = eventLog;
    active.cursor = cursor;
  }
  localStorage.setItem(BATTLE_STORE_KEY, JSON.stringify({ battles, activeBattleId }));
}

// The main app's character store — read-only from here. Battle-helper
// never writes to it; a placement stores a character id and looks the
// character back up at render time, so it always reflects the character's
// current sheet rather than a stale copy.
function loadCharacters() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY)) ?? {};
    return raw.characters ?? [];
  } catch {
    return [];
  }
}

// Groups are how the main page organises characters (typically one per
// party), and the character picker mirrors that so a DM finds people where
// they filed them.
function loadGroups() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY)) ?? {};
    return raw.groups ?? [];
  } catch {
    return [];
  }
}

// Characters grouped exactly the way renderSidebar() groups them on the
// main page: groups in store order, then everything with no group — or a
// group id that no longer resolves — under "Ungrouped".
function charactersByGroup() {
  const characters = loadCharacters();
  const groups = loadGroups();
  const sections = groups
    .map((group) => ({ name: group.name, characters: characters.filter((c) => c.groupId === group.id) }))
    .filter((section) => section.characters.length);

  const ungrouped = characters.filter((c) => !c.groupId || !groups.some((g) => g.id === c.groupId));
  if (ungrouped.length) sections.push({ name: "Ungrouped", characters: ungrouped });
  return sections;
}

// Character ids added to THIS battle, reconciled against the store on read
// — a character deleted on the main page shouldn't leave a dead roster row
// behind. Read-time only, like initiativeOrderIds(): it returns a corrected
// list without writing one back outside dispatch().
function battleCharacterIds() {
  const known = new Set(loadCharacters().map((c) => c.id));
  return (battleState.characterIds ?? []).filter((id) => known.has(id));
}

// ---------------------------------------------------------------------------
// Monsters. A monster on the field is a custom object that remembers which
// bestiary entry it came from — deliberately NOT a third kind of entity.
// Everything custom objects already do (placement, initiative, conditions,
// appearance, removal, deletion) then works for monsters with no parallel
// code paths, which is the same reason findEntity() exists at all.
//
// The reference list is name -> AoN page, built by
// local/scripts/build_monster_entities.py from local/data/monsters.txt. Statblocks are
// deliberately NOT copied into this repo: the popup opens the real AoN
// page, so there's no partial, drifting copy of a monster's numbers here.
// That does mean a monster token carries no HP or AC of its own yet — the
// source table has both columns whenever that's wanted.
const AON_BASE = "https://2e.aonprd.com";
// Every creature in the bestiary list lives on Monsters.aspx, so the page is
// a constant rather than a field repeated 558 times. The build script warns
// if a rebuild ever resolves one somewhere else (AoN also has NPCs.aspx) —
// see EXPECTED_PAGE in local/scripts/build_monster_entities.py.
const AON_MONSTER_PAGE = "Monsters.aspx";
let monsterList = []; // [{ name, archives_of_nexus_id }] — stats too, in local dev
let monsterByName = new Map();

// Monster data files are build output — they change only when the build
// script is re-run — so a repeat visit shouldn't pay to download them
// again. The Cache API holds them rather than localStorage: it's built for
// whole HTTP responses, and its quota is separate from the ~5 MB origin
// budget that characters, rolls and battle state already share.
//
// Stale-while-revalidate. A cached copy is returned at once and the network
// copy replaces it in the background, so a local rebuild shows up on the
// next load instead of never, without any page load waiting on a file that
// rarely changes. Returns null when there's nothing to be had.
const MONSTER_CACHE = "monster-data-v1";

async function fetchMonsterData(path) {
  // Absent on insecure origins — opening this page over file://, say. The
  // fetch still works there, it just isn't cached between visits.
  if (typeof caches === "undefined") {
    const response = await fetch(path);
    return response.ok ? response.json() : null;
  }

  const cache = await caches.open(MONSTER_CACHE);
  const cached = await cache.match(path);
  const fresh = fetch(path)
    .then((response) => {
      if (response.ok) cache.put(path, response.clone());
      return response;
    })
    // A failed revalidation isn't an error when a cached copy already
    // answered; the miss path below handles having neither.
    .catch(() => null);

  if (cached) return cached.json();
  const response = await fresh;
  return response?.ok ? response.json() : null;
}

async function loadMonsterList() {
  try {
    const list = await fetchMonsterData("../monster-data/monsters.json");
    if (!list) return;
    monsterList = list;
    monsterByName = new Map(monsterList.map((m) => [m.name, m]));
  } catch {
    // Non-fatal: the roster's "Add monster" button just finds nothing to
    // offer, and every other feature on the page is unaffected.
  }
}

// Spell name -> AoN id, from the committed static/spell-data/*.json the
// main app already ships. Loaded lazily on the first render of a Spells
// tab, memoised so N renders cause one load, and re-rendering once it
// arrives — the same shape as loadMonsterAbilities(), and for the same
// reason: a session that never selects a caster never fetches it.
//
// Until it lands (or if it fails) every chip falls back to AoN search,
// which resolves a spell by name reliably enough to be a real fallback
// rather than a broken link. That's why nothing here needs a loading state.
let spellIdMap = {};
let spellIdPromise = null;

function loadSpellIds() {
  if (spellIdPromise) return spellIdPromise;
  spellIdPromise = Promise.all(
    ["cantrips", "spells", "focals"].map((file) => fetch(`../spell-data/${file}.json`)
      .then((response) => (response.ok ? response.json() : []))
      .catch(() => [])),
  ).then((lists) => {
    for (const entities of lists) {
      for (const entity of entities) {
        if (entity.archives_of_nexus_id != null) spellIdMap[entity.name] = entity.archives_of_nexus_id;
      }
    }
    render();
  });
  return spellIdPromise;
}

function spellUrl(name) {
  const id = spellIdMap[name];
  return id != null
    ? `${AON_BASE}/Spells.aspx?ID=${id}`
    : `${AON_BASE}/Search.aspx?q=${encodeURIComponent(name)}`;
}

// Items, the same way — but an item's page varies by category, so the map
// stores both. Later files win on a name collision, matching the main app's
// loadItemIdMap() rather than inventing a different tie-break here.
const AON_ITEM_PAGES = { armor: "Armor.aspx", weapon: "Weapons.aspx", equipment: "Equipment.aspx", shield: "Shields.aspx" };
let itemIdMap = {};
let itemIdPromise = null;

function loadItemIds() {
  if (itemIdPromise) return itemIdPromise;
  itemIdPromise = Promise.all([
    ["armor", "armor.json"],
    ["equipment", "alchemical-items.json"],
    ["weapon", "weapons-melee.json"],
    ["weapon", "weapons-ranged.json"],
    ["shield", "shields.json"],
  ].map(([category, file]) => fetch(`../item-data/${file}`)
    .then((response) => (response.ok ? response.json() : []))
    .then((entities) => [category, entities])
    .catch(() => [category, []])))
    .then((loaded) => {
      for (const [category, entities] of loaded) {
        for (const entity of entities) {
          if (entity.archives_of_nexus_id != null) {
            itemIdMap[entity.name] = { category, id: entity.archives_of_nexus_id };
          }
        }
      }
      render();
    });
  return itemIdPromise;
}

// lookupName is the base item name; a weapon or armor's display name can
// carry a material or rune prefix ("Cold Iron Clan Dagger") that resolves
// against nothing. Same split the main app's itemNameLink() makes.
function itemUrl(lookupName) {
  const item = itemIdMap[lookupName];
  return item
    ? `${AON_BASE}/${AON_ITEM_PAGES[item.category]}?ID=${item.id}`
    : `${AON_BASE}/Search.aspx?q=${encodeURIComponent(lookupName)}`;
}

// A monster AoN had nothing for has a null id and falls back to AoN's search
// page — the same fallback the main app uses for an item it doesn't
// recognise, and the only case the null check is guarding.
function monsterUrl(monsterName) {
  const monster = monsterByName.get(monsterName);
  if (monster?.archives_of_nexus_id != null) {
    return `${AON_BASE}/${AON_MONSTER_PAGE}?ID=${monster.archives_of_nexus_id}`;
  }
  return `${AON_BASE}/Search.aspx?q=${encodeURIComponent(monsterName)}`;
}

// One hidden iframe per distinct URL, kept alive rather than removed, so
// reopening an already-viewed statblock doesn't re-request it — only its
// visibility toggles. Mirrors openAonPopup() in static/app.js, including
// its reasoning; the dialog markup and styling are shared via style.css.
const aonIframes = new Map();

function openAonPopup(url, name) {
  let iframe = aonIframes.get(url);
  if (!iframe) {
    iframe = document.createElement("iframe");
    iframe.src = url;
    iframe.loading = "lazy";
    aonIframes.set(url, iframe);
    aonDialogBody.appendChild(iframe);
  }
  for (const [otherUrl, otherIframe] of aonIframes) {
    otherIframe.classList.toggle("active", otherUrl === url);
  }
  aonDialogTitle.textContent = name;
  aonDialogOpenTab.href = url;
  aonDialog.showModal();
}

aonDialogClose.addEventListener("click", () => aonDialog.close());

// A placement, roster entry, or initiative-track entry can point at either
// a real character (from the main app's store) or a battle-local entity —
// a custom object or a monster, both tracked in battleState.customObjects
// (see the battle-helper-architecture skill's "Custom objects" section).
// This is the one place that knows how to resolve any of them by id, so
// the rest of the file can treat them uniformly wherever only a name is
// needed.
//
// `monsterName` is the bestiary entry this entity came from, which is NOT
// the same as `name`: renaming "Goblin Warrior 2" to "Sneaky Pete" has to
// keep pointing at the same statblock.
function findEntity(id) {
  const character = loadCharacters().find((c) => c.id === id);
  if (character) {
    return { id, name: character.name, build: character.data?.build ?? null, isCustom: false, monsterName: null };
  }
  const custom = battleState.customObjects[id];
  if (custom) {
    return { id, name: custom.name, build: null, isCustom: true, monsterName: custom.monster ?? null };
  }
  return null;
}

// A monster's stats, or null when this build of monsters.json carries none.
//
// Stats are baked into the file rather than fetched, because Archives of
// Nethys is unreachable from a browser on this origin: its elasticsearch
// backend allowlists exactly one Origin (2e.aonprd.com) and 403s everything
// else, and its HTML pages send no CORS header at all. A browser can't
// suppress the Origin header, so no amount of client-side caching would
// make a runtime fetch work. See local/scripts/build_monster_entities.py,
// which takes these out of the same response that already resolved the
// statblock link — the app makes zero requests to AoN for stats, however
// many battles are opened.
//
// Which is why null is the normal case on the deployed site and not a bug:
// only the stats-free index is committed and published, so GitHub Pages
// serves entries with no `stats` key. Local dev gets the full file from
// app.py. Callers already fall back to the minimal panel on null, so the
// difference needs no branch beyond this one.
function monsterStats(monsterName) {
  return monsterByName.get(monsterName)?.stats ?? null;
}

// Base stats — before conditions — in one shape whichever kind of entity
// they came from. A character's are computed from their Pathbuilder build
// with PF2e's proficiency math; a monster's are published as finished
// totals and need none of it. Normalising here is what lets a single stat
// panel, a single HP pool and a single condition pipeline serve both,
// instead of a monster branch beside every stat.
//
// Returns null for anything with no stats at all — a plain custom object,
// a monster AoN had nothing for, or a character whose sheet data is
// missing — which is the signal to fall back to the minimal panel.
//
// `speedText` is the monster's prose speed ("25 feet, fly 40 feet"): one
// number can't say a dragon flies, so the panel keeps it for the tooltip.
function entityStatBlock(entity) {
  const build = entity?.build;
  if (build) {
    const prof = build.proficiencies ?? {};
    const attrs = build.attributes ?? {};
    return {
      level: build.level ?? 1,
      maxHp: computeMaxHp(build),
      ac: Number(build.acTotal?.acTotal) || 0,
      fortitude: checkTotal(build, prof.fortitude ?? 0, "con"),
      reflex: checkTotal(build, prof.reflex ?? 0, "dex"),
      will: checkTotal(build, prof.will ?? 0, "wis"),
      perception: checkTotal(build, prof.perception ?? 0, "wis"),
      speed: (attrs.speed ?? 0) + (attrs.speedBonus ?? 0),
      speedText: null,
    };
  }

  const stats = monsterStats(entity?.monsterName);
  if (!stats) return null;
  // A monster missing one field (AoN's documents aren't uniformly
  // complete) shows a dash for that stat rather than a misleading 0, so
  // nulls are carried through rather than defaulted here. Max HP is the
  // exception: the HP bar has to divide by it, so a monster with no
  // published HP gets no HP bar at all.
  return {
    level: stats.level ?? 0,
    maxHp: stats.hp ?? null,
    ac: stats.ac ?? null,
    fortitude: stats.fortitude ?? null,
    reflex: stats.reflex ?? null,
    will: stats.will ?? null,
    perception: stats.perception ?? null,
    speed: stats.speed ?? null,
    speedText: stats.speedText ?? null,
  };
}

// The stat block for an entity id, looked up from scratch. Convenience for
// the several places that hold an id rather than an entity.
function statBlockFor(entityId) {
  const entity = findEntity(entityId);
  return entity ? entityStatBlock(entity) : null;
}

// Every name currently in play — characters from the store plus everything
// battle-local. Used to keep a newly added monster's name unique.
function existingEntityNames() {
  return new Set([
    ...loadCharacters().map((c) => c.name),
    ...Object.values(battleState.customObjects).map((o) => o.name),
  ]);
}

// "Goblin Warrior", then "Goblin Warrior 2", "Goblin Warrior 3"… The first
// one keeps the bare name — numbering only appears once there's an actual
// clash, so a lone monster doesn't read as one of a set. Checked against
// every name in the battle, not just other monsters, so a monster can't
// collide with a character or a custom object either.
function uniqueEntityName(base) {
  const taken = existingEntityNames();
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

function addMonster(monsterName) {
  const id = `custom-${crypto.randomUUID()}`;
  const name = uniqueEntityName(monsterName);
  dispatch("add-monster", `Added ${name} to the roster`, (state) => {
    state.customObjects[id] = { name, monster: monsterName };
  });
}

// Default token letters: one letter from each of the first two words, or
// the first two letters of the only word if there's just one — e.g.
// "Tumb Kamneshit" -> "TK", "Goblin" -> "GO", "" -> "?". Only used when
// the entity has no letters override (see getAppearance()).
function defaultInitials(name) {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// Merges a stored appearance override (battleState.appearance[id], any
// subset of these four fields) with computed defaults — mirrors
// currentHp()/currentTempHp()'s "default unless tracked" pattern. Colors
// default to the live theme's --accent/--accent-contrast (already hex,
// see style.css), so an uncustomized token keeps following light/dark
// mode; once a color is picked it's a literal, fixed hex value.
function getAppearance(entityId, name) {
  const stored = battleState.appearance[entityId] ?? {};
  return {
    shape: stored.shape ?? "circle",
    letters: stored.letters ?? defaultInitials(name),
    textColor: stored.textColor ?? cssVar("--accent-contrast"),
    shapeColor: stored.shapeColor ?? cssVar("--accent"),
  };
}

// Read through helpers rather than battleState.cols/rows directly, so a
// state that predates resizable grids (or a malformed one) still yields a
// usable size — the same "default unless tracked" pattern as currentHp().
function gridCols() {
  return clampDimension(battleState.cols);
}

function gridRows() {
  return clampDimension(battleState.rows);
}

// Square coordinates are ABSOLUTE and fixed to the board, not to the
// canvas: the square that starts life as (0, 0) keeps those numbers
// forever, so growing the map leftward or upward moves the ORIGIN
// negative rather than renumbering everything that was already placed.
// Coordinates below the origin are therefore negative, which is the point
// — a token's square doesn't change because the DM added room beside it.
//
// The grid covers rows originRow .. originRow + rows - 1 and columns
// originCol .. originCol + cols - 1.
function gridOriginRow() {
  return Number.isFinite(battleState.originRow) ? battleState.originRow : 0;
}

function gridOriginCol() {
  return Number.isFinite(battleState.originCol) ? battleState.originCol : 0;
}

// Absolute coordinate -> canvas pixel. Every bit of drawing goes through
// these two, so the origin offset can never be applied in one place and
// forgotten in another.
function pixelX(col) {
  return (col - gridOriginCol()) * SQUARE_SIZE;
}

function pixelY(row) {
  return (row - gridOriginRow()) * SQUARE_SIZE;
}

function inGridBounds(row, col) {
  const originRow = gridOriginRow();
  const originCol = gridOriginCol();
  return row >= originRow && row < originRow + gridRows()
    && col >= originCol && col < originCol + gridCols();
}

function squareKey(row, col) {
  return `${row},${col}`;
}

// Reverse of battleState.placements[squareKey] = entityId — used to select
// an entity's square from the initiative track. Placement is 1:1 (an
// entity occupies exactly one square), so the first match is the only one.
function squareKeyForEntity(entityId) {
  return Object.entries(battleState.placements).find(([, id]) => id === entityId)?.[0] ?? null;
}

// Terrain is a property of the ground, not of whoever is standing on it —
// so it's keyed by square and untouched by tokens arriving, leaving or
// being deleted. Only a grid shrink can clear it (see pruneTerrain).
function isDifficultTerrain(key) {
  return (battleState.terrain?.[key] ?? null) === TERRAIN_DIFFICULT;
}

function toggleDifficultTerrain(key) {
  const [row, col] = key.split(",").map(Number);
  const on = !isDifficultTerrain(key);
  dispatch(
    "set-terrain",
    `${on ? "Marked" : "Cleared"} difficult terrain at (${col}, ${row})`,
    (state) => {
      if (!state.terrain) state.terrain = {};
      if (on) state.terrain[key] = TERRAIN_DIFFICULT;
      else delete state.terrain[key];
    },
  );
}

// PF2e's actual diagonal-movement rule (see the pf2e-battle-grid skill):
// diagonal steps alternate 5/10 ft, not a flat 5 ft each — the first
// diagonal costs 5, the second 10, then it repeats. Straight (non-
// diagonal) steps are always a flat 5 ft. rowDelta/colDelta are in
// squares, not feet.
function pf2eDistanceFeet(rowDelta, colDelta) {
  const dx = Math.abs(colDelta);
  const dy = Math.abs(rowDelta);
  const diagonal = Math.min(dx, dy);
  const straight = Math.max(dx, dy) - diagonal;
  let feet = straight * 5;
  for (let i = 0; i < diagonal; i++) {
    feet += i % 2 === 0 ? 5 : 10;
  }
  return feet;
}

// ---------------------------------------------------------------------------
// Pathfinding: the shortest walkable route between two squares, respecting
// walls and PF2e's alternating diagonal cost.

// The eight steps a token can take, clockwise from N. The index matters:
// the opposite of direction i is (i + 4) % 8, which is how an arriving
// step becomes "which side did we enter this cell by".
const DIRECTIONS = [
  { dr: -1, dc: 0 },  // 0 N
  { dr: -1, dc: 1 },  // 1 NE
  { dr: 0, dc: 1 },   // 2 E
  { dr: 1, dc: 1 },   // 3 SE
  { dr: 1, dc: 0 },   // 4 S
  { dr: 1, dc: -1 },  // 5 SW
  { dr: 0, dc: -1 },  // 6 W
  { dr: -1, dc: -1 }, // 7 NW
];
const DIR_NONE = 8; // the starting square, entered from nowhere

// Bounds check in absolute coordinates. Pathfinding takes the origin as
// arguments rather than reading it, so the search is a pure function of
// the board it was handed.
function inGrid(row, col, originRow, originCol, rows, cols) {
  return row >= originRow && row < originRow + rows
    && col >= originCol && col < originCol + cols;
}

// The edge an orthogonal step crosses. Diagonal steps cross no single
// edge — they pass through a corner — so they're handled separately.
function edgeKeyBetween(row, col, dr, dc) {
  if (dr === -1 && dc === 0) return wallKey("h", row, col);
  if (dr === 1 && dc === 0) return wallKey("h", row + 1, col);
  if (dr === 0 && dc === -1) return wallKey("v", row, col);
  if (dr === 0 && dc === 1) return wallKey("v", row, col + 1);
  return null;
}

// Doors are openings, so only a full wall blocks. If a closed-door state
// is ever wanted, this is the one place that decides it.
function edgeBlocks(walls, row, col, dr, dc) {
  const key = edgeKeyBetween(row, col, dr, dc);
  return key ? walls[key] === EDGE_WALL : false;
}

// Which side of a cell's diagonal wall a direction lies on. 0 means "on
// the wall's own line" — its two end corners — which blocks nothing.
// "b" is "\" from the NW corner to the SE corner, separating N/NE/E from
// S/SW/W; "f" is "/" from NE to SW, separating N/NW/W from E/SE/S.
function diagonalSide(type, dir) {
  if (type === "b") {
    if (dir === 0 || dir === 1 || dir === 2) return 1;
    if (dir === 4 || dir === 5 || dir === 6) return 2;
    return 0;
  }
  if (dir === 0 || dir === 7 || dir === 6) return 1;
  if (dir === 2 || dir === 3 || dir === 4) return 2;
  return 0;
}

// A diagonal wall inside a cell blocks passing THROUGH it from one side to
// the other — entering from the north and leaving west, say. It never
// blocks merely entering or leaving, so it can't be a property of the cell
// alone: it needs the direction we arrived by, which is why that's carried
// in the search state.
function diagonalBlocksTransit(walls, row, col, entryDir, exitDir) {
  if (entryDir === DIR_NONE) return false;
  for (const type of ["b", "f"]) {
    if (walls[wallKey(type, row, col)] !== EDGE_WALL) continue;
    const from = diagonalSide(type, entryDir);
    const to = diagonalSide(type, exitDir);
    if (from !== 0 && to !== 0 && from !== to) return true;
  }
  return false;
}

// A diagonal step is allowed as long as at least one of the two
// right-angle routes around the corner is open. That's the lenient rule:
// a wall running alongside you doesn't stop you slipping past it
// diagonally — only a wall on both ways round does.
function diagonalStepOpen(walls, row, col, dr, dc, bounds) {
  const viaCol = !edgeBlocks(walls, row, col, 0, dc)
    && inGrid(row, col + dc, ...bounds)
    && !edgeBlocks(walls, row, col + dc, dr, 0);
  if (viaCol) return true;
  return !edgeBlocks(walls, row, col, dr, 0)
    && inGrid(row + dr, col, ...bounds)
    && !edgeBlocks(walls, row + dr, col, 0, dc);
}

// Shortest walkable route from one square to another, as
// [{ row, col, feet }] with feet cumulative from the start (0 on the first
// entry), or null if the target can't be reached.
//
// Dijkstra rather than plain BFS because steps aren't equal cost, and the
// state is (cell, diagonal parity, entry direction) rather than just the
// cell: PF2e's diagonals alternate 5/10 ft so the cost of the next one
// depends on how many the route has already spent, and a diagonal wall's
// blocking depends on which side the route entered by. Tokens don't block
// — you can move through allies in PF2e, and the drop target is checked
// separately.
function findPath(fromKey, toKey) {
  const rows = gridRows();
  const cols = gridCols();
  const originRow = gridOriginRow();
  const originCol = gridOriginCol();
  const bounds = [originRow, originCol, rows, cols];
  const walls = battleState.walls ?? {};
  const [fromRow, fromCol] = fromKey.split(",").map(Number);
  const [toRow, toCol] = toKey.split(",").map(Number);
  if (!inGrid(fromRow, fromCol, ...bounds) || !inGrid(toRow, toCol, ...bounds)) return null;
  if (fromRow === toRow && fromCol === toCol) return [{ row: fromRow, col: fromCol, feet: 0 }];

  // State ids are packed from ZERO-BASED indices; absolute coordinates can
  // be negative and would index outside the arrays.
  const stateId = (row, col, parity, entryDir) =>
    (((row - originRow) * cols + (col - originCol)) * 2 + parity) * 9 + entryDir;
  const dist = new Int32Array(rows * cols * 2 * 9).fill(-1);
  const prev = new Int32Array(dist.length).fill(-1);

  // Binary heap of [cost, stateId]; entries are never decreased in place,
  // stale ones are skipped on pop.
  const heap = [];
  const push = (cost, id) => {
    heap.push([cost, id]);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent][0] <= heap[i][0]) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < heap.length && heap[left][0] < heap[smallest][0]) smallest = left;
        if (right < heap.length && heap[right][0] < heap[smallest][0]) smallest = right;
        if (smallest === i) break;
        [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
        i = smallest;
      }
    }
    return top;
  };

  const start = stateId(fromRow, fromCol, 0, DIR_NONE);
  dist[start] = 0;
  push(0, start);

  let goal = -1;
  while (heap.length) {
    const [cost, id] = pop();
    if (cost > dist[id]) continue; // superseded by a cheaper route

    const entryDir = id % 9;
    const withoutDir = (id - entryDir) / 9;
    const parity = withoutDir % 2;
    const cell = (withoutDir - parity) / 2;
    const row = originRow + Math.floor(cell / cols);
    const col = originCol + (cell % cols);

    // Dijkstra pops in non-decreasing cost, so the first arrival is best.
    if (row === toRow && col === toCol) {
      goal = id;
      break;
    }

    for (let d = 0; d < 8; d++) {
      const { dr, dc } = DIRECTIONS[d];
      const nextRow = row + dr;
      const nextCol = col + dc;
      if (!inGrid(nextRow, nextCol, ...bounds)) continue;
      if (diagonalBlocksTransit(walls, row, col, entryDir, d)) continue;

      const diagonal = dr !== 0 && dc !== 0;
      if (diagonal) {
        if (!diagonalStepOpen(walls, row, col, dr, dc, bounds)) continue;
      } else if (edgeBlocks(walls, row, col, dr, dc)) {
        continue;
      }

      // Every other diagonal costs 10 ft — the same alternation
      // pf2eDistanceFeet() applies, tracked here as parity because the
      // route's shape decides it. Difficult terrain adds its 5 ft on top,
      // charged by the square being ENTERED (so the square you start on
      // never costs anything, and a diagonal into rough ground is 10 or
      // 15, not 5+5). Terrain doesn't change the parity — it's extra cost,
      // not an extra diagonal.
      const step = (diagonal ? (parity === 0 ? 5 : 10) : 5)
        + (isDifficultTerrain(squareKey(nextRow, nextCol)) ? DIFFICULT_TERRAIN_FEET : 0);
      const nextId = stateId(nextRow, nextCol, diagonal ? 1 - parity : parity, (d + 4) % 8);
      const nextCost = cost + step;
      if (dist[nextId] === -1 || nextCost < dist[nextId]) {
        dist[nextId] = nextCost;
        prev[nextId] = id;
        push(nextCost, nextId);
      }
    }
  }

  if (goal === -1) return null;

  const path = [];
  for (let id = goal; id !== -1; id = prev[id]) {
    const entryDir = id % 9;
    const withoutDir = (id - entryDir) / 9;
    const parity = withoutDir % 2;
    const cell = (withoutDir - parity) / 2;
    path.push({ row: originRow + Math.floor(cell / cols), col: originCol + (cell % cols), feet: dist[id] });
  }
  return path.reverse();
}

// The initiative track's order is manual (drag-and-drop), not derived from
// the initiative number — see the battle-helper-architecture skill. This
// reconciles battleState.initiativeOrder against battleState.placements at
// read time rather than writing a fixup back: drops any id no longer
// placed (should already be pruned by remove-token, but defensive) and
// appends any placed id missing from the order (covers battle state saved
// before this feature existed, and any other implicit-append edge case),
// without mutating state outside dispatch().
function initiativeOrderIds() {
  const order = battleState.initiativeOrder ?? [];
  const placedIds = Object.values(battleState.placements);
  const placedSet = new Set(placedIds);
  const missing = placedIds.filter((id) => !order.includes(id));
  return [...order.filter((id) => placedSet.has(id)), ...missing];
}

// Current HP defaults to max whenever it hasn't been tracked yet (a
// freshly placed character, or battle state persisted before HP tracking
// existed) — never stored redundantly, so it always reflects the
// character's current sheet if their build changes.
// maxHp is a required parameter rather than recomputed here because
// drained lowers it — see effectiveMaxHp(). The clamp is what makes a
// drained entity's HP drop on screen without touching the stored value, so
// it climbs back when drained ends.
function currentHp(characterId, maxHp) {
  const tracked = battleState.hp[characterId];
  return tracked == null ? maxHp : Math.min(tracked, maxHp);
}

function currentTempHp(characterId) {
  return battleState.tempHp[characterId] ?? 0;
}

// ---------------------------------------------------------------------------
// Event-driven state changes. Every function that mutates battleState goes
// through dispatch() — see the battle-helper-architecture skill. Selection
// (selectedSquareKey, armedEntityId) never does.

function dispatch(type, label, mutate) {
  const before = structuredClone(battleState);
  mutate(battleState);
  const after = structuredClone(battleState);

  eventLog = eventLog.slice(0, cursor + 1);
  eventLog.push({ type, label, before, after, at: Date.now() });
  cursor = eventLog.length - 1;

  persistBattleStore();
  render();
}

function undo() {
  if (cursor < 0) return;
  battleState = structuredClone(eventLog[cursor].before);
  cursor--;
  persistBattleStore();
  render();
}

function redo() {
  if (cursor >= eventLog.length - 1) return;
  cursor++;
  battleState = structuredClone(eventLog[cursor].after);
  persistBattleStore();
  render();
}

// ---------------------------------------------------------------------------
// Rendering

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Traces a token's outline into the current canvas path — caller fills it.
// One of the four appearance.shape values from getAppearance().
function traceTokenShape(shape, cx, cy, radius) {
  ctx.beginPath();
  switch (shape) {
    case "square": {
      const s = radius * 1.7;
      ctx.rect(cx - s / 2, cy - s / 2, s, s);
      break;
    }
    case "diamond":
      ctx.moveTo(cx, cy - radius);
      ctx.lineTo(cx + radius, cy);
      ctx.lineTo(cx, cy + radius);
      ctx.lineTo(cx - radius, cy);
      ctx.closePath();
      break;
    case "triangle": {
      const h = radius * 1.8;
      ctx.moveTo(cx, cy - h * 0.6);
      ctx.lineTo(cx + h * 0.58, cy + h * 0.4);
      ctx.lineTo(cx - h * 0.58, cy + h * 0.4);
      ctx.closePath();
      break;
    }
    case "circle":
    default:
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      break;
  }
}

function drawGrid() {
  const cols = gridCols();
  const rows = gridRows();
  const originRow = gridOriginRow();
  const originCol = gridOriginCol();
  const width = cols * SQUARE_SIZE;
  const height = rows * SQUARE_SIZE;

  // The bitmap is allocated at zoom x devicePixelRatio and the context
  // scaled to match, so everything below still draws in unscaled logical
  // pixels (0..width, 0..height) while the result stays crisp when zoomed
  // in — an upscaled 1x bitmap would just look blurry. The CSS size is what
  // the zoom controls actually change; the canvas is free to overflow its
  // viewport, which is what there is to pan around.
  const scale = zoom * (window.devicePixelRatio || 1);
  // The canvas is CANVAS_PAD larger than the grid on every side, and the
  // transform is translated by the same, so logical (0, 0) is the grid's
  // top-left corner while a boundary wall's overhang still has bitmap to
  // land on. Everything below draws in grid coordinates and needn't know.
  const canvasWidth = width + CANVAS_PAD * 2;
  const canvasHeight = height + CANVAS_PAD * 2;
  const bitmapWidth = Math.round(canvasWidth * scale);
  const bitmapHeight = Math.round(canvasHeight * scale);
  // Assigning canvas.width/height reallocates and clears the bitmap, so
  // only touch it on an actual change — drawGrid() also runs on every
  // mousemove while a token is being dragged.
  if (canvas.width !== bitmapWidth) canvas.width = bitmapWidth;
  if (canvas.height !== bitmapHeight) canvas.height = bitmapHeight;
  canvas.style.width = `${canvasWidth * zoom}px`;
  canvas.style.height = `${canvasHeight * zoom}px`;
  // Re-applied every draw, not just on resize: assigning canvas.width
  // resets the context, and the scale changes with zoom anyway.
  ctx.setTransform(scale, 0, 0, scale, CANVAS_PAD * scale, CANVAS_PAD * scale);
  // The pad is left transparent so the box's own background shows through
  // it; only the grid rectangle gets the surface fill below.
  ctx.clearRect(-CANVAS_PAD, -CANVAS_PAD, canvasWidth, canvasHeight);

  const surface = cssVar("--surface");
  const border = cssVar("--border");
  const accent = cssVar("--accent");
  const accentSoft = cssVar("--accent-soft");

  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, width, height);

  if (selectedSquareKey) {
    const [row, col] = selectedSquareKey.split(",").map(Number);
    ctx.fillStyle = accentSoft;
    ctx.fillRect(pixelX(col), pixelY(row), SQUARE_SIZE, SQUARE_SIZE);
  }

  // Terrain goes over the selection tint so a selected square still shows
  // what it's made of, but under the grid lines and everything after them —
  // it's the ground, and a wall or a token standing on it should read as
  // being on top.
  const terrain = battleState.terrain ?? {};
  const terrainKeys = Object.keys(terrain);
  if (terrainKeys.length) {
    ctx.fillStyle = cssVar("--text");
    ctx.globalAlpha = TERRAIN_ALPHA;
    for (const key of terrainKeys) {
      if (terrain[key] !== TERRAIN_DIFFICULT) continue;
      const [row, col] = key.split(",").map(Number);
      // Terrain outside the board can exist between a shrink and its
      // prune (and in battle state saved before pruning existed), so this
      // skips rather than trusting the map.
      if (!inGridBounds(row, col)) continue;
      traceDifficultTerrain(row, col);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // Every fifth line is drawn heavier, breaking the grid into 5x5 blocks so
  // a large map stays countable at a glance. The two outer lines are always
  // heavy as well, which frames the map — without that a grid whose size
  // isn't a multiple of five (7 wide, say) would get a heavy left border
  // and a hairline right one, which just reads as a mistake.
  //
  // The half-pixel offset puts a 1px stroke on a whole pixel instead of
  // straddling two and blurring; a 2px stroke is crisp centred on a whole
  // pixel instead, hence the offset depending on weight. The closing lines
  // need no clamping toward the middle — CANVAS_PAD gives them bitmap to
  // sit on, where before they fell outside 0..width and were clipped away
  // entirely, which is what made the right and bottom borders invisible.
  // Heaviness is keyed off the ABSOLUTE coordinate, not the line's index
  // from the edge, so the 5x5 blocks stay pinned to the board. Growing the
  // map leftward slides the heavy lines along with everything else and can
  // leave a partial block at the edge, which is correct: the blocks belong
  // to the board, not to the current viewport. (JS modulo keeps the sign of
  // the dividend, but only === 0 is tested here and -0 === 0, so negative
  // coordinates need no special handling.)
  ctx.strokeStyle = border;
  const gridLinePos = (index, coordinate, count) => {
    const major = coordinate % GRID_MAJOR_EVERY === 0 || index === 0 || index === count;
    return { lineWidth: major ? 2 : 1, pos: index * SQUARE_SIZE + (major ? 0 : 0.5) };
  };

  for (let col = 0; col <= cols; col++) {
    const { lineWidth, pos } = gridLinePos(col, originCol + col, cols);
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(pos, 0);
    ctx.lineTo(pos, height);
    ctx.stroke();
  }
  for (let row = 0; row <= rows; row++) {
    const { lineWidth, pos } = gridLinePos(row, originRow + row, rows);
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(0, pos);
    ctx.lineTo(width, pos);
    ctx.stroke();
  }
  ctx.lineWidth = 1;

  // Mid-drag feedback: dim the origin square, tint the hovered square
  // green (valid drop — empty) or red (invalid — occupied). Drawn under
  // the tokens so the dragged token still visibly sits at its origin
  // square throughout the drag; it only actually moves on drop.
  if (dragFromKey) {
    const [row, col] = dragFromKey.split(",").map(Number);
    ctx.fillStyle = border;
    ctx.globalAlpha = 0.5;
    ctx.fillRect(pixelX(col), pixelY(row), SQUARE_SIZE, SQUARE_SIZE);
    ctx.globalAlpha = 1;
  }
  if (dragHoverKey && dragHoverKey !== dragFromKey) {
    const [row, col] = dragHoverKey.split(",").map(Number);
    const valid = !battleState.placements[dragHoverKey];
    ctx.fillStyle = cssVar(valid ? "--success" : "--danger");
    ctx.globalAlpha = 0.3;
    ctx.fillRect(pixelX(col), pixelY(row), SQUARE_SIZE, SQUARE_SIZE);
    ctx.globalAlpha = 1;
  }

  // Walls, drawn over the grid lines but under the tokens — they're
  // terrain, and a token standing beside one shouldn't be painted over.
  // Outer-boundary walls are nudged half a thickness inward so they render
  // fully instead of having half the stroke fall outside the bitmap, the
  // same clipping problem the closing grid lines had.
  const walls = battleState.walls ?? {};
  const wallEntries = Object.entries(walls);
  // Recomputed from the stored cursor position rather than cached, so it
  // always reflects current state — see wallHoverPos.
  const hover = wallHoverPos && isEdgeTool() ? wallActionFromEvent(wallHoverPos) : null;

  if (wallEntries.length || hover) {
    // Any edge the preview is about to repaint is skipped here and drawn
    // only in the preview pass. Drawing it solid and tinting over it
    // cannot work: overlaying paint makes a stroke MORE prominent, never
    // less. Covers an edge being removed, and also one being CHANGED in
    // place (a wall becoming a door), which would otherwise leave the old
    // state at full opacity under a ghosted new one.
    const previewed = new Set();
    if (hover?.remove) previewed.add(hover.remove);
    if (hover?.add) previewed.add(hover.add);

    // Walls as they WOULD be after the hovered click. Door geometry depends
    // on the neighbouring cell's edge, so this is what lets an existing
    // door visibly slide over to meet the one being previewed beside it,
    // instead of the ghost magneting toward a neighbour that hasn't moved.
    const effective = { ...walls };
    if (hover?.remove) delete effective[hover.remove];
    if (hover?.add) effective[hover.add] = hover.state;

    for (const [key, state] of wallEntries) {
      if (previewed.has(key)) continue;
      drawEdgeShape(key, state, cssVar("--text"), effective);
    }

    if (hover) {
      // Outgoing first, incoming over it, so what you're about to get wins
      // where the two overlap.
      if (hover.remove) {
        // Turning a diagonal is a change, not a deletion — fade the old
        // direction so attention lands on the new one. A removal with
        // nothing replacing it really is a deletion, so that stays red.
        // Drawn against the CURRENT walls: it's showing what is there now,
        // about to go, not where it would sit afterwards.
        const turning = Boolean(hover.add);
        ctx.globalAlpha = turning ? 0.22 : 0.6;
        drawEdgeShape(hover.remove, walls[hover.remove], cssVar(turning ? "--muted" : "--danger"), walls);
      }
      if (hover.add) {
        ctx.globalAlpha = 0.55;
        drawEdgeShape(hover.add, hover.state, cssVar("--text"), effective);
      }
      ctx.globalAlpha = 1;
    }

    // Restored so the token loop below and the selection outline after it
    // don't inherit the wall/door stroke settings.
    ctx.lineCap = "butt";
    ctx.lineWidth = 1;
  }

  // The route a dragged token would take, drawn under the tokens so the
  // one being dragged still reads clearly at its origin square. Each step
  // is labelled with the distance spent getting there, so the DM can see
  // the cost of the move before committing to it.
  if (dragPath && dragPath.length > 1) {
    ctx.strokeStyle = cssVar("--accent");
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    dragPath.forEach((step, i) => {
      const x = pixelX(step.col) + SQUARE_SIZE / 2;
      const y = pixelY(step.row) + SQUARE_SIZE / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    // Reset immediately: the dash pattern is context state and would
    // otherwise leak into the token and selection strokes below.
    ctx.setLineDash([]);

    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = 1; i < dragPath.length; i++) {
      const step = dragPath[i];
      const x = pixelX(step.col) + SQUARE_SIZE / 2;
      const y = pixelY(step.row) + SQUARE_SIZE / 2;
      const text = `${step.feet}ft`;
      // Knocked out of the dashed line behind it, or the two overlap into
      // something unreadable at small zoom.
      const textWidth = ctx.measureText(text).width;
      ctx.fillStyle = cssVar("--surface");
      ctx.fillRect(x - textWidth / 2 - 2, y - 7, textWidth + 4, 14);
      ctx.fillStyle = cssVar("--danger");
      ctx.fillText(text, x, y);
    }
  }

  for (const [key, entityId] of Object.entries(battleState.placements)) {
    const entity = findEntity(entityId);
    if (!entity) continue;
    const [row, col] = key.split(",").map(Number);
    const cx = pixelX(col) + SQUARE_SIZE / 2;
    const cy = pixelY(row) + SQUARE_SIZE / 2;
    const radius = SQUARE_SIZE / 2 - 4;
    const appearance = getAppearance(entityId, entity.name);

    ctx.fillStyle = appearance.shapeColor;
    traceTokenShape(appearance.shape, cx, cy, radius);
    ctx.fill();

    ctx.fillStyle = appearance.textColor;
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(appearance.letters, cx, cy);
  }

  if (selectedSquareKey) {
    const [row, col] = selectedSquareKey.split(",").map(Number);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(pixelX(col) + 1, pixelY(row) + 1, SQUARE_SIZE - 2, SQUARE_SIZE - 2);
  }
}

function renderRoster() {
  const placedIds = new Set(Object.values(battleState.placements));
  // Only characters actually added to this battle, not everyone in the
  // store — a DM running one encounter shouldn't have to scroll past three
  // other parties. See battleCharacterIds() and the character picker.
  const byId = new Map(loadCharacters().map((c) => [c.id, c]));
  const characters = battleCharacterIds().map((id) => ({ id, name: byId.get(id).name, isCustom: false, monsterName: null }));
  const customs = Object.entries(battleState.customObjects).map(([id, obj]) => ({ id, name: obj.name, isCustom: true, monsterName: obj.monster ?? null }));
  const unplaced = [...characters, ...customs].filter((e) => !placedIds.has(e.id));

  rosterList.innerHTML = unplaced.length
    ? unplaced.map((e) => `
        <li draggable="true" class="battle-roster-item${e.id === armedEntityId ? " armed" : ""}${e.id === clipboardSourceId ? " copied" : ""}" data-entity-id="${escapeHtml(e.id)}">
          <span class="battle-roster-item-name">${escapeHtml(e.name)}</span>
          ${e.monsterName ? `<button type="button" class="battle-roster-stats" draggable="false" data-monster="${escapeHtml(e.monsterName)}" title="${escapeHtml(e.monsterName)} statblock" aria-label="${escapeHtml(e.monsterName)} statblock">&#9744;</button>` : ""}
          <button type="button" class="battle-remove-btn battle-roster-delete" draggable="false" data-entity-id="${escapeHtml(e.id)}" title="${e.isCustom ? `Delete ${escapeHtml(e.name)}` : `Take ${escapeHtml(e.name)} out of this battle`}" aria-label="${e.isCustom ? `Delete ${escapeHtml(e.name)}` : `Take ${escapeHtml(e.name)} out of this battle`}">&times;</button>
        </li>
      `).join("")
    : '<li class="placeholder">Nobody here yet — add characters, a monster, or a custom object below.</li>';

  // Same stopPropagation() reasoning as the delete button below: this sits
  // inside the <li> whose own click arms the entity for placement, and
  // checking a statblock shouldn't also arm it.
  for (const btn of rosterList.querySelectorAll(".battle-roster-stats")) {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      openAonPopup(monsterUrl(btn.dataset.monster), btn.dataset.monster);
    });
  }

  // Scoped to li[data-entity-id], not the bare attribute selector — the
  // delete button carries data-entity-id too (for its own handler below)
  // and would otherwise pick up the row's arm/drag behaviour.
  for (const li of rosterList.querySelectorAll("li[data-entity-id]")) {
    li.addEventListener("click", () => {
      const id = li.dataset.entityId;
      armedEntityId = armedEntityId === id ? null : id;
      render();
    });

    // Dragging a row onto a square is the second way to place an entity,
    // alongside arm-then-click. Native HTML5 DnD, like the initiative
    // track's reordering and unlike the map's own token drag — the thing
    // being dragged here IS an element, so there's nothing to hand-roll.
    li.addEventListener("dragstart", (event) => {
      rosterDragId = li.dataset.entityId;
      // An entity armed by an earlier click would otherwise still be
      // waiting to drop on the next map click, long after this drag placed
      // a different one somewhere else.
      armedEntityId = null;
      li.classList.add("dragging");
      event.dataTransfer.effectAllowed = "copy";
      // Firefox refuses to start a drag with nothing on the transfer. The
      // payload is the NAME, not the id, so a stray drop into some other
      // text field pastes something a person would recognise; the drop
      // handler on the canvas reads rosterDragId and ignores this.
      event.dataTransfer.setData("text/plain", findEntity(rosterDragId)?.name ?? "");
      // Deliberately no render() here, despite armedEntityId having just
      // changed: render() rebuilds the roster, and destroying the element
      // the drag started from cancels the drag outright. The stale armed
      // styling lasts until the drag ends, which is a moment away.
    });
    li.addEventListener("dragend", () => {
      // A backstop for drags that end anywhere but the map (cancelled, or
      // released off-target). A successful drop can't rely on this: it
      // re-renders the roster, and this row — now placed — is gone from it
      // before dragend would have fired.
      li.classList.remove("dragging");
      endRosterDrag();
    });
  }

  // Every row gets an ×, but it means two different things — which is why
  // the title spells out which. For a battle-local entity it DELETES the
  // thing (it exists nowhere else). For a character it only takes them out
  // of this battle; the sheet on the main page is untouched, and they can
  // be added back from the picker. stopPropagation() keeps either from
  // also triggering the <li>'s own click handler (arming for placement).
  for (const btn of rosterList.querySelectorAll(".battle-roster-delete")) {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const id = btn.dataset.entityId;
      const entity = findEntity(id);
      if (!entity) return;
      if (entity.isCustom) {
        dispatch("delete-custom-object", `Deleted ${entity.name}`, (state) => {
          delete state.customObjects[id];
          delete state.initiative[id];
          delete state.appearance[id];
          delete state.conditions[id];
          delete state.spellSlots[id];
          delete state.inventory[id];
        });
      } else {
        removeCharacterFromBattle(id, entity.name);
      }
      if (armedEntityId === id) armedEntityId = null;
      if (clipboardSourceId === id) clipboard = null;
    });
  }
}

// Puts a roster entity on an empty square. Shared by the arm-then-click
// path and the drag-and-drop one so the two can't drift into placing
// subtly different things — HP seeding and the initiative-track insert are
// easy to remember in one place and forget in the other. Returns whether
// it happened; an occupied square is a no-op, not a swap.
function placeEntity(entityId, key) {
  if (battleState.placements[key]) return false;
  const entity = findEntity(entityId);
  if (!entity) return false;
  const stats = entityStatBlock(entity);
  dispatch("place-token", `Placed ${entity.name} on the field`, (state) => {
    state.placements[key] = entityId;
    // Characters get their computed max, monsters their published one, and
    // a plain custom object none at all — it's name-only by design, per
    // the battle-helper-architecture skill.
    if (stats?.maxHp != null) state.hp[entityId] = stats.maxHp;
    else delete state.hp[entityId];
    delete state.tempHp[entityId];
    delete state.conditions[entityId];
    delete state.spellSlots[entityId];
    state.initiativeOrder.push(entityId);
  });
  return true;
}

// Clears whatever a roster drag left behind. Called from dragend and from
// a drop that placed nothing; a drop that DID place goes through dispatch()
// instead, having cleared these first so its render sees them gone.
function endRosterDrag() {
  if (!rosterDragId && dragHoverKey === null) return;
  rosterDragId = null;
  dragHoverKey = null;
  render();
}

function addCharacterToBattle(characterId, name) {
  dispatch("add-character", `Added ${name} to the battle`, (state) => {
    if (!state.characterIds.includes(characterId)) state.characterIds.push(characterId);
  });
}

// Only removes them from this battle's roster. Their sheet lives in the
// main app's store, which this page never writes to. Battle progress keyed
// to them goes with it, the same way remove-token clears it — they're
// leaving the encounter, not stepping off the field for a moment.
function removeCharacterFromBattle(characterId, name) {
  dispatch("remove-character", `Took ${name} out of the battle`, (state) => {
    state.characterIds = state.characterIds.filter((id) => id !== characterId);
    for (const [key, id] of Object.entries(state.placements)) {
      if (id === characterId) delete state.placements[key];
    }
    state.initiativeOrder = state.initiativeOrder.filter((id) => id !== characterId);
    delete state.hp[characterId];
    delete state.tempHp[characterId];
    delete state.conditions[characterId];
    delete state.spellSlots[characterId];
    delete state.inventory[characterId];
    delete state.initiative[characterId];
  });
  raisedShieldIds.delete(characterId);
}

let dragEntityId = null; // entity id currently being dragged in the initiative track — UI-only, not battle state

// Delegated to the <ul> and attached once, for exactly the reason the
// battle tabs' rename is: renderInitiative() replaces every <li> on each
// render, and a row's own click handler re-renders (it selects the
// entity's square). So on a double-click the two clicks land on different
// nodes and the browser dispatches dblclick on their nearest common
// ancestor — this <ul> — never on the row itself.
initiativeList.addEventListener("dblclick", (event) => {
  if (event.target.closest(".battle-initiative-value")) return;
  const row = event.target.closest("li[data-entity-id]");
  if (row) openEntityRenameDialog(row.dataset.entityId);
});

function renderInitiative() {
  const placed = initiativeOrderIds()
    .map((id) => findEntity(id))
    .filter(Boolean);

  if (!placed.length) {
    initiativeList.innerHTML = '<li class="placeholder">No one on the field yet.</li>';
    return;
  }

  // Selection is shared both ways with the map: a square selected on the
  // grid highlights its entity's row here (this lookup), and clicking a
  // row below selects that entity's square on the grid.
  const selectedEntityId = selectedSquareKey ? battleState.placements[selectedSquareKey] : null;

  initiativeList.innerHTML = placed.map((e) => {
    const initiative = battleState.initiative[e.id];
    // Only battle-local entities can be renamed here — a character's name
    // comes from their sheet. The title says which, so a double-click that
    // does nothing on a character row isn't a mystery.
    const nameTitle = e.isCustom
      ? "Double-click to rename"
      : "Renaming a character is done on their sheet, on the main page";
    return `
      <li draggable="true" data-entity-id="${escapeHtml(e.id)}" class="${e.id === selectedEntityId ? "selected" : ""}">
        <span class="battle-initiative-name" title="${escapeHtml(nameTitle)}">${escapeHtml(e.name)}</span>
        <button type="button" class="battle-initiative-value" draggable="false" data-entity-id="${escapeHtml(e.id)}" title="Set initiative">${initiative != null ? initiative : "—"}</button>
      </li>
    `;
  }).join("");

  for (const btn of initiativeList.querySelectorAll(".battle-initiative-value")) {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const entity = findEntity(btn.dataset.entityId);
      if (entity) openInitiativeDialog(entity.id, entity.name);
    });
  }

  // Native HTML5 drag-and-drop reorders battleState.initiativeOrder. This
  // is a real battle-state change (Rule 1), so it goes through dispatch()
  // like everything else — dragging is undoable the same as any other
  // action, not a UI-only convenience. Scoped to "li[data-entity-id]", not
  // the bare attribute selector — the value button also carries
  // data-entity-id (for its own click handler above), and would otherwise
  // wrongly get drag handlers meant for the row.
  for (const li of initiativeList.querySelectorAll("li[data-entity-id]")) {
    // Selecting a square (empty or occupied) to inspect it is UI-only —
    // not an event, per the battle-helper-architecture skill — same as
    // clicking the square itself on the grid. The value button above
    // already stopPropagation()s so this doesn't also fire on that click.
    li.addEventListener("click", () => {
      const key = squareKeyForEntity(li.dataset.entityId);
      if (key) {
        selectedSquareKey = key;
        render();
      }
    });
    li.addEventListener("dragstart", () => {
      dragEntityId = li.dataset.entityId;
      li.classList.add("dragging");
    });
    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      dragEntityId = null;
    });
    li.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (li.dataset.entityId !== dragEntityId) li.classList.add("drag-over");
    });
    li.addEventListener("dragleave", () => {
      li.classList.remove("drag-over");
    });
    li.addEventListener("drop", (event) => {
      event.preventDefault();
      li.classList.remove("drag-over");
      const targetId = li.dataset.entityId;
      const draggedId = dragEntityId;
      if (!draggedId || draggedId === targetId) return;
      const draggedEntity = findEntity(draggedId);
      dispatch("reorder-initiative", `Moved ${draggedEntity?.name ?? "entity"} in the initiative track`, (state) => {
        const order = initiativeOrderIds();
        const from = order.indexOf(draggedId);
        const to = order.indexOf(targetId);
        if (from === -1 || to === -1) return;
        order.splice(from, 1);
        order.splice(to, 0, draggedId);
        state.initiativeOrder = order;
      });
    });
  }
}

// Shared by both renderCharacterTab() branches below (full character panel,
// name-only custom-object panel) so "remove from field" behaves
// identically either way — same event type, same state cleanup. The id it
// binds, battle-remove-token, is correctly named: it takes the occupant's
// token off the map, leaving them in the roster.
// Both this button and the Delete key remove the selected square's
// occupant, so both go through deleteSelectedToken() — one event type, one
// piece of state cleanup, no chance of the two drifting apart.
function bindRemoveButton() {
  document.getElementById("battle-remove-token").addEventListener("click", deleteSelectedToken);
}

// The bottom-left box is about the object standing on the selected square,
// from two angles: the character it is (stats, HP, conditions) and the
// token it's drawn as on the map. Which tab is showing is UI-only, like
// selection and zoom — it changes what you're looking at, not the battle,
// so it never dispatches.
//
// The two really are different things, which is why they're tabs and not
// one long panel: a token's shape and letters say nothing about the
// creature's Fortitude save, and vice versa.
//
// Sticky across selections rather than resetting per square, so working
// through several characters in a row keeps whichever view you chose.
// Defaults to the character tab, which is what this box showed before it
// had tabs.
const OBJECT_TAB_CHARACTER = "character";
const OBJECT_TAB_TOKEN = "token";
const OBJECT_TAB_SQUARE = "square";
let selectedObjectTab = OBJECT_TAB_CHARACTER;

// Everything the selected square can tell you, in one box: who's standing
// there (stats and conditions), the token drawn for them, and the ground
// itself. Square joined these two when the bottom-right box was given over
// to abilities — it's a third view of the same selection, so it belongs
// with them rather than in a box of its own.
const OBJECT_TABS = [
  { id: OBJECT_TAB_CHARACTER, label: "Character" },
  { id: OBJECT_TAB_TOKEN, label: "Token" },
  { id: OBJECT_TAB_SQUARE, label: "Square" },
];

function renderObjectPanel() {
  if (!selectedSquareKey) {
    objectPanel.innerHTML = '<p class="placeholder">Click a square to select it.</p>';
    return;
  }

  objectPanel.innerHTML = `
    <div class="battle-object-tabs" role="tablist">
      ${OBJECT_TABS.map(({ id, label }) => `
        <button type="button" class="battle-object-tab${selectedObjectTab === id ? " active" : ""}" data-object-tab="${id}" role="tab" aria-selected="${selectedObjectTab === id}">${label}</button>`).join("")}
    </div>
    <div id="battle-object-body" class="battle-object-body"></div>
  `;

  for (const btn of objectPanel.querySelectorAll(".battle-object-tab")) {
    btn.addEventListener("click", () => {
      if (selectedObjectTab === btn.dataset.objectTab) return;
      selectedObjectTab = btn.dataset.objectTab;
      render();
    });
  }

  const body = document.getElementById("battle-object-body");
  if (selectedObjectTab === OBJECT_TAB_TOKEN) renderTokenTab(body);
  else if (selectedObjectTab === OBJECT_TAB_SQUARE) renderSquareTab(body);
  else renderCharacterTab(body);
}

// The ground itself, independent of who's on it. Terrain is keyed by
// square, so unlike the other two tabs there's no "empty square" case —
// an empty square is still a square, and still has terrain.
function renderSquareTab(objectBody) {
  const key = selectedSquareKey;
  const [row, col] = key.split(",").map(Number);
  const difficult = isDifficultTerrain(key);

  objectBody.innerHTML = `
    <h3 class="battle-square-heading">Square (${col}, ${row})</h3>
    <div class="battle-square-info">
      <label class="battle-square-toggle">
        <input type="checkbox" id="battle-square-difficult"${difficult ? " checked" : ""} />
        <span class="battle-square-toggle-text">
          <span class="battle-square-toggle-name">Difficult terrain</span>
          <span class="battle-square-toggle-hint">Entering this square costs ${DIFFICULT_TERRAIN_FEET} extra feet.</span>
        </span>
      </label>
    </div>
  `;

  // Reads the key captured above, not selectedSquareKey at click time —
  // they're the same today, but the panel is rebuilt on every render() and
  // this makes the handler's target unambiguous.
  document.getElementById("battle-square-difficult").addEventListener("change", () => {
    toggleDifficultTerrain(key);
  });
}

// A character's spells, in the same shape static/app.js reads them from a
// Pathbuilder build — one entry per caster, each with the levels that
// actually hold spells. Returns null for anything with no spells at all,
// which is what hides the Spells tab.
//
// Monsters never reach here: the build script parses strikes and special
// abilities out of a statblock but not spell lists, so a monster's spells
// aren't in the data at all. entity.build is the gate.
//
// `perDay` is indexed by spell level, so perDay[3] is how many level-3
// slots per day. Cantrips (level 0) are unlimited and deliberately get no
// slot row — a cantrip you can cast all day has nothing to count down.
function entitySpells(entity) {
  const build = entity?.build;
  if (!build) return null;

  const casters = (build.spellCasters ?? []).map((caster, index) => ({
    // The index, not the name, keys the slots: two casters can share a
    // name, and renaming one in Pathbuilder shouldn't silently hand its
    // spent slots to the other.
    key: String(index),
    name: caster.name || "Spells",
    meta: [caster.magicTradition, caster.spellcastingType].filter(Boolean).join(" · "),
    levels: (caster.spells ?? [])
      .filter((entry) => entry.list?.length)
      .map((entry) => ({
        level: entry.spellLevel,
        spells: entry.list,
        slots: entry.spellLevel > 0 ? (caster.perDay?.[entry.spellLevel] ?? 0) : 0,
      })),
  })).filter((caster) => caster.levels.length);

  // Focus spells are one shared pool of Focus Points rather than per-level
  // slots, so they collapse to a single row however many traditions grant
  // them — which is also how the character sheet presents them.
  const focusSpells = [];
  for (const byAbility of Object.values(build.focus ?? {})) {
    for (const data of Object.values(byAbility)) {
      focusSpells.push(...(data.focusCantrips ?? []), ...(data.focusSpells ?? []));
    }
  }
  if (focusSpells.length) {
    casters.push({
      key: "focus",
      name: "Focus Spells",
      meta: "",
      levels: [{ level: "focus", spells: focusSpells, slots: build.focusPoints ?? 0 }],
    });
  }

  return casters.length ? casters : null;
}

// Spent slots are battle progress, so they live in battleState and move
// through dispatch() like HP — one Ctrl+Z puts a slot back. Stored as
// entityId -> "casterKey:level" -> [bool], true meaning spent.
//
// Read with a clamp rather than being written back into shape: a character
// who levels up gains slots, and reconciling on read is the same
// "don't write outside dispatch()" pattern initiativeOrderIds() uses.
function spellSlotKey(casterKey, level) {
  return `${casterKey}:${level}`;
}

function spellSlotsSpent(entityId, casterKey, level, count) {
  const spent = battleState.spellSlots?.[entityId]?.[spellSlotKey(casterKey, level)] ?? [];
  return Array.from({ length: count }, (_, i) => spent[i] === true);
}

function toggleSpellSlot(entityId, entityName, casterKey, level, index, levelLabel) {
  const key = spellSlotKey(casterKey, level);
  const wasSpent = battleState.spellSlots?.[entityId]?.[key]?.[index] === true;
  dispatch(
    "toggle-spell-slot",
    `${entityName} ${wasSpent ? "regained" : "spent"} a ${levelLabel} slot`,
    (state) => {
      const forEntity = (state.spellSlots[entityId] ??= {});
      const slots = (forEntity[key] ??= []);
      slots[index] = !wasSpent;
    },
  );
}

// Deleting the entity's whole record IS the refresh: an absent record reads
// as every slot unspent, so there's nothing to rebuild from the character's
// current slot counts — which also means a refresh can't bake in a stale
// count from before they levelled.
function refreshSpellSlots(entityId, entityName) {
  dispatch("refresh-spell-slots", `${entityName} regained all spell slots`, (state) => {
    delete state.spellSlots[entityId];
  });
}

// What a character is carrying: loose gear, weapons, armor and coin. Null
// — which hides the tab — when they carry nothing at all, and always for a
// monster, whose statblock has no equipment list to parse.
//
// Weapons and armor are here as well as being felt elsewhere (a weapon is
// a strike on the Actions tab, armor is folded into AC) because those show
// what the item DOES; this tab answers "what is on them", which is a
// different question and the one that comes up when someone is disarmed,
// looted, or handing something over.
//
// Pathbuilder writes loose gear as [name, qty, note] triples rather than
// objects — the same shape the main app's inventoryTable() destructures.
// Anything that isn't a populated triple is skipped rather than rendered as
// a blank row.
// A monster carries whatever the DM has given it, so battle-local items and
// coin sit alongside a character's sheet gear rather than replacing it.
// Everything placed has an inventory, including a plain custom object — a
// chest with loot in it is the same idea as a monster with loot on it.
function entityInventory(entity) {
  if (!entity) return null;
  const build = entity.build;

  const gear = (build?.equipment ?? [])
    .filter((row) => Array.isArray(row) && row[0])
    .map(([name, qty, note]) => ({ name, qty: qty ?? 1, note: note ?? "" }));
  const weapons = (build?.weapons ?? [])
    .filter((w) => w?.name)
    .map((w) => ({ name: w.name, display: w.display || w.name, qty: w.qty ?? 1, note: "" }));
  const armor = (build?.armor ?? [])
    .filter((a) => a?.name)
    .map((a) => ({ name: a.name, display: a.display || a.name, qty: a.qty ?? 1, note: a.worn ? "worn" : "" }));

  // Items the DM added in this battle. Removable, unlike the sheet's own
  // gear, which belongs to the character sheet this page never writes to.
  const carried = (battleState.inventory?.[entity.id]?.items ?? [])
    .filter((item) => item?.name)
    .map((item) => ({ name: item.name, qty: item.qty ?? 1, note: "" }));

  return { gear, weapons, armor, carried, coins: entityMoney(entity) };
}

// Always all four denominations, zeros included: a coin row that hid empty
// denominations made "no silver" and "silver not tracked" look identical,
// and left the row changing width as money was spent.
//
// Battle-local coin REPLACES the sheet's once the DM has set any — someone
// who spent their gold this fight shouldn't keep showing the sheet's total
// — and a monster, having no sheet, simply starts from zero.
function entityMoney(entity) {
  const local = battleState.inventory?.[entity?.id]?.money;
  const base = entity?.build?.money ?? {};
  return COIN_ORDER.map(({ key, label, color }) => ({
    key,
    label,
    color,
    amount: Math.max(0, Math.trunc(Number(local?.[key] ?? base[key] ?? 0)) || 0),
  }));
}

// Adding the same item twice stacks it rather than growing a second chip,
// which is what a DM handing out three potions one at a time expects.
function addInventoryItem(entityId, entityName, name, qty) {
  dispatch("add-item", `Gave ${entityName} ${qty > 1 ? `${qty} × ` : ""}${name}`, (state) => {
    const entry = (state.inventory[entityId] ??= {});
    const items = (entry.items ??= []);
    const existing = items.find((item) => item.name === name);
    if (existing) existing.qty = (existing.qty ?? 1) + qty;
    else items.push({ name, qty });
  });
}

function removeInventoryItem(entityId, entityName, name) {
  dispatch("remove-item", `Took ${name} from ${entityName}`, (state) => {
    const entry = state.inventory[entityId];
    if (!entry?.items) return;
    entry.items = entry.items.filter((item) => item.name !== name);
  });
}

function setInventoryMoney(entityId, entityName, money) {
  const summary = COIN_ORDER.filter(({ key }) => money[key] > 0)
    .map(({ key, label }) => `${money[key]} ${label}`).join(", ");
  dispatch("set-money", `Set ${entityName}'s coin to ${summary || "nothing"}`, (state) => {
    const entry = (state.inventory[entityId] ??= {});
    entry.money = money;
  });
}

// Highest denomination first, matching the main app's coin row. The colours
// are the metals themselves, which is why they're literals rather than
// theme tokens — silver is silver in either theme.
const COIN_ORDER = [
  { key: "pp", label: "pp", color: "#e5e4e2" },
  { key: "gp", label: "gp", color: "#d4af37" },
  { key: "sp", label: "sp", color: "#c0c0c0" },
  { key: "cp", label: "cp", color: "#cd7f32" },
];

// Bottom-right box: what the selected creature can DO, as opposed to what
// it is. Four tabs, split the way a DM reaches for them: Actions is the
// in-combat page (strikes, then special abilities), Spells is the other
// in-combat one, Proficiencies is the out-of-combat page (attribute
// modifiers and skills), and Inventory is what they're carrying. Spells and
// Inventory each appear only when there's something to show.
//
// TODO, deliberately left for now: Recall Knowledge DCs.
const ABILITY_TAB_ACTIONS = "actions";
const ABILITY_TAB_SPELLS = "spells";
const ABILITY_TAB_PROFICIENCIES = "proficiencies";
const ABILITY_TAB_INVENTORY = "inventory";
let selectedAbilityTab = ABILITY_TAB_ACTIONS;

// Built per entity, because every tab here is conditional now. Actions and
// Proficiencies both read the parsed abilities, so they go together and are
// absent for a creature that has none. Order is fixed, so a tab never
// changes position as the selection moves — only appears or disappears.
function abilityTabsFor(abilities, spells, inventory) {
  return [
    ...(abilities ? [{ id: ABILITY_TAB_ACTIONS, label: "Actions" }] : []),
    ...(spells ? [{ id: ABILITY_TAB_SPELLS, label: "Spells" }] : []),
    ...(abilities ? [{ id: ABILITY_TAB_PROFICIENCIES, label: "Proficiencies" }] : []),
    ...(inventory ? [{ id: ABILITY_TAB_INVENTORY, label: "Inventory" }] : []),
  ];
}

function renderAbilitiesPanel() {
  if (!selectedSquareKey) {
    abilitiesPanel.innerHTML = '<p class="placeholder">Click a square to select it.</p>';
    return;
  }
  const entityId = battleState.placements[selectedSquareKey];
  const entity = entityId ? findEntity(entityId) : null;
  if (!entity) {
    abilitiesPanel.innerHTML = '<p class="placeholder">Empty square.</p>';
    return;
  }

  const abilities = entityAbilities(entity);
  if (abilities === "loading") {
    abilitiesPanel.innerHTML = '<p class="placeholder">Loading&hellip;</p>';
    return;
  }
  // No early return for missing abilities any more: a creature with none
  // still has an Inventory tab, and bailing here would make loot
  // unreachable for exactly the cases that need it most — a plain custom
  // object (a chest), and every monster on the deployed site, where the
  // abilities file isn't published.
  const spells = entitySpells(entity);
  const inventory = entityInventory(entity);
  const tabs = abilityTabsFor(abilities, spells, inventory);
  if (!tabs.length) {
    abilitiesPanel.innerHTML = '<p class="placeholder">Nothing to show for this creature.</p>';
    return;
  }
  // Stepping from a caster to a fighter with Spells showing would otherwise
  // leave a tab selected that isn't in the strip — no tab looks active and
  // the body falls through to whatever the last branch is. Falls back to the
  // first tab that IS present rather than to Actions, which a creature with
  // no parsed abilities doesn't have.
  const activeTab = tabs.some((t) => t.id === selectedAbilityTab)
    ? selectedAbilityTab
    : tabs[0].id;

  // Same tab markup and classes as the bottom-left box, so the two boxes
  // read as one pattern rather than two inventions. The corner control is
  // pushed to the far right of the same strip, so it sits in the panel's
  // top-right corner without costing a row of its own in a 220px box; being
  // last with margin-left:auto means it moves none of the tabs. Which
  // control it is depends on the tab — refresh slots on Spells, edit
  // contents on Inventory — and there is none on the read-only tabs.
  const cornerControl = {
    [ABILITY_TAB_SPELLS]: `<button type="button" id="battle-refresh-spells" class="battle-panel-corner-btn" title="Refresh all spell slots (daily preparations)" aria-label="Refresh all spell slots">${REFRESH_ICON}</button>`,
    [ABILITY_TAB_INVENTORY]: `<button type="button" id="battle-edit-inventory" class="battle-panel-corner-btn" title="Add an item or set coin" aria-label="Add an item or set coin">${PLUS_ICON}</button>`,
  }[activeTab] ?? "";

  abilitiesPanel.innerHTML = `
    <div class="battle-object-tabs" role="tablist">
      ${tabs.map(({ id, label }) => `
        <button type="button" class="battle-object-tab${activeTab === id ? " active" : ""}" data-ability-tab="${id}" role="tab" aria-selected="${activeTab === id}">${label}</button>`).join("")}
      ${cornerControl}
    </div>
    <div id="battle-ability-body" class="battle-object-body"></div>
  `;

  for (const btn of abilitiesPanel.querySelectorAll(".battle-object-tab")) {
    btn.addEventListener("click", () => {
      if (selectedAbilityTab === btn.dataset.abilityTab) return;
      selectedAbilityTab = btn.dataset.abilityTab;
      render();
    });
  }

  const body = document.getElementById("battle-ability-body");
  if (activeTab === ABILITY_TAB_PROFICIENCIES) renderProficienciesTab(body, abilities);
  else if (activeTab === ABILITY_TAB_SPELLS) renderSpellsTab(body, entity, spells);
  else if (activeTab === ABILITY_TAB_INVENTORY) renderInventoryTab(body, entity, inventory);
  else renderActionsTab(body, abilities);

  if (activeTab === ABILITY_TAB_SPELLS) {
    document.getElementById("battle-refresh-spells").addEventListener("click", () => {
      refreshSpellSlots(entityId, entity.name);
    });
  }
  if (activeTab === ABILITY_TAB_INVENTORY) {
    document.getElementById("battle-edit-inventory").addEventListener("click", () => {
      openInventoryDialog(entityId, entity.name);
    });
  }
}

// Matches REFRESH_ICON's conventions — 100-unit viewBox, currentColor,
// em-sized. A plain cross rather than a glyph, so it lines up with the
// refresh icon that occupies the same corner on the Spells tab.
const PLUS_ICON =
  '<svg class="refresh-icon" viewBox="0 0 100 100" role="img" aria-hidden="true">'
  + '<path d="M42 10H58V42H90V58H58V90H42V58H10V42H42Z"/></svg>';

// Circular arrow. Same conventions as the action and speed icons: a
// 100-unit viewBox, currentColor, em-sized. The arrowhead is deliberately
// oversized against the ring — at the ~16px this renders at, a
// proportionate one disappears and the icon reads as a plain circle.
const REFRESH_ICON =
  '<svg class="refresh-icon" viewBox="0 0 100 100" role="img" aria-hidden="true">'
  + '<path d="M64 30A29 29 0 1 1 36 26" fill="none" stroke="currentColor" stroke-width="15"/>'
  + '<path d="M62 6L60 46L26 22Z"/></svg>';

// One row per spell level: the level's name, its slot pips, then the spells
// themselves. Clicking a pip spends or regains that slot.
//
// Slots are per caster AND per level, so a sorcerer/wizard multiclass burns
// each independently — hence the caster key in every slot id.
function renderSpellsTab(body, entity, spells) {
  const entityId = entity.id;
  loadSpellIds();
  const casterBlocks = spells.map((caster) => {
    const rows = caster.levels.map(({ level, spells: list, slots }) => {
      // Bare number in the column, spelled out in the tooltips: the column
      // is a list of levels and repeating the word in every row was what
      // made it wide. Cantrips and Focus keep their names — they aren't
      // numbered, so there's nothing to read them as.
      const label = level === "focus" ? "Focus" : level === 0 ? "Cantrips" : String(level);
      const longLabel = level === "focus" ? "Focus spells" : level === 0 ? "Cantrips" : `Level ${level}`;
      const spent = spellSlotsSpent(entityId, caster.key, level, slots);
      // Cantrips get no pips at all rather than an empty row — the absence
      // is the point, and a lone label reads as "no cost" better than zero
      // pips would.
      const pips = slots > 0
        ? `<span class="battle-spell-slots">${spent.map((isSpent, i) => `
            <button type="button" class="battle-spell-slot${isSpent ? "" : " on"}"
              data-caster="${escapeHtml(caster.key)}" data-level="${escapeHtml(String(level))}" data-index="${i}"
              title="${longLabel} slot ${i + 1} of ${slots} — ${isSpent ? "spent, click to regain" : "available, click to spend"}"
              aria-pressed="${!isSpent}"></button>`).join("")}</span>`
        : "";
      const chips = list.map((name) => `<button type="button" class="battle-spell-chip" data-spell="${escapeHtml(name)}" title="${escapeHtml(name)} on Archives of Nethys">${escapeHtml(name)}</button>`).join("");
      return `
        <li class="battle-spell-level">
          <span class="battle-spell-level-head">
            <span class="battle-spell-level-label" title="${longLabel}">${label}</span>
            ${pips}
          </span>
          <span class="battle-spell-chips">${chips}</span>
        </li>`;
    }).join("");

    return `
      <div class="battle-spell-caster">
        <div class="battle-spell-caster-head">
          <span class="battle-spell-caster-name">${escapeHtml(caster.name)}</span>
          ${caster.meta ? `<span class="battle-spell-caster-meta">${escapeHtml(caster.meta)}</span>` : ""}
        </div>
        <ul class="battle-ability-list">${rows}</ul>
      </div>`;
  }).join("");

  body.innerHTML = `<div class="battle-ability-body">${casterBlocks}</div>`;

  for (const pip of body.querySelectorAll(".battle-spell-slot")) {
    pip.addEventListener("click", () => {
      const { caster, level, index } = pip.dataset;
      const label = level === "focus" ? "Focus" : `level ${level}`;
      toggleSpellSlot(entityId, entity.name, caster, level, Number(index), label);
    });
  }

  // Same AoN popup a monster's name opens, so a spell's rules are one click
  // away rather than a switch to the other app.
  for (const chip of body.querySelectorAll(".battle-spell-chip")) {
    chip.addEventListener("click", () => {
      openAonPopup(spellUrl(chip.dataset.spell), chip.dataset.spell);
    });
  }
}

// The same label-column-then-chips row the Spells tab uses, so the two
// read as one pattern. Empty groups are dropped rather than shown with a
// "None" placeholder: this tab only exists when there's something in it,
// and four rows of "None" would bury the one that isn't.
function renderInventoryTab(body, entity, inventory) {
  loadItemIds();

  // `removable` marks the DM's own additions. Sheet gear has no × because
  // it belongs to the character sheet, which this page never writes to —
  // the same reason a character can't be renamed here.
  const group = (label, items, removable = false) => (items.length ? `
    <li class="battle-inv-row">
      <span class="battle-inv-label">${label}</span>
      <span class="battle-inv-items">${items.map((item) => {
        // The display name can carry a material or rune prefix; the base
        // name is what resolves against AoN, so they're carried separately.
        const shown = item.display ?? item.name;
        const qty = item.qty > 1 ? ` <span class="battle-inv-qty">&times;${item.qty}</span>` : "";
        const note = item.note ? ` <span class="battle-inv-note">${escapeHtml(item.note)}</span>` : "";
        const drop = removable
          ? `<button type="button" class="battle-inv-drop" data-drop="${escapeHtml(item.name)}" title="Take ${escapeHtml(item.name)} away" aria-label="Take ${escapeHtml(item.name)} away">&times;</button>`
          : "";
        return `<span class="battle-inv-entry"><button type="button" class="battle-inv-chip" data-item="${escapeHtml(item.name)}" title="${escapeHtml(item.name)} on Archives of Nethys">${escapeHtml(shown)}${qty}${note}</button>${drop}</span>`;
      }).join("")}</span>
    </li>` : "");

  // Always rendered, always all four denominations. A zero is information —
  // "this creature has no silver" — and a row that only showed non-zero
  // coins changed width every time one ran out.
  const coins = `
    <li class="battle-inv-row">
      <span class="battle-inv-label">Coin</span>
      <span class="battle-inv-items">${inventory.coins.map(({ label, color, amount }) => `
        <span class="battle-inv-coin${amount ? "" : " empty"}" style="--coin-color: ${color}" title="${amount} ${label}">${amount} ${label}</span>`).join("")}</span>
    </li>`;

  const rows = group("Weapons", inventory.weapons)
    + group("Armor", inventory.armor)
    + group("Gear", inventory.gear)
    + group("Carried", inventory.carried, true)
    + coins;

  body.innerHTML = `
    <div class="battle-ability-body">
      <ul class="battle-ability-list battle-inv-list">${rows}</ul>
    </div>
  `;

  for (const chip of body.querySelectorAll(".battle-inv-chip")) {
    chip.addEventListener("click", () => {
      openAonPopup(itemUrl(chip.dataset.item), chip.dataset.item);
    });
  }
  for (const drop of body.querySelectorAll(".battle-inv-drop")) {
    drop.addEventListener("click", () => {
      removeInventoryItem(entity.id, entity.name, drop.dataset.drop);
    });
  }
}

// ---------------------------------------------------------------------------
// Inventory dialog. Opened from the Inventory tab's corner button. Adding an
// item and setting coin are the two battle-state changes, so they're the two
// that dispatch; opening and closing are UI-only, the same split the HP and
// initiative dialogs make.
//
// It's a dialog rather than controls inside the tab because the panel is
// rebuilt on every render() — an input living there would lose a half-typed
// item name to any unrelated dispatch.
let inventoryDialogEntityId = null;

function openInventoryDialog(entityId, name) {
  inventoryDialogEntityId = entityId;
  inventoryDialogName.textContent = name;
  // Coin fields are seeded with what the creature has now, so "set" edits
  // the current amount rather than starting from a blank the DM has to
  // retype.
  for (const { key, amount } of entityMoney(findEntity(entityId))) {
    inventoryCoinInputs[key].value = String(amount);
  }
  inventoryItemInput.value = "";
  inventoryQtyInput.value = "1";
  inventoryDialog.showModal();
  inventoryItemInput.focus();
}

inventoryAddForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const entity = findEntity(inventoryDialogEntityId);
  const name = inventoryItemInput.value.trim();
  const qty = Math.max(1, Math.trunc(Number(inventoryQtyInput.value)) || 1);
  if (entity && name) addInventoryItem(entity.id, entity.name, name, qty);
  // Stays open and clears: handing over three different things in a row is
  // the common case, and reopening the dialog each time is friction.
  inventoryItemInput.value = "";
  inventoryQtyInput.value = "1";
  inventoryItemInput.focus();
});

inventoryMoneyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const entity = findEntity(inventoryDialogEntityId);
  if (!entity) return;
  const money = {};
  for (const { key } of COIN_ORDER) {
    money[key] = Math.max(0, Math.trunc(Number(inventoryCoinInputs[key].value)) || 0);
  }
  setInventoryMoney(entity.id, entity.name, money);
});

inventoryCloseBtn.addEventListener("click", () => inventoryDialog.close());

function renderActionsTab(body, { strikes, special }) {
  // The multiple-attack penalty beside each strike, because a DM reads it
  // every single round and doing the arithmetic mid-fight is exactly the
  // kind of friction this panel exists to remove.
  const strikeRows = strikes.map((s) => `
    <li class="battle-ability-strike">
      <span class="battle-ability-strike-head">
        ${s.action ? `<span class="battle-ability-action">${actionIcon(s.action)}</span>` : ""}
        ${s.kind ? `<span class="battle-ability-kind">${escapeHtml(s.kind)}</span>` : ""}
        <span class="battle-ability-name">${escapeHtml(s.name)}</span>
        <span class="battle-ability-bonus">${formatMod(s.bonus)}</span>
        ${s.map ? `<span class="battle-ability-map" title="Multiple attack penalty: second and third attacks this round">[${s.map.map(formatMod).join(" / ")}]</span>` : ""}
      </span>
      ${s.traits?.length ? `<span class="battle-ability-traits">${s.traits.map((t) => `<span class="battle-ability-trait">${escapeHtml(t)}</span>`).join("")}</span>` : ""}
      ${s.damage ? `<span class="battle-ability-damage">${withActionIcons(escapeHtml(s.damage))}</span>` : ""}
    </li>
  `).join("");

  const specialRows = special.map((a) => {
    const { name, action } = splitActionFromName(a.name, a.action);
    return `
    <li class="battle-ability-special">
      <span class="battle-ability-special-head">
        ${action ? `<span class="battle-ability-action">${actionIcon(action)}</span>` : ""}
        <span class="battle-ability-name">${escapeHtml(name)}</span>
      </span>
      ${a.text ? `<span class="battle-ability-text">${abilityText(a.text)}</span>` : ""}
    </li>
  `;
  }).join("");

  body.innerHTML = `
    <div class="battle-ability-body">
      <ul class="battle-ability-list">
        ${strikeRows || '<li class="placeholder">No strikes.</li>'}
      </ul>
      ${specialRows ? `<ul class="battle-ability-list">${specialRows}</ul>` : ""}
    </div>
  `;
}

function renderProficienciesTab(body, { attributes, skills }) {
  // Abbreviated, not ABILITY_NAMES' full "Strength" — six of them share one
  // row, where the Character tab's grid only ever fits two. The title
  // carries the full name.
  const attrRow = ABILITIES.map((key) => {
    const value = attributes?.[key];
    return `<div class="battle-stat" title="${escapeHtml(ABILITY_NAMES[key] ?? key)}"><span class="stat-label">${key.toUpperCase()}</span><span class="stat-value${value == null ? " unknown" : ""}">${value == null ? "&mdash;" : formatMod(value)}</span></div>`;
  }).join("");

  // A conditional bonus ("Athletics +5 (+9 to Climb)") is shown beside the
  // flat one rather than replacing it — both apply, and which one is live
  // depends on what's being attempted. It's the whole reason these are
  // scraped from the rendered statblock; see the build script.
  const skillRows = (skills ?? []).map((s) => `
    <li class="battle-ability-skill">
      <span class="battle-ability-skill-name">${escapeHtml(s.name)}</span>
      <span class="battle-ability-bonus">${formatMod(s.modifier)}</span>
      ${(s.notes ?? []).map((n) => `<span class="battle-ability-skill-note">${formatMod(n.modifier)}${n.condition ? ` ${escapeHtml(n.condition)}` : ""}</span>`).join("")}
    </li>
  `).join("");

  body.innerHTML = `
    <div class="battle-ability-body">
      <div class="battle-stat-grid battle-ability-attrs">${attrRow}</div>
      <ul class="battle-ability-list battle-ability-skills">
        ${skillRows || '<li class="placeholder">No trained skills.</li>'}
      </ul>
    </div>
  `;
}

// PF2e's action symbols as SVG. AoN's action font isn't available here, and
// the Unicode stand-ins these replace ("◆◆◆", "↺") read as arbitrary
// decoration beside the symbols a PF2e player already knows.
//
// Traced from the Pathfinder action-card artwork rather than drawn by hand:
// a diamond pip followed by one chevron per action, a looping arrow for a
// reaction, and a knocked-out diamond for a free action.
//
// Every icon is a 100-unit-tall viewBox with only the width changing, and
// all five share one scale taken from the source sheet — which is why the
// reaction is drawn shorter than the chevrons here, exactly as it is on the
// cards, and is centred in its box rather than stretched to fill it.
//
// One <path> each, with fill-rule evenodd. The source art builds the free
// action from white shapes painted over a black diamond; evenodd turns
// those into real holes instead, so the icon works on any background.
//
// Filled with currentColor rather than a fixed colour, so an icon takes the
// colour of whatever text it sits in — which is what keeps them right in
// both themes without a second set of rules.
//
// The sheet has no three-action card. Its third chevron is the second one
// carried through the same affine that maps the first chevron onto the
// second (the art steps each one down slightly and to the right), so the
// progression continues instead of a third copy sitting at a guessed size.
const ACTION_ICON_ART = {
  "one-action": [100, "M 25.79,23.78 L 51.58,49.57 L 25.79,75.36 L 50.43,100 L 76.22,74.21 L 82.5,67.93 L 100,50.43 L 49.57-0 Z M 0,49.57 L 17.76,31.81 L 35.53,49.57 L 17.76,67.34 Z"],
  "two-actions": [153.28, "M 25.79,23.78 L 51.58,49.57 L 25.79,75.36 L 50.43,100 C 66.95,83.48 83.48,66.95 100,50.43 L 49.57-0 Z M 89.55,27.49 L 111.62,49.57 L 89.78,71.41 L 110.52,92.15 C 126.09,76.58 137.71,64.96 153.28,49.4 L 110.46,6.58 Z M 0,49.57 L 17.76,31.81 L 35.53,49.57 L 17.76,67.33 Z"],
  "three-actions": [198.83, "M 25.79,23.78 L 51.58,49.57 L 25.79,75.36 L 50.43,100 C 66.95,83.48 83.48,66.95 100,50.43 L 49.57-0 Z M 89.55,27.49 L 111.62,49.57 L 89.78,71.41 L 110.52,92.15 C 126.09,76.58 137.71,64.96 153.28,49.4 L 110.46,6.58 Z M 144.13,29.46 L 163.18,47.88 L 144.63,66.99 L 162.53,84.3 C 175.75,70.68 185.61,60.51 198.83,46.89 L 161.88,11.16 Z M 0,49.57 L 17.76,31.81 L 35.53,49.57 L 17.76,67.33 Z"],
  reaction: [97.77, "M 0,35.01 C 0,35.01 9.72,10.21 52.92,10.21 C 81.44,10.21 97.77,27.47 97.77,47 C 97.77,74.49 52.61,76.77 52.61,76.77 C 49.46,77.96 58.6,85.28 61.5,89.79 L 13.44,80.28 L 57.26,54.03 C 55.59,60.9 48.82,73.39 52.3,73.15 C 52.3,73.15 75.45,65.09 75.45,48.35 C 75.45,34.08 54.78,23.13 40.93,23.13 C 11.16,23.13 0,35.01 0,35.01 Z"],
  "free-action": [99.99, "M 0,49.58 L 49.57,0 L 99.99,50.42 L 50.42,100 Z M 35.42,25.48 L 50.26,10.64 L 90.01,50.39 L 51.12,89.27 L 35.44,73.59 L 59.48,49.55 Z M 11.39,49.56 L 25.05,35.9 L 38.71,49.56 L 25.05,63.23 Z"],
};

const ACTION_LABELS = {
  "one-action": "Single Action",
  "two-actions": "Two Actions",
  "three-actions": "Three Actions",
  reaction: "Reaction",
  "free-action": "Free Action",
};

// <title> rather than an aria-label: it gives the icon an accessible name
// AND a native hover tooltip, which is the pair the old markup needed a
// separate title attribute on the wrapping span to get.
const ACTION_ICONS = Object.fromEntries(
  Object.entries(ACTION_ICON_ART).map(([key, [width, d]]) => [
    key,
    `<svg class="action-icon" viewBox="0 0 ${width} 100" role="img">`
      + `<title>${ACTION_LABELS[key]}</title>`
      + `<path fill-rule="evenodd" d="${d}"/></svg>`,
  ]),
);

// The `action` field on a strike or special ability, spelled as AoN spells
// it. Anything unrecognised falls through to its own text rather than
// silently rendering no icon at all.
const ACTION_ICON_KEYS = {
  "Single Action": "one-action",
  "Two Actions": "two-actions",
  "Three Actions": "three-actions",
  Reaction: "reaction",
  "Free Action": "free-action",
};

// Takes either spelling: an AoN `action` field ("Two Actions") or the token
// key used in its text ("two-actions"). Anything unrecognised falls through
// to its own text rather than silently rendering nothing.
function actionIcon(action) {
  const key = ACTION_ICON_KEYS[action] ?? (ACTION_ICONS[action] ? action : null);
  return key ? ACTION_ICONS[key] : escapeHtml(action);
}

// AoN writes an action cost mid-text as a bracketed token — "[reaction]",
// "[one-action]". Square brackets aren't touched by escaping, so this runs
// on already-escaped text and the pattern still matches: the input is
// third-party data and must never reach innerHTML unescaped.
const ACTION_TOKEN = /\[(one-action|two-actions|three-actions|reaction|free-action)\]/g;
const ACTION_TOKEN_ONCE = /\[(one-action|two-actions|three-actions|reaction|free-action)\]/;

function withActionIcons(escaped) {
  return escaped.replace(ACTION_TOKEN, (_, key) => ACTION_ICONS[key]);
}

// AoN encodes an ability's cost two different ways and never both: a
// separate `action` field on some, and a token stuck on the end of the name
// on others ("Slink [reaction]"). The second is much the commoner — 249 of
// the 269 tokens in the data arrive that way, every one of them with a null
// `action`. Lifting the token out of the name lets both kinds put the same
// icon in the same slot, instead of one of them printing a literal
// "[reaction]" in the middle of a heading.
function splitActionFromName(name, action) {
  const match = name?.match(ACTION_TOKEN_ONCE);
  if (!match) return { name, action };
  return {
    name: name.replace(ACTION_TOKEN_ONCE, "").replace(/\s{2,}/g, " ").trim(),
    action: action ?? match[1],
  };
}

// AoN also writes the sub-headings inside an ability's text as **bold**
// runs ("**Trigger** ... **Effect** ..."). Rendered rather than shown
// literally, but through the same explicit escape-then-replace: escapeHtml()
// first, and only these two known markers promoted back to markup after.
function abilityText(text) {
  return withActionIcons(
    escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>"),
  );
}

// Monster abilities live in their own file, loaded on first use rather than
// at startup. They're ~216 KB gzipped against monsters.json's ~14 KB, and a
// session that never opens the abilities panel never needs a byte of them —
// putting that on the critical path of a page whose main job is drawing a
// grid would be paying for everyone what few use.
//
// null means "not fetched yet", a Map means "fetched" (possibly empty, if
// the fetch failed). The promise is memoised, so the render below can ask
// for it every frame and only ever cause one request.
let monsterAbilitiesByName = null;
let monsterAbilitiesPromise = null;

function loadMonsterAbilities() {
  if (monsterAbilitiesPromise) return monsterAbilitiesPromise;
  monsterAbilitiesPromise = fetchMonsterData("../monster-data/monster-abilities.json")
    .then((list) => {
      monsterAbilitiesByName = new Map((list ?? []).map((m) => [m.name, m.abilities]));
      // Repaints the panel that asked for this. Safe against a loop: the
      // memoised promise means the next render finds the Map and returns.
      render();
    })
    .catch(() => {
      // Non-fatal, and cached as an empty Map so a failed fetch isn't
      // retried on every render. The panel says so; nothing else breaks.
      monsterAbilitiesByName = new Map();
      render();
    });
  return monsterAbilitiesPromise;
}

// Strikes, attribute modifiers and special abilities, from whichever source
// the entity has — mirroring entityStatBlock()'s job for the stat panel.
// A character's strikes come from their Pathbuilder weapons; a monster's
// were parsed out of its statblock at build time.
//
// Returns the string "loading" for a monster whose abilities file hasn't
// arrived yet, which is distinct from null ("this thing has none").
function entityAbilities(entity) {
  const build = entity?.build;
  if (build) {
    const strikes = (build.weapons ?? []).map((w) => {
      const bonus = Number(w.attack) || 0;
      const damage = [w.die, w.damageBonus ? formatMod(w.damageBonus) : "", w.damageType]
        .filter(Boolean).join(" ");
      return {
        // No kind and no traits: Pathbuilder's export says neither whether
        // a weapon is melee or ranged nor whether it's agile. Guessing from
        // the name ("bow", "sling"…) would mislabel often enough to be
        // worse than saying nothing, and mis-stating agile would put the
        // wrong penalty in front of a DM every round. Both stay absent
        // until the export carries them — the standard -5/-10 shown here is
        // right for the large majority of weapons.
        kind: null,
        action: "Single Action",
        name: w.display || w.name || "weapon",
        bonus,
        map: [bonus - 5, bonus - 10],
        traits: [],
        damage: damage || null,
      };
    });
    const attributes = Object.fromEntries(
      ABILITIES.map((key) => [key, abilityMod(build.abilities?.[key] ?? 10)])
    );
    // Only trained-and-above, matching what a monster statblock lists — an
    // untrained skill is just the attribute modifier, already shown above,
    // and eighteen rows of those would bury the handful that matter.
    // SKILLS maps a skill name to its key ability; checkTotal() applies
    // PF2e's "no level bonus while untrained" rule.
    const prof = build.proficiencies ?? {};
    const skills = Object.entries(SKILLS)
      .filter(([key]) => (prof[key] ?? 0) > 0)
      .map(([key, ability]) => ({
        name: key.charAt(0).toUpperCase() + key.slice(1),
        modifier: checkTotal(build, prof[key], ability),
        notes: [],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { strikes, attributes, special: [], skills };
  }

  if (!entity?.monsterName) return null;
  if (monsterAbilitiesByName === null) {
    loadMonsterAbilities();
    return "loading";
  }
  const abilities = monsterAbilitiesByName.get(entity.monsterName);
  if (!abilities) return null;
  return {
    strikes: abilities.strikes ?? [],
    attributes: abilities.attributes ?? {},
    special: abilities.special ?? [],
    skills: abilities.skills ?? [],
  };
}

// One icon per movement type, so four speeds fit where "Speed 15 ft" used
// to sit for one. Same conventions as ACTION_ICONS: a 100-unit viewBox,
// currentColor, em-sized, <title> for both the accessible name and the
// tooltip. Default (nonzero) fill rule, not evenodd — the wing's feathers
// overlap deliberately and evenodd would punch holes where they cross.
const SPEED_ICON_ART = {
  walk: "M28 6H60V40C60 49 66 54 75 57L87 62C93 64 96 69 96 76C96 84 90 90 82 90H28Z",
  climb: "M22 8H34V92H22ZM66 8H78V92H66ZM34 24H66V36H34ZM34 44H66V56H34ZM34 64H66V76H34Z",
  fly: "M14 26Q56 8 97 20Q56 34 14 37ZM13 33Q52 24 92 42Q52 51 13 44ZM13 41Q47 40 80 63Q45 63 13 51ZM14 49Q41 55 61 80Q36 73 13 57Z",
  burrow: "M38 6H62V40H78L50 70L22 40H38ZM6 78H94V92H6Z",
};

// Swim is the one drawn with a stroke: a wave is a line, and outlining one
// as a closed shape reads as a ribbon rather than water.
const SPEED_ICON_SWIM =
  '<path d="M6 42C20 28 34 28 48 42S76 56 92 42" fill="none" stroke="currentColor"'
  + ' stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>'
  + '<path d="M6 70C20 56 34 56 48 70S76 84 92 70" fill="none" stroke="currentColor"'
  + ' stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>';

const SPEED_LABELS = {
  walk: "Speed",
  climb: "Climb",
  fly: "Fly",
  swim: "Swim",
  burrow: "Burrow",
};

const SPEED_ICONS = Object.fromEntries(
  Object.keys(SPEED_LABELS).map((kind) => [
    kind,
    `<svg class="speed-icon" viewBox="0 0 100 100" role="img">`
      + `<title>${SPEED_LABELS[kind]}</title>`
      + (kind === "swim" ? SPEED_ICON_SWIM : `<path d="${SPEED_ICON_ART[kind]}"/>`)
      + `</svg>`,
  ]),
);

// AoN publishes every speed as one prose string with the walk speed leading
// and unlabelled: "20 feet, climb 20 feet, swim 20 feet". Split on commas
// and read the movement type off the front of each part.
//
// Anything that doesn't start with an optional type and a number is
// dropped, which is what keeps the trailing special abilities the same
// field carries ("; unfettered movement", "earth glide") — and the one
// creature whose entry caught a page-full of scraped AoN navigation — from
// rendering as nameless speeds.
const SPEED_PART = /^(?:(climb|fly|swim|burrow)\s+)?(\d+)\s*(?:feet|ft\b)/i;

function parseSpeeds(speedText, walkSpeed) {
  const found = new Map();
  // Seeded from stats.speed rather than the prose, because that's the value
  // the rest of the panel agrees with; a duplicate walk speed in the text
  // is then ignored rather than overwriting it.
  if (walkSpeed != null) found.set("walk", walkSpeed);
  for (const part of (speedText ?? "").split(",")) {
    const match = part.trim().match(SPEED_PART);
    if (!match) continue;
    const kind = (match[1] ?? "walk").toLowerCase();
    if (!found.has(kind)) found.set(kind, Number(match[2]));
  }
  return [...found].map(([kind, feet]) => ({ kind, feet }));
}

// The character or custom object standing on the selected square — sheet
// numbers and conditions. Not the marker drawn for them; that's
// renderTokenTab() below.
function renderCharacterTab(objectBody) {
  const entityId = battleState.placements[selectedSquareKey];
  if (!entityId) {
    objectBody.innerHTML = '<p class="placeholder">Empty square.</p>';
    return;
  }

  const entity = findEntity(entityId);
  if (!entity) {
    objectBody.innerHTML = '<p class="placeholder">Empty square.</p>';
    return;
  }

  // The branch is on having STATS, not on being a character: a monster
  // with published numbers gets the full panel — HP bar, AC, saves,
  // Perception, conditions applying to all of it — and renders through
  // exactly the same code below. Custom objects (name only, by design), a
  // monster AoN had nothing for, and — defensively — a character missing
  // sheet data all fall through to the minimal panel.
  const stats = entityStatBlock(entity);
  if (!stats) {
    // A renamed monster still points at its statblock, so the button is
    // labelled with the bestiary entry rather than the token's name —
    // "Sneaky Pete" opening a page headed "Goblin Warrior" would look like
    // the wrong link otherwise.
    const monsterName = entity.monsterName;
    const summary = monsterName
      ? `<button type="button" id="battle-monster-stats" class="battle-monster-stats">View ${escapeHtml(monsterName)} statblock</button>`
      : `<p class="placeholder">${entity.isCustom ? "Custom object — no additional stats." : "No sheet data for this character."}</p>`;

    objectBody.innerHTML = `
      <div class="battle-stat-header">
        <div class="battle-stat-left">
          <button id="battle-remove-token" class="battle-remove-btn" title="Remove from field" aria-label="Remove from field">&times;</button>
          <div class="battle-stat-identity">
            <span class="battle-stat-name">${escapeHtml(entity.name)}</span>
          </div>
        </div>
      </div>
      ${summary}
      <div class="battle-stat-body">
        ${conditionsSectionHtml(entityId)}
      </div>
    `;
    bindRemoveButton();
    if (monsterName) {
      document.getElementById("battle-monster-stats").addEventListener("click", () => {
        openAonPopup(monsterUrl(monsterName), monsterName);
      });
    }
    // Custom objects get conditions too: a hazard can be broken or take
    // persistent damage, and conditions aren't sheet data — they're battle
    // state that applies to anything on the field, like initiative.
    bindConditionsSection(entityId, entity.name);
    return;
  }

  // Past this point `stats` is guaranteed (the branch above returned
  // otherwise), so this renders a character and a statted monster alike.
  const characterId = entityId;
  const build = entity.build;
  // Conditions are resolved once for the whole panel — every stat below
  // reads its own entry out of this, rather than each recomputing the
  // grant graph.
  const mods = entityModifiers(characterId, stats.level ?? 1);
  const hpPools = effectiveMaxHp(characterId, stats);
  const baseMaxHp = hpPools?.base ?? 0;
  const maxHp = hpPools?.max ?? 0;
  const hp = currentHp(characterId, maxHp);
  const tempHp = currentTempHp(characterId);
  // The bar's whole is max HP + temp HP, not just max HP, so adding temp
  // HP visibly shrinks the HP/absent portions to make room for it rather
  // than changing the bar's own width — e.g. 50/100 HP + 50 temp splits
  // into three even thirds (HP, absent, temp) of one fixed-size bar. The
  // "low HP" color threshold still checks real HP against real max,
  // uninflated by temp HP — a character sitting on a pile of temp HP is
  // still in danger the moment it runs out.
  const hpPool = maxHp + tempHp;
  const hpFillPct = hpPool > 0 ? Math.max(0, Math.min(100, (hp / hpPool) * 100)) : 0;
  const tempFillPct = hpPool > 0 ? Math.max(0, Math.min(100, (tempHp / hpPool) * 100)) : 0;
  const hpLow = maxHp > 0 && hp / maxHp <= 0.25;
  // Only a character can raise a shield — a monster's AC already includes
  // whatever it carries, and there's no published shield bonus to add.
  const { hasShield, shieldBonus } = build ? getAcBonuses(build) : { hasShield: false, shieldBonus: 0 };
  const shieldRaised = hasShield && raisedShieldIds.has(characterId);
  // Conditions apply on top of the raised-shield bonus, not instead of it:
  // the shield is a circumstance bonus, so it and a status penalty from
  // e.g. frightened both count. baseAc here is "AC before conditions".
  const baseAc = stats.ac == null ? null : stats.ac + (shieldRaised ? shieldBonus : 0);
  // Speed can't go below 0 however much is stacked on it; the clamp lives
  // with the other speeds further down, where every movement type gets it.
  const baseSpeed = stats.speed;

  // Each save/Perception tile is the same shape, so build them from one
  // list instead of four near-identical lines of template literal. A stat
  // the source didn't publish shows an em dash rather than a plausible
  // "+0" — a monster with no listed Will save has an unknown one, not a
  // zero one, and the difference matters at the table.
  // `short` is what the tile prints; `label` stays the full name for the
  // tooltip and the condition breakdown. "PERCEPTION" spelled out is what
  // was setting the tile width, and these four are the only stats here —
  // the abbreviations aren't ambiguous against anything.
  const checks = [
    { label: "Fortitude", short: "FORT", base: stats.fortitude, modifier: mods.fortitude },
    { label: "Reflex", short: "REF", base: stats.reflex, modifier: mods.reflex },
    { label: "Will", short: "WILL", base: stats.will, modifier: mods.will },
    { label: "Perception", short: "PERC", base: stats.perception, modifier: mods.perception },
  ].map(({ label, short, base, modifier }) => {
    if (base == null) {
      return `<div class="battle-stat" title="${label}"><span class="stat-label">${short}</span><span class="stat-value unknown" title="Not published for this creature">&mdash;</span></div>`;
    }
    const hint = modifierHint(label, base, modifier);
    return `<div class="battle-stat" title="${escapeHtml(hint || label)}"><span class="stat-label">${short}</span><span class="stat-value ${modifierClass(modifier)}">${formatMod(base + modifier.total)}</span></div>`;
  }).join("");

  const ac = baseAc == null ? null : baseAc + mods.ac.total;
  const hasHp = hpPools != null;

  const acHint = baseAc == null ? "" : modifierHint("AC", baseAc, mods.ac, String);
  const speedHint = baseSpeed == null ? "" : modifierHint("Speed", baseSpeed, mods.speed, String);
  const maxHpHint = hasHp ? modifierHint("Max HP", baseMaxHp, mods.maxHp, String) : "";
  // The AC panel's tooltip already explains the shield toggle; the
  // condition breakdown is appended below it rather than replacing it.
  const acTitle = [hasShield ? `Raise a Shield (+${shieldBonus} AC)` : "AC", acHint].filter(Boolean).join("\n\n");
  const hpTitle = hasHp
    ? ["Click to adjust HP", maxHpHint].filter(Boolean).join("\n\n")
    : "No published HP for this creature";
  // Every movement type the creature has, as an icon and a number each.
  // A dragon's fly speed used to be readable only by hovering for the prose
  // tooltip; the panel now shows all of them and still takes less room than
  // "Speed 25 ft" did, because the word and the unit are gone.
  //
  // The condition modifier applies to every speed, not just walking: PF2e's
  // Speed penalties are penalties to all your Speeds, and showing a slowed
  // dragon an unmodified fly speed beside a modified walk speed would be
  // the panel disagreeing with itself.
  const speedTitle = [stats.speedText, speedHint].filter(Boolean).join("\n\n");
  const speeds = parseSpeeds(stats.speedText, baseSpeed)
    .map(({ kind, feet }) => ({ kind, feet: Math.max(0, feet + mods.speed.total) }));
  const speedsHtml = speeds.length
    ? speeds.map(({ kind, feet }) => {
      const hint = [`${SPEED_LABELS[kind]} ${feet} feet`, speedHint].filter(Boolean).join("\n\n");
      return `<span class="battle-speed ${modifierClass(mods.speed)}" title="${escapeHtml(hint)}">${SPEED_ICONS[kind]}${feet}</span>`;
    }).join("")
    : `<span class="battle-speed unknown" title="Not published for this creature">${SPEED_ICONS.walk}&mdash;</span>`;
  const maxHpText = mods.maxHp.total
    ? `<span class="${modifierClass(mods.maxHp)} on-fill">${maxHp}</span>`
    : `${maxHp}`;

  // Monsters keep a way through to the full statblock — the panel carries
  // the numbers a fight needs, not the strikes, spells and abilities. The
  // NAME is the link rather than a separate icon beside it: the header row
  // is tight, and an extra control there was crowding the speed and HP bar
  // for something the name itself can carry.
  //
  // Its tooltip names the STATBLOCK, not the token — "Giant Gecko 4" is
  // this particular gecko, and what the link opens is the page for Giant
  // Gecko. Same reasoning the roster's button already used.
  const monsterName = entity.monsterName;
  const nameHtml = monsterName
    ? `<button type="button" id="battle-monster-stats" class="battle-stat-name battle-stat-name-link" title="${escapeHtml(monsterName)} statblock">${escapeHtml(entity.name)}</button>`
    : `<span class="battle-stat-name">${escapeHtml(entity.name)}</span>`;

  // Two clusters pinned to opposite edges (identity on the left, HP/AC on
  // the right) rather than one row that stretches the HP bar to fill the
  // gap — an empty center is intentional, not a layout bug. See "Page
  // layout: boxing" in the battle-helper-architecture skill.
  objectBody.innerHTML = `
    <div class="battle-stat-header">
      <div class="battle-stat-left">
        <button id="battle-remove-token" class="battle-remove-btn" title="Remove from field" aria-label="Remove from field">&times;</button>
        <div class="battle-stat-identity">
          <!-- Level stacks above the name rather than riding it as a
               superscript: a column costs the tight header row no
               horizontal space at all, which is what the <sup> was there to
               save. It stays a sibling of the name, never a child — inside
               the monster case's <button> it would join the click target. -->
          <div class="battle-stat-name-block">
            <span class="battle-stat-level">lvl ${stats.level ?? 1}</span>
            <span class="battle-stat-name-wrap">${nameHtml}</span>
          </div>
          <span class="battle-stat-speeds" title="${escapeHtml(speedTitle)}">${speedsHtml}</span>
        </div>
      </div>
      <div class="battle-stat-right">
        <button type="button" id="battle-hp-bar" class="battle-hp-bar" title="${escapeHtml(hpTitle)}" ${hasHp ? "" : "disabled"}>
          <span class="battle-hp-bar-fill${hpLow ? " low" : ""}" style="width:${hpFillPct}%"></span>
          ${tempHp > 0 ? `<span class="battle-hp-bar-temp-fill" style="left:${hpFillPct}%; width:${tempFillPct}%"></span>` : ""}
          <span class="battle-hp-bar-text">${hasHp ? `${hp} / ${maxHpText}${tempHp > 0 ? ` (+${tempHp})` : ""}` : "&mdash;"}</span>
        </button>
        <button type="button" id="battle-toggle-shield" class="battle-stat-ac${shieldRaised ? " active" : ""}" title="${escapeHtml(acTitle)}" ${hasShield ? "" : "disabled"}>
          <span class="stat-label">AC</span>
          <span class="stat-value ${ac == null ? "unknown" : modifierClass(mods.ac)}">${ac == null ? "&mdash;" : ac}</span>
          ${hasShield ? `<span class="battle-stat-ac-shield-icon" aria-hidden="true">&#128737;</span>` : ""}
        </button>
      </div>
    </div>
    <div class="battle-stat-body">
      <div class="battle-stat-grid">
        ${checks}
      </div>
      ${conditionsSectionHtml(characterId)}
    </div>
  `;

  bindRemoveButton();
  bindConditionsSection(characterId, entity.name);

  if (monsterName) {
    document.getElementById("battle-monster-stats").addEventListener("click", () => {
      openAonPopup(monsterUrl(monsterName), monsterName);
    });
  }

  if (hasHp) {
    document.getElementById("battle-hp-bar").addEventListener("click", () => {
      openHpDialog(characterId, entity.name);
    });
  }

  if (hasShield) {
    document.getElementById("battle-toggle-shield").addEventListener("click", () => {
      if (raisedShieldIds.has(characterId)) raisedShieldIds.delete(characterId);
      else raisedShieldIds.add(characterId);
      render();
    });
  }
}

// ---------------------------------------------------------------------------
// Conditions. Battle progress, not identity: cleared when a token leaves
// the field or is placed fresh, exactly like HP — unlike appearance, which
// survives. Stored per entity id (never per square) so they'd survive a
// future move, same reasoning as hp/tempHp.
//
// Shape: conditions[entityId][conditionId] = { active, value }
//   active — the checkbox. A condition can be applied but suppressed,
//            which is how a DM parks something that's temporarily not
//            biting without losing its tier.
//   value  — only for PF2E_CONDITIONS[id].valued; absent otherwise.

const CONDITION_MIN = 1;
const CONDITION_MAX = 10;

function entityConditions(entityId) {
  return battleState.conditions?.[entityId] ?? {};
}

// What's actually in effect, grants expanded — see resolveConditions() in
// pf2e-conditions.js. Derived on every read rather than stored: a granted
// condition has no independent life of its own (removing Encumbered must
// take its clumsy 1 with it, and must not disturb a clumsy the DM applied
// separately), and deriving it is the only way that stays true without a
// bookkeeping pass on every add/remove.
function effectiveConditions(entityId) {
  return resolveConditions(entityConditions(entityId));
}

// { stat: { total, terms } } for AC/saves/Perception/Speed/max HP.
// `level` only matters to drained, whose max-HP hit scales with it.
function entityModifiers(entityId, level) {
  return conditionModifiers(effectiveConditions(entityId), level);
}

// Drained is the one condition that changes max HP, so max HP is no longer
// a pure function of the stat block. Everything that clamps HP goes through
// here so the cap is the same in the panel and in the damage/heal dialog.
// Floored at 1: enough drained on a low-level entity would otherwise
// produce a zero-or-negative maximum, which the HP bar can't divide by.
//
// Takes a normalised stat block (see entityStatBlock()), so a monster's
// published HP is drained exactly like a character's computed HP — drained
// is level-scaled, and a monster has a level like anything else. Returns
// null for an entity with no HP at all, which is the panel's cue to leave
// the bar out rather than draw a bar over a made-up maximum.
function effectiveMaxHp(entityId, stats) {
  if (stats?.maxHp == null) return null;
  const base = stats.maxHp;
  const modifier = entityModifiers(entityId, stats.level ?? 1).maxHp;
  return { base, max: Math.max(1, base + modifier.total), modifier };
}

// A stat the conditions moved renders in red (or green, if something ever
// grants a bonus) with the arithmetic in its tooltip; a stat nothing
// touched renders exactly as it did before this existed — no class, no
// title — so the coloring only ever means "a condition is biting here".
//
// Returns a bare class string (no leading space) meant to be interpolated
// after a space: `class="stat-value ${modifierClass(m)}"`. The trailing
// space when nothing applies is harmless.
function modifierClass(modifier) {
  if (!modifier?.total) return "";
  return modifier.total < 0 ? "modified penalized" : "modified buffed";
}

// Multi-line tooltip text: the before/after on the first line, then one
// line per contributing condition. Terms that lost the stacking contest
// are listed too, marked as such — "clumsy 1 is on, frightened 2 is what's
// actually costing you" is exactly the question this hint exists to answer.
function modifierHint(label, base, modifier, format = formatMod) {
  if (!modifier?.total) return "";
  const lines = [`${label} ${format(base)} → ${format(base + modifier.total)}`];
  for (const term of modifier.terms) {
    const type = term.type === "untyped" ? "" : ` ${term.type}`;
    lines.push(`${formatMod(term.amount)}${type} — ${term.source}${term.applied ? "" : " (doesn't stack)"}`);
  }
  return lines.join("\n");
}

// One place that writes the map, so every caller gets the same defensive
// creation of the per-entity object and the same single dispatch.
function updateEntityConditions(entityId, label, mutate) {
  dispatch("update-conditions", label, (state) => {
    if (!state.conditions) state.conditions = {};
    const current = { ...state.conditions[entityId] };
    mutate(current);
    state.conditions[entityId] = current;
  });
}

function addCondition(entityId, conditionId, name) {
  const definition = PF2E_CONDITIONS[conditionId];
  if (!definition) return;
  updateEntityConditions(entityId, `${name} gained ${definition.name}${definition.valued ? ` ${CONDITION_MIN}` : ""}`, (current) => {
    current[conditionId] = definition.valued
      ? { active: true, value: CONDITION_MIN }
      : { active: true };
  });
}

function removeCondition(entityId, conditionId, name) {
  const definition = PF2E_CONDITIONS[conditionId];
  if (!definition) return;
  updateEntityConditions(entityId, `${name} lost ${definition.name}`, (current) => {
    delete current[conditionId];
  });
}

function toggleCondition(entityId, conditionId, name) {
  const definition = PF2E_CONDITIONS[conditionId];
  const existing = entityConditions(entityId)[conditionId];
  if (!definition || !existing) return;
  const nextActive = !existing.active;
  updateEntityConditions(entityId, `${name}'s ${definition.name} ${nextActive ? "reapplied" : "suppressed"}`, (current) => {
    current[conditionId] = { ...current[conditionId], active: nextActive };
  });
}

function adjustCondition(entityId, conditionId, name, delta) {
  const definition = PF2E_CONDITIONS[conditionId];
  const existing = entityConditions(entityId)[conditionId];
  if (!definition?.valued || !existing) return;
  // Clamped at 1 rather than removing at 0: the checkbox is how a
  // condition is switched off, and stepping past the floor shouldn't
  // silently delete a row the DM is still pointing at.
  const nextValue = Math.min(CONDITION_MAX, Math.max(CONDITION_MIN, (existing.value ?? CONDITION_MIN) + delta));
  if (nextValue === existing.value) return;
  updateEntityConditions(entityId, `${name}'s ${definition.name} set to ${nextValue}`, (current) => {
    current[conditionId] = { ...current[conditionId], value: nextValue };
  });
}

// Every condition to list: applied by hand, or imposed by one that was —
// in the dictionary's (alphabetical) order rather than the order they
// happened to arrive, so a row doesn't move under the cursor when an
// unrelated condition is applied, and a granted row lands in the same
// place it would have if the DM had added it themselves.
function sortedConditionIds(applied, effective) {
  return Object.keys(PF2E_CONDITIONS).filter((id) => applied[id] || effective[id]);
}

function conditionsSectionHtml(entityId) {
  const applied = entityConditions(entityId);
  const effective = effectiveConditions(entityId);
  const ids = sortedConditionIds(applied, effective);

  const rows = ids.map((id) => {
    const definition = PF2E_CONDITIONS[id];
    const entry = applied[id];      // undefined => imposed, not applied by hand
    const state = effective[id];    // undefined => switched off and not imposed
    const value = state?.value ?? entry?.value ?? CONDITION_MIN;
    const grantedBy = (state?.grantedBy ?? []).map((from) => PF2E_CONDITIONS[from]?.name ?? from);

    const classes = ["battle-condition-row"];
    if (!state) classes.push("suppressed");
    if (!entry) classes.push("derived");
    if (state?.overriddenBy) classes.push("overridden");

    const notes = [definition.summary];
    if (entry && !entry.active) {
      notes.push(state
        ? `Switched off by hand, but still imposed by ${grantedBy.join(", ")}.`
        : "Switched off — not in effect.");
    } else if (grantedBy.length) {
      notes.push(entry
        ? `Also imposed by ${grantedBy.join(", ")}.`
        : `Imposed by ${grantedBy.join(", ")} — remove that to clear it.`);
    }
    if (state?.overriddenBy) {
      notes.push(`Overridden by ${PF2E_CONDITIONS[state.overriddenBy].name}, so its effects don't apply right now.`);
    }

    // Only a hand-applied condition gets a stepper: an imposed one's value
    // belongs to whatever imposed it (encumbered's clumsy is always 1), so
    // there's nothing here to step. The tier slot is rendered either way,
    // empty if need be, so names and checkboxes stay column-aligned down
    // the list regardless of which kinds are applied.
    let tier = '<div class="battle-condition-tier"></div>';
    if (definition.valued && entry) {
      tier = `
        <div class="battle-condition-tier">
          <button type="button" class="battle-condition-step" data-condition="${id}" data-delta="-1" title="Decrease" aria-label="Decrease ${escapeHtml(definition.name)}"${value <= CONDITION_MIN ? " disabled" : ""}>&minus;</button>
          <span class="battle-condition-value">${value}</span>
          <button type="button" class="battle-condition-step" data-condition="${id}" data-delta="1" title="Increase" aria-label="Increase ${escapeHtml(definition.name)}"${value >= CONDITION_MAX ? " disabled" : ""}>+</button>
        </div>`;
    } else if (definition.valued) {
      tier = `<div class="battle-condition-tier"><span class="battle-condition-value">${value}</span></div>`;
    }

    // An imposed row's checkbox is checked and disabled: it *is* in
    // effect, and the way to clear it is to clear whatever imposed it.
    return `
      <li class="${classes.join(" ")}" title="${escapeHtml(notes.join("\n\n"))}">
        <input type="checkbox" class="battle-condition-toggle" data-condition="${id}"${entry ? (entry.active ? " checked" : "") : " checked disabled"} aria-label="${escapeHtml(definition.name)} active" />
        <span class="battle-condition-name">${escapeHtml(definition.name)}</span>
        ${tier}
      </li>`;
  }).join("");

  return `
    <div class="battle-conditions">
      <div class="battle-conditions-header">
        <h3>Conditions</h3>
        <button type="button" id="battle-condition-add" class="battle-condition-add" title="Add condition" aria-label="Add condition">+</button>
      </div>
      <ul class="battle-condition-list">
        ${rows || '<li class="placeholder">None.</li>'}
      </ul>
    </div>`;
}

function bindConditionsSection(entityId, name) {
  document.getElementById("battle-condition-add").addEventListener("click", () => {
    openConditionDialog(entityId, name);
  });

  for (const box of objectPanel.querySelectorAll(".battle-condition-toggle")) {
    box.addEventListener("change", () => toggleCondition(entityId, box.dataset.condition, name));
  }
  for (const btn of objectPanel.querySelectorAll(".battle-condition-step")) {
    btn.addEventListener("click", () => {
      adjustCondition(entityId, btn.dataset.condition, name, Number(btn.dataset.delta));
    });
  }
}

const TOKEN_SHAPES = [
  { value: "circle", label: "●", title: "Circle" },
  { value: "square", label: "■", title: "Square" },
  { value: "diamond", label: "◆", title: "Diamond" },
  { value: "triangle", label: "▲", title: "Triangle" },
];

// Patches battleState.appearance[entityId] — deletes a key when its patch
// value is undefined (used to revert a field back to its computed
// default) rather than leaving a dangling `undefined` in the object.
function updateAppearance(entityId, patch, label) {
  dispatch("update-appearance", label, (state) => {
    const current = { ...state.appearance[entityId] };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete current[key];
      else current[key] = value;
    }
    state.appearance[entityId] = current;
  });
}

// The marker drawn on the map for whatever is on the selected square —
// shape, letters, text color, shape color. This is the tab that's actually
// about the *token*; the Character tab beside it is about the creature or
// object it stands for. Like the initiative dialog, it works for any
// placed entity, custom objects included.
//
// No <h2> of its own: the tab label already names it, where the old
// standalone box needed a heading like every other box on the page.
function renderTokenTab(objectBody) {
  const entityId = battleState.placements[selectedSquareKey];
  if (!entityId) {
    objectBody.innerHTML = '<p class="placeholder">Empty square.</p>';
    return;
  }

  const entity = findEntity(entityId);
  if (!entity) {
    objectBody.innerHTML = '<p class="placeholder">Empty square.</p>';
    return;
  }

  const appearance = getAppearance(entityId, entity.name);

  objectBody.innerHTML = `
    <div class="battle-appearance-row">
      <span class="battle-appearance-label">Shape</span>
      <div class="battle-appearance-shapes">
        ${TOKEN_SHAPES.map((s) => `
          <button type="button" class="battle-shape-btn${s.value === appearance.shape ? " active" : ""}" data-shape="${s.value}" title="${s.title}">${s.label}</button>
        `).join("")}
      </div>
    </div>
    <div class="battle-appearance-row">
      <span class="battle-appearance-label">Letters</span>
      <input type="text" id="battle-appearance-letters" maxlength="2" value="${escapeHtml(appearance.letters)}" />
    </div>
    <div class="battle-appearance-row">
      <span class="battle-appearance-label">Text color</span>
      <input type="color" id="battle-appearance-text-color" value="${appearance.textColor}" />
    </div>
    <div class="battle-appearance-row">
      <span class="battle-appearance-label">Shape color</span>
      <input type="color" id="battle-appearance-shape-color" value="${appearance.shapeColor}" />
    </div>
  `;

  for (const btn of objectBody.querySelectorAll(".battle-shape-btn")) {
    btn.addEventListener("click", () => {
      const shape = btn.dataset.shape;
      updateAppearance(entityId, { shape }, `Set ${entity.name}'s token shape to ${shape}`);
    });
  }

  // change (not input) so typing/dragging a color wheel doesn't spam the
  // undo log with one event per intermediate value — only the committed
  // result is a real action.
  document.getElementById("battle-appearance-letters").addEventListener("change", (event) => {
    const value = event.target.value.trim().slice(0, 2).toUpperCase();
    updateAppearance(entityId, { letters: value || undefined }, `Set ${entity.name}'s token letters to "${value || defaultInitials(entity.name)}"`);
  });
  document.getElementById("battle-appearance-text-color").addEventListener("change", (event) => {
    updateAppearance(entityId, { textColor: event.target.value }, `Changed ${entity.name}'s token text color`);
  });
  document.getElementById("battle-appearance-shape-color").addEventListener("change", (event) => {
    updateAppearance(entityId, { shapeColor: event.target.value }, `Changed ${entity.name}'s token shape color`);
  });
}

function renderLog() {
  if (eventLog.length === 0) {
    logList.innerHTML = '<li class="empty">No actions yet</li>';
    return;
  }

  // Newest first, same convention as the main app's Roll History. Events
  // past the undo cursor (available to redo, but not currently applied)
  // are marked "undone" so the log stays honest about current state.
  logList.innerHTML = eventLog
    .slice()
    .reverse()
    .map((event, i) => {
      const originalIndex = eventLog.length - 1 - i;
      const undone = originalIndex > cursor;
      const time = new Date(event.at).toLocaleTimeString();
      return `<li class="${undone ? "undone" : ""}" title="${escapeHtml(time)}">${escapeHtml(event.label)}</li>`;
    })
    .join("");
}

function renderUndoRedoButtons() {
  undoBtn.hidden = cursor < 0;
  redoBtn.hidden = cursor >= eventLog.length - 1;
}

// ---------------------------------------------------------------------------
// Battle tabs. None of these dispatch() — see the comment on `battles`
// above for why a tab operation sits above the per-battle undo stack.

// Points the live battleState/eventLog/cursor at another battle's entry.
// UI-only state is reset rather than carried over: selectedSquareKey and
// dragFromKey are square keys, and armedEntityId/raisedShieldIds are entity
// ids, all of which mean something different (or nothing) in the battle
// being opened.
function setActiveBattle(id) {
  const battle = battles.find((b) => b.id === id);
  if (!battle) return;
  activeBattleId = id;
  battleState = battle.state;
  eventLog = battle.eventLog;
  cursor = battle.cursor;

  selectedSquareKey = null;
  armedEntityId = null;
  raisedShieldIds = new Set();
  dragFromKey = null;
  dragHoverKey = null;
  dragPath = null;
  dragMoved = false;
  // The clipboard itself deliberately SURVIVES the switch — carrying a
  // creature from one battle to another is the main reason to copy one.
  // Only the "copied" highlight resets, since it points at a row in the
  // battle being left.
  clipboardSourceId = null;
}

function switchBattle(id) {
  if (id === activeBattleId) return;
  persistBattleStore(); // flush the outgoing battle's live values into its entry
  setActiveBattle(id);
  persistBattleStore();
  render();
}

// Counts up from the current tab count rather than filling the lowest free
// gap, so a new battle doesn't reuse the name of one just closed.
function nextBattleName() {
  const used = new Set(battles.map((b) => b.name));
  let n = battles.length + 1;
  while (used.has(`Battle ${n}`)) n++;
  return `Battle ${n}`;
}

function addBattle() {
  persistBattleStore();
  const battle = createBattle(nextBattleName());
  battles.push(battle);
  setActiveBattle(battle.id);
  persistBattleStore();
  render();
}

function deleteBattle(id) {
  const index = battles.findIndex((b) => b.id === id);
  if (index === -1) return;
  battles.splice(index, 1);
  // Never leave the page with no battle open.
  if (!battles.length) battles.push(createBattle("Battle 1"));
  // Closing the active tab focuses whichever tab slid into its place (or
  // the new last one), the way closing a browser tab does. Note this runs
  // *after* the splice, so persistBattleStore() below can't resurrect the
  // deleted entry by flushing live values into it.
  if (id === activeBattleId) setActiveBattle(battles[Math.min(index, battles.length - 1)].id);
  persistBattleStore();
  render();
}

let renameBattleId = null;
let pendingDeleteBattleId = null;

function openRenameBattleDialog(id) {
  const battle = battles.find((b) => b.id === id);
  if (!battle) return;
  renameBattleId = id;
  renameInput.value = battle.name;
  renameDialog.showModal();
  renameInput.select();
}

function openDeleteBattleDialog(id) {
  const battle = battles.find((b) => b.id === id);
  if (!battle) return;
  pendingDeleteBattleId = id;
  deleteBattleMessage.textContent =
    `Close "${battle.name}"? Its tokens, HP and event log are deleted with it, and this can't be undone.`;
  deleteBattleDialog.showModal();
}

function renderTabs() {
  tabList.innerHTML = battles.map((b) => `
    <li class="battle-tab${b.id === activeBattleId ? " active" : ""}" data-battle-id="${escapeHtml(b.id)}" title="${escapeHtml(b.name)} — double-click to rename">
      <span class="battle-tab-name">${escapeHtml(b.name)}</span>
      <button type="button" class="battle-tab-close" data-battle-id="${escapeHtml(b.id)}" title="Close ${escapeHtml(b.name)}" aria-label="Close ${escapeHtml(b.name)}">&times;</button>
    </li>
  `).join("");
}

// Delegated to the <ul>, and attached once rather than per render — unlike
// the roster and initiative track, this listener CAN'T live on the <li>s:
// renderTabs() replaces them on every render, so on a double-click the
// first click re-renders, the two clicks land on different nodes, and the
// browser dispatches dblclick on their nearest common ancestor instead of
// the tab. Delegating here makes that ancestor the thing listening, so
// double-click-to-rename works on any tab, not just the active one.
// Checking the close button first also replaces the stopPropagation() the
// per-element version needed to avoid switching to a tab being closed.
tabList.addEventListener("click", (event) => {
  const closeBtn = event.target.closest(".battle-tab-close");
  if (closeBtn) {
    openDeleteBattleDialog(closeBtn.dataset.battleId);
    return;
  }
  const tab = event.target.closest("li[data-battle-id]");
  if (tab) switchBattle(tab.dataset.battleId);
});

tabList.addEventListener("dblclick", (event) => {
  if (event.target.closest(".battle-tab-close")) return;
  const tab = event.target.closest("li[data-battle-id]");
  if (tab) openRenameBattleDialog(tab.dataset.battleId);
});

tabAddBtn.addEventListener("click", addBattle);

renameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const battle = battles.find((b) => b.id === renameBattleId);
  const name = renameInput.value.trim();
  if (battle && name) {
    battle.name = name;
    persistBattleStore();
    render();
  }
  renameDialog.close();
});
renameCloseBtn.addEventListener("click", () => renameDialog.close());

deleteBattleConfirmBtn.addEventListener("click", () => {
  deleteBattle(pendingDeleteBattleId);
  pendingDeleteBattleId = null;
  deleteBattleDialog.close();
});
deleteBattleCancelBtn.addEventListener("click", () => deleteBattleDialog.close());

// ---------------------------------------------------------------------------

function render() {
  renderTabs();
  drawGrid();
  // After drawGrid(), which is what resizes the canvas: shrinking the grid
  // or zooming out can leave a pan that was fine a moment ago pointing at
  // empty space. Not inside drawGrid() itself — that also runs on every
  // mousemove of a token drag, where nothing has resized.
  clampPan();
  renderGridControls();
  renderZoomControls();
  renderToolControls();
  renderRoster();
  renderInitiative();
  renderObjectPanel();
  renderAbilitiesPanel();
  renderLog();
  renderUndoRedoButtons();
}

// ---------------------------------------------------------------------------
// HP adjustment dialog. Only the action buttons (damage/heal/temp HP)
// mutate battle state — dispatched as one event each. The stepper buttons
// and the input box just stage a number for those actions to use; staging
// a number isn't itself a battle change, so it's not dispatched.

function openHpDialog(characterId, name) {
  hpDialogCharacterId = characterId;
  hpDialogName.textContent = name;
  hpInput.value = 0;
  updateHpActionVisibility();
  hpDialog.showModal();
}

// The staged value's sign carries meaning: negative = damage, positive =
// heal/temp HP, 0 = nothing to apply. The damage group and the heal group
// are stacked on top of each other (see .hp-action-row/.hp-action-group in
// battle-helper.css) rather than laid out side by side, so each one
// centers within the FULL row on its own — not just "its half" — and
// .hp-action-row has a fixed height, so whichever group is showing (or
// neither, at 0) never resizes the dialog. Hiding is done on the GROUP
// (`hidden` = real display:none), not on individual buttons: an empty-but-
// present group still has a full-size box stacked on top of the other
// group and silently swallows its clicks, since a positioned box
// intercepts pointer events over its area even with no visible content.
// See "Avoiding layout jumps" in the battle-helper-architecture skill.
const hpDamageGroup = document.getElementById("hp-action-group-damage");
const hpHealGroup = document.getElementById("hp-action-group-heal");
const hpHalfBtn = document.getElementById("hp-action-half");
const hpFullBtn = document.getElementById("hp-action-full");
const hpDoubleBtn = document.getElementById("hp-action-double");
const hpHealBtn = document.getElementById("hp-action-heal");
const hpTempBtn = document.getElementById("hp-action-temp");

function updateHpActionVisibility() {
  const value = Number(hpInput.value) || 0;
  hpDamageGroup.hidden = !(value < 0);
  hpHealGroup.hidden = !(value > 0);
}

// Temporary HP absorbs damage before real HP does (PF2e's actual rule) —
// handled inside the same dispatch as the HP change itself, so undo/redo
// reverts both pools together as one event, not two. The log breaks out
// how much of the damage each pool actually took, not just the total.
function applyHpDelta(delta, kind) {
  const characterId = hpDialogCharacterId;
  // findEntity(), not loadCharacters(): a monster has an HP pool too, and
  // looking only in the character store would silently no-op every button
  // in this dialog for one.
  const character = findEntity(characterId);
  const pools = character ? effectiveMaxHp(characterId, entityStatBlock(character)) : null;
  if (!pools || !delta) {
    hpDialog.close();
    return;
  }

  // The drained-reduced maximum, not the published one — healing can't push
  // a drained creature back above the cap the condition imposes.
  const { max: maxHp } = pools;
  const suffix = kind ? ` (${kind})` : "";
  let label;
  if (delta < 0) {
    const totalDamage = -delta;
    const temp = battleState.tempHp[characterId] ?? 0;
    const absorbed = Math.min(temp, totalDamage);
    const toHp = totalDamage - absorbed;
    if (absorbed === 0) {
      label = `${character.name} took ${totalDamage} damage${suffix}`;
    } else if (toHp === 0) {
      label = `${character.name} took ${totalDamage} damage${suffix} to temp HP`;
    } else {
      label = `${character.name} took ${totalDamage} damage${suffix} (${absorbed} to temp HP, ${toHp} to HP)`;
    }
  } else {
    label = `${character.name} healed ${delta} HP`;
  }

  dispatch("adjust-hp", label, (state) => {
    let hpDelta = delta;
    if (hpDelta < 0) {
      const temp = state.tempHp[characterId] ?? 0;
      const absorbed = Math.min(temp, -hpDelta);
      state.tempHp[characterId] = temp - absorbed;
      hpDelta += absorbed;
    }
    const before = state.hp[characterId] ?? maxHp;
    state.hp[characterId] = Math.max(0, Math.min(maxHp, before + hpDelta));
  });
  hpDialog.close();
}

// Temp HP doesn't stack with itself and isn't part of max HP — a new grant
// simply replaces the tracked value (a DM setting it to what they intend,
// not an additive stepper like damage/heal).
function applyTempHp(value) {
  const characterId = hpDialogCharacterId;
  // findEntity(), for the same reason as applyHpDelta(): temp HP applies
  // to a monster just as much as to a character.
  const character = findEntity(characterId);
  if (!character || !value) {
    hpDialog.close();
    return;
  }

  dispatch("adjust-temp-hp", `${character.name} gained ${value} temporary HP`, (state) => {
    state.tempHp[characterId] = value;
  });
  hpDialog.close();
}

// Rapid clicks on these small buttons get misread by the browser as a
// double-click text selection (highlighting the button's own label).
// preventDefault() on mousedown stops selection from starting without
// affecting the click event itself.
for (const btn of document.querySelectorAll(".hp-step, .hp-action")) {
  btn.addEventListener("mousedown", (event) => event.preventDefault());
}

for (const stepBtn of document.querySelectorAll(".hp-step")) {
  stepBtn.addEventListener("click", () => {
    const step = Number(stepBtn.dataset.step);
    hpInput.value = (Number(hpInput.value) || 0) + step;
    updateHpActionVisibility();
  });
}
hpInput.addEventListener("input", updateHpActionVisibility);

hpFullBtn.addEventListener("click", () => {
  applyHpDelta(Number(hpInput.value) || 0);
});
hpHalfBtn.addEventListener("click", () => {
  const value = Number(hpInput.value) || 0;
  applyHpDelta(Math.trunc(value / 2), "half");
});
hpDoubleBtn.addEventListener("click", () => {
  applyHpDelta((Number(hpInput.value) || 0) * 2, "double");
});
hpHealBtn.addEventListener("click", () => {
  applyHpDelta(Number(hpInput.value) || 0);
});
hpTempBtn.addEventListener("click", () => {
  applyTempHp(Number(hpInput.value) || 0);
});

hpCloseBtn.addEventListener("click", () => hpDialog.close());

// ---------------------------------------------------------------------------
// Condition picker. Lists every PF2e condition; clicking one TOGGLES it on
// the entity, so the same list both applies and removes. That's why there's
// no per-row delete button in the stat panel — the checkbox there suppresses
// a condition without forgetting its tier, and removal lives here.
//
// The dialog stays open after a click: applying several conditions at once
// is the normal case (a creature that's frightened, sickened and prone),
// and reopening the picker for each would be tedious.

let conditionDialogEntityId = null;
let conditionDialogName = "";

function openConditionDialog(entityId, name) {
  conditionDialogEntityId = entityId;
  conditionDialogName = name;
  conditionDialogTitle.textContent = name;
  conditionFilter.value = "";
  renderConditionOptions();
  conditionDialog.showModal();
  conditionFilter.focus();
}

function renderConditionOptions() {
  const applied = entityConditions(conditionDialogEntityId);
  const effective = effectiveConditions(conditionDialogEntityId);
  const needle = conditionFilter.value.trim().toLowerCase();

  const matches = Object.entries(PF2E_CONDITIONS).filter(([id, definition]) =>
    !needle
    || definition.name.toLowerCase().includes(needle)
    || definition.summary.toLowerCase().includes(needle));

  conditionOptions.innerHTML = matches.length
    ? matches.map(([id, definition]) => {
        // Already in effect but not applied by hand (encumbered's clumsy):
        // say where it came from, so the list doesn't read as "not applied"
        // for something the panel behind the dialog is clearly showing.
        // Clicking it still applies it directly, which is what a DM
        // stacking a real clumsy on top of an encumbered one wants.
        const grantedBy = !applied[id] ? (effective[id]?.grantedBy ?? []) : [];
        const note = grantedBy.length
          ? ` <em>(from ${escapeHtml(grantedBy.map((from) => PF2E_CONDITIONS[from]?.name ?? from).join(", "))})</em>`
          : "";
        return `
        <li>
          <button type="button" class="battle-condition-option${applied[id] ? " applied" : ""}${grantedBy.length ? " granted" : ""}" data-condition="${id}">
            <span class="battle-condition-option-name">${escapeHtml(definition.name)}${definition.valued ? " <em>(has tier)</em>" : ""}${note}</span>
            <span class="battle-condition-option-summary">${escapeHtml(definition.summary)}</span>
          </button>
        </li>`;
      }).join("")
    : '<li class="placeholder">No condition matches that.</li>';

  for (const btn of conditionOptions.querySelectorAll(".battle-condition-option")) {
    btn.addEventListener("click", () => {
      const id = btn.dataset.condition;
      if (entityConditions(conditionDialogEntityId)[id]) {
        removeCondition(conditionDialogEntityId, id, conditionDialogName);
      } else {
        addCondition(conditionDialogEntityId, id, conditionDialogName);
      }
      // dispatch() re-rendered the stat panel behind the dialog; this
      // refreshes the "applied" ticks in the still-open list.
      renderConditionOptions();
    });
  }
}

conditionFilter.addEventListener("input", renderConditionOptions);
conditionCloseBtn.addEventListener("click", () => conditionDialog.close());

// ---------------------------------------------------------------------------
// Character picker. A toggle list, like the condition dialog: clicking an
// added character takes them back out, so a mis-click is one click to fix.
// Grouped by the main page's groups, since that's where a DM filed them.

function renderCharacterOptions() {
  const inBattle = new Set(battleCharacterIds());
  const placed = new Set(Object.values(battleState.placements));
  const needle = characterFilter.value.trim().toLowerCase();

  const sections = charactersByGroup()
    .map(({ name, characters }) => ({
      name,
      characters: characters.filter((c) => !needle || c.name.toLowerCase().includes(needle)),
    }))
    .filter((section) => section.characters.length);

  if (!sections.length) {
    characterOptions.innerHTML = loadCharacters().length
      ? '<li class="placeholder">No character matches that.</li>'
      : '<li class="placeholder">No characters saved yet — add one on the main page first.</li>';
    return;
  }

  characterOptions.innerHTML = sections.map(({ name, characters }) => `
    <li class="battle-character-group">${escapeHtml(name)}</li>
    ${characters.map((c) => {
      const added = inBattle.has(c.id);
      // A character standing on the map can't be un-picked here without
      // silently pulling their token off, so the row says so instead of
      // doing it. Taking them off the field first re-enables it.
      const onField = placed.has(c.id);
      const title = !added
        ? `Add ${escapeHtml(c.name)} to this battle`
        : onField
          ? `${escapeHtml(c.name)} is on the field — remove their token first`
          : `Take ${escapeHtml(c.name)} out of this battle`;
      return `
      <li class="battle-monster-row">
        <button type="button" class="battle-monster-option${added ? " applied" : ""}" data-character-id="${escapeHtml(c.id)}"${added && onField ? " disabled" : ""} title="${title}">
          <span class="battle-monster-option-name">${escapeHtml(c.name)}</span>
          ${added ? '<span class="battle-monster-count">&check;</span>' : ""}
        </button>
      </li>`;
    }).join("")}`).join("");
}

characterOptions.addEventListener("click", (event) => {
  const option = event.target.closest(".battle-monster-option");
  if (!option || option.disabled) return;
  const id = option.dataset.characterId;
  const character = loadCharacters().find((c) => c.id === id);
  if (!character) return;
  if (battleCharacterIds().includes(id)) removeCharacterFromBattle(id, character.name);
  else addCharacterToBattle(id, character.name);
  // dispatch() re-rendered the roster behind the backdrop; this refreshes
  // the ticks in the still-open list.
  renderCharacterOptions();
});

characterFilter.addEventListener("input", renderCharacterOptions);
characterCloseBtn.addEventListener("click", () => characterDialog.close());

addCharacterBtn.addEventListener("click", () => {
  characterFilter.value = "";
  renderCharacterOptions();
  characterDialog.showModal();
  characterFilter.focus();
});

// ---------------------------------------------------------------------------
// Monster picker. Stays open after a pick, like the condition dialog and for
// the same reason: adding four goblins at once is the normal case, and
// reopening the list for each would be tedious.

// The full list is ~560 entries. Unlike the 42-row condition picker, this
// one delegates its clicks to the <ul> and caps how many rows it draws —
// attaching hundreds of listeners on every keystroke is work with nothing
// to show for it, and nobody reads past the first screenful anyway.
const MONSTER_OPTIONS_SHOWN = 60;

// How many of each monster are already in this battle. The dialog is
// modal, so the roster updating behind it is hidden by the backdrop —
// without this, clicking a monster looks like it did nothing. Counts by
// the statblock reference, not the name, so renaming "Goblin Warrior 2"
// to "Sneaky Pete" doesn't make the tally lie.
function monsterCounts() {
  const counts = new Map();
  for (const object of Object.values(battleState.customObjects)) {
    if (!object.monster) continue;
    counts.set(object.monster, (counts.get(object.monster) ?? 0) + 1);
  }
  return counts;
}

function renderMonsterOptions() {
  const counts = monsterCounts();
  const needle = monsterFilter.value.trim().toLowerCase();
  const matches = needle
    ? monsterList.filter((m) => m.name.toLowerCase().includes(needle))
    : monsterList;

  if (!monsterList.length) {
    monsterOptions.innerHTML = '<li class="placeholder">Monster list unavailable.</li>';
    return;
  }
  if (!matches.length) {
    monsterOptions.innerHTML = '<li class="placeholder">No monster matches that.</li>';
    return;
  }

  // Two sibling buttons rather than a "Stats" control nested inside the
  // row button: nested interactive elements are invalid HTML, and a
  // <button> inside a <button> gets reparented by the parser outright.
  const shown = matches.slice(0, MONSTER_OPTIONS_SHOWN);
  const more = matches.length - shown.length;
  monsterOptions.innerHTML = shown.map((m) => {
    const count = counts.get(m.name) ?? 0;
    return `
    <li class="battle-monster-row">
      <button type="button" class="battle-monster-option${count ? " added" : ""}" data-monster="${escapeHtml(m.name)}" title="Add ${escapeHtml(m.name)} to the roster">
        <span class="battle-monster-option-name">${escapeHtml(m.name)}</span>
        ${count ? `<span class="battle-monster-count">&times;${count}</span>` : ""}
      </button>
      <button type="button" class="battle-monster-preview" data-monster="${escapeHtml(m.name)}" title="Open the ${escapeHtml(m.name)} statblock">Stats</button>
    </li>`;
  }).join("")
    + (more ? `<li class="placeholder">…and ${more} more — keep typing to narrow it down.</li>` : "");
}

// Delegated to the <ul>: the list is redrawn on every keystroke, and
// attaching two listeners per row each time is work with nothing to show
// for it. Preview is checked first only for readability — the two buttons
// are siblings, so neither click can reach the other.
monsterOptions.addEventListener("click", (event) => {
  const preview = event.target.closest(".battle-monster-preview");
  if (preview) {
    openAonPopup(monsterUrl(preview.dataset.monster), preview.dataset.monster);
    return;
  }
  const option = event.target.closest(".battle-monster-option");
  if (option) {
    addMonster(option.dataset.monster);
    // dispatch() re-rendered the roster behind the backdrop; this refreshes
    // the count badges in the still-open list, the same way the condition
    // picker refreshes its applied ticks.
    renderMonsterOptions();
  }
});

monsterFilter.addEventListener("input", renderMonsterOptions);
monsterCloseBtn.addEventListener("click", () => monsterDialog.close());

addMonsterBtn.addEventListener("click", () => {
  monsterFilter.value = "";
  renderMonsterOptions();
  monsterDialog.showModal();
  monsterFilter.focus();
});

// ---------------------------------------------------------------------------
// Copy/paste, over the roster and the initiative track. UI-only state, like
// selection: a clipboard isn't part of the battle, and undoing a copy would
// be baffling. Pasting IS a battle change and dispatches.
//
// What's copied is a *description* — the base name and the statblock
// reference — not an entity id. Copy a goblin, delete it, paste: you still
// get a goblin. An id would dangle.
//
// Characters are deliberately not duplicable. There is one Tumb; his sheet
// lives in the main app's store, and a second battle-local "Tumb 2" would
// be a name with no stats behind it, which is worse than nothing. Copying
// one is allowed and does something useful anyway — see pasteEntity().
let clipboard = null; // { baseName, monster, isCharacter, characterId, sourceName }
let clipboardSourceId = null; // for the roster's "copied" highlight — UI-only

// "Goblin Warrior 4" -> "Goblin Warrior", so pasting a copy continues the
// series rather than producing "Goblin Warrior 4 2". A custom object the DM
// literally named "Pillar 2" bases to "Pillar" too, which is the same
// intent read a different way.
function baseEntityName(name) {
  return name.replace(/\s+\d+$/, "").trim() || name;
}

// The entity a copy would take: a roster row armed for placement, or
// whatever is on the selected square. Roster first — arming one is the more
// deliberate act, and it's how you reach something that isn't on the map.
function copyTargetId() {
  if (armedEntityId) return armedEntityId;
  return selectedSquareKey ? battleState.placements[selectedSquareKey] ?? null : null;
}

function copyEntity() {
  const id = copyTargetId();
  const entity = id ? findEntity(id) : null;
  if (!entity) return false;
  clipboard = {
    baseName: entity.monsterName ?? baseEntityName(entity.name),
    monster: entity.monsterName,
    isCharacter: !entity.isCustom,
    characterId: entity.isCustom ? null : entity.id,
    sourceName: entity.name,
  };
  clipboardSourceId = id;
  render();
  return true;
}

function pasteEntity() {
  if (!clipboard) return false;

  // A character can't be duplicated, so pasting one puts THEM in the
  // battle instead — which makes Ctrl+C/Ctrl+V a way to carry someone from
  // one battle tab to another, the only thing copying a character could
  // usefully mean.
  if (clipboard.isCharacter) {
    if (!loadCharacters().some((c) => c.id === clipboard.characterId)) return false;
    if (battleCharacterIds().includes(clipboard.characterId)) return false;
    addCharacterToBattle(clipboard.characterId, clipboard.sourceName);
    return true;
  }

  const id = `custom-${crypto.randomUUID()}`;
  const name = uniqueEntityName(clipboard.baseName);
  const monster = clipboard.monster;
  dispatch("paste-entity", `Added ${name} to the roster`, (state) => {
    state.customObjects[id] = monster ? { name, monster } : { name };
  });
  return true;
}

// ---------------------------------------------------------------------------
// Renaming a creature on the initiative track. Battle-local entities only:
// a character's name lives on their sheet in the main app's store, which
// this page only ever reads.

let renameEntityId = null;

function openEntityRenameDialog(entityId) {
  const entity = findEntity(entityId);
  if (!entity?.isCustom) return;
  renameEntityId = entityId;
  entityRenameInput.value = entity.name;
  entityRenameDialog.showModal();
  entityRenameInput.select();
}

entityRenameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const entity = findEntity(renameEntityId);
  const name = entityRenameInput.value.trim();
  if (entity && name && name !== entity.name) {
    const id = renameEntityId;
    dispatch("rename-entity", `Renamed ${entity.name} to ${name}`, (state) => {
      // Spread rather than assigning .name, so a monster keeps its
      // `monster` statblock reference through the rename.
      state.customObjects[id] = { ...state.customObjects[id], name };
    });
  }
  entityRenameDialog.close();
});

entityRenameCloseBtn.addEventListener("click", () => entityRenameDialog.close());

// ---------------------------------------------------------------------------
// Initiative dialog. Opened from the small clickable value box on an
// initiative-track row (works for characters and custom objects alike,
// since initiative isn't part of a character's sheet data). Setting or
// clearing it is the only battle-state change here, so it's the only part
// that dispatches — opening/closing the dialog and staging the input are
// UI-only, the same split as the HP dialog.

function openInitiativeDialog(entityId, name) {
  initiativeDialogEntityId = entityId;
  initiativeDialogName.textContent = name;
  const current = battleState.initiative[entityId];
  initiativeInput.value = current != null ? current : "";
  initiativeDialog.showModal();
}

initiativeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const entityId = initiativeDialogEntityId;
  const entity = findEntity(entityId);
  if (!entity) {
    initiativeDialog.close();
    return;
  }

  const raw = initiativeInput.value.trim();
  if (raw === "") {
    dispatch("set-initiative", `Cleared ${entity.name}'s initiative`, (state) => {
      delete state.initiative[entityId];
    });
  } else {
    const value = Number(raw);
    if (Number.isNaN(value)) return;
    dispatch("set-initiative", `Set ${entity.name}'s initiative to ${value}`, (state) => {
      state.initiative[entityId] = value;
    });
  }
  initiativeDialog.close();
});

initiativeCloseBtn.addEventListener("click", () => initiativeDialog.close());

// ---------------------------------------------------------------------------
// Interaction

// A pointer event's position in logical grid pixels, with (0, 0) at the
// grid's top-left corner. The one place that inverts drawGrid()'s mapping,
// so a change to how the canvas is sized can't be applied to square
// picking and forgotten for wall picking (which is exactly what CANVAS_PAD
// would otherwise have caused).
//
// Deliberately NOT via canvas.width/height: the bitmap is oversampled by
// zoom x devicePixelRatio, so that ratio would land on device pixels
// rather than the SQUARE_SIZE-based coordinates callers want. And the
// element spans the grid PLUS a CANVAS_PAD margin on each side, so the
// ratio is taken against that larger box with the pad subtracted after.
function gridPointFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  const padded = CANVAS_PAD * 2;
  return {
    x: (event.clientX - rect.left) * ((gridCols() * SQUARE_SIZE + padded) / rect.width) - CANVAS_PAD,
    y: (event.clientY - rect.top) * ((gridRows() * SQUARE_SIZE + padded) / rect.height) - CANVAS_PAD,
  };
}

function squareFromEvent(event) {
  const { x, y } = gridPointFromEvent(event);
  // Offset back into absolute board coordinates, which is what placements
  // and walls are keyed by.
  const col = gridOriginCol() + Math.floor(x / SQUARE_SIZE);
  const row = gridOriginRow() + Math.floor(y / SQUARE_SIZE);
  if (!inGridBounds(row, col)) return null;
  return { row, col };
}

// A token move: distance uses PF2e's real diagonal-alternating rule (not
// straight-line/Euclidean), logged alongside the start/end square
// coordinates so the log line is useful for tracking actual movement
// spent, not just "something moved somewhere."
function moveToken(fromKey, toKey) {
  const entityId = battleState.placements[fromKey];
  const entity = findEntity(entityId);
  if (!entity) return;

  const [fromRow, fromCol] = fromKey.split(",").map(Number);
  const [toRow, toCol] = toKey.split(",").map(Number);
  // The distance actually walked, routed around walls, rather than the
  // straight-line figure — that's the number a DM is spending movement on.
  // With no route at all (fully walled off) the move is still allowed, in
  // case the DM is placing something that ignores walls, but the log says
  // so rather than quietly reporting a distance nothing could travel.
  const path = findPath(fromKey, toKey);
  const feet = path ? path[path.length - 1].feet : pf2eDistanceFeet(toRow - fromRow, toCol - fromCol);
  const note = path ? "" : " (no walkable route)";

  dispatch(
    "move-token",
    `Moved ${entity.name} ${feet} ft${note}, from (${fromCol}, ${fromRow}) to (${toCol}, ${toRow})`,
    (state) => {
      delete state.placements[fromKey];
      state.placements[toKey] = entityId;
    }
  );
  selectedSquareKey = toKey;
}

// Counts what already ends at one corner of the grid — walls, doors and
// neighbouring cells' diagonals alike. (r, c) is a grid POINT, not a cell,
// so the keys around it mix the two indexings wallKey() uses: the four
// edges meeting there are "h" left and right of it and "v" above and below,
// while the four diagonals that could end there belong to the four cells it
// touches.
//
// `skipRow`/`skipCol` is the cell being decided. Its own two diagonals are
// exactly what this is choosing between, so letting them vote would make
// the answer depend on the answer.
function cornerLinks(walls, r, c, skipRow, skipCol) {
  let count = 0;
  for (const key of [wallKey("h", r, c - 1), wallKey("h", r, c),
                     wallKey("v", r - 1, c), wallKey("v", r, c)]) {
    if (walls[key]) count++;
  }
  // Offsets from the corner to the cell whose diagonal would end at it:
  // "\" starts at its cell's NW corner and ends at the SE one, "/" runs
  // between the other two.
  for (const [type, dr, dc] of [["b", 0, 0], ["b", -1, -1], ["f", 0, -1], ["f", -1, 0]]) {
    if (r + dr === skipRow && c + dc === skipCol) continue;
    if (walls[wallKey(type, r + dr, c + dc)]) count++;
  }
  return count;
}

// Which way a new diagonal in this cell should run. A diagonal is only ever
// meant to close off a corner, so the useful orientation is the one whose
// two ends meet something: drawn the other way it leaves a gap at both ends
// and crosses the middle of the cell for nothing. Guessing wrong is cheap
// to correct (the centre-zone cycle's next click turns it) but annoying,
// because it's wrong on exactly the cells where the intent was obvious.
//
// A plain count of what each orientation's corners touch, not a search for
// a specific arrangement: a wall along the cell's own top edge ends at both
// top corners and so votes for neither, which is the right answer. Ties keep
// "\", the historical default, so a diagonal in open space is unchanged.
function preferredDiagonal(walls, row, col) {
  const back = cornerLinks(walls, row, col, row, col)
    + cornerLinks(walls, row + 1, col + 1, row, col);
  const forward = cornerLinks(walls, row, col + 1, row, col)
    + cornerLinks(walls, row + 1, col, row, col);
  return forward > back ? "f" : "b";
}

// Decides what a click at a given position WOULD do, without doing it.
// Both the click handler and the hover preview go through this, so the
// preview is incapable of disagreeing with what actually happens — the
// usual failure mode for "show me where this will land" affordances.
// Returns { remove, add } (either may be null), or null if off-grid.
//
// Anywhere inside a cell counts: the square is split into four edge zones
// plus a centre zone, rather than demanding a hit on a few pixels of line.
// Right/bottom resolve to the NEXT cell's left/top edge, which is what
// keeps the canonical "top/left only" keying honest.
function wallActionFromEvent(event) {
  const { x, y } = gridPointFromEvent(event);
  const col = gridOriginCol() + Math.floor(x / SQUARE_SIZE);
  const row = gridOriginRow() + Math.floor(y / SQUARE_SIZE);
  if (!inGridBounds(row, col)) return null;

  const walls = battleState.walls ?? {};
  // Offsets within the cell, so these use the cell's pixel position rather
  // than its (now possibly negative) coordinate.
  const fromLeft = x - pixelX(col);
  const fromTop = y - pixelY(row);
  const fromRight = SQUARE_SIZE - fromLeft;
  const fromBottom = SQUARE_SIZE - fromTop;
  const nearest = Math.min(fromLeft, fromRight, fromTop, fromBottom);

  // Centre of the cell cycles the diagonal: none -> the orientation that
  // fits -> the other one -> none. Three states rather than two so the same
  // spot that changes direction also clears it — otherwise a diagonal could
  // be placed but never removed without a separate control.
  if (nearest > SQUARE_SIZE * WALL_CENTRE_ZONE) {
    // Doors go on cell edges only — there's no sensible doorway through a
    // corner-to-corner diagonal, so the door tool simply has no action in
    // the centre zone (and previews nothing there).
    if (activeTool !== TOOL_WALL) return null;
    const first = wallKey(preferredDiagonal(walls, row, col), row, col);
    const second = wallKey(first[0] === "b" ? "f" : "b", row, col);
    if (walls[first]) return { remove: first, add: second, state: EDGE_WALL };
    if (walls[second]) return { remove: second, add: null, state: null };
    return { remove: null, add: first, state: EDGE_WALL };
  }

  let key;
  if (nearest === fromLeft) key = wallKey("v", row, col);
  else if (nearest === fromRight) key = wallKey("v", row, col + 1);
  else if (nearest === fromTop) key = wallKey("h", row, col);
  else key = wallKey("h", row + 1, col);

  if (activeTool === TOOL_DOOR) {
    // A plain toggle: one cell holds at most one door, and a double door
    // is made by putting a second door on the neighbouring cell rather
    // than by clicking the same edge twice. Starting from a plain wall
    // goes straight to a door — cutting a doorway into an existing wall
    // is the common intent, and the wall tool is right there to clear it.
    return walls[key] === EDGE_DOOR
      ? { remove: key, add: null, state: null }
      : { remove: null, add: key, state: EDGE_DOOR };
  }

  return walls[key]
    ? { remove: key, add: null, state: null }
    : { remove: null, add: key, state: EDGE_WALL };
}

function edgeName(key, state) {
  const type = key[0];
  if (type === "b" || type === "f") return "diagonal wall";
  if (state === EDGE_DOOR) return "door";
  return type === "h" ? "horizontal wall" : "vertical wall";
}

function wallActionLabel({ remove, add, state }, previousState) {
  // Both set means the diagonal cycled from one direction to the other.
  if (remove && add) {
    const [, row, col] = add.split(",");
    return `Turned the diagonal wall at (${col}, ${row})`;
  }
  if (add) {
    const [, row, col] = add.split(",");
    const name = edgeName(add, state);
    return previousState
      ? `Changed the ${edgeName(add, previousState)} at (${col}, ${row}) to a ${name}`
      : `Placed a ${name} at (${col}, ${row})`;
  }
  const [, row, col] = remove.split(",");
  return `Removed the ${edgeName(remove, previousState)} at (${col}, ${row})`;
}

function applyWallAction(action) {
  const { remove, add, state } = action;
  // Read before dispatching so the label can name what was there — same
  // approach as applyHpDelta(), and safe for the same reason.
  const previousState = battleState.walls?.[add ?? remove] ?? null;

  dispatch("toggle-wall", wallActionLabel(action, previousState), (next) => {
    if (!next.walls) next.walls = {};
    if (remove) delete next.walls[remove];
    if (add) next.walls[add] = state;
  });
}

// Traces a wall into the current path without stroking it, mirroring
// traceTokenShape()'s split — the caller sets colour/alpha, so the solid
// walls and the translucent hover preview share one definition of where a
// wall of each type actually sits.
function traceWall(key) {
  const [type, rowStr, colStr] = key.split(",");
  const row = Number(rowStr);
  const col = Number(colStr);
  const x0 = pixelX(col);
  const y0 = pixelY(row);

  ctx.beginPath();
  if (type === "h") {
    // Always centred on its own line, boundary or not. CANVAS_PAD is what
    // makes that safe — an earlier version nudged boundary walls half a
    // thickness inward to keep them from being clipped, which left them
    // visibly sitting inside the first row of squares rather than on the
    // map's edge.
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + SQUARE_SIZE, y0);
  } else if (type === "v") {
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0, y0 + SQUARE_SIZE);
  } else if (type === "b") {
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + SQUARE_SIZE, y0 + SQUARE_SIZE);
  } else {
    ctx.moveTo(x0 + SQUARE_SIZE, y0);
    ctx.lineTo(x0, y0 + SQUARE_SIZE);
  }
}

// Three uneven "rocks" scattered across the square, as one path the caller
// fills — same trace-without-painting split as traceWall(). Deliberately
// asymmetric and off-centre: a neat centred symbol would read as a token
// or a marker placed ON the square, where scattered rubble reads as what
// the square is made of. All geometry is in fractions of SQUARE_SIZE, so
// the icon scales with the grid instead of needing per-zoom sizes.
const TERRAIN_ROCKS = [
  { cx: 0.31, base: 0.66, width: 0.30, height: 0.26 },
  { cx: 0.66, base: 0.57, width: 0.22, height: 0.19 },
  { cx: 0.52, base: 0.85, width: 0.27, height: 0.22 },
];

function traceDifficultTerrain(row, col) {
  const x = pixelX(col);
  const y = pixelY(row);
  ctx.beginPath();
  for (const { cx, base, width, height } of TERRAIN_ROCKS) {
    const half = (width / 2) * SQUARE_SIZE;
    const centreX = x + cx * SQUARE_SIZE;
    const baseY = y + base * SQUARE_SIZE;
    ctx.moveTo(centreX - half, baseY);
    ctx.lineTo(centreX, baseY - height * SQUARE_SIZE);
    ctx.lineTo(centreX + half, baseY);
    ctx.closePath();
  }
}

// Strokes a run along an edge — `from`/`to` are positions along the edge,
// `axis` the fixed perpendicular coordinate. Keeps the horizontal and
// vertical cases from being written out twice for every piece of door.
function strokeAlong(horizontal, axis, from, to) {
  ctx.beginPath();
  if (horizontal) {
    ctx.moveTo(from, axis);
    ctx.lineTo(to, axis);
  } else {
    ctx.moveTo(axis, from);
    ctx.lineTo(axis, to);
  }
  ctx.stroke();
}

// A door panel: a thin rectangle centred on the edge, running from `from`
// to `to` along it.
function panelRect(horizontal, axis, from, to, thickness) {
  const half = thickness / 2;
  return horizontal
    ? [from, axis - half, to - from, thickness]
    : [axis - half, from, thickness, to - from];
}

// Draws whatever occupies one edge — a plain wall, a diagonal, or a
// doorway. Colour and globalAlpha are the caller's, so solid rendering and
// the translucent hover preview share one definition of what each state
// looks like and can't drift apart.
function drawEdgeShape(key, state, color, walls) {
  const type = key[0];
  if (type === "b" || type === "f" || state === EDGE_WALL) {
    ctx.strokeStyle = color;
    ctx.lineWidth = WALL_THICKNESS;
    ctx.lineCap = "round";
    traceWall(key);
    ctx.stroke();
    return;
  }

  const [, rowStr, colStr] = key.split(",");
  const row = Number(rowStr);
  const col = Number(colStr);
  const horizontal = type === "h";
  // Centred on its own line wherever it is, boundary included — see
  // traceWall() and CANVAS_PAD.
  const axis = horizontal ? pixelY(row) : pixelX(col);
  const start = horizontal ? pixelX(col) : pixelY(row);
  const end = start + SQUARE_SIZE;

  // A door magnets toward a door on the neighbouring cell's matching edge,
  // so the two meet on the shared boundary and read as one double door
  // across two cells. The neighbours are the collinear edges either side:
  // for "h" that's the same row line one column over, for "v" the same
  // column line one row over.
  const before = horizontal ? wallKey("h", row, col - 1) : wallKey("v", row - 1, col);
  const after = horizontal ? wallKey("h", row, col + 1) : wallKey("v", row + 1, col);
  const pairedBefore = walls?.[before] === EDGE_DOOR;
  const pairedAfter = walls?.[after] === EDGE_DOOR;

  const length = SQUARE_SIZE * DOOR_LENGTH;
  const slack = SQUARE_SIZE - length;
  // Doors on BOTH sides can't be met at once, so a door in the middle of a
  // run stays centred rather than arbitrarily favouring one neighbour.
  let offset = slack / 2;
  if (pairedBefore && !pairedAfter) offset = 0;
  else if (pairedAfter && !pairedBefore) offset = slack;

  const doorStart = start + offset;
  const doorEnd = doorStart + length;

  // Whatever edge the door doesn't cover is wall. One of these is empty
  // when the door has magneted flush to that end.
  ctx.strokeStyle = color;
  ctx.lineWidth = WALL_THICKNESS;
  ctx.lineCap = "butt";
  if (doorStart > start) strokeAlong(horizontal, axis, start, doorStart);
  if (doorEnd < end) strokeAlong(horizontal, axis, doorEnd, end);

  ctx.lineWidth = DOOR_BORDER;
  ctx.fillStyle = cssVar("--surface");
  const [x, y, w, h] = panelRect(horizontal, axis, doorStart, doorEnd, DOOR_THICKNESS);
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.fill();
  ctx.stroke();
}

function cellInside(row, col, originRow, originCol, rows, cols) {
  return row >= originRow && row < originRow + rows
    && col >= originCol && col < originCol + cols;
}

// Drops walls that a resize left off the board. Their valid ranges differ
// by type, which is the one subtlety: an "h" wall's ROW is an edge index
// running originRow..originRow+rows inclusive — one more value than there
// are cells, since a row of cells has a line above and below — while its
// column is an ordinary cell index. "v" is the mirror image. Diagonals
// ("b"/"f") sit inside a cell, so both of their components are cell
// indices.
//
// Iterated as entries, not keys: the value is the edge's state, and
// rebuilding with `true` would quietly demote every door to a wall.
function pruneWalls(walls, originRow, originCol, rows, cols) {
  const kept = {};
  for (const [key, state] of Object.entries(walls ?? {})) {
    const [type, rowStr, colStr] = key.split(",");
    const row = Number(rowStr);
    const col = Number(colStr);
    const rowLimit = originRow + rows + (type === "h" ? 1 : 0);
    const colLimit = originCol + cols + (type === "v" ? 1 : 0);
    if (row >= originRow && row < rowLimit && col >= originCol && col < colLimit) {
      kept[key] = state;
    }
  }
  return kept;
}

// The four +/- controls around the map. Resizing is a real battle-state
// change (Rule 1), so it dispatches — and it dispatches ONCE, covering the
// new size, the new origin, and any tokens evicted by a removed row or
// column, so a single Ctrl+Z restores all of it together rather than
// leaving a half-undone board.
function resizeGrid(side, delta) {
  const horizontal = side === "left" || side === "right";
  const current = horizontal ? gridCols() : gridRows();
  const next = current + delta;
  if (next < MIN_GRID || next > MAX_GRID) return;

  // Editing the top/left edge moves the ORIGIN instead of renumbering
  // anything: the square that was (0, 0) stays (0, 0), and squares added
  // beyond it simply take negative coordinates. Bottom/right edits leave
  // the origin alone. Nothing on the board is ever renumbered, so a token's
  // coordinates never change because the DM added room beside it.
  const leading = side === "left" || side === "top";
  const nextOriginRow = !horizontal && leading ? gridOriginRow() - delta : gridOriginRow();
  const nextOriginCol = horizontal && leading ? gridOriginCol() - delta : gridOriginCol();
  const nextRows = horizontal ? gridRows() : next;
  const nextCols = horizontal ? next : gridCols();

  // Shrinking can leave placements and walls off the board; those are
  // dropped. This is the whole payoff of anchoring coordinates — the old
  // version had to renumber every key on a top/left edit while getting the
  // edge-index vs cell-index asymmetry right, and now nothing moves at all.
  const nextPlacements = {};
  const dropped = [];
  for (const [key, entityId] of Object.entries(battleState.placements)) {
    const [row, col] = key.split(",").map(Number);
    if (cellInside(row, col, nextOriginRow, nextOriginCol, nextRows, nextCols)) nextPlacements[key] = entityId;
    else dropped.push(entityId);
  }

  const nextWalls = pruneWalls(battleState.walls, nextOriginRow, nextOriginCol, nextRows, nextCols);
  // Terrain is keyed by square, so unlike walls it needs no edge-index vs
  // cell-index care — the same cellInside() test the placements above use.
  const nextTerrain = {};
  for (const [key, kind] of Object.entries(battleState.terrain ?? {})) {
    const [row, col] = key.split(",").map(Number);
    if (cellInside(row, col, nextOriginRow, nextOriginCol, nextRows, nextCols)) nextTerrain[key] = kind;
  }

  // Names read before dispatching, so the log line can say who left —
  // same approach as applyHpDelta() reading temp HP up front. Safe because
  // nothing can mutate state between here and the mutator (JS is
  // single-threaded), and the label has to be a plain string by then.
  const droppedNames = dropped.map((id) => findEntity(id)?.name).filter(Boolean);
  const unit = horizontal ? "column" : "row";
  let label = delta > 0 ? `Added a ${unit} on the ${side}` : `Removed the ${side} ${unit}`;
  if (droppedNames.length) label += ` (${droppedNames.join(", ")} left the field)`;

  // UI-only state, updated before the dispatch so its render() sees the
  // final picture. The selected square keeps its coordinates now that
  // nothing is renumbered — it only clears if it fell off the board.
  for (const entityId of dropped) raisedShieldIds.delete(entityId);
  if (selectedSquareKey) {
    const [row, col] = selectedSquareKey.split(",").map(Number);
    if (!cellInside(row, col, nextOriginRow, nextOriginCol, nextRows, nextCols)) selectedSquareKey = null;
  }

  dispatch("resize-grid", label, (state) => {
    state.placements = nextPlacements;
    state.walls = nextWalls;
    state.terrain = nextTerrain;
    state.originRow = nextOriginRow;
    state.originCol = nextOriginCol;
    if (horizontal) state.cols = next;
    else state.rows = next;
    for (const entityId of dropped) {
      delete state.hp[entityId];
      delete state.tempHp[entityId];
      delete state.conditions[entityId];
      delete state.spellSlots[entityId];
      delete state.initiative[entityId];
      // Appearance deliberately survives, exactly as it does for a normal
      // remove-token — it's the entity's visual identity, not battle
      // progress (see the battle-helper-architecture skill).
    }
    if (dropped.length) {
      state.initiativeOrder = state.initiativeOrder.filter((id) => !dropped.includes(id));
    }
  });
}

const gridControlButtons = [...document.querySelectorAll(".battle-grid-btn")];

// Static markup, so these bind once rather than per render — unlike the
// roster/initiative rows, nothing rebuilds these buttons.
for (const btn of gridControlButtons) {
  btn.addEventListener("click", () => resizeGrid(btn.dataset.side, Number(btn.dataset.delta)));
}

function renderGridControls() {
  for (const btn of gridControlButtons) {
    const delta = Number(btn.dataset.delta);
    const horizontal = btn.dataset.side === "left" || btn.dataset.side === "right";
    const next = (horizontal ? gridCols() : gridRows()) + delta;
    btn.disabled = next < MIN_GRID || next > MAX_GRID;
  }
}

const toolButtons = [...document.querySelectorAll(".battle-tool-btn")];

// Shared by the palette buttons and the digit hotkeys, so picking an
// instrument means the same thing however you did it.
function selectTool(tool) {
  if (!tool || activeTool === tool) return;
  activeTool = tool;
  // A roster entity armed for placement is meaningless once the map
  // stops placing tokens, and would silently fire on the first click
  // after switching back. Disarm on any tool change.
  armedEntityId = null;
  // The preview belongs to the wall tool; leaving it up after switching
  // to select would advertise an edit that clicking no longer performs.
  wallHoverPos = null;
  wallHoverSig = null;
  render();
}

for (const btn of toolButtons) {
  btn.addEventListener("click", () => selectTool(btn.dataset.tool));
}

function renderToolControls() {
  for (const btn of toolButtons) {
    btn.classList.toggle("active", btn.dataset.tool === activeTool);
  }
  // Drives the canvas cursor (crosshair while editing edges) from CSS
  // rather than an inline style, so it doesn't fight the "grabbing" that
  // panning sets and clears inline mid-drag.
  canvas.classList.toggle("tool-edit", isMapEditTool());
}

const zoomButtons = [...document.querySelectorAll(".battle-zoom-btn")];
const zoomResetBtn = document.getElementById("battle-zoom-reset");

for (const btn of zoomButtons) {
  btn.addEventListener("click", () => {
    const action = btn.dataset.zoom;
    if (action === "reset") fitMapToView();
    else setZoom(zoom + (action === "in" ? ZOOM_STEP : -ZOOM_STEP));
  });
}

function renderZoomControls() {
  for (const btn of zoomButtons) {
    const action = btn.dataset.zoom;
    if (action === "in") btn.disabled = zoom >= ZOOM_MAX;
    else if (action === "out") btn.disabled = zoom <= ZOOM_MIN;
    // Nothing left to do only when the map both fits and is centred —
    // being at fit zoom but panned away is still worth a click.
    else btn.disabled = zoom === fitZoom() && !panX && !panY;
  }
  // The reset button is a symbol, so the current level lives in its
  // tooltip — otherwise nothing on screen says what zoom you're at.
  zoomResetBtn.title = `Fit the whole map in view (now ${Math.round(zoom * 100)}%)`;
}

// Map drag-and-drop is mouse-based, not native HTML5 DnD — canvas has no
// per-square element to make draggable="true". mousedown only arms a
// potential drag (an occupied square, and not while a roster entity is
// armed for placement); it only becomes a real drag once mousemove
// crosses DRAG_THRESHOLD, so a plain click still reaches the click
// handler below unaffected. mouseup is on window, not canvas, so a drag
// that ends outside the grid still cleanly cancels instead of getting
// stuck.
//
// Bound to the viewport rather than the canvas so the blank space around
// the map is a pan handle too — with a small or panned-away map that space
// is most of the box, and having to hunt for the map to grab it was the
// gesture's most annoying limitation. squareFromEvent() measures from the
// canvas's own rect, so it keeps working from a viewport-level event and
// simply returns null out there.
mapViewport.addEventListener("mousedown", (event) => {
  // Left button only. Right-drag has no meaning here, and arming a pan on
  // it would leave one running underneath the context menu.
  if (event.button !== 0) return;
  // A roster entity armed for placement suppresses both gestures — the
  // next click is meant to drop it, not to move a token or the view.
  if (armedEntityId) return;

  // The wall tool never drags tokens — a press is either a wall placement
  // (on release, if it didn't move) or a pan, so fall through to the pan
  // arming below regardless of what's on the square.
  const square = squareFromEvent(event);
  if (square && activeTool === TOOL_SELECT) {
    const key = squareKey(square.row, square.col);
    if (battleState.placements[key]) {
      dragFromKey = key;
      dragStartPos = { x: event.clientX, y: event.clientY };
      dragMoved = false;
      return;
    }
  }

  // Empty square, any square with an edge tool, or the blank space outside
  // the map entirely: grab the map itself.
  panFrom = { x: panX, y: panY };
  panStartPos = { x: event.clientX, y: event.clientY };
  panMoved = false;
});

// Hover preview for the wall tool. Suppressed mid-pan — the map is moving
// under the cursor, so a preview pinned to a square would just flicker.
// Redraws only when the previewed action actually changes, not on every
// pixel of movement.
canvas.addEventListener("mousemove", (event) => {
  if (!isEdgeTool() || panFrom) {
    clearWallHover();
    return;
  }
  wallHoverPos = { clientX: event.clientX, clientY: event.clientY };
  const sig = wallActionSignature(wallActionFromEvent(event));
  if (sig === wallHoverSig) return;
  wallHoverSig = sig;
  drawGrid();
});

canvas.addEventListener("mouseleave", clearWallHover);

// Wheel zooms rather than scrolling the viewport. Panning is already
// covered by dragging empty space, so the wheel is free for the thing
// there's otherwise no quick gesture for. Bound to the viewport, not the
// canvas, so it still works over the empty space around a small map.
//
// passive: false because the handler calls preventDefault() — wheel
// listeners default to passive, where preventDefault() is ignored and the
// whole page would scroll underneath the zoom.
mapViewport.addEventListener("wheel", (event) => {
  event.preventDefault();
  // Sign only: trackpads and mice report wildly different magnitudes, so
  // one notch is one ZOOM_STEP either way rather than something
  // proportional that flies off at a flick.
  const direction = event.deltaY < 0 ? 1 : -1;
  setZoom(zoom + direction * ZOOM_STEP, event);
}, { passive: false });

// On window, not the canvas: a pan that wanders outside the grid (very
// easy, since panning is how you reach off-screen parts of it) should keep
// tracking rather than freezing at the edge.
window.addEventListener("mousemove", (event) => {
  if (!panFrom) return;
  const dx = event.clientX - panStartPos.x;
  const dy = event.clientY - panStartPos.y;
  if (!panMoved) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    panMoved = true;
    // A class, not an inline style: the canvas has cursor rules of its own
    // (pointer, or crosshair under an edge tool) that an inline style on
    // the viewport wouldn't beat, since it isn't their element.
    mapViewport.classList.add("panning");
  }
  // The map travels with the hand — drag right and what was off the left
  // edge comes into view. Note this is the opposite sign to the scroll
  // offset this replaced, where moving the viewport right moved the map
  // left.
  setPan(panFrom.x + dx, panFrom.y + dy);
});

window.addEventListener("mouseup", () => {
  if (!panFrom) return;
  panFrom = null;
  panStartPos = null;
  mapViewport.classList.remove("panning");
  // Same one-tick backstop as the token drag: the click that follows this
  // mouseup needs to still see panMoved === true to suppress itself, and
  // if the release happened off-canvas no click fires at all, so this is
  // what stops the flag sticking and swallowing the next real click.
  setTimeout(() => { panMoved = false; }, 0);
});

canvas.addEventListener("mousemove", (event) => {
  if (!dragFromKey) return;
  if (!dragMoved) {
    const dx = event.clientX - dragStartPos.x;
    const dy = event.clientY - dragStartPos.y;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    dragMoved = true;
    canvas.style.cursor = "grabbing";
  }
  const square = squareFromEvent(event);
  const nextHover = square ? squareKey(square.row, square.col) : null;
  if (nextHover !== dragHoverKey) {
    dragHoverKey = nextHover;
    // Only on an actual square change — a full search on every mouse move
    // would be wasted work, and the route can't change without it.
    dragPath = dragHoverKey ? findPath(dragFromKey, dragHoverKey) : null;
  }
  drawGrid();
});

window.addEventListener("mouseup", (event) => {
  if (!dragFromKey) return;
  if (dragMoved) {
    const square = squareFromEvent(event);
    const targetKey = square ? squareKey(square.row, square.col) : null;
    if (targetKey && targetKey !== dragFromKey && !battleState.placements[targetKey]) {
      moveToken(dragFromKey, targetKey);
    }
  }
  dragFromKey = null;
  dragHoverKey = null;
  dragPath = null;
  canvas.style.cursor = "";
  render();
  // Cleared a tick after mouseup, not immediately: the browser still
  // fires "click" on canvas right after this if the drag started and
  // ended on it, and that handler needs to see dragMoved as true to
  // suppress itself. If mouseup happened outside the canvas (no click
  // will ever fire to do that reset), this timeout is what prevents
  // dragMoved from staying stuck true and swallowing the next real click.
  setTimeout(() => { dragMoved = false; }, 0);
});

canvas.addEventListener("click", (event) => {
  // A completed token drag or map pan also fires click on the canvas —
  // without this, releasing a pan would additionally select whatever
  // square you happened to let go over.
  if (dragMoved || panMoved) {
    dragMoved = false;
    panMoved = false;
    return;
  }

  // The terrain tool targets a whole square, so it needs none of the
  // edge-proximity work below — just the square under the cursor.
  if (activeTool === TOOL_TERRAIN) {
    const square = squareFromEvent(event);
    if (square) toggleDifficultTerrain(squareKey(square.row, square.col));
    return;
  }

  // The edge tools take the click before any placement/selection logic —
  // with one active, the map edits terrain and nothing else.
  if (isEdgeTool()) {
    const action = wallActionFromEvent(event);
    if (action) {
      wallHoverPos = { clientX: event.clientX, clientY: event.clientY };
      // Dropped so the next mousemove is guaranteed to re-evaluate: the
      // action under a stationary cursor changes as a result of this click.
      wallHoverSig = null;
      applyWallAction(action);
    }
    return;
  }

  const square = squareFromEvent(event);
  if (!square) return;
  const key = squareKey(square.row, square.col);

  if (armedEntityId) {
    // The render() is needed even when placeEntity() dispatched one of its
    // own: disarming is UI-only state, and a rejected placement (occupied
    // square) wouldn't otherwise clear the row's armed highlight.
    placeEntity(armedEntityId, key);
    armedEntityId = null;
    render();
    return;
  }

  // Selecting a square (empty or occupied) to inspect it is UI-only — not
  // an event, per the battle-helper-architecture skill.
  selectedSquareKey = key;
  render();
});

// The map as a drop target for roster rows. dragover's preventDefault() is
// what makes it one at all — without it the browser refuses every drop and
// shows "no entry" across the whole map.
canvas.addEventListener("dragover", (event) => {
  if (!rosterDragId) return;
  event.preventDefault();
  const square = squareFromEvent(event);
  const key = square ? squareKey(square.row, square.col) : null;
  // Says "you can't put it there" on the cursor itself, before the drop —
  // the same answer the green/red square tint gives, in the place the
  // pointer is already looking.
  event.dataTransfer.dropEffect = key && !battleState.placements[key] ? "copy" : "none";
  if (key === dragHoverKey) return;
  dragHoverKey = key;
  // drawGrid(), not render(): re-rendering the roster mid-drag would
  // destroy the row the drag started from and cancel it.
  drawGrid();
});

canvas.addEventListener("dragleave", () => {
  if (!rosterDragId || dragHoverKey === null) return;
  dragHoverKey = null;
  drawGrid();
});

canvas.addEventListener("drop", (event) => {
  if (!rosterDragId) return;
  event.preventDefault();
  const square = squareFromEvent(event);
  const entityId = rosterDragId;
  const key = square ? squareKey(square.row, square.col) : null;
  // Cleared BEFORE placing, so the render() inside dispatch() already sees
  // the drag as over and doesn't paint a target tint on the square the
  // token now occupies.
  rosterDragId = null;
  dragHoverKey = null;
  if (!key || !placeEntity(entityId, key)) render();
});

undoBtn.addEventListener("click", undo);
redoBtn.addEventListener("click", redo);

addObjectForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = addObjectNameInput.value.trim();
  if (!name) return;
  const id = `custom-${crypto.randomUUID()}`;
  dispatch("add-custom-object", `Added ${name} to the roster`, (state) => {
    state.customObjects[id] = { name };
  });
  addObjectNameInput.value = "";
});

// Clears the event LOG itself, not battle state — there's nothing to
// dispatch() here (Rule 1 only governs battleState) and nothing to undo
// afterward, since undo/redo work by walking eventLog, which this empties.
logClearBtn.addEventListener("click", () => {
  eventLog = [];
  cursor = -1;
  persistBattleStore();
  render();
});

// Controls that keep their own edit history, where Ctrl+Z means "undo my
// typing" and has nothing to do with the battle. Checkboxes, colour
// swatches and range sliders are deliberately NOT in this set: they hold
// no text, have no history for the browser to step back through, and
// swallowing the shortcut there would just make it dead while a token's
// colour picker happens to have focus.
function isTextEntry(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === "TEXTAREA") return true;
  if (target.tagName !== "INPUT") return false;
  return !["checkbox", "radio", "color", "range", "button", "submit", "reset"].includes(target.type);
}

// Which side of the map each WASD key grows, matching the four +/- grid
// controls around the box. Shift shrinks instead.
const GRID_KEYS = { w: "top", a: "left", s: "bottom", d: "right" };

// Removes the selected square's occupant from the field — the same action
// as the × in the Character tab, which is where the alternative is.
function deleteSelectedToken() {
  const key = selectedSquareKey;
  const entityId = key ? battleState.placements[key] : null;
  const entity = entityId ? findEntity(entityId) : null;
  if (!entity) return false;
  dispatch("remove-token", `Removed ${entity.name} from the field`, (state) => {
    delete state.placements[key];
    delete state.hp[entityId];
    delete state.tempHp[entityId];
    delete state.conditions[entityId];
    delete state.spellSlots[entityId];
    delete state.initiative[entityId];
    state.initiativeOrder = state.initiativeOrder.filter((id) => id !== entityId);
  });
  raisedShieldIds.delete(entityId);
  selectedSquareKey = null;
  render();
  return true;
}

// Unmodified letters and Delete are only map shortcuts when nothing else
// could want them: not while typing, and not while a dialog is open. A
// modal traps focus but keydown still bubbles to document, so without the
// dialog check, tabbing to a dialog button and pressing "d" would silently
// grow the board behind the backdrop.
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (isTextEntry(event.target)) return;
  if (document.querySelector("dialog[open]")) return;

  if (event.key === "Delete") {
    if (deleteSelectedToken()) event.preventDefault();
    return;
  }

  // Digits pick an instrument by its POSITION in the palette, not from a
  // key-to-tool table: the row of keys then maps onto the row of buttons
  // by construction, and adding or reordering a tool can't leave the two
  // disagreeing. Out-of-range digits fall through to nothing.
  if (event.key >= "1" && event.key <= "9") {
    const btn = toolButtons[Number(event.key) - 1];
    if (btn) {
      event.preventDefault();
      selectTool(btn.dataset.tool);
    }
    return;
  }

  const side = GRID_KEYS[event.key.toLowerCase()];
  if (side) {
    event.preventDefault();
    resizeGrid(side, event.shiftKey ? -1 : 1);
  }
});

document.addEventListener("keydown", (event) => {
  if (!event.ctrlKey) return;
  const key = event.key.toLowerCase();
  if (!["z", "y", "c", "v"].includes(key)) return;

  // Returns BEFORE preventDefault, which is the whole point: the browser's
  // native undo/copy/paste has to still fire so half-typed text can be
  // taken back and a name can be copied out of a field. Battle undo would
  // otherwise reach past the field and revert the last real action instead
  // — the typing isn't in eventLog (staging a value isn't a battle change,
  // per Rule 1), so there'd be nothing on screen to connect the keystroke
  // to what it did.
  if (isTextEntry(event.target)) return;

  // Same deference for a text selection anywhere on the page: if the DM
  // has highlighted a monster's name to paste elsewhere, Ctrl+C means that
  // and not "copy the armed token". Only Ctrl+C — a selection says nothing
  // about what a paste was meant to do.
  if (key === "c" && !window.getSelection().isCollapsed) return;

  // preventDefault only once the shortcut is actually going to do
  // something. A Ctrl+V with an empty clipboard, or a Ctrl+C with nothing
  // selected on the board, falls through to the browser rather than
  // becoming a key that silently does nothing anywhere on the page.
  if (key === "c") {
    if (copyEntity()) event.preventDefault();
    return;
  }
  if (key === "v") {
    if (pasteEntity()) event.preventDefault();
    return;
  }

  event.preventDefault();
  if (key === "y" || event.shiftKey) redo();
  else undo();
});

// ---------------------------------------------------------------------------

const stored = loadBattleStore();
battles = stored.battles;
setActiveBattle(stored.activeBattleId);

render();

// Fetched after the first render, not awaited before it: nothing on screen
// depends on the monster list until the picker is opened, so the page
// shouldn't wait on a network round-trip to draw. A re-render follows in
// case a battle already has monsters placed — their roster rows and stat
// buttons need the list to resolve a URL.
loadMonsterList().then(render);
