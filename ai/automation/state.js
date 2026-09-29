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

/**
 * What an engine id may look like.
 *
 * The same rule forge.js applies to a directory name, kept here as a syntax
 * check and not as a second answer to "which engines exist" — that question
 * belongs to the registry, and server.js asks the registry. This only rejects
 * what could never be an id at all, so a corrupt file cannot grow a key that no
 * code path will ever look up.
 */
const ID_RE = /^[a-z][a-z0-9-]{1,40}$/;

/** Everything defaults to auto and on, because a missing preference is not a choice. */
function blank() {
  const engines = {};
  for (const id of KNOWN) engines[id] = { enabled: true };
  return { version: 1, engine: AUTO, engines };
}

/**
 * Read a stored preference without throwing away decisions.
 *
 * This used to keep only the four ids in KNOWN and discard every other entry,
 * and that is what made the dashboard's engine switch a lie: the panel drew a
 * switch for an engine the agent had built, and pressing it came back
 * "unknown engine", because the id was never in the list. The switch was the
 * one control the agent's own work was missing.
 *
 * So the rule is now "keep what is real, drop what is not". Every entry whose id
 * could be an engine id survives the round trip — including an engine whose
 * folder has been renamed or removed, whose switch someone turned off on
 * purpose. Losing that is losing a decision, and describe() reports the leftovers
 * as orphans instead so they are visible rather than merely gone.
 *
 * The four shipped ids are still re-seeded afterwards, so an entry deleted by
 * hand comes back as the default rather than as a hole.
 */
function normalise(raw) {
  const out = blank();
  if (!raw || typeof raw !== 'object') return out;
  /* "auto", or any id that could be an engine. Checking shape rather than
     membership in KNOWN is the same change as below, and for the same reason:
     pinning the product to an engine the agent built was refused here, and a
     pin that was somehow stored was silently reset to auto on the next load. */
  if (raw.engine === AUTO || ID_RE.test(String(raw.engine == null ? '' : raw.engine))) {
    out.engine = raw.engine === AUTO ? AUTO : String(raw.engine);
  }
  const given = raw.engines && typeof raw.engines === 'object' ? raw.engines : {};
  for (const id of Object.keys(given)) {
    if (!ID_RE.test(id)) continue;
    const e = given[id];
    if (!e || typeof e !== 'object' || typeof e.enabled !== 'boolean') continue;
    out.engines[id] = { enabled: e.enabled };
  }
  for (const id of KNOWN) if (!out.engines[id]) out.engines[id] = { enabled: true };
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

/**
 * Flip one engine on or off.
 *
 * The id is checked for shape here and for existence at the router, which is
 * the only place that knows what is registered. This function used to answer
 * both questions from a list of four, so an engine the agent built could never
 * be switched off — and the dashboard had already been changed to draw a switch
 * for every engine, which meant the panel promised a control the server refused.
 *
 * The `on` check comes first and is not decorative: the caller used to write
 * `body.enabled === true`, which is a boolean no matter what arrived, so a
 * malformed payload read as "turn it off" rather than as a mistake.
 */
function setEnabled(id, on) {
  const key = String(id == null ? '' : id);
  if (!ID_RE.test(key)) return { ok: false, error: 'not an engine id: ' + JSON.stringify(id) };
  if (typeof on !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
  const cfg = load();
  if (!cfg.engines[key]) cfg.engines[key] = { enabled: true };
  cfg.engines[key].enabled = on;
  persist();
  return { ok: true, id: key, enabled: on };
}

/**
 * The user's choice: "auto", or an engine id the router must honour.
 *
 * Same split as setEnabled — shape here, existence at the router. This used to
 * refuse any id outside the four, which meant the one engine a person might most
 * reasonably want to pin by hand, the one the agent wrote for them, was the only
 * one they could not pin.
 */
function setEngine(id) {
  const want = String(id || AUTO);
  if (want !== AUTO && !ID_RE.test(want)) return { ok: false, error: 'not an engine id: ' + JSON.stringify(id) };
  const cfg = load();
  cfg.engine = want;
  persist();
  return { ok: true, engine: want };
}

/** for tests: forget what was cached so the file is read afresh */
function reset() { cache = null; }

module.exports = { load, persist, setEnabled, setEngine, normalise, blank, reset, KNOWN, AUTO, FILE, ID_RE };
