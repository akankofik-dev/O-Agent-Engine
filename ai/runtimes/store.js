'use strict';
/* ====================================================================== *
 *  ai/runtimes/store.js — what runtimes are configured, and nothing else.
 *
 *  data/runtimes.json, written the way ai/store.js writes its own file: to a
 *  temp path, chmod 0600, then renamed. A half-written config is a config that
 *  loses somebody's endpoint on the next boot, and a world-readable one is a
 *  config that hands an API key to everything else on the machine.
 *
 *  Two things this file will not do
 *  --------------------------------
 *  It will not store a status. A stored status is a stale status, and the whole
 *  point of the five states is that one of them is a fact about a probe that has
 *  just happened. There is no `status` field on disk and there is not going to
 *  be one.
 *
 *  It will not hand a secret to the browser. publicView() is the only thing that
 *  leaves, and it carries hasKey and keyHint — the same two fields ai/store.js
 *  uses for a provider key, and for the same reason: a reviewer needs to know
 *  WHICH key is configured without the page ever holding it.
 * ====================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', '..', 'data');
const FILE = path.join(DIR, 'runtimes.json');

const MAX_NAME = 80;
const MAX_ENDPOINT = 400;
const MAX_CWD = 400;
const MAX_TIMEOUT_MS = 120000;
const MIN_TIMEOUT_MS = 300;

/* a type the registry has to agree with, asked of the registry and not written
   out here — the failure this project has already had once, in provider land */
let typesProvider = () => [];
function setTypes(fn) { typesProvider = typeof fn === 'function' ? fn : () => []; }

/* The adapter's own default endpoint, for the same reason: a second table of
   defaults in this file would be a second thing to forget to update. */
let defaultProvider = () => '';
function setDefaults(fn) { defaultProvider = typeof fn === 'function' ? fn : () => ''; }

const str = (v, d = '') => (v === undefined || v === null ? d : String(v));
const isPlain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const uid = (p) => p + '_' + crypto.randomBytes(6).toString('hex');

/** the last four, and nothing else. Copied rather than shared so this module
 *  keeps its zero-dependency-on-the-adapters property. */
function keyHint(key) {
  const k = String(key || '');
  if (!k) return '';
  return k.length <= 4 ? '••••' : '••••' + k.slice(-4);
}

/** an endpoint has to look like one. A typo here is a status of `unavailable`
 *  forever, and the message "nothing is answering on http:/127.0.0.1:8642" is
 *  much worse than being refused at save time.
 *
 *  The `//` is checked as TEXT, before the URL parser is asked, and that is not
 *  fussiness. `new URL('http:/x.test')` does not throw — it quietly returns
 *  `http://x.test/`, so the one typo a person actually makes when typing a URL is
 *  the one this would have accepted and silently repaired. A store that repairs
 *  a value saves it and reads it back as though it had been typed, which is the
 *  whole reason the rest of this function refuses rather than corrects. */
