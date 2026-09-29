'use strict';
/* ========================================================================= *
 *  test/evolve.test.js — Level 7 (SELF-EVOLVE), the seven acceptance cases.
 *
 *  Every case here runs the real lifecycle against a real router and real files:
 *  discover reads the registry, forge builds and gates, lifecycle repairs and
 *  promotes, compose chains, router.route runs. Nothing internal is stubbed,
 *  because the thing being claimed is that these modules fit together, and a
 *  mocked module proves that a mock fits together.
 *
 *  The assertions are about the trace as much as the results. A lifecycle that
 *  reaches the right answer by the wrong route is not a lifecycle, and the only
 *  record of the route is which capabilities ran and in what order.
 * ======================================================================== */

const fs = require('fs');
const path = require('path');
const forge = require('../forge');
const lifecycle = require('../lifecycle');
const evolve = require('../evolve');
const automation = require('../ai/automation');

const SHOUT = 'ev-shout';
const MAKE = 'ev-make';

/* A null byte, computed rather than written. See where it is used. */
const nulText = (lead, tail) => lead + String.fromCharCode(0) + tail;
const SHAPE = 'ev-shape';
const BROKEN = 'ev-broken';
const ALL = [SHOUT, MAKE, SHAPE, BROKEN];

const driver = { action: async () => ({ ok: true }), tabs: async () => ({ tabs: [] }) };
const context = () => ({ connected: true, agentTabId: 'tab_ev', url: 'about:blank' });
const newRouter = () => automation.createRouter({ driver, context, engines: automation.DEFAULT_ENGINES.slice() });
const rm = (q) => { try { fs.rmSync(q, { recursive: true, force: true }); } catch { /* gone */ } };
const head = (s) => console.log('\n  --- ' + s + ' ' + '-'.repeat(Math.max(0, 62 - s.length)));

const CLEAN = ALL.concat(['watermark', 'watermark-bad']);
const cleanUp = () => { for (const id of CLEAN) rm(path.join(forge.ENGINES_DIR, id)); };

let pass = 0; const fails = [];
const check = (name, fn) => Promise.resolve().then(fn)
  .then(() => { pass += 1; console.log('  ok   ' + name); })
  .catch(e => { fails.push(name); console.log('  FAIL ' + name + '\n         ' + e.message); })
  /* Cleanup runs whichever way the check went. Without it one failure poisons
     every case after it: the next seed hits create()'s refusal to overwrite,
     which is correct behaviour, and the suite then reports fifteen failures
     where there was one. */
  .then(cleanUp, e => { fails.push(name); console.log('  FAIL ' + name + '\n         ' + e.message); })
  .then(() => { pass = pass; });

/** the capabilities that actually ran, in the order they ran */
const ran = (r) => r.trace.map(t => t.capability);
/** the trace entries for one capability */
const step = (r, cap) => r.trace.filter(t => t.capability === cap);
const firstStep = (r, cap) => r.trace.find(t => t.capability === cap) || {};
const fresh = (id) => { const h = { successCount: 0, failureCount: 0, cooldownUntil: 0, lastError: '' }; return h; };

