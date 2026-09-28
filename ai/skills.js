'use strict';
/* ====================================================================== *
 *  ai/skills.js — what a selected skill means.
 *
 *  A skill is a named block of operating guidance plus the capabilities it
 *  needs. Selecting a skill therefore has two real effects:
 *    1. its instruction text is added to the agent context
 *    2. the capabilities it requires are granted, so its tools exist
 *  There is no decorative checkbox: an unknown id is rejected and a skill
 *  whose capabilities are switched off by hand is reported as unavailable.
 *
 *  The guidance text is not in this file. It is in ai/rules.js, because a const
 *  array is the reason the agent cannot correct itself: this module decides what
 *  a selected skill *means*, the store decides what it *says*, and only a person
 *  moves the second one. There is deliberately no second copy of the guidance
 *  here — two sources of truth is a bug this project has already had.
 * ====================================================================== */

const rules = require('./rules');

/** the guidance in effect: what shipped, with approved edits on top */
const catalog = () => rules.catalog();

const CAP_KEYS = rules.CAP_KEYS;

function known(id) { return rules.byId().get(id) || null; }

function sanitize(ids) {
  const knownIds = rules.byId();
  const out = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id === 'string' && knownIds.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Work out what a profile's skills mean for its tool access.
 * @param {string[]} ids     selected skill ids (unknown ones are dropped)
 * @param {object}  tools    the profile's capability flags
 * @returns {{selected, unknown, granted, blocked, caps}}
 */
function resolve(ids, tools) {
  const byId = rules.byId();
  const flags = {};
  for (const k of CAP_KEYS) flags[k] = !!(tools && tools[k]);

  const selected = [];
  const unknown = (Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && !byId.has(id));
  const blocked = [];
  const granted = {};

  for (const id of sanitize(ids)) {
    const skill = byId.get(id);
    const missing = skill.requires.filter(c => !flags[c]);
    if (missing.length) {
      blocked.push({ id, name: skill.name, missing });
      continue;
    }
    selected.push({
      id, name: skill.name, description: skill.description,
      instruction: skill.instruction, requires: skill.requires,
    });
    for (const c of skill.requires) granted[c] = true;
  }

  const caps = Object.assign({}, flags, granted);
  return { selected, blocked, unknown: Array.from(new Set(unknown)), granted, caps };
}

/** the markdown block that goes into the agent context */
function instructionBlock(resolved) {
  if (!resolved.selected.length) return '';
  return resolved.selected
    .map(s => `- **${s.name}** (tools: ${s.requires.join(', ')})\n  ${s.instruction}`)
    .join('\n');
}

module.exports = { catalog, CAP_KEYS, known, sanitize, resolve, instructionBlock };
