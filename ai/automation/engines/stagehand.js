'use strict';
/* ========================================================================= *
 *  Stagehand — semantic actions: "click the checkout button".
 *
 *  The value of this engine is that it does not need a selector. Its interface
 *  has moved between major versions, so nothing here assumes a shape: the
 *  adapter reads the installed version, and every call tolerates both the v2
 *  return (a bare array) and the v3 return ({ data }). An unfamiliar shape is
 *  reported, not coerced.
 *
 *  On the shared browser: Stagehand drives a browser it is given. The only
 *  honest way to keep it on the same Chrome is to hand it the connection this
 *  product already has; when the installed version does not accept that, the
 *  engine reports itself unavailable for this context instead of quietly
 *  starting a second browser.
 * ========================================================================= */

const { requireContext } = require('../context');

const ID = 'stagehand';
const PKG = '@browserbasehq/stagehand';

let cached = null;

function loadStagehand() {
  if (cached !== null) return cached;
  try { cached = require(PKG); }
  catch (e) { cached = { __error: e.code === 'MODULE_NOT_FOUND' ? 'not installed' : String(e.message).slice(0, 120) }; }
  return cached;
}

function versionOf(mod) {
  try {
    const pj = require(PKG + '/package.json');
    return String(pj.version || '');
  } catch { return ''; }
}

function unavailable(reason) {
  const e = new Error('Stagehand unavailable: ' + reason);
  e.code = 'unavailable';
  return e;
}

/** v2 returned the array itself; v3 wraps it. Accept both, reject anything else. */
function rows(out) {
  if (Array.isArray(out)) return out;
  if (out && Array.isArray(out.data)) return out.data;
  if (Array.isArray(out && out.actions)) return out.actions;
  throw unavailable('observe() returned a shape this adapter does not recognise');
}

let stage = null;      // one Stagehand, reused
let probeCache = { at: 0, value: null };
const PROBE_TTL_MS = 30000;

async function build(endpoints) {
  const mod = loadStagehand();
  if (!mod || mod.__error) throw unavailable(mod && mod.__error ? mod.__error : 'cannot load ' + PKG);
  const Stagehand = mod.Stagehand || mod.default;
  if (typeof Stagehand !== 'function') throw unavailable(PKG + ' exports no Stagehand constructor');

  if (!endpoints || !endpoints.cdpWs) throw unavailable('no browser session to attach to');

  // The endpoint belongs in the options that are actually used. It used to be
  // added only to the throwaway object the support probe constructed with, so
  // the probe proved the constructor tolerates a CDP endpoint and then the real
  // instance was built without one — which is how a second browser gets started
  // silently, the one thing the comment above this call was written to prevent.
  const opts = {
    env: 'LOCAL', browserType: 'chrome', verbose: 0, domSettleTimeoutMs: 3000,
    cdpEndpoint: endpoints.cdpWs,
    browserCDPEndpoint: endpoints.cdpWs,
  };

  if (!supportsCdp(Stagehand, opts)) {
    throw unavailable('the installed version will not attach to the existing Chrome');
  }

  const s = new Stagehand(opts);
  try {
    await s.init();
  } catch (e) {
    // Never leave a half-started engine holding a browser we did not ask for.
    try { await s.close(); } catch { /* it never opened */ }
    throw unavailable('could not attach to the existing Chrome: ' + String((e && e.message) || e).slice(0, 160));
  }
  return s;
}

/**
 * A constructor that takes a browser endpoint is the only proof available
 * without starting a browser to find out, so that is all this checks. It does
 * not call init(): doing that is the very side effect being avoided.
 */
function supportsCdp(Stagehand, opts) {
  try {
    const s = new Stagehand(opts);
    if (!s || typeof s.init !== 'function') return false;
    // close() on a never-initialised instance can reject, and nothing awaits
    // this function's return value, so an unhandled rejection here would be
    // the only visible symptom of an otherwise successful check.
    try {
      const closing = typeof s.close === 'function' ? s.close() : null;
      if (closing && typeof closing.catch === 'function') closing.catch(() => {});
    } catch { /* nothing to close */ }
    return true;
  } catch {
    return false;
  }
}