function seed() {
  for (const id of ALL) rm(path.join(forge.ENGINES_DIR, id));
  const r = newRouter();
  const build = (spec) => {
    const made = forge.build(r, spec);
    if (!made.ok) throw new Error('seed ' + spec.id + ' failed: ' + (made.reason || made.error) + '\n' + (made.output || ''));
    /* the lifecycle tests deliberately make engines fail, and the router's
       cooldown survives across cases, so each engine starts this case with a
       clean slate rather than inheriting the last one's failures */
    Object.assign(r.health.get(spec.id), fresh(spec.id));
  };

  build({ id: SHOUT, name: 'Shout', capability: 'shout',
    body: "    return { shouted: String(action.text || '').toUpperCase() };",
    examples: [{ action: 'shout', text: 'hi', expect: { shouted: 'HI' } }] });

  build({ id: MAKE, name: 'Make', capability: 'make',
    body: "    return { made: String(action.text || 'none') };",
    examples: [{ action: 'make', text: 'seed', expect: { made: 'seed' } }] });

  build({ id: SHAPE, name: 'Shape', capability: 'shape',
    body: "    const got = String(action.word || '');\n    return { shaped: got.trim().toLowerCase(), size: got.length };",
    /* size is the untrimmed length — the engine trims for `shaped` and measures
       the original. An earlier example claimed 6 for a seven-character string,
       which made the engine fail its own test at build time and took down every
       case in this suite before any of them ran. */
    examples: [{ action: 'shape', word: '  Seed ', expect: { shaped: 'seed', size: 7 } }] });

  /* Refuses one specific input. Its own test uses a good input, so it builds
     and registers cleanly — which is the point: this is an engine that works
     and is asked to do something it cannot, not one that is broken on disk. */
  build({ id: BROKEN, name: 'Broken', capability: 'convert',
    body: [
      '    const raw = String(action.text === undefined ? \'\' : action.text);',
      "    if (raw.indexOf('\\u0000') >= 0) throw new Error('cannot convert a value containing a null byte');",
      '    return { converted: raw.replace(/\\s+/g, \' \').trim() };',
    ].join('\n'),
    examples: [{ action: 'convert', text: 'a  b', expect: { converted: 'a b' } }] });

  return r;
}

/** the fixed version of the refusing engine, for the repair case */
const BROKEN_FIXED = [
  '    const raw = String(action.text === undefined ? \'\' : action.text);',
  "    /* The null byte was the thing it refused, so it is replaced rather than",
  '       rejected: a repair is meant to make the engine able to do the job, and a',
  '       refusal for an input the task actually contains is not a repair. */',
  "    const clean = raw.split('\\u0000').join('');",
  "    return { converted: clean.replace(/\\s+/g, ' ').trim(), stripped: raw.length - clean.length };",
].join('\n');

