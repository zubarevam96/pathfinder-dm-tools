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

const deleteGroupDialog = document.getElementById("delete-group-dialog");
const deleteGroupMessage = document.getElementById("delete-group-message");
const deleteGroupStatus = document.getElementById("delete-group-status");
const deleteGroupCancel = document.getElementById("delete-group-cancel");
const deleteGroupConfirmBtn = document.getElementById("delete-group-confirm");

const rollHistoryList = document.getElementById("roll-history");
const clearHistoryBtn = document.getElementById("clear-history-btn");

const aonDialog = document.getElementById("aon-dialog");
const aonDialogTitle = document.getElementById("aon-dialog-title");
const aonDialogBody = document.getElementById("aon-dialog-body");
const aonDialogOpenTab = document.getElementById("aon-dialog-open-tab");
const aonDialogClose = document.getElementById("aon-dialog-close");

const optionsBtn = document.getElementById("options-btn");
const optionsDialog = document.getElementById("options-dialog");
const optionsPanelBody = document.getElementById("options-panel-body");
const optionsClose = document.getElementById("options-close");

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
    settings: { critModifier: false, spellTraditions: false, ...raw.settings },
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
let pendingDeleteGroupId = null;

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

function buildGroupSection(title, characters, group) {
  const details = document.createElement("details");
  details.className = "group";
  details.open = true;

  const summary = document.createElement("summary");
  const summaryText = document.createElement("span");
  summaryText.textContent = `${title} (${characters.length})`;
  summary.appendChild(summaryText);

  if (group) {
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "group-delete-btn";
    deleteBtn.textContent = "×";
    deleteBtn.title = `Delete group "${group.name}"`;
    deleteBtn.addEventListener("click", (event) => {
      event.preventDefault(); // don't toggle the <details> open/closed
      event.stopPropagation();
      openDeleteGroupDialog(group.id, group.name);
    });
    summary.appendChild(deleteBtn);
  }

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
    characterTree.appendChild(buildGroupSection(group.name, groupCharacters, group));
  }

  const ungrouped = characters.filter((c) => !c.groupId || !groups.some((g) => g.id === c.groupId));
  if (groups.length === 0 || ungrouped.length > 0) {
    characterTree.appendChild(buildGroupSection("Ungrouped", ungrouped, null));
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
// describeCheck() returns both the total and the individual {value, label}
// terms that produced it, so the UI can show a "how was this calculated"
// hint with real numbers instead of just the final total.
function describeCheck(build, prof, ability) {
  const score = build.abilities?.[ability] ?? 10;
  const mod = abilityMod(score);
  const level = build.level ?? 1;
  const levelApplies = prof > 0;
  const total = mod + prof + (levelApplies ? level : 0);
  const terms = [
    { value: mod, label: `${ABILITY_NAMES[ability] ?? ability} mod (score ${score})` },
    { value: prof, label: "proficiency" },
  ];
  if (levelApplies) terms.push({ value: level, label: "level" });
  return { total, terms };
}

function checkTotal(build, prof, ability) {
  return describeCheck(build, prof, ability).total;
}

// Tooltips list one signed term per line (never a result — that's already
// shown as the visible number) so they stay readable instead of one long
// run-on string. Each line carries its own +/- sign, so there's never a
// literal "+" joiner butting up against a formatMod() sign (the "10 + +1"
// bug this replaced).
function formatTerm(term) {
  return `${formatMod(term.value)} ${term.label}`;
}

function formulaHint(terms) {
  return terms.map(formatTerm).join("\n");
}

// For values that are "10 + <total already shown elsewhere>" — the total's
// value is visible right next to this hint (e.g. the Mod. column, or an
// Attack span), so only the base and the total's own line are needed.
function baseDcHint(total) {
  return `10 base\n${formatMod(total)} modifier`;
}

// For values where nothing else on the page already shows the total (AC,
// Class DC) — spell out the full 10 + term breakdown.
function baseTenHint(terms) {
  return [`10 base`, ...terms.map(formatTerm)].join("\n");
}

function checkRow(label, ability, prof, total, terms) {
  const dc = 10 + total;
  const modHint = terms ? formulaHint(terms) : "";
  const dcHint = baseDcHint(total);
  return `
    <tr>
      <td>${escapeHtml(label)} <span class="ability-tag">${ability}</span></td>
      <td class="prof prof-${prof}">${PROF_LABELS[prof] ?? prof}</td>
      <td class="num calc-hint" title="${escapeHtml(modHint)}">${formatMod(total)}</td>
      <td class="num calc-hint" title="${escapeHtml(dcHint)}">${dc}</td>
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

function chipList(items) {
  if (!items || items.length === 0) {
    return '<p class="placeholder">None</p>';
  }
  return `<div class="chip-list">${items.map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("")}</div>`;
}

// Archives of Nethys has no stable name-based page URL (spells are keyed by
// a numeric ID), so as a fallback we link to its search endpoint, which
// takes the name as a query param and reliably surfaces the matching spell
// as the top result. Known IDs and traditions come from
// static/spell-data/*.json (built by scripts/build_spell_entities.py),
// loaded into these maps at startup — see loadSpellIdMap().
let spellIdMap = {};
let spellTraditionMap = {};

async function loadSpellIdMap() {
  const idMap = {};
  const traditionMap = {};
  for (const file of ["spell-data/cantrips.json", "spell-data/spells.json", "spell-data/focals.json"]) {
    try {
      const response = await fetch(file);
      if (!response.ok) continue;
      const entities = await response.json();
      for (const entity of entities) {
        if (entity.archives_of_nexus_id != null) {
          idMap[entity.name] = entity.archives_of_nexus_id;
        }
        traditionMap[entity.name] = entity.traditions ?? [];
      }
    } catch {
      // Non-fatal — spells just fall back to the AoN search link.
    }
  }
  spellIdMap = idMap;
  spellTraditionMap = traditionMap;
}

// Colors mirror the classic PF2e tradition Venn diagram (Arcane/Divine/
// Occult/Primal).
const TRADITION_COLORS = {
  arcane: "#8e44ad",
  divine: "#d4ac0d",
  occult: "#e67e22",
  primal: "#2e8b57",
};
const TRADITION_ORDER = ["arcane", "divine", "occult", "primal"];

// Each tradition keeps a fixed grid slot (arcane top-left, divine top-right,
// occult bottom-left, primal bottom-right) regardless of which traditions a
// given spell has, so the badge is scannable at a glance across spells.
function traditionDots(name) {
  const traditions = spellTraditionMap[name] ?? [];
  if (traditions.length === 0) return "";
  const dots = TRADITION_ORDER.map((tradition) => {
    const present = traditions.includes(tradition);
    const style = present ? `background:${TRADITION_COLORS[tradition]}` : "background:transparent";
    return `<span class="tradition-dot" style="${style}" title="${present ? tradition : ""}"></span>`;
  }).join("");
  return `<span class="tradition-dots">${dots}</span>`;
}

function spellSearchUrl(name) {
  return `https://2e.aonprd.com/Search.aspx?q=${encodeURIComponent(name)}`;
}

function spellDirectUrl(id) {
  return `https://2e.aonprd.com/Spells.aspx?ID=${id}`;
}

// Focus spells have no tradition of their own (they belong to a class, not
// arcane/divine/occult/primal), so tradition dots are skipped for them —
// every dot would just be grey, which is noise, not information.
function spellChipList(items, { showTraditions = true } = {}) {
  if (!items || items.length === 0) {
    return '<p class="placeholder">None</p>';
  }
  return `<div class="chip-list">${items.map((item) => {
    const id = spellIdMap[item];
    const url = id ? spellDirectUrl(id) : spellSearchUrl(item);
    const dots = showTraditions && store.settings.spellTraditions ? traditionDots(item) : "";
    return `<a class="chip chip-link" href="${escapeHtml(url)}" target="_blank" rel="noopener" data-spell-name="${escapeHtml(item)}">${escapeHtml(item)}${dots}</a>`;
  }).join("")}</div>`;
}

// One hidden iframe per distinct AoN URL, kept alive (never removed) in the
// popup dialog so revisiting an already-viewed page doesn't re-request it —
// only its visibility toggles. Shared by spells, armor, weapons, and
// inventory items — they all resolve down to "an AoN page URL" either way.
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

function handleSpellChipClick(event, chip) {
  const name = chip.dataset.spellName;
  const id = spellIdMap[name];
  if (!id) return; // unknown spell — fall back to the default search-page link

  // Ctrl/Cmd/Shift-click (or middle-click) should still open the direct
  // page in a new tab as normal, not the in-page popup.
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1) return;

  event.preventDefault();
  openAonPopup(spellDirectUrl(id), name);
}

