'use strict';
/* ====================================================================== *
 *  ai/skills.js — the skill abstraction.
 *
 *  A skill is a named block of operating guidance plus the capabilities it
 *  needs. Selecting a skill therefore has two real effects:
 *    1. its instruction text is added to the agent context
 *    2. the capabilities it requires are granted, so its tools exist
 *  There is no decorative checkbox: an unknown id is rejected and a skill
 *  whose capabilities are switched off by hand is reported as unavailable.
 * ====================================================================== */

const CATALOG = [
  {
    id: 'browser-research',
    name: 'Browser Research',
    description: 'Follow a question across several pages, reading structure instead of guessing.',
    requires: ['browser', 'dom'],
    instruction: [
      'Browser research: form a specific question before you navigate.',
      'Read the page before you decide anything, and follow links that actually answer the question.',
      'Record the source url with every finding so the user can check it.',
    ].join(' '),
  },
  {
    id: 'web-extraction',
    name: 'Web Extraction',
    description: 'Pull structured data out of a page and report it as text, not as a guess.',
    requires: ['dom'],
    instruction: [
      'Extraction: prefer DOM content and structured attributes over anything visual.',
      'Report only values you actually read, and say explicitly when a field is missing.',
    ].join(' '),
  },
  {
    id: 'screenshot-analysis',
    name: 'Screenshot Analysis',
    description: 'Use the rendered viewport when the DOM does not describe what is on screen.',
    requires: ['screenshot'],
    instruction: [
      'Screenshots: capture the viewport when layout, state or rendering matters, not for text you can already read.',
      'Describe what is visible and never infer off-screen content.',
    ].join(' '),
  },
  {
    id: 'coding',
    name: 'Coding',
    description: 'Read and reason about source code, including code running in the page.',
    requires: ['dom', 'javascript'],
    instruction: [
      'Coding: quote the exact line you are reasoning about before changing it.',
      'Use javascript evaluation to inspect live state instead of speculating about it.',
    ].join(' '),
  },
  {
    id: 'terminal',
    name: 'Terminal',
    description: 'Shell access for files, processes and version control on this machine.',
    requires: ['terminal'],
    instruction: [
      'Terminal: run one command at a time and read the output before continuing.',
      'Show the command you ran, and never claim a file changed without seeing the output.',
    ].join(' '),
  },
];

const BY_ID = new Map(CATALOG.map(s => [s.id, s]));
const CAP_KEYS = ['browser', 'screenshot', 'dom', 'javascript', 'terminal'];

function known(id) { return BY_ID.get(id) || null; }

function sanitize(ids) {
  const out = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id === 'string' && BY_ID.has(id) && !out.includes(id)) out.push(id);
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
  const flags = {};
  for (const k of CAP_KEYS) flags[k] = !!(tools && tools[k]);

  const selected = [];
  const unknown = (Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && !BY_ID.has(id));
  const blocked = [];
  const granted = {};

  for (const id of sanitize(ids)) {
    const skill = BY_ID.get(id);
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

module.exports = { CATALOG, CAP_KEYS, known, sanitize, resolve, instructionBlock };
