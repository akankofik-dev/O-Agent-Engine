#!/usr/bin/env node
'use strict';

/* =========================================================================
 * Octop Browser Automation — zero-dependency Node server
 * -------------------------------------------------------------------------
 *   Node built-ins only (http, net, crypto, child_process) plus a
 *   hand-rolled WebSocket server — no ws dependency, no npm install.
 *
 *   What it does
 *     1. auto-launches a real Chrome with --remote-debugging-port (CDP)
 *     2. serves the dashboard on http://127.0.0.1:8787
 *     3. streams Page.screencast frames over WS /api/browser/stream
 *     4. executes browser actions over  POST /api/browser/action
 *     5. proxies AI chat to ANY OpenAI-compatible endpoint over
 *        POST /api/ai/chat  (avoids browser CORS, keeps the key server-side)
 *     6. runs a real interactive shell over WS /api/shell
 *
 *   This is deliberately independent of hermes — nothing here talks to it.
 * ========================================================================= */

const http = require('http');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

/* AI layer — provider abstraction, agent engine and tool runner. The browser
   controller below is injected into the engine, never the other way round. */
const aiStore = require('./ai/store');
const aiProviders = require('./ai/providers');
const aiEngine = require('./ai/engine');
const aiSkills = require('./ai/skills');
const agentFiles = require('./ai/agentfiles');
const aiCompat = require('./ai/compat');
const aiAttachments = require('./ai/attachments');
const aiAutomation = require('./ai/automation');
const browserSession = require('./ai/browser/session');
const agentRuns = require('./ai/runs').createRunRegistry();

/* ----------------------------- config --------------------------------- */

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
/* An explicit CDP_PORT is a promise that this process should attach to whatever
   is already on it. Without one, the port is ours to take: two instances sharing
   9222 used to mean the second silently joined the first one's browser, so both
   servers drove the same tabs and the same profile lock. */
const CDP_PORT_PINNED = true;
let CDP_PORT = Number(process.env.CDP_PORT || 9222);
const ROOT = __dirname;
const DASHBOARD = path.join(ROOT, 'dashboard.html');

const QUALITY = clamp(Number(process.env.QUALITY || 78), 20, 100);
const MAX_FRAME_W = Number(process.env.MAX_W || 1600);
const MAX_FRAME_H = Number(process.env.MAX_H || 1000);
const IS_WINDOWS = process.platform === 'win32';
const SHELL_FILE = IS_WINDOWS ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/bash');
const SHELL_NAME = path.basename(SHELL_FILE);
const HEADLESS = process.env.HEADLESS ? process.env.HEADLESS === '1' : process.platform !== 'win32'
  || (!IS_WINDOWS && process.platform !== 'darwin' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);

const PROFILE = process.env.CHROME_PROFILE || path.join(os.homedir(), '.octop-browser-profile');

const STATE = {
  port: PORT,
  chromePid: null,
  launchedByUs: false,
  connected: false,
  version: null,
  screencasting: false,
  /** targetIds with a running Page.startScreencast */
  casting: new Set(),
  /** targetIds Chrome last reported as not visible, straight from
      Page.screencastVisibilityChanged — a real signal, never inferred */
  hidden: new Set(),
  /** how many browser actions are in flight, so the user's own clicks cannot
      pull the agent off the tab it is driving mid-action */
  acting: 0,
  lastFrame: null,
  lastFrameAt: 0,
};

/**
 * Browser identity. The agent speaks tabId; the CDP targetId never leaves this
 * process. agentTabId is the agent's; focusedTabId is the human's and moves
 * nothing.
 */
const BROWSER = browserSession.createSession({
  sessionId: 'browser-1',
  onEvent: ev => {
    if (ev.event === 'tab.created' || ev.event === 'tab.closed' || ev.event === 'tab.focused') {
      broadcastTabs();
    } else if (ev.event === 'tab.activated' || ev.event === 'tab.unassigned') {
      broadcastContext();
      broadcastStatus();
    } else if (ev.event === 'tab.navigated') {
      broadcast({ type: 'navigated', tabId: ev.tabId, url: ev.url, title: ev.title, generation: ev.generation });
    }
  },
});

/** targetId -> TargetInfo */
const targets = new Map();
/** targetId -> CDP sessionId */
const sessions = new Map();
/** sessionId -> targetId */
const sessionOwner = new Map();

let cdpSocket = null;
let cdpId = 0;
/**
 * The CDP endpoint, for an engine that can attach to a browser this product is
 * already driving. Module-level on purpose: it is not on STATE, so it cannot be
 * swept into a status response, and it is not logged.
 */
let cdpEndpoint = null;
const cdpPending = new Map();
/** how many consecutive reconnects have failed, so the wait can grow */
let cdpBackoff = 0;
let cdpRetryTimer = null;

const clients = new Set();

/* ----------------------------- helpers -------------------------------- */

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ------------------------- one browser action at a time ------------------ *
 * A tail of the promise chain. Anything that dispatches input to the page goes
 * through here, and it goes one at a time.
 *
 * STATE.acting existed for exactly this and nothing ever read it: it counted
 * the actions in flight and the counter was write-only, so the promise in its
 * own comment — that the person's own clicks cannot pull the agent off the tab
 * it is driving mid-action — was never kept.
 *
 * The problem is real and it is not only about the person. A navigate waits up
 * to twelve seconds for the page to load, and a click dispatched into that
 * window lands on whatever is on screen when it arrives — a page still
 * swapping in, not the page the agent decided to click. Two agents would be
 * the same problem, and the run lock keeps only one going, but the person is
 * not an agent and the run lock does not stop them; the preview is theirs to
 * reach into while the agent works.
 *
 * So the actions are serialised rather than refused. Refusing would be the
 * wrong answer for the person: the preview is a live browser they are meant to
 * be able to use, and "the agent is busy" on every click would turn it into a
 * picture of a browser. Waiting is not a refusal — the click still happens, a
 * moment later, when the page it was aimed at is the page on screen.
 *
 * The tail is reset to a resolved promise after every action, so one that
 * rejects does not wedge everything queued behind it.
 * ------------------------------------------------------------------------ */
let actionTail = Promise.resolve();
let actionQueued = 0;

function withActionLock(fn) {
  // run whether the previous action settled or threw, and keep this action's
  // outcome out of the tail so one failure cannot stop the queue behind it
  const mine = actionTail.then(() => fn(), () => fn());
  actionTail = mine.then(() => undefined, () => undefined);
  actionQueued += 1;
  STATE.acting = actionQueued;
  return mine.finally(() => {
    actionQueued -= 1;
    STATE.acting = actionQueued;
  });
}

function log(...args) { console.log(new Date().toISOString().slice(11, 19), ...args); }
function logErr(...args) { console.error(new Date().toISOString().slice(11, 19), ...args); }

/**
 * Which browser the agent drives.
 *
 * The bundled build in .browser/ comes first, always. That is the whole point
 * of it: a system Chrome cannot be version-pinned, updates itself underneath
 * the CDP surface we depend on, and a second instance attaching to it fights
 * the first over the profile lock. The system browsers are still listed, but
 * only as a fallback for a checkout that has not run the installer yet — and
 * whichever one is chosen is reported, so "which browser is the agent on" is
 * never a question you have to guess at.
 *
 * Returns { path, source, version } or null.
 */
