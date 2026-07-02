const characterTree = document.getElementById("character-tree");
const mainContent = document.getElementById("main-content");

const newBtn = document.getElementById("new-btn");
const newDialog = document.getElementById("new-dialog");
const newForm = document.getElementById("new-form");
const newLinkInput = document.getElementById("character-link");
const newStatus = document.getElementById("new-status");
const newCancel = document.getElementById("new-cancel");

const collisionDialog = document.getElementById("collision-dialog");
const collisionMessage = document.getElementById("collision-message");
const collisionTarget = document.getElementById("collision-target");
const collisionStatus = document.getElementById("collision-status");
const collisionCancel = document.getElementById("collision-cancel");
const collisionCopyBtn = document.getElementById("collision-copy");
const collisionOverrideBtn = document.getElementById("collision-override");

const newGroupBtn = document.getElementById("new-group-btn");
const groupDialog = document.getElementById("group-dialog");
const groupForm = document.getElementById("group-form");
const groupNameInput = document.getElementById("group-name");
const groupStatus = document.getElementById("group-status");
const groupCancel = document.getElementById("group-cancel");

const deleteDialog = document.getElementById("delete-dialog");
const deleteMessage = document.getElementById("delete-message");
const deleteStatus = document.getElementById("delete-status");
const deleteCancel = document.getElementById("delete-cancel");
const deleteConfirmBtn = document.getElementById("delete-confirm");

const rollHistoryList = document.getElementById("roll-history");
const clearHistoryBtn = document.getElementById("clear-history-btn");

const tabCharacterBtn = document.getElementById("tab-character");
const tabOptionsBtn = document.getElementById("tab-options");

// ---------------------------------------------------------------------------
// Browser-local storage: each user's characters live in their own browser.

const STORE_KEY = "pathfinder-dm-tools";
const MIGRATED_KEY = STORE_KEY + ":migrated";
const MAX_ROLLS = 50;

function loadStore() {
  let raw = {};
  try {
    raw = JSON.parse(localStorage.getItem(STORE_KEY)) ?? {};
  } catch {
    raw = {};
  }
  return {
    characters: raw.characters ?? [],
    groups: raw.groups ?? [],
    rolls: raw.rolls ?? [],
    settings: { critModifier: false, ...raw.settings },
  };
}

function persist() {
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
}

function uid() {
  return crypto.randomUUID
    ? crypto.randomUUID().replaceAll("-", "")
    : Math.random().toString(16).slice(2) + Date.now().toString(16);
}

let store = loadStore();
let selectedId = null;
let pendingFetch = null;
let pendingDeleteId = null;
let activeTab = "character";

async function importLegacyIfNeeded() {
  if (store.characters.length || store.groups.length || localStorage.getItem(MIGRATED_KEY)) {
    return;
  }
  try {
    // Relative path: only exists when running behind the local Flask server;
    // on static hosting (GitHub Pages) this 404s and is skipped.
    const response = await fetch("api/legacy-store");
    if (!response.ok) throw new Error("no legacy store");
    const legacy = await response.json();
    if (legacy.characters?.length || legacy.groups?.length) {
      store.characters = (legacy.characters ?? []).map((c) => ({ ...c, groupId: c.groupId ?? null }));
      store.groups = legacy.groups ?? [];
      persist();
      renderSidebar();
    }
  } catch {
    // Server-side legacy data is a nice-to-have; ignore failures.
  }
  localStorage.setItem(MIGRATED_KEY, "1");
}

function addCharacterEntry(fetched, groupId = null) {
  const entry = {
    id: uid(),
    name: fetched.name,
    sourceId: fetched.sourceId,
    link: fetched.link,
    data: fetched.data,
    groupId,
    savedAt: Date.now() / 1000,
  };
  store.characters.push(entry);
  persist();
  return entry;
}

// ---------------------------------------------------------------------------
// Sidebar

function buildCharacterItem(character) {
  const li = document.createElement("li");
  li.textContent = character.name;
  li.dataset.id = character.id;
  if (character.id === selectedId) li.classList.add("active");
  li.addEventListener("click", () => selectCharacter(character.id));
  return li;
}

function buildGroupSection(title, characters) {
  const details = document.createElement("details");
  details.className = "group";
  details.open = true;

  const summary = document.createElement("summary");
  summary.textContent = `${title} (${characters.length})`;
  details.appendChild(summary);

  const ul = document.createElement("ul");
  if (characters.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No characters";
    ul.appendChild(li);
  } else {
    for (const character of characters) {
      ul.appendChild(buildCharacterItem(character));
    }
  }
  details.appendChild(ul);
  return details;
}

