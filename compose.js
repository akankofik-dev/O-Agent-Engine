'use strict';
/* ========================================================================= *
 *  compose.js — Level 6 (SELF-COMPOSE).
 *
 *  What it is
 *  ----------
 *  Running several engines in order, where each one is handed what the last one
 *  produced:
 *
 *      fetch  ->  transform  ->  save
 *      result     result        result
 *
 *  Every step is an ordinary router.route() call with an engine named on it.
 *  That is the whole design, and it is load-bearing in two ways. The engine
 *  contract does not change by one character, because a step is not a new kind
 *  of call — it is the call that already exists. And every step goes through the
 *  same door as everything else, which means the Milestone 2A URL policy, the
 *  context check, availability and the cooldown all still apply to a composed
 *  step exactly as they do to a standalone one. A workflow is a sequence of
 *  ordinary actions, and gets no privileges for being a sequence.
 *
 *  Passing data between steps
 *  --------------------------
 *  A step's `args` is a literal object, except that a string of the form
 *
 *      $prev                 the previous step's whole result
 *      $prev.a.b             one path into it
 *      $steps.<id>.result    a named step's result, including an earlier one
 *
 *  is replaced by that value. Nothing is evaluated: no expressions, no code, no
 *  function calls, because the whole subject of this milestone is an agent
 *  choosing to chain engines, and letting the chain description execute would
 *  hand the description more power than the engines it names.
 *
 *  Failure
 *  -------
 *  A step that fails stops the workflow. There is no option to continue, on
 *  purpose — "the fetch failed, carry on to save" is how a workflow writes an
 *  empty result somewhere and calls it done. Later steps are reported as never
 *  run, which is the difference between a trace and a log.
 *
 *  Retry
 *  -----
 *  Only the step that failed is retried, only if that step asked for it, and
 *  only within the number it asked for. Steps that already succeeded are never
 *  run again — a fetch that has already fetched would fetch again, and a save
 *  that has already saved would save twice.
 *
 *  The trace
 *  ---------
 *  Appended as the run happens, by the loop that is doing the running. There is
 *  no timer, no polling and no synthesised event anywhere in this file: if an
 *  entry is in the trace, a call returned.
 * ========================================================================= */

const state = require('./ai/automation/state');

/** the largest retry count anyone can ask for, whatever they ask for */
const MAX_RETRY = 3;

/**
 * How a `$ref` string is recognised — deliberately the only templating here is.
 *
 * The name after `steps.` is parsed loosely ([A-Za-z0-9_-]) and then refused by
 * the lookup if no such step ran. It is not restricted to lowercase, because a
 * reference that fails to parse must not become a literal string on its way to
 * an engine: an earlier version restricted it, and `$steps.SomeName.result`
 * simply stopped being a reference and was passed through as text.
 *
 * `REF_INTENT` catches a string that is clearly trying to be a reference but is
 * not well formed, so the two cases — "understood, and it points nowhere" and
 * "not understood at all" — both end in a refusal instead of one ending in a
 * refusal and the other ending in a value.
 */
const REF = /^\$(prev|steps\.[A-Za-z0-9_-]+)((?:\.[A-Za-z0-9_$-]+)*)$/;
const REF_INTENT = /^\$(prev\b|steps\b|steps\.)/;

/* --------------------------------------------------------------- resolving -- */

/**
 * Walk a dotted path out of a value.
 *
 * Strict: a path that runs off the end throws. It used to return undefined, which
 * meant a step received undefined where the model expected a field, failed
 * somewhere else, and the trace blamed that step rather than the reference. One
 * rule for references — resolve or refuse — is worth more than the ability to
 * pass an optional field through, and an optional field can be read from the
 * previous result inside the engine that wants it.
 */
function dig(root, dotted) {
  if (!dotted) return root;
  let at = root;
  const keys = dotted.replace(/^\./, '').split('.');
  for (let i = 0; i < keys.length; i++) {
    if (at === null || at === undefined) {
      throw new Error('.' + keys.slice(0, i).join('.') + ' is ' + (at === null ? 'null' : 'not there') + ', so .' + keys[i] + ' cannot be read');
    }
    at = at[keys[i]];
  }
  if (at === undefined) throw new Error('the value has no "' + keys.join('.') + '"');
  return at;
}

/**
 * Replace every $ref inside `args` with what it points at.
 *
 * An unresolved ref is an error rather than an undefined, because a step that
 * receives undefined where a URL was meant fails later and further away, and
 * the trace then blames the wrong step. `$steps.<name>` has to name a step that
 * has already run, and `$prev` has to have a step before it — both are checked
 * here, against the state of the run rather than against the shape of the
 * string, because a reference that parses is not a reference that resolves.
 */
