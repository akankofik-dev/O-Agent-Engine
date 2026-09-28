'use strict';
/* ========================================================================= *
 *  The one BrowserContext, and the one question about it.
 *
 *  browserContext() in server.js is the only source of this object, and its
 *  shape is fixed: { connected, tabId, agentTabId, focusedTabId, hasSession,
 *  generation, url, title, tabs, session }. It has no CDP targetId — that stays
 *  inside the session — so no engine can reach past the tab it is given.
 *
 *  Every engine asks this instead of deciding for itself what "am I connected"
 *  means, so an engine can never answer it wrongly.
 * ========================================================================= */

/**
 * The tab the agent is driving, or null when there is none.
 *
 * agentTabId, deliberately, and not focusedTabId: where the person is looking
 * is not an engine's business, and an engine that could read it would be an
 * engine that could aim itself at the wrong page.
 */
function contextTab(ctx) {
  if (!ctx) return null;
  return ctx.agentTabId || null;
}

/**
 * True only when there is a real target to act on. With no target the answer
 * is no — never "let me go and find a browser".
 */
function hasContext(ctx) {
  const t = contextTab(ctx);
  return !!(t && ctx.connected !== false);
}

/** the refusal every engine gives, in the same words */
function noContextError() {
  const e = new Error('This chat has no browser tab to act on. Open one with browser_tabs action "new" first.');
  e.code = 'no-context';
  return e;
}

/** act on a context, or refuse in the same way every time */
function requireContext(ctx) {
  if (!hasContext(ctx)) throw noContextError();
  return contextTab(ctx);
}

module.exports = { contextTab, hasContext, noContextError, requireContext };
