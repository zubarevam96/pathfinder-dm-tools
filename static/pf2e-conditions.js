// The PF2e condition list, plus the mechanical effects the Battle Helper
// stat panel applies. Loaded as a plain <script> before battle-helper.js,
// same as pf2e-math.js: no build step, no modules, just globals. Keep this
// file free of DOM/rendering — it should only ever describe conditions and
// compute numbers from them.
//
// Source: https://pf2.d20pfsrd.com/rules/conditions/
//
// These are the PRE-REMASTER names, matching that page. If this project
// ever moves to remaster rules, the notable rename is Flat-Footed ->
// Off-Guard (and Clumsy/Enfeebled/Stupefied/Drained keep their names but
// lose the "status penalty" wording).
//
// Shape, per entry:
//   name      display name
//   valued    true if the condition carries a number (Frightened 2), so a
//             UI knows whether to offer a stepper or a plain toggle
//   summary   one-line mechanical effect, for a tooltip or list row
//   group     "death" | "detection" | "attitude" | null — the rules treat
//             each of these sets as a chain a creature moves along, so
//             they're worth showing together and, later, worth making
//             mutually exclusive within a group
//   overrides ids this condition supersedes while both apply (the rules
//             say so explicitly; only three pairs exist)
//   grants    ids this condition also imposes, as {id, value} — e.g.
//             encumbered making you clumsy 1. Expanded transitively by
//             resolveConditions(): dying -> unconscious -> flat-footed.
//   effects   numeric modifiers, as terms (see below). Empty for the many
//             conditions that change what you *can do* rather than what
//             your numbers are (fleeing, immobilized, controlled...).
//
// Effect terms:
//   stats     which stat keys the term hits — concrete ("ac", "reflex") or
//             an umbrella ("saves", "checks-and-dcs") that PF2E_STAT_SOURCES
//             below resolves down to concrete ones
//   type      "status" | "circumstance" | "item" | "untyped". PF2e's
//             stacking rule works per type: of several penalties of the
//             same type only the worst applies (and of several bonuses,
//             only the best), while untyped ones always stack. That is why
//             frightened 2 + sickened 1 is -2, not -3, but frightened 2
//             (status) + flat-footed (circumstance) really is -4 to AC.
//   amount    fixed size, for conditions with no tier
//   perValue  size per point of the condition's value, for valued ones
//   perLevel  multiply by the creature's level as well (only drained)
//
// Only effects on stats the Battle Helper actually shows are modelled
// numerically — AC, the three saves, Perception, Speed and max HP. The
// rest (attack rolls, skills, damage, flat checks, action loss) stay in
// the prose summary on purpose: they belong to rolls this page doesn't
// make, and a half-modelled penalty a DM leans on is worse than none.
// Deliberately left out for the same reason: conditional penalties whose
// trigger this page can't know, such as blinded's -4 Perception ("if
// vision was your only precise sense") and deafened's -2 on sound-based
// checks.
const PF2E_CONDITIONS = {
  blinded: {
    name: "Blinded",
    valued: false,
    summary: "Can't see. All terrain is difficult terrain, sight-based Perception checks automatically critically fail, and you take a −4 status penalty to Perception if vision was your only precise sense.",
    group: null,
    overrides: ["dazzled"],
    grants: [],
    effects: [],
  },
  broken: {
    name: "Broken",
    valued: false,
    summary: "An object condition: the item can't be used for its normal function. Broken armour still grants its AC bonus but adds a penalty (−1 light, −2 medium, −3 heavy).",
    group: null,
    overrides: [],
    grants: [],
    effects: [],
  },
  clumsy: {
    name: "Clumsy",
    valued: true,
    summary: "Status penalty equal to the value on Dexterity-based checks and DCs — AC, Reflex saves, ranged attack rolls, Acrobatics, Stealth and Thievery.",
    group: null,
    overrides: [],
    grants: [],
    effects: [{ stats: ["ac", "reflex"], type: "status", perValue: -1 }],
  },
  concealed: {
    name: "Concealed",
    valued: false,
    summary: "Attacks and effects targeting you require a DC 5 flat check to hit. Area effects ignore it.",
    group: "detection",
    overrides: [],
    grants: [],
    effects: [],
  },
  confused: {
    name: "Confused",
    valued: false,
    summary: "You're flat-footed, attack randomly determined targets, and can't act otherwise. Taking damage lets you attempt a DC 11 flat check to recover.",
    group: null,
    overrides: [],
    grants: [{ id: "flat-footed" }],
    effects: [],
  },
  controlled: {
    name: "Controlled",
    valued: false,
    summary: "Another creature dictates your actions and decisions entirely.",
    group: null,
    overrides: [],
    grants: [],
    effects: [],
  },
  dazzled: {
    name: "Dazzled",
    valued: false,
    summary: "If vision is your only precise sense, all creatures and objects are concealed to you.",
    group: null,
    overrides: [],
    grants: [],
    effects: [],
  },
  deafened: {
    name: "Deafened",
    valued: false,
    summary: "Can't hear. Hearing-based Perception checks automatically critically fail, and you take a −2 status penalty to initiative and to Perception checks involving sound.",
    group: null,
    overrides: [],
    grants: [],
    effects: [],
  },
  doomed: {
    name: "Doomed",
    valued: true,
    summary: "The dying value at which you die is reduced by this value. Decreases by 1 after a full night's rest.",
    group: "death",
    overrides: [],
    grants: [],
    effects: [],
  },
  drained: {
    name: "Drained",
    valued: true,
    summary: "Status penalty equal to the value on Constitution-based checks, such as Fortitude saves. You lose HP equal to your level times the value, and your maximum HP is reduced by the same amount. Decreases by 1 per night's rest.",
    group: null,
    overrides: [],
    grants: [],
    effects: [
      { stats: ["fortitude"], type: "status", perValue: -1 },
      // The only per-level term in the game: drained 2 on a level 5
      // character is -10 max HP, not -2.
      { stats: ["maxHp"], type: "untyped", perValue: -1, perLevel: true },
    ],
  },
  dying: {
    name: "Dying",
    valued: true,
    summary: "Unconscious and near death. At dying 4 you die. Attempt a recovery check each turn; damage increases the value by 1, or 2 from a critical hit.",
    group: "death",
    overrides: [],
    grants: [{ id: "unconscious" }],
    effects: [],
  },
  encumbered: {
    name: "Encumbered",
    valued: false,
    summary: "Carrying too much: you're clumsy 1 and take a −10-foot penalty to all Speeds.",
    group: null,
    overrides: [],
    grants: [{ id: "clumsy", value: 1 }],
    effects: [{ stats: ["speed"], type: "untyped", amount: -10 }],
  },
  enfeebled: {
    name: "Enfeebled",
    valued: true,
    summary: "Status penalty equal to the value on Strength-based rolls and DCs — melee attack rolls, melee damage and Athletics.",
    group: null,
    overrides: [],
    grants: [],
    // Real, but entirely on rolls this page doesn't show. Prose only.
    effects: [],
  },
  fascinated: {
    name: "Fascinated",
    valued: false,
    summary: "−2 status penalty to Perception and skill checks, and you can't use concentrate actions unless they relate to the subject of your fascination.",
    group: null,
    overrides: [],
    grants: [],
    effects: [{ stats: ["perception"], type: "status", amount: -2 }],
  },
  fatigued: {
    name: "Fatigued",
    valued: false,
    summary: "−1 status penalty to AC and saving throws, and you can't choose an exploration activity while travelling.",
    group: null,
    overrides: [],
    grants: [],
    effects: [{ stats: ["ac", "saves"], type: "status", amount: -1 }],
  },
  "flat-footed": {
    name: "Flat-Footed",
    valued: false,
    summary: "−2 circumstance penalty to AC. Many other conditions impose it.",
    group: null,
    overrides: [],
    grants: [],
    // Circumstance, not status — this is the one AC penalty that stacks
    // with frightened/sickened/clumsy/fatigued rather than competing.
    effects: [{ stats: ["ac"], type: "circumstance", amount: -2 }],
  },
  fleeing: {
    name: "Fleeing",
    valued: false,
    summary: "You must spend each action trying to escape the source of the condition, and can't Delay or Ready.",
    group: null,
    overrides: [],
    grants: [],
    effects: [],
  },
  friendly: {
    name: "Friendly",
    valued: false,
    summary: "NPC attitude: likes you and will likely accept simple, safe requests.",
    group: "attitude",
    overrides: [],
    grants: [],
    effects: [],
  },
  frightened: {
    name: "Frightened",
    valued: true,
    summary: "Status penalty equal to the value on all checks and DCs. Decreases by 1 at the end of each of your turns.",
    group: null,
    overrides: [],
    grants: [],
    // "All checks and DCs" includes AC: AC is a DC in PF2e.
    effects: [{ stats: ["checks-and-dcs"], type: "status", perValue: -1 }],
  },
  grabbed: {
    name: "Grabbed",
    valued: false,
    summary: "Flat-footed and immobilized. Manipulate actions require a DC 5 flat check or are lost.",
    group: null,
    overrides: [],
    grants: [{ id: "flat-footed" }, { id: "immobilized" }],
    effects: [],
  },
  helpful: {
    name: "Helpful",
    valued: false,
    summary: "NPC attitude: actively wants to assist you and accepts reasonable requests.",
    group: "attitude",
    overrides: [],
    grants: [],
    effects: [],
  },
  hidden: {
    name: "Hidden",
    valued: false,
    summary: "A creature knows roughly where you are but not your exact location. It's flat-footed to you, and targeting you requires a DC 11 flat check.",
    group: "detection",
    overrides: [],
    // Note the direction: hidden makes the *other* creature flat-footed to
    // you, not you flat-footed. Same for undetected/unnoticed below.
    grants: [],
    effects: [],
  },
  hostile: {
    name: "Hostile",
    valued: false,
    summary: "NPC attitude: actively seeks to harm you and won't accept requests.",
    group: "attitude",
    overrides: [],
    grants: [],
    effects: [],
  },
  immobilized: {
    name: "Immobilized",
    valued: false,
    summary: "You can't take any action with the move trait. Moving you by force requires a successful check.",
    group: null,
    overrides: [],
    grants: [],
    effects: [],
  },
  indifferent: {
    name: "Indifferent",
    valued: false,
    summary: "NPC attitude: doesn't care about you either way. The default starting attitude.",
    group: "attitude",
    overrides: [],
    grants: [],
    effects: [],
  },
  invisible: {
    name: "Invisible",
    valued: false,
    summary: "You can't be seen and are undetected to everyone. A successful Seek can make you merely hidden; you can't become observed except by special abilities.",
    group: "detection",
    overrides: [],
    grants: [{ id: "undetected" }],
    effects: [],
  },
  observed: {
    name: "Observed",
    valued: false,
    summary: "You're in plain view of a creature using a precise sense. The default detection state.",
    group: "detection",
    overrides: [],
    grants: [],
    effects: [],
  },
  paralyzed: {
    name: "Paralyzed",
    valued: false,
    summary: "Flat-footed and unable to act, except for actions requiring only your mind — such as Recall Knowledge.",
    group: null,
    overrides: [],
    grants: [{ id: "flat-footed" }],
    effects: [],
  },
  "persistent-damage": {
    name: "Persistent Damage",
    valued: true,
    summary: "Take the listed damage at the end of each of your turns, then attempt a DC 15 flat check to end it. Spending 2 actions on assistance grants an extra, easier check.",
    group: null,
    overrides: [],
    grants: [],
    // The value is damage dealt each turn, not a modifier — applying it to
    // HP automatically would silently change HP behind the DM's back.
    effects: [],
  },
  petrified: {
    name: "Petrified",
    valued: false,
    summary: "Turned to stone: you can't act or sense anything, and become an object with double your normal Bulk, AC 9 and Hardness 8.",
    group: null,
    overrides: [],
    grants: [],
    // Replaces AC outright rather than modifying it — not a term.
    effects: [],
  },
  prone: {
    name: "Prone",
    valued: false,
    summary: "Lying down: flat-footed, −2 circumstance penalty to attack rolls, and your only move actions are Crawl and Stand.",
    group: null,
    overrides: [],
    grants: [{ id: "flat-footed" }],
    effects: [],
  },
  quickened: {
    name: "Quickened",
    valued: false,
    summary: "Gain 1 extra action at the start of your turn. The granting effect says what that action may be used for.",
    group: null,
    overrides: [],
    grants: [],
    effects: [],
  },
  restrained: {
    name: "Restrained",
    valued: false,
    summary: "Tied up: flat-footed and immobilized, and you can take no actions except Escape and Force Open.",
    group: null,
    overrides: ["grabbed"],
    grants: [{ id: "flat-footed" }, { id: "immobilized" }],
    effects: [],
  },
  sickened: {
    name: "Sickened",
    valued: true,
    summary: "Status penalty equal to the value on all checks and DCs, and you can't willingly ingest anything. Spend 1 action retching to attempt a Fortitude save and reduce it by 1, or 2 on a critical success.",
    group: null,
    overrides: [],
    grants: [],
    effects: [{ stats: ["checks-and-dcs"], type: "status", perValue: -1 }],
  },
  slowed: {
    name: "Slowed",
    valued: true,
    summary: "Lose this many actions at the start of each of your turns.",
    group: null,
    overrides: [],
    grants: [],
    effects: [],
  },
  stunned: {
    name: "Stunned",
    valued: true,
    summary: "Lose actions equal to the value, spread across turns as needed; the value drops as actions are lost. Stunned overrides slowed for the turns it applies.",
    group: null,
    overrides: ["slowed"],
    grants: [],
    effects: [],
  },
  stupefied: {
    name: "Stupefied",
    valued: true,
    summary: "Status penalty equal to the value on Intelligence-, Wisdom- and Charisma-based checks and DCs, including Will saves and spell attack rolls. Casting a spell requires a DC 5 + value flat check or the spell is lost.",
    group: null,
    overrides: [],
    grants: [],
    // Perception is a Wisdom-based check, so it takes the penalty too.
    effects: [{ stats: ["will", "perception"], type: "status", perValue: -1 }],
  },
  unconscious: {
    name: "Unconscious",
    valued: false,
    summary: "Asleep or knocked out: you can't act, take a −4 status penalty to AC, Perception and Reflex saves, and are blinded and flat-footed. You fall prone and drop what you're holding.",
    group: "death",
    overrides: [],
    grants: [{ id: "blinded" }, { id: "flat-footed" }],
    effects: [{ stats: ["ac", "perception", "reflex"], type: "status", amount: -4 }],
  },
  undetected: {
    name: "Undetected",
    valued: false,
    summary: "A creature doesn't know where you are at all. It's flat-footed to you, and can only guess your square and attempt a secret check to hit.",
    group: "detection",
    overrides: [],
    grants: [],
    effects: [],
  },
  unfriendly: {
    name: "Unfriendly",
    valued: false,
    summary: "NPC attitude: dislikes and distrusts you, and won't accept requests.",
    group: "attitude",
    overrides: [],
    grants: [],
    effects: [],
  },
  unnoticed: {
    name: "Unnoticed",
    valued: false,
    summary: "A creature has no idea you're there at all. You're also undetected by it.",
    group: "detection",
    overrides: [],
    grants: [{ id: "undetected" }],
    effects: [],
  },
  wounded: {
    name: "Wounded",
    valued: true,
    summary: "Lingering injury, gained when you lose the dying condition. If you become dying again, its value increases by your wounded value.",
    group: "death",
    overrides: [],
    grants: [],
    effects: [],
  },
};