function renderSidebar() {
  const { groups, characters } = store;

  characterTree.innerHTML = "";

  if (groups.length === 0 && characters.length === 0) {
    const empty = document.createElement("p");
    empty.className = "placeholder";
    empty.textContent = "No characters yet";
    characterTree.appendChild(empty);
    return;
  }

  for (const group of groups) {
    const groupCharacters = characters.filter((c) => c.groupId === group.id);
    characterTree.appendChild(buildGroupSection(group.name, groupCharacters));
  }

  const ungrouped = characters.filter((c) => !c.groupId || !groups.some((g) => g.id === c.groupId));
  if (groups.length === 0 || ungrouped.length > 0) {
    characterTree.appendChild(buildGroupSection("Ungrouped", ungrouped));
  }
}

// ---------------------------------------------------------------------------
// Character sheet

const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"];
const ABILITY_NAMES = {
  str: "Strength", dex: "Dexterity", con: "Constitution",
  int: "Intelligence", wis: "Wisdom", cha: "Charisma",
};
const SKILLS = {
  acrobatics: "dex", arcana: "int", athletics: "str", crafting: "int",
  deception: "cha", diplomacy: "cha", intimidation: "cha", medicine: "wis",
  nature: "wis", occultism: "int", performance: "cha", religion: "wis",
  society: "int", stealth: "dex", survival: "wis", thievery: "dex",
};
const SAVES = { fortitude: "con", reflex: "dex", will: "wis" };
const PROF_LABELS = { 0: "Untrained", 2: "Trained", 4: "Expert", 6: "Master", 8: "Legendary" };

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

function abilityMod(score) {
  return Math.floor((score - 10) / 2);
}

