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
const statPanel = document.getElementById("battle-stat-panel");
const appearancePanel = document.getElementById("battle-appearance-panel");
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

const addObjectForm = document.getElementById("battle-add-object-form");
const addObjectNameInput = document.getElementById("battle-add-object-name");
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
//   select — click to inspect a square, drag a token to move it (default)
//   wall   — click near a cell edge to toggle a wall on that edge
const TOOL_SELECT = "select";
const TOOL_WALL = "wall";
const TOOL_DOOR = "door";
let activeTool = TOOL_SELECT;

// Both the wall and door tools edit edges and want the same crosshair and
// hover preview; only their click cycles differ.
function isEdgeTool() {
  return activeTool === TOOL_WALL || activeTool === TOOL_DOOR;
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

function setZoom(value) {
  // Rounded to whole percents so repeated +/- steps can't drift onto
  // values like 0.9999999999 and miss the ZOOM_MIN/MAX comparisons.
  const next = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value)) * 100) / 100;
  if (next === zoom) return;
  zoom = next;
  render();
}

// ---------------------------------------------------------------------------
// Battle state: the only things that live behind dispatch()/undo()/redo().
// Everything else below (selectedSquareKey, armedEntityId) is UI-only —
// see the battle-helper-architecture skill for why that split matters.

