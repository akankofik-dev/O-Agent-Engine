'use strict';
/* ========================================================================= *
 *  Native Chrome/CDP — the engine that was already there.
 *
 *  This adapter owns no browser. It cannot launch one, find one, or attach to
 *  one: everything it does goes through the driver it is handed, and the driver
 *  is the one CDP session the product already holds. It also chooses no target.
 *  The tab was decided by the agent naming a tabId, or by the agent owning one,
 *  and this adapter passes that name on — the session resolves it. That is the
 *  split the router exists for: HOW an action is carried out is the engine's
 *  business; WHERE it lands never is.
 * ========================================================================= */

const { requireContext } = require('../context');

const ID = 'native-cdp';

module.exports = {
  id: ID,
  name: 'Native Chrome/CDP',
  type: 'cdp',
  builtIn: true,

  /* what this engine can do, in the router's vocabulary. Anything not listed
     here is something the router must not send it. */
  capabilities: [
    'navigate', 'click', 'type', 'press', 'select', 'scroll', 'drag',
    'screenshot', 'tabs', 'read', 'evaluate', 'wait', 'history', 'reload',
    'observe', 'extract', 'act',
  ],

  /* No probe, no import, no version check: the engine is the CDP connection the
     product already maintains, and if it is down the driver says so. */
  async available() {
    return { available: true, reason: 'built in' };
  },

  /**
   * One deterministic action against the context it was handed.
   * @param {object} action   { action, url, selector, text, tabId, ... } — the
   *                          shape the tools already send
   * @param {object} ctx      the BrowserContext: { agentTabId, focusedTabId, url }
   * @param {object} driver   { action, tabs, runtime } — the only way to Chrome
   */
  async execute(action, ctx, driver) {
    const tabId = requireContext(ctx);
    // The tab is named explicitly whenever the agent named one, and otherwise
    // filled in from the tab the agent owns. It is never left to the engine, and
    // never taken from wherever the person happens to be looking.
    return driver.action(Object.assign({}, action, { tabId: action && action.tabId ? action.tabId : tabId }));
  },

  /**
   * Look at the page. This is the deterministic observe: what the DOM says,
   * which is exactly what the agent already had.
   */
  async observe(opts, ctx, driver) {
    const tabId = requireContext(ctx);
    const a = opts || {};
    if (a.selector) return driver.action({ action: 'read', tabId, selector: a.selector });
    return driver.action({ action: 'read', tabId });
  },

  /**
   * What, if anything, this engine can try after a failure.
   * The native engine is the floor of the fallback chain, so: nothing.
   */
  async recover() {
    return { retried: false, reason: 'native-cdp is the fallback floor' };
  },
};
