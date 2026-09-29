'use strict';
/* ========================================================================= *
 *  The automation layer: a registry, a router, and the health they keep.
 *
 *  The agent does not know this file exists. It calls the same browser tools it
 *  always called; those still hand a plain action to `controller.browser.action`.
 *  What changed is that the action now passes through here first, and the
 *  router decides which engine carries it out.
 *
 *  Four rules, and every one of them is a decision this file refuses to make
 *  badly:
 *
 *   1. One context. Every engine gets the BrowserContext the agent is driving
 *      and reaches Chrome only through the driver it is handed. No engine can
 *      find, choose, or launch a browser, so none of them can quietly end up on
 *      a different tab than the preview is showing.
 *
 *   2. One choice, made once. Auto mode picks by capability and by what the
 *      action actually is, not by matching words in a string.
 *
 *   3. Bounded fallback. A failure moves down the chain, each engine at most
 *      once per action, and only if it is enabled, available, and able. An
 *      engine that has just failed is not asked again straight away.
 *
 *   4. Honest states. An engine that is not installed says so. An engine the
 *      user picked by hand and that cannot run is reported as unavailable
 *      rather than quietly replaced by another one.
 * ========================================================================= */

const fs = require('fs');
const path = require('path');

const state = require('./state');
const { hasContext, noContextError } = require('./context');

/* the four engines the product ships with, in fallback order: the built-in one
   is the floor, because it is always there and always shares the context.
   Frozen because it is a definition rather than a working list: createRouter()
   copies it, and anything that wants to add an engine adds it to a router. A
   mutation landing here would land on every router at once, so the array
   refuses to accept one. */
const DEFAULT_ENGINES = Object.freeze([
  require('./engines/native'),
  require('./engines/playwright-mcp'),
  require('./engines/stagehand'),
  require('./engines/browser-use'),
]);

/* after this many more failures than successes an engine is stepped over for a
   while, so a broken engine is not retried on every single action */
const COOLDOWN_MS = 45000;
const COOLDOWN_AFTER = 2;

/* ------------------------------- health --------------------------------- *
 * Counts and timestamps only. There is deliberately nowhere to put a key, a
 * cookie, a token or a websocket url: if a future engine wanted to record one,
 * there would be no field for it.
 * ------------------------------------------------------------------------- */
function freshHealth(engines) {
  const h = new Map();
  for (const e of engines) {
    h.set(e.id, {
      id: e.id, available: null, reason: '', capabilities: e.capabilities || [],
      sharesContext: true, lastUsed: 0, lastError: '', successCount: 0, failureCount: 0, cooldownUntil: 0,
    });
  }
  return h;
}

/* --------------------------- capability match --------------------------- */

/**
 * What kind of work this is, in the router's terms rather than the caller's.
 *
 * A single word, because everything downstream — needed(), rank() — switches on
 * it. The distinction that matters: words in place of a selector is one thing
 * (`semantic`), and a whole goal in words is another (`task`).
 */
function classify(action) {
  const a = action || {};
  const has = k => a[k] !== undefined && a[k] !== null && a[k] !== '';
  if (has('task')) return 'task';
  if (has('instruction')) {
    const text = String(a.instruction);
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const across = /\b(several|multiple|compare|research|across|each|find information|and then)\b/i.test(text);
    return across || words > 12 ? 'task' : 'semantic';
  }
  if (has('extract')) return 'extract';
  if (a.action === 'navigate') return 'navigate';
  if (a.action === 'read' || a.action === 'snapshot') return 'observe';
  if (a.action === 'screenshot') return 'screenshot';
  if (a.action === 'tabs') return 'tabs';
  if (has('selector') || has('nx')) return 'precise';
  return 'act';
}

/** the capabilities an action needs, so a match is a fact and not a hope */
function needed(kind) {
  switch (kind) {
    case 'navigate': return ['navigate'];
    case 'observe': return ['read', 'observe'];
    case 'screenshot': return ['screenshot'];
    case 'tabs': return ['tabs'];
    case 'precise': return ['click', 'type', 'act'];
    case 'act': return ['act'];
    case 'semantic': return ['act', 'observe'];
    case 'extract': return ['extract'];
    case 'task': return ['task', 'act'];
    default: return ['act'];
  }
}