// "Frightened 2" vs plain "Blinded" — the valued flag is meaningless
// without knowing how to render it, so the one formatting rule that
// depends on it lives next to the data.
function formatCondition(id, value) {
  const condition = PF2E_CONDITIONS[id];
  if (!condition) return "";
  return condition.valued && value != null ? `${condition.name} ${value}` : condition.name;
}

// Every key an effect can be written against that ends up applying to a
// given stat, most specific first. Frightened writes one term against
// "checks-and-dcs" and it lands on all five checks *and* on AC, because
// AC is a DC in PF2e — that umbrella is why frightened lowers AC without
// the dictionary having to list five stats per entry.
//
// A stat missing from this map simply has no conditions that touch it;
// the panel only asks about the ones it displays.
const PF2E_STAT_SOURCES = {
  ac: ["ac", "dcs", "checks-and-dcs"],
  fortitude: ["fortitude", "saves", "checks", "checks-and-dcs"],
  reflex: ["reflex", "saves", "checks", "checks-and-dcs"],
  will: ["will", "saves", "checks", "checks-and-dcs"],
  perception: ["perception", "checks", "checks-and-dcs"],
  speed: ["speed"],
  maxHp: ["maxHp"],
};

const PF2E_CONDITION_DEFAULT_VALUE = 1;

