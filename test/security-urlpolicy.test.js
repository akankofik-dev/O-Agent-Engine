'use strict';
/* ====================================================================== *
 *  security-urlpolicy.test.js — a profile's allowlist has to mean something
 *  on every route out, not on the one that was easiest to remember.
 *
 *  The two halves
 *  --------------
 *  The unit half checks the judgement itself, including that it stays silent
 *  when a profile has no opinion, because a default install must not pay for a
 *  feature it does not use.
 *
 *  The contract half is the one that matters. It reads `doActionOn` out of
 *  server.js and works out, from the CDP calls in each branch, which actions
 *  can move the browser. Every one of them has to be in the guard's list. Add
 *  a navigation path later and forget the guard, and this fails.
 * ====================================================================== */

const fs = require('fs');
const path = require('path');
const policy = require('../policy');

const SERVER = path.join(__dirname, '..', 'server.js');

let pass = 0;
const fails = [];
function check(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass += 1; console.log('  ok   ' + name); })
    .catch(e => { fails.push(name); console.log('  FAIL ' + name + '\n         ' + e.message); });
}

const OPEN = {};                                        /* the shipped default */
const ALLOWLIST = { allowedDomains: ['contoh.test'] };
const BLOCKLIST = { blockedDomains: ['larangan.test'] };