function emptyBattleState() {
  return { placements: {}, hp: {}, tempHp: {}, customObjects: {}, initiative: {}, initiativeOrder: [], appearance: {}, conditions: {}, walls: {}, cols: MIN_GRID, rows: MIN_GRID, originRow: 0, originCol: 0 };
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

// Panning: grabbing the map by an EMPTY square and dragging the view.
// Distinct from the token drag above — that moves a piece, this moves the
// camera — so it gets its own state and its own click-suppression flag,
// but the same press/threshold/release shape. Implemented as scrolling
// the viewport rather than an offset of our own, so it composes with the
// scrollbars the overflow already provides.
let panFromScroll = null; // { left, top } viewport scroll captured at mousedown
let panStartPos = null; // {x,y} client coords at mousedown
let panMoved = false; // true once movement crossed DRAG_THRESHOLD — suppresses the click that would otherwise select a square

// Raise a Shield is situational, like the main app's AC toggle — it isn't
// baked into the sheet and wouldn't surprise anyone by disappearing on
// undo, so it's UI-only state, not battle state. Kept across renders (a
// plain Set, not rebuilt from HTML) since renderStatPanel() re-renders on
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

// A placement, roster entry, or initiative-track entry can point at either
// a real character (from the main app's store) or a custom object (name
// only, tracked in battleState.customObjects — see the
// battle-helper-architecture skill's "Custom objects" section). This is
// the one place that knows how to resolve either kind by id, so the rest
// of the file can treat them uniformly wherever only a name is needed.
function findEntity(id) {
  const character = loadCharacters().find((c) => c.id === id);
  if (character) return { id, name: character.name, build: character.data?.build ?? null, isCustom: false };
  const custom = battleState.customObjects[id];
  if (custom) return { id, name: custom.name, build: null, isCustom: true };
  return null;
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
      // route's shape decides it.
      const step = diagonal ? (parity === 0 ? 5 : 10) : 5;
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
// maxHp is a parameter (defaulting to the sheet's) rather than always
// recomputed here because drained lowers it — see effectiveMaxHp(). The
// clamp is what makes a drained character's HP drop on screen without
// touching the stored value, so it climbs back when drained ends.
function currentHp(characterId, build, maxHp = computeMaxHp(build)) {
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
  const bitmapWidth = Math.round(width * scale);
  const bitmapHeight = Math.round(height * scale);
  // Assigning canvas.width/height reallocates and clears the bitmap, so
  // only touch it on an actual change — drawGrid() also runs on every
  // mousemove while a token is being dragged.
  if (canvas.width !== bitmapWidth) canvas.width = bitmapWidth;
  if (canvas.height !== bitmapHeight) canvas.height = bitmapHeight;
  canvas.style.width = `${width * zoom}px`;
  canvas.style.height = `${height * zoom}px`;
  // Re-applied every draw, not just on resize: assigning canvas.width
  // resets the context, and the scale changes with zoom anyway.
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

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

  // Every fifth line is drawn heavier, breaking the grid into 5x5 blocks so
  // a large map stays countable at a glance. The two outer lines are always
  // heavy as well, which frames the map — without that a grid whose size
  // isn't a multiple of five (7 wide, say) would get a heavy left border
  // and a hairline right one, which just reads as a mistake.
  //
  // The half-pixel offset puts a 1px stroke on a whole pixel instead of
  // straddling two and blurring; a 2px stroke is crisp centred on a whole
  // pixel instead, hence the offset depending on weight. Either way the
  // line is clamped to keep its full width inside the bitmap: the bitmap
  // spans 0..width, so a line pushed past that edge is clipped away
  // entirely — which is what used to make the right and bottom borders
  // invisible.
  // Heaviness is keyed off the ABSOLUTE coordinate, not the line's index
  // from the edge, so the 5x5 blocks stay pinned to the board. Growing the
  // map leftward slides the heavy lines along with everything else and can
  // leave a partial block at the edge, which is correct: the blocks belong
  // to the board, not to the current viewport. (JS modulo keeps the sign of
  // the dividend, but only === 0 is tested here and -0 === 0, so negative
  // coordinates need no special handling.)
  ctx.strokeStyle = border;
  const gridLinePos = (index, coordinate, count, extent) => {
    const major = coordinate % GRID_MAJOR_EVERY === 0 || index === 0 || index === count;
    const lineWidth = major ? 2 : 1;
    const half = lineWidth / 2;
    const raw = index * SQUARE_SIZE + (major ? 0 : 0.5);
    return { lineWidth, pos: Math.min(Math.max(raw, half), extent - half) };
  };

  for (let col = 0; col <= cols; col++) {
    const { lineWidth, pos } = gridLinePos(col, originCol + col, cols, width);
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(pos, 0);
    ctx.lineTo(pos, height);
    ctx.stroke();
  }
  for (let row = 0; row <= rows; row++) {
    const { lineWidth, pos } = gridLinePos(row, originRow + row, rows, height);
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
      drawEdgeShape(key, state, width, height, cssVar("--text"), effective);
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
        drawEdgeShape(hover.remove, walls[hover.remove], width, height, cssVar(turning ? "--muted" : "--danger"), walls);
      }
      if (hover.add) {
        ctx.globalAlpha = 0.55;
        drawEdgeShape(hover.add, hover.state, width, height, cssVar("--text"), effective);
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
  const characters = loadCharacters().map((c) => ({ id: c.id, name: c.name, isCustom: false }));
  const customs = Object.entries(battleState.customObjects).map(([id, obj]) => ({ id, name: obj.name, isCustom: true }));
  const unplaced = [...characters, ...customs].filter((e) => !placedIds.has(e.id));

  rosterList.innerHTML = unplaced.length
    ? unplaced.map((e) => `
        <li class="battle-roster-item${e.id === armedEntityId ? " armed" : ""}" data-entity-id="${escapeHtml(e.id)}">
          <span class="battle-roster-item-name">${escapeHtml(e.name)}</span>
          ${e.isCustom ? `<button type="button" class="battle-remove-btn battle-roster-delete" data-entity-id="${escapeHtml(e.id)}" title="Delete ${escapeHtml(e.name)}" aria-label="Delete ${escapeHtml(e.name)}">&times;</button>` : ""}
        </li>
      `).join("")
    : '<li class="placeholder">No characters available — add one on the main page, or add a custom object below.</li>';

  for (const li of rosterList.querySelectorAll("[data-entity-id]")) {
    li.addEventListener("click", () => {
      const id = li.dataset.entityId;
      armedEntityId = armedEntityId === id ? null : id;
      render();
    });
  }

  // Only custom objects get a delete button — real characters are managed
  // on the main page, not here. stopPropagation() keeps this from also
  // triggering the <li>'s own click handler (arming it for placement).
  for (const btn of rosterList.querySelectorAll(".battle-roster-delete")) {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const id = btn.dataset.entityId;
      const entity = findEntity(id);
      if (!entity) return;
      dispatch("delete-custom-object", `Deleted ${entity.name}`, (state) => {
        delete state.customObjects[id];
        delete state.initiative[id];
        delete state.appearance[id];
        delete state.conditions[id];
      });
      if (armedEntityId === id) armedEntityId = null;
    });
  }
}

let dragEntityId = null; // entity id currently being dragged in the initiative track — UI-only, not battle state

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
    return `
      <li draggable="true" data-entity-id="${escapeHtml(e.id)}" class="${e.id === selectedEntityId ? "selected" : ""}">
        <span class="battle-initiative-name">${escapeHtml(e.name)}</span>
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

// Shared by both renderStatPanel() branches below (full character panel,
// name-only custom-object panel) so "remove from field" behaves
// identically either way — same event type, same state cleanup.
function bindRemoveButton(entityId, name) {
  document.getElementById("battle-remove-token").addEventListener("click", () => {
    const key = selectedSquareKey;
    dispatch("remove-token", `Removed ${name} from the field`, (state) => {
      delete state.placements[key];
      delete state.hp[entityId];
      delete state.tempHp[entityId];
      delete state.conditions[entityId];
      delete state.initiative[entityId];
      state.initiativeOrder = state.initiativeOrder.filter((id) => id !== entityId);
    });
    raisedShieldIds.delete(entityId);
    selectedSquareKey = null;
    render();
  });
}

function renderStatPanel() {
  if (!selectedSquareKey) {
    statPanel.innerHTML = '<p class="placeholder">Click a square to select it.</p>';
    return;
  }

  const entityId = battleState.placements[selectedSquareKey];
  if (!entityId) {
    statPanel.innerHTML = '<p class="placeholder">Empty square.</p>';
    return;
  }

  const entity = findEntity(entityId);
  if (!entity) {
    statPanel.innerHTML = '<p class="placeholder">Empty square.</p>';
    return;
  }

  // Custom objects (name only, by design) and — as a defensive fallback —
  // any real character missing sheet data get the same minimal panel:
  // just a name and a way to remove them from the field.
  if (!entity.build) {
    statPanel.innerHTML = `
      <div class="battle-stat-header">
        <div class="battle-stat-left">
          <button id="battle-remove-token" class="battle-remove-btn" title="Remove from field" aria-label="Remove from field">&times;</button>
          <div class="battle-stat-identity">
            <span class="battle-stat-name">${escapeHtml(entity.name)}</span>
          </div>
        </div>
      </div>
      <p class="placeholder">${entity.isCustom ? "Custom object — no additional stats." : "No sheet data for this character."}</p>
      <div class="battle-stat-body">
        ${conditionsSectionHtml(entityId)}
      </div>
    `;
    bindRemoveButton(entityId, entity.name);
    // Custom objects get conditions too: a hazard can be broken or take
    // persistent damage, and conditions aren't sheet data — they're battle
    // state that applies to anything on the field, like initiative.
    bindConditionsSection(entityId, entity.name);
    return;
  }

  // Past this point entity.build is guaranteed (the branch above already
  // returned otherwise), so this is always a real character — renamed for
  // readability in the rest of this function, which is character-specific.
  const character = entity;
  const characterId = entityId;
  const build = entity.build;
  const prof = build.proficiencies ?? {};
  const attrs = build.attributes ?? {};
  // Conditions are resolved once for the whole panel — every stat below
  // reads its own entry out of this, rather than each recomputing the
  // grant graph.
  const mods = entityModifiers(characterId, build.level ?? 1);
  const { base: baseMaxHp, max: maxHp } = effectiveMaxHp(characterId, build);
  const hp = currentHp(characterId, build, maxHp);
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
  const { hasShield, shieldBonus } = getAcBonuses(build);
  const shieldRaised = raisedShieldIds.has(characterId);
  // Conditions apply on top of the raised-shield bonus, not instead of it:
  // the shield is a circumstance bonus, so it and a status penalty from
  // e.g. frightened both count. baseAc here is "AC before conditions".
  const baseAc = (Number(build.acTotal?.acTotal) || 0) + (shieldRaised ? shieldBonus : 0);
  const ac = baseAc + mods.ac.total;
  const baseFort = checkTotal(build, prof.fortitude ?? 0, "con");
  const baseReflex = checkTotal(build, prof.reflex ?? 0, "dex");
  const baseWill = checkTotal(build, prof.will ?? 0, "wis");
  const basePerception = checkTotal(build, prof.perception ?? 0, "wis");
  const baseSpeed = (attrs.speed ?? 0) + (attrs.speedBonus ?? 0);
  // Speed can't go below 0 however much is stacked on it, and it's shown
  // as a plain number of feet rather than a signed modifier.
  const speed = Math.max(0, baseSpeed + mods.speed.total);

  // Each save/Perception tile is the same shape, so build them from one
  // list instead of four near-identical lines of template literal.
  const checks = [
    { label: "Fortitude", base: baseFort, modifier: mods.fortitude },
    { label: "Reflex", base: baseReflex, modifier: mods.reflex },
    { label: "Will", base: baseWill, modifier: mods.will },
    { label: "Perception", base: basePerception, modifier: mods.perception },
  ].map(({ label, base, modifier }) => {
    const hint = modifierHint(label, base, modifier);
    return `<div class="battle-stat"><span class="stat-label">${label}</span><span class="stat-value ${modifierClass(modifier)}"${hint ? ` title="${escapeHtml(hint)}"` : ""}>${formatMod(base + modifier.total)}</span></div>`;
  }).join("");

  const acHint = modifierHint("AC", baseAc, mods.ac, String);
  const speedHint = modifierHint("Speed", baseSpeed, mods.speed, String);
  const maxHpHint = modifierHint("Max HP", baseMaxHp, mods.maxHp, String);
  // The AC panel's tooltip already explains the shield toggle; the
  // condition breakdown is appended below it rather than replacing it.
  const acTitle = [hasShield ? `Raise a Shield (+${shieldBonus} AC)` : "AC", acHint].filter(Boolean).join("\n\n");
  const hpTitle = ["Click to adjust HP", maxHpHint].filter(Boolean).join("\n\n");
  // Speed and max HP sit in running text rather than in a .stat-value slot
  // of their own, so they're only wrapped when a condition actually moved
  // them — otherwise they keep exactly the bare-number markup they had
  // before conditions existed, with no empty class attribute.
  const speedText = mods.speed.total
    ? `<span class="${modifierClass(mods.speed)}" title="${escapeHtml(speedHint)}">${speed}</span>`
    : `${speed}`;
  const maxHpText = mods.maxHp.total
    ? `<span class="${modifierClass(mods.maxHp)} on-fill">${maxHp}</span>`
    : `${maxHp}`;

  // Two clusters pinned to opposite edges (identity on the left, HP/AC on
  // the right) rather than one row that stretches the HP bar to fill the
  // gap — an empty center is intentional, not a layout bug. See "Page
  // layout: boxing" in the battle-helper-architecture skill.
  statPanel.innerHTML = `
    <div class="battle-stat-header">
      <div class="battle-stat-left">
        <button id="battle-remove-token" class="battle-remove-btn" title="Remove from field" aria-label="Remove from field">&times;</button>
        <div class="battle-stat-identity">
          <span class="battle-stat-name">${escapeHtml(character.name)}</span>
          <span class="battle-stat-level">Lvl ${build.level ?? 1}</span>
          <span class="battle-stat-speed">Speed ${speedText} ft</span>
        </div>
      </div>
      <div class="battle-stat-right">
        <button type="button" id="battle-hp-bar" class="battle-hp-bar" title="${escapeHtml(hpTitle)}">
          <span class="battle-hp-bar-fill${hpLow ? " low" : ""}" style="width:${hpFillPct}%"></span>
          ${tempHp > 0 ? `<span class="battle-hp-bar-temp-fill" style="left:${hpFillPct}%; width:${tempFillPct}%"></span>` : ""}
          <span class="battle-hp-bar-text">${hp} / ${maxHpText}${tempHp > 0 ? ` (+${tempHp})` : ""}</span>
        </button>
        <button type="button" id="battle-toggle-shield" class="battle-stat-ac${shieldRaised ? " active" : ""}" title="${escapeHtml(acTitle)}" ${hasShield ? "" : "disabled"}>
          <span class="stat-label">AC</span>
          <span class="stat-value ${modifierClass(mods.ac)}">${ac}</span>
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

  bindRemoveButton(characterId, character.name);
  bindConditionsSection(characterId, character.name);

  document.getElementById("battle-hp-bar").addEventListener("click", () => {
    openHpDialog(characterId, character.name);
  });

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
// a pure function of the sheet. Everything that clamps HP goes through
// here so the cap is the same in the panel and in the damage/heal dialog.
// Floored at 1: enough drained on a low-level character would otherwise
// produce a zero-or-negative maximum, which the HP bar can't divide by.
function effectiveMaxHp(entityId, build) {
  const base = computeMaxHp(build);
  const modifier = entityModifiers(entityId, build.level ?? 1).maxHp;
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

  for (const box of statPanel.querySelectorAll(".battle-condition-toggle")) {
    box.addEventListener("change", () => toggleCondition(entityId, box.dataset.condition, name));
  }
  for (const btn of statPanel.querySelectorAll(".battle-condition-step")) {
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

// Bottom-right box: how the selected entity's token looks on the map —
// shape, letters, text color, shape color. Mirrors the same
// selectedSquareKey as renderStatPanel() (selecting a square drives both
// panels together), and — like the initiative dialog — works for any
// placed entity, custom objects included.
function renderAppearancePanel() {
  if (!selectedSquareKey) {
    appearancePanel.innerHTML = '<p class="placeholder">Click a square to select it.</p>';
    return;
  }

  const entityId = battleState.placements[selectedSquareKey];
  if (!entityId) {
    appearancePanel.innerHTML = '<p class="placeholder">Empty square.</p>';
    return;
  }

  const entity = findEntity(entityId);
  if (!entity) {
    appearancePanel.innerHTML = '<p class="placeholder">Empty square.</p>';
    return;
  }

  const appearance = getAppearance(entityId, entity.name);

  appearancePanel.innerHTML = `
    <h2>Token Appearance</h2>
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

  for (const btn of appearancePanel.querySelectorAll(".battle-shape-btn")) {
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
  renderGridControls();
  renderZoomControls();
  renderToolControls();
  renderRoster();
  renderInitiative();
  renderStatPanel();
  renderAppearancePanel();
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
  const character = loadCharacters().find((c) => c.id === characterId);
  if (!character || !delta) {
    hpDialog.close();
    return;
  }

  // The drained-reduced maximum, not the sheet's — healing can't push a
  // drained character back above the cap the condition imposes.
  const { max: maxHp } = effectiveMaxHp(characterId, character.data.build);
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
  const character = loadCharacters().find((c) => c.id === characterId);
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

function squareFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  // Maps from the on-screen box to logical grid pixels. Deliberately NOT
  // via canvas.width/height: the bitmap is oversampled by zoom x
  // devicePixelRatio (see drawGrid()), so that ratio would land on device
  // pixels rather than the SQUARE_SIZE-based coordinates below.
  const x = (event.clientX - rect.left) * (gridCols() * SQUARE_SIZE / rect.width);
  const y = (event.clientY - rect.top) * (gridRows() * SQUARE_SIZE / rect.height);
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
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * (gridCols() * SQUARE_SIZE / rect.width);
  const y = (event.clientY - rect.top) * (gridRows() * SQUARE_SIZE / rect.height);
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

  // Centre of the cell cycles the diagonal: none -> "\" -> "/" -> none.
  // Three states rather than two so the same spot that changes direction
  // also clears it — otherwise a diagonal could be placed but never
  // removed without a separate control.
  if (nearest > SQUARE_SIZE * WALL_CENTRE_ZONE) {
    // Doors go on cell edges only — there's no sensible doorway through a
    // corner-to-corner diagonal, so the door tool simply has no action in
    // the centre zone (and previews nothing there).
    if (activeTool !== TOOL_WALL) return null;
    const back = wallKey("b", row, col);
    const forward = wallKey("f", row, col);
    if (walls[back]) return { remove: back, add: forward, state: EDGE_WALL };
    if (walls[forward]) return { remove: forward, add: null, state: null };
    return { remove: null, add: back, state: EDGE_WALL };
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
function traceWall(key, width, height) {
  const [type, rowStr, colStr] = key.split(",");
  const row = Number(rowStr);
  const col = Number(colStr);
  const x0 = pixelX(col);
  const y0 = pixelY(row);
  const half = WALL_THICKNESS / 2;

  ctx.beginPath();
  if (type === "h") {
    // Outer-boundary walls are nudged half a thickness inward so the whole
    // stroke renders instead of half of it falling outside the bitmap —
    // the same clipping trap the closing grid lines had.
    const y = Math.min(Math.max(y0, half), height - half);
    ctx.moveTo(x0, y);
    ctx.lineTo(x0 + SQUARE_SIZE, y);
  } else if (type === "v") {
    const x = Math.min(Math.max(x0, half), width - half);
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y0 + SQUARE_SIZE);
  } else if (type === "b") {
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + SQUARE_SIZE, y0 + SQUARE_SIZE);
  } else {
    ctx.moveTo(x0 + SQUARE_SIZE, y0);
    ctx.lineTo(x0, y0 + SQUARE_SIZE);
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
function drawEdgeShape(key, state, width, height, color, walls) {
  const type = key[0];
  if (type === "b" || type === "f" || state === EDGE_WALL) {
    ctx.strokeStyle = color;
    ctx.lineWidth = WALL_THICKNESS;
    ctx.lineCap = "round";
    traceWall(key, width, height);
    ctx.stroke();
    return;
  }

  const [, rowStr, colStr] = key.split(",");
  const row = Number(rowStr);
  const col = Number(colStr);
  const horizontal = type === "h";
  // Clamped by the thicker of the two so a doorway on the outer boundary
  // isn't half-clipped, same as walls.
  const clampHalf = Math.max(WALL_THICKNESS, DOOR_THICKNESS) / 2;
  const axis = horizontal
    ? Math.min(Math.max(pixelY(row), clampHalf), height - clampHalf)
    : Math.min(Math.max(pixelX(col), clampHalf), width - clampHalf);
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
    state.originRow = nextOriginRow;
    state.originCol = nextOriginCol;
    if (horizontal) state.cols = next;
    else state.rows = next;
    for (const entityId of dropped) {
      delete state.hp[entityId];
      delete state.tempHp[entityId];
      delete state.conditions[entityId];
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

for (const btn of toolButtons) {
  btn.addEventListener("click", () => {
    if (activeTool === btn.dataset.tool) return;
    activeTool = btn.dataset.tool;
    // A roster entity armed for placement is meaningless once the map
    // stops placing tokens, and would silently fire on the first click
    // after switching back. Disarm on any tool change.
    armedEntityId = null;
    // The preview belongs to the wall tool; leaving it up after switching
    // to select would advertise an edit that clicking no longer performs.
    wallHoverPos = null;
    wallHoverSig = null;
    render();
  });
}

function renderToolControls() {
  for (const btn of toolButtons) {
    btn.classList.toggle("active", btn.dataset.tool === activeTool);
  }
  // Drives the canvas cursor (crosshair while editing edges) from CSS
  // rather than an inline style, so it doesn't fight the "grabbing" that
  // panning sets and clears inline mid-drag.
  canvas.classList.toggle("tool-wall", isEdgeTool());
}

const zoomButtons = [...document.querySelectorAll(".battle-zoom-btn")];
const zoomResetBtn = document.getElementById("battle-zoom-reset");

for (const btn of zoomButtons) {
  btn.addEventListener("click", () => {
    const action = btn.dataset.zoom;
    if (action === "reset") setZoom(1);
    else setZoom(zoom + (action === "in" ? ZOOM_STEP : -ZOOM_STEP));
  });
}

function renderZoomControls() {
  for (const btn of zoomButtons) {
    const action = btn.dataset.zoom;
    if (action === "in") btn.disabled = zoom >= ZOOM_MAX;
    else if (action === "out") btn.disabled = zoom <= ZOOM_MIN;
    else btn.disabled = zoom === 1;
  }
  // The reset button is a symbol, so the current level lives in its
  // tooltip — otherwise nothing on screen says what zoom you're at.
  zoomResetBtn.title = zoom === 1 ? "Zoom is 100%" : `Reset zoom to 100% (now ${Math.round(zoom * 100)}%)`;
}

// Map drag-and-drop is mouse-based, not native HTML5 DnD — canvas has no
// per-square element to make draggable="true". mousedown only arms a
// potential drag (an occupied square, and not while a roster entity is
// armed for placement); it only becomes a real drag once mousemove
// crosses DRAG_THRESHOLD, so a plain click still reaches the click
// handler below unaffected. mouseup is on window, not canvas, so a drag
// that ends outside the grid still cleanly cancels instead of getting
// stuck.
canvas.addEventListener("mousedown", (event) => {
  const square = squareFromEvent(event);
  if (!square) return;
  // A roster entity armed for placement suppresses both gestures — the
  // next click is meant to drop it, not to move a token or the view.
  if (armedEntityId) return;

  // The wall tool never drags tokens — a press is either a wall placement
  // (on release, if it didn't move) or a pan, so fall through to the pan
  // arming below regardless of what's on the square.
  const key = squareKey(square.row, square.col);
  if (activeTool === TOOL_SELECT && battleState.placements[key]) {
    dragFromKey = key;
    dragStartPos = { x: event.clientX, y: event.clientY };
    dragMoved = false;
    return;
  }

  // Empty square (or any square, with the wall tool): grab the map itself.
  panFromScroll = { left: mapViewport.scrollLeft, top: mapViewport.scrollTop };
  panStartPos = { x: event.clientX, y: event.clientY };
  panMoved = false;
});

// Hover preview for the wall tool. Suppressed mid-pan — the map is moving
// under the cursor, so a preview pinned to a square would just flicker.
// Redraws only when the previewed action actually changes, not on every
// pixel of movement.
canvas.addEventListener("mousemove", (event) => {
  if (!isEdgeTool() || panFromScroll) {
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

// On window, not the canvas: a pan that wanders outside the grid (very
// easy, since panning is how you reach off-screen parts of it) should keep
// tracking rather than freezing at the edge.
window.addEventListener("mousemove", (event) => {
  if (!panFromScroll) return;
  const dx = event.clientX - panStartPos.x;
  const dy = event.clientY - panStartPos.y;
  if (!panMoved) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    panMoved = true;
    canvas.style.cursor = "grabbing";
  }
  // Scroll moves opposite the cursor, so the map follows the hand: drag
  // right and the view travels left, revealing what was off the left edge.
  mapViewport.scrollLeft = panFromScroll.left - dx;
  mapViewport.scrollTop = panFromScroll.top - dy;
});

window.addEventListener("mouseup", () => {
  if (!panFromScroll) return;
  panFromScroll = null;
  panStartPos = null;
  canvas.style.cursor = "";
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
  const occupantId = battleState.placements[key];

  if (armedEntityId) {
    if (!occupantId) {
      const entity = findEntity(armedEntityId);
      if (entity) {
        dispatch("place-token", `Placed ${entity.name} on the field`, (state) => {
          state.placements[key] = armedEntityId;
          // Custom objects have no build data, so no HP to initialize —
          // per the battle-helper-architecture skill, they're name-only.
          if (entity.build) state.hp[armedEntityId] = computeMaxHp(entity.build);
          delete state.tempHp[armedEntityId];
          delete state.conditions[armedEntityId];
          state.initiativeOrder.push(armedEntityId);
        });
      }
    }
    armedEntityId = null;
    render();
    return;
  }

  // Selecting a square (empty or occupied) to inspect it is UI-only — not
  // an event, per the battle-helper-architecture skill.
  selectedSquareKey = key;
  render();
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

document.addEventListener("keydown", (event) => {
  if (!event.ctrlKey || event.key.toLowerCase() !== "z" && event.key.toLowerCase() !== "y") return;
  event.preventDefault();
  if (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey)) {
    redo();
  } else {
    undo();
  }
});

// ---------------------------------------------------------------------------

const stored = loadBattleStore();
battles = stored.battles;
setActiveBattle(stored.activeBattleId);

render();