function resolveBrowser() {
  // 1. an explicit override always wins, so a pinned build can be tested
  if (process.env.CHROME_PATH) {
    if (fs.existsSync(process.env.CHROME_PATH)) {
      return { path: process.env.CHROME_PATH, source: 'CHROME_PATH', version: null };
    }
    logErr('CHROME_PATH points at nothing:', process.env.CHROME_PATH);
  }

  // 2. the browser that belongs to this project
  let bundled = null;
  try { bundled = require('./scripts/get-browser').bundledBinary(); } catch (e) {
    logErr('could not read the bundled browser:', e.message);
  }
  if (bundled) return bundled;

  // 3. fall back to browsers installed by the operating system
  const cands = IS_WINDOWS
    ? [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  for (const c of cands) {
    try { if (fs.existsSync(c)) return { path: c, source: 'system', version: null }; } catch { /* ignore */ }
  }
  return null;
}

/** one lookup per process, and the answer is reported in the boot banner */
const BROWSER_BIN = resolveBrowser();

/* ====================================================================== *
 *  Chrome lifecycle                                                       *
 * ====================================================================== */

async function cdpHttp(p) {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}${p}`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`CDP ${p} -> HTTP ${r.status}`);
  return r.json();
}

async function cdpReachable() {
  try { await cdpHttp('/json/version'); return true; } catch { return false; }
}

function launchChrome() {
  const bin = BROWSER_BIN && BROWSER_BIN.path;
  if (!bin) {
    // The message has to name the one command that fixes it, because this is
    // the first thing a fresh checkout hits.
    throw new Error(
      'No browser for this project.\n'
      + '  Get the bundled one:  node scripts/get-browser.js\n'
      + '  Or point at your own: CHROME_PATH=/path/to/browser'
    );
  }

  const args = [
    '--no-sandbox',
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-client-side-phishing-detection',
    '--disable-default-apps',
    '--disable-translate',
    '--metrics-recording-only',
    '--no-service-autorun',
    '--password-store=basic',
    // --- keep the automation page "visible" even when our window is covered ---
    // without these Chrome marks the page document.hidden = true and CDP input
    // events stop reaching the renderer entirely.
    '--disable-features=Translate,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-ipc-flooding-protection',
    '--window-size=1280,860',
    '--window-position=40,40',
    ...(HEADLESS ? ['--headless=new'] : []),
    'about:blank',
  ];

  log('launching the browser:', bin, '(' + (BROWSER_BIN.source || 'unknown') + ')');
  const child = spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', e => logErr('chrome spawn error:', e.message));
  child.unref();
  STATE.chromePid = child.pid;
  STATE.launchedByUs = true;
  return child;
}

async function ensureChrome() {
  if (CDP_PORT_PINNED) {
    // the operator asked for this port, so honour whatever is on it
    if (await cdpReachable()) {
      log(`browser already listening on :${CDP_PORT} — attaching to it (CDP_PORT was set)`);
      return;
    }
  } else {
    // not pinned: the port belongs to this instance. If something is already
    // listening, it is a *different* browser, and joining it would put two
    // servers on one profile lock and one set of tabs.
    if (await cdpReachable()) {
      const was = CDP_PORT;
      CDP_PORT = await pickPort(CDP_PORT);
      log(`:${was} is taken by another browser — this instance will use :${CDP_PORT}`);
      if (await cdpReachable()) {
        throw new Error(`could not find a free CDP port above ${was}`);
      }
    }
  }
  launchChrome();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await cdpReachable()) return;
    await sleep(250);
  }
  throw new Error(`the browser did not come up on port ${CDP_PORT}`);
}

function killChrome() {
  if (!STATE.launchedByUs || !STATE.chromePid) return;
  const pid = STATE.chromePid;
  STATE.launchedByUs = false;
  // Only ever the process this server started. A system browser belongs to the
  // person using the machine, and killing that would close their own windows.
  try {
    if (IS_WINDOWS) {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        .on('error', () => {});
    } else {
      // the negative pid is the process group, which is what takes the zygote
      // and the renderers with it; a plain kill leaves the whole tree running
      try { process.kill(-pid, 'SIGTERM'); }
      catch { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
    }
    log('stopped the browser (pid ' + pid + ')');
  } catch (e) { logErr('could not stop the browser:', e.message); }
}

/* ====================================================================== *
 *  CDP client (browser-level session)                                     *
 * ====================================================================== */

function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    if (!cdpSocket || cdpSocket.readyState !== WebSocket.OPEN) {
      return reject(new Error('CDP not connected'));
    }
    const id = ++cdpId;
    cdpPending.set(id, { resolve, reject, method });
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    try { cdpSocket.send(JSON.stringify(msg)); }
    catch (e) { cdpPending.delete(id); reject(e); }
  });
}

function sendNoWait(method, params = {}, sessionId) {
  if (!cdpSocket || cdpSocket.readyState !== WebSocket.OPEN) return;
  const id = ++cdpId;
  const msg = { id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  try { cdpSocket.send(JSON.stringify(msg)); } catch { /* ignore */ }
}

async function evalValue(sessionId, expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false }, sessionId);
  if (r && r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description
      ? r.exceptionDetails.exception.description
      : (r.exceptionDetails.text || 'evaluate failed'));
  }
  return r && r.result ? r.result.value : undefined;
}

async function connectCDP() {
  let ver = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { ver = await cdpHttp('/json/version'); break; } catch { await sleep(300); }
  }
  if (!ver) throw new Error('could not read http://127.0.0.1:' + CDP_PORT + '/json/version');

  STATE.version = ver.Browser || null;
  const wsUrl = ver.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error('/json/version did not include webSocketDebuggerUrl');

  // the endpoint itself is never printed: it is the browser's private address
  log('connecting CDP: ' + STATE.version);
  cdpEndpoint = wsUrl;
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('CDP websocket timeout')), 15000);
    ws.onopen = () => { clearTimeout(to); resolve(); };
    ws.onerror = () => { clearTimeout(to); reject(new Error('CDP websocket error')); };
  });

  cdpSocket = ws;
  STATE.connected = true;
  cdpBackoff = 0;

  ws.onmessage = ev => {
    let m;
    try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); }
    catch { return; }
    onCdpMessage(m);
  };
  ws.onclose = () => {
    STATE.connected = false;
    cdpSocket = null;
    for (const [, p] of cdpPending) p.reject(new Error('CDP connection closed'));
    cdpPending.clear();
    // The targets belonged to the connection that just went away. Keeping them
    // would leave the agent and the preview bound to a tab that may not exist,
    // so say disconnected and let the reconnect rebuild a real session.
    BROWSER.drop();
    STATE.lastFrame = null;
    STATE.casting.clear();
    // nothing is casting once the socket is gone, and the status object used to
    // keep saying "screencasting: true" beside zero tabs
    STATE.screencasting = false;
    STATE.hidden.clear();
    sessions.clear();
    sessionOwner.clear();
    broadcastContext();
    broadcastStatus();
    broadcast({ type: 'error', message: 'CDP connection closed' });
    log('CDP closed — will keep trying');
    scheduleReconnect();
  };
  ws.onerror = () => { /* handled by onclose */ };

  await send('Target.setDiscoverTargets', { discover: true });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await sleep(200);

  const list = await send('Target.getTargets');
  for (const t of (list.targetInfos || [])) {
    targets.set(t.targetId, t);
    if (t.type === 'page' && !sessions.has(t.targetId)) {
      try {
        const a = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        registerSession(a.sessionId, t);
      } catch (e) { logErr('attach failed:', e.message); }
    }
  }
  // The agent needs a tab to start with. This is the ONLY time a page is picked
  // by asking which one is visible, and it happens once, when there is nothing
  // yet. After that the agent owns its tab and nothing re-picks it for it.
  if (!BROWSER.agentTabId || !sessions.has(BROWSER.agentTarget())) {
    const firstVisible = await visiblePageTarget();
    if (firstVisible) setAgentTarget(firstVisible, false, 'first page');
  }
  broadcastContext();
  broadcastTabs();
  broadcastStatus();
  log('CDP ready —', targets.size, 'targets,', sessions.size, 'sessions');
}

/**
 * Keep trying until the browser is back.
 *
 * Two things this has to do that a single retry did not. It has to try again
 * after a failure — the first version scheduled one attempt, so one unlucky
 * moment left the workbench permanently disconnected while the page still
 * promised it "will come back on its own". And it has to bring the browser back
 * with it: reconnecting to a browser that is no longer there fails forever, and
 * the most ordinary way to lose the connection is a person closing the window.
 */
function scheduleReconnect() {
  if (cdpRetryTimer) return;
  const wait = Math.min(15000, 1000 * Math.pow(2, Math.min(cdpBackoff, 4)));
  cdpRetryTimer = setTimeout(() => {
    cdpRetryTimer = null;
    if (STATE.connected) return;
    (async () => {
      try {
        // the browser may be the thing that went away, not just the socket
        await ensureChrome();
        await connectCDP();
      } catch (e) {
        cdpBackoff += 1;
        logErr('CDP reconnect failed:', e.message, '— retrying');
        scheduleReconnect();
      }
    })();
  }, wait);
}

function registerSession(sessionId, targetInfo) {
  const tid = targetInfo.targetId;
  targets.set(tid, targetInfo);
  sessions.set(tid, sessionId);
  sessionOwner.set(sessionId, tid);
  // a page gets a tabId of its own; anything else is not a tab
  if (targetInfo.type === 'page') {
    /* A re-attach is not new information about the page. activate() resizes the
       window, Chrome re-attaches the target, and registerSession comes back
       here for a tab that is already known — and the title on a target event
       is the name Chrome guesses from the address, not the page's own, so
       passing it again renamed the tab after its url just for being brought
       to the front. A tab that already has a name keeps it; only a tab
       without one takes this, and adopt() skips a title that is undefined. */
    const seen = BROWSER.byTargetId(tid);
    BROWSER.adopt(tid, { url: targetInfo.url, title: seen && seen.title ? undefined : targetInfo.title });
    initPageSession(sessionId, tid);
  }
  broadcastTabs();
}

async function initPageSession(sessionId, targetId) {
  try { await send('Page.enable', {}, sessionId); } catch (e) { logErr('Page.enable:', e.message); return; }
  try { await send('Runtime.enable', {}, sessionId); } catch { /* optional */ }
  try {
    await send('Page.startScreencast', {
      format: 'jpeg', quality: QUALITY,
      maxWidth: MAX_FRAME_W, maxHeight: MAX_FRAME_H,
      everyNthFrame: 1,
    }, sessionId);
    STATE.casting.add(targetId);
    STATE.screencasting = true;
  } catch (e) { logErr('startScreencast:', e.message); }
}

function onCdpMessage(m) {
  if (typeof m.id === 'number') {
    const p = cdpPending.get(m.id);
    if (p) {
      cdpPending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
      else p.resolve(m.result || {});
    }
    return;
  }

  switch (m.method) {
    case 'Target.attachedToTarget': {
      const { sessionId, targetInfo } = m.params;
      registerSession(sessionId, targetInfo);
      break;
    }
    case 'Target.detachedFromTarget': {
      const tid = sessionOwner.get(m.params.sessionId);
      if (tid) {
        const gone = BROWSER.byTargetId(tid);
        if (gone) forgetTitleTimer(gone.tabId);
        sessions.delete(tid);
        STATE.casting.delete(tid);
        STATE.hidden.delete(tid);
        if (BROWSER.isAgentTarget(tid)) STATE.lastFrame = null;
        BROWSER.forget(tid, 'detached');
      }
      sessionOwner.delete(m.params.sessionId);
      broadcastTabs();
      break;
    }
    case 'Target.targetCreated':
    case 'Target.targetInfoChanged': {
      const t = m.params.targetInfo;
      if (!t) break;
      targets.set(t.targetId, t);
      if (t.type === 'page') {
        const known = BROWSER.byTargetId(t.targetId);
        if (known) {
          // the title on this event is the name Chrome guesses from the
          // address, not the one the page has settled on, and the event does
          // not fire again when it does — so a tab that already has a name
          // keeps it, and only a tab still without one takes this guess
          BROWSER.update(known.tabId, { url: t.url, title: known.title ? undefined : t.title });
        }
      }
      broadcastTabs();
      break;
    }
    case 'Target.targetDestroyed': {
      const tid = m.params.targetId;
      const sid = sessions.get(tid);
      targets.delete(tid);
      sessions.delete(tid);
      if (sid) sessionOwner.delete(sid);
      if (BROWSER.isAgentTarget(tid)) STATE.lastFrame = null;
      BROWSER.forget(tid, 'destroyed');
      broadcastTabs();
      break;
    }
    case 'Page.screencastFrame': {
      const p = m.params;
      sendNoWait('Page.screencastFrameAck', { sessionId: p.sessionId }, m.sessionId);
      const tid = sessionOwner.get(m.sessionId);
      const dataUrl = p.data.startsWith('data:') ? p.data : 'data:image/jpeg;base64,' + p.data;
      // only the target the agent is driving reaches the preview. Every page
      // session casts, so without this the preview would show whichever tab
      // happened to produce a frame last.
      if (!BROWSER.isAgentTarget(tid)) break;
      // the frame is stamped with the tabId the UI compares against, so nothing
      // outside this process ever needs the CDP target to make sense of it
      const frameTab = BROWSER.byTargetId(tid);
      const frameTabId = frameTab ? frameTab.tabId : null;
      STATE.lastFrame = { data: dataUrl, metadata: p.metadata, targetId: tid, tabId: frameTabId };
      STATE.lastFrameAt = Date.now();
      broadcast({ type: 'frame', data: dataUrl, metadata: p.metadata, tabId: frameTabId, targetId: tid, ts: STATE.lastFrameAt });
      break;
    }
    case 'Page.screencastVisibilityChanged': {
      const tid = sessionOwner.get(m.sessionId);
      if (tid) {
        if (m.params.visible) STATE.hidden.delete(tid);
        else STATE.hidden.add(tid);
        // Chrome reports visibility for background tabs too, so this only means
        // something when the tab the person is driving went to the background:
        // that is a person switching tabs. Record where they are looking. Do NOT
        // move the agent — the agent's tab is the agent's business, and a click
        // in another tab must not take the work somewhere else.
        const agentTid = BROWSER.agentTarget();
        if (m.params.visible && tid !== agentTid && agentTid && STATE.hidden.has(agentTid)) {
          const seen = BROWSER.byTargetId(tid);
          BROWSER.setFocusedTab(seen ? seen.tabId : null);
        }
      }
      broadcastStatus();
      break;
    }
    case 'Page.frameNavigated': {
      const tid = sessionOwner.get(m.sessionId);
      const navTab = tid ? BROWSER.byTargetId(tid) : null;
      if (navTab && m.params.frame && !m.params.frame.parentId) {
        // The URL is left to Target.targetInfoChanged, which already carries it
        // and already owns the generation bump a new document implies. Here the
        // document exists but has no title yet, so this only schedules the read;
        // Page.loadEventFired is what actually gets the name.
        refreshTitle(navTab.tabId, m.sessionId, 250);
        if (navTab.tabId === BROWSER.agentTabId) {
          broadcast({ type: 'navigating', tabId: navTab.tabId, url: m.params.frame.url || '' });
        }
      }
      break;
    }
    case 'Page.loadEventFired': {
      // The new document is ready, so this is the first moment the title is
      // real. Covers every full navigation, including the person's own.
      const tid = sessionOwner.get(m.sessionId);
      const loadTab = tid ? BROWSER.byTargetId(tid) : null;
      if (loadTab) refreshTitle(loadTab.tabId, m.sessionId);
      break;
    }
    case 'Page.navigatedWithinDocument': {
      // pushState, replaceState, a hash change: the document never unloaded, so
      // the title can be read straight away. Only the title — the URL is already
      // handled, and treating a hash change as a new page would throw away
      // element handles that are still perfectly good.
      const tid = sessionOwner.get(m.sessionId);
      const sameDoc = tid ? BROWSER.byTargetId(tid) : null;
      if (sameDoc) refreshTitle(sameDoc.tabId, m.sessionId);
      break;
    }
    case 'Runtime.consoleAPICalled': {
      const tid = sessionOwner.get(m.sessionId);
      const conTab = tid ? BROWSER.byTargetId(tid) : null;
      if (conTab && conTab.tabId === BROWSER.agentTabId) {
        const text = (m.params.args || [])
          .map(a => a.value !== undefined ? String(a.value) : (a.description || a.type || ''))
          .join(' ');
        broadcast({ type: 'console', level: m.params.type, text: text.slice(0, 500), tabId: conTab.tabId });
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Point the agent at a tab. The one writer of agentTabId that is not the agent
 * asking for it directly. Callers pass a targetId because that is what CDP
 * hands them; the session turns it into the tabId everything else speaks.
 */
function setAgentTarget(tid, activateInChrome, why) {
  if (!tid || !targets.has(tid)) return null;
  /* Pointing the agent at a tab is not new information about its page. The
     cached TargetInfo carries the name Chrome guesses from the address, and
     handing that to adopt() renamed the tab every time it was activated — so
     a tab that already has a name keeps it, and only one without takes this. */
  const info = targets.get(tid);
  const seen = BROWSER.byTargetId(tid);
  const tab = BROWSER.adopt(tid, Object.assign({}, info,
    { title: seen && seen.title ? undefined : info.title }));
  if (!tab) return null;
  BROWSER.setAgentTab(tab.tabId, why || 'server');
  if (activateInChrome) sendNoWait('Target.activateTarget', { targetId: tid });
  const sid = sessions.get(tid);
  if (sid) ensureCasting(sid, tid);
  // a frame from the tab we just left must not survive the switch
  if (STATE.lastFrame && STATE.lastFrame.tabId !== tab.tabId) STATE.lastFrame = null;
  return tab;
}

'use strict';
/* ========================================================================= *
 *  One browser context, read by the tools, the preview and the agent alike.
 *
 *  Before this there was no such thing. The tools asked activeSession(), which
 *  quietly fell back to "the first page in the map" whenever the active target
 *  was missing, and the preview accepted every screencast frame that arrived —
 *  including frames from tabs nobody was driving. So the agent could be on one
 *  tab while the preview showed another.
 *
 *  The session is that context now. browserContext() is the only
 *  place it is read, the agent and the person hold different tabs, and neither
 *  is guessed: if the agent has no tab there is no context, and the tools say
 *  so rather than picking one.
 * ========================================================================= */

/** the single source of truth, shaped the way every consumer needs it */
function browserContext() {
  const tab = BROWSER.agentTab();
  return {
    connected: STATE.connected,
    /* the agent's identity, and the only tab id anyone outside needs */
    tabId: tab ? tab.tabId : null,
    agentTabId: tab ? tab.tabId : null,
    /* the human's, which is UI state and moves nothing */
    focusedTabId: BROWSER.focusedTabId,
    hasSession: !!(tab && sessions.has(tab.targetId)),
    generation: tab ? tab.generation : 0,
    url: tab ? tab.url || '' : '',
    title: tab ? tab.title || '' : '',
    tabs: tabList(),
    /* a name for the session, not the websocket that carries it */
    session: STATE.connected && tab ? 'browser-1' : null,
  };
}

/**
 * The CDP session every action runs against — the agent's target, the preview's
 * target and the reported page, because all three ask here. No fallback: a
 * missing active target is a real state, not an invitation to pick a tab.
 */
function activeSession(tabId) {
  const tab = tabId ? BROWSER.resolve(tabId) : BROWSER.agentTab();
  if (!tab) return null;
  const sid = sessions.get(tab.targetId);
  if (!sid) return null;
  return { tabId: tab.tabId, targetId: tab.targetId, sessionId: sid, generation: tab.generation };
}

/** true when this is the target the agent is driving and the preview may show */
function isActiveTarget(tid) {
  return BROWSER.isAgentTarget(tid);
}

/* -------------------------------------------------------------------------
 *  Element references
 *
 *  A ref is an opaque handle minted from a read of one tab. It carries the tab
 *  and the generation it was minted at, so using it somewhere else, or after
 *  the page has moved on, is an error rather than a guess.
 * ------------------------------------------------------------------------- */
const refs = new Map();      // ref -> { tabId, generation, selector }
let refSeq = 0;
const REF_CAP = 400;

function mintRef(tab, selector) {
  const ref = 'e' + (++refSeq);
  refs.set(ref, { tabId: tab.tabId, generation: tab.generation, selector: String(selector || '') });
  if (refs.size > REF_CAP) refs.delete(refs.keys().next().value);
  return ref;
}

/**
 * Turn a ref back into a selector, or refuse.
 * The two refusals matter: a ref from another tab is never honoured, and a ref
 * from before a navigation is never honoured.
 */
function refSelector(tab, ref) {
  const r = refs.get(String(ref));
  if (!r) throw new Error('unknown element ref ' + ref + ' — read the page again to get fresh ones');
  if (r.tabId !== tab.tabId) {
    throw new Error('element ref ' + ref + ' belongs to another tab; read the tab you are acting on');
  }
  if (r.generation !== tab.generation) {
    throw new Error('element ref ' + ref + ' is stale: the page navigated since it was read. Read it again.');
  }
  return r.selector;
}

/** the selector a call is really about: an explicit one, or one behind a ref */
function selectorFor(tab, body) {
  if (body.ref) return refSelector(tab, body.ref);
  return body.selector === undefined || body.selector === null ? undefined : String(body.selector);
}

/**
 * The page a person is looking at right now, asked of the pages themselves.
 *
 * This is used exactly once: to give a brand new session its first tab. It is
 * not a rule about where the agent should be, and nothing calls it again while
 * the agent works. The agent's tab is whatever the agent last chose.
 */
async function visiblePageTarget() {
  const pages = [];
  for (const [tid, sid] of sessions) {
    const t = targets.get(tid);
    if (t && t.type === 'page') pages.push({ tid, sid });
  }
  if (!pages.length) return null;
  let visibleOnly = null;
  for (const p of pages) {
    let state = '';
    try {
      state = String(await evalValue(
        p.sid,
        'document.visibilityState + (document.hasFocus() ? ":focus" : "")'
      ) || '');
    } catch { continue; }            // a page that will not answer is not the one
    if (state === 'visible:focus') return p.tid;   // the tab the user is on
    if (state === 'visible' && !visibleOnly) visibleOnly = p.tid;
  }
  if (visibleOnly) return visibleOnly;
  // Nothing is visible: every window is hidden or minimised. Say so rather
  // than binding the agent to an arbitrary tab.
  return null;
}

/** a page session must be casting before the preview can show anything */
async function ensureCasting(sessionId, targetId) {
  if (!sessionId || !targetId || STATE.casting.has(targetId)) return;
  try {
    await send('Page.startScreencast', {
      format: 'jpeg', quality: QUALITY,
      maxWidth: MAX_FRAME_W, maxHeight: MAX_FRAME_H,
      everyNthFrame: 1,
    }, sessionId);
    STATE.casting.add(targetId);
  } catch (e) { logErr('startScreencast:', e.message); }
}

/* ====================================================================== *
 *  Browser actions                                                        *
 * ====================================================================== */

const KEY_TABLE = {
  Enter: { key: 'Enter', code: 'Enter', vkc: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vkc: 9 },
  Escape: { key: 'Escape', code: 'Escape', vkc: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vkc: 8 },
  Delete: { key: 'Delete', code: 'Delete', vkc: 46 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vkc: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vkc: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vkc: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vkc: 40 },
  Home: { key: 'Home', code: 'Home', vkc: 36 },
  End: { key: 'End', code: 'End', vkc: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vkc: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vkc: 34 },
  Space: { key: ' ', code: 'Space', vkc: 32, text: ' ' },
};

const MOD_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8, Cmd: 4, Ctrl: 2 };

function codeForChar(ch) {
  if (/[a-z]/i.test(ch)) return 'Key' + ch.toUpperCase();
  if (/[0-9]/.test(ch)) return 'Digit' + ch;
  const named = { ' ': 'Space', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', ';': 'Semicolon', "'": 'Quote', '`': 'Backquote', ',': 'Comma', '.': 'Period', '/': 'Slash', '\\': 'Backslash' };
  return named[ch] || '';
}
function vkcForChar(ch) {
  if (/[a-z]/i.test(ch)) return ch.toUpperCase().charCodeAt(0);
  if (/[0-9]/.test(ch)) return ch.charCodeAt(0);
  return 0;
}

