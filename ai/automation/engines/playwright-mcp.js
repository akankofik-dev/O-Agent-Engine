'use strict';
/* ========================================================================= *
 *  Playwright MCP — an optional engine that is an MCP server, not a library.
 *
 *  The interface used here is the real one: `tools/list` to see what the
 *  installed server actually offers, and `tools/call` to invoke it. Nothing is
 *  assumed about which tools exist — the adapter reads the list and maps its
 *  capabilities onto whatever that server version provides.
 *
 *  On the shared browser: Playwright MCP takes `--cdp-endpoint`, and the
 *  endpoint it is given is the connection this product already has. That keeps
 *  it on the same Chrome and the same tabs. The endpoint is passed to a local
 *  child process and never leaves the server — it is in no response, no event
 *  and no log. If the option is not supported by the installed version the
 *  engine reports itself unavailable rather than quietly driving a new browser.
 * ========================================================================= */

const { createClient } = require('../mcp');
const { requireContext } = require('../context');

/* the same check every engine makes, not a second opinion on it */
const needContext = requireContext;

const ID = 'playwright-mcp';
const BIN = process.env.OCTOP_PLAYWRIGHT_MCP || '@playwright/mcp';

/* our capability -> the tool names Playwright MCP is documented to expose. The
   probe only reports a capability available if the running server really lists a
   matching tool, so a version that renamed one is unavailable, not a guess. */
const TOOL_MAP = {
  navigate:  [/^browser_navigate$/i, /^browser_navigate$/i],
  click:     [/^browser_click$/i],
  type:      [/^browser_type$/i, /^browser_fill_form$/i],
  press:     [/^browser_press_key$/i],
  select:    [/^browser_select_option$/i],
  scroll:    [/^browser_evaluate$/i],
  screenshot:[/^browser_take_screenshot$/i],
  tabs:      [/^browser_(tabs|tab_.*)$/i],
  read:      [/^browser_(snapshot|console_messages)$/i],
  evaluate:  [/^browser_evaluate$/i],
  act:       [/^browser_click$/i, /^browser_type$/i],
  observe:   [/^browser_snapshot$/i],
  extract:   [/^browser_evaluate$/i],
};

/** one client per process, reused: starting a server per action would be absurd */
let client = null;
let probeCache = { at: 0, value: null };
let inFlight = null;          // one probe at a time; the rest wait for it
const PROBE_TTL_MS = 30000;

function argsFor(endpoints) {
  const args = ['--headless=false'];
  // attach to the browser this product already drives, rather than launching one
  if (endpoints && endpoints.cdpWs) args.push('--cdp-endpoint', endpoints.cdpWs);
  return args;
}

async function probe(endpoints) {
  const now = Date.now();
  if (probeCache.value && now - probeCache.at < PROBE_TTL_MS) return probeCache.value;
  if (inFlight) return inFlight;
  inFlight = runProbe(endpoints).finally(() => { inFlight = null; });
  return inFlight;
}

async function runProbe(endpoints) {
  const now = Date.now();
  let out;
  try {
    if (client && !client.isClosed()) await client.stop();
    client = createClient({ command: 'npx', args: ['--yes', BIN].concat(argsFor(endpoints)) });
    await client.start();
    const tools = await client.tools();
    const names = tools.map(t => String(t.name || ''));
    const capabilities = Object.keys(TOOL_MAP).filter(cap =>
      TOOL_MAP[cap].some(re => names.some(n => re.test(n))));
    out = names.length
      ? { available: true, reason: names.length + ' tools', tools: names, capabilities }
      : { available: false, reason: 'the server started but offered no browser tools' };
  } catch (e) {
    out = { available: false, reason: String((e && e.message) || e).slice(0, 160) };
    if (client) { try { await client.stop(); } catch { /* ignore */ } client = null; }
  }
  probeCache = { at: now, value: out };
  return out;
}

/** refuse to act on a context we could not attach to */


module.exports = {
  id: ID,
  name: 'Playwright MCP',
  type: 'mcp',
  builtIn: false,

  /* what this engine could do. The probe narrows this to what the server that
     is actually installed really offers, so a renamed tool shows up as missing
     rather than as a guess. */
  capabilities: ['navigate', 'click', 'type', 'press', 'select', 'screenshot',
                 'tabs', 'read', 'evaluate', 'observe', 'extract', 'act'],

  async available(endpoints) {
    const p = await probe(endpoints);
    return {
      available: p.available,
      reason: p.available ? p.reason : p.reason,
      tools: p.tools || [],
      capabilities: p.capabilities || [],
      /* the one thing that would silently fork the browser */
      sharesContext: true,
    };
  },

  capabilitiesOf(p) { return (p && p.capabilities) || []; },

  async execute(action, ctx, driver, opts) {
    needContext(ctx);
    const p = await probe(opts && opts.endpoints);
    if (!p.available) throw unavailable(p.reason);
    const name = toolFor(p.tools, TOOL_MAP[action.action] || []);
    if (!name) throw unavailable('this server has no ' + action.action + ' tool');
    const args = callArgs(action.action, action);
    const r = await client.callTool(name, args);
    return { via: ID, tool: name, result: r.text };
  },

  async observe(o, ctx, driver, opts) {
    return this.execute({ action: 'read' }, ctx, driver, opts);
  },

  async recover() {
    return { retried: false, reason: 'the mcp server owns its own retry policy' };
  },

  /** kept out of the request path; the probe is what Settings calls */
  async shutdown() {
    if (inFlight) { try { await inFlight; } catch { /* ignore */ } }
    if (client) { try { await client.stop(); } catch { /* ignore */ } client = null; }
    probeCache = { at: 0, value: null };
  },
};

function unavailable(reason) {
  const e = new Error('Playwright MCP unavailable: ' + reason);
  e.code = 'unavailable';
  return e;
}
function toolFor(tools, patterns) {
  for (const re of patterns) {
    const hit = tools.find(n => re.test(n));
    if (hit) return hit;
  }
  return null;
}
/* the documented argument names, per tool */
function callArgs(action, a) {
  switch (action) {
    case 'navigate': return { url: a.url };
    case 'click': return (a.selector ? { element: a.selector, ref: a.ref } : { element: 'the element', ref: a.ref });
    case 'type': return { element: a.selector, ref: a.ref, text: a.text };
    case 'press': return { key: a.key };
    case 'select': return { element: a.selector, ref: a.ref, values: a.values || [a.value] };
    case 'screenshot': return { type: 'png' };
    case 'read': return {};
    case 'evaluate': return { function: a.code, args: [] };
    default: return {};
  }
}
