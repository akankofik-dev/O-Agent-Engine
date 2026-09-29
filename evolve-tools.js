'use strict';
/* ========================================================================= *
 *  evolve-tools.js — the agent's doors onto Levels 3 to 6.
 *
 *  create_engine and engine_execute (in forge.js) are the first two. These are
 *  the rest, and they exist because a capability nothing can reach is not a
 *  capability:
 *
 *    repair_engine     an engine that fails, made healthy again
 *    improve_engine    an engine that works, made better — and only with a reason
 *    rollback_engine   put a past version back
 *    engine_plan       what exists, what is missing, and whether to build
 *    engine_compose    run several engines in order, handing each the last result
 *    engine_evolve     the whole lifecycle, in one call
 *
 *  One permission for all of them
 *  -----------------------------
 *  Every one of these is the `engines` key, the same key create_engine already
 *  uses. Splitting them would produce the profile that may rewrite an engine it
 *  built but may not run it, or may compose engines it may not repair — a
 *  profile where the permissions describe a distinction nobody wants. This
 *  permission means "this agent writes and runs code"; nothing here is more
 *  dangerous than that, and everything here is less dangerous than a shell.
 *
 *  What each one refuses
 *  ---------------------
 *  These are thin. They check that a router exists, that the shape of the
 *  arguments is right, and then call lifecycle.js / discover.js / compose.js /
 *  evolve.js, which own the real rules. That split is deliberate: the safety
 *  argument for changing an engine is in the module that changes it, and a tool
 *  that re-implemented any of it would be a second place for the argument to be
 *  wrong.
 *
 *  What a refusal looks like
 *  -------------------------
 *  Every refusal throws, and that is not a style choice. `ai/engine.js` records a
 *  thrown tool call as ok:false; a tool that *returns* {ok:false} is recorded as
 *  a successful call whose result happened to be a refusal. A refusal that is
 *  recorded as a success is a refusal the model does not learn from, so the
 *  throw is how a refusal is made visible to the run that caused it.
 * ========================================================================= */

const forge = require('./forge');
const lifecycle = require('./lifecycle');
const discover = require('./discover');
const compose = require('./compose');
const evolve = require('./evolve');

const CAP = forge.TOOL_CAP;

/** every tool in this file, in the order they are offered */
const TOOLS = [];

/** a refusal, thrown so the run records it as a failure rather than an answer */
function refuse(message, fact) {
  const e = new Error(String(message).slice(0, 400));
  if (fact && typeof fact === 'object') e.fact = fact;
  throw e;
}

/**
 * Hand back a result, or refuse it.
 *
 * `ai/engine.js` records a thrown tool as ok:false and a returned value as a
 * success. So a tool that returns {ok:false} is telling the run that the call
 * succeeded, and the model never learns that anything was refused. Every tool
 * here therefore throws on a refusal, which is the same rule engine_execute
 * already follows.
 *
 * The gate's own output goes into the message, not just the fact, because a
 * refusal with the reason hidden one field down is a refusal the model reads
 * as an unexplained failure and answers by trying the same thing again.
 */
function result(r, what) {
  if (r && r.ok) return r;
  const reason = String((r && (r.reason || r.error)) || 'refused');
  const output = String((r && r.output) || '');
  refuse(what + ' refused: ' + reason + (output ? '\n' + output.split('\n').slice(0, 40).join('\n') : ''), r);
}

/** the router the tools act on, captured at install time like create_engine's */
let router = null;
function setRouter(r) { router = r; }
function needRouter(tool) {
  if (!router) refuse(tool + ' is not wired to a router — it should have been installed with the server');
  return router;
}

/* ----------------------------------------------------------- repair_engine -- */

