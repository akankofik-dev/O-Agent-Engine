'use strict';
/* ========================================================================= *
 *  Which browser automation engine the router should use.
 *
 *  One field, because that is the whole decision: "auto" lets the router choose,
 *  and any other value is an engine the user picked by hand and the router must
 *  not work around.
 *
 *  This is the only state the automation layer keeps, and it is deliberately
 *  dull: a preference and a set of toggles. No keys, no cookies, no tokens — an
 *  engine that wanted any of those has no field to put them in.
 *
 *  Written the way ai/store.js writes, so a half-written file can never be read
 *  back as a real preference.
 * ========================================================================= */

const fs = require('fs');
const path = require('path');

/* the project's own data/ — the same place ai/store.js keeps its state */
const DIR = path.join(__dirname, '..', '..', 'data');
const FILE = path.join(DIR, 'automation.json');

const KNOWN = ['native-cdp', 'playwright-mcp', 'stagehand', 'browser-use'];
const AUTO = 'auto';

/** Everything defaults to auto and on, because a missing preference is not a choice. */
function blank() {
  const engines = {};
  for (const id of KNOWN) engines[id] = { enabled: true };
  return { version: 1, engine: AUTO, engines };
}

function normalise(raw) {
  const out = blank();
  if (!raw || typeof raw !== 'object') return out;
  // only "auto" or a known engine id; anything else is a typo, not a preference
  if (raw.engine === AUTO || KNOWN.includes(raw.engine)) out.engine = raw.engine;
  const given = raw.engines && typeof raw.engines === 'object' ? raw.engines : {};
  for (const id of KNOWN) {
    const e = given[id];
    if (e && typeof e === 'object' && typeof e.enabled === 'boolean') out.engines[id].enabled = e.enabled;
  }
  return out;
}

let cache = null;

function load() {
  if (cache) return cache;
  try { cache = normalise(JSON.parse(fs.readFileSync(FILE, 'utf8'))); }
  catch { cache = normalise(null); }
  return cache;
}

function persist() {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort on Windows */ }
  fs.renameSync(tmp, FILE);
}

/** flip one engine on or off */
function setEnabled(id, on) {
  const cfg = load();
  if (!KNOWN.includes(id)) return { ok: false, error: 'unknown engine: ' + id };
  if (typeof on !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
  cfg.engines[id].enabled = on;
  persist();
  return { ok: true, id, enabled: on };
}

/** the user's choice: "auto", or an engine id the router must honour */
function setEngine(id) {
  const cfg = load();
  const want = String(id || AUTO);
  if (want !== AUTO && !KNOWN.includes(want)) return { ok: false, error: 'unknown engine: ' + want };
  cfg.engine = want;
  persist();
  return { ok: true, engine: want };
}

/** for tests: forget what was cached so the file is read afresh */
function reset() { cache = null; }

module.exports = { load, persist, setEnabled, setEngine, normalise, blank, reset, KNOWN, AUTO, FILE };
