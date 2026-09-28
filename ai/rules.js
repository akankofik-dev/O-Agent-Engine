'use strict';
/* ====================================================================== *
 *  ai/rules.js — the agent's own operating rules, as data.
 *
 *  A skill is a block of guidance the agent follows. Until now that guidance was
 *  a const array in the module, which means two things: it cannot be corrected
 *  without shipping code, and an agent that notices its own instruction is wrong
 *  has nowhere to say so. This is that somewhere.
 *
 *  Two files, on purpose, because the trust boundary is the point:
 *
 *    data/rules.json             the rules in effect. Only the server writes it,
 *                                and only when a person approves.
 *    data/rule-proposals.json    changes waiting for a person. The agent can
 *                                write nothing else — rule_edit() cannot reach
 *                                the applied file even by accident, because it
 *                                does not open it.
 *
 *  Overrides rather than a whole replacement catalog. A proposal then *is* the
 *  diff the person reads, and improving a seed skill in a later release does not
 *  silently revert someone's edit: the override is still there, on top of a
 *  better base.
 *
 *  rung 2, deliberately: an agent may propose, a person applies. See the limits
 *  below for what an agent may not propose at all.
 * ====================================================================== */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data');
const RULES_FILE = path.join(DIR, 'rules.json');
const PROPOSALS_FILE = path.join(DIR, 'rule-proposals.json');

/* Normally these two. A test points them somewhere disposable, because a test
   * that rewrites the person's real rules would be making their decisions. */
let dirOverride = null;
const rulesFile = () => (dirOverride ? path.join(dirOverride, 'rules.json') : RULES_FILE);
const proposalsFile = () => (dirOverride ? path.join(dirOverride, 'rule-proposals.json') : PROPOSALS_FILE);

/** point the store at another directory, or back at the real one with no argument */
function useDir(dir) {
  dirOverride = dir || null;
  invalidate();
  return dirOverride;
}

/* the shipped guidance. An override sits on top of this and survives a change
   to it, which is the whole reason overrides are stored separately. */
const SEED_SKILLS = [
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

const CAP_KEYS = ['browser', 'screenshot', 'dom', 'javascript', 'terminal', 'rules'];

/* ── what an agent is allowed to propose ──────────────────────────────────
 *
 * Prose only. `requires` is the field that grants capabilities, so an agent
 * able to propose it could hand itself the terminal capability the person just
 * switched off — the override would be a back door around the tool toggle that
 * is supposed to be the thing deciding. A new skill is refused for the same
 * reason: a new skill carries its own requires, and would arrive asking for
 * exactly the capability it was not given.
 *
 * So: existing skill, prose field, nothing else. Widening this is rung 3 and
 * should be a decision rather than a default. */
const EDITABLE = ['name', 'description', 'instruction'];
const MAX_LEN = { name: 80, description: 400, instruction: 4000 };
const MAX_REASON = 500;
const MAX_PENDING = 50;      /* a queue a person can actually read */
const MAX_HISTORY = 30;

const str = v => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const isPlain = v => !!v && typeof v === 'object' && !Array.isArray(v);

/* Control characters are refused rather than trimmed. An instruction is prose
 * that goes into a prompt, and a proposal is text a person has to read on one
 * line in a list; a zero-width or a bell in it is not something a person can
 * see and not something they should be able to save. Tab and newline are the two
 * that carry meaning. */
const BAD_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/;

function bad(why) { return { ok: false, error: why }; }

/* ── storage ────────────────────────────────────────────────────────────── */

/* tmp + rename, the same way ai/store.js does it: a crash mid-write leaves the
   previous file whole rather than a half-written one. */
function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort on Windows */ }
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const clone = v => JSON.parse(JSON.stringify(v));

let rulesCache = null;
let pendingCache = null;
let rulesStamp = null;
let pendingStamp = null;

/** mtime and length, or 'absent'. Compared, never trusted on its own. */
function stampOf(file) {
  try {
    const s = fs.statSync(file);
    return s.mtimeMs + ':' + s.size;
  } catch {
    return 'absent';
  }
}