async function viewportSize(sessionId) {
  try {
    const r = await send('Page.getLayoutMetrics', {}, sessionId);
    const v = r.cssVisualViewport || r.visualViewport || {};
    const w = v.clientWidth || (r.cssLayoutViewport && r.cssLayoutViewport.width) || 1;
    const h = v.clientHeight || (r.cssLayoutViewport && r.cssLayoutViewport.height) || 1;
    return { w, h };
  } catch {
    return { w: 1, h: 1 };
  }
}

/** CDP input silently does nothing while document.hidden is true (window
 *  minimized / fully occluded). Make sure the page is actually shown first. */
async function ensureVisible(sessionId, targetId) {
  let hidden = false;
  try { hidden = !!(await evalValue(sessionId, 'document.hidden')); }
  catch { return; }
  if (!hidden) return;
  try { await send('Page.bringToFront', {}, sessionId); } catch { /* ignore */ }
  await sleep(80);
  try { hidden = !!(await evalValue(sessionId, 'document.hidden')); } catch { return; }
  if (!hidden) return;
  // window is minimized — restore it
  try {
    const g = await send('Browser.getWindowForTarget', { targetId });
    await send('Browser.setWindowBounds', { windowId: g.windowId, bounds: { windowState: 'normal' } });
    await sleep(150);
    await send('Page.bringToFront', {}, sessionId);
    await sleep(80);
  } catch { /* ignore */ }
}

const RECT_EXPR = String.raw`(() => {
  const el = document.querySelector(__SEL__);
  if (!el) return null;
  el.scrollIntoView({block:'center', inline:'center'});
  const b = el.getBoundingClientRect();
  if (!b.width && !b.height) return null;
  return {
    x: b.left + b.width / 2,
    y: b.top + b.height / 2,
    tag: el.tagName,
    text: (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').slice(0, 80)
  };
})()`;

async function pointFor(sessionId, args) {
  if (args.selector) {
    const expr = RECT_EXPR.replace('__SEL__', JSON.stringify(args.selector));
    const rect = await evalValue(sessionId, expr);
    if (!rect) throw new Error(`no element matches selector: ${args.selector}`);
    return { x: rect.x, y: rect.y, note: rect };
  }
  const vp = await viewportSize(sessionId);
  const nx = typeof args.nx === 'number' ? args.nx : 0.5;
  const ny = typeof args.ny === 'number' ? args.ny : 0.5;
  return { x: clamp(nx, 0, 1) * vp.w, y: clamp(ny, 0, 1) * vp.h, note: null };
}

async function waitForLoad(sessionId, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const st = await evalValue(sessionId, 'document.readyState');
      if (st === 'complete') return true;
    } catch { return false; }
    await sleep(150);
  }
  return false;
}

const READ_EXPR = String.raw`(() => {
  const cssEsc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&');
  const sel = (el) => {
    if (el.id) return '#' + cssEsc(el.id);
    const cls = [...(el.classList || [])].slice(0, 2).filter(Boolean).join('.');
    const base = el.tagName.toLowerCase() + (cls ? '.' + cls : '');
    try { if (document.querySelectorAll(base).length === 1) return base; } catch (e) {}
    const p = el.parentElement;
    if (!p || p === document.documentElement) return base;
    const same = [...p.children].filter(c => c.tagName === el.tagName);
    const idx = same.indexOf(el) + 1;
    const tail = same.length > 1 ? ':nth-of-type(' + idx + ')' : '';
    const parentSel = p === document.body ? 'body' : sel(p);
    return parentSel + ' > ' + el.tagName.toLowerCase() + (cls ? '.' + cls : '') + tail;
  };
  const vis = (el) => {
    try {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05) return false;
      if (r.bottom < -50 || r.top > innerHeight + 50) return false;
      return true;
    } catch (e) { return false; }
  };
  const lab = (el) => {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return aria;
    if (el.id) {
      const l = document.querySelector('label[for="' + cssEsc(el.id) + '"]');
      if (l) return (l.innerText || '').trim();
    }
    const pl = el.getAttribute && el.getAttribute('placeholder');
    if (pl) return pl;
    const titled = el.getAttribute && el.getAttribute('title');
    if (titled) return titled;
    return (el.innerText || el.value || '').replace(/\s+/g, ' ').trim();
  };
  const flat = (el) => (el.innerText || '').replace(/\s+/g, ' ').trim();
  const take = (sel_, n) => { try { return [...document.querySelectorAll(sel_)].filter(vis).slice(0, n); } catch (e) { return []; } };
  const links = take('a[href]', 60).map(a => ({ text: flat(a).slice(0, 110), href: a.href, selector: sel(a) }));
  const buttons = take('button, [role="button"], input[type="submit"], input[type="button"]', 60)
    .map(b => ({ text: lab(b).slice(0, 110), disabled: !!b.disabled, selector: sel(b) }));
  const inputs = take('input, textarea, select', 40).map(i => ({
    tag: i.tagName.toLowerCase(), type: (i.type || ''), name: (i.name || ''),
    placeholder: (i.placeholder || ''), label: lab(i).slice(0, 90),
    selector: sel(i), value: (i.type === 'password') ? '' : String(i.value || '').slice(0, 120)
  }));
  const headings = take('h1, h2, h3', 30).map(h => ({ level: h.tagName, text: flat(h).slice(0, 160) }));
  const text = (document.body ? document.body.innerText : '')
    .replace(/\n{3,}/g, '\n\n').slice(0, 12000);
  return {
    url: location.href, title: document.title, lang: document.documentElement.lang || '',
    readyState: document.readyState, text, headings, links, buttons, inputs
  };
})()`;

async function doAction(body) {
  const act = String(body.action || '');
  const wanted = body.tabId ? String(body.tabId) : null;

  if (wanted) {
    const tab = BROWSER.resolve(wanted);
    if (!tab) {
      const known = BROWSER.list().map(x => x.id);
      throw new Error('no such tab: ' + wanted
        + (known.length ? ' — open tabs: ' + known.join(', ') : ' — no tabs are open'));
    }
  }
  // With no tabId the agent means the tab it owns — never the tab the person is
  // looking at. If it has no tab either, that is said out loud.
  const sess = activeSession(wanted);
  if (!sess) {
    const known = BROWSER.list().map(x => x.id);
    throw new Error('this agent has no browser tab yet'
      + (known.length
        ? ' — pass one of these as tabId: ' + known.join(', ')
        : ' — open one with browser_tabs action "new"'));
  }
  const sid = sess.sessionId;
  return withActionLock(() => doActionOn(act, body, sess, sid));
}