function resolveArgs(args, scope) {
  const where0 = scope.named instanceof Map ? scope.named : new Map();
  const walk = (v, where) => {
    if (typeof v === 'string') {
      const m = REF.exec(v);
      if (!m) {
        if (REF_INTENT.test(v)) {
          throw new Error(where + ' contains "' + v + '", which is not a reference this workflow understands. Write $prev, $prev.a.b, or $steps.<id> followed by a path');
        }
        return v;
      }
      const head = m[1];
      const tail = m[2] || '';

      if (head === 'prev') {
        if (!scope.hasPrev) throw new Error(where + ' refers to $prev, but it is the first step and has nothing before it');
        return dig(scope.prev, tail);
      }

      /* head is `steps.<name>`; the tail is the path into that step's result,
         which is the same thing $prev walks. There is no `.result` suffix: a
         step's value is its result, and having the word there meant two
         different things depending on which side of the name you read it. */
      const name = head.slice('steps.'.length);
      if (!where0.has(name)) {
        throw new Error(where + ' refers to ' + v + ', and no step called "' + name + '" has run — the ones that have: ' +
          (where0.size ? Array.from(where0.keys()).join(', ') : 'none'));
      }
      return dig(where0.get(name), tail);
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, where + '[' + i + ']'));
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, where + '.' + k);
      return out;
    }
    return v;
  };
  return walk(args === undefined ? {} : args, 'args');
}

/* ------------------------------------------------------------- validation -- */

/**
 * Check a workflow before any of it runs.
 *
 * Doing this first is not tidiness. A workflow whose third step names an engine
 * that does not exist should say so before the first step has run, because once
 * step one has run the interesting question is no longer whether the workflow is
 * valid — it is what it already did.
 */
function validate(router, workflow) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    return { ok: false, reason: 'a workflow has to be an object with a steps array' };
  }
  const raw = workflow.steps;
  if (!Array.isArray(raw) || !raw.length) {
    return { ok: false, reason: 'a workflow needs at least one step' };
  }
  if (raw.length > 20) {
    return { ok: false, reason: 'a workflow of ' + raw.length + ' steps is refused — the limit is 20' };
  }

  const seen = new Set();
  const steps = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    const at = 'step ' + (i + 1);
    if (!s || typeof s !== 'object' || Array.isArray(s)) return { ok: false, reason: at + ' is not an object' };

    if (typeof s.engine !== 'string' || !s.engine.trim()) {
      return { ok: false, reason: at + ' does not name an engine' };
    }
    if (!router || !router.BY_ID || !router.BY_ID.has(s.engine)) {
      return { ok: false, reason: at + ' names "' + s.engine + '", which is not in the registry' };
    }
    if (typeof s.action !== 'string' || !s.action.trim()) {
      return { ok: false, reason: at + ' does not name an action' };
    }
    if (s.args !== undefined && (typeof s.args !== 'object' || s.args === null || Array.isArray(s.args))) {
      return { ok: false, reason: at + ' has args that are not an object' };
    }
    if (s.retry !== undefined && (!Number.isInteger(s.retry) || s.retry < 0 || s.retry > MAX_RETRY)) {
      return { ok: false, reason: at + ' asks for ' + s.retry + ' retries — it must be a whole number from 0 to ' + MAX_RETRY };
    }
    if (s.id !== undefined) {
      if (typeof s.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(s.id)) {
        return { ok: false, reason: at + ' has an id that is not usable in a $steps reference' };
      }
      if (seen.has(s.id)) return { ok: false, reason: 'two steps are called "' + s.id + '", so $steps.' + s.id + ' is ambiguous' };
      seen.add(s.id);
    }
    steps.push({ index: i, id: s.id || null, engine: s.engine, action: s.action, args: s.args, retry: s.retry || 0, label: String(s.label || '').slice(0, 80) });
  }
  return { ok: true, steps, name: String(workflow.name || 'workflow').slice(0, 80) };
}

/**
 * Is this engine cooling down, and for how much longer.
 *
 * The router records this in the engine's health after COOLDOWN_AFTER clean
 * failures, and refuses to route to it until it expires. While it refuses, the
 * reason it gives is "X cannot <kind> actions" — which is about capabilities,
 * not about the cooldown, and reads like a composition bug. Reading the
 * cooldown here is what turns a wasted retry into a recorded reason.
 */
function cooling(router, id, now) {
  const h = router && router.health && router.health.get(id);
  if (!h || !h.cooldownUntil) return 0;
  const left = Number(h.cooldownUntil) - (now || Date.now());
  return left > 0 ? left : 0;
}

/* ------------------------------------------------------------------- run --- */

/**
 * The pinned-engine problem, checked once before anything runs.
 *
 * The router reads the user's chosen engine out of the config first and only
 * falls back to the one named on the action. So a user who picked a single
 * engine in the UI would silently get that engine for every step of a workflow
 * that asked for four different ones, and the trace would name four engines
 * while four calls went to one. Composition is a claim about which engine does
 * what; a claim the router is about to ignore is refused rather than recorded.
 */
function pinnedEngine() {
  try {
    const cfg = state.load();
    if (cfg && cfg.engine && cfg.engine !== state.AUTO) return String(cfg.engine);
  } catch { /* no config is not an obstruction here */ }
  return '';
}

/**
 * Run a workflow.
 *
 * @param {object} router what createRouter returned
 * @param {object} workflow { name?, steps: [{ id?, engine, action, args?, retry? }] }
 * @param {object} opts    { emit? } — emit gets one real event per attempt
 */
