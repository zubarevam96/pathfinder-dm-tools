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
let activeTool = TOOL_SELECT;

// How thick a wall is drawn, in logical (unzoomed) px.
const WALL_THICKNESS = 5;

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
// mirror image. See remapWalls() for why that asymmetry needs care.
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
  return { placements: {}, hp: {}, tempHp: {}, customObjects: {}, initiative: {}, initiativeOrder: [], appearance: {}, walls: {}, cols: MIN_GRID, rows: MIN_GRID };
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
function currentHp(characterId, build) {
  const maxHp = computeMaxHp(build);
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
    ctx.fillRect(col * SQUARE_SIZE, row * SQUARE_SIZE, SQUARE_SIZE, SQUARE_SIZE);
  }

  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  // The +0.5 offset puts a 1px stroke on a whole pixel instead of
  // straddling two and blurring. The closing line in each direction has to
  // be pulled half a pixel back INSIDE instead of pushed out: the bitmap
  // spans 0..width, so a line at width + 0.5 falls entirely outside it and
  // gets clipped away — which is why the grid's right and bottom borders
  // were invisible. Math.min only ever affects that last line.
  for (let col = 0; col <= cols; col++) {
    const x = Math.min(col * SQUARE_SIZE + 0.5, width - 0.5);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let row = 0; row <= rows; row++) {
    const y = Math.min(row * SQUARE_SIZE + 0.5, height - 0.5);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  // Mid-drag feedback: dim the origin square, tint the hovered square
  // green (valid drop — empty) or red (invalid — occupied). Drawn under
  // the tokens so the dragged token still visibly sits at its origin
  // square throughout the drag; it only actually moves on drop.
  if (dragFromKey) {
    const [row, col] = dragFromKey.split(",").map(Number);
    ctx.fillStyle = border;
    ctx.globalAlpha = 0.5;
    ctx.fillRect(col * SQUARE_SIZE, row * SQUARE_SIZE, SQUARE_SIZE, SQUARE_SIZE);
    ctx.globalAlpha = 1;
  }
  if (dragHoverKey && dragHoverKey !== dragFromKey) {
    const [row, col] = dragHoverKey.split(",").map(Number);
    const valid = !battleState.placements[dragHoverKey];
    ctx.fillStyle = cssVar(valid ? "--success" : "--danger");
    ctx.globalAlpha = 0.3;
    ctx.fillRect(col * SQUARE_SIZE, row * SQUARE_SIZE, SQUARE_SIZE, SQUARE_SIZE);
    ctx.globalAlpha = 1;
  }

  // Walls, drawn over the grid lines but under the tokens — they're
  // terrain, and a token standing beside one shouldn't be painted over.
  // Outer-boundary walls are nudged half a thickness inward so they render
  // fully instead of having half the stroke fall outside the bitmap, the
  // same clipping problem the closing grid lines had.
  const wallKeys = Object.keys(battleState.walls ?? {});
  // Recomputed from the stored cursor position rather than cached, so it
  // always reflects current state — see wallHoverPos.
  const hover = wallHoverPos && activeTool === TOOL_WALL ? wallActionFromEvent(wallHoverPos) : null;

  if (wallKeys.length || hover) {
    ctx.lineWidth = WALL_THICKNESS;
    ctx.lineCap = "round";

    // A wall the hover is about to remove is deliberately skipped here and
    // redrawn in the preview pass instead. Drawing it solid and tinting
    // over it cannot work: overlaying paint makes a stroke MORE prominent,
    // never less. That's what made a diagonal being turned keep its old
    // direction looking solid while the incoming one was a faint ghost —
    // the preview appeared stuck at one angle.
    const pendingRemoval = hover?.remove ?? null;
    ctx.strokeStyle = cssVar("--text");
    for (const key of wallKeys) {
      if (key === pendingRemoval) continue;
      traceWall(key, width, height);
      ctx.stroke();
    }

    if (hover) {
      // Outgoing first, incoming over it, so the wall you're about to get
      // wins where the two cross.
      if (hover.remove) {
        // Turning a diagonal is a change, not a deletion — fade the old
        // direction so attention lands on the new one. A removal with
        // nothing replacing it really is a deletion, so that stays red.
        const turning = Boolean(hover.add);
        ctx.globalAlpha = turning ? 0.22 : 0.6;
        ctx.strokeStyle = cssVar(turning ? "--muted" : "--danger");
        traceWall(hover.remove, width, height);
        ctx.stroke();
      }
      if (hover.add) {
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = cssVar("--text");
        traceWall(hover.add, width, height);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Restored so the token loop below and the selection outline after it
    // don't inherit the wall stroke settings.
    ctx.lineCap = "butt";
    ctx.lineWidth = 1;
  }

  for (const [key, entityId] of Object.entries(battleState.placements)) {
    const entity = findEntity(entityId);
    if (!entity) continue;
    const [row, col] = key.split(",").map(Number);
    const cx = col * SQUARE_SIZE + SQUARE_SIZE / 2;
    const cy = row * SQUARE_SIZE + SQUARE_SIZE / 2;
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
    ctx.strokeRect(col * SQUARE_SIZE + 1, row * SQUARE_SIZE + 1, SQUARE_SIZE - 2, SQUARE_SIZE - 2);
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
    `;
    bindRemoveButton(entityId, entity.name);
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
  const maxHp = computeMaxHp(build);
  const hp = currentHp(characterId, build);
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
  const baseAc = Number(build.acTotal?.acTotal) || 0;
  const { hasShield, shieldBonus } = getAcBonuses(build);
  const shieldRaised = raisedShieldIds.has(characterId);
  const ac = baseAc + (shieldRaised ? shieldBonus : 0);
  const fort = checkTotal(build, prof.fortitude ?? 0, "con");
  const reflex = checkTotal(build, prof.reflex ?? 0, "dex");
  const will = checkTotal(build, prof.will ?? 0, "wis");
  const perception = checkTotal(build, prof.perception ?? 0, "wis");
  const speed = (attrs.speed ?? 0) + (attrs.speedBonus ?? 0);

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
        </div>
      </div>
      <div class="battle-stat-right">
        <button type="button" id="battle-hp-bar" class="battle-hp-bar" title="Click to adjust HP">
          <span class="battle-hp-bar-fill${hpLow ? " low" : ""}" style="width:${hpFillPct}%"></span>
          ${tempHp > 0 ? `<span class="battle-hp-bar-temp-fill" style="left:${hpFillPct}%; width:${tempFillPct}%"></span>` : ""}
          <span class="battle-hp-bar-text">${hp} / ${maxHp}${tempHp > 0 ? ` (+${tempHp})` : ""}</span>
        </button>
        <button type="button" id="battle-toggle-shield" class="battle-stat-ac${shieldRaised ? " active" : ""}" title="${hasShield ? `Raise a Shield (+${shieldBonus} AC)` : "AC"}" ${hasShield ? "" : "disabled"}>
          <span class="stat-label">AC</span>
          <span class="stat-value">${ac}</span>
          ${hasShield ? `<span class="battle-stat-ac-shield-icon" aria-hidden="true">&#128737;</span>` : ""}
        </button>
      </div>
    </div>
    <div class="battle-stat-grid">
      <div class="battle-stat"><span class="stat-label">Fortitude</span><span class="stat-value">${formatMod(fort)}</span></div>
      <div class="battle-stat"><span class="stat-label">Reflex</span><span class="stat-value">${formatMod(reflex)}</span></div>
      <div class="battle-stat"><span class="stat-label">Will</span><span class="stat-value">${formatMod(will)}</span></div>
      <div class="battle-stat"><span class="stat-label">Perception</span><span class="stat-value">${formatMod(perception)}</span></div>
      <div class="battle-stat"><span class="stat-label">Speed</span><span class="stat-value">${speed} ft</span></div>
    </div>
  `;

  bindRemoveButton(characterId, character.name);

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

  const maxHp = computeMaxHp(character.data.build);
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
  const col = Math.floor(x / SQUARE_SIZE);
  const row = Math.floor(y / SQUARE_SIZE);
  if (col < 0 || col >= gridCols() || row < 0 || row >= gridRows()) return null;
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
  const feet = pf2eDistanceFeet(toRow - fromRow, toCol - fromCol);

  dispatch(
    "move-token",
    `Moved ${entity.name} ${feet} ft, from (${fromCol}, ${fromRow}) to (${toCol}, ${toRow})`,
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
  const col = Math.floor(x / SQUARE_SIZE);
  const row = Math.floor(y / SQUARE_SIZE);
  if (col < 0 || col >= gridCols() || row < 0 || row >= gridRows()) return null;

  const walls = battleState.walls ?? {};
  const fromLeft = x - col * SQUARE_SIZE;
  const fromTop = y - row * SQUARE_SIZE;
  const fromRight = SQUARE_SIZE - fromLeft;
  const fromBottom = SQUARE_SIZE - fromTop;
  const nearest = Math.min(fromLeft, fromRight, fromTop, fromBottom);

  // Centre of the cell cycles the diagonal: none -> "\" -> "/" -> none.
  // Three states rather than two so the same spot that changes direction
  // also clears it — otherwise a diagonal could be placed but never
  // removed without a separate control.
  if (nearest > SQUARE_SIZE * WALL_CENTRE_ZONE) {
    const back = wallKey("b", row, col);
    const forward = wallKey("f", row, col);
    if (walls[back]) return { remove: back, add: forward };
    if (walls[forward]) return { remove: forward, add: null };
    return { remove: null, add: back };
  }

  let key;
  if (nearest === fromLeft) key = wallKey("v", row, col);
  else if (nearest === fromRight) key = wallKey("v", row, col + 1);
  else if (nearest === fromTop) key = wallKey("h", row, col);
  else key = wallKey("h", row + 1, col);

  return walls[key] ? { remove: key, add: null } : { remove: null, add: key };
}

const WALL_LABELS = { h: "horizontal", v: "vertical", b: "diagonal", f: "diagonal" };

function wallActionLabel({ remove, add }) {
  // Both set means the diagonal cycled from one direction to the other.
  if (remove && add) {
    const [, row, col] = add.split(",");
    return `Turned the diagonal wall at (${col}, ${row})`;
  }
  const [type, row, col] = (add ?? remove).split(",");
  return `${add ? "Placed" : "Removed"} a ${WALL_LABELS[type]} wall at (${col}, ${row})`;
}

function applyWallAction(action) {
  const { remove, add } = action;
  dispatch("toggle-wall", wallActionLabel(action), (state) => {
    if (!state.walls) state.walls = {};
    if (remove) delete state.walls[remove];
    if (add) state.walls[add] = true;
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
  const x0 = col * SQUARE_SIZE;
  const y0 = row * SQUARE_SIZE;
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

// Walls sit on edges, so their indices don't shift in lockstep with
// placements when the grid is resized. For a "v" wall the COLUMN is an
// edge index (0..cols, one more value than there are cells) while its row
// is a cell index — and "h" is the mirror image. That asymmetry only bites
// on a TRAILING removal: dropping the right-hand column removes cell index
// cols-1, but edge index cols (the old outer boundary), leaving the edge
// that was between the last two cells to become the new outer boundary.
// Leading edits are uniform: drop index 0, shift the rest.
//
// Diagonals ("b"/"f") live inside a cell, so BOTH their components are
// cell indices. They need no special case: edgeSpace below is false for
// them on either axis, which is already the cell-index behaviour.
function remapWalls(walls, horizontal, delta, leading, current) {
  const next = {};
  for (const key of Object.keys(walls ?? {})) {
    const [type, rowStr, colStr] = key.split(",");
    let row = Number(rowStr);
    let col = Number(colStr);

    const value = horizontal ? col : row;
    const edgeSpace = horizontal ? type === "v" : type === "h";
    if (delta < 0) {
      const dropIndex = leading ? 0 : (edgeSpace ? current : current - 1);
      if (value === dropIndex) continue;
    }

    const moved = value + (leading ? delta : 0);
    if (horizontal) col = moved;
    else row = moved;
    next[wallKey(type, row, col)] = true;
  }
  return next;
}

// The four +/- controls around the map. Resizing is a real battle-state
// change (Rule 1), so it dispatches — and it dispatches ONCE, covering the
// new size, the renumbering below, and any tokens evicted by a removed
// row/column, so a single Ctrl+Z restores all three together rather than
// leaving a half-undone board.
function resizeGrid(side, delta) {
  const horizontal = side === "left" || side === "right";
  const current = horizontal ? gridCols() : gridRows();
  const next = current + delta;
  if (next < MIN_GRID || next > MAX_GRID) return;

  // Editing the top/left edge renumbers every square, because placements
  // are keyed "row,col" off the top-left origin — inserting a column at 0
  // pushes everyone one index right. Bottom/right edits append or truncate
  // past the existing keys, so those need no renumbering at all.
  const leading = side === "left" || side === "top";
  const shift = leading ? delta : 0;
  const removedIndex = leading ? 0 : current - 1;

  const nextPlacements = {};
  const dropped = [];
  for (const [key, entityId] of Object.entries(battleState.placements)) {
    const [row, col] = key.split(",").map(Number);
    const index = horizontal ? col : row;
    if (delta < 0 && index === removedIndex) {
      dropped.push(entityId);
      continue;
    }
    const moved = index + shift;
    nextPlacements[horizontal ? squareKey(row, moved) : squareKey(moved, col)] = entityId;
  }

  const nextWalls = remapWalls(battleState.walls, horizontal, delta, leading, current);

  // Names read before dispatching, so the log line can say who left —
  // same approach as applyHpDelta() reading temp HP up front. Safe because
  // nothing can mutate state between here and the mutator (JS is
  // single-threaded), and the label has to be a plain string by then.
  const droppedNames = dropped.map((id) => findEntity(id)?.name).filter(Boolean);
  const unit = horizontal ? "column" : "row";
  let label = delta > 0 ? `Added a ${unit} on the ${side}` : `Removed the ${side} ${unit}`;
  if (droppedNames.length) label += ` (${droppedNames.join(", ")} left the field)`;

  // UI-only state, updated before the dispatch so its render() sees the
  // final picture. Selection is a square key, so it has to follow the
  // renumbering — or clear, if its square is the one that just went away.
  for (const entityId of dropped) raisedShieldIds.delete(entityId);
  if (selectedSquareKey) {
    const [row, col] = selectedSquareKey.split(",").map(Number);
    const index = horizontal ? col : row;
    if (delta < 0 && index === removedIndex) {
      selectedSquareKey = null;
    } else {
      const moved = index + shift;
      selectedSquareKey = horizontal ? squareKey(row, moved) : squareKey(moved, col);
    }
  }

  dispatch("resize-grid", label, (state) => {
    state.placements = nextPlacements;
    state.walls = nextWalls;
    if (horizontal) state.cols = next;
    else state.rows = next;
    for (const entityId of dropped) {
      delete state.hp[entityId];
      delete state.tempHp[entityId];
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
  // Drives the canvas cursor (crosshair while placing walls) from CSS
  // rather than an inline style, so it doesn't fight the "grabbing" that
  // panning sets and clears inline mid-drag.
  canvas.classList.toggle("tool-wall", activeTool === TOOL_WALL);
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
  if (activeTool !== TOOL_WALL || panFromScroll) {
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
  dragHoverKey = square ? squareKey(square.row, square.col) : null;
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

  // The wall tool takes the click before any placement/selection logic —
  // with it active, the map edits terrain and nothing else.
  if (activeTool === TOOL_WALL) {
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
