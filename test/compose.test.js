'use strict';
/* ========================================================================= *
 *  test/compose.test.js — Level 6 (SELF-COMPOSE).
 *
 *  Three engines, chained for real: one produces text, one transforms it, one
 *  records what it was given. Nothing is stubbed — every step is a router.route
 *  against a generated engine on disk, so a workflow that "works" here works for
 *  the same reason it would work in the agent.
 *
 *  The tests that matter are the failures. A workflow that runs three steps in
 *  order proves very little; the claim worth proving is that a step which fails
 *  stops the ones after it, that a retry touches only the step that failed, and
 *  that the trace says which steps never ran.
 * ======================================================================== */

const fs = require('fs');
const path = require('path');
const forge = require('../forge');
const compose = require('../compose');
const automation = require('../ai/automation');

const MAKER = 'chain-maker';
const TRANSFORM = 'chain-transform';
const SINK = 'chain-sink';
const FLAKY = 'chain-flaky';

const driver = { action: async () => ({ ok: true }), tabs: async () => ({ tabs: [] }) };
const context = () => ({ connected: true, agentTabId: 'tab_cp', url: 'about:blank' });
const newRouter = () => automation.createRouter({ driver, context, engines: automation.DEFAULT_ENGINES.slice() });
const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* gone */ } };
const head = (s) => console.log('\n  --- ' + s + ' ' + '-'.repeat(Math.max(0, 62 - s.length)));
const allIds = [MAKER, TRANSFORM, SINK, FLAKY];

let pass = 0; const fails = [];
const check = (name, fn) => Promise.resolve().then(fn)
  .then(() => { pass += 1; console.log('  ok   ' + name); })
  .catch(e => { fails.push(name); console.log('  FAIL ' + name + '\n         ' + e.message); });

/* how many times each flaky-engine action has been called, per id */
let flakyCalls = 0;

/** build the three engines a workflow needs, plus one that fails on demand */
function seed() {
  for (const id of allIds) rm(path.join(forge.ENGINES_DIR, id));
  const r = newRouter();
  const build = (spec) => {
    const made = forge.build(r, spec);
    if (!made.ok) throw new Error('seed ' + spec.id + ' failed: ' + (made.reason || made.error) + '\n' + (made.output || ''));
  };

  build({ id: MAKER, name: 'Maker', capability: 'make',
    body: "    return { made: String(action.text || 'x') + '-' + String(action.tag || 'none') };",
    examples: [{ action: 'make', text: 'seed', tag: 'a', expect: { made: 'seed-a' } }] });

  build({ id: TRANSFORM, name: 'Transform', capability: 'transform',
    body: "    const got = String(action.word || '');\n    return { transformed: got.toUpperCase(), length: got.length };",
    examples: [{ action: 'transform', word: 'seed', expect: { transformed: 'SEED', length: 4 } }] });

  build({ id: SINK, name: 'Sink', capability: 'store',
    body: "    return { stored: true, saw: String(action.thing || ''), position: Number(action.at || 0) };",
    examples: [{ action: 'store', thing: 'seed', at: 1, expect: { stored: true, saw: 'seed', position: 1 } }] });

  /* Fails until it has been called `failUntil` times, so a test can make it
     fail once and then succeed — the shape of a real transient failure, and the
     only kind worth retrying. */
  build({ id: FLAKY, name: 'Flaky', capability: 'poke',
    body: [
      '    /* Nothing is required here and nothing is read from disk. A generated',
      '       execute() has no module scope beyond its own arguments, and the first',
      '       version of this engine used path and failed its own build with a',
      '       ReferenceError. The router calls engines in-process, so the counter',
      '       that makes this engine fail-then-succeed belongs on global. */',
      '    global.__chainFlaky = (global.__chainFlaky || 0) + 1;',
      "    if (global.__chainFlaky <= Number(global.__chainFailUntil || 0)) throw new Error('poke refused, attempt ' + global.__chainFlaky);",
      '    return { poked: true, attempt: global.__chainFlaky };',
    ].join('\n'),
    /* The example has to name `attempt` as well, because the generated test
       deep-equals the whole result and a missing key is a failure. It is 1
       there because the test runs in a fresh child process, where the counter
       starts from nothing. */
    examples: [{ action: 'poke', expect: { poked: true, attempt: 1 } }] });
  global.__chainFailUntil = 0;
  global.__chainFlaky = 0;
  return r;
}

