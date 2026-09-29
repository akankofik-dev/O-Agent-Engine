'use strict';
/* ========================================================================= *
 *  evolve.js — Level 7 (SELF-EVOLVE).
 *
 *  What this is
 *  ------------
 *  An ordering. Nothing new happens here.
 *
 *      discover -> plan -> use existing
 *                          |
 *                          +-- gap -> build -> verify -> register
 *                                             |
 *                                             v
 *                                          compose -> execute
 *                                             |
 *                            failure -> repair -> retry
 *                                             |
 *                            success -> improve -> verify -> promote
 *                                                        |
 *                                              rollback, always available
 *
 *  Every arrow is a call to something that already exists and has already been
 *  tested: the survey and the plan from discover.js, the gate from forge.js,
 *  the repair/improve/promote/rollback from lifecycle.js, the workflow from
 *  compose.js, and the ordinary router.route that is the only way any work
 *  reaches an engine. This file decides which of those happen and in what
 *  order. It is the part that could be wrong in a way none of the parts are —
 *  an orchestrator that builds when the plan said not to, or that repairs a
 *  failure it should have reported, is a bug no gate behind it can catch.
 *
 *  So the order is the specification
 *  ---------------------------------
 *  Each capability runs when the state the run is actually in says it should,
 *  and the trace records which ones ran. Three rules carry the weight:
 *
 *    - nothing is built unless the plan said the capability is missing, and the
 *      plan's own guard is asked a second time immediately before the build. A
 *      plan is a decision that can be wrong; the guard is the same question
 *      answered by different code, and the build only happens if both agree.
 *
 *    - an improve runs only when the run succeeded and only when a reason was
 *      given. "There is always something better" is not a reason, and an
 *      improve with no stated reason is how a working engine gets replaced by a
 *      change nobody can account for.
 *
 *    - a retry repeats the execution, not the planning. The plan was made
 *      against the registry as it was, and a failure does not change what that
 *      registry can do.
 *
 *  What it will not do
 *  -------------------
 *  It will not build a capability the registry already serves, repair a
 *  built-in, promote anything that has not passed the gate, or continue past a
 *  step that failed. Each of those is refused by the module that owns it, and
 *  this file's job is to arrive at the right door — not to open it.
 * ========================================================================= */

const forge = require('./forge');
const lifecycle = require('./lifecycle');
const discover = require('./discover');
const compose = require('./compose');

/**
 * The lifecycle, in the order it happens.
 *
 * Exported so it can be asserted against rather than described in prose. A
 * capability the list does not name is not something this file does, and a
 * capability the list names but the run never reaches is a hole in the
 * ordering.
 */
const CAPABILITIES = [
  'discover', 'plan', 'guard', 'use-existing', 'build', 'verify', 'register',
  'compose', 'execute', 'repair', 'retry', 'improve', 'promote', 'rollback',
];

/**
 * Run the lifecycle once.
 *
 * @param {object} router what createRouter returned
 * @param {object} spec   {
 *   task?, needs?: string[],
 *   build?: { id?, name?, body, examples },
 *   run?: { action, args?, engine? },
 *   workflow?: { steps },
 *   repair?: { id?, body, examples, why? },
 *   improve?: { id?, body, examples, why },
 *   rollback?: { id?, to? },
 * }
 */