(async () => {
  console.log('\n  browser url policy');

  /* --- the judgement --------------------------------------------------- */

  await check('a profile with no policy restricts nothing', () => {
    if (policy.restricts(OPEN)) throw new Error('an empty policy was treated as a restriction');
    if (policy.restricts({ allowedDomains: [], blockedDomains: [] })) throw new Error('empty lists counted');
  });

  await check('a profile with either list does restrict', () => {
    if (!policy.restricts(ALLOWLIST)) throw new Error('an allowlist was ignored');
    if (!policy.restricts(BLOCKLIST)) throw new Error('a blocklist was ignored');
  });

  await check('blocked wins over allowed', () => {
    const p = { allowedDomains: ['larangan.test'], blockedDomains: ['larangan.test'] };
    const v = policy.checkUrl(p, 'https://larangan.test/x');
    if (v.ok) throw new Error('a domain that is both allowed and blocked was let through');
  });

  await check('subdomains follow the profile setting', () => {
    if (!policy.checkUrl(ALLOWLIST, 'https://sub.contoh.test/').ok) throw new Error('a subdomain was refused');
    const strict = { allowedDomains: ['contoh.test'], allowSubdomains: false };
    if (policy.checkUrl(strict, 'https://sub.contoh.test/').ok) throw new Error('a subdomain was allowed with subdomains off');
  });

  await check('something that is not a url is refused, not waved through', () => {
    const v = policy.checkUrl(ALLOWLIST, 'not a url');
    if (v.ok) throw new Error('a malformed url passed the check');
  });

  /* --- silence when there is nothing to say ---------------------------- */

  await check('the guard is silent for the default profile', () => {
    const g = policy.makeGuard(OPEN);
    if (g.active) throw new Error('the guard engaged with no policy configured');
    for (const action of ['navigate', 'click', 'javascript', 'press', 'back', 'forward']) {
      if (g.before(action, 'https://larangan.test') !== null) throw new Error(action + ' was checked with no policy');
      if (g.after(action, 'https://a.test', 'https://larangan.test') !== null) throw new Error(action + ' was checked with no policy');
    }
  });

  await check('the guard answers for every navigation action it claims', () => {
    const g = policy.makeGuard(BLOCKLIST);
    for (const action of policy.NAV_CAPABLE) {
      if (!g.covers(action)) throw new Error(action + ' is in the list but not covered');
    }
  });

  /* --- the two sides, per action ---------------------------------------- */

  await check('every navigation action is checked after the move', () => {
    const g = policy.makeGuard(BLOCKLIST);
    for (const action of policy.NAV_CAPABLE) {
      const v = g.after(action, 'https://biasa.test/a', 'https://larangan.test/b');
      if (!v || v.ok) throw new Error(action + ' moved onto a blocked domain without being caught');
    }
  });

  await check('a move that stays put is not an offence', () => {
    const g = policy.makeGuard(BLOCKLIST);
    if (g.after('click', 'https://biasa.test/a', 'https://biasa.test/a') !== null) throw new Error('a same-url click was reported');
    if (g.after('click', 'https://biasa.test/a', null) !== null) throw new Error('an unknown destination was reported');
  });

  await check('a move onto an allowed domain is fine', () => {
    const g = policy.makeGuard(ALLOWLIST);
    if (g.after('click', 'https://contoh.test/a', 'https://contoh.test/b') !== null) throw new Error('an allowed move was refused');
  });

  await check('a destination known up front is refused before the move', () => {
    const g = policy.makeGuard(BLOCKLIST);
    if (g.before('navigate', 'https://larangan.test/x') === null) throw new Error('navigate to a blocked domain was allowed up front');
    if (g.before('navigate', 'https://biasa.test/x') !== null) throw new Error('navigate to a normal domain was refused');
  });

  await check('back and forward are checked against the history entry, not the current url', () => {
    /* A history move names a position, not a URL, so the caller has to read the
       destination out of Page.getNavigationHistory first and pass that in. The
       guard has to accept it — and it must not quietly fall back to judging the
       URL the tab is already on, which is the one URL a history move is not
       going to land on. */
    const g = policy.makeGuard(BLOCKLIST);
    if (g.before('back', 'https://larangan.test/lama') === null) throw new Error('back onto a blocked entry was allowed');
    if (g.before('forward', 'https://larangan.test/lama') === null) throw new Error('forward onto a blocked entry was allowed');
    if (g.before('back', 'https://biasa.test/lama') !== null) throw new Error('back onto a normal entry was refused');
  });

  await check('an action with no known destination is not judged before the move', () => {
    /* click, press and javascript carry no URL. Asking about them anyway meant
       asking about `undefined`, and browserAllows answers a missing URL with
       "that is not a valid absolute url" — which refused a click that was never
       going anywhere in particular, for a reason that had nothing to do with the
       policy. Caught by running it: a same-origin click and a same-origin
       location.href were both refused with exactly that sentence. */
    const g = policy.makeGuard(ALLOWLIST);
    for (const action of ['click', 'press', 'javascript']) {
      for (const arg of [undefined, null, '', {}]) {
        if (g.before(action, arg) !== null) {
          throw new Error(action + ' was refused up front on a destination nobody gave it');
        }
      }
    }
  });

  await check('a history move with no readable entry is left to the action itself', () => {
    /* null here means "we do not know where this would go", and the honest
       response to not knowing is not to invent a verdict. doActionOn already
       answers "no history entry" for that case. */
    const g = policy.makeGuard(BLOCKLIST);
    if (g.before('back', null) !== null) throw new Error('an unknown destination was judged');
    if (g.before('forward', null) !== null) throw new Error('an unknown destination was judged');
  });

  await check('a tab opened at a refused url is turned away', () => {
    const g = policy.makeGuard(BLOCKLIST);
    if (g.check('https://larangan.test/x') === null) throw new Error('tabs new at a blocked domain was allowed');
    if (g.check('https://biasa.test/x') !== null) throw new Error('tabs new at a normal domain was refused');
    const open = policy.makeGuard(OPEN);
    if (open.check('https://larangan.test/x') !== null) throw new Error('the guard judged a url with no policy');
  });

  /* --- the contract half ------------------------------------------------ */

  await check('every action in server.js that can move the browser is in the guard', () => {
    const src = fs.readFileSync(SERVER, 'utf8');
    const start = src.indexOf('async function doActionOn(');
    if (start < 0) throw new Error('doActionOn not found — the contract test cannot check anything');
    const end = src.indexOf('\nasync function ', start + 10);
    const body = src.slice(start, end < 0 ? src.length : end);

    /* Only the two calls that name a destination outright. The input events
       are deliberately NOT used as a signal: `type` dispatches Control+a to
       select a field's text, `drag` and `scroll` dispatch the mouse, and none
       of the three can move the browser. Reading them as navigation would have
       made the guard look thorough while adding three round trips per action
       for nothing. The actions that reach a link through raw input are named
       below instead, which is a fact about this code and not a guess. */
    const MOVES = ['Page.navigate', 'Page.navigateToHistoryEntry'];
    const found = new Set();
    const re = /case '([a-zA-Z]+)':/g;
    let m;
    const cases = [];
    while ((m = re.exec(body))) cases.push({ name: m[1], at: m.index });
    for (const c of cases) {
      const next = cases.find(x => x.at > c.at);
      const chunk = body.slice(c.at, next ? next.at : body.length);
      if (MOVES.some(sig => chunk.includes(sig))) found.add(c.name);
    }
    /* click dispatches the mouse onto whatever is under it, press can be
       Enter on a focused link, and javascript evaluates whatever it is given */
    for (const named of ['click', 'press', 'javascript']) {
      if (new RegExp("case '" + named + "':").test(body)) found.add(named);
    }

    const missing = [...found].filter(a => !policy.NAV_CAPABLE.has(a));
    if (missing.length) {
      throw new Error('these can move the browser and are not in the guard: ' + missing.join(', '));
    }
    if (found.size < 4) throw new Error('only found ' + found.size + ' navigation actions — the scan is probably not reading the right code');
  });

  await check('the actions that cannot navigate are deliberately left out', () => {
    /* The other half of the same contract. An earlier version of this file
       read Input.dispatchKeyEvent as "can navigate" and so demanded a guard on
       `type`, which only uses it to press Control+a. A guard that covers
       actions that cannot move the browser is a cost with no boundary behind
       it, so the exclusions are asserted as deliberately as the inclusions. */
    const CANT = ['type', 'drag', 'scroll', 'reload', 'stop', 'read', 'screenshot', 'viewport', 'focus', 'wait'];
    const wrongly = CANT.filter(a => policy.NAV_CAPABLE.has(a));
    if (wrongly.length) throw new Error('these cannot navigate and do not belong in the guard: ' + wrongly.join(', '));
  });

  await check('tab creation is policed too, and not through the browser action list', () => {
    /* `tabs new` is not a doActionOn branch, so it cannot appear in the scan
       above; this is the assertion that stops it being forgotten instead */
    const src = fs.readFileSync(SERVER, 'utf8');
    const start = src.indexOf('function agentController(');
    if (start < 0) throw new Error('agentController not found');
    const chunk = src.slice(start, src.indexOf('\nfunction ', start + 10));
    if (!/tabs:/.test(chunk)) throw new Error('the tabs entry point is gone');
    if (!/guard\.check\s*\(/.test(chunk)) {
      throw new Error('tabs new is no longer checked — it was one of only two that were');
    }
  });

  await check('the agent path actually runs the guard, on both sides', () => {
    /* The checks above prove the guard is right. This one proves the server
       calls it, which is the half that was missing entirely: guardUrl() ran
       for `navigate` and nothing else, so a correct guard sitting unused in a
       module would have passed every other test in this file. */
    const src = fs.readFileSync(SERVER, 'utf8');
    const start = src.indexOf('function agentController(');
    if (start < 0) throw new Error('agentController not found');
    const end = src.indexOf('\nfunction ', start + 10);
    const chunk = src.slice(start, end < 0 ? start + 3000 : end);
    if (!/makeGuard|policy\./.test(chunk)) {
      throw new Error('agentController does not build a guard — the policy is not applied to any agent action');
    }
    if (!/\.before\s*\(/.test(chunk)) throw new Error('the guard is never asked about a known destination');
    if (!/\.after\s*\(/.test(chunk)) throw new Error('the guard is never asked about a destination only the move revealed');
  });

  await check('the guard is consulted only when the profile has a policy', () => {
    /* The cost argument, kept as a test: a default install must not pay a
       round trip per click for a policy it does not have. */
    const src = fs.readFileSync(SERVER, 'utf8');
    if (!/guard\.active|\.active\b/.test(src)) {
      throw new Error('the guard is not gated on whether a policy exists — every click now pays for nothing');
    }
  });

  console.log('\n  url policy: ' + pass + ' passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ''));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('\n  suite crashed: ' + e.message); process.exit(1); });