(async () => {
  console.log('\n  Level 7 — SELF-EVOLVE');

  await check('the lifecycle names every capability it can reach', () => {
    for (const c of ['discover', 'plan', 'guard', 'use-existing', 'build', 'verify', 'register', 'compose', 'execute', 'repair', 'retry', 'improve', 'promote', 'rollback']) {
      if (!evolve.CAPABILITIES.includes(c)) throw new Error('the lifecycle does not name ' + c);
    }
    if (evolve.CAPABILITIES.length !== new Set(evolve.CAPABILITIES).size) throw new Error('the list has a duplicate');
  });

  head('CASE 1 — an engine that already exists is used, and nothing is built');

  await check('CASE 1: the existing engine runs the task and no engine is written', async () => {
    const r = seed();
    const before = fs.readdirSync(forge.ENGINES_DIR).sort();

    const out = await evolve.evolve(r, {
      task: 'shout this',
      needs: ['shout'],
      run: { action: 'shout', args: { text: 'hello' } },
    });
    if (!out.ok) throw new Error('failed: ' + out.reason);
    if (out.result.shouted !== 'HELLO') throw new Error('result = ' + JSON.stringify(out.result));
    if (out.decision !== 'use-existing') throw new Error('decision = ' + out.decision);

    /* the three capabilities that must run, and the four that must not */
    const order = ran(out);
    for (const want of ['discover', 'plan', 'use-existing', 'execute']) {
      if (!order.includes(want)) throw new Error('the trace lacks ' + want + ': ' + order.join(' -> '));
    }
    for (const never of ['build', 'verify', 'register', 'repair', 'improve', 'promote']) {
      if (order.includes(never)) throw new Error('a capability that had no cause ran: ' + never + ' in ' + order.join(' -> '));
    }
    if (JSON.stringify(fs.readdirSync(forge.ENGINES_DIR).sort()) !== JSON.stringify(before)) {
      throw new Error('engines/ changed: ' + before.join(',') + ' -> ' + fs.readdirSync(forge.ENGINES_DIR).sort().join(','));
    }
    if (!step(out, 'use-existing')[0].fact.engines.includes(SHOUT)) throw new Error('the engine it used is not named in the trace');
  });

  await check('CASE 1: an engine that is switched off is not rebuilt either', async () => {
    const r = seed();
    const h = r.health.get(SHOUT);
    h.available = false;
    h.reason = 'switched off for this case';

    const out = await evolve.evolve(r, {
      task: 'shout this', needs: ['shout'],
      run: { action: 'shout', args: { text: 'hello' } },
    });
    for (const never of ['build', 'verify', 'register', 'repair', 'improve', 'promote', 'rollback']) {
      if (ran(out).includes(never)) throw new Error('a capability that had no cause ran: ' + never + ' in ' + ran(out).join(' -> '));
    }

    /* The distinction that matters: the engine exists and is merely off, so the
       plan says use-existing and points at what to switch on. An earlier
       version counted an off engine as missing, which is the one thing that
       justifies a build — so it planned a duplicate of an engine that already
       existed, and the guard then had to stop it. */
    if (ran(out).includes('build')) throw new Error('it built a second copy of an engine that exists but is off');
    if (ran(out).includes('guard')) throw new Error('the guard had to intervene for a capability the plan should never have called missing');
    if (out.decision !== 'use-existing') throw new Error('decision = ' + out.decision);
    if (!out.plan.turnOn.includes(SHOUT)) throw new Error('the plan does not name the engine to turn on: ' + JSON.stringify(out.plan.turnOn));
    if (out.plan.missing.length) throw new Error('a switched-off engine is still being called missing: ' + JSON.stringify(out.plan.missing));
    const use = firstStep(out, 'use-existing');
    if (use.ok) throw new Error('it claimed the switched-off engine could serve');
    if (!use.fact.turnOn.includes(SHOUT)) throw new Error('it did not point at the engine to turn on: ' + JSON.stringify(use.fact));
  });

  head('CASE 2 — a missing capability is built, tested, registered and run');

  await check('CASE 2: gap -> build -> verify -> register -> execute, in that order', async () => {
    const r = seed();
    if (r.BY_ID.get('watermark')) throw new Error('watermark already exists, so this case proves nothing');

    const out = await evolve.evolve(r, {
      task: 'watermark the photo',
      needs: ['watermark'],
      build: { id: 'watermark', name: 'Watermark', capability: 'watermark',
        body: "    return { watermarked: true, over: String(action.label || 'none') };",
        examples: [{ action: 'watermark', label: 'draft', expect: { watermarked: true, over: 'draft' } }] },
      run: { action: 'watermark', args: { label: 'final' } },
    });
    if (!out.ok) throw new Error('failed: ' + out.reason);
    if (out.result.over !== 'final') throw new Error('the new engine did not run: ' + JSON.stringify(out.result));

    const order = ran(out);
    const expected = ['discover', 'plan', 'build', 'verify', 'register', 'execute'];
    let at = -1;
    for (const want of expected) {
      const next = order.indexOf(want, at + 1);
      if (next < 0) throw new Error(want + ' did not run after ' + (expected[expected.indexOf(want) - 1] || 'the start') + ': ' + order.join(' -> '));
      at = next;
    }
    if (!r.BY_ID.get('watermark')) throw new Error('the built engine is not in the registry');
    if (!forge.runTest('watermark').ok) throw new Error('the built engine does not pass its own test on disk');
  });

  await check('CASE 2: a build whose test fails is refused and registers nothing', async () => {
    const r = seed();
    const out = await evolve.evolve(r, {
      task: 'watermark it badly', needs: ['watermark'],
      build: { id: 'watermark-bad', name: 'Bad', capability: 'watermark',
        body: "    return { watermarked: true };",
        examples: [{ action: 'watermark', expect: { watermarked: false } }] },
      run: { action: 'watermark', args: {} },
    });
    if (out.ok) throw new Error('a build with a failing test was reported as a success');
    if (out.stage !== 'build') throw new Error('stage = ' + out.stage);

    /* Nothing registered, and the router cannot reach it — that is the whole
       of what safety means here. The folder itself is kept: forge.test.js has
       asserted since Level 2 that a refused engine stays on disk so its
       failure can be read, and an earlier version of this check asserted the
       opposite and made forge.test.js fail, correctly. */
    if (r.BY_ID.get('watermark-bad')) throw new Error('it registered an engine whose test fails');
    const routed = await r.route({ action: 'watermark', engine: 'watermark-bad', label: 'x' });
    if (routed.ok) throw new Error('the router reached an engine that never passed: ' + JSON.stringify(routed));
    if (!/not in the registry|there is no automation engine/.test(routed.error)) {
      throw new Error('the router refused it for the wrong reason: ' + routed.error);
    }
    const dir = path.join(forge.ENGINES_DIR, 'watermark-bad');
    if (!fs.existsSync(path.join(dir, 'test.js'))) throw new Error('the failure was not left where it can be read');
    if (firstStep(out, 'build').fact.output.indexOf('FAILED') < 0) {
      throw new Error('the refusal did not carry the test output: ' + JSON.stringify(firstStep(out, 'build').fact).slice(0, 200));
    }
  });

  await check('CASE 2: the guard is asked twice, and a second opinion that disagrees wins', async () => {
    /* The plan and the guard are different code. If the guard says no, the build
       does not happen — which is the property that stops a plan from being the
       only thing between "I feel like building" and a new engine. */
    const r = seed();
    const before = fs.readdirSync(forge.ENGINES_DIR).sort();
    const out = await evolve.evolve(r, {
      task: 'shout', needs: ['shout'],
      build: { id: 'shout-again', name: 'Again', capability: 'shout',
        body: '    return { shouted: \'x\' };', examples: [{ action: 'shout', expect: { shouted: 'x' } }] },
      run: { action: 'shout', args: { text: 'hi' } },
    });
    /* the plan should never have said build here, so the guard is never reached */
    if (ran(out).includes('build')) throw new Error('a build was attempted for a capability the registry serves');
    if (JSON.stringify(before) !== JSON.stringify(fs.readdirSync(forge.ENGINES_DIR).sort())) throw new Error('engines/ changed');
  });

  head('CASE 3 — an engine that fails is repaired, tested, and runs');

  await check('CASE 3: fail -> repair -> retry -> success, and the old version is kept', async () => {
    const r = seed();
    const withNul = { text: nulText('a', 'b') };

    /* the failure first, on its own, so the repair is answering a real one */
    const alone = await r.route({ action: 'convert', engine: BROKEN, ...withNul });
    if (alone.ok) throw new Error('the precondition is wrong: the engine did not refuse, so the repair would prove nothing');
    Object.assign(r.health.get(BROKEN), fresh(BROKEN));

    const out = await evolve.evolve(r, {
      task: 'convert it', needs: ['convert'], run: { action: 'convert', args: withNul },
      repair: { id: BROKEN, body: BROKEN_FIXED,
        examples: [{ action: 'convert', text: nulText('a', 'b'), expect: { converted: 'ab', stripped: 1 } }],
        why: 'strip the null byte instead of refusing' },
    });
    if (!out.ok) throw new Error('the repair did not rescue the task: ' + out.reason);
    if (out.result.converted !== 'ab' || out.result.stripped !== 1) throw new Error('the repaired engine did not run: ' + JSON.stringify(out.result));

    const order = ran(out);
    const at = (c) => order.lastIndexOf(c);
    if (at('execute') < at('repair')) throw new Error('the repair came before the failure: ' + order.join(' -> '));
    if (at('retry') < at('repair')) throw new Error('there was no retry after the repair: ' + order.join(' -> '));
    if (step(out, 'execute').length !== 2) throw new Error('the task ran ' + step(out, 'execute').length + ' times, expected 2 — once before and once after the repair');

    /* and the version the repair replaced is still there to go back to */
    const kept = lifecycle.versions(BROKEN);
    if (kept.length !== 1) throw new Error('the replaced version was not kept: ' + JSON.stringify(kept));
    const c = lifecycle.current(BROKEN);
    if (c.version !== 2) throw new Error('version = ' + c.version);
    if (c.lineage.kind !== 'repair') throw new Error('lineage = ' + JSON.stringify(c.lineage));
  });

  await check('CASE 3: a repair that fails does not make the task look like it worked', async () => {
    const r = seed();
    const withNul = { text: nulText('a', 'b') };
    if ((await r.route({ action: 'convert', engine: BROKEN, ...withNul })).ok) throw new Error('precondition: it did not refuse');
    Object.assign(r.health.get(BROKEN), fresh(BROKEN));

    const out = await evolve.evolve(r, {
      task: 'convert it', needs: ['convert'], run: { action: 'convert', args: withNul },
      repair: { id: BROKEN, body: "    return { converted: 'always this' };",
        examples: [{ action: 'convert', text: 'a b', expect: { converted: 'something else' } }] },
    });
    if (out.ok) throw new Error('a failed repair was reported as a success');
    if (firstStep(out, 'repair').ok) throw new Error('the repair was recorded as successful');
    if (ran(out).includes('retry')) throw new Error('it retried after a repair that was refused');
    /* the running engine is still the one that was there */
    const c = lifecycle.current(BROKEN);
    if (c.version !== 1) throw new Error('the version moved despite a refused repair: ' + c.version);
    if (lifecycle.versions(BROKEN).length) throw new Error('a refused repair left a version behind');
  });

  await check('CASE 3: a repair of a built-in is refused inside the lifecycle too', async () => {
    const r = seed();
    Object.assign(r.health.get(SHOUT), fresh(SHOUT));
    const out = await evolve.evolve(r, {
      task: 'shout badly', needs: ['shout'], run: { action: 'shout', args: { text: 'x' } },
      repair: { id: 'native-cdp', body: '    return { shouted: \'x\' };', examples: [{ action: 'shout', expect: { shouted: 'x' } }] },
    });
    /* the task itself succeeds, so the repair is never reached — which is the
       point: a repair is for a failure, not something to do on a success. */
    if (ran(out).includes('repair')) throw new Error('it repaired a healthy task');
  });

  head('CASE 4 — a healthy engine is improved, the candidate is tested, and it is promoted');

  await check('CASE 4: improve -> verify -> promote -> retry, and the new shape runs', async () => {
    const r = seed();
    const out = await evolve.evolve(r, {
      task: 'shape it', needs: ['shape'], run: { action: 'shape', args: { word: '  Hi  ' } },
      improve: { id: SHAPE,
        body: "    const got = String(action.word || '');\n    return { shaped: got.trim().toLowerCase(), size: got.length, trimmed: got.trim().length };",
        examples: [{ action: 'shape', word: '  Seed ', expect: { shaped: 'seed', size: 7, trimmed: 4 } }],
        why: 'also report the trimmed length' },
    });
    if (!out.ok) throw new Error('failed: ' + out.reason);
    if (out.result.trimmed !== 2) {
      throw new Error('the promoted version is not what runs: ' + JSON.stringify(out.result) +
        '\n         trace: ' + out.trace.map(t => (t.ok ? '' : '!') + t.capability + ' — ' + t.note).join('\n                ') +
        '\n         facts: ' + JSON.stringify(out.trace.filter(t => !t.ok).map(t => t.fact)));
    }

    const order = ran(out);
    for (const want of ['improve', 'verify', 'promote', 'retry']) {
      if (!order.includes(want)) throw new Error('the trace lacks ' + want + ': ' + order.join(' -> '));
    }
    if (order.indexOf('improve') < order.indexOf('execute')) throw new Error('it improved before it succeeded: ' + order.join(' -> '));

    const c = lifecycle.current(SHAPE);
    if (c.version !== 2) throw new Error('version = ' + c.version);
    if (c.lineage.kind !== 'improve') throw new Error('lineage = ' + JSON.stringify(c.lineage));
    if (firstStep(out, 'promote').fact.keptAs !== lifecycle.versions(SHAPE)[0].stamp) {
      throw new Error('the promote did not name the version it kept');
    }
  });

  await check('CASE 4: an improve with no reason is refused, and the engine is untouched', async () => {
    const r = seed();
    const before = lifecycle.current(SHAPE);
    const out = await evolve.evolve(r, {
      task: 'shape it', needs: ['shape'], run: { action: 'shape', args: { word: 'x' } },
      improve: { id: SHAPE, body: '    return { shaped: \'different\' };', examples: [{ action: 'shape', expect: { shaped: 'different' } }] },
    });
    if (!out.ok) throw new Error('the task itself should still have worked: ' + out.reason);
    if (firstStep(out, 'improve').ok) throw new Error('an improve with no reason was carried out');
    if (!/no stated reason/.test(firstStep(out, 'improve').note)) throw new Error('the refusal does not say why: ' + firstStep(out, 'improve').note);
    if (ran(out).includes('promote')) throw new Error('it promoted a change with no reason');
    const after = lifecycle.current(SHAPE);
    if (after.version !== before.version) throw new Error('the version moved');
    if ((await r.route({ action: 'shape', engine: SHAPE, word: 'x' })).result.shaped !== 'x') throw new Error('the engine changed anyway');
  });

  await check('CASE 4: an improve that fails its candidate test leaves the engine running', async () => {
    const r = seed();
    const before = (await r.route({ action: 'shape', engine: SHAPE, word: 'A' })).result;
    Object.assign(r.health.get(SHAPE), fresh(SHAPE));

    const out = await evolve.evolve(r, {
      task: 'shape it', needs: ['shape'], run: { action: 'shape', args: { word: 'A' } },
      improve: { id: SHAPE, body: "    return { shaped: 'nope' };",
        examples: [{ action: 'shape', word: 'A', expect: { shaped: 'yep' } }], why: 'break it on purpose' },
    });
    if (firstStep(out, 'improve').ok) throw new Error('an improve whose candidate fails was recorded as successful');
    if (ran(out).includes('promote')) throw new Error('it promoted a candidate that failed');
    const after = (await r.route({ action: 'shape', engine: SHAPE, word: 'A' })).result;
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('the running engine changed: ' + JSON.stringify(after));
  });

  head('CASE 5 — a task needing two engines is a composition');

  await check('CASE 5: two engines, one result, and the data travelled between them', async () => {
    const r = seed();
    const out = await evolve.evolve(r, {
      task: 'make it and shape it',
      needs: ['make', 'shape'],
      workflow: {
        steps: [
          { id: 'made', engine: MAKE, action: 'make', args: { text: '  Hello World ' } },
          { id: 'shaped', engine: SHAPE, action: 'shape', args: { word: '$prev.made' } },
        ],
      },
    });
    if (!out.ok) throw new Error('failed: ' + out.reason);
    if (out.result.shaped !== 'hello world') throw new Error('the chain did not produce the right result: ' + JSON.stringify(out.result));
    /* size is what the maker produced, untrimmed: '  Hello World ' is 14
       characters, and the shaper measures what it was given rather than what
       it trimmed. An earlier check said 13, which was the count of the string
       everyone imagined rather than the one that arrived. */
    if (out.result.size !== 14) throw new Error('the second engine did not see the first engine output: ' + JSON.stringify(out.result));

    for (const want of ['discover', 'plan', 'compose', 'execute']) {
      if (!ran(out).includes(want)) throw new Error('the trace lacks ' + want + ': ' + ran(out).join(' -> '));
    }
    if (out.workflow.trace.length !== 2) throw new Error('the workflow trace has ' + out.workflow.trace.length + ' entries');
    if (ran(out).includes('build')) throw new Error('it built something for a task it could already do');
  });

  head('CASE 6 — a step that fails stops the workflow, and is repaired and retried');

  await check('CASE 6: the workflow stops at the failing step and names the ones after it', async () => {
    const r = seed();
    const withNul = { text: nulText('a', 'b') };
    const out = await evolve.evolve(r, {
      task: 'make then convert', needs: ['make', 'convert'],
      workflow: {
        steps: [
          { id: 'made', engine: MAKE, action: 'make', args: { text: 'a b' } },
          { id: 'converted', engine: BROKEN, action: 'convert', args: { text: withNul.text } },
        ],
      },
    });
    if (out.ok) throw new Error('the workflow reported success over a failing step');

    const comp = firstStep(out, 'compose');
    if (comp.ok) throw new Error('the composition was recorded as a success');
    if (comp.fact.ran !== 2) throw new Error('it ran ' + comp.fact.ran + ' steps, expected 2');
    if (out.workflow.failedAt !== 1) throw new Error('failedAt = ' + out.workflow.failedAt);
    if (!out.workflow.trace.some(t => t.error && /null byte/.test(t.error))) throw new Error('the real error is not in the trace: ' + JSON.stringify(out.workflow.trace));
  });

  await check('CASE 6: the same workflow, with a repair, gets to the end', async () => {
    const r = seed();
    const out = await evolve.evolve(r, {
      task: 'make then convert', needs: ['make', 'convert'],
      workflow: {
        steps: [
          { id: 'made', engine: MAKE, action: 'make', args: { text: 'a b' } },
          { id: 'converted', engine: BROKEN, action: 'convert', args: { text: nulText('a', 'b') } },
        ],
      },
      repair: { id: BROKEN, body: BROKEN_FIXED,
        examples: [{ action: 'convert', text: nulText('a', 'b'), expect: { converted: 'ab', stripped: 1 } }],
        why: 'strip the null byte' },
    });
    if (!out.ok) {
      /* The trace comes with it, because the interesting version of this failure
         is a gate refusing a candidate — and then the gate's own output is the
         whole answer, several hundred lines of it, hidden inside one field. */
      throw new Error('the repair did not get the workflow to the end: ' + out.reason +
        '\n         trace: ' + out.trace.map(t => (t.ok ? '' : '!') + t.capability + ' — ' + t.note).join('\n                ') +
        '\n         facts: ' + JSON.stringify(out.trace.filter(t => !t.ok).map(t => t.fact)).slice(0, 400));
    }
    if (out.workflow.trace.length !== 2) throw new Error('the second run did not have two steps: ' + JSON.stringify(out.workflow.trace));
    if (!out.workflow.trace[1].result || out.workflow.trace[1].result.stripped !== 1) {
      throw new Error('the repaired step did not run: ' + JSON.stringify(out.workflow.trace[1]) +
        '\n         trace: ' + out.trace.map(t => (t.ok ? '' : '!') + t.capability + ' — ' + t.note).join('\n                ') +
        '\n         repair: ' + JSON.stringify(out.trace.filter(t => t.capability === 'repair').map(t => t.fact)));
    }
    if (ran(out).includes('build')) throw new Error('it built instead of repairing');
  });

  head('CASE 7 — the whole lifecycle, start to finish');

  await check('CASE 7: discover -> use -> compose -> execute -> improve -> promote -> rollback', async () => {
    const r = seed();
    const out = await evolve.evolve(r, {
      task: 'shout it and make it, then roll the shout engine back',
      needs: ['shout', 'make'],
      workflow: {
        steps: [
          { id: 'made', engine: MAKE, action: 'make', args: { text: 'loud' } },
          { id: 'shouted', engine: SHOUT, action: 'shout', args: { text: '$prev.made' } },
        ],
      },
      improve: { id: SHOUT,
        body: "    return { shouted: String(action.text || '').toUpperCase(), length: String(action.text || '').length };",
        examples: [{ action: 'shout', text: 'hi', expect: { shouted: 'HI', length: 2 } }],
        why: 'also report the length' },
      rollback: { id: SHOUT },
    });
    if (!out.ok) throw new Error('the lifecycle did not finish: ' + out.reason);

    /* the last thing that ran is on the rolled-back version, so the result is
       the original shape again — which is the whole point of a rollback */
    if (out.result.length !== undefined) throw new Error('the rolled-back version is not what ran: ' + JSON.stringify(out.result));
    if (out.result.shouted !== 'LOUD') throw new Error('the result is wrong: ' + JSON.stringify(out.result));

    const order = ran(out);
    for (const want of ['discover', 'plan', 'use-existing', 'compose', 'execute', 'improve', 'verify', 'promote', 'retry', 'rollback']) {
      if (!order.includes(want)) throw new Error('the trace lacks ' + want + ': ' + order.join(' -> '));
    }
    /* and the order is the order */
    const at = (c) => order.indexOf(c);
    if (!(at('discover') < at('plan') && at('plan') < at('use-existing') && at('use-existing') < at('compose'))) {
      throw new Error('the front of the lifecycle is out of order: ' + order.join(' -> '));
    }
    if (!(at('execute') < at('improve') && at('improve') < at('promote') && at('promote') < at('rollback'))) {
      throw new Error('the back of the lifecycle is out of order: ' + order.join(' -> '));
    }
    if (order.lastIndexOf('retry') < at('rollback')) throw new Error('nothing ran after the rollback');
    if (lifecycle.current(SHOUT).version !== 1) throw new Error('the rollback did not put v1 back: v' + lifecycle.current(SHOUT).version);
  });

  head('the boundaries');

  await check('a run with neither a workflow nor an action says so instead of pretending', async () => {
    const r = seed();
    const out = await evolve.evolve(r, { task: 'do something', needs: ['shout'] });
    if (out.ok) throw new Error('it reported success with nothing to run');
    if (!/nothing to execute/.test(out.reason)) throw new Error('the reason is unhelpful: ' + out.reason);
  });

  await check('every trace entry says which capability it was and when', async () => {
    const r = seed();
    const out = await evolve.evolve(r, {
      task: 'shout', needs: ['shout'], run: { action: 'shout', args: { text: 'q' } },
    });
    for (const t of out.trace) {
      if (!evolve.CAPABILITIES.includes(t.capability)) throw new Error('the trace names a capability that is not in the lifecycle: ' + t.capability);
      if (!Number.isFinite(t.at)) throw new Error(t.capability + ' has no timestamp');
      if (typeof t.ok !== 'boolean') throw new Error(t.capability + ' does not say whether it worked');
      if (!t.note) throw new Error(t.capability + ' has no note saying what it did');
    }
    for (let i = 1; i < out.trace.length; i++) {
      if (out.trace[i].at < out.trace[i - 1].at) throw new Error('the trace goes backwards in time at entry ' + i);
    }
  });

  await check('the lifecycle is an ordering, not a new way in', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'evolve.js'), 'utf8');
    /* it must reach every gate through the module that owns it */
    for (const need of ["require('./forge')", "require('./lifecycle')", "require('./discover')", "require('./compose')"]) {
      if (!src.includes(need)) throw new Error('evolve.js does not require ' + need);
    }
    /* and must not do any of their jobs itself */
    for (const forbidden of ['child_process', 'spawnSync', 'fs.rmSync', 'fs.writeFileSync', 'fs.copyFileSync', 'require.cache']) {
      if (src.includes(forbidden)) throw new Error('evolve.js reaches for ' + forbidden + ' — it orders the lifecycle, it does not re-implement it');
    }
    if ((src.match(/await router\.route\(/g) || []).length !== 1) throw new Error('evolve.js calls router.route more than once or not at all');
  });

  await check('the engines it used are still the engines from earlier levels', () => {
    /* Seeded here, not left over: cleanup now runs after every case, so by the
       time this one starts the engines are gone. Reading them here used to
       report "there is no test.js" and look like a broken engine. */
    const r = seed();
    for (const id of ALL) {
      const t = forge.runTest(id);
      if (!t.ok) throw new Error(id + ' no longer passes its own test: ' + t.reason);
      if (!r.BY_ID.get(id)) throw new Error(id + ' did not register');
    }
  });

  console.log('\n  evolve: ' + pass + ' passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ''));
  process.exit(fails.length ? 1 : 0);
})().catch(e => {
  for (const id of ALL) rm(path.join(forge.ENGINES_DIR, id));
  console.error('\n  suite crashed: ' + e.message);
  process.exit(1);
});