async function doActionOn(act, body, sess, sid) {

  switch (act) {
    case 'navigate': {
      let url = String(body.url || '').trim();
      if (!url) throw new Error('url required');
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = (url.includes('.') && !url.includes(' ')) ? 'https://' + url : 'https://www.google.com/search?q=' + encodeURIComponent(url);
      const r = await send('Page.navigate', { url }, sid);
      if (r.errorText) throw new Error(r.errorText);
      await waitForLoad(sid, 12000);
      const out = { url: await evalValue(sid, 'location.href'), title: await evalValue(sid, 'document.title'), tabId: sess.tabId };
      // before bump(), so the navigation event the panel listens for carries it
      await noteLiveTitle(sess.tabId, sid);
      // the page the agent was reading is gone; its refs are too
      BROWSER.bump(sess.tabId, 'navigated');
      return out;
    }
    case 'back':
    case 'forward': {
      const h = await send('Page.getNavigationHistory', {}, sid);
      // an entry's place in the array is its index; it carries no index field
      const entries = h.entries || [];
      const at = h.currentIndex + (act === 'forward' ? 1 : -1);
      const entry = entries[at];
      if (!entry) {
        return { moved: false, reason: 'no history entry',
          where: act === 'forward' ? 'at the end of this tab\'s history' : 'at the start of this tab\'s history',
          entries: entries.length, index: h.currentIndex };
      }
      await send('Page.navigateToHistoryEntry', { entryId: entry.id }, sid);
      await waitForLoad(sid, 8000);
      return { moved: true, url: await evalValue(sid, 'location.href') };
    }
    case 'reload': {
      await send('Page.reload', { ignoreCache: !!body.cache }, sid);
      await waitForLoad(sid, 12000);
      return { url: await evalValue(sid, 'location.href') };
    }
    case 'stop':
      await send('Page.stopLoading', {}, sid);
      return { stopped: true };
    case 'click': {
      const sel = selectorFor(BROWSER.resolve(sess.tabId), body);
      if (sel === undefined && body.ref) throw new Error('that click named an element but no ref');
      const p = await pointFor(sid, sel === undefined ? body : Object.assign({}, body, { selector: sel }));
      await ensureVisible(sid, sess.targetId);
      const ev = { x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' };
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0, pointerType: 'mouse' }, sid);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...ev }, sid);
      await sleep(35);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...ev, buttons: 0 }, sid);
      await sleep(120);
      return { clicked: true, x: Math.round(p.x), y: Math.round(p.y), selector: body.selector || null };
    }
    case 'drag': {
      // normalised 0..1 endpoints from the canvas pointer handler
      await ensureVisible(sid, sess.targetId);
      const vp = await viewportSize(sid);
      const num = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;
      const x1 = clamp(num(body.x1, 0.5), 0, 1) * vp.w;
      const y1 = clamp(num(body.y1, 0.5), 0, 1) * vp.h;
      const x2 = clamp(num(body.x2, 0.5), 0, 1) * vp.w;
      const y2 = clamp(num(body.y2, 0.5), 0, 1) * vp.h;
      const dist = Math.hypot(x2 - x1, y2 - y1);
      const steps = clamp(Math.round(dist / 12), 2, 60);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, button: 'none', buttons: 0, pointerType: 'mouse' }, sid);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' }, sid);
      await sleep(45);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t,
          button: 'left', buttons: 1, pointerType: 'mouse',
        }, sid);
        if (i < steps) await sleep(10);
      }
      await sleep(50);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' }, sid);
      await sleep(150);
      return {
        dragged: true, steps,
        from: { x: Math.round(x1), y: Math.round(y1) },
        to: { x: Math.round(x2), y: Math.round(y2) },
      };
    }
    case 'type': {
      const text = String(body.text ?? '');
      let focused = true;
      const sel = selectorFor(BROWSER.resolve(sess.tabId), body);
      const useSel = sel === undefined ? body.selector : sel;
      await ensureVisible(sid, sess.targetId);
      if (useSel) {
        const expr = `(() => {
          const el = document.querySelector(${JSON.stringify(String(useSel))});
          if (!el) return 'missing';
          el.focus({preventScroll:true});
          if (${body.clear ? 'true' : 'false'} && typeof el.select === 'function') { try { el.select(); } catch (e) {} }
          return 'ok';
        })()`;
        const r = await evalValue(sid, expr);
        focused = r === 'ok';
        if (!focused) throw new Error(`no element matches selector: ${useSel}`);
      }
      if (body.clear && !useSel) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 }, sid);
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 }, sid);
      }
      if (text) await send('Input.insertText', { text }, sid);
      await sleep(80);
      return { typed: text.length, focused, selector: useSel || null };
    }
    case 'press': {
      await ensureVisible(sid, sess.targetId);
      const combo = String(body.key || '').split('+').map(s => s.trim()).filter(Boolean);
      if (!combo.length) throw new Error('key required');
      const mods = combo.slice(0, -1);
      const base = combo[combo.length - 1];
      let modifiers = 0;
      for (const m of mods) {
        if (MOD_BITS[m] === undefined) throw new Error('unknown modifier: ' + m);
        modifiers |= MOD_BITS[m];
      }
      const k = KEY_TABLE[base] ||
        (base.length === 1
          ? { key: base, code: codeForChar(base), vkc: vkcForChar(base), text: modifiers ? '' : base }
          : null);
      if (!k) throw new Error('unknown key: ' + base);
      const common = {
        key: k.key, code: k.code || '', modifiers,
        windowsVirtualKeyCode: k.vkc || 0, nativeVirtualKeyCode: k.vkc || 0,
        autoRepeat: false, location: 0, isKeypad: false,
      };
      const text = modifiers ? '' : (k.text !== undefined ? k.text : '');
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common }, sid).catch(() => {});
      if (text) await send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, text, unmodifiedText: text }, sid).catch(() => {});
      await sleep(20);
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common }, sid);
      await sleep(60);
      return { pressed: k.key, modifiers: mods };
    }
    case 'scroll': {
      const p = await pointFor(sid, body);
      await ensureVisible(sid, sess.targetId);
      const dy = Number(body.direction === 'up' ? -(body.deltaY ?? 300) : (body.deltaY ?? 300));
      const dx = Number(body.deltaX || 0);
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: dx, deltaY: dy, pointerType: 'mouse' }, sid);
      await sleep(150);
      return { scrolled: true, deltaY: dy };
    }
    case 'wait':
      await sleep(clamp(Number(body.ms) || 500, 0, 20000));
      return { waited: Number(body.ms) || 500 };
    case 'read': {
      const tab = BROWSER.resolve(sess.tabId);
      const snap = await evalValue(sid, READ_EXPR);
      if (!snap) throw new Error('could not read the page');
      // every selector handed out gets a ref, tied to this tab and this
      // generation, so the agent can act on an element without re-typing CSS
      const refOut = (o) => {
        if (!o || !o.selector) return o;
        o.ref = mintRef(tab, o.selector);
        return o;
      };
      // 'inputs', not 'fields': that is the key READ_EXPR returns. The two names
      // never matched, and because a missing key is quietly skipped rather than
      // thrown, every form field came back with a selector and no ref — the
      // agent could see a text box and still have nothing to type into it with.
      for (const k of ['links', 'buttons', 'inputs', 'headings']) {
        if (Array.isArray(snap[k])) snap[k] = snap[k].map(refOut);
      }
      snap.tabId = tab.tabId;
      snap.generation = tab.generation;
      if (body.withScreenshot && STATE.lastFrame && STATE.lastFrame.tabId === tab.tabId) {
        snap.screenshot = STATE.lastFrame.data;
        snap.screenshotMetadata = STATE.lastFrame.metadata;
      }
      return snap;
    }
    case 'screenshot':
      // a frame from another tab is not this tab's picture
      if (!STATE.lastFrame || STATE.lastFrame.tabId !== sess.tabId) return { error: 'no frame captured for this tab yet' };
      return { data: STATE.lastFrame.data, metadata: STATE.lastFrame.metadata, capturedAt: STATE.lastFrameAt, tabId: sess.tabId };
    case 'javascript': {
      const code = String(body.code || body.expression || '').trim();
      if (!code) throw new Error('code required');
      const value = await evalValue(sid, code);
      return { value: value === undefined ? null : value };
    }
    case 'viewport': {
      // "fit" means the size of the *page*; width/height mean the window
      if (body.fit && body.fit.w && body.fit.h) {
        const vp = await fitPageToWindow(sid, sess.targetId, body.fit);
        return { viewport: vp, fit: true };
      }
      await setWindowBounds(body);
      await sleep(400);
      const vp = await viewportSize(sid);
      return { viewport: vp };
    }
    case 'focus': {
      // the agent names a tab to move to; it may not name a CDP target
      const wanted = String(body.tabId || body.targetId || '');
      const tab = wanted ? BROWSER.resolve(wanted) : null;
      if (wanted && !tab) throw new Error('no such tab: ' + wanted);
      if (tab) setAgentTarget(tab.targetId, true, 'agent asked');
      return { tabId: BROWSER.agentTabId };
    }
    default:
      throw new Error(`unknown action: ${act}`);
  }
}

/**
 * Make the *page* the size the caller asked for, not the window.
 *
 * A window is taller and wider than what it shows: the title bar, the tab strip
 * and the frame all come off the top and the sides. Asking for a 744x502 window
 * therefore yields a page of about 744x375, which is not what anyone who sizes
 * their panel to 744x502 wanted. Only this side can measure that difference,
 * so the client states the size it wants for the page and the correction is
 * applied here, once, against the real measured content.
 */
async function fitPageToWindow(sessionId, targetId, want) {
  const g0 = await send('Browser.getWindowForTarget', { targetId });
  const before = await viewportSize(sessionId);
  const win = (g0 && g0.bounds) || {};
  // how much of the window is not page
  const chromeW = Math.max(0, Math.round((win.width || 0) - before.w));
  const chromeH = Math.max(0, Math.round((win.height || 0) - before.h));
  const wantW = Math.max(320, Math.round(want.w));
  const wantH = Math.max(240, Math.round(want.h));
  await send('Browser.setWindowBounds', {
    windowId: g0.windowId,
    bounds: {
      width: Math.min(MAX_FRAME_W + chromeW, wantW + chromeW),
      height: Math.min(MAX_FRAME_H + chromeH, wantH + chromeH),
      windowState: 'normal',
    },
  });
  await sleep(220);
  // one correction, because a frame's own border can move when the size settles
  const after = await viewportSize(sessionId);
  const dw = wantW - after.w, dh = wantH - after.h;
  if (Math.abs(dw) > 2 || Math.abs(dh) > 2) {
    const g1 = await send('Browser.getWindowForTarget', { targetId });
    await send('Browser.setWindowBounds', {
      windowId: g1.windowId,
      bounds: {
        width: Math.max(320, Math.round((g1.bounds.width || 0) + dw)),
        height: Math.max(240, Math.round((g1.bounds.height || 0) + dh)),
        windowState: 'normal',
      },
    });
    await sleep(220);
  }
  return viewportSize(sessionId);
}

async function setWindowBounds(body) {
  const tid = BROWSER.agentTarget();
  if (!tid) throw new Error('this agent has no browser tab yet');
  let bounds = null;
  if (body.width && body.height) {
    bounds = { width: Math.round(Number(body.width)), height: Math.round(Number(body.height)), windowState: 'normal' };
  } else if (body.preset === 'auto') {
    bounds = { windowState: 'normal' };
  } else if (body.preset) {
    const [w, h] = String(body.preset).split(/[x×]/i).map(Number);
    if (w && h) bounds = { width: w, height: h, windowState: 'normal' };
  }
  if (!bounds) throw new Error('give width/height, preset (e.g. "1280x800"), or preset:"auto"');
  const g = await send('Browser.getWindowForTarget', { targetId: tid });
  await send('Browser.setWindowBounds', { windowId: g.windowId, bounds });
}

async function doTabs(body) {
  const action = String(body.action || 'list');

  if (action === 'list') {
    return { tabs: tabList(), focusedTabId: BROWSER.focusedTabId, agentTabId: BROWSER.agentTabId };
  }

  if (action === 'new') {
    return withActionLock(async () => {
      const t = await send('Target.createTarget', { url: body.url || 'about:blank', background: !!body.background });
      await sleep(350);
      // a page appears as a target; the session gives it a tabId of its own
      const tab = BROWSER.adopt(t.targetId, { url: body.url || 'about:blank' });
      if (!tab) throw new Error('the new tab did not attach');
      const sid = sessions.get(t.targetId);
      if (sid) {
        try { await initPageSession(sid, t.targetId); } catch { /* not fatal */ }
        // the tab was created with an address but never with a name, so the tab
        // bar would have shown the url until the agent navigated somewhere
        try { await waitForLoad(sid, 5000); } catch { /* slow or endless page */ }
        await noteLiveTitle(tab.tabId, sid);
      }
      // the tab the agent opened is the tab it now drives
      if (!body.background) setAgentTarget(t.targetId, true, 'agent opened a tab');
      else { broadcastContext(); broadcastTabs(); }
      const live = BROWSER.resolve(tab.tabId) || tab;
      return { tabId: tab.tabId, url: live.url, title: live.title, tabs: tabList(), agentTabId: BROWSER.agentTabId };
    });
  }

  if (action === 'activate') {
    const wanted = String(body.tabId || body.id || '');
    const tab = wanted ? BROWSER.resolve(wanted) : null;
    if (!tab) {
      const known = tabList().map(x => x.id);
      throw new Error('no such tab: ' + (wanted || '(none given)')
        + (known.length ? ' — open tabs: ' + known.join(', ') : ' — no tabs are open'));
    }
    return withActionLock(async () => {
      setAgentTarget(tab.targetId, true, 'agent activated a tab');
      await sleep(250);
      return { tabId: tab.tabId, tabs: tabList(), agentTabId: BROWSER.agentTabId, focusedTabId: BROWSER.focusedTabId };
    });
  }

  if (action === 'close') {
    // no id means the tab this agent is driving
    const wanted = String(body.tabId || body.id || BROWSER.agentTabId || '');
    const tab = wanted ? BROWSER.resolve(wanted) : null;
    if (!tab) throw new Error('no such tab: ' + (wanted || '(none given)'));
    const wasAgentTab = tab.tabId === BROWSER.agentTabId;
    await send('Target.closeTarget', { targetId: tab.targetId });
    await sleep(300);
    // If it was the agent's tab, the agent now has none. It is NOT re-picked
    // from whatever the person happens to be looking at: the agent chooses.
    if (wasAgentTab && !BROWSER.agentTabId) { broadcastContext(); broadcastStatus(); }
    return { closed: tab.tabId, tabs: tabList(), agentTabId: BROWSER.agentTabId };
  }

  throw new Error('unknown tab action: ' + action);
}

/**
 * Record the page's own title on a tab.
 *
 * Called only where the page has just finished arriving and a session to it is
 * already in hand, so this is a read that costs nothing extra and needs no
 * polling to stay true. A page that will not answer simply keeps whatever
 * title it has, which is the honest state.
 */
async function noteLiveTitle(tabId, sessionId) {
  if (!tabId || !sessionId) return null;
  try {
    const title = await evalValue(sessionId, 'document.title');
    if (title) BROWSER.update(tabId, { title });
    return title || null;
  } catch {
    return null;
  }
}

/**
 * Re-read a tab's title from the page and tell the dashboard if it moved.
 *
 * noteLiveTitle is only ever called from the two places where we asked for a
 * navigation, so a person clicking a link in Chrome, typing in the address bar
 * or pressing Back left every tab showing the name the last agent-driven
 * navigate happened to settle on. This is the one case where a stale title is
 * a bug rather than a conservative default, because there is no action of ours
 * to hang the read off — the only signal is the page telling us it moved.
 *
 * Reads are coalesced per tab. Page.frameNavigated and Page.loadEventFired land
 * within a few milliseconds of each other, and the first one fires on a document
 * that has no title yet, so an uncoalesced pair would cost two evals and settle
 * one of them on an empty string.
 */
const titleTimers = new Map();

function refreshTitle(tabId, sessionId, delay = 0) {
  if (!tabId || !sessionId) return;
  const prev = titleTimers.get(tabId);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    titleTimers.delete(tabId);
    const before = (BROWSER.resolve(tabId) || {}).title || '';
    noteLiveTitle(tabId, sessionId).then((title) => {
      // only a change is worth a broadcast: the tab bar redraws on every one
      if (title && title !== before) broadcastTabs();
    });
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
  titleTimers.set(tabId, timer);
}

function forgetTitleTimer(tabId) {
  const t = titleTimers.get(tabId);
  if (t) { clearTimeout(t); titleTimers.delete(tabId); }
}