function formatMod(mod) {
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

// PF2e: total = ability mod + proficiency bonus (+ level when trained or better).
function checkTotal(build, prof, ability) {
  const mod = abilityMod(build.abilities[ability] ?? 10);
  return mod + prof + (prof > 0 ? build.level : 0);
}

function checkRow(label, ability, prof, total) {
  return `
    <tr>
      <td>${escapeHtml(label)} <span class="ability-tag">${ability}</span></td>
      <td class="prof prof-${prof}">${PROF_LABELS[prof] ?? prof}</td>
      <td class="num">${formatMod(total)}</td>
      <td class="num">${10 + total}</td>
      <td><button class="roll-btn" data-mod="${total}" data-label="${escapeHtml(label)}">Roll</button></td>
      <td class="roll-result"></td>
    </tr>
  `;
}

function checkTableHead() {
  return `
    <tr><th>Check</th><th>Prof.</th><th>Mod.</th><th>DC</th><th></th><th></th></tr>
  `;
}

function renderCharacterSheet(character) {
  const build = character.data?.build;
  if (!build) {
    mainContent.innerHTML = '<p class="placeholder">This character has no build data.</p>';
    return;
  }

  const prof = build.proficiencies ?? {};
  const attrs = build.attributes ?? {};
  const level = build.level ?? 1;
  const conMod = abilityMod(build.abilities?.con ?? 10);
  const hp =
    (attrs.ancestryhp ?? 0) + (attrs.bonushp ?? 0) +
    ((attrs.classhp ?? 0) + conMod + (attrs.bonushpPerLevel ?? 0)) * level;
  const speed = (attrs.speed ?? 0) + (attrs.speedBonus ?? 0);
  const classDC = 10 + checkTotal(build, prof.classDC ?? 0, build.keyability ?? "str");

  const subtitleParts = [
    `Level ${level} ${build.ancestry ?? ""} ${build.class ?? ""}`.trim(),
    build.heritage,
    build.background,
  ].filter(Boolean);

  const abilityCards = ABILITIES.map((ability) => {
    const score = build.abilities?.[ability] ?? 10;
    const mod = abilityMod(score);
    return `
      <div class="ability-card">
        <div class="ability-name">${ABILITY_NAMES[ability]}</div>
        <div class="ability-score">${score}</div>
        <div class="ability-mod">${formatMod(mod)} <span class="dc">DC ${10 + mod}</span></div>
        <button class="roll-btn" data-mod="${mod}" data-label="${ABILITY_NAMES[ability]}">Roll</button>
        <div class="roll-result"></div>
      </div>
    `;
  }).join("");

  const saveRows = Object.entries(SAVES).map(([save, ability]) => {
    const p = prof[save] ?? 0;
    const label = save.charAt(0).toUpperCase() + save.slice(1);
    return checkRow(label, ability, p, checkTotal(build, p, ability));
  }).join("");
  const perceptionRow = checkRow("Perception", "wis", prof.perception ?? 0, checkTotal(build, prof.perception ?? 0, "wis"));

  const skillRows = Object.entries(SKILLS).map(([skill, ability]) => {
    const p = prof[skill] ?? 0;
    const label = skill.charAt(0).toUpperCase() + skill.slice(1);
    return checkRow(label, ability, p, checkTotal(build, p, ability));
  }).join("");

  const loreRows = (build.lores ?? []).map(([loreName, p]) =>
    checkRow(`${loreName} Lore`, "int", p ?? 0, checkTotal(build, p ?? 0, "int"))
  ).join("");

  mainContent.innerHTML = `
    <div class="character-header">
      <div>
        <h2>${escapeHtml(character.name)}</h2>
        <p class="subtitle">${subtitleParts.map(escapeHtml).join(" · ")}</p>
        <p class="source-id">Pathbuilder ID:
          <a href="${escapeHtml(character.link)}" target="_blank" rel="noopener">${escapeHtml(character.sourceId ?? "?")}</a>
        </p>
      </div>
      <div class="character-actions">
        <select id="group-select">
          <option value="">No group</option>
        </select>
        <button id="refresh-character-btn">Refresh</button>
        <button id="delete-character-btn" class="danger">Delete</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat"><span class="stat-label">AC</span><span class="stat-value">${build.acTotal?.acTotal ?? "?"}</span></div>
      <div class="stat"><span class="stat-label">HP</span><span class="stat-value">${hp}</span></div>
      <div class="stat"><span class="stat-label">Speed</span><span class="stat-value">${speed} ft</span></div>
      <div class="stat"><span class="stat-label">Class DC</span><span class="stat-value">${classDC}</span></div>
    </div>

    <section class="sheet-section">
      <h3>Abilities</h3>
      <div class="ability-grid">${abilityCards}</div>
    </section>

    <section class="sheet-section">
      <h3>Perception &amp; Saving Throws</h3>
      <table class="check-table">${checkTableHead()}${perceptionRow}${saveRows}</table>
    </section>

    <section class="sheet-section">
      <h3>Skills</h3>
      <table class="check-table">${checkTableHead()}${skillRows}${loreRows}</table>
    </section>

    <details class="raw-json">
      <summary>Raw JSON</summary>
      <pre id="character-json"></pre>
    </details>
  `;
  document.getElementById("character-json").textContent = JSON.stringify(character.data, null, 2);

  for (const btn of mainContent.querySelectorAll(".roll-btn")) {
    btn.addEventListener("click", () => rollCheck(btn, character.name));
  }

  const groupSelect = document.getElementById("group-select");
  for (const group of store.groups) {
    const option = document.createElement("option");
    option.value = group.id;
    option.textContent = group.name;
    if (group.id === character.groupId) option.selected = true;
    groupSelect.appendChild(option);
  }
  groupSelect.addEventListener("change", () => updateCharacterGroup(character.id, groupSelect.value || null));

  document.getElementById("refresh-character-btn").addEventListener("click", () => refreshCharacter(character.id));
  document.getElementById("delete-character-btn").addEventListener("click", () => openDeleteDialog(character.id, character.name));
}

async function refreshCharacter(id) {
  const character = store.characters.find((c) => c.id === id);
  if (!character) return;

  const btn = document.getElementById("refresh-character-btn");
  btn.disabled = true;
  btn.textContent = "Refreshing...";

  try {
    const fetched = await fetchPathbuilder(character.sourceId ?? character.link);
    Object.assign(character, {
      name: fetched.name,
      sourceId: fetched.sourceId,
      link: fetched.link,
      data: fetched.data,
      savedAt: Date.now() / 1000,
    });
    persist();
    renderSidebar();
    renderCharacterSheet(character);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Refresh";
    alert(`Failed to refresh: ${err.message}`);
  }
}

function selectCharacter(id) {
  selectedId = id;
  for (const li of characterTree.querySelectorAll("li")) {
    li.classList.toggle("active", li.dataset.id === id);
  }

  switchTab("character");
}

function renderActiveTab() {
  if (activeTab === "options") {
    renderOptionsPanel();
    return;
  }

  const character = store.characters.find((c) => c.id === selectedId);
  if (!character) {
    mainContent.innerHTML = '<p class="placeholder">Select a character, or add a new one.</p>';
    return;
  }
  renderCharacterSheet(character);
}

function switchTab(tab) {
  activeTab = tab;
  tabCharacterBtn.classList.toggle("active", tab === "character");
  tabOptionsBtn.classList.toggle("active", tab === "options");
  renderActiveTab();
}

function renderOptionsPanel() {
  mainContent.innerHTML = `
    <h2>Options</h2>
    <div class="options-panel">
      <label class="option-row">
        <input type="checkbox" id="opt-crit-modifier" ${store.settings.critModifier ? "checked" : ""} />
        Add/subtract 10 on critical rolls (natural 20 or natural 1)
      </label>
      <p class="option-hint">
        When enabled, a natural 20 adds 10 to the roll total and a natural 1
        subtracts 10 — a quick shorthand for critical success/failure margins.
      </p>
    </div>
  `;

  document.getElementById("opt-crit-modifier").addEventListener("change", (event) => {
    store.settings.critModifier = event.target.checked;
    persist();
  });
}

function updateCharacterGroup(id, groupId) {
  const character = store.characters.find((c) => c.id === id);
  if (!character) return;
  character.groupId = groupId;
  persist();
  renderSidebar();
}

// ---------------------------------------------------------------------------
// Rolls

function rollCheck(btn, characterName) {
  const mod = Number(btn.dataset.mod);
  const label = btn.dataset.label;
  const die = Math.floor(Math.random() * 20) + 1;

  let critAdjust = 0;
  if (store.settings.critModifier) {
    if (die === 20) critAdjust = 10;
    else if (die === 1) critAdjust = -10;
  }
  const total = die + mod + critAdjust;

  const resultEl = btn.closest("tr, .ability-card").querySelector(".roll-result");
  const critText = critAdjust !== 0 ? ` ${formatMod(critAdjust)} (crit)` : "";
  resultEl.textContent = `d20 (${die}) ${formatMod(mod)}${critText} = ${total}`;
  resultEl.classList.toggle("nat20", die === 20);
  resultEl.classList.toggle("nat1", die === 1);

  store.rolls.unshift({ name: characterName, label, die, mod, critAdjust, total, at: Date.now() });
  store.rolls.length = Math.min(store.rolls.length, MAX_ROLLS);
  persist();
  renderRollHistory();
}

function renderRollHistory() {
  rollHistoryList.innerHTML = "";

  if (store.rolls.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No rolls yet";
    rollHistoryList.appendChild(li);
    return;
  }

  for (const roll of store.rolls) {
    const li = document.createElement("li");
    li.textContent = `${roll.name} rolled ${roll.total} in ${roll.label} check`;
    const critText = roll.critAdjust ? ` ${formatMod(roll.critAdjust)} (crit)` : "";
    li.title = `d20 (${roll.die}) ${formatMod(roll.mod)}${critText} · ${new Date(roll.at).toLocaleTimeString()}`;
    if (roll.die === 20) li.classList.add("nat20");
    if (roll.die === 1) li.classList.add("nat1");
    rollHistoryList.appendChild(li);
  }
}

function clearRollHistory() {
  store.rolls = [];
  persist();
  renderRollHistory();
}

// ---------------------------------------------------------------------------
// Add character / collision dialogs

const PATHBUILDER_JSON_URL = "https://pathbuilder2e.com/json.php";

function extractCharacterId(linkOrId) {
  const trimmed = linkOrId.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const match = trimmed.match(/[?&]id=(\d+)/);
  return match ? match[1] : null;
}

async function fetchPathbuilder(link) {
  const characterId = extractCharacterId(link);
  if (!characterId) {
    throw new Error("Could not find a character id in that link.");
  }

  let data;
  try {
    const response = await fetch(`${PATHBUILDER_JSON_URL}?id=${characterId}`);
    if (!response.ok) throw new Error(`Pathbuilder returned ${response.status}.`);
    data = await response.json();
  } catch (err) {
    // Direct fetch can fail (e.g. CORS policy changes); fall back to the
    // local Flask proxy when the app is served by it.
    const response = await fetch("api/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ link }),
    }).catch(() => null);
    if (!response || !response.ok) {
      let proxyError = null;
      try {
        proxyError = (await response.json()).error;
      } catch {}
      throw new Error(proxyError || `Failed to fetch character: ${err.message}`);
    }
    const result = await response.json();
    result.link = `${PATHBUILDER_JSON_URL}?id=${result.sourceId}`;
    return result;
  }

  if (data.success === false) {
    throw new Error("Pathbuilder reported this character is not shareable.");
  }
  return {
    name: data.build?.name || "Unnamed character",
    sourceId: characterId,
    link: `${PATHBUILDER_JSON_URL}?id=${characterId}`,
    data,
  };
}