/* ------------------------------- the router ------------------------------ */

/**
 * @param {object} o
 * @param {object} o.driver          { action, tabs } — the existing CDP, and the
 *                                   only way any engine can reach Chrome
 * @param {Function} o.context       () => the BrowserContext
 * @param {Function} [o.resolveProvider] (id) => provider row, for the one
 *                                   engine that needs a model of its own
 * @param {Array} [o.engines]        the registry; the four real ones by default
 */
function createRouter({ driver, context, resolveProvider, engines }) {
  if (!driver || typeof driver.action !== 'function') throw new Error('the router needs the existing browser driver');
  if (typeof context !== 'function') throw new Error('the router needs the BrowserContext reader');

  /* An own copy, always — and this is not tidiness.
   *
   * The line used to be `engines && engines.length ? engines : DEFAULT_ENGINES`,
   * which meant that a router built with no `engines` argument did not get a
   * registry: it got the module-level DEFAULT_ENGINES array itself. So the day
   * something registers an engine at runtime it is pushing into the shared list,
   * and every router built after it in the same process starts with an engine
   * nobody asked for. Registering into one router would edit the default for all
   * of them, which is exactly the kind of aliasing that is invisible until it is
   * a bug two features later.
   *
   * `slice()` gives each router its own list. The shipped engines are the same
   * objects — that is the point, they are the four adapters — but the list is
   * per-router, so adding to one adds to one.
   */
  const ENGINES = (engines && engines.length ? engines : DEFAULT_ENGINES).slice();
  const BY_ID = new Map(ENGINES.map(e => [e.id, e]));
  const health = freshHealth(ENGINES);
  // when health was last established; 0 means never, which is always stale
  let healthCheckedAt = 0;

  /**
   * The built-in engine has nothing to look for — it is the CDP connection the
   * product already holds — so its availability is a constant, not a question.
   * Seeding it here means the first thing Settings shows is true. Every other
   * engine stays unknown until something actually checks for it, and says so.
   */
  for (const e of ENGINES) {
    if (!e.builtIn) continue;
    const h = health.get(e.id);
    h.available = true;
    h.reason = 'built in';
  }

  /**
   * Record how an engine went. Counts and a cooldown only: after it has failed
   * more often than it has succeeded, the router stops choosing it for a while
   * rather than trying it again on the very next action.
   */
  function note(engine, ok, err) {
    const h = health.get(engine.id);
    if (!h) return;
    if (ok) {
      h.successCount++;
      h.lastError = '';
      h.cooldownUntil = 0;
      return;
    }
    h.failureCount++;
    h.lastError = String(err || '').slice(0, 200);
    if (h.failureCount - h.successCount >= COOLDOWN_AFTER) h.cooldownUntil = Date.now() + COOLDOWN_MS;
  }

  /** ask every engine once, and remember the answer */
  async function probeAll(opts) {
    healthCheckedAt = Date.now();
    for (const e of ENGINES) {
      const h = health.get(e.id);
      try {
        const r = await e.available({ endpoints: opts && opts.endpoints, profile: opts && opts.profile, resolveProvider });
        h.available = !!(r && r.available);
        h.reason = String((r && r.reason) || (h.available ? '' : 'unavailable')).slice(0, 200);
        if (r && Array.isArray(r.capabilities) && r.capabilities.length) h.capabilities = r.capabilities;
        if (r && typeof r.sharesContext === 'boolean') h.sharesContext = r.sharesContext;
      } catch (err) {
        h.available = false;
        h.reason = String((err && err.message) || err).slice(0, 200);
        h.capabilities = [];
      }
    }
    return health;
  }

  /**
   * probeAll, but only when the answer in hand is old enough to be worth
   * replacing.
   *
   * route() ran this before every single action, and an engine's answer is not
   * free: one of them is an `npx` spawn, another attaches to Chrome. Paying that
   * several times a minute to re-derive a fact that cannot have changed in
   * between is the difference between a responsive UI and one that stalls while
   * a subprocess boots.
   *
   * The one case that is worth re-asking early is when nothing was usable.
   * That is exactly what installing an engine looks like from in here, and a
   * twenty-second wait to notice a package the user just installed is a bug of
   * the same family.
   */
  const HEALTH_TTL_MS = 20000;
  const HEALTH_TTL_EMPTY_MS = 4000;

  function healthIsFresh() {
    if (!healthCheckedAt) return false;
    const age = Date.now() - healthCheckedAt;
    const anyUsable = [...health.values()].some(h => h.available === true);
    return anyUsable ? age < HEALTH_TTL_MS : age < HEALTH_TTL_EMPTY_MS;
  }

  function ensureFresh(opts) {
    if (healthIsFresh()) return Promise.resolve(health);
    return probeAll(opts);
  }

  /** drop the freshness mark so the next action re-probes: called when the
   *  person turns an engine on or off, because that is a change of intent
   *  rather than a change of machine. */
  function invalidate() {
    healthCheckedAt = 0;
  }

  /** enabled, available, not cooling down, and actually able */
  function usable(h, caps) {
    if (!h || h.available !== true) return false;
    if (h.cooldownUntil && Date.now() < h.cooldownUntil) return false;
    const have = new Set(h.capabilities || []);
    return caps.every(c => have.has(c));
  }

  /**
   * Auto mode: rank the engines that can do this job and take the best one.
   *
   * The ranking is the honest part. A precise action goes to the engine that
   * is precise. A goal in words goes to an engine that understands words, if
   * one is there. A whole task goes to the autonomous engine, and only then.
   * Health breaks ties, so an engine that has been failing is passed over
   * before it is asked again.
   */
  function rank(kind, caps) {
    const scored = [];
    for (const e of ENGINES) {
      const h = health.get(e.id);
      if (!usable(h, caps)) continue;
      const has = c => (h.capabilities || []).includes(c);
      const isNative = e.id === 'native-cdp';
      let score = 0;

      switch (kind) {
        case 'navigate':
          // going somewhere is the one thing that must not go sideways
          score = isNative ? 100 : has('navigate') ? 40 : 0;
          break;
        case 'precise':
          // a selector is exact: prefer the engine that is exact
          score = (isNative ? 80 : 0) + (has('observe') ? 10 : 0);
          break;
        case 'observe':
        case 'screenshot':
        case 'tabs':
          score = isNative ? 90 : has(kind) ? 50 : 0;
          break;
        case 'semantic':
          // words in, no selector: this is what a semantic engine is for
          score = (e.id === 'stagehand' ? 100 : 0) + (has('observe') ? 15 : 0) + (isNative ? 20 : 0);
          break;
        case 'extract':
          score = (e.id === 'stagehand' ? 100 : 0) + (has('act') ? 10 : 0);
          break;
        case 'task':
          // a whole workflow: only the autonomous engine should take this
          score = e.id === 'browser-use' ? 100 : (isNative ? 5 : 0);
          break;
        default:
          score = isNative ? 60 : has('act') ? 40 : 0;
      }
      if (score <= 0) continue;
      // a healthy engine outranks a shaky one, but never by enough to send a
      // precise action somewhere it does not belong
      const tally = h.successCount - h.failureCount;
      scored.push({ engine: e, score: score + Math.max(-20, Math.min(20, tally * 2)) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map(s => s.engine);
  }

  /**
   * Let a failed engine put itself back together, and say whether it wants the
   * same action handed to it again.
   *
   * recover() existed on every engine and was never called, so the contract was
   * documentation rather than behaviour. That is worth fixing carefully rather
   * than loudly: three of the four engines genuinely have nothing to recover,
   * and they say so — native-cdp is the floor of the chain and has no state to
   * reset, Stagehand and browser-use re-observe inside their own loops, and the
   * MCP server owns its own retry. Forcing a retry on those would be inventing
   * a second attempt at work that is already being retried somewhere else.
   *
   * So this honours what recover() says, exactly:
   *   retried:false — it cleaned up what it could; move down the chain
   *   retried:true  — it is whole again; the same action gets one more go
   *
   * One more go, and only one. An engine that fails, recovers, and fails again
   * has told us the recovery was not the answer, and the chain below it is
   * where the work belongs.
   *
   * A recover() that throws is not allowed to fail the action: the engine was
   * already failing, and its opinion about why is not worth more than the
   * fallback that is already lined up behind it.
   */
  async function recoverAndMaybeRetry(e, action, ctx, driver, opts, emit) {
    if (typeof e.recover !== 'function') return { retry: false, reason: 'this engine cannot recover' };
    let r;
    try {
      r = await e.recover();
    } catch (err) {
      return { retry: false, reason: 'recovery failed: ' + safeError(err) };
    }
    if (!r || r.retried !== true) {
      return { retry: false, reason: String((r && r.reason) || '') };
    }
    emit({ type: 'engine', engine: e.id, phase: 'recover', label: e.name + ' is trying again' });
    try {
      const result = await e.execute(action, ctx, driver, opts);
      note(e, true, '');
      health.get(e.id).lastUsed = Date.now();
      emit({ type: 'engine', engine: e.id, phase: 'act', label: 'Done with ' + e.name + ' after a retry', ok: true });
      return { retry: true, result };
    } catch (err) {
      const msg = safeError(err);
      note(e, false, msg);
      return { retry: false, reason: msg };
    }
  }

  /**
   * Run one action on the best engine that can take it, falling back down the
   * chain if it cannot. Every engine is tried at most once — plus, for an engine
   * that recovers, at most one more attempt after that.
   */
  async function route(action, opts = {}) {
    const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
    const cfg = state.load();
    const kind = classify(action);
    const caps = needed(kind);

    /* the context is read once, here, and handed to whichever engine runs.
       there is no other reader and no other source. */
    const ctx = context();

    /* No tab, no engine — and that is worth saying plainly rather than
       discovering by trying four of them. Every engine needs a tab, and not one
       of them is allowed to pick one, so the answer cannot be an engine. Saying
       it here also keeps a missing tab out of the engines' health: refusing
       work that was never theirs is not them failing. */
    if (!hasContext(ctx)) {
      const why = noContextError().message;
      emit({ type: 'engine', engine: null, phase: 'failed', label: why });
      return { ok: false, error: why, tried: [] };
    }

    /* one choice, made by the user: "auto", or an engine to honour exactly */
    const pinned = cfg.engine !== state.AUTO
      ? cfg.engine
      : String((action && action.engine) || opts.engine || '').trim();
    if (pinned) {
      await ensureFresh(opts);
      return manual(pinned, action, ctx, emit, opts, kind, caps);
    }

    await ensureFresh(opts);
    const order = rank(kind, caps);
    if (!order.length) {
      const why = explain(caps);
      emit({ type: 'engine', engine: null, phase: 'failed', label: why });
      return { ok: false, error: why, tried: [] };
    }

    emit({ type: 'engine', engine: null, phase: 'choose', label: 'Choosing a browser engine' });
    const tried = [];
    for (let i = 0; i < order.length; i++) {
      const e = order[i];
      if (i > 0) emit({ type: 'engine', engine: e.id, phase: 'fallback', label: e.name + ' instead' });
      emit({ type: 'engine', engine: e.id, phase: 'use', label: 'Using ' + e.name });
      try {
        const result = await e.execute(action, ctx, driver, opts);
        note(e, true, '');
        health.get(e.id).lastUsed = Date.now();
        emit({ type: 'engine', engine: e.id, phase: 'act', label: 'Done with ' + e.name, ok: true });
        return { ok: true, engine: e.id, via: e.id, result, tried: tried.map(x => x.engine) };
      } catch (err) {
        const msg = safeError(err);
        tried.push({ engine: e.id, error: msg });
        note(e, false, msg);
        emit({ type: 'engine', engine: e.id, phase: 'recover', label: e.name + ' could not: ' + msg, ok: false });
        // it may have been a stale client or a dead child rather than a genuine
        // refusal, so it gets its say before the chain moves on
        const again = await recoverAndMaybeRetry(e, action, ctx, driver, opts, emit);
        if (again.retry) {
          return { ok: true, engine: e.id, via: e.id, result: again.result, recovered: true, tried: tried.map(x => x.engine) };
        }
      }
    }
    const last = tried.length ? tried[tried.length - 1].error : 'no engine could take this';
    emit({ type: 'engine', engine: null, phase: 'failed', label: last });
    return { ok: false, error: last, tried: tried.map(x => x.engine) };
  }

  /** the user named an engine: use it, or say why not. never a silent swap. */
  async function manual(id, action, ctx, emit, opts, kind, caps) {
    const e = BY_ID.get(id);
    if (!e) {
      const msg = 'there is no automation engine called "' + id + '"';
      emit({ type: 'engine', engine: null, phase: 'failed', label: msg });
      return { ok: false, error: msg, tried: [] };
    }
    const h = health.get(id);
    if (!h || h.available !== true) {
      const msg = e.name + ' unavailable — ' + ((h && h.reason) || 'not available on this machine');
      emit({ type: 'engine', engine: id, phase: 'failed', label: msg, ok: false });
      return { ok: false, error: msg, tried: [] };
    }
    if (!usable(h, caps)) {
      const msg = e.name + ' cannot ' + kind + ' actions';
      emit({ type: 'engine', engine: id, phase: 'failed', label: msg, ok: false });
      return { ok: false, error: msg, tried: [] };
    }
    emit({ type: 'engine', engine: id, phase: 'use', label: 'Using ' + e.name });
    try {
      const result = await e.execute(action, ctx, driver, opts);
      note(e, true, '');
      h.lastUsed = Date.now();
      emit({ type: 'engine', engine: id, phase: 'act', label: 'Done with ' + e.name, ok: true });
      return { ok: true, engine: id, via: id, result, tried: [id] };
    } catch (err) {
      const msg = safeError(err);
      note(e, false, msg);
      emit({ type: 'engine', engine: id, phase: 'recover', label: e.name + ' could not: ' + msg, ok: false });
      /* The same one chance a failure gets in auto mode. A recovery is not a
         fallback: it is the same engine saying it was not really a refusal. The
         engine the person chose still carries the work or the work fails — there
         is no quiet swap either way. */
      const again = await recoverAndMaybeRetry(e, action, ctx, driver, opts, emit);
      if (again.retry) {
        return { ok: true, engine: id, via: id, result: again.result, recovered: true, tried: [id] };
      }
      // chosen by hand means chosen by hand: no falling back behind the user's back
      return { ok: false, error: msg, tried: [id] };
    }
  }

  /* Which of the packages this engine names is actually resolvable right now.
   *
   * Deliberately not a require() of the engine itself: importing browser-use
   * loads a browser automation library, and asking "is it installed" must not be
   * the thing that installs it. require.resolve() against the manifest finds the
   * folder without running any of it.
   *
   * npx candidates are not in node_modules and are not ours to remove, so they
   * report null and the UI shows the warm-the-cache action instead. */
/* Is there a node_modules/<pkg>/package.json in one of the directories above us?

   Not require.resolve, which is the obvious tool and the wrong one. A package
   whose "exports" map does not name ./package.json — which is most of them now —
   makes it throw ERR_PACKAGE_PATH_NOT_EXPORTED for a package that is installed
   and working. @browserbasehq/stagehand is one, and after a successful install of
   it the engine was still reporting "not installed here", which then made the
   Remove button refuse. Three of the four candidate answers fail the same way;
   only the manifest on disk is a question with one answer, and reading it runs
   none of the package's code. */
function packageOnDisk(pkg) {
  const segs = String(pkg).split('/');
  /* a segment that climbs out of node_modules is not a package name, and this
     walks the filesystem, so the path is checked before it is used */
  if (segs.some(x => !x || x === '.' || x === '..')) return false;
  let dir = __dirname;
  for (;;) {
    try { if (fs.existsSync(path.join(dir, 'node_modules', ...segs, 'package.json'))) return true; }
    catch (e) { return false; }
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

  function installedFor(e) {
    for (const i of (e.installs || [])) {
      if (i.via !== 'npm') continue;
      if (packageOnDisk(i.pkg)) return i.pkg;
    }
    return null;
  }

  /** the public view for Settings: no secrets, no endpoints, no paths */
  function describe() {
    const cfg = state.load();
    return {
      engine: cfg.engine,
      mode: cfg.engine === state.AUTO ? 'auto' : 'manual',
      engines: ENGINES.map(e => {
        const h = health.get(e.id);
        const enabled = cfg.engines[e.id] ? cfg.engines[e.id].enabled !== false : true;
        /* null means nobody has looked yet, which is not the same as broken */
        const known = h.available !== null;
        return {
          id: e.id,
          name: e.name,
          type: e.type,
          builtIn: !!e.builtIn,
          enabled,
          /* what it would take to make this engine work, and whether the first
             candidate is already here. Both are names from the engine's own
             module — the view never invents a package. */
          installs: (e.installs || []).map(i => ({ pkg: i.pkg, via: i.via })),
          installed: installedFor(e),
          available: known ? h.available === true : null,
          status: !enabled ? 'disabled' : !known ? 'unknown' : (h.available ? 'available' : 'unavailable'),
          reason: enabled ? (known ? String(h.reason || '') : 'not checked yet') : 'turned off',
          capabilities: enabled ? (h.capabilities || []) : [],
          health: {
            lastUsed: h.lastUsed || null,
            lastError: String(h.lastError || '').slice(0, 160),
            successCount: h.successCount,
            failureCount: h.failureCount,
            coolingDown: !!(h.cooldownUntil && Date.now() < h.cooldownUntil),
          },
        };
      }),
      /** is there anything to route to beyond the built-in engine? */
      extrasAvailable: ENGINES.filter(e => !e.builtIn).some(e => health.get(e.id).available === true),
      /** how many are still unchecked, so the UI can stop guessing about them */
      unchecked: ENGINES.filter(e => health.get(e.id).available === null
        && (cfg.engines[e.id] ? cfg.engines[e.id].enabled !== false : true)).length,
    };
  }

  /** why nothing could take it, in words a person can act on */
  function explain(caps) {
    const cfg = state.load();
    const on = ENGINES.filter(e => !cfg.engines[e.id] || cfg.engines[e.id].enabled !== false);
    if (!on.length) return 'every automation engine is turned off';
    const available = on.filter(e => health.get(e.id).available === true);
    if (!available.length) {
      const first = on[0];
      return 'no automation engine can run here — ' + first.name + ': ' + (health.get(first.id).reason || 'unavailable');
    }
    return 'no available engine supports ' + caps.join('/');
  }

  /**
   * Stop every engine that holds something, before the process goes away.
   *
   * Three of the four engines own an external thing: a child `npx` process for
   * Playwright MCP, a browser connection for Stagehand, a session and its
   * browser for browser-use. None of them is torn down on the way out — the
   * shutdown() methods were written and never called — so stopping the server
   * left the `npx` child and the connections running. That is a leak the user
   * pays for in processes they did not ask for, and on a machine where the
   * server is restarted often it accumulates.
   *
   * native-cdp has nothing to stop: it owns no process, only the CDP connection
   * the product already holds, and the host closes that itself.
   *
   * Each engine is stopped under a timeout, and one that throws or hangs does
   * not stop the others — a half-finished shutdown is worse than a noisy one,
   * because it is the reason the process would not have exited. Returns what it
   * managed to stop and what it had to leave, so the caller can say so rather
   * than exiting as if everything were clean.
   */
  const SHUTDOWN_GRACE_MS = 3000;
  async function shutdownAll(opts = {}) {
    const grace = typeof opts.graceMs === 'number' ? opts.graceMs : SHUTDOWN_GRACE_MS;
    const stopped = [];
    const failed = [];
    for (const e of ENGINES) {
      if (typeof e.shutdown !== 'function') continue;
      let timer;
      try {
        await Promise.race([
          e.shutdown(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('shutdown did not finish in ' + grace + 'ms')), grace); }),
        ]);
        stopped.push(e.id);
      } catch (err) {
        failed.push({ id: e.id, error: safeError(err) });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return { stopped, failed };
  }

  return { route, describe, probeAll, invalidate, shutdownAll, ENGINES, BY_ID, health, usable, rank, explain };
}

/* ------------------------------- helpers --------------------------------- */

/** an error message safe to put in an event, a log line, or a reply */
function safeError(err) {
  const raw = String((err && err.message) || err || 'failed');
  return raw
    .replace(/ws:\/\/\S+/gi, '<cdp>')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, '<key>')
    .replace(/Bearer\s+\S+/gi, 'Bearer <key>')
    .slice(0, 180);
}

module.exports = {
  createRouter,
  classify,
  needed,
  safeError,
  DEFAULT_ENGINES,
  freshHealth,
  state,
  COOLDOWN_MS,
  COOLDOWN_AFTER,
};