function loadRules() {
  const stamp = stampOf(rulesFile());
  if (rulesCache && stamp === rulesStamp) return rulesCache;
  const raw = readJson(rulesFile());
  const out = {
    version: Number(raw && raw.version) > 0 ? Number(raw.version) : 1,
    overrides: {},
    history: [],
  };
  if (isPlain(raw) && isPlain(raw.overrides)) {
    for (const [id, patch] of Object.entries(raw.overrides)) {
      if (!knownSeed(id) || !isPlain(patch)) continue;
      const clean = {};
      /* only fields that still exist and pass the same limits as a proposal.
         A hand-edited file gets the same door check as an agent. */
      for (const [k, v] of Object.entries(patch)) {
        if (!EDITABLE.includes(k)) continue;
        const s = str(v).trim();
        if (!s || s.length > MAX_LEN[k] || BAD_CHARS.test(s)) continue;
        clean[k] = s;
      }
      if (Object.keys(clean).length) out.overrides[id] = clean;
    }
  }
  if (isPlain(raw) && Array.isArray(raw.history)) {
    out.history = raw.history.filter(h => isPlain(h) && h.version).slice(-MAX_HISTORY);
  }
  rulesCache = out;
  rulesStamp = stamp;
  return out;
}

function loadPending() {
  const stamp = stampOf(proposalsFile());
  if (pendingCache && stamp === pendingStamp) return pendingCache;
  const raw = readJson(proposalsFile());
  const list = raw && Array.isArray(raw.pending) ? raw.pending : [];
  pendingCache = { pending: list.filter(p => isPlain(p) && p.id && knownSeed(p.skillId)) };
  pendingStamp = stamp;
  return pendingCache;
}

function saveRules(next) {
  writeAtomic(rulesFile(), next);
  rulesCache = next;
  rulesStamp = stampOf(rulesFile());
}

/* a save re-stamps, so the next read is still a cache hit rather than a stat
   that misses and re-reads a file this module just wrote */
function savePending(next) {
  writeAtomic(proposalsFile(), next);
  pendingCache = next;
  pendingStamp = stampOf(proposalsFile());
}

function knownSeed(id) { return SEED_SKILLS.some(s => s.id === id); }
function seed(id) { return SEED_SKILLS.find(s => s.id === id) || null; }

/* ── reading ────────────────────────────────────────────────────────────── */

/** the catalog in effect: seed, with approved overrides laid over it */
function catalog() {
  const ov = loadRules().overrides;
  return SEED_SKILLS.map(s => (ov[s.id] ? Object.assign({}, s, ov[s.id]) : s));
}

function byId() { return new Map(catalog().map(s => [s.id, s])); }

/** what a person sees as the pending change, with the current value alongside */
function currentValue(skillId, field) {
  const s = seed(skillId);
  if (!s) return null;
  const ov = loadRules().overrides[skillId];
  return (ov && ov[field] !== undefined) ? ov[field] : s[field];
}

function listProposals() {
  return loadPending().pending.map(p => {
    const s = seed(p.skillId);
    return {
      id: p.id,
      skillId: p.skillId,
      skillName: s ? s.name : p.skillId,
      field: p.field,
      from: currentValue(p.skillId, p.field),
      to: p.value,
      reason: p.reason,
      at: p.at,
      by: p.by,
      stale: currentValue(p.skillId, p.field) !== (p.base === undefined ? currentValue(p.skillId, p.field) : p.base),
    };
  });
}

function history() { return loadRules().history.slice(); }

/* ── rung 2: the agent may propose, only ────────────────────────────────── */

function validate(p) {
  if (!isPlain(p)) return bad('a proposal must be an object');
  const skillId = str(p.skillId).trim();
  if (!skillId) return bad('skillId is required');
  if (!knownSeed(skillId)) return bad('no such skill: ' + skillId);
  const field = str(p.field).trim();
  if (!EDITABLE.includes(field)) {
    return bad('field must be one of ' + EDITABLE.join(', ') +
      ' — requires and new skills are not the agent\'s to change');
  }
  const value = str(p.value).trim();
  if (!value) return bad(field + ' cannot be empty');
  if (value.length > MAX_LEN[field]) return bad(field + ' is ' + value.length + ' characters, the limit is ' + MAX_LEN[field]);
  if (BAD_CHARS.test(value)) return bad(field + ' contains control characters');
  const reason = str(p.reason).trim();
  if (!reason) return bad('reason is required — an unexplained change is not reviewable');
  if (reason.length > MAX_REASON) return bad('reason is over ' + MAX_REASON + ' characters');
  return { ok: true, skillId, field, value, reason };
}

let seq = 0;
function newId() {
  seq += 1;
  return 'rp_' + Date.now().toString(36) + '_' + seq.toString(36);
}

