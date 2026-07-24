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
const rosterList = document.getElementById("battle-roster");
const initiativeList = document.getElementById("battle-initiative");
const logList = document.getElementById("battle-log");
const undoBtn = document.getElementById("battle-undo");
const redoBtn = document.getElementById("battle-redo");

const hpDialog = document.getElementById("battle-hp-dialog");
const hpDialogName = document.getElementById("battle-hp-dialog-name");
const hpInput = document.getElementById("battle-hp-input");
const hpCloseBtn = document.getElementById("battle-hp-close");

const COLS = 24;
const ROWS = 16;
const SQUARE_SIZE = 40; // px — each square is 5 ft per PF2e's grid convention

canvas.width = COLS * SQUARE_SIZE;
canvas.height = ROWS * SQUARE_SIZE;

// ---------------------------------------------------------------------------
// Battle state: the only things that live behind dispatch()/undo()/redo().
// Everything else below (selectedSquareKey, armedCharacterId) is UI-only —
// see the battle-helper-architecture skill for why that split matters.

let battleState = { placements: {}, hp: {}, tempHp: {} }; // hp/tempHp: character id -> value
let eventLog = []; // [{ type, label, before, after, at }]
let cursor = -1; // index into eventLog of the last applied event

let selectedSquareKey = null; // square the player clicked to inspect
let armedCharacterId = null; // roster character about to be placed
let hpDialogCharacterId = null; // character the HP dialog is currently open for

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
      state: { placements: {}, hp: {}, tempHp: {}, ...raw.state },
      eventLog: raw.eventLog ?? [],
      cursor: raw.cursor ?? -1,
    };
  } catch {
    return { state: { placements: {}, hp: {}, tempHp: {} }, eventLog: [], cursor: -1 };
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

function squareKey(row, col) {
  return `${row},${col}`;
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
// (selectedSquareKey, armedCharacterId) never does.

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

function drawGrid() {
  const surface = cssVar("--surface");
  const border = cssVar("--border");
  const accent = cssVar("--accent");
  const accentSoft = cssVar("--accent-soft");
  const accentContrast = cssVar("--accent-contrast");

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

  const byId = new Map(loadCharacters().map((c) => [c.id, c]));
  for (const [key, characterId] of Object.entries(battleState.placements)) {
    const character = byId.get(characterId);
    if (!character) continue;
    const [row, col] = key.split(",").map(Number);
    const cx = col * SQUARE_SIZE + SQUARE_SIZE / 2;
    const cy = row * SQUARE_SIZE + SQUARE_SIZE / 2;
    const radius = SQUARE_SIZE / 2 - 4;

    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = accentContrast;
    ctx.font = "bold 14px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText((character.name || "?").trim()[0]?.toUpperCase() ?? "?", cx, cy);
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
  const unplaced = loadCharacters().filter((c) => !placedIds.has(c.id));

  if (unplaced.length === 0) {
    rosterList.innerHTML = '<li class="placeholder">No characters available — add one on the main page.</li>';
    return;
  }

  rosterList.innerHTML = unplaced.map((c) => `
    <li class="battle-roster-item${c.id === armedCharacterId ? " armed" : ""}" data-character-id="${escapeHtml(c.id)}">
      ${escapeHtml(c.name)}
    </li>
  `).join("");

  for (const li of rosterList.querySelectorAll("[data-character-id]")) {
    li.addEventListener("click", () => {
      const id = li.dataset.characterId;
      armedCharacterId = armedCharacterId === id ? null : id;
      render();
    });
  }
}

function renderInitiative() {
  const byId = new Map(loadCharacters().map((c) => [c.id, c]));
  const placed = Object.values(battleState.placements)
    .map((id) => byId.get(id))
    .filter(Boolean);

  initiativeList.innerHTML = placed.length
    ? placed.map((c) => `<li>${escapeHtml(c.name)}</li>`).join("")
    : '<li class="placeholder">No one on the field yet.</li>';
}

function renderStatPanel() {
  if (!selectedSquareKey) {
    statPanel.innerHTML = '<p class="placeholder">Click a square to select it.</p>';
    return;
  }

  const characterId = battleState.placements[selectedSquareKey];
  if (!characterId) {
    statPanel.innerHTML = '<p class="placeholder">Empty square.</p>';
    return;
  }

  const character = loadCharacters().find((c) => c.id === characterId);
  const build = character?.data?.build;
  if (!character || !build) {
    statPanel.innerHTML = '<p class="placeholder">No sheet data for this character.</p>';
    return;
  }

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

  document.getElementById("battle-remove-token").addEventListener("click", () => {
    const key = selectedSquareKey;
    dispatch("remove-token", `Removed ${character.name} from the field`, (state) => {
      delete state.placements[key];
      delete state.hp[characterId];
      delete state.tempHp[characterId];
    });
    raisedShieldIds.delete(characterId);
    selectedSquareKey = null;
    render();
  });

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

canvas.addEventListener("click", (event) => {
  const square = squareFromEvent(event);
  if (!square) return;
  const key = squareKey(square.row, square.col);
  const occupantId = battleState.placements[key];

  if (armedCharacterId) {
    if (!occupantId) {
      const character = loadCharacters().find((c) => c.id === armedCharacterId);
      if (character) {
        dispatch("place-token", `Placed ${character.name} on the field`, (state) => {
          state.placements[key] = armedCharacterId;
          state.hp[armedCharacterId] = computeMaxHp(character.data.build);
          delete state.tempHp[armedCharacterId];
        });
      }
    }
    armedCharacterId = null;
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