const REPAIR_TOOL = {
  name: 'repair_engine',
  description:
    'Change an engine that is failing, and promote the change only if its own test passes. ' +
    'The engine that is running is never touched unless the new version passes first, and the version ' +
    'it replaces is kept so you can roll back. Built-in engines cannot be repaired, and an id that is ' +
    'not a generated engine is refused. Read the failure, fix the cause, and pass the new body.',
  caps: [CAP],
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'body', 'examples'],
    properties: {
      id: { type: 'string', description: 'the engine to repair, e.g. uppercase-text-engine' },
      body: { type: 'string', description: 'the full source of the new body of execute(), as JavaScript' },
      examples: {
        type: 'array',
        description: 'what the repaired engine now promises. The new test checks execute() against every one, so the repair has to be covered by at least one.',
        items: {
          type: 'object',
          required: ['action', 'expect'],
          properties: { action: { type: 'string' }, expect: { type: 'object' } },
        },
      },
      why: { type: 'string', description: 'one line: what was wrong, and what this fixes' },
    },
  },
  label: (a) => 'repair ' + ((a && a.id) || 'engine'),
  run: async (_ctx, a) => {
    needRouter(this.name);
    const args = a || {};
    if (typeof args.id !== 'string' || !args.id.trim()) refuse('repair_engine needs the id of the engine to repair — call create_engine with action "survey" to see the generated ones');
    return result(lifecycle.repair(router, args), 'repair_engine');
  },
};

/* ---------------------------------------------------------- improve_engine -- */

const IMPROVE_TOOL = {
  name: 'improve_engine',
  description:
    'Propose a better version of an engine that already works. The candidate is tested before anything ' +
    'active is touched, and it is refused unless the version it would replace is still passing too — a ' +
    'change that improves one thing while breaking another is not an improvement. The version it replaces ' +
    'is kept and can be rolled back to. A reason is required: without one, nothing is promoted.',
  caps: [CAP],
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'body', 'examples', 'why'],
    properties: {
      id: { type: 'string', description: 'the engine to improve' },
      body: { type: 'string', description: 'the full source of the new body of execute(), as JavaScript' },
      examples: {
        type: 'array',
        description: 'what the new version promises. Its test checks execute() against every one.',
        items: {
          type: 'object',
          required: ['action', 'expect'],
          properties: { action: { type: 'string' }, expect: { type: 'object' } },
        },
      },
      why: { type: 'string', description: 'required: what is better about this version, concretely' },
    },
  },
  label: (a) => 'improve ' + ((a && a.id) || 'engine'),
  run: async (_ctx, a) => {
    needRouter(this.name);
    const args = a || {};
    if (typeof args.id !== 'string' || !args.id.trim()) refuse('improve_engine needs the id of the engine to improve');
    if (typeof args.why !== 'string' || !args.why.trim()) {
      refuse('improve_engine needs a reason. A working engine is not replaced by a change nobody can account for, so say what the new version does that the old one did not.');
    }
    return result(lifecycle.improve(router, args), 'improve_engine');
  },
};

/* --------------------------------------------------------- rollback_engine -- */

const ROLLBACK_TOOL = {
  name: 'rollback_engine',
  description:
    'Put a past version of an engine back. The version being replaced is kept first, so a rollback is ' +
    'itself undoable. With no version named, the most recent one is used.',
  caps: [CAP],
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: { type: 'string', description: 'the engine to roll back' },
      to: { type: 'string', description: 'the version stamp, or its number. Omit for the most recent.' },
    },
  },
  label: (a) => 'roll back ' + ((a && a.id) || 'engine'),
  run: async (_ctx, a) => {
    needRouter(this.name);
    const args = a || {};
    if (typeof args.id !== 'string' || !args.id.trim()) refuse('rollback_engine needs the id of the engine to roll back');
    return result(lifecycle.rollback(router, args.id, args.to), 'rollback_engine');
  },
};

/* ------------------------------------------------------------ engine_plan -- */

const PLAN_TOOL = {
  name: 'engine_plan',
  description:
    'Ask what the registry can do, and what a task is missing. Returns every engine and capability that ' +
    'exists, and a decision: use-existing or build. Call this before create_engine — a build is only ' +
    'justified when a capability is genuinely missing, and this is what establishes that.',
  caps: [CAP],
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['needs'],
    properties: {
      needs: {
        type: 'array',
        description: 'the capabilities the task cannot proceed without, in the router\'s own words — e.g. ["navigate"], ["observe"], ["echo"]',
        items: { type: 'string' },
      },
      task: { type: 'string', description: 'one line describing the task, kept in the plan for whoever reads it later' },
    },
  },
  label: (a) => 'plan ' + (((a && a.needs) || []).join('+') || 'task'),
  run: async (_ctx, a) => {
    needRouter(this.name);
    const args = a || {};
    return discover.plan(router, { needs: args.needs, task: args.task });
  },
};