function tabList() {
  // the session is the only place a tab is listed from, and the id in the list
  // is the tabId — never a CDP target
  return BROWSER.list().map(t => ({
    id: t.id,
    url: t.url || '',
    title: t.title || t.url || 'New tab',
    active: t.agent,
    agent: t.agent,
    focused: t.focused,
    generation: t.generation,
    loading: t.loading,
    canGoBack: t.canGoBack,
    canGoForward: t.canGoForward,
    hasSession: sessions.has((BROWSER.resolve(t.id) || {}).targetId),
  }));
}

function statusObject() {
  const ctx = browserContext();
  return {
    ok: ctx.connected,
    port: STATE.port,
    chrome: STATE.version,
    // Which browser the agent is actually on, so this is answerable from the
    // dashboard instead of by inspecting the process list.
    browser: BROWSER_BIN
      ? { path: BROWSER_BIN.path, source: BROWSER_BIN.source, version: BROWSER_BIN.version || null }
      : null,
    cdpPort: CDP_PORT,
    profile: PROFILE,
    /* The screencast is downscaled to fit these, so a client sizing a window to
       match its canvas has to know them or it will ask for something the frame
       can never have and letterbox itself. */
    frame: { maxW: MAX_FRAME_W, maxH: MAX_FRAME_H, quality: QUALITY },
    screencasting: STATE.screencasting,
    /* how many browser actions are queued or running. Read here so the field
       the comment has been promising is actually answerable: while this is
       above zero, an action a person makes on the preview waits for the agent's
       action to finish rather than landing in the middle of it. The dashboard
       can grey the preview or say "the agent is mid-action" off this, and
       anything asking whether it is safe to poke the browser right now has one
       number to read instead of guessing. */
    acting: STATE.acting,
    attached: ctx.hasSession,
    tabId: ctx.tabId,
    agentTabId: ctx.agentTabId,
    focusedTabId: ctx.focusedTabId,
    generation: ctx.generation,
    url: ctx.url || null,
    title: ctx.title || null,
    tabs: ctx.tabs,
    lastFrameAt: STATE.lastFrameAt,
    frameAge: STATE.lastFrameAt ? Date.now() - STATE.lastFrameAt : null,
  };
}

/* ====================================================================== *
 *  WebSocket server (hand-rolled, zero deps)                              *
 * ====================================================================== */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

class WSConn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.fragOpcode = 0;
    this.closed = false;
    socket.setNoDelay(true);
    socket.on('data', d => this.onData(d));
    socket.on('close', () => this.destroy());
    socket.on('error', () => this.destroy());
  }

  onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    if (this.buf.length > 4 * 1024 * 1024) return this.destroy();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const f = this.readFrame();
      if (!f) break;
      this.handleFrame(f);
      if (this.closed) break;
    }
  }

  readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      const big = b.readBigUInt64BE(off); off += 8;
      if (big > BigInt(32 * 1024 * 1024)) { this.destroy(); return null; }
      len = Number(big);
    }
    let mask = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.subarray(off, off + 4); off += 4;
    }
    if (b.length < off + len) return null;
    let payload = b.subarray(off, off + len);
    if (mask) {
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
      payload = out;
    }
    this.buf = b.subarray(off + len);
    return { fin, opcode, payload };
  }

  handleFrame(f) {
    switch (f.opcode) {
      case 0x0: // continuation
        this.frags.push(f.payload);
        if (f.fin) {
          const full = Buffer.concat(this.frags);
          this.frags = [];
          this.deliver(this.fragOpcode, full);
        }
        break;
      case 0x1: // text
      case 0x2: // binary
        if (f.fin) { this.frags = []; this.deliver(f.opcode, f.payload); }
        else { this.frags = [f.payload]; this.fragOpcode = f.opcode; }
        break;
      case 0x8: // close
        try { this.socket.write(encodeFrame(0x8, Buffer.alloc(0))); } catch { /* ignore */ }
        this.destroy();
        break;
      case 0x9: // ping
        this.raw(0xA, f.payload);
        break;
      case 0xA: // pong
        break;
      default:
        this.destroy();
    }
  }

  deliver(opcode, payload) {
    if (opcode !== 0x1) return; // we only accept text
    const text = payload.toString('utf8');
    const onMessage = this.onmessage;
    if (onMessage) {
      try { onMessage(text); } catch (e) { logErr('ws handler:', e.message); }
    }
  }

  raw(opcode, payload) {
    if (this.closed || !this.socket.writable) return;
    try { this.socket.write(encodeFrame(opcode, payload)); } catch { this.destroy(); }
  }

  send(obj) {
    if (this.closed || !this.socket.writable) return;
    // screencast floods: drop rather than buffer unboundedly
    if (this.socket.writableLength > 6 * 1024 * 1024) return;
    this.raw(0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.destroy(); } catch { /* ignore */ }
    if (this.onclose) { try { this.onclose(); } catch { /* ignore */ } }
  }
}

function broadcast(obj) {
  if (!clients.size) return;
  const text = JSON.stringify(obj);
  for (const c of clients) {
    if (c.closed) continue;
    if (c.socket.writableLength > 6 * 1024 * 1024) continue;
    try { c.socket.write(encodeFrame(0x1, Buffer.from(text, 'utf8'))); } catch { c.destroy(); }
  }
}

function broadcastTabs() { broadcast({ type: 'tabs', tabs: tabList() }); }
function broadcastStatus() { broadcast({ type: 'status', status: statusObject() }); }

/** the page renders the preview from this, and nothing else */
function broadcastContext() { broadcast({ type: 'context', context: browserContext() }); }