function propose(input, by) {
  const v = validate(input);
  if (!v.ok) return v;
  const cur = loadPending();
  /* the same edit twice is one question, not two */
  const dup = cur.pending.findIndex(p => p.skillId === v.skillId && p.field === v.field);
  if (dup !== -1) {
    if (cur.pending[dup].value === v.value) {
      return { ok: true, duplicate: true, id: cur.pending[dup].id, state: 'already proposed' };
    }
    const next = { pending: cur.pending.slice() };
    next.pending[dup] = Object.assign({}, cur.pending[dup], {
      value: v.value, reason: v.reason, at: new Date().toISOString(), by: str(by) || 'agent',
    });
    savePending(next);
    return { ok: true, id: next.pending[dup].id, state: 'revised' };
  }
  if (cur.pending.length >= MAX_PENDING) return bad('there are already ' + MAX_PENDING + ' proposals waiting; approve or reject some first');
  const entry = {
    id: newId(), skillId: v.skillId, field: v.field, value: v.value,
    reason: v.reason, at: new Date().toISOString(), by: str(by) || 'agent',
    base: currentValue(v.skillId, v.field),
  };
  savePending({ pending: cur.pending.concat([entry]) });
  return { ok: true, id: entry.id, state: 'proposed' };
}

/* ── a person decides ───────────────────────────────────────────────────── */

function findPending(id) {
  return loadPending().pending.find(p => p.id === id) || null;
}

function reject(id) {
  const cur = loadPending();
  const p = findPending(id);
  if (!p) return bad('no such proposal: ' + id);
  savePending({ pending: cur.pending.filter(x => x.id !== id) });
  return { ok: true, id, state: 'rejected' };
}

function approve(id) {
  const p = findPending(id);
  if (!p) return bad('no such proposal: ' + id);
  const v = validate(p);
  if (!v.ok) return v;

  const rules = loadRules();
  const before = clone(rules.overrides);
  const overrides = Object.assign({}, rules.overrides);
  overrides[p.skillId] = Object.assign({}, overrides[p.skillId], { [p.field]: v.value });

  const next = {
    version: rules.version + 1,
    overrides,
    history: rules.history.concat([{
      version: rules.version + 1,
      at: new Date().toISOString(),
      reason: v.reason,
      by: p.by,
      skillId: p.skillId,
      field: p.field,
      from: before[p.skillId] ? before[p.skillId][p.field] : (seed(p.skillId) || {})[p.field],
      to: v.value,
      /* both sides, so that reverting the first approval returns to the shipped
         text rather than to a state that no entry describes */
      before: before,
      overrides: clone(overrides),
    }]).slice(-MAX_HISTORY),
  };
  saveRules(next);
  savePending({ pending: loadPending().pending.filter(x => x.id !== id) });
  return { ok: true, id, state: 'approved', version: next.version, skillId: p.skillId, field: p.field };
}

function revert(version) {
  const rules = loadRules();
  const h = rules.history.find(x => Number(x.version) === Number(version));
  if (!h) return bad('no such version in the history: ' + version);
  /* the state that was in effect *before* that change. An entry written before
     this field existed cannot be reverted to, and says so rather than guessing. */
  if (!isPlain(h.before)) return bad('that version is too old to revert — its previous state was never recorded');
  const next = {
    version: rules.version + 1,
    overrides: clone(h.before),
    history: rules.history.concat([{
      version: rules.version + 1,
      at: new Date().toISOString(),
      reason: 'reverted to ' + h.version + ': ' + str(h.reason || '').slice(0, 200),
      by: 'person',
      skillId: null, field: null, from: null, to: null,
      before: clone(rules.overrides),
      overrides: clone(h.before),
    }]).slice(-MAX_HISTORY),
  };
  saveRules(next);
  return { ok: true, state: 'reverted', to: h.version, version: next.version };
}

/** drop every override and go back to the shipped guidance */
function reset() {
  const rules = loadRules();
  saveRules({
    version: rules.version + 1,
    overrides: {},
    history: rules.history.concat([{
      version: rules.version + 1, at: new Date().toISOString(),
      reason: 'reset to the shipped guidance', by: 'person',
      skillId: null, field: null, from: null, to: null,
      before: clone(rules.overrides), overrides: {},
    }]).slice(-MAX_HISTORY),
  });
  return { ok: true, state: 'reset', version: rules.version + 1 };
}

/** tests and a second process need to see a change on disk */
function invalidate() {
  rulesCache = null;
  pendingCache = null;
  rulesStamp = null;
  pendingStamp = null;
}

function state() {
  const rules = loadRules();
  return {
    version: rules.version,
    overridden: Object.entries(rules.overrides).map(([skillId, patch]) => ({ skillId, fields: Object.keys(patch) })),
    pending: listProposals(),
    history: history().map(h => ({ version: h.version, at: h.at, reason: h.reason, by: h.by, skillId: h.skillId, field: h.field })),
    skills: catalog(),
  };
}

module.exports = {
  SEED_SKILLS, CAP_KEYS, EDITABLE, RULES_FILE, PROPOSALS_FILE, useDir,
  catalog, byId, state, propose, listProposals, history,
  approve, reject, revert, reset, invalidate, currentValue,
};