/* ---------------------------------------------------------- engine_compose -- */

const COMPOSE_TOOL = {
  name: 'engine_compose',
  description:
    'Run several engines in order, handing each one what the last produced. A step that fails stops the ' +
    'workflow — the steps after it are reported as never run, which is not the same as having run and ' +
    'returned nothing. Pass "retry" on a step only if running it twice is safe; steps that already ' +
    'succeeded are never run again. In args, "$prev" is the previous result, "$prev.a.b" a path into ' +
    'it, and "$steps.<id>" the result of an earlier step.',
  caps: [CAP],
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['steps'],
    properties: {
      name: { type: 'string', description: 'a name for this workflow' },
      steps: {
        type: 'array',
        description: 'the steps, in order',
        items: {
          type: 'object',
          required: ['engine', 'action'],
          properties: {
            id: { type: 'string', description: 'optional: a name other steps can reach with $steps.<id>' },
            engine: { type: 'string', description: 'a registered engine id' },
            action: { type: 'string', description: 'the action, as that engine\'s execute() takes it' },
            args: { type: 'object', description: 'the action\'s arguments, with $prev and $steps.<id> resolved' },
            retry: { type: 'integer', minimum: 0, maximum: 3, description: 'how many extra attempts this one step may have, if it is safe to repeat. 0 by default.' },
          },
        },
      },
    },
  },
  label: (a) => 'compose ' + (((a && a.steps) || []).length) + ' steps',
  run: async (_ctx, a) => {
    needRouter(this.name);
    const args = a || {};
    const w = await compose.run(router, args, {});
    if (w.ok) return w;
    /* The trace is in the message, not only in the fact. A workflow that stops
       at step 2 of 5 is only useful if the reader can see which step and what
       it said — and a step that never ran has to be visibly distinct from one
       that ran and returned nothing. */
    const ran = (w.trace || []).map(t => (t.ok ? '  ok   ' : '  FAIL ') + (t.id || ('step ' + (t.index + 1))) + ' ' + t.engine + ' — ' + (t.error || 'done'));
    const notRun = (w.notRun || []).map(x => '  never  ' + (x.id || x.engine) + ' ' + x.engine);
    return result({ ok: false, reason: w.reason, trace: w.trace, notRun: w.notRun },
      'engine_compose\n' + ran.concat(notRun).join('\n'));
  },
};

/* ----------------------------------------------------------- engine_evolve -- */