/* ====================================================================== *
 *  HTTP server                                                            *
 * ====================================================================== */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8',
};

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return true;
  return origin === `http://${req.headers.host}`;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, over = false;
    req.on('data', c => {
      size += c.length;
      // drain without destroying the socket, so the caller can answer with a
      // real 413 instead of the client seeing a reset connection
      if (size > limit) { chunks.length = 0; over = true; return; }
      chunks.push(c);
    });
    req.on('end', () => (over ? reject(new Error('body too large')) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

async function handleApi(req, res, pathname) {
  if (!originAllowed(req)) return sendJson(res, 403, { error: 'origin not allowed' });

  if (pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'octop-browser-automation',
      uptime: process.uptime(),
      browser: {
        connected: STATE.connected,
        launchedByUs: STATE.launchedByUs,
        version: STATE.version,
        port: CDP_PORT,
      },
    });
  }

  if (pathname === '/api/ready') {
    const ready = STATE.connected && !!activeSession();
    return sendJson(res, ready ? 200 : 503, {
      ok: ready,
      service: 'octop-browser-automation',
      browserConnected: STATE.connected,
      activeTab: !!activeSession(),
    });
  }

  if (pathname === '/api/browser/status' && req.method === 'GET') {
    const st = statusObject();
    const sess = activeSession();
    st.pageHidden = null;
    if (sess) {
      try { st.pageHidden = !!(await evalValue(sess.sessionId, 'document.hidden')); } catch { st.pageHidden = null; }
      try {
        const g = await send('Browser.getWindowForTarget', { targetId: sess.targetId });
        st.windowState = (g.bounds && g.bounds.windowState) || 'normal';
        st.windowBounds = g.bounds || null;
      } catch { st.windowState = null; }
    }
    return sendJson(res, 200, st);
  }

  if (pathname === '/api/browser/action' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch (e) { return sendJson(res, 400, { error: 'bad json: ' + e.message }); }
    try {
      const result = await doAction(body);
      broadcastStatus();
      return sendJson(res, 200, { ok: true, action: body.action, result });
    } catch (e) {
      logErr('action', body.action, '->', e.message);
      return sendJson(res, 400, { ok: false, action: body.action, error: e.message });
    }
  }

  if (pathname === '/api/browser/tabs') {
    if (req.method === 'GET') return sendJson(res, 200, { tabs: tabList() });
    if (req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); }
      catch (e) { return sendJson(res, 400, { error: 'bad json: ' + e.message }); }
      try {
        const r = await doTabs(body);
        broadcastTabs();
        broadcastStatus();
        return sendJson(res, 200, { ok: true, ...r });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message });
      }
    }
  }

  if (pathname === '/api/ai/chat' && req.method === 'POST') {
    let cfg;
    try { cfg = JSON.parse(await readBody(req) || '{}'); }
    catch (e) { return sendJson(res, 400, { error: 'bad json: ' + e.message }); }
    return proxyChat(cfg, res);
  }

  /* ---- settings: AI providers + agent profiles ---- */

  if (pathname === '/api/config/agents' && req.method === 'GET') {
    return sendJson(res, 200, aiStore.publicView());
  }

  if (pathname === '/api/config/agents' && req.method === 'PUT') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch (e) { return sendJson(res, 400, { ok: false, error: 'bad json: ' + e.message }); }
    try { return sendJson(res, 200, { ok: true, config: aiStore.replaceAll(body) }); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }

  if (pathname === '/api/config/agents/provider' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch (e) { return sendJson(res, 400, { ok: false, error: 'bad json: ' + e.message }); }
    try { return sendJson(res, 200, { ok: true, provider: aiStore.upsertProvider(body) }); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }

  if (pathname === '/api/config/agents/provider' && req.method === 'DELETE') {
    const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
    try { return sendJson(res, 200, { ok: true, ...aiStore.deleteProvider(id) }); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }

  if (pathname === '/api/config/agents/profile' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch (e) { return sendJson(res, 400, { ok: false, error: 'bad json: ' + e.message }); }
    try { return sendJson(res, 200, { ok: true, profile: aiStore.upsertProfile(body) }); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }

  if (pathname === '/api/config/agents/profile' && req.method === 'DELETE') {
    const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
    try { return sendJson(res, 200, { ok: true, ...aiStore.deleteProfile(id) }); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }

  if (pathname === '/api/config/agents/activate' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch (e) { return sendJson(res, 400, { ok: false, error: 'bad json: ' + e.message }); }
    try { return sendJson(res, 200, { ok: true, ...aiStore.activateProfile(String(body.id || '')), config: aiStore.publicView() }); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }

  /* one-way import of the pre-Settings browser-local config */
  if (pathname === '/api/config/agents/migrate' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch (e) { return sendJson(res, 400, { ok: false, error: 'bad json: ' + e.message }); }
    try {
      const r = aiStore.migrateLegacy(body);
      return sendJson(res, 200, { ok: true, ...r, config: aiStore.publicView() });
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }

  /* real Test Connection — no fake success anywhere in this path */
  if (pathname === '/api/ai/test' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch (e) { return sendJson(res, 400, { ok: false, error: 'bad json: ' + e.message }); }
    return testProvider(body, res);
  }

  if (pathname === '/api/ai/models' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch (e) { return sendJson(res, 400, { ok: false, error: 'bad json: ' + e.message }); }
    return listProviderModels(body, res);
  }

  /* one minimal probe: can this model serve a plain chat request at all? */
  if (pathname === '/api/ai/check' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch (e) { return sendJson(res, 400, { ok: false, error: 'bad json: ' + e.message }); }
    return checkProviderModel(body, res);
  }

  /* the agent loop itself, streamed as server-sent events */
  if (pathname === '/api/agent/run' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch (e) { return sendJson(res, 400, { ok: false, error: 'bad json: ' + e.message }); }
    return agentRun(body, res);
  }

  /* ---- attachments ---- */

  if (pathname === '/api/agent/attach' && req.method === 'POST') {
    let body;
    // base64 of the 8 MB ceiling is ~11 MB, so allow headroom and let
    // ai/attachments.js answer with the real reason instead of a reset socket
    try { body = JSON.parse(await readBody(req, 16 * 1024 * 1024) || '{}'); }
    catch (e) {
      const tooBig = /too large/i.test(e.message);
      return sendJson(res, tooBig ? 413 : 400, { ok: false, error: tooBig ? 'file is too large' : 'bad json: ' + e.message });
    }
    try {
      const attachment = aiAttachments.put(body.name, body.data);
      return sendJson(res, 200, { ok: true, attachment });
    } catch (e) {
      // a file we cannot really read is refused, never quietly stored
      return sendJson(res, 400, { ok: false, error: e.message, name: body.name || '' });
    }
  }

  if (pathname === '/api/agent/attach' && req.method === 'DELETE') {
    const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
    try { return sendJson(res, 200, { ok: true, ...aiAttachments.remove(id) }); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }

  /* ---- stop a run in flight ---- */

  /* A page that was refreshed mid-run asks here what happened, and gets the
     events it missed. It never starts a second run. */
  if (pathname === '/api/agent/run' && req.method === 'GET') {
    return agentRunStatus(req, res);
  }

  /* ---- automation engines: what Settings shows, and what it can change ---- */

  if (pathname === '/api/automation/engines' && req.method === 'GET') {
    if (req.url && req.url.indexOf('probe=1') !== -1) {
      // the availability check: what is really here, not what is claimed
      try { await automation.probeAll(automationEndpoints(aiStore.activeProfile())); }
      catch (e) { logErr('automation probe failed:', e.message); }
    }
    return sendJson(res, 200, Object.assign({ ok: true }, automation.describe()));
  }

  if (pathname === '/api/automation/engine' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch (e) { return sendJson(res, 400, { ok: false, error: 'bad json: ' + e.message }); }
    if (body.engine) {
      const r = aiAutomation.state.setEngine(String(body.engine));
      if (!r.ok) return sendJson(res, 400, { ok: false, error: r.error });
    }
    if (body.id) {
      const r = aiAutomation.state.setEnabled(String(body.id), body.enabled === true);
      if (!r.ok) return sendJson(res, 400, { ok: false, error: r.error });
    }
    // Turning an engine on or off is a change of intent, not a change of
    // machine, so the next action re-probes rather than trusting the answer
    // that was established before the toggle.
    automation.invalidate();
    return sendJson(res, 200, Object.assign({ ok: true }, automation.describe()));
  }

  if (pathname === '/api/agent/cancel' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch (e) { return sendJson(res, 400, { ok: false, error: 'bad json: ' + e.message }); }
    const id = String(body.runId || '');
    // recorded, not just signalled: a page that reattaches has to see it stopped
    const run = agentRuns.cancel(id);
    if (!run) return sendJson(res, 200, { ok: false, error: 'that run has already finished' });
    return sendJson(res, 200, { ok: true, runId: id, stopped: true });
  }

  if (pathname === '/api/agent/forget' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch (e) { return sendJson(res, 400, { ok: false, error: 'bad json: ' + e.message }); }
    const sessionId = String(body.sessionId || '').slice(0, 64);
    if (!sessionId) return sendJson(res, 400, { ok: false, error: 'sessionId required' });
    /* The dashboard keeps conversations in the browser and deletes them there.
       This is the other half: a run holds its emitted events for two minutes so
       a refresh can replay them, and a conversation the person has removed
       should not stay resident here waiting out that timer. A run that is
       still going is not forgotten — the person can delete the record of a
       conversation, but stopping the work in it is what /api/agent/cancel is
       for, and doing it here would make a delete button silently kill a turn. */
    const { dropped, keptRunning } = agentRuns.forgetSession(sessionId);
    return sendJson(res, 200, { ok: true, sessionId, dropped, keptRunning });
  }

  /* ---- per-agent documents: SOUL.md / MEMORY.md, skills, context ---- */

  if (pathname === '/api/agents/skills' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, skills: aiSkills.CATALOG });
  }

  if (pathname === '/api/agents/export' && req.method === 'GET') {
    const id = new URL(req.url, 'http://x').searchParams.get('profileId') || '';
    try { return sendJson(res, 200, { ok: true, bundle: aiStore.exportProfile(id) }); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }

  if (pathname === '/api/agents/import' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch (e) { return sendJson(res, 400, { ok: false, error: 'bad json: ' + e.message }); }
    try { return sendJson(res, 200, { ok: true, ...aiStore.importProfile(body.bundle || body, { name: body.name }) }); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }

  const docPath = /^\/api\/agents\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/(documents|context)$/.exec(pathname);
  if (docPath) {
    const [, agentId, kind] = docPath;
    if (!aiStore.getProfile(agentId)) return sendJson(res, 404, { ok: false, error: 'no such agent: ' + agentId });

    if (kind === 'documents' && req.method === 'GET') {
      try { return sendJson(res, 200, { ok: true, agentId, ...agentFiles.read(agentId) }); }
      catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }
    if (kind === 'documents' && req.method === 'PUT') {
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); }
      catch (e) { return sendJson(res, 400, { ok: false, error: 'bad json: ' + e.message }); }
      try { return sendJson(res, 200, { ok: true, agentId, ...agentFiles.write(agentId, body) }); }
      catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }
    if (kind === 'documents' && req.method === 'DELETE') {
      try { return sendJson(res, 200, { ok: true, agentId, ...agentFiles.reset(agentId, 'all') }); }
      catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }
    if (kind === 'context' && req.method === 'GET') {
      try {
        const profile = aiStore.getProfile(agentId);
        const prepared = await aiEngine.prepareContext({ profile, controller: agentController(profile) });
        return sendJson(res, 200, {
          ok: true,
          agentId,
          profile: profile.name,
          system: prepared.context.system,
          sections: prepared.context.sections,
          chars: prepared.context.chars,
          tools: prepared.toolSchemas.map(t => t.name),
          skills: prepared.skillInfo,
        });
      } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }
  }

  const docReset = /^\/api\/agents\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/documents\/reset$/.exec(pathname);
  if (docReset && req.method === 'POST') {
    const [, agentId] = docReset;
    if (!aiStore.getProfile(agentId)) return sendJson(res, 404, { ok: false, error: 'no such agent: ' + agentId });
    let which = 'all';
    try {
      const parsed = JSON.parse(await readBody(req) || '{}');
      if (parsed && parsed.which) which = String(parsed.which);
    } catch { /* body optional */ }
    try { return sendJson(res, 200, { ok: true, agentId, ...agentFiles.reset(agentId, which) }); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }

  return sendJson(res, 404, { error: 'not found: ' + pathname });
}

/* ---------------------------------------------------------------------- *
 *  AI endpoints
 * ---------------------------------------------------------------------- */

/** resolve a provider from a stored id or from an unsaved draft */
function resolveProviderArg(arg) {
  const a = arg && typeof arg === 'object' ? arg : {};
  const draft = a.provider && typeof a.provider === 'object' ? a.provider : null;
  const id = String((draft && draft.id) || a.providerId || '');
  const stored = id ? aiStore.getProvider(id) : null;
  if (!draft) return stored;
  if (!stored) return { ...draft };
  // a draft that only names a stored provider inherits its address and its
  // secret, so "change model" works without the user retyping a key. The
  // key is only ever used here, to build the client; it is never returned.
  return {
    ...stored,
    ...draft,
    apiKey: String(draft.apiKey || '').trim() ? draft.apiKey : stored.apiKey,
    baseUrl: String(draft.baseUrl || '').trim() || stored.baseUrl,
  };
}

async function testProvider(arg, res) {
  const cfg = resolveProviderArg(arg);
  if (!cfg) return sendJson(res, 400, { ok: false, error: 'nothing to test — fill in the endpoint first' });
  if (!String(cfg.baseUrl || '').trim()) {
    return sendJson(res, 400, { ok: false, error: 'an API endpoint is required', errorType: 'invalid_config' });
  }
  if (!String(cfg.model || '').trim()) {
    return sendJson(res, 400, { ok: false, error: 'a model name is required', errorType: 'invalid_config' });
  }
  const t0 = Date.now();
  try {
    const client = aiProviders.create({ ...cfg, params: { ...(cfg.params || {}), timeoutMs: 30000 } });
    const out = await client.chat({
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 1,
    });
    return sendJson(res, 200, {
      ok: true,
      model: out.model || cfg.model,
      latencyMs: Date.now() - t0,
      protocol: client.protocol,
      endpoint: client.baseUrl,
    });
  } catch (e) {
    logErr('ai test failed:', aiProviders.scrub(e.message, cfg.apiKey));
    return sendJson(res, 200, {
      ok: false,
      error: aiProviders.scrub(e.message, cfg.apiKey),
      errorType: e.errorType || 'unknown',
      status: e.status || null,
      latencyMs: Date.now() - t0,
    });
  }
}

async function listProviderModels(arg, res) {
  const cfg = resolveProviderArg(arg);
  if (!cfg) return sendJson(res, 400, { ok: false, error: 'no provider to list models for' });
  try {
    const client = aiProviders.create({ ...cfg, params: { ...(cfg.params || {}), timeoutMs: 20000 } });
    // providers that publish per-model records get them passed through, so the
    // picker can show tools support, context size and modalities for free. One
    // request either way: the ids come out of the detailed list.
    if (typeof client.listModelsDetailed === 'function') {
      const details = await client.listModelsDetailed();
      // what the catalogue alone can tell us, decided in one place
      for (const d of details) d.compat = aiCompat.catalogue(d);
      return sendJson(res, 200, { ok: true, models: details.map(d => d.id), details });
    }
    return sendJson(res, 200, { ok: true, models: await client.listModels() });
  } catch (e) {
    return sendJson(res, 200, { ok: false, error: aiProviders.scrub(e.message, cfg.apiKey), errorType: e.errorType || 'unknown' });
  }
}

/**
 * Is this model usable through our chat path?
 *
 * The catalogue cannot answer that: some models are gated behind a harness, an
 * affiliate link or an app registration and reject a good key with a 403 that
 * says nothing in the catalogue. So we ask, once, with the smallest possible
 * request: one word in, one token out, no tools, no browser, no terminal, no
 * user data, and a short timeout. The key never leaves this process.
 */
async function checkProviderModel(arg, res) {
  const cfg = resolveProviderArg(arg);
  if (!cfg) return sendJson(res, 400, { ok: false, verdict: aiCompat.VERDICT.UNKNOWN, reason: 'no service to check' });
  const model = String((arg && arg.model) || '').trim();
  if (!model) return sendJson(res, 400, { ok: false, verdict: aiCompat.VERDICT.UNKNOWN, reason: 'no model given' });
  const draft = Object.assign({}, cfg, { model, params: Object.assign({}, cfg.params || {}, { timeoutMs: 15000 }) });
  const t0 = Date.now();
  try {
    const client = aiProviders.create(draft);
    try {
      // one word in, a small budget out: enough room for a reply, no tools
      await client.chat({ messages: [{ role: 'user', content: 'Reply with the single word: ok' }], maxTokens: 12 });
    } catch (inner) {
      const v = aiCompat.classify(inner, {
        status: inner.status, errorType: inner.errorType, detail: inner.body, message: inner.message,
      });
      return sendJson(res, 200, {
        ok: false, verdict: v.verdict, reason: aiCompat.describe(v.verdict, v.reason),
        blocked: aiCompat.blocksUse(v.verdict),
        status: inner.status || 0, errorType: inner.errorType || 'unknown',
        latencyMs: Date.now() - t0, model,
      });
    }
    // a served response is a served response, whatever the model chose to say
    return sendJson(res, 200, {
      ok: true, verdict: aiCompat.VERDICT.OK, reason: "The service accepted a chat request for this model.",
      blocked: false, latencyMs: Date.now() - t0, model,
    });
  } catch (e) {
    const v = aiCompat.classify(e, { status: e.status, errorType: e.errorType, detail: e.body, message: e.message });
    return sendJson(res, 200, {
      ok: false, verdict: v.verdict, reason: aiCompat.describe(v.verdict, v.reason),
      blocked: aiCompat.blocksUse(v.verdict), latencyMs: Date.now() - t0, model,
    });
  }
}

/** What the agent engine is allowed to touch: CDP actions, a status snapshot
 *  and one shell call. The profile's browser policy is enforced right here, so
 *  an allow/deny list applies to the agent and not to the person clicking
 *  around in the dashboard. */
/**
 * The automation router, built from the pieces that were already here.
 *
 * `driver` is the existing CDP path, so no engine can reach Chrome any other
 * way. `context` is browserContext(), the one reader, so every engine acts on
 * the target the preview is showing. `endpoints` is private to this process:
 * it is how an engine that can attach to a running browser is told where that
 * browser already is, and it reaches no response, event, or log.
 */
const automation = aiAutomation.createRouter({
  driver: {
    action: body => doAction(body),
    tabs: arg => doTabs(arg),
  },
  context: () => browserContext(),
});

function automationEndpoints(profile) {
  return { endpoints: cdpEndpoint ? { cdpWs: cdpEndpoint } : {}, profile, resolveProvider: id => aiStore.getProvider(id) };
}

function agentController(profile, emit) {
  const policy = aiStore.normBrowser(profile && profile.browser);
  const guardUrl = (url) => {
    const v = aiStore.browserAllows(policy, url);
    if (!v.ok) throw new Error(v.reason);
    return v;
  };
  return {
    browser: {
      /**
       * The same call the agent always made. It now passes through the
       * automation router first, which decides which engine carries it out and
       * reports the step on the run's own event stream. The browser policy is
       * still checked here, before any engine sees the request.
       */
      action: async (body) => {
        if (body && body.action === 'navigate' && body.url) guardUrl(body.url);
        const out = await automation.route(body || {}, {
          emit: typeof emit === 'function' ? emit : () => {},
          ...automationEndpoints(profile),
        });
        if (out && out.ok === false) throw new Error(out.error);
        // the unwrapped result, exactly as the tools have always received it
        return out && Object.prototype.hasOwnProperty.call(out, 'result') ? out.result : out;
      },
      tabs: (a) => {
        if (a && a.action === 'new' && a.url) guardUrl(a.url);
        return doTabs(a);
      },
      /**
       * Only the fields that belong in a prompt. The agent learns which tab it
       * is on and whether the browser is there at all; it never learns the CDP
       * websocket, cookies, headers or anything else about the connection.
       */
      runtime: async () => {
        const ctx = browserContext();
        const active = ctx.tabs.find(t => t.id === ctx.agentTabId) || null;
        return {
          connected: ctx.connected,
          session: ctx.session,
          /* the agent's own identity, which is what every tool takes */
          tabId: ctx.agentTabId,
          generation: ctx.generation,
          focusedTabId: ctx.focusedTabId,
          activeTab: active ? { title: active.title, url: active.url } : null,
          url: ctx.url,
          title: ctx.title,
          tabs: ctx.tabs.map(t => ({
            id: t.id,
            url: t.url,
            title: t.title,
            active: t.id === ctx.agentTabId,
          })),
        };
      },
    },
    shell: { exec: (command, timeoutMs) => shellExec(command, timeoutMs) },
  };
}

/**
 * Run one command for the agent and hand back what a shell would have reported.
 *
 * This was spawnSync, which held the whole process for as long as the command
 * ran — up to two minutes. Everything sharing this event loop went quiet while
 * it did: the screencast preview froze, the terminal panel stopped, the tab list
 * stopped, and any HTTP request simply hung. One tool call could stop the
 * application responding while the agent worked. spawn hands the same work to
 * the OS and the loop keeps turning, so the person watching sees it happen.
 *
 * The cap is applied per stream as the bytes arrive rather than through
 * maxBuffer, because a child that keeps writing past the cap is still a live
 * process that has to be waited on. What gets dropped is the tail of the
 * output; the exit code is never affected by how much the command printed.
 */
const SHELL_OUT_CAP = 8 * 1024 * 1024;

function killProcessTree(child) {
  if (!child || !child.pid) return;
  try {
    if (IS_WINDOWS) {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); }
      catch { process.kill(child.pid, 'SIGTERM'); }
    }
  } catch { try { child.kill(); } catch { /* already gone */ } }
}

function shellExec(command, timeoutMs) {
  const cmd = String(command || '').trim();
  if (!cmd) throw new Error('command required');
  const ms = clamp(Number(timeoutMs) || 20000, 1000, 120000);
  const t0 = Date.now();

  // One argument, handed to the shell this machine actually has. A hardcoded
  // cmd.exe is not portability, it is an ENOENT on every other platform.
  const win = IS_WINDOWS;
  const file = SHELL_FILE;
  const args = win ? ['/d', '/s', '/c', cmd] : ['-c', cmd];

  return new Promise((resolve) => {
    const out = [], err = [];
    const outKept = { n: 0 }, outSeen = { n: 0 };
    const errKept = { n: 0 }, errSeen = { n: 0 };
    let settled = false, timedOut = false;

    const answer = (exitCode, spawnError) => {
      const durationMs = Date.now() - t0;
      const stdout = decodeSmart(Buffer.concat(out));
      const stderr = decodeSmart(Buffer.concat(err));
      const truncated = outKept.n < outSeen.n || errKept.n < errSeen.n;
      log(`shell_exec: ${cmd} -> exit ${exitCode} in ${durationMs}ms` + (truncated ? ' (output truncated)' : ''));
      resolve({
        command: cmd,
        exitCode: exitCode === undefined ? null : exitCode,
        timedOut,
        truncated,
        durationMs,
        stdout: stdout.slice(0, 8000),
        stderr: stderr.slice(0, 4000),
        output: (stdout + stderr).trim().slice(0, 8000),
        error: spawnError || null,
      });
    };

    let child;
    try {
      child = spawn(file, args, { cwd: ROOT, windowsHide: true });
    } catch (e) {
      answer(null, `could not start ${file}: ${String((e && e.message) || e)}`);
      return;
    }

    const pump = (list, chunk, kept, seen) => {
      const room = SHELL_OUT_CAP - kept.n;
      if (room > 0) {
        const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
        list.push(slice);
        kept.n += slice.length;
      }
      seen.n += chunk.length;
    };
    // a spawn that fails asynchronously can hand back null streams
    if (child.stdout) child.stdout.on('data', c => pump(out, c, outKept, outSeen));
    if (child.stderr) child.stderr.on('data', c => pump(err, c, errKept, errSeen));

    /* A timeout has to take down the tree, not just the shell. `cmd /c npm run
       leaves grandchildren holding the same pipes, and the close event waits
       for the last writer — so killing only the child would let the promise
       outlive its own deadline. */
    const killer = setTimeout(() => {
      timedOut = true;
      if (win) killProcessTree(child);
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone already */ } } }
    }, ms);
    if (typeof killer.unref === 'function') killer.unref();

    const settle = (code, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      answer(code, spawnError);
    };
    child.on('error', e => settle(null, String((e && e.message) || e)));
    child.on('close', code => settle(code));
  });
}