async function evolve(router, spec) {
  const s = spec || {};
  const trace = [];
  const reached = new Set();

  /* The id of an engine this run created, if it created one. The plan was made
     before the build and so knows nothing about it, and without this the task
     is routed by capability alone — which is how a freshly built watermark
     engine ends up not being the thing that runs the watermark. Declared here
     rather than beside the run because the build assigns to it. */
  let built = '';
  const say = (capability, ok, fact, note) => {
    reached.add(capability);
    const entry = { at: Date.now(), capability, ok: !!ok, fact: fact || {}, note: note || '' };
    trace.push(entry);
    return entry;
  };

  const out = {
    ok: false,
    task: String(s.task || '').slice(0, 300),
    trace, engine: null, result: null, decision: null,
  };
  /* An early exit still has to say which capabilities it reached — a run that
     stopped at the guard is a different thing from one that never planned, and
     the trace is the only place that difference shows. */
  const stop = (stage, reason, entry, extra) => {
    if (entry) reached.add(entry.capability);
    return Object.assign(out, {
      ok: false, stage, reason,
      reached: Array.from(reached),
      workflow: s.workflow ? { trace: [], notRun: [], failedAt: null } : null,
    }, extra || {});
  };

  /* ---------------------------------------------------------------- discover */
  const survey = discover.capabilities(router);
  say('discover', true,
    { engines: survey.engines.length, capabilities: Object.keys(survey.capabilities).length },
    'read what the registry can do right now');

  /* -------------------------------------------------------------------- plan */
  const needs = Array.isArray(s.needs) ? s.needs : [];
  const plan = discover.plan(router, { needs, task: out.task });
  out.decision = plan.decision;
  out.plan = plan;
  say('plan', true,
    { decision: plan.decision, have: plan.have, missing: plan.missing, servers: plan.servers, disabled: plan.disabled },
    plan.decision === 'build'
      ? 'nothing registered provides ' + plan.missing.join(', ')
      : 'the registry already covers this');

  /* --------------------------------------- use what is there, or build what is not */
  if (plan.decision === 'use-existing') {
    if (plan.servers.length) {
      say('use-existing', true, { engines: plan.servers }, 'using ' + plan.servers.join(', ') + ' — nothing is built');
    } else if (plan.disabled.length) {
      say('use-existing', false, { turnOn: plan.disabled }, 'the engines that could do this are switched off: ' + plan.disabled.join(', '));
    } else {
      say('use-existing', false, {}, 'nothing was asked for and nothing was found, so there is nothing to use');
    }
  } else {
    const want = plan.build.capability;
    const buildSpec = (s.build && s.build[want]) || s.build || {};

    /* The plan said build. Ask the guard again, immediately before acting: it is
       the same question answered by different code, and the build needs both to
       agree. */
    const guard = discover.guardBuild(router, { capability: want });
    if (!guard.ok) {
      /* Recorded as 'guard' and not as 'build': nothing was written, and a trace
         that claims a build happened when the guard stopped it is a trace that
         cannot be used to find out what ran. */
      return stop('guard', guard.reason,
        say('guard', false, { capability: want, useInstead: guard.useInstead || [], turnOn: guard.turnOn || [] },
          'the plan wanted to build ' + want + ' and the guard would not allow it'),
        { decision: 'use-existing', useInstead: guard.useInstead || [], turnOn: guard.turnOn || [] });
    }
    say('guard', true, { capability: want }, 'no registered engine provides ' + want + ', so building it is justified');

    const id = String(buildSpec.id || want).trim();
    const made = forge.build(router, {
      id, name: buildSpec.name, capability: want,
      body: buildSpec.body, examples: buildSpec.examples,
    });
    if (!made.ok) {
      return stop('build', made.reason || made.error,
        say('build', false, { id, reason: made.reason || made.error, output: made.output || '' },
          'the candidate did not pass its own test, so nothing was registered'),
        { output: made.output || '' });
    }
    built = id;
    say('build', true, { id, reason: made.reason }, 'written, tested and registered as ' + id);

    /* build() already ran the gate before registering. These two are not a second
       gate — they are the record that it happened, read back afterwards. */
    const verdict = forge.verify(id);
    if (!verdict.ok) {
      return stop('verify', verdict.reason, say('verify', false, { id, reason: verdict.reason },
        'the promoted files do not verify'));
    }
    say('verify', true, { id, reason: verdict.reason }, 'the contract and the test pass on the promoted files');
    say('register', !!router.BY_ID.get(id), { id, name: (router.BY_ID.get(id) || {}).name },
      'the router can route to ' + id);
  }

  /* ------------------------------------------------------------- which engine */
  const run = s.run || {};
  let engine = String(run.engine || '').trim();
  if (!engine && plan.servers.length === 1) engine = plan.servers[0];
  if (!engine && built) engine = built;
  out.engine = engine || null;

  /* ------------------------------------------------------------- run, once */
  const runOnce = async () => {
    if (s.workflow) {
      /* compose and execute are the same event for a workflow: the composition is
         how the task is executed, not something done before it. Both are recorded
         so the trace reads the way the lifecycle is described. */
      const w = await compose.run(router, s.workflow);
      say('compose', w.ok, { ran: w.ran, of: w.of, steps: w.trace.length },
        w.ok ? w.of + ' steps ran' : 'stopped at step ' + ((w.failedAt || 0) + 1));
      say('execute', w.ok, { error: w.reason, failedAt: w.failedAt, notRun: w.notRun || [] },
        w.ok ? 'the workflow finished' : 'the workflow stopped: ' + w.reason);
      return w;
    }
    if (!run.action) {
      const why = 'the run has neither a workflow nor an action, so there is nothing to execute';
      say('execute', false, {}, why);
      return { ok: false, error: why };
    }
    const r = await router.route({ action: run.action, ...(engine ? { engine } : {}), ...(run.args || {}) });
    say('execute', r.ok, { engine: r.via || engine || 'the router chose', error: r.error },
      r.ok ? 'the engine ran' : 'the engine failed: ' + r.error);
    return r;
  };

  let first = await runOnce();
  let ok = !!first.ok;

  /* -------------------------------------------------------------------- repair */
  if (!ok && s.repair) {
    const target = String(s.repair.id || out.engine || engine || '').trim();
    if (!target) {
      say('repair', false, {}, 'a repair was asked for but no engine is named, and there is nothing to attribute the failure to');
    } else {
      const r = lifecycle.repair(router, Object.assign({}, s.repair, { id: target }));
      say('repair', r.ok,
        { id: target, stage: r.stage, reason: r.reason, keptActive: r.keptActive, keptAs: r.keptAs, version: r.version, output: r.output || '' },
        r.ok
          ? 'promoted v' + (r.version || '?') + '; the version it replaced is kept as ' + r.keptAs + ' and can be rolled back to'
          : 'refused at the ' + r.stage + ' step, and the running engine was not touched');
      if (r.ok) {
        const again = await runOnce();
        say('retry', !!again.ok, { error: again.error },
          again.ok ? 'the task ran on the repaired engine' : 'still failing after the repair');
        first = again;
        ok = !!again.ok;
      }
    }
  }

  /* ------------------------------------------------------------------- improve */
  if (ok && s.improve) {
    const why = String(s.improve.why || '').trim();
    const target = String(s.improve.id || out.engine || engine || '').trim();
    if (!why) {
      say('improve', false, {}, 'an improve with no stated reason is not carried out — a working engine is not replaced by a change nobody can account for');
    } else if (!target) {
      say('improve', false, {}, 'an improve was asked for but names no engine');
    } else {
      const before = lifecycle.current(target);
      const r = lifecycle.improve(router, Object.assign({}, s.improve, { id: target, why }));
      say('improve', r.ok,
        { id: target, stage: r.stage, reason: r.reason, from: before ? before.version : null, to: r.version, output: r.output || '' },
        r.ok
          ? 'v' + (before ? before.version : '?') + ' -> v' + r.version
          : 'refused at the ' + r.stage + ' step, and the running engine was not touched');
      if (r.ok) {
        /* Reported as their own capabilities because they are: a candidate passed
           before anything active was touched, and a version went past the gate
           and became the running one with the old one kept. */
        say('verify', true, { id: target, kind: 'candidate' }, 'the candidate passed, and the version it would replace was still passing, before anything active was touched');
        say('promote', true, { id: target, version: r.version, keptAs: r.keptAs },
          'v' + r.version + ' is running; v' + (before ? before.version : '?') + ' is kept as ' + r.keptAs);
        const again = await runOnce();
        say('retry', !!again.ok, { error: again.error },
          again.ok ? 'the task ran again, now on the promoted version' : 'the promoted version does not run the task');
        if (again.ok) { first = again; ok = true; }
      }
    }
  }

  /* ------------------------------------------------------------------ rollback */
  if (s.rollback) {
    const target = String(s.rollback.id || out.engine || engine || '').trim();
    if (!target) {
      say('rollback', false, {}, 'a rollback was asked for but names no engine');
    } else {
      const r = lifecycle.rollback(router, target, s.rollback.to);
      say('rollback', r.ok, { id: target, to: r.rolledBackTo, reason: r.reason },
        r.ok ? 'put ' + r.rolledBackTo + ' back' : 'refused: ' + r.reason);
      if (r.ok) {
        const again = await runOnce();
        say('retry', !!again.ok, { error: again.error }, 'the task ran again, now on the rolled-back version');
        if (again.ok) { first = again; ok = true; }
      }
    }
  }

  out.ok = ok;
  out.result = first && first.ok ? (first.result === undefined ? null : first.result) : null;
  out.reason = ok ? '' : String((first && (first.error || first.reason)) || 'the task did not run');
  out.workflow = s.workflow ? { trace: (first && first.trace) || [], notRun: (first && first.notRun) || [], failedAt: (first && first.failedAt) } : null;
  out.reached = Array.from(reached);
  return out;
}

module.exports = { evolve, CAPABILITIES };
