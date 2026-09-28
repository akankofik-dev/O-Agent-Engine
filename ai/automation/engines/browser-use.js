'use strict';
/* ========================================================================= *
 *  Browser Use — the autonomous engine, for a task rather than a step.
 *
 *  Where the other engines take one action, this one takes a goal: "research
 *  these five sites and compare them". That is a different shape of call, and
 *  the router treats it as such — it is only ever asked for work that has no
 *  single action behind it.
 *
 *  Two things it needs that the others do not:
 *    - a browser it can attach to, so it does not open its own;
 *    - a model, which means an API key. The key is read here, on the server,
 *      from the same store every other provider uses, and is handed straight to
 *      the library. It is never returned, never logged, never put in an event.
 * ========================================================================= */

const { requireContext } = require('../context');

const ID = 'browser-use';
const PKGS = ['@browser-use/sdk', 'browser-use'];

let mod = null;
let loaded = false;
let session = null;
let probeCache = { at: 0, value: null };
const PROBE_TTL_MS = 30000;

function loadSdk() {
  if (loaded) return mod;
  loaded = true;
  for (const p of PKGS) {
    try { mod = { name: p, lib: require(p) }; return mod; }
    catch (e) { if (e.code !== 'MODULE_NOT_FOUND') { mod = { name: p, error: String(e.message).slice(0, 120) }; return mod; } }
  }
  mod = { name: null, error: 'not installed' };
  return mod;
}

function unavailable(reason) {
  const e = new Error('Browser Use unavailable: ' + reason);
  e.code = 'unavailable';
  return e;
}

function versionOf() {
  const m = loadSdk();
  if (!m || !m.name) return '';
  try { return String(require(m.name + '/package.json').version || ''); } catch { return ''; }
}

/**
 * The SDK takes a model. The key comes from the agent's own provider so there
 * is no second set of credentials to configure, and it is passed straight
 * through — never stored on the engine, never returned in any payload.
 */
function modelFor(profile, resolveProvider) {
  if (!profile || !profile.providerId) throw unavailable('the agent has no provider to give it a model');
  const provider = resolveProvider(profile.providerId);
  if (!provider) throw unavailable('the agent\'s provider could not be resolved');
  if (!provider.apiKey) throw unavailable('the agent\'s provider has no API key');
  return {
    // deliberately narrow: just enough to make a request, nothing to persist
    provider: 'openai',
    baseURL: provider.baseUrl,
    apiKey: provider.apiKey,
    model: profile.model || provider.model || '',
  };
}

async function build(ctx, endpoints, profile, resolveProvider) {
  const m = loadSdk();
  if (!m || !m.lib) throw unavailable(m && m.error ? m.error : 'not installed');
  const lib = m.lib;
  const Browser = lib.Browser;
  if (typeof Browser !== 'function') throw unavailable(m.name + ' exports no Browser');

  const opts = {};
  if (endpoints && endpoints.cdpWs) opts.cdpUrl = endpoints.cdpWs;   // join, do not launch
  else throw unavailable('no browser session to attach to');

  const model = modelFor(profile, resolveProvider);
  let browser;
  try { browser = new Browser(opts); }
  catch (e) { throw unavailable('could not attach to the existing Chrome: ' + String(e.message).slice(0, 100)); }

  const Agent = lib.Agent;
  if (typeof Agent !== 'function') { try { await browser.close(); } catch { /* ignore */ } throw unavailable(m.name + ' exports no Agent'); }
  const LLM = lib.LLM;
  const llm = typeof LLM === 'function' ? new LLM({ ...model }) : { ...model };
  return { browser, agent: { Agent, llm, model: model.model } };
}

async function probe(endpoints, profile, resolveProvider) {
  const now = Date.now();
  if (probeCache.value && now - probeCache.at < PROBE_TTL_MS) return probeCache.value;
  const m = loadSdk();
  let out;
  if (!m || !m.lib) {
    out = { available: false, reason: m && m.error ? m.error : 'not installed' };
  } else if (m.error) {
    out = { available: false, reason: m.error };
  } else {
    out = {
      available: true,
      reason: m.name + ' v' + (versionOf() || '?') + ', attaches to the existing Chrome',
      version: versionOf(),
      capabilities: ['task', 'observe', 'act', 'read'],
    };
    // a provider is required for it to run at all, so say so now rather than
    // at the first action
    try { modelFor(profile, resolveProvider); }
    catch (e) { out.available = false; out.reason = String(e.message).replace(/^Browser Use unavailable: /, ''); }
    if (out.available && !endpoints) { out.available = false; out.reason = 'no browser session to attach to'; }
  }
  probeCache = { at: now, value: out };
  return out;
}

module.exports = {
  id: ID,
  name: 'Browser Use',
  type: 'sdk',
  builtIn: false,

  /* a whole task rather than a step; it has no navigate of its own because it
     navigates by doing the task */
  capabilities: ['task', 'observe', 'act', 'read'],

  async available(o) {
    const p = await probe(o && o.endpoints, o && o.profile, o && o.resolveProvider);
    return {
      available: p.available,
      reason: p.reason,
      version: p.version || '',
      capabilities: p.capabilities || [],
      sharesContext: true,
    };
  },

  /**
   * A whole task, not a step. The agent gets a goal in words and this engine
   * works through it, reporting progress as it goes.
   */
  async execute(action, ctx, driver, opts) {
    requireContext(ctx);
    const task = String(action.task || action.instruction || '').trim();
    if (!task) throw new Error('a browser task needs a goal in words');

    if (!session) {
      const built = await build(ctx, opts && opts.endpoints, opts && opts.profile, opts && opts.resolveProvider);
      session = built;
    }
    const agent = new session.agent.Agent({
      task,
      llm: session.agent.llm,
      browserSession: session.browser,
    });
    const history = await agent.run();
    return {
      via: ID,
      task,
      result: lastOutput(history),
      steps: countSteps(history),
    };
  },

  /** The task engine has no separate observe; its own loop is the observe. */
  async observe() {
    return { via: ID, note: 'browser-use observes as part of its own loop' };
  },

  async recover() {
    return { retried: false, reason: 'browser-use retries inside its own loop' };
  },

  async shutdown() {
    if (session && session.browser) { try { await session.browser.close(); } catch { /* ignore */ } }
    session = null;
    probeCache = { at: 0, value: null };
  },
};

function lastOutput(history) {
  if (!history) return null;
  const list = Array.isArray(history) ? history : (history.history || []);
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i].result;
    if (typeof r === 'string' && r.trim()) return r.trim().slice(0, 1200);
    if (r && typeof r === 'object') {
      const s = r.extracted_content || r.output || r.final_result;
      if (typeof s === 'string' && s.trim()) return s.trim().slice(0, 1200);
    }
  }
  return null;
}
function countSteps(history) {
  const list = Array.isArray(history) ? history : (history && history.history) || [];
  return list.length;
}