// Armor, weapons, and inventory items don't have a fixed reference list the
// way spells do — Pathbuilder can report literally anything a character is
// carrying, including homebrew or DM-renamed items — so a direct AoN link
// is only available when itemIdMap (built from static/item-data/*.json,
// e.g. armor.json) recognizes the exact name. Everything else falls back
// to AoN's search page, same as an unrecognized spell. Inventory items are
// checked against the same map, since armor sometimes shows up loose in a
// character's inventory instead of the dedicated armor list.
const AON_ITEM_PAGES = { armor: "Armor.aspx", weapon: "Weapons.aspx", equipment: "Equipment.aspx" };
let itemIdMap = {};

async function loadItemIdMap() {
  const map = {};
  for (const [category, file] of [
    ["armor", "item-data/armor.json"],
    ["equipment", "item-data/alchemical-items.json"],
  ]) {
    try {
      const response = await fetch(file);
      if (!response.ok) continue;
      const entities = await response.json();
      for (const entity of entities) {
        if (entity.archives_of_nexus_id != null) {
          map[entity.name] = { category, id: entity.archives_of_nexus_id };
        }
      }
    } catch {
      // Non-fatal — items just fall back to the AoN search link.
    }
  }
  itemIdMap = map;
}

function itemLink(name) {
  const item = itemIdMap[name];
  if (item) {
    return { url: `https://2e.aonprd.com/${AON_ITEM_PAGES[item.category]}?ID=${item.id}`, category: item.category, id: item.id };
  }
  return { url: spellSearchUrl(name), category: null, id: null };
}