/** in-flight agent runs, so the UI can genuinely stop one. See ai/runs.js —
 *  the registry also holds the lock that keeps a run to one at a time. */

'use strict';
/* ========================================================================= *
 *  A run you can come back to.
 *
 *  The engine already emits real events and the page already renders them, but
 *  they only existed for the length of one fetch: refresh the tab mid-run and
 *  the activity was gone, even though the run was still going on the server.
 *
 *  agentRuns already kept every run for cancel. So the run record now also
 *  keeps the events it emitted, and a page that comes back asks for them by
 *  runId instead of starting a second run. The registry is the same one; no
 *  second system, no polling, no new stream.
 * ========================================================================= */

async function agentRunStatus(req, res) {
  const runId = String(new URL(req.url, 'http://x').searchParams.get('runId') || '').slice(0, 64);
  const view = agentRuns.view(runId);
  if (!view) {
    // not in the registry: either it never existed, or it finished long ago
    return sendJson(res, 200, { ok: true, runId, known: false, running: false, events: [] });
  }
  return sendJson(res, 200, { ok: true, known: true, ...view });
}

async function agentRun(body, res) {
  const { profile, provider, model } = aiStore.resolveProfile(body.profileId);
  if (!profile) {
    return sendJson(res, 400, { ok: false, error: 'no agent profile yet — create one in Settings' });
  }
  if (!provider) {
    return sendJson(res, 400, { ok: false, error: `agent "${profile.name}" has no provider — fix it in Settings` });
  }
  if (!model) {
    return sendJson(res, 400, { ok: false, error: `provider "${provider.name}" has no model — set one in Settings` });
  }
  const text = String(body.text || '').trim();
  const attachmentIds = Array.isArray(body.attachments) ? body.attachments.filter(x => typeof x === 'string') : [];
  if (!text && !attachmentIds.length) return sendJson(res, 400, { ok: false, error: 'empty message' });

  const runId = String(body.runId || '').slice(0, 64) || ('run_' + Date.now().toString(36));
  // the session is the conversation; the run is one turn inside it
  const sessionId = String(body.sessionId || '').slice(0, 64) || null;

  /* One turn at a time. Claimed only after everything above has been checked,
     so a request that is merely misconfigured is still told what is wrong with
     it rather than being told it is busy. See ai/runs.js for what a second
     concurrent run would actually do to the browser. */
  const claim = agentRuns.claim(runId, sessionId);
  if (!claim.ok) {
    return sendJson(res, 409, {
      ok: false,
      error: 'an agent run is already in progress — stop it first',
      busy: true,
      runId: claim.live.runId,
      runningSince: claim.live.startedAt,
    });
  }
  const run = claim.run;

  // inbox files are scratch space, not storage
  try { aiAttachments.sweep(); } catch { /* best effort */ }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = ev => {
    // one funnel, so what a reattaching page replays is exactly what the first
    // page saw: the same events, in the same order, from the same run
    agentRuns.record(run, ev);
    if (!res.writableEnded) res.write('data: ' + JSON.stringify(ev) + '\n\n');
  };
  send({ type: 'run', runId, sessionId });

  const started = Date.now();
  try {
    const client = aiProviders.create({ ...provider, model });
    const out = await aiEngine.runAgent({
      provider: client,
      profile,
      text,
      history: body.history,
      attachments: attachmentIds,
      shouldStop: () => run.stopped,
      controller: agentController(profile, send),
      onEvent: send,
    });
    send({ type: 'final', ok: out.ok, rounds: out.rounds, text: out.text, stopped: !!out.stopped, ms: Date.now() - started });
  } catch (e) {
    logErr('agent run failed:', aiProviders.scrub(e.message, provider.apiKey));
    send({
      type: 'error',
      message: aiProviders.scrub(e.message, provider.apiKey),
      errorType: e.errorType || 'unknown',
      status: e.status || null,
      // same distinction as the engine's own provider failure: a spent
      // allowance and a busy service need different advice from the page
      rateScope: e.rateScope || null,
      retryable: e.retryable === true,
      gated: e.gated === true,
      model,
    });
  } finally {
    /* Releasing the lock. This is the only place it happens, and it is a
       finally rather than a line at the end of the happy path: a run that
       threw its way out without clearing the flag would keep the browser to
       itself until the server was restarted, and the symptom — every later
       turn answered "an agent run is already in progress" — names nothing
       that is actually running. */
    agentRuns.finish(run);
  }
  res.end();
}

/** keep old clients working: same envelope, same openai-shaped `data`.
 *  An explicit endpoint still wins; otherwise the active profile is used. */
async function proxyChat(cfg, res) {
  if (!Array.isArray(cfg.messages)) return sendJson(res, 400, { ok: false, error: 'messages must be an array' });

  const legacy = String(cfg.endpoint || '').trim();
  let providerCfg;
  if (legacy) {
    providerCfg = {
      protocol: 'openai-compatible',
      baseUrl: legacy,
      apiKey: String(cfg.apiKey || ''),
      model: String(cfg.model || 'gpt-4o-mini'),
      headers: {},
      params: {
        temperature: (cfg.temperature === undefined || cfg.temperature === null) ? null : Number(cfg.temperature),
        maxTokens: cfg.maxTokens ? Number(cfg.maxTokens) : null,
        topP: null,
        timeoutMs: 180000,
      },
    };
  } else {
    const r = aiStore.resolveProfile(cfg.profileId);
    if (!r.provider) return sendJson(res, 400, { ok: false, error: 'no provider configured — set one up in Settings' });
    providerCfg = { ...r.provider, model: cfg.model || r.model };
  }

  const t0 = Date.now();
  try {
    const client = aiProviders.create(providerCfg);
    const out = await client.chat({ messages: cfg.messages, tools: cfg.tools });
    log(`ai ${client.protocol} ${out.model} in ${Date.now() - t0}ms -> ${client.baseUrl}`);
    return sendJson(res, 200, { ok: true, status: 200, ms: Date.now() - t0, data: out.raw || openAiShape(out) });
  } catch (e) {
    const msg = aiProviders.scrub(e.message, providerCfg.apiKey);
    logErr('ai request failed:', msg, '->', providerCfg.baseUrl);
    return sendJson(res, 200, {
      ok: false, status: e.status || 502, ms: Date.now() - t0, error: msg,
      data: { error: { message: msg } },
    });
  }
}

function openAiShape(out) {
  return {
    id: 'chatcmpl-' + Date.now(),
    object: 'chat.completion',
    model: out.model,
    choices: [{
      index: 0,
      finish_reason: out.finishReason || 'stop',
      message: {
        role: 'assistant',
        content: out.text,
        ...(out.toolCalls && out.toolCalls.length
          ? { tool_calls: out.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })) }
          : {}),
      },
    }],
    usage: out.usage || null,
  };
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/dashboard.html' : pathname;
  const file = path.normalize(path.join(ROOT, rel));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
  // never serve the config file (it holds API keys) or the server modules
  const inside = (name) => file.startsWith(path.join(ROOT, name) + path.sep);
  if (inside('data') || inside('ai') || file === aiStore.FILE) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404 — dashboard not found');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname); }
  catch { res.writeHead(400); return res.end('bad url'); }

  if (pathname.startsWith('/api/')) return void handleApi(req, res, pathname).catch(e => sendJson(res, 500, { error: e.message }));
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, pathname);
});

/* ====================================================================== *
 *  Shell — a real interactive shell over WS /api/shell                    *
 * ====================================================================== */

/** Windows cmd.exe speaks an OEM code page; POSIX shells use UTF-8. */
function detectCodePage() {
  if (!IS_WINDOWS) return 65001;
  try {
    const out = String(execFileSync('cmd.exe', ['/c', 'chcp'], { encoding: 'utf8', windowsHide: true }));
    const m = out.match(/\d{2,5}/g);
    const cp = m ? Number(m[m.length - 1]) : 0;
    return cp > 0 ? cp : 437;
  } catch { return 437; }
}
const CODE_PAGE = detectCodePage();

/* CP437 high half 0x80..0xFF as unicode code points, 16 per row */
const CP437_HEX = [
  '00C700FC00E900E200E400E000E500E700EA00EB00E800EF00EE00EC00C400C5', // 80
  '00C900E600C600F400F600F200FB00F900FF00D600DC00A200A300A520A70192', // 90
  '00E100ED00F300FA00F100D100AA00BA00BF231000AC00BD00BC00A100AB00BB', // A0
  '259125922593250225242561256225562555256325512557255D255C255B2510', // B0
  '25142534252C251C2500253C255E255F255A25542569256625602550256C2567', // C0
  '2568256425652559255825522553256B256A2518250C25882584258C25902580', // D0
  '03B100DF039303C003A303C300B503C403A6039803A903B4221E03C603B52229', // E0
  '226100B1226522642320232100F7224800B0221900B7221A207F00B225A000A0', // F0
].join('');

const CP437_DEC = (() => {
  const t = new Array(128);
  for (let i = 0; i < 128; i++) t[i] = String.fromCharCode(parseInt(CP437_HEX.slice(i * 4, i * 4 + 4), 16));
  return t;
})();
const CP437_ENC = (() => {
  const m = new Map();
  for (let i = 0; i < 128; i++) m.set(CP437_DEC[i].codePointAt(0), i + 128);
  return m;
})();

function decodeOem(buf) {
  let s = '';
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    s += b < 128 ? String.fromCharCode(b) : CP437_DEC[b - 128];
  }
  return s;
}
function encodeOem(str) {
  const out = Buffer.alloc(Math.max(1, Buffer.byteLength(str, 'utf8')));
  let n = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp < 128) out[n++] = cp;
    else { const b = CP437_ENC.get(cp); out[n++] = b === undefined ? 63 : b; }
  }
  return out.subarray(0, n);
}
const codec = str => (CODE_PAGE === 65001 ? Buffer.from(str, 'utf8') : encodeOem(str));

/** modern tools (node, git) emit utf-8 while cmd itself speaks the OEM page,
 *  so prefer a strict utf-8 decode and fall back to the CP437 table. */
function decodeSmart(buf) {
  if (!buf.length) return '';
  if (CODE_PAGE === 65001) return buf.toString('utf8');
  let ascii = true;
  for (let i = 0; i < buf.length; i++) if (buf[i] > 127) { ascii = false; break; }
  if (ascii) return buf.toString('latin1');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return decodeOem(buf); }
}

/** never decode a utf-8 sequence that is split across two chunks */
function splitUtf8Tail(buf) {
  let i = buf.length - 1;
  while (i >= 0 && (buf[i] & 0xC0) === 0x80) i--;
  if (i < 0) return { head: buf, tail: Buffer.alloc(0) };
  const b = buf[i];
  if (b < 0x80) return { head: buf, tail: Buffer.alloc(0) };
  const need = b >= 0xF0 ? 4 : b >= 0xE0 ? 3 : b >= 0xC0 ? 2 : 1;
  if (buf.length - i < need) return { head: buf.subarray(0, i), tail: buf.subarray(i) };
  return { head: buf, tail: Buffer.alloc(0) };
}

