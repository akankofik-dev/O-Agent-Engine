'use strict';
/* ====================================================================== *
 *  ai/agentfiles.js — per-agent SOUL.md and MEMORY.md.
 *
 *  Storage layout:
 *      data/agents/<agent-id>/SOUL.md
 *      data/agents/<agent-id>/MEMORY.md
 *
 *  Two rules are enforced here and nowhere else:
 *    1. an agent id is a strict whitelist pattern, never a path fragment
 *    2. every resolved path must stay inside the agent data directory
 *  So the agent runtime can read its own identity/memory and nothing else.
 * ====================================================================== */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'data', 'agents');
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_BYTES = 128 * 1024;

const DEFAULT_SOUL = `# Who this agent is

<!--
This file is the agent's identity: who it is and how it behaves.
It is loaded into the system context on every run.

Keep it short. It is sent to the model every single turn.

This is the heaviest sentence in the whole system and it outranks everything
else that describes the agent — the core instructions, the tool list, the task.
The first version read "You are a careful browser automation agent", which is
a claim about what this is rather than how to behave, and it is in the wrong
tense: it says what the agent does today instead of how it should decide. A
browser is one of the things it may reach for, not what it is. An agent given
a tool it does not need, and told it is that tool, will go looking for a
reason to use it — which is the whole failure this sentence produced.
-->

You are careful about what you claim.
You verify before you say something happened.
You do not assume a tool is the right one just because it is familiar to you.
`;

const DEFAULT_MEMORY = `# Project Memory

<!--
Persistent facts this agent should remember between runs.
Facts, not instructions — behaviour belongs in SOUL.md.
-->

## Browser Preferences

- 

## Project Context

- 
`;

const DEFAULTS = { 'SOUL.md': DEFAULT_SOUL, 'MEMORY.md': DEFAULT_MEMORY };

function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function assertId(id) {
  if (!isValidId(id)) throw new Error('invalid agent id');
  return id;
}

function dirFor(agentId) {
  assertId(agentId);
  const dir = path.resolve(ROOT, agentId);
  const base = path.resolve(ROOT);
  if (dir !== base && !dir.startsWith(base + path.sep)) {
    throw new Error('agent path escapes the agent data directory');
  }
  return dir;
}

function fileFor(agentId, name) {
  if (name !== 'SOUL.md' && name !== 'MEMORY.md') throw new Error('unknown agent file: ' + name);
  return path.join(dirFor(agentId), name);
}

function ensureDir(agentId) {
  const dir = dirFor(agentId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readOne(agentId, name) {
  try {
    const raw = fs.readFileSync(fileFor(agentId, name), 'utf8');
    return { content: raw, exists: true, bytes: Buffer.byteLength(raw, 'utf8') };
  } catch (e) {
    if (e.code === 'ENOENT') return { content: DEFAULTS[name], exists: false, bytes: Buffer.byteLength(DEFAULTS[name], 'utf8') };
    throw e;
  }
}

function writeOne(agentId, name, content) {
  const text = String(content == null ? '' : content);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_BYTES) throw new Error(`${name} is too large (${bytes} bytes, limit ${MAX_BYTES})`);
  ensureDir(agentId);
  const file = fileFor(agentId, name);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  return { content: text, exists: true, bytes };
}

/** both documents, with the built-in template used when a file is absent */
function read(agentId) {
  const dir = dirFor(agentId);
  const soul = readOne(agentId, 'SOUL.md');
  const memory = readOne(agentId, 'MEMORY.md');
  return {
    soul: soul.content,
    memory: memory.content,
    soulMeta: { exists: soul.exists, bytes: soul.bytes },
    memoryMeta: { exists: memory.exists, bytes: memory.bytes },
    dir,
    defaults: DEFAULTS,
    limits: { maxBytes: MAX_BYTES },
  };
}

/** partial write — only the keys present are touched */
function write(agentId, patch) {
  const out = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'soul')) out.soul = writeOne(agentId, 'SOUL.md', patch.soul);
  if (Object.prototype.hasOwnProperty.call(patch, 'memory')) out.memory = writeOne(agentId, 'MEMORY.md', patch.memory);
  if (!Object.keys(out).length) throw new Error('nothing to save — send soul and/or memory');
  return { saved: Object.keys(out) };
}

/** back to the built-in template; used by the Settings "reset" action */
function reset(agentId, which) {
  const target = which || 'all';
  if (target !== 'all' && target !== 'soul' && target !== 'memory') {
    throw new Error('reset expects soul, memory or all');
  }
  const done = [];
  if (target === 'all' || target === 'soul') { writeOne(agentId, 'SOUL.md', DEFAULTS['SOUL.md']); done.push('soul'); }
  if (target === 'all' || target === 'memory') { writeOne(agentId, 'MEMORY.md', DEFAULTS['MEMORY.md']); done.push('memory'); }
  return { reset: done };
}

function removeDir(agentId) {
  const dir = dirFor(agentId);
  fs.rmSync(dir, { recursive: true, force: true });
  return { removed: true };
}

function exists(agentId) {
  try { return fs.existsSync(dirFor(agentId)); } catch { return false; }
}

module.exports = { ROOT, MAX_BYTES, DEFAULTS, ID_RE, isValidId, dirFor, fileFor, read, write, reset, removeDir, exists };