// Turns what the DM ticked into what's actually in effect: grants expanded
// transitively, values merged, overridden conditions marked.
//
// `entries` is the stored map, { id: { active, value } }. Returns
// { id: { value, direct, grantedBy, overriddenBy } } where
//   value       the effective value (null for conditions with no tier)
//   direct      true if the DM applied it themselves (vs. purely granted)
//   grantedBy   ids of applied conditions that impose it
//   overriddenBy  id of a condition that supersedes it, if any
function resolveConditions(entries) {
  const effective = {};

  // Breadth-first over the grant graph rather than plain recursion: the
  // graph is small and acyclic today, but nothing in the data stops a
  // future entry from closing a loop, and a cycle here would hang render().
  // Revisiting an id merges into the existing record and stops, so each
  // condition expands its grants exactly once.
  const queue = [];
  for (const [id, entry] of Object.entries(entries ?? {})) {
    // Suppressed conditions contribute nothing — not their modifiers, and
    // not their grants either. That's the point of the checkbox.
    if (!entry?.active || !PF2E_CONDITIONS[id]) continue;
    queue.push({ id, value: entry.value ?? PF2E_CONDITION_DEFAULT_VALUE, from: null });
  }

  while (queue.length) {
    const { id, value, from } = queue.shift();
    const definition = PF2E_CONDITIONS[id];
    if (!definition) continue;

    const existing = effective[id];
    if (existing) {
      // Same condition reached twice (applied directly *and* granted, or
      // granted by two sources). PF2e keeps only the highest value.
      if (from && !existing.grantedBy.includes(from)) existing.grantedBy.push(from);
      if (!from) existing.direct = true;
      if (definition.valued && value > existing.value) existing.value = value;
      continue;
    }

    effective[id] = {
      value: definition.valued ? value : null,
      direct: !from,
      grantedBy: from ? [from] : [],
      overriddenBy: null,
    };
    for (const grant of definition.grants ?? []) {
      queue.push({ id: grant.id, value: grant.value ?? PF2E_CONDITION_DEFAULT_VALUE, from: id });
    }
  }

  // "Overrides" means the overridden condition's effects don't apply while
  // both are on. It stays in the map (it's still there, and comes back the
  // moment the overriding condition ends) — it just stops counting.
  //
  // No "skip conditions that are themselves overridden" guard here: that
  // would make the result depend on iteration order, and the three pairs
  // the rules define (blinded/dazzled, restrained/grabbed, stunned/slowed)
  // form no chains for it to matter on.
  for (const id of Object.keys(effective)) {
    for (const overridden of PF2E_CONDITIONS[id].overrides ?? []) {
      if (effective[overridden]) effective[overridden].overriddenBy = id;
    }
  }

  return effective;
}