async function run(router, workflow, opts = {}) {
  const emit = typeof opts.emit === 'function' ? opts.emit : () => {};

  const v = validate(router, workflow);
  if (!v.ok) return { ok: false, stage: 'validate', reason: v.reason, steps: [], trace: [], ran: 0, of: 0 };

  const pin = pinnedEngine();
  if (pin && v.steps.some(s => s.engine !== pin)) {
    return {
      ok: false, stage: 'validate', trace: [], ran: 0, of: v.steps.length,
      reason: 'a single engine is chosen in the settings (' + pin + '), and a workflow asking for ' +
        Array.from(new Set(v.steps.map(s => s.engine))).join(', ') + ' would be run through ' + pin +
        ' regardless. Choose "auto" or compose something that uses ' + pin + ' alone.',
    };
  }

  const trace = [];
  const named = new Map();
  let prev = undefined;
  let result = null;

  for (let i = 0; i < v.steps.length; i++) {
    const s = v.steps[i];
    const scope = { prev, named, hasPrev: i > 0 };

    /* A $ref that does not resolve is a failure of this step and of no other,
       and it is reported here rather than thrown, so the trace can name the step
       the reference was in. */
    let args;
    try {
      args = resolveArgs(s.args, scope);
    } catch (e) {
      trace.push({ at: Date.now(), index: i, id: s.id, engine: s.engine, action: s.action, attempt: 1, ok: false, ms: 0, error: e.message, phase: 'resolve' });
      return { ok: false, stage: 'run', name: v.name, steps: v.steps, trace, failedAt: i, failedStep: s.id || (i + 1), ran: i, of: v.steps.length, result: null,
        reason: e.message, notRun: v.steps.slice(i + 1).map((x, k) => ({ index: i + 1 + k, id: x.id, engine: x.engine, action: x.action })) };
    }

    /* The step's own attempts, and only its own. Nothing before this point is
       re-run: a step that already succeeded may have had effects, and repeating
       it because a later step failed is a different workflow from the one asked
       for. */
    const attempts = s.retry + 1;
    let done = null;
    for (let a = 1; a <= attempts; a++) {
      const started = Date.now();

      /* Before spending an attempt: if the engine is cooling down this call
         cannot be routed to it, and the router's answer at that point reads
         like a capability problem. Stop here instead, and say why. */
      if (a > 1) {
        const left = cooling(router, s.engine, started);
        if (left) {
          trace.push({ at: started, ms: 0, index: i, id: s.id, engine: s.engine, action: s.action,
            attempt: a, of: attempts, ok: false, phase: 'cooling-down', cooledForMs: left,
            error: s.engine + ' is cooling down for another ' + Math.ceil(left / 1000) + 's, so attempt ' + a + ' was not made' });
          emit({ type: 'compose', step: i + 1, id: s.id, engine: s.engine, phase: 'cooling-down', ok: false, label: s.engine + ' is cooling down' });
          break;
        }
      }
      emit({ type: 'compose', step: i + 1, id: s.id, engine: s.engine, action: s.action, attempt: a, of: attempts, phase: 'run' });

      const r = await router.route({ action: s.action, engine: s.engine, ...args }, { emit });

      trace.push({
        at: started, ms: Date.now() - started,
        index: i, id: s.id, engine: s.engine, action: s.action,
        attempt: a, of: attempts, ok: !!r.ok, phase: 'run',
        result: r.ok ? r.result : undefined,
        error: r.ok ? undefined : r.error,
        via: r.via || null,
      });

      if (r.ok) { done = r.result; break; }
      done = null;
    }

    if (done === null) {
      /* Stop. The steps after this one did not run, and saying so is the whole
         value of a trace over a log: a reader can tell "not run" from "ran and
         returned nothing". */
      const why = trace[trace.length - 1].error || 'no result';
      emit({ type: 'compose', step: i + 1, id: s.id, engine: s.engine, phase: 'stop', ok: false, label: why });
      return {
        ok: false, stage: 'run', name: v.name, steps: v.steps, trace,
        failedAt: i, failedStep: s.id || (i + 1), ran: i + 1, of: v.steps.length, result: null,
        reason: 'step ' + (i + 1) + ' (' + s.engine + ') failed after ' + attempts + ' attempt' + (attempts > 1 ? 's' : '') + ': ' + why,
        notRun: v.steps.slice(i + 1).map((x, k) => ({ index: i + 1 + k, id: x.id, engine: x.engine, action: x.action })),
      };
    }

    if (s.id) named.set(s.id, done);
    prev = done;
    result = done;
  }

  emit({ type: 'compose', phase: 'done', ok: true, label: v.name + ' finished' });
  return {
    ok: true, stage: 'run', name: v.name, steps: v.steps, trace,
    ran: v.steps.length, of: v.steps.length, result,
    results: Object.fromEntries(named),
  };
}

module.exports = { run, validate, pinnedEngine, cooling, resolveArgs, MAX_RETRY };
