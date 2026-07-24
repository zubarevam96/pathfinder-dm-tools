// Shared PF2e rules math, used by both the main character sheet (app.js)
// and the Battle Helper stat panel (battle-helper/battle-helper.js).
// Loaded as a plain <script> before either — no build step, no modules,
// just globals, consistent with the rest of this project. Keep this file
// free of DOM/page-specific rendering; it should only ever compute numbers
// from a Pathbuilder `build` object.

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
// terms that produced it, so callers can show a "how was this calculated"
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

// PF2e max HP: ancestry HP + flat bonus + (class HP + Con mod + bonus/level) * level.
function computeMaxHp(build) {
  const attrs = build.attributes ?? {};
  const level = build.level ?? 1;
  const conMod = abilityMod(build.abilities?.con ?? 10);
  return (
    (attrs.ancestryhp ?? 0) + (attrs.bonushp ?? 0) +
    ((attrs.classhp ?? 0) + conMod + (attrs.bonushpPerLevel ?? 0)) * level
  );
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