// displayText is what's shown (e.g. "Cold Iron (Standard-Grade) Clan
// Dagger"), lookupName is the base item name to resolve against itemIdMap
// and to search AoN by (e.g. "Clan Dagger") — they differ whenever a
// weapon/armor has a material or rune prefix baked into its display name.
function itemNameLink(displayText, lookupName = displayText) {
  const { url, category, id } = itemLink(lookupName);
  const dataAttrs = category ? ` data-aon-category="${category}" data-aon-id="${id}"` : "";
  return `<a class="item-link" href="${escapeHtml(url)}" target="_blank" rel="noopener" data-item-name="${escapeHtml(lookupName)}"${dataAttrs}>${escapeHtml(displayText)}</a>`;
}

function handleItemLinkClick(event, link) {
  const category = link.dataset.aonCategory;
  const id = link.dataset.aonId;
  if (!category || !id) return; // unrecognized item — fall back to the default search-page link

  if (event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1) return;

  event.preventDefault();
  openAonPopup(`https://2e.aonprd.com/${AON_ITEM_PAGES[category]}?ID=${id}`, link.dataset.itemName);
}

const COIN_LABELS = [
  ["pp", "Platinum", "#e5e4e2"],
  ["gp", "Gold", "#d4af37"],
  ["sp", "Silver", "#c0c0c0"],
  ["cp", "Copper", "#cd7f32"],
];

