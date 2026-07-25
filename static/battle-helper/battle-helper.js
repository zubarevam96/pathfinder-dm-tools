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

const COLS = 24;
const ROWS = 16;
const SQUARE_SIZE = 40; // px — each square is 5 ft per PF2e's grid convention

canvas.width = COLS * SQUARE_SIZE;
canvas.height = ROWS * SQUARE_SIZE;

// ---------------------------------------------------------------------------
// Battle state: the only things that live behind dispatch()/undo()/redo().
// Everything else below (selectedSquareKey, armedEntityId) is UI-only —
// see the battle-helper-architecture skill for why that split matters.

let battleState = { placements: {}, hp: {}, tempHp: {}, customObjects: {}, initiative: {}, initiativeOrder: [], appearance: {} };
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

// Raise a Shield is situational, like the main app's AC toggle — it isn't
// baked into the sheet and wouldn't surprise anyone by disappearing on
// undo, so it's UI-only state, not battle state. Kept across renders (a
// plain Set, not rebuilt from HTML) since renderStatPanel() re-renders on
// every selection change.
let raisedShieldIds = new Set();

function loadBattleStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(BATTLE_STORE_KEY)) ?? {};
    return {
      state: { placements: {}, hp: {}, tempHp: {}, customObjects: {}, initiative: {}, initiativeOrder: [], appearance: {}, ...raw.state },
      eventLog: raw.eventLog ?? [],
      cursor: raw.cursor ?? -1,
    };
  } catch {
    return { state: { placements: {}, hp: {}, tempHp: {}, customObjects: {}, initiative: {}, initiativeOrder: [], appearance: {} }, eventLog: [], cursor: -1 };
  }
}

function persistBattleStore() {
  localStorage.setItem(BATTLE_STORE_KEY, JSON.stringify({ state: battleState, eventLog, cursor }));
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
  const surface = cssVar("--surface");
  const border = cssVar("--border");
  const accent = cssVar("--accent");
  const accentSoft = cssVar("--accent-soft");

  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (selectedSquareKey) {
    const [row, col] = selectedSquareKey.split(",").map(Number);
    ctx.fillStyle = accentSoft;
    ctx.fillRect(col * SQUARE_SIZE, row * SQUARE_SIZE, SQUARE_SIZE, SQUARE_SIZE);
  }

  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  for (let col = 0; col <= COLS; col++) {
    const x = col * SQUARE_SIZE + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let row = 0; row <= ROWS; row++) {
    const y = row * SQUARE_SIZE + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
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

function render() {
  drawGrid();
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
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (event.clientX - rect.left) * scaleX;
  const y = (event.clientY - rect.top) * scaleY;
  const col = Math.floor(x / SQUARE_SIZE);
  const row = Math.floor(y / SQUARE_SIZE);
  if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null;
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
  const key = squareKey(square.row, square.col);
  if (!battleState.placements[key] || armedEntityId) return;
  dragFromKey = key;
  dragStartPos = { x: event.clientX, y: event.clientY };
  dragMoved = false;
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
  if (dragMoved) {
    dragMoved = false;
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
battleState = stored.state;
eventLog = stored.eventLog;
cursor = stored.cursor;

render();