// PF2e stacking: of several penalties of the same type only the worst
// applies, of several bonuses only the best, and untyped terms always
// stack. A bonus and a penalty of the same type don't cancel out as a
// pair — each side picks its own winner and the two are summed.
//
// Terms that lost are kept in the result with applied: false rather than
// dropped, so a "why is my AC this number" hint can show the DM that
// clumsy 1 is on but frightened 2 is what's actually biting.
function combineModifierTerms(terms) {
  const winners = new Map();
  const result = terms.map((term) => ({ ...term, applied: true }));

  for (const term of result) {
    if (term.type === "untyped") continue;
    const key = `${term.type}:${term.amount < 0 ? "penalty" : "bonus"}`;
    const current = winners.get(key);
    if (!current) {
      winners.set(key, term);
      continue;
    }
    const beats = term.amount < 0 ? term.amount < current.amount : term.amount > current.amount;
    if (beats) {
      current.applied = false;
      winners.set(key, term);
    } else {
      term.applied = false;
    }
  }

  const total = result.reduce((sum, term) => sum + (term.applied ? term.amount : 0), 0);
  return { total, terms: result };
}

// The numeric side of a resolved condition set: { stat: { total, terms } }
// for every stat in PF2E_STAT_SOURCES, including stats nothing touched
// (total 0, no terms) so callers can read modifiers.ac unconditionally.
//
// `level` is only used by drained, whose max-HP reduction scales with it.
function conditionModifiers(effective, level = 1) {
  const collected = {};

  for (const [id, state] of Object.entries(effective ?? {})) {
    if (state.overriddenBy) continue;
    const definition = PF2E_CONDITIONS[id];
    if (!definition) continue;

    for (const effect of definition.effects ?? []) {
      let amount = effect.perValue != null
        ? effect.perValue * (state.value ?? PF2E_CONDITION_DEFAULT_VALUE)
        : (effect.amount ?? 0);
      if (effect.perLevel) amount *= level;
      if (!amount) continue;

      const term = {
        amount,
        type: effect.type ?? "untyped",
        conditionId: id,
        source: formatCondition(id, state.value),
      };
      for (const stat of effect.stats) {
        if (!collected[stat]) collected[stat] = [];
        collected[stat].push(term);
      }
    }
  }

  const modifiers = {};
  for (const [stat, sources] of Object.entries(PF2E_STAT_SOURCES)) {
    // One term object is shared across every stat its effect names, so a
    // Set is enough to stop it being counted twice when an effect lists
    // both a concrete stat and an umbrella covering it (e.g. a future
    // stats: ["reflex", "saves"]). Nothing in the dictionary does that
    // today; this keeps it from silently doubling if something does.
    const seen = new Set();
    const terms = [];
    for (const key of sources) {
      for (const term of collected[key] ?? []) {
        if (seen.has(term)) continue;
        seen.add(term);
        terms.push(term);
      }
    }
    modifiers[stat] = combineModifierTerms(terms);
  }
  return modifiers;
}
