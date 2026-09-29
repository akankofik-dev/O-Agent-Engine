'use strict';
/* ========================================================================= *
 *  policy.js — one browser policy, applied to every way the browser can end
 *  up somewhere new.
 *
 *  What broke
 *  ----------
 *  `guardUrl()` was called from exactly two places: `navigate` and `tabs new`.
 *  The profile's allowlist and blocklist therefore described a door with two
 *  hinges and a wall. A click on a link went straight through, `Enter` on a
 *  focused link went straight through, `back` could land on any URL still in
 *  history, and `browser_js` could set `location.href` to anything at all.
 *  None of those are exotic; three of them are what a person does by accident.
 *
 *  The two questions
 *  -----------------
 *  Before, when the destination is known: `navigate` and `tabs new` carry the
 *  URL in the request, and `back`/`forward` carry an index into a history the
 *  server can read before it moves.
 *
 *  After, when it is not: a click, a keypress and a script all reach the new
 *  page before anyone can object. The only honest place to object is after,
 *  which is what `after()` is for.
 *
 *  Why the default costs nothing
 *  -----------------------------
 *  A profile with no allowlist and no blocklist has no opinion, and `on()`
 *  says so. Every caller asks first. With the shipped defaults the answer is
 *  "no policy", the extra code runs zero times, and not one round trip is added
 *  to a click.
 * ========================================================================= */

const store = require('./ai/store');

/**
 * Every action that can put the browser on a URL nobody chose up front.
 *
 * This list is the whole boundary, so it is written as an exhaustive list of
 * names rather than a pattern: a new navigation path has to be added here on
 * purpose, and `test/security-urlpolicy.test.js` fails if one is missing.
 */
const NAV_CAPABLE = new Set([
  'navigate',   // the URL is in the request
  'back',       // the destination is an index into history, readable first
  'forward',
  'click',      // a link, with a target only the page knows
  'press',      // Enter on a focused link or a submit button
  'javascript', // anything at all, including location.href =
]);

/* actions whose destination can be read BEFORE the move happens */
const PRE_KNOWN = new Set(['navigate', 'back', 'forward']);

/** does this profile have an opinion about where the browser may go? */
function restricts(policy) {
  const p = store.normBrowser(policy);
  return p.allowedDomains.length > 0 || p.blockedDomains.length > 0;
}

/** the one judgement, unchanged from the store's own: blocked wins */
function checkUrl(policy, url) {
  return store.browserAllows(policy, url);
}

/**
 * The gate, bound to one profile's policy.
 *
 * Callers use all three methods; which one is meaningful depends on the
 * action, and a caller that picks the wrong one gets a no-op rather than a
 * wrong answer. That is deliberate: the two-sided check has to be usable
 * without every call site having to reason about it.
 */
function makeGuard(policy) {
  const active = restricts(policy);

  return {
    active,

    /** true when the action can move the browser at all */
    covers(action) {
      return NAV_CAPABLE.has(String(action || ''));
    },

    /**
     * The judgement on its own, for a caller that is not a browser action at
     * all. `tabs new` creates a tab at a URL rather than moving an existing one
     * — it is not in NAV_CAPABLE because NAV_CAPABLE describes doActionOn's
     * switch, and inventing a fake action name to reach this would be worse
     * than having a second, honest entry point.
     */
    check(url) {
      if (!active) return null;
      const v = checkUrl(policy, url);
      return v.ok ? null : v;
    },

    /**
     * Check a destination that the request already names.
     *
     * Only the three actions that carry a URL in the request are eligible. A
     * click, a keypress and a script say nothing about where they end up, so
     * asking about them here would be asking about `undefined` — and
     * browserAllows answers a missing URL with "that is not a valid absolute
     * url", which is true and useless: it refused a click that was never going
     * anywhere in particular, and it refused it for a reason that has nothing to
     * do with the policy. Those three are the after-check's job, and the only
     * reason they get one is that nothing before the move can answer for them.
     *
     * @returns {null|{ok:false, reason:string}} null means "carry on"
     */
    before(action, url) {
      if (!active) return null;
      if (!PRE_KNOWN.has(String(action || ''))) return null;
      if (!url) return null;   /* nothing to check; the after-check will */
      const v = checkUrl(policy, url);
      return v.ok ? null : v;
    },

    /**
     * Check a destination that was only revealed by the move.
     * @param {string} from the URL the tab was on, or null if not recorded
     * @param {string} to   where it ended up
     * @returns {null|{ok:false, reason:string}}
     */
    after(action, from, to) {
      if (!active) return null;
      if (!NAV_CAPABLE.has(String(action || ''))) return null;
      if (!to || to === from) return null;      /* nothing moved */
      const v = checkUrl(policy, to);
      return v.ok ? null : v;
    },
  };
}

module.exports = { NAV_CAPABLE, PRE_KNOWN, restricts, checkUrl, makeGuard };