const EVOLVE_TOOL = {
  name: 'engine_evolve',
  description:
    'The whole lifecycle in one call: look at what exists, use it if it fits, build what is missing, run ' +
    'the task, repair it if it failed, improve it if it worked, and roll it back if asked. Everything it ' +
    'does is gated — a build that fails its test is never registered, a repair is only promoted if it ' +
    'passes, an improve needs a reason. Returns the trace of which capabilities actually ran, so you can ' +
    'see what happened rather than only the result.',
  caps: [CAP],
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['needs'],
    properties: {
      task: { type: 'string', description: 'what the task is, in one line' },
      needs: { type: 'array', description: 'the capabilities the task cannot proceed without', items: { type: 'string' } },
      build: {
        type: 'object',
        description: 'only if a capability is genuinely missing: the engine to build for it',
        properties: {
          id: { type: 'string' }, name: { type: 'string' },
          body: { type: 'string', description: 'the source of the body of execute()' },
          examples: { type: 'array', items: { type: 'object', required: ['action', 'expect'], properties: { action: { type: 'string' }, expect: { type: 'object' } } } },
        },
      },
      run: {
        type: 'object',
        description: 'a single action to run. Omit it and give a workflow instead.',
        properties: {
          action: { type: 'string' },
          engine: { type: 'string', description: 'optional: pin an engine rather than letting the router choose' },
          args: { type: 'object' },
        },
      },
      workflow: { type: 'object', description: 'a workflow, as engine_compose takes it' },
      repair: { type: 'object', description: 'applied only if the task fails', properties: { id: { type: 'string' }, body: { type: 'string' }, examples: { type: 'array' }, why: { type: 'string' } } },
      improve: { type: 'object', description: 'applied only if the task works. "why" is required.', properties: { id: { type: 'string' }, body: { type: 'string' }, examples: { type: 'array' }, why: { type: 'string' } } },
      rollback: { type: 'object', description: 'applied at the end', properties: { id: { type: 'string' }, to: { type: 'string' } } },
    },
  },
  label: (a) => 'evolve: ' + ((a && a.task) || 'task').slice(0, 50),
  run: async (_ctx, a) => {
    needRouter(this.name);
    const args = a || {};
    const out = await evolve.evolve(router, args);
    if (out.ok) return out;
    /* The reason, and the last thing that failed. A stop with only a stage named
       is a stop the caller cannot act on: "the run failed" and "the engine said
       it cannot act actions" are the same size of message and only one of them
       helps. */
    const done = (out.trace || []).map(t => (t.ok ? '  ok   ' : '  FAIL ') + t.capability + ' — ' + t.note);
    const last = (out.trace || []).filter(t => !t.ok).pop();
    return result({ ok: false, reason: out.reason, stage: out.stage, trace: out.trace, decision: out.decision },
      'engine_evolve — ' + (out.reason || 'the task did not run')
      + (last ? '\n  last failure: ' + JSON.stringify(last.fact).slice(0, 300) : '')
      + '\n' + done.join('\n'));
  },
};

TOOLS.push(REPAIR_TOOL, IMPROVE_TOOL, ROLLBACK_TOOL, PLAN_TOOL, COMPOSE_TOOL, EVOLVE_TOOL);

/**
 * Put these in front of the agent.
 *
 * Same shape as forge.installTool — push the definitions, and wrap the lookup so
 * the names resolve — because that is the only way in that ai/tools.js offers.
 * Both wrappers check for their own marker so installing twice does not wrap
 * twice, and installing this after forge.installTool finds the forge's wrapper
 * already in place and leaves it alone.
 */
function install(r) {
  if (!r) return { ok: false, error: 'install() needs the router — the tools act on it' };
  setRouter(r);

  const tools = require('./ai/tools');
  for (const tool of TOOLS) {
    if (!tools.TOOLS.some(t => t && t.name === tool.name)) tools.TOOLS.push(tool);
  }

  if (!tools.toolByName.__forgeWrapped) {
    const original = tools.toolByName;
    const wrapped = function toolByName(name) {
      return original(name) || tools.TOOLS.find(t => t && t.name === name) || null;
    };
    wrapped.__forgeWrapped = true;
    tools.toolByName = wrapped;
  }

  return { ok: true, tools: TOOLS.map(t => t.name), cap: CAP };
}

/** what is true right now, not what was true when this was written */
function installed() {
  const tools = require('./ai/tools');
  const present = TOOLS.every(t => tools.TOOLS.some(x => x && x.name === t.name));
  const resolvable = TOOLS.every(t => tools.toolByName(t.name) === t);
  let offered = false;
  try {
    const all = {};
    for (const k of require('./ai/rules').CAP_KEYS) all[k] = true;
    all[CAP] = true;
    const names = tools.toolsFor({ id: 'evolve-probe', skills: [], tools: all }).map(t => t.name);
    offered = TOOLS.every(t => names.includes(t.name));
  } catch { /* ai/rules not readable — never as yes */ }
  return { present, resolvable, offered, cap: CAP, router: !!router, tools: TOOLS.map(t => t.name) };
}

module.exports = {
  TOOLS, install, installed, setRouter,
  REPAIR_TOOL, IMPROVE_TOOL, ROLLBACK_TOOL, PLAN_TOOL, COMPOSE_TOOL, EVOLVE_TOOL,
};
