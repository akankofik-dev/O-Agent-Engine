'use strict';
/* ========================================================================= *
 *  BrowserSession — the owner of browser identity.
 *
 *  Before this, the agent had no browser identity at all. It inherited
 *  STATE.activeTargetId, a single global slot, and that slot was rewritten
 *  whenever the *person* clicked a different Chrome tab. So the agent was
 *  driving whichever tab the human happened to be looking at.
 *
 *  Now the session owns the mapping and separates the two questions that were
 *  conflated:
 *
 *      agentTabId     the tab the agent drives. Only the agent changes it.
 *      focusedTabId   the tab the human is looking at. UI state only. It can
 *                     differ from agentTabId, and nothing follows from it.
 *
 *  The identifier the agent sees is a tabId — `tab_<uuid>`, minted here, and
 *  meaningless outside. The CDP targetId never leaves this file's owner: the
 *  tools, the events and the preview all speak tabId, and the translation to a
 *  real page happens in exactly one place, resolve().
 *
 *  Nothing here launches or finds a browser. The session is handed targets by
 *  the host as CDP reports them, and it can only resolve what it was given.
 * ========================================================================= */

const crypto = require('crypto');

/** the shape the agent and the UI see. CDP knows nothing about it. */
function newTabId() {
  return 'tab_' + crypto.randomUUID();
}

function createSession(opts = {}) {
  const emit = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  /** tabId -> tab */
  const tabs = new Map();
  /** targetId -> tabId, the only place a CDP id is ever looked up */
  const byTarget = new Map();

  const session = {
    id: opts.sessionId || 'browser-1',
    tabs,
    byTarget,
    agentTabId: null,
    focusedTabId: null,
  };

  /* ----------------------------- identity ------------------------------ */

  /**
   * The tab for a CDP target, minted on first sight. A target that comes back
   * after a detach gets the same tabId again, so an agent holding a tabId keeps
   * working across a reattach instead of silently losing its page.
   */
  function adopt(targetId, info = {}) {
    if (!targetId) return null;
    let tabId = byTarget.get(targetId);
    if (!tabId) {
      tabId = newTabId();
      tabs.set(tabId, {
        tabId,
        targetId,
        url: info.url || '',
        title: info.title || '',
        loading: false,
        generation: 0,
        canGoBack: false,
        canGoForward: false,
        createdAt: now(),
        lastUsedAt: now(),
      });
      byTarget.set(targetId, tabId);
      emit({ event: 'tab.created', tabId, url: info.url || '', title: info.title || '' });
      return tabs.get(tabId);
    }
    const tab = tabs.get(tabId);
    if (info.url !== undefined && info.url !== tab.url) {
      tab.url = info.url;
      // a page that changed address is a new page: its element handles died
      bump(tabId, 'navigated');
    }
    if (info.title !== undefined) tab.title = info.title;
    return tab;
  }

  /** a target is gone; the tab goes with it, whatever the agent was doing */
  function forget(targetId, reason) {
    const tabId = byTarget.get(targetId);
    if (!tabId) return null;
    byTarget.delete(targetId);
    const tab = tabs.get(tabId);
    tabs.delete(tabId);
    emit({ event: 'tab.closed', tabId, reason: reason || 'closed' });
    if (session.agentTabId === tabId) {
      // deliberately NOT re-derived from focus: the agent must choose again
      session.agentTabId = null;
      emit({ event: 'tab.unassigned', tabId, reason: 'the tab the agent was driving is gone' });
    }
    if (session.focusedTabId === tabId) session.focusedTabId = null;
    return tab;
  }

  /**
   * Resolve what the caller named into a real page.
   *
   * Accepts a tabId. It does NOT fall back to the focused tab, because the
   * focused tab is the human's business; and it does not guess a target.
   */
  function resolve(tabId) {
    if (!tabId) return null;
    const tab = tabs.get(String(tabId));
    if (!tab) return null;
    if (!byTarget.has(tab.targetId)) return null;
    tab.lastUsedAt = now();
    return tab;
  }

  /** the tab for a CDP target, or null */
  function byTargetId(targetId) {
    const tabId = byTarget.get(targetId);
    return tabId ? tabs.get(tabId) : null;
  }

  /* ---------------------------- the agent's tab ------------------------ */

  /**
   * Point the agent at a tab. The only thing that may do this, apart from the
   * agent opening or activating a tab itself.
   */
  function setAgentTab(tabId, why) {
    if (tabId && !tabs.has(tabId)) return null;
    if (session.agentTabId === tabId) return tabs.get(tabId) || null;
    const previous = session.agentTabId;
    session.agentTabId = tabId || null;
    emit({ event: 'tab.activated', tabId: tabId || null, previousTabId: previous || null, reason: why || 'agent' });
    return tabId ? tabs.get(tabId) : null;
  }

  /**
   * Note which tab the human is looking at. UI state, and that is all: it
   * deliberately does not touch agentTabId, so a person clicking another tab
   * cannot move the agent.
   */
  function setFocusedTab(tabId) {
    if (tabId && !tabs.has(tabId)) return null;
    if (session.focusedTabId === tabId) return null;
    const previous = session.focusedTabId;
    session.focusedTabId = tabId || null;
    emit({ event: 'tab.focused', tabId: tabId || null, previousTabId: previous || null });
    return session.focusedTabId;
  }

  function agentTab() {
    return session.agentTabId ? tabs.get(session.agentTabId) || null : null;
  }
  function agentTarget() {
    const t = agentTab();
    return t ? t.targetId : null;
  }
  function isAgentTarget(targetId) {
    return !!targetId && agentTarget() === targetId;
  }

  /* --------------------------- page lifecycle -------------------------- */

  /**
   * A page moved on, so everything the agent remembered about the old document
   * is gone. Generation is what a stale element handle is checked against.
   */
  function bump(tabId, why) {
    const tab = tabs.get(tabId);
    if (!tab) return null;
    tab.generation += 1;
    emit({ event: 'tab.navigated', tabId, url: tab.url, title: tab.title, generation: tab.generation, reason: why || 'navigated' });
    return tab;
  }

  function update(tabId, patch) {
    const tab = tabs.get(tabId);
    if (!tab) return null;
    if (patch && patch.url !== undefined && patch.url !== tab.url) {
      tab.url = patch.url;
      tab.generation += 1;
    }
    if (patch) for (const k of ['title', 'loading', 'canGoBack', 'canGoForward']) {
      if (patch[k] !== undefined) tab[k] = patch[k];
    }
    return tab;
  }

  /* ------------------------------- listing ----------------------------- */

  /** exactly what the agent and the tab bar are shown; no targetId anywhere */
  function list() {
    return [...tabs.values()]
      .filter(t => !/^(devtools:|chrome-devtools:|edge:)/.test(t.url || ''))
      .map(t => ({
        id: t.tabId,
        url: t.url,
        title: t.title || t.url || 'New tab',
        loading: !!t.loading,
        canGoBack: !!t.canGoBack,
        canGoForward: !!t.canGoForward,
        generation: t.generation,
        agent: t.tabId === session.agentTabId,
        focused: t.tabId === session.focusedTabId,
      }));
  }

  function drop() {
    tabs.clear();
    byTarget.clear();
    session.agentTabId = null;
    session.focusedTabId = null;
  }

  return Object.assign(session, {
    adopt, forget, resolve, byTargetId,
    setAgentTab, setFocusedTab, agentTab, agentTarget, isAgentTarget,
    bump, update, list, drop, newTabId,
  });
}

module.exports = { createSession, newTabId };