function validEndpoint(v) {
  const s = str(v).trim();
  if (!s) return false;
  if (s.length > MAX_ENDPOINT) return false;
  if (!/^https?:\/\//i.test(s)) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

function bad(why) { return { ok: false, error: why }; }

/**
 * Normalise one stored record, and refuse it rather than repair it.
 *
 * Repairing is what makes a store grow fields nobody chose: a bad value is
 * corrected, saved, and read back as though it had been typed. So this returns
 * the reason and lets the caller show it.
 */
function normRuntime(input, prev) {
  if (!isPlain(input)) return bad('a runtime has to be an object');
  const known = typesProvider();
  const type = str(input.type || (prev && prev.type)).trim();
  if (!type) return bad('an agent type is required');
  if (known.length && !known.includes(type)) {
    return bad('"' + type + '" is not a runtime this build has an adapter for. It has: ' + known.join(', '));
  }

  const endpoint = str(input.endpoint !== undefined ? input.endpoint : (prev && prev.endpoint)).trim();
  /* Empty is not an error: it means "use the adapter's default", which is how
     hermes gets 127.0.0.1:8642 without that address being written down twice —
     once here and once in the form. What IS an error is a half-typed url, because
     that produces an `unavailable` forever with a message about the wrong host. */
  const fallback = str(defaultProvider(type), '').trim();
  if (!endpoint && !fallback) return bad('an endpoint is required');
  if (endpoint && !validEndpoint(endpoint)) return bad('"' + endpoint + '" is not an http or https url');
  const finalEndpoint = (endpoint || fallback).replace(/\/+$/, '');

  const timeoutMs = Math.max(MIN_TIMEOUT_MS,
    Math.min(MAX_TIMEOUT_MS, Number(input.timeoutMs !== undefined ? input.timeoutMs : (prev && prev.timeoutMs)) || 4000));

  /* Three states, and the form needs all three because it never receives the key.
       absent / empty  leave the stored one alone — a form round-tripping an
                      existing record submits an empty field, and reading that as
                      "forget the key" would wipe it every time somebody saved
       clearKey:true  remove it, stated as an intent rather than encoded in a
                      magic string
       anything else  replace it

     The middle case was originally a NUL-prefixed sentinel, which is the kind of
     cleverness that costs later: a raw NUL in a source file makes it binary to
     grep and to every diff tool, and it collides with any real key that happened
     to start the same way. A named boolean cannot collide with a key. */
  let apiKey;
  if (input.clearKey === true || input.clearKey === 'true') {
    apiKey = '';
  } else if (input.apiKey === undefined || input.apiKey === null || input.apiKey === '') {
    apiKey = prev && prev.apiKey ? prev.apiKey : '';
  } else {
    apiKey = str(input.apiKey).slice(0, 4000);
  }

  const out = {
    id: str(input.id || (prev && prev.id) || uid('rt')).slice(0, 64),
    name: str(input.name !== undefined ? input.name : (prev && prev.name)).trim().slice(0, MAX_NAME) || 'Agent',
    type,
    endpoint: finalEndpoint,
    apiKey,
    model: str(input.model !== undefined ? input.model : (prev && prev.model)).trim().slice(0, 120),
    timeoutMs,
    cwd: str(input.cwd !== undefined ? input.cwd : (prev && prev.cwd)).trim().slice(0, MAX_CWD),
    /* What the person said this runtime is for. Kept because a list of six
       runtimes with six identical subtitles is a list nobody can choose from. */
    note: str(input.note !== undefined ? input.note : (prev && prev.note)).trim().slice(0, 300),
  };
  if (prev && prev.createdAt) out.createdAt = prev.createdAt;
  out.updatedAt = new Date().toISOString();
  return { ok: true, runtime: out };
}

function normalize(raw) {
  const known = typesProvider();
  const list = Array.isArray(raw && raw.runtimes) ? raw.runtimes : [];
  const runtimes = [];
  for (const r of list) {
    /* Same rule as ai/store.js: a record whose type this build has no adapter for
       is DROPPED, not kept and refused later. A config that carries an
       unopenable entry is a config that fails to load, and then the person
       cannot even see the five they can. */
    if (!isPlain(r)) continue;
    if (known.length && !known.includes(String(r.type || ''))) continue;
    const v = normRuntime(r);
    if (v.ok) runtimes.push(v.runtime);
  }
  return { version: 1, runtimes };
}

/* ------------------------------ store -------------------------------- */

let cache = null;
let fileOverride = '';

function file() { return fileOverride || FILE; }
function useFile(f) { fileOverride = String(f || ''); cache = null; }

function load() {
  if (cache) return cache;
  try {
    cache = normalize(JSON.parse(fs.readFileSync(file(), 'utf8')));
  } catch {
    cache = normalize(null);
  }
  return cache;
}

function persist() {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  /* mode on the write, not a chmod after it: there is a window between the two
     in which the file exists at the default umask. */
  try {
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch {
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  }
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort on Windows */ }
  fs.renameSync(tmp, f);
}

function invalidate() { cache = null; }

/* ------------------------------------------------------------ redaction */

/**
 * Exactly what leaves the server.
 *
 * The field list is written out rather than produced by deleting keys, because a
 * delete-the-secret approach goes stale the moment somebody adds a field called
 * token or password and forgets. An allow list fails closed: the new field is
 * simply not sent until somebody decides it should be.
 */
function publicView(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    endpoint: r.endpoint,
    model: r.model || '',
    cwd: r.cwd || '',
    note: r.note || '',
    timeoutMs: r.timeoutMs,
    hasKey: !!r.apiKey,
    keyHint: keyHint(r.apiKey),
    createdAt: r.createdAt || '',
    updatedAt: r.updatedAt || '',
  };
}

/** the whole configuration, for GET */
function publicAll() {
  return load().runtimes.map(publicView);
}

function get(id) {
  return load().runtimes.find(r => r.id === id) || null;
}

/** the raw record, secrets and all. Server-side callers only. */
function getRaw(id) { return get(id); }

function upsert(input) {
  const cur = load();
  const prev = input && input.id ? get(String(input.id)) : null;
  const v = normRuntime(input, prev);
  if (!v.ok) return v;
  const at = cur.runtimes.findIndex(r => r.id === v.runtime.id);
  if (at >= 0) cur.runtimes[at] = v.runtime;
  else cur.runtimes.push(v.runtime);
  persist();
  return { ok: true, runtime: publicView(v.runtime) };
}

function remove(id) {
  const cur = load();
  const at = cur.runtimes.findIndex(r => r.id === String(id || ''));
  if (at < 0) return bad('no such runtime: ' + id);
  const [gone] = cur.runtimes.splice(at, 1);
  persist();
  return { ok: true, removed: publicView(gone) };
}

/** replace everything, for an import. Same validation, applied per record. */
function replaceAll(list) {
  const next = normalize({ runtimes: Array.isArray(list) ? list : [] });
  cache = next;
  persist();
  return { ok: true, runtimes: next.runtimes.map(publicView) };
}

module.exports = {
  setTypes, setDefaults, useFile, invalidate,
  load, persist, get, getRaw, upsert, remove, replaceAll,
  publicView, publicAll, normRuntime, normalize, keyHint, validEndpoint,
  MAX_NAME, MAX_ENDPOINT, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS,
  FILE, DIR,
};