function openNewDialog() {
  newLinkInput.value = "";
  newStatus.textContent = "";
  newDialog.showModal();
  newLinkInput.focus();
}

async function submitNewCharacter(event) {
  event.preventDefault();
  const link = newLinkInput.value.trim();
  if (!link) {
    newStatus.textContent = "Enter a character link or id first.";
    return;
  }

  newStatus.textContent = "Fetching...";
  try {
    const result = await fetchPathbuilder(link);

    const conflicts = store.characters.filter((c) => c.name === result.name);
    if (conflicts.length > 0) {
      newDialog.close();
      openCollisionDialog(result, conflicts);
      return;
    }

    const entry = addCharacterEntry(result);
    newDialog.close();
    renderSidebar();
    selectCharacter(entry.id);
  } catch (err) {
    newStatus.textContent = err.message;
  }
}

function openCollisionDialog(fetched, conflicts) {
  pendingFetch = fetched;
  collisionMessage.textContent = `A character named "${fetched.name}" already exists. Copy to keep both, or override an existing one.`;
  collisionTarget.innerHTML = "";
  for (const conflict of conflicts) {
    const option = document.createElement("option");
    option.value = conflict.id;
    option.textContent = conflict.name;
    collisionTarget.appendChild(option);
  }
  collisionStatus.textContent = "";
  collisionDialog.showModal();
}