async function probe(endpoints) {
  const now = Date.now();
  if (probeCache.value && now - probeCache.at < PROBE_TTL_MS) return probeCache.value;
  let out;
  try {
    if (stage) { try { await stage.close(); } catch { /* ignore */ } stage = null; }
    stage = await build(endpoints);
    out = {
      available: true,
      reason: 'v' + (versionOf() || '?') + ', attached to the existing Chrome',
      version: versionOf(),
      capabilities: ['observe', 'act', 'extract', 'read', 'screenshot'],
    };
  } catch (e) {
    out = { available: false, reason: String((e && e.message) || e).replace(/^Stagehand unavailable: /, '').slice(0, 160) };
    stage = null;
  }
  probeCache = { at: now, value: out };
  return out;
}

/* the same check every engine makes, not a second opinion on it */
const needContext = requireContext;

module.exports = {
  id: ID,
  /* the one package this adapter require()s, named by the constant it already
     requires it through */
  installs: [{ pkg: PKG, via: 'npm' }],
  name: 'Stagehand',
  type: 'sdk',
  builtIn: false,

  /* the reason this engine exists: a goal in words instead of a selector */
  capabilities: ['observe', 'act', 'extract', 'read', 'screenshot'],

  async available(endpoints) {
    const p = await probe(endpoints);
    return {
      available: p.available,
      reason: p.reason,
      version: p.version || '',
      capabilities: p.capabilities || [],
      sharesContext: true,
    };
  },

  /**
   * Semantic act. The instruction is the point — the caller says what it wants
   * in words, and Stagehand finds the element.
   */
  async execute(action, ctx, driver, opts) {
    needContext(ctx);
    const p = await probe(opts && opts.endpoints);
    if (!p.available) throw unavailable(p.reason);
    const instruction = String(action.instruction || action.text || '').trim();
    if (!instruction) throw new Error('a semantic action needs an instruction, e.g. "click the checkout button"');
    const r = await stage.act(instruction);
    return { via: ID, instruction, result: summarise(r) };
  },

  /**
   * Observe: the candidate actions on the page, each with a description a model
   * can choose from instead of a selector it would have to guess.
   */
  async observe(o, ctx, driver, opts) {
    needContext(ctx);
    const p = await probe(opts && opts.endpoints);
    if (!p.available) throw unavailable(p.reason);
    const found = rows(await stage.observe(String((o && o.goal) || '')));
    return {
      via: ID,
      actions: found.map(x => ({
        id: x.id,
        description: x.description || x.name || '',
        method: x.method || '',
      })).slice(0, 60),
    };
  },

  /** Extract structured data by instruction. */
  async extract(instruction, ctx, driver, opts) {
    needContext(ctx);
    const p = await probe(opts && opts.endpoints);
    if (!p.available) throw unavailable(p.reason);
    const r = await stage.extract(String(instruction || '').slice(0, 400));
    return { via: ID, result: r && typeof r === 'object' && 'result' in r ? r.result : r };
  },

  /**
   * Stagehand self-heals the part that is hard — it re-observes when a selector
   * goes stale, inside its own act(). What it cannot do from here is notice
   * that the instance itself has gone: `stage` is a module-level singleton
   * holding a browser connection, and if that connection has dropped, every
   * later act() fails identically and the cached probe keeps reporting the
   * engine as available.
   *
   * So the same reset as the MCP engine: drop the instance and the probe cache,
   * so the next action builds a new one against the browser we already have.
   * That is a state reset, not a retry of the call that just failed, so it does
   * not claim to have retried.
   */
  async recover() {
    if (stage) {
      try { await stage.close(); } catch { /* already gone */ }
      stage = null;
      probeCache = { at: 0, value: null };
      return { retried: false, reason: 'the stagehand instance was dropped so the next action rebuilds it' };
    }
    probeCache = { at: 0, value: null };
    return { retried: false, reason: 'no stagehand instance was held (the probe cache was still dropped)' };
  },

  async shutdown() {
    if (stage) { try { await stage.close(); } catch { /* ignore */ } stage = null; }
    probeCache = { at: 0, value: null };
  },
};

function summarise(r) {
  if (r === null || r === undefined) return null;
  if (typeof r === 'string') return r.slice(0, 400);
  if (typeof r === 'object') {
    const out = {};
    for (const k of Object.keys(r).slice(0, 8)) {
      const v = r[k];
      out[k] = typeof v === 'string' ? v.slice(0, 200) : (typeof v === 'number' || typeof v === 'boolean' ? v : undefined);
    }
    return out;
  }
  return String(r).slice(0, 200);
}