const shellSessions = new Set();

/** One live shell process bound to one WS connection. Windows uses cmd's
 *  sentinel prompt; POSIX uses bash's PROMPT_COMMAND to emit the same marker.
 */
class ShellSession {
  constructor(conn, cwd) {
    this.conn = conn;
    this.cwd = cwd || ROOT;
    this.proc = null;
    this.alive = false;
    this.raw = Buffer.alloc(0);
    this.idleTimer = null;
    this.drainTimer = null;
    this.pending = [];
    this.first = true;
    this.killedBy = null;
    this.start();
  }

  /* ---------------- outgoing ---------------- */
  sendMsg(o) {
    if (this.conn.closed) return;
    if (o.type !== 'stream') this.drain();
    this.conn.send(o);
  }
  emit(ev) {
    this.pending.push(ev);
    if (!this.drainTimer) this.drainTimer = setTimeout(() => this.drain(), 20);
  }
  drain() {
    if (this.drainTimer) { clearTimeout(this.drainTimer); this.drainTimer = null; }
    if (!this.pending.length) return;
    const segs = this.pending;
    this.pending = [];
    if (this.conn.closed) return;
    this.conn.send({ type: 'stream', segs });
  }

  /* ---------------- lifecycle ---------------- */
  start() {
    let cwd = this.cwd;
    try { if (!fs.existsSync(cwd)) cwd = ROOT; } catch { cwd = ROOT; }
    this.cwd = cwd;

    let proc;
    try {
      const args = IS_WINDOWS ? ['/Q', '/K', 'prompt \x01$P\x01$G'] : ['--noprofile', '--norc', '-i'];
      const env = IS_WINDOWS ? process.env : {
        ...process.env,
        PS1: '',
        PROMPT_COMMAND: 'printf "\\001%s\\001>" "$PWD"',
      };
      proc = spawn(SHELL_FILE, args, {
        cwd, detached: !IS_WINDOWS, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env,
      });
    } catch (e) {
      this.sendMsg({ type: 'fatal', error: String((e && e.message) || e) });
      return;
    }
    this.proc = proc;
    this.alive = true;
    this.raw = Buffer.alloc(0);
    this.first = true;

    proc.on('error', e => {
      this.alive = false;
      this.sendMsg({ type: 'fatal', error: 'shell could not start: ' + e.message });
    });
    proc.stdout.on('data', d => this.feed(d));
    proc.stderr.on('data', d => this.feed(d));
    proc.on('exit', (code, signal) => {
      this.alive = false;
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
      this.drain();
      if (this.killedBy) { this.killedBy = null; this.start(); return; }
      this.sendMsg({ type: 'exited', code, signal: signal || null });
    });

    this.sendMsg({ type: 'started', cwd, pid: proc.pid, shell: SHELL_NAME, cp: CODE_PAGE });
    log(`shell started (pid ${proc.pid}, cwd ${cwd}, cp ${CODE_PAGE})`);
  }

  destroy() {
    if (this.drainTimer) { clearTimeout(this.drainTimer); this.drainTimer = null; }
    const proc = this.proc;
    this.alive = false;
    this.proc = null;
    if (!proc) return;
    try {
      killProcessTree(proc);
    } catch { /* already gone */ }
  }

  /** Ctrl+C cannot interrupt a piped console, so stop the whole tree and
   *  come back in the same directory. */
  interrupt() { this.restart(); }
  restart() {
    if (!this.alive) { this.start(); return; }
    this.killedBy = 'restart';
    const proc = this.proc;
    if (!proc) { this.start(); return; }
    try {
      killProcessTree(proc);
    } catch { /* ignore */ }
  }

  command(text) {
    if (!this.alive || !this.proc || !this.proc.stdin || !this.proc.stdin.writable) {
      this.sendMsg({ type: 'error', message: 'shell is not running — press restart' });
      return;
    }
    try {
      const newline = IS_WINDOWS ? '\r\n' : '\n';
      this.proc.stdin.write(Buffer.concat([codec(String(text ?? '')), Buffer.from(newline)]));
    } catch (e) {
      this.sendMsg({ type: 'error', message: 'could not write to the shell: ' + e.message });
    }
  }

  /* ---------------- incoming bytes ---------------- */
  feed(d) {
    this.raw = this.raw.length ? Buffer.concat([this.raw, d]) : d;
    this.processRaw();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const waitsForMarker = this.raw.length > 0 && this.raw[0] === 0x01;
    this.idleTimer = setTimeout(() => this.flushIdle(), waitsForMarker ? 400 : 90);
  }

  /** split the buffer into text runs and prompt markers */
  processRaw() {
    let buf = this.raw;
    let pos = 0, scan = 0, keepFrom = -1;
    for (;;) {
      const open = buf.indexOf(0x01, scan);
      if (open === -1) break;
      const close = buf.indexOf('\x01>', open + 1);
      if (close === -1) { keepFrom = open; break; }
      if (open > pos) this.pushText(buf.subarray(pos, open));
      this.emit({ p: decodeSmart(buf.subarray(open + 1, close)) });
      pos = scan = close + 2;
    }
    if (keepFrom !== -1) {
      if (keepFrom > pos) this.pushText(buf.subarray(pos, keepFrom));
      this.raw = buf.subarray(keepFrom);
      return;
    }
    if (buf.length > pos) {
      const tail = buf.subarray(pos);
      const s = splitUtf8Tail(tail);
      if (s.head.length) this.pushText(s.head);
      this.raw = s.tail;
      return;
    }
    this.raw = buf.subarray(0, 0);
  }

  pushText(bytes) {
    if (!bytes.length) return;
    let text = decodeSmart(bytes);
    if (this.first) { text = text.replace(/^\r?\n+/, ''); this.first = false; }
    if (!text) return;
    if (/\x1b\[2J|\x1b\[3J|\x0c/.test(text)) {
      text = text.replace(/\x1b\[[23]J|\x0c/g, '');
      this.emit({ c: 1 });
      if (!text) return;
    }
    this.emit({ o: text });
  }

  flushIdle() {
    this.idleTimer = null;
    if (!this.raw.length) return;
    const buf = this.raw;
    this.raw = Buffer.alloc(0);
    this.pushText(buf);
  }
}

server.on('upgrade', (req, socket) => {
  const pathname = (req.url || '').split('?')[0];
  const isShell = pathname === '/api/shell';
  if (pathname !== '/api/browser/stream' && !isShell) { socket.destroy(); return; }
  const origin = req.headers.origin;
  if (origin && origin !== 'null' && origin !== `http://${req.headers.host}`) { socket.destroy(); return; }

  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const conn = new WSConn(socket);

  /* ---------------- shell session ---------------- */
  if (isShell) {
    const session = new ShellSession(conn, ROOT);
    shellSessions.add(session);
    conn.onmessage = text => {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.type === 'cmd') session.command(msg.text);
      else if (msg.type === 'interrupt') session.interrupt();
      else if (msg.type === 'restart') session.restart();
      else if (msg.type === 'kill') session.destroy();
      else if (msg.type === 'cwd') session.sendMsg({ type: 'cwd', cwd: session.cwd });
      else if (msg.type === 'ping') conn.send({ type: 'pong', ts: Date.now() });
    };
    conn.onclose = () => { shellSessions.delete(session); session.destroy(); };
    log(`shell ws connected (${shellSessions.size} session(s))`);
    return;
  }

  /* ---------------- screencast stream ---------------- */
  clients.add(conn);
  conn.onclose = () => { clients.delete(conn); };

  conn.onmessage = text => {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.type === 'ping') return conn.send({ type: 'pong', ts: Date.now() });
    if (msg.type === 'status') return conn.send({ type: 'status', status: statusObject() });
    if (msg.type === 'tabs') return conn.send({ type: 'tabs', tabs: tabList() });
    if (msg.type === 'frame' && STATE.lastFrame) {
      return conn.send({ type: 'frame', data: STATE.lastFrame.data, metadata: STATE.lastFrame.metadata, tabId: STATE.lastFrame.tabId, ts: STATE.lastFrameAt });
    }
  };

  conn.send({ type: 'hello', version: STATE.version, server: 'octop-browser-automation' });
  conn.send({ type: 'status', status: statusObject() });
  conn.send({ type: 'tabs', tabs: tabList() });
  if (STATE.lastFrame) {
    conn.send({ type: 'frame', data: STATE.lastFrame.data, metadata: STATE.lastFrame.metadata, tabId: STATE.lastFrame.tabId, ts: STATE.lastFrameAt });
  }

  // keep alive: Chrome tab switches / frame drops are otherwise silent
  const iv = setInterval(() => {
    if (conn.closed) return clearInterval(iv);
    conn.send({ type: 'ping', ts: Date.now() });
  }, 15000);

  log(`ws client connected (${clients.size} total)`);
});

/* ====================================================================== *
 *  boot                                                                   *
 * ====================================================================== */

/** find a free port starting at `start` so a busy default never kills boot */
function pickPort(start, tries = 40) {
  return new Promise((resolve, reject) => {
    let p = start;
    const attempt = () => {
      const probe = net.createServer();
      probe.once('error', () => {
        probe.removeAllListeners();
        p += 1;
        if (p >= start + tries) reject(new Error(`no free port in range ${start}..${start + tries}`));
        else attempt();
      });
      probe.once('listening', () => {
        const found = p;
        probe.close(() => resolve(found));
      });
      probe.listen(p, HOST);
    };
    attempt();
  });
}

function openDashboard(url) {
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') return;
  try {
    const cmd = process.platform === 'win32' ? 'cmd'
      : process.platform === 'darwin' ? 'open'
      : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url]
      : process.platform === 'darwin' ? [url]
      : [url];
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
  } catch { /* auto-open is a nicety, never fatal */ }
}

async function main() {
  // 1. bind first — fail fast before we spawn a browser
  const port = await pickPort(PORT);
  STATE.port = port;
  await new Promise((resolve, reject) => {
    const onErr = e => { server.removeListener('listening', onOk); reject(e); };
    const onOk = () => { server.removeListener('error', onErr); resolve(); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, HOST);
  });

  server.on('error', e => logErr('server runtime error:', e.message));

  // 2. bring up the AI config (env seed is a one-time, non-destructive step)
  try {
    if (aiStore.seedFromEnv(process.env)) log('seeded AI config from environment variables');
  } catch (e) {
    logErr('could not seed AI config:', e.message);
  }

  // 3. then bring up the real browser + CDP
  await ensureChrome();
  await connectCDP();

  const cfg = aiStore.publicView();
  const active = cfg.profiles.find(p => p.id === cfg.activeProfileId) || null;
  const url = `http://${HOST}:${port}`;
  log('─'.repeat(58));
  log('Octop Browser Automation');
  log('  dashboard : ' + url);
  log('  browser   : ' + (BROWSER_BIN
    ? BROWSER_BIN.path + '  [' + BROWSER_BIN.source
      + (BROWSER_BIN.version ? ' ' + BROWSER_BIN.version : '') + ']'
    : 'NONE — run: node scripts/get-browser.js'));
  log('  chrome    : ' + (STATE.version || 'unknown'));
  log('  profile   : ' + PROFILE);
  log('  shell     : WS /api/shell  (' + SHELL_NAME + ', code page ' + CODE_PAGE + ')');
  log('  config    : ' + aiStore.FILE);
  log('  providers : ' + (cfg.providers.length || 'none — add one in Settings'));
  log('  agent     : ' + (active
    ? `${active.name} → ${active.providerName || '?'} / ${active.model || 'no model'}`
    : 'none — create a profile in Settings'));
  log('─'.repeat(58));
  openDashboard(url);
}

let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`\n${sig} — shutting down`);
  for (const c of clients) { try { c.socket.destroy(); } catch { /* ignore */ } }
  clients.clear();
  for (const s of shellSessions) { try { s.destroy(); } catch { /* ignore */ } }
  shellSessions.clear();
  // a pending reconnect would otherwise relaunch Chrome on the way out
  if (cdpRetryTimer) { clearTimeout(cdpRetryTimer); cdpRetryTimer = null; }
  try { if (cdpSocket) cdpSocket.close(); } catch { /* ignore */ }
  server.close();
  killChrome();
  /* The engines that own something have to be told to let go of it, or the
     `npx` child Playwright MCP started and the browser connections Stagehand
     and browser-use opened outlive this process. That is a leak the person
     pays for in processes they never asked for, and it accumulates across
     restarts. Each engine is stopped under a timeout inside the router, so
     nothing here can wait forever — but the exit itself is still armed, in
     case an engine's own shutdown() ignores its promise. */
  const exited = new Promise(r => setTimeout(() => { r(); process.exit(0); }, 1200));
  try {
    const { stopped, failed } = await Promise.race([
      automation.shutdownAll(),
      new Promise(r => setTimeout(() => r({ stopped: [], failed: [{ id: '(timed out)', error: 'engines did not stop in time' }] }), 900)),
    ]);
    if (stopped.length) log('engines stopped: ' + stopped.join(', '));
    for (const f of failed) logErr('engine ' + f.id + ' did not stop cleanly: ' + f.error);
  } catch (e) {
    logErr('engine shutdown:', e.message);
  }
  await exited;
}
process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('uncaughtException', e => logErr('uncaught:', e.stack || e));
process.on('unhandledRejection', e => logErr('unhandled:', e && (e.stack || e.message || e)));

main().catch(e => {
  logErr('fatal:', e.message);
  killChrome();
  process.exit(1);
});