function resolveCollision(action) {
  if (!pendingFetch) return;

  let entry;
  if (action === "override") {
    entry = store.characters.find((c) => c.id === collisionTarget.value);
    if (!entry) {
      collisionStatus.textContent = "Character to override was not found.";
      return;
    }
    Object.assign(entry, {
      name: pendingFetch.name,
      sourceId: pendingFetch.sourceId,
      link: pendingFetch.link,
      data: pendingFetch.data,
      savedAt: Date.now() / 1000,
    });
    persist();
  } else {
    entry = addCharacterEntry(pendingFetch);
  }

  collisionDialog.close();
  pendingFetch = null;
  renderSidebar();
  selectCharacter(entry.id);
}

// ---------------------------------------------------------------------------
// Groups

function openGroupDialog() {
  groupNameInput.value = "";
  groupStatus.textContent = "";
  groupDialog.showModal();
  groupNameInput.focus();
}

function submitNewGroup(event) {
  event.preventDefault();
  const name = groupNameInput.value.trim();
  if (!name) {
    groupStatus.textContent = "Enter a group name first.";
    return;
  }

  const existing = store.groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
  if (!existing) {
    store.groups.push({ id: uid(), name });
    persist();
  }

  groupDialog.close();
  renderSidebar();
}

// ---------------------------------------------------------------------------
// Delete

function openDeleteDialog(id, name) {
  pendingDeleteId = id;
  deleteMessage.textContent = `Are you sure you want to delete "${name}"? This cannot be undone.`;
  deleteStatus.textContent = "";
  deleteDialog.showModal();
}

function confirmDelete() {
  store.characters = store.characters.filter((c) => c.id !== pendingDeleteId);
  persist();

  deleteDialog.close();
  if (pendingDeleteId === selectedId) {
    selectedId = null;
    mainContent.innerHTML = '<p class="placeholder">Select a character, or add a new one.</p>';
  }
  pendingDeleteId = null;
  renderSidebar();
}

// ---------------------------------------------------------------------------

newBtn.addEventListener("click", openNewDialog);
newCancel.addEventListener("click", () => newDialog.close());
newForm.addEventListener("submit", submitNewCharacter);

collisionCancel.addEventListener("click", () => collisionDialog.close());
collisionCopyBtn.addEventListener("click", () => resolveCollision("copy"));
collisionOverrideBtn.addEventListener("click", () => resolveCollision("override"));

newGroupBtn.addEventListener("click", openGroupDialog);
groupCancel.addEventListener("click", () => groupDialog.close());
groupForm.addEventListener("submit", submitNewGroup);

deleteCancel.addEventListener("click", () => deleteDialog.close());
deleteConfirmBtn.addEventListener("click", confirmDelete);

clearHistoryBtn.addEventListener("click", clearRollHistory);

tabCharacterBtn.addEventListener("click", () => switchTab("character"));
tabOptionsBtn.addEventListener("click", () => switchTab("options"));

renderSidebar();
renderRollHistory();
importLegacyIfNeeded();