function moneyRow(money) {
  return `
    <div class="stat-row">
      ${COIN_LABELS.map(([key, label, color]) => `
        <div class="stat coin-stat" style="--coin-color: ${color}">
          <span class="stat-label">${label}</span>
          <span class="stat-value">${money?.[key] ?? 0}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function weaponsTable(weapons) {
  if (!weapons || weapons.length === 0) {
    return '<p class="placeholder">No weapons</p>';
  }
  const rows = weapons.map((w) => `
    <tr>
      <td>${itemNameLink(w.display || w.name, w.name)}</td>
      <td class="num">${formatMod(w.attack ?? 0)}</td>
      <td>${escapeHtml(w.die ?? "-")}${w.damageBonus ? " " + formatMod(w.damageBonus) : ""} ${escapeHtml(w.damageType ?? "")}</td>
      <td>${escapeHtml(w.prof ?? "")}</td>
    </tr>
  `).join("");
  return `
    <table class="check-table">
      <tr><th>Weapon</th><th>Attack</th><th>Damage</th><th>Prof.</th></tr>
      ${rows}
    </table>
  `;
}

function armorTable(armorList) {
  if (!armorList || armorList.length === 0) {
    return '<p class="placeholder">No armor</p>';
  }
  const rows = armorList.map((a) => {
    const runeNotes = [a.pot ? `+${a.pot} potency` : "", a.res || ""].filter(Boolean).join(", ");
    return `
      <tr>
        <td>${itemNameLink(a.display || a.name, a.name)}</td>
        <td>${escapeHtml(a.prof ?? "")}</td>
        <td>${a.worn ? "Worn" : ""}</td>
        <td>${escapeHtml(runeNotes)}</td>
      </tr>
    `;
  }).join("");
  return `
    <table class="check-table">
      <tr><th>Armor</th><th>Category</th><th>Status</th><th>Runes</th></tr>
      ${rows}
    </table>
  `;
}

function inventoryTable(equipment) {
  if (!equipment || equipment.length === 0) {
    return '<p class="placeholder">No inventory items</p>';
  }
  const rows = equipment.map(([name, qty, note]) => `
    <tr>
      <td>${name ? itemNameLink(name) : ""}</td>
      <td class="num">${qty ?? 1}</td>
      <td>${escapeHtml(note ?? "")}</td>
    </tr>
  `).join("");
  return `
    <table class="check-table">
      <tr><th>Item</th><th>Qty</th><th>Notes</th></tr>
      ${rows}
    </table>
  `;
}

function spellcastingSection(build) {
  const casters = build.spellCasters ?? [];
  const focusData = build.focus ?? {};
  const focusPoints = build.focusPoints ?? 0;

  const blocks = [];

  for (const caster of casters) {
    const ability = caster.ability ?? "cha";
    const prof = caster.proficiency ?? 0;
    const { total, terms } = describeCheck(build, prof, ability);
    const dc = 10 + total;
    const attackHint = formulaHint(terms);
    const dcHint = baseDcHint(total);
    const perDay = caster.perDay ?? [];

    const levelSections = (caster.spells ?? [])
      .filter((entry) => entry.list && entry.list.length > 0)
      .map((entry) => {
        const level = entry.spellLevel;
        const levelLabel = level === 0 ? "Cantrips" : `Level ${level}`;
        const slots = perDay[level];
        const slotLabel = level > 0 && slots ? ` (${slots}/day)` : "";
        return `
          <div class="spell-level">
            <div class="spell-level-label">${escapeHtml(levelLabel)}${slotLabel}</div>
            ${spellChipList(entry.list)}
          </div>
        `;
      }).join("");

    if (!levelSections) continue;

    blocks.push(`
      <div class="caster-block">
        <div class="caster-header">
          <h4>${escapeHtml(caster.name)}</h4>
          <span class="caster-meta">${escapeHtml(caster.magicTradition ?? "")} · ${escapeHtml(caster.spellcastingType ?? "")}</span>
          <div class="caster-stats">
            <span class="calc-hint" title="${escapeHtml(attackHint)}">Attack ${formatMod(total)}</span>
            <span class="calc-hint" title="${escapeHtml(dcHint)}">DC ${dc}</span>
          </div>
        </div>
        ${levelSections}
      </div>
    `);
  }

  for (const [tradition, byAbility] of Object.entries(focusData)) {
    for (const [ability, data] of Object.entries(byAbility)) {
      const spells = [...(data.focusCantrips ?? []), ...(data.focusSpells ?? [])];
      if (spells.length === 0) continue;

      const { total: baseTotal, terms } = describeCheck(build, data.proficiency ?? 0, ability);
      const itemBonus = data.itemBonus ?? 0;
      const total = baseTotal + itemBonus;
      const dc = 10 + total;
      const attackTerms = itemBonus ? [...terms, { value: itemBonus, label: "item" }] : terms;
      const attackHint = formulaHint(attackTerms);
      const dcHint = baseDcHint(total);
      blocks.push(`
        <div class="caster-block">
          <div class="caster-header">
            <h4>Focus Spells</h4>
            <span class="caster-meta">${escapeHtml(tradition)}</span>
            <div class="caster-stats">
              <span class="calc-hint" title="${escapeHtml(attackHint)}">Attack ${formatMod(total)}</span>
              <span class="calc-hint" title="${escapeHtml(dcHint)}">DC ${dc}</span>
            </div>
          </div>
          ${spellChipList(spells, { showTraditions: false })}
        </div>
      `);
    }
  }

  if (blocks.length === 0) {
    return '<p class="placeholder">No spells</p>';
  }

  const focusPointsLine = focusPoints > 0
    ? `<p class="focus-points">Focus Points: <strong>${focusPoints}</strong></p>`
    : "";

  return `${focusPointsLine}${blocks.join("")}`;
}

// A weapon/shield can grant a temporary AC bonus that only applies while an
// action (Raise a Shield / Parry) is active, so it's a toggle, not baked
// into the base AC total Pathbuilder reports.
function getAcBonuses(build) {
  const shieldBonus = Number(build.acTotal?.shieldBonus) || 0;
  const hasShield = shieldBonus > 0;

  const parryWeapon = (build.weapons ?? []).find(
    (w) => Array.isArray(w.traits) && w.traits.some((t) => /parry/i.test(t))
  );

  return { hasShield, shieldBonus, hasParry: Boolean(parryWeapon), parryBonus: 1 };
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
  const hpHint =
    `${formatMod(attrs.ancestryhp ?? 0)} ancestry\n${formatMod(attrs.bonushp ?? 0)} flat bonus\n` +
    `(${formatMod(attrs.classhp ?? 0)} class ${formatMod(conMod)} Con mod ${formatMod(attrs.bonushpPerLevel ?? 0)} bonus/level) × ${level} level`;
  const speed = (attrs.speed ?? 0) + (attrs.speedBonus ?? 0);
  const classDCCheck = describeCheck(build, prof.classDC ?? 0, build.keyability ?? "str");
  const classDC = 10 + classDCCheck.total;
  const classDCHint = baseTenHint(classDCCheck.terms);

  const subtitleParts = [
    `Level ${level} ${build.ancestry ?? ""} ${build.class ?? ""}`.trim(),
    build.heritage,
    build.background,
  ].filter(Boolean);

  const abilityCards = ABILITIES.map((ability) => {
    const score = build.abilities?.[ability] ?? 10;
    const mod = abilityMod(score);
    const modHint = `(score ${score} - 10) / 2, rounded down`;
    const dc = 10 + mod;
    const dcHint = baseDcHint(mod);
    return `
      <div class="ability-card">
        <div class="ability-name">${ABILITY_NAMES[ability]}</div>
        <div class="ability-score">${score}</div>
        <div class="ability-mod">
          <span class="calc-hint" title="${escapeHtml(modHint)}">${formatMod(mod)}</span>
          <span class="dc calc-hint" title="${escapeHtml(dcHint)}">DC ${dc}</span>
        </div>
        <button class="roll-btn" data-mod="${mod}" data-label="${ABILITY_NAMES[ability]}">Roll</button>
        <div class="roll-result"></div>
      </div>
    `;
  }).join("");

  const saveRows = Object.entries(SAVES).map(([save, ability]) => {
    const p = prof[save] ?? 0;
    const label = save.charAt(0).toUpperCase() + save.slice(1);
    const { total, terms } = describeCheck(build, p, ability);
    return checkRow(label, ability, p, total, terms);
  }).join("");
  const perceptionCheck = describeCheck(build, prof.perception ?? 0, "wis");
  const perceptionRow = checkRow("Perception", "wis", prof.perception ?? 0, perceptionCheck.total, perceptionCheck.terms);

  const skillRows = Object.entries(SKILLS).map(([skill, ability]) => {
    const p = prof[skill] ?? 0;
    const label = skill.charAt(0).toUpperCase() + skill.slice(1);
    const { total, terms } = describeCheck(build, p, ability);
    return checkRow(label, ability, p, total, terms);
  }).join("");

  const loreRows = (build.lores ?? []).map(([loreName, p]) => {
    const { total, terms } = describeCheck(build, p ?? 0, "int");
    return checkRow(`${loreName} Lore`, "int", p ?? 0, total, terms);
  }).join("");

  const baseAC = Number(build.acTotal?.acTotal) || 0;
  const acProfBonus = Number(build.acTotal?.acProfBonus) || 0;
  const acAbilityBonus = Number(build.acTotal?.acAbilityBonus) || 0;
  const acItemBonus = Number(build.acTotal?.acItemBonus) || 0;
  const baseAcHint = baseTenHint([
    { value: acProfBonus, label: "proficiency" },
    { value: acAbilityBonus, label: "ability" },
    { value: acItemBonus, label: "item" },
  ]);
  const { hasShield, shieldBonus, hasParry, parryBonus } = getAcBonuses(build);
  const acToggles = `
    ${hasShield ? `<button class="icon-btn" id="toggle-shield" title="Raise a Shield (+${shieldBonus} AC)" data-bonus="${shieldBonus}">🛡</button>` : ""}
    ${hasParry ? `<button class="icon-btn" id="toggle-parry" title="Parry (+${parryBonus} AC)" data-bonus="${parryBonus}">⚔</button>` : ""}
  `;

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
      <div class="stat">
        <span class="stat-label">AC</span>
        <span class="stat-value calc-hint" id="ac-value" title="${escapeHtml(baseAcHint)}">${baseAC}</span>
        ${acToggles.trim() ? `<div class="ac-toggles">${acToggles}</div>` : ""}
      </div>
      <div class="stat"><span class="stat-label">HP</span><span class="stat-value calc-hint" title="${escapeHtml(hpHint)}">${hp}</span></div>
      <div class="stat"><span class="stat-label">Speed</span><span class="stat-value">${speed} ft</span></div>
      <div class="stat"><span class="stat-label">Class DC</span><span class="stat-value calc-hint" title="${escapeHtml(classDCHint)}">${classDC}</span></div>
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

    <section class="sheet-section">
      <h3>Spells</h3>
      ${spellcastingSection(build)}
    </section>

    <section class="sheet-section">
      <h3>Weapons</h3>
      ${weaponsTable(build.weapons)}
    </section>

    <section class="sheet-section">
      <h3>Armor</h3>
      ${armorTable(build.armor)}
    </section>

    <section class="sheet-section">
      <h3>Inventory</h3>
      ${inventoryTable(build.equipment)}
    </section>

    <section class="sheet-section">
      <h3>Languages</h3>
      ${chipList(build.languages)}
    </section>

    <section class="sheet-section">
      <h3>Resistances</h3>
      ${chipList(build.resistances)}
    </section>

    <section class="sheet-section">
      <h3>Money</h3>
      ${moneyRow(build.money)}
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

  for (const chip of mainContent.querySelectorAll(".chip-link[data-spell-name]")) {
    chip.addEventListener("click", (event) => handleSpellChipClick(event, chip));
  }

  for (const link of mainContent.querySelectorAll(".item-link[data-item-name]")) {
    link.addEventListener("click", (event) => handleItemLinkClick(event, link));
  }

  const acValueEl = document.getElementById("ac-value");
  const acToggleBtns = mainContent.querySelectorAll(".ac-toggles .icon-btn");
  for (const btn of acToggleBtns) {
    btn.addEventListener("click", () => {
      btn.classList.toggle("active");
      const activeBonus = Array.from(acToggleBtns)
        .filter((b) => b.classList.contains("active"))
        .reduce((sum, b) => sum + Number(b.dataset.bonus), 0);
      acValueEl.textContent = baseAC + activeBonus;
      acValueEl.title = activeBonus
        ? `${baseAcHint}\n${formatMod(activeBonus)} situational`
        : baseAcHint;
    });
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

    // Pathbuilder's numeric id isn't a permanent identity for one character —
    // it can end up pointing at a different character later. Only refresh in
    // place when the name still matches what we last saved under this id.
    if (fetched.sourceId !== character.sourceId || fetched.name !== character.name) {
      btn.disabled = false;
      btn.textContent = "Refresh";
      alert(
        `Refresh aborted: Pathbuilder ID ${fetched.sourceId} now returns "${fetched.name}", ` +
        `not "${character.name}". Add it as a new character instead if this is intentional.`
      );
      return;
    }

    Object.assign(character, {
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

  renderMain();
}

function renderMain() {
  const character = store.characters.find((c) => c.id === selectedId);
  if (!character) {
    mainContent.innerHTML = '<p class="placeholder">Select a character, or add a new one.</p>';
    return;
  }
  renderCharacterSheet(character);
}

function openOptionsDialog() {
  optionsPanelBody.innerHTML = `
    <label class="option-row">
      <input type="checkbox" id="opt-crit-modifier" ${store.settings.critModifier ? "checked" : ""} />
      Add/subtract 10 on critical rolls (natural 20 or natural 1)
    </label>
    <p class="option-hint">
      When enabled, a natural 20 adds 10 to the roll total and a natural 1
      subtracts 10 — a quick shorthand for critical success/failure margins.
    </p>
    <label class="option-row">
      <input type="checkbox" id="opt-spell-traditions" ${store.settings.spellTraditions ? "checked" : ""} />
      Show spell tradition dots
    </label>
    <p class="option-hint">
      When enabled, each spell chip shows four dots for arcane, divine,
      occult, and primal — colored if the spell belongs to that tradition,
      grey otherwise.
    </p>
  `;

  document.getElementById("opt-crit-modifier").addEventListener("change", (event) => {
    store.settings.critModifier = event.target.checked;
    persist();
  });

  document.getElementById("opt-spell-traditions").addEventListener("change", (event) => {
    store.settings.spellTraditions = event.target.checked;
    persist();
    renderMain();
  });

  optionsDialog.showModal();
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

    // Same Pathbuilder id AND same name: this is a re-sync of a character we
    // already have, not a new character or a name collision — update in place.
    const exactMatch = store.characters.find(
      (c) => c.sourceId === result.sourceId && c.name === result.name
    );
    if (exactMatch) {
      Object.assign(exactMatch, { link: result.link, data: result.data, savedAt: Date.now() / 1000 });
      persist();
      newDialog.close();
      renderSidebar();
      selectCharacter(exactMatch.id);
      return;
    }

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

function openDeleteGroupDialog(id, name) {
  pendingDeleteGroupId = id;
  deleteGroupMessage.textContent = `Are you sure you want to delete the group "${name}"? Its characters will become ungrouped, not deleted. This cannot be undone.`;
  deleteGroupStatus.textContent = "";
  deleteGroupDialog.showModal();
}

function confirmDeleteGroup() {
  store.groups = store.groups.filter((g) => g.id !== pendingDeleteGroupId);
  for (const character of store.characters) {
    if (character.groupId === pendingDeleteGroupId) character.groupId = null;
  }
  persist();

  deleteGroupDialog.close();
  pendingDeleteGroupId = null;
  renderSidebar();
  if (selectedId) renderMain();
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

deleteGroupCancel.addEventListener("click", () => deleteGroupDialog.close());
deleteGroupConfirmBtn.addEventListener("click", confirmDeleteGroup);

aonDialogClose.addEventListener("click", () => aonDialog.close());

clearHistoryBtn.addEventListener("click", clearRollHistory);

optionsBtn.addEventListener("click", openOptionsDialog);
optionsClose.addEventListener("click", () => optionsDialog.close());

renderSidebar();
renderRollHistory();
importLegacyIfNeeded();
loadSpellIdMap();
loadItemIdMap();