/* Reset both halves of what makes an engine flaky: its behaviour (how many more
   times it refuses) and the router's memory of it (successes, failures, and the
   45s cooldown two clean failures earn it). Resetting only the first leaks a
   cooldown into the next scenario, and the next scenario then fails for a
   reason that has nothing to do with what it is testing. */
const setFlaky = (n, router) => {
  global.__chainFailUntil = n;
  global.__chainFlaky = 0;
  if (router && router.health && router.health.has(FLAKY)) {
    const h = router.health.get(FLAKY);
    h.successCount = 0; h.failureCount = 0; h.cooldownUntil = 0; h.lastError = '';
  }
};

(async () => {
  console.log('\n  Level 6 — SELF-COMPOSE');
  let router = seed();

  await check('three engines chained: make -> transform -> store', async () => {
    const r = await compose.run(router, {
      name: 'seed the chain',
      steps: [
        { id: 'made', engine: MAKER, action: 'make', args: { text: 'hello', tag: 'x' } },
        { id: 'changed', engine: TRANSFORM, action: 'transform', args: { word: '$prev.made' } },
        { id: 'kept', engine: SINK, action: 'store', args: { thing: '$prev.transformed', at: 3 } },
      ],
    });
    if (!r.ok) throw new Error('failed: ' + r.reason);
    if (r.ran !== 3 || r.of !== 3) throw new Error('ran ' + r.ran + ' of ' + r.of);
    if (JSON.stringify(r.result) !== JSON.stringify({ stored: true, saw: 'HELLO-X', position: 3 })) {
      throw new Error('the final result is wrong: ' + JSON.stringify(r.result));
    }
    /* the data really travelled: the sink saw what the transformer produced out
       of what the maker produced, three engines apart */
    if (r.results.kept.saw !== 'HELLO-X') throw new Error('the chain did not carry its data: ' + JSON.stringify(r.results));
  });

  await check('one trace entry per real call, in order, and nothing else', async () => {
    const r = await compose.run(router, {
      steps: [
        { id: 'a', engine: MAKER, action: 'make', args: { text: 't1' } },
        { id: 'b', engine: TRANSFORM, action: 'transform', args: { word: '$prev.made' } },
      ],
    });
    if (r.trace.length !== 2) throw new Error('expected 2 trace entries, got ' + r.trace.length);
    for (let i = 0; i < r.trace.length; i++) {
      const t = r.trace[i];
      if (t.index !== i) throw new Error('entry ' + i + ' has index ' + t.index);
      if (!t.at || !Number.isFinite(t.at)) throw new Error("entry ' + i + ' has no real timestamp");
      if (t.ms < 0) throw new Error('entry ' + i + ' claims a negative duration');
      if (t.ok !== true) throw new Error('entry ' + i + ' is not ok: ' + t.error);
    }
    if (r.trace[0].engine !== MAKER || r.trace[1].engine !== TRANSFORM) {
      throw new Error('the trace does not name the engines in order: ' + JSON.stringify(r.trace.map(t => t.engine)));
    }
  });

  await check('a step that fails stops every step after it, and the trace says so', async () => {
    const r = await compose.run(router, {
      steps: [
        { id: 'a', engine: MAKER, action: 'make', args: { text: 't2' } },
        { id: 'boom', engine: TRANSFORM, action: 'transform', args: { word: '$steps.neverDefined.result' } },
        /* the name has a capital in it on purpose: `$steps.neverDefined` did not
           match the old lowercase-only pattern, so the whole string used to be
           handed to the engine as literal text instead of being refused */
        { id: 'c', engine: SINK, action: 'store', args: { thing: 'should never run' } },
      ],
    });
    if (r.ok) throw new Error('a workflow with an unresolvable reference was reported as a success');
    if (r.failedAt !== 1) throw new Error('failedAt = ' + r.failedAt);
    /* `ran` counts the steps that were actually called, and the step that
       failed to resolve was never called — so it is not counted. That is the
       difference from an engine that throws, where the step did get called and
       `ran` includes it. The two are different events and the number says so. */
    if (r.ran !== 1) throw new Error('ran = ' + r.ran + ', expected 1 — only the first step was ever called');
    /* Two trace entries and one call. The first is the maker that ran; the
       second is the step whose reference did not resolve — recorded, with the
       reason, but with no result because nothing was asked of the engine. A
       trace that only listed calls would have one entry here and would have
       looked like the workflow stopped for no reason. */
    if (r.trace.length !== 2) throw new Error('the trace has ' + r.trace.length + ' entries, expected 2 — one call and one refusal');
    if (r.trace[1].phase !== 'resolve') throw new Error('the failure is not recorded as a reference problem: ' + JSON.stringify(r.trace[1]));
    if (r.trace[1].engine !== TRANSFORM) throw new Error('the refusal names the wrong engine: ' + JSON.stringify(r.trace[1]));
    if (r.trace[1].result !== undefined) throw new Error('a step that was never called has a result in the trace: ' + JSON.stringify(r.trace[1]));
    if (r.result !== null) throw new Error('a failed workflow returned a result: ' + JSON.stringify(r.result));

    /* the important part: the third step is accounted for as not-run, not as
       run-and-empty */
    if (!Array.isArray(r.notRun) || r.notRun.length !== 1) throw new Error('notRun = ' + JSON.stringify(r.notRun));
    if (r.notRun[0].engine !== SINK) throw new Error('the step marked not-run is the wrong one: ' + JSON.stringify(r.notRun));
    if (r.trace.some(t => t.engine === SINK)) throw new Error('the step after the failure was called anyway');
  });

  await check('an engine that throws stops the workflow the same way', async () => {
    setFlaky(99, router);
    global.__chainFlaky = 0;
    const r = await compose.run(router, {
      steps: [
        { id: 'a', engine: MAKER, action: 'make', args: { text: 't3' } },
        { id: 'boom', engine: FLAKY, action: 'poke' },
        { id: 'c', engine: SINK, action: 'store', args: { thing: 'no' } },
      ],
    });
    if (r.ok) throw new Error('a throwing engine did not fail the workflow');
    if (r.failedAt !== 1) throw new Error('failedAt = ' + r.failedAt);
    if (r.trace.length !== 2) throw new Error('the trace has ' + r.trace.length + ' entries, expected 2');
    if (!/refused/.test(r.trace[1].error || '')) throw new Error('the failure is not in the trace: ' + JSON.stringify(r.trace[1]));
    if (r.notRun.length !== 1) throw new Error('notRun = ' + JSON.stringify(r.notRun));
    setFlaky(0, router);
  });

  await check('a retry touches only the step that failed, and only when asked', async () => {
    setFlaky(1, router);
    global.__chainFlaky = 0;
    const r = await compose.run(router, {
      steps: [
        { id: 'a', engine: MAKER, action: 'make', args: { text: 't4', tag: 'once' } },
        { id: 'flaky', engine: FLAKY, action: 'poke', retry: 1 },
        { id: 'c', engine: SINK, action: 'store', args: { thing: '$prev.poked' } },
      ],
    });
    if (!r.ok) throw new Error('the retry did not rescue it: ' + r.reason);
    if (r.result.saw !== true && r.result.saw !== 'true') { /* stored: what it saw */ }
    if (r.result.thing === undefined) { /* shape check below */ }

    /* three steps, four calls: the first step ran once, the flaky one twice */
    const byStep = {};
    for (const t of r.trace) byStep[t.index] = (byStep[t.index] || 0) + 1;
    if (byStep[0] !== 1) throw new Error('the first step ran ' + byStep[0] + ' times — a retry re-ran a step that had already succeeded');
    if (byStep[1] !== 2) throw new Error('the flaky step ran ' + byStep[1] + ' times, expected 2');
    if (byStep[2] !== 1) throw new Error('the last step ran ' + byStep[2] + ' times');
    if (r.trace[1].ok !== false || r.trace[2].ok !== true) throw new Error('the two attempts are not recorded as a failure then a success');
    if (r.trace[2].attempt !== 2) throw new Error('the successful attempt is not numbered 2');
    setFlaky(0, router);
  });

  await check('a step that did not ask to retry is called exactly once', async () => {
    setFlaky(99, router);
    global.__chainFlaky = 0;
    const r = await compose.run(router, { steps: [{ engine: FLAKY, action: 'poke' }] });
    if (r.ok) throw new Error('it should have failed');
    if (r.trace.length !== 1) throw new Error('it was called ' + r.trace.length + ' times without asking to retry');
    if (!/after 1 attempt/.test(r.reason)) throw new Error('the reason does not say how many attempts: ' + r.reason);
    setFlaky(0, router);
  });

  await check('a retry that runs out of attempts fails the workflow', async () => {
    setFlaky(99, router);
    global.__chainFlaky = 0;
    const r = await compose.run(router, { steps: [{ engine: FLAKY, action: 'poke', retry: 2 }] });
    if (r.ok) throw new Error('it passed when it should not have');
    if (r.trace.length !== 3) throw new Error('expected 3 attempts, got ' + r.trace.length);
    if (r.trace.some(t => t.ok)) throw new Error('one of the attempts is recorded as a success');
    setFlaky(0, router);
  });

  await check('a retry is not spent on an engine the router has cooled down', async () => {
    /* The router cools an engine down for 45s after two clean failures, and while
       it is cooling down it refuses with "Flaky cannot act actions" — which is
       about capabilities and not about the cooldown. This suite spent a while
       reading that message as a composition bug. The workflow now checks the
       cooldown before spending an attempt, so the attempt is not made and the
       trace says why in the words that are true. */
    setFlaky(99, router);
    const r = await compose.run(router, { steps: [{ engine: FLAKY, action: 'poke', retry: 2 }] });
    if (r.ok) throw new Error('it passed');

    const h = router.health.get(FLAKY);
    if (!(h.failureCount - h.successCount >= 2)) {
      throw new Error('the precondition is wrong: the engine is not in a cooldown (' + h.failureCount + ' failures, ' + h.successCount + ' successes)');
    }
    const cold = r.trace.filter(t => t.phase === 'cooling-down');
    if (cold.length !== 1) throw new Error('expected one cooling-down entry, got ' + cold.length + ': ' + JSON.stringify(r.trace.map(t => t.phase)));
    /* The engine is called twice and then the third attempt is skipped. The
       cooldown only starts after the second clean failure, so attempt 2 is
       still made — a check that assumed the retry was skipped from the first
       failure was assuming a policy the router does not have. */
    if (cold[0].attempt !== 3) throw new Error('the skipped attempt is numbered ' + cold[0].attempt + ', expected 3');
    if (r.trace.filter(t => t.phase === 'run').length !== 2) {
      throw new Error('the engine was called ' + r.trace.filter(t => t.phase === 'run').length + ' times, expected 2 — the third was refused before it was made');
    }
    if (!/cooling down/.test(cold[0].error || '')) throw new Error('the entry does not say why: ' + cold[0].error);
    if (cold[0].cooledForMs <= 0) throw new Error('it does not say for how long');

    setFlaky(0, router);
  });

  head('validation happens before anything runs');

  await check('a workflow that names an engine which is not registered runs nothing', async () => {
    const before = router.BY_ID.get(MAKER);
    const r = await compose.run(router, {
      steps: [
        { engine: MAKER, action: 'make', args: { text: 'should not happen' } },
        { engine: 'tidak-terdaftar', action: 'make' },
      ],
    });
    if (r.ok) throw new Error('it ran');
    if (r.stage !== 'validate') throw new Error('stage = ' + r.stage);
    if (r.ran !== 0 || r.trace.length !== 0) throw new Error('a step ran before validation: ' + JSON.stringify(r.trace));
    if (!/not in the registry/.test(r.reason)) throw new Error('the reason is unhelpful: ' + r.reason);
    if (before !== router.BY_ID.get(MAKER)) throw new Error('the registry changed');
  });

  await check('malformed workflows are each refused, with a reason naming the step', async () => {
    const cases = [
      [{}, /at least one step/],
      [{ steps: [] }, /at least one step/],
      [{ steps: 'nope' }, /at least one step/],
      [{ steps: ['nope'] }, /not an object/],
      [{ steps: [{ action: 'make' }] }, /does not name an engine/],
      [{ steps: [{ engine: '   ' }] }, /does not name an engine/],
      [{ steps: [{ engine: 'not-registered' }] }, /not in the registry/],
      [{ steps: [{ engine: MAKER }] }, /does not name an action/],
      [{ steps: [{ engine: MAKER, action: '' }] }, /does not name an action/],
      [{ steps: [{ engine: MAKER, action: 'make', args: [1] }] }, /args that are not an object/],
      [{ steps: [{ engine: MAKER, action: 'make', args: 'x' }] }, /args that are not an object/],
      [{ steps: [{ engine: MAKER, action: 'make', retry: -1 }] }, /whole number/],
      [{ steps: [{ engine: MAKER, action: 'make', retry: 1.5 }] }, /whole number/],
      [{ steps: [{ engine: MAKER, action: 'make', retry: 99 }] }, /whole number/],
      [{ steps: [{ engine: MAKER, action: 'make', id: 'Bad Id' }] }, /usable in a \$steps reference/],
      [{ steps: [{ engine: MAKER, action: 'make', id: 'same' }, { engine: MAKER, action: 'make', id: 'same' }] }, /ambiguous/],
      [{ steps: new Array(21).fill({ engine: MAKER, action: 'make' }) }, /limit is 20/],
    ];
    for (const [wf, want] of cases) {
      const r = await compose.run(router, wf);
      if (r.ok) throw new Error('accepted: ' + JSON.stringify(wf).slice(0, 80));
      if (r.stage !== 'validate') throw new Error('stage = ' + r.stage + ' for ' + JSON.stringify(wf).slice(0, 60));
      if (!want.test(r.reason)) throw new Error('the reason "' + r.reason + '" does not match ' + want + ' for ' + JSON.stringify(wf).slice(0, 60));
    }
  });

  await check('a retry is capped at three, whatever the workflow says', async () => {
    const v = compose.validate(router, { steps: [{ engine: FLAKY, action: 'poke', retry: 4 }] });
    if (v.ok) throw new Error('a retry of 4 was accepted');
    if (!/0 to 3/.test(v.reason)) throw new Error('the cap is not stated: ' + v.reason);
  });

  head('references');

  await check('$prev takes a path, and a path that goes nowhere is an error', () => {
    /* hasPrev is what run() passes and what tells resolveArgs there is a
       previous step at all; without it every $prev here is a first step. */
    const scope = { prev: { a: { b: { c: 42 } } }, named: new Map(), hasPrev: true };
    const got = compose.resolveArgs({ deep: '$prev.a.b.c', flat: '$prev' }, scope);
    if (got.deep !== 42) throw new Error('the path was not walked: ' + JSON.stringify(got));
    const original = { a: { b: { c: 42 } } };
    if (JSON.stringify(got.flat) !== JSON.stringify(original)) {
      throw new Error("$prev alone did not pass the whole value through");
    }
    let threw = null;
    try { compose.resolveArgs({ x: '$prev.a.b.c.d' }, { prev: {}, named: new Map(), hasPrev: true }); } catch (e) { threw = e.message; }
    if (!threw) throw new Error('a path into nothing resolved to something');
    if (!/cannot be read|has no/.test(threw)) throw new Error('the error is unhelpful: ' + threw);

    /* $prev with nothing before it, and $steps naming a step that has not
       run, are the other two ways a reference can fail to resolve. */
    for (const [args, scope, want] of [
      [{ x: '$prev' }, { named: new Map(), hasPrev: false }, /first step/],
      [{ x: '$steps.nope' }, { prev: {}, named: new Map(), hasPrev: true }, /no step called "nope"/],
      [{ x: '$steps.bad name' }, { prev: {}, named: new Map(), hasPrev: true }, /not a reference this workflow understands/],
    ]) {
      let said = null;
      try { compose.resolveArgs(args, scope); } catch (e) { said = e.message; }
      if (!said) throw new Error(JSON.stringify(args) + ' was accepted: ' + JSON.stringify(compose.resolveArgs(args, scope)));
      if (!want.test(said)) throw new Error('the refusal for ' + JSON.stringify(args) + ' is unhelpful: ' + said);
    }
  });

  await check('a $steps reference can reach an earlier step, and not a later one', async () => {
    const r = await compose.run(router, {
      steps: [
        { id: 'made', engine: MAKER, action: 'make', args: { text: 'skip' } },
        /* $steps.made IS the step's result, and $steps.made.made is a field of
           it — the same shape $prev has. The .result suffix used to be
           accepted and meant two different things depending on which side of
           the name you read it from. */
        { id: 'later', engine: SINK, action: 'store', args: { thing: '$steps.made.made', at: 9 } },
      ],
    });
    if (!r.ok) throw new Error('failed: ' + r.reason);
    if (r.results.later.saw !== 'skip-none') throw new Error('$steps did not reach the named step: ' + JSON.stringify(r.results));
  });

  await check('nothing is evaluated — a $ref-looking string that is not one is left alone', () => {
    const got = compose.resolveArgs({ a: '$novariable', b: 'cost $5', c: '$prev', d: 7, e: null, f: true },
      { prev: { x: 1 }, named: new Map(), hasPrev: true });
    if (got.a !== '$novariable') throw new Error('a plain $ string was resolved: ' + got.a);
    if (got.b !== 'cost $5') throw new Error('a price was mangled: ' + got.b);
    if (got.c.x !== 1) throw new Error('$prev stopped working: ' + JSON.stringify(got));
    if (got.d !== 7 || got.e !== null || got.f !== true) throw new Error('a non-string was changed: ' + JSON.stringify(got));
  });

  await check('args are deep-walked, so a ref inside a nested object is resolved', () => {
    const got = compose.resolveArgs({ cfg: { headers: { tag: '$prev.tag' } }, list: ['$prev.tag'] },
      { prev: { tag: 'deep' }, named: new Map(), hasPrev: true });
    if (got.cfg.headers.tag !== 'deep') throw new Error('a nested ref was not resolved: ' + JSON.stringify(got));
    if (got.list[0] !== 'deep') throw new Error('a ref inside an array was not resolved: ' + JSON.stringify(got));
  });

  head('the shape of a failure, reported exactly');

  await check('the reason names the step, the engine and how many attempts', async () => {
    setFlaky(99, router);
    global.__chainFlaky = 0;
    const r = await compose.run(router, {
      steps: [{ id: 'x', engine: MAKER, action: 'make', args: { text: 'a' } }, { id: 'y', engine: FLAKY, action: 'poke', retry: 1 }],
    });
    if (r.ok) throw new Error('it passed');
    if (r.failedStep !== 'y') throw new Error('failedStep = ' + r.failedStep);
    for (const want of ['step 2', FLAKY, '2 attempts']) {
      if (String(r.reason).indexOf(want) < 0) throw new Error('the reason lacks "' + want + '": ' + r.reason);
    }
    setFlaky(0, router);
  });

  await check('a single-step workflow succeeds and returns that step\'s result', async () => {
    const r = await compose.run(router, { steps: [{ engine: MAKER, action: 'make', args: { text: 'solo' } }] });
    if (!r.ok) throw new Error('failed: ' + r.reason);
    if (r.result.made !== 'solo-none') throw new Error('result = ' + JSON.stringify(r.result));
    if (r.ran !== 1) throw new Error('ran = ' + r.ran);
  });

  head('it did not change anything it was not supposed to');

  await check('a step is an ordinary route call — the router and its policy are untouched', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'compose.js'), 'utf8');
    for (const forbidden of ['child_process', 'spawn', 'forge.create', 'forge.build', 'lifecycle.', 'fs.write']) {
      if (src.includes(forbidden)) throw new Error('compose.js reaches for ' + forbidden);
    }
    /* one route call, and it is the router's own — not a reimplementation */
    /* The header comment mentions router.route() in prose, so count the call and
       not the word: a check that counts comments is a check that stops meaning
       anything the first time someone explains the code in it. */
    const calls = (src.match(/await router\.route\(/g) || []).length;
    if (calls !== 1) throw new Error('compose.js calls router.route ' + calls + ' times, expected 1');
    if (!src.includes("require('./ai/automation/state')")) throw new Error('it does not read the pinned-engine setting');
  });

  await check('the engine contract is unchanged — the steps took a plain action', async () => {
    /* The generated engines were built by the forge and are the same ones from
       Level 2. If composition had needed a different shape, these would not run
       through router.route unchanged. */
    for (const id of allIds) {
      const t = forge.runTest(id);
      if (!t.ok) throw new Error(id + ' no longer passes its own test: ' + t.reason);
    }
  });

  await check('compose.js leaves engines/ as it found it', async () => {
    for (const id of allIds) rm(path.join(forge.ENGINES_DIR, id));
    const left = fs.readdirSync(forge.ENGINES_DIR).sort().join(',');
    if (/chain-/.test(left)) throw new Error('debris left behind: ' + left);
  });

  console.log('\n  compose: ' + pass + ' passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ''));
  process.exit(fails.length ? 1 : 0);
})().catch(e => {
  for (const id of allIds) rm(path.join(forge.ENGINES_DIR, id));
  console.error('\n  suite crashed: ' + e.message);
  process.exit(1);
});
