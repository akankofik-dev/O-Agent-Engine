'use strict';
/* ====================================================================== *
 *  forge.test.js — the agent builds an engine, and the router uses it.
 *
 *  This is the acceptance test for one claim and nothing else:
 *
 *      an agent can notice a capability nobody has,
 *      write an engine that provides it,
 *      watch that engine's own test decide whether it is allowed in,
 *      and then get work routed to it — with the router, the engine
 *      contract, native-cdp and the Workbench untouched.
 *
 *  Two things make it a real test rather than a demonstration.
 *
 *  The router under test is the real one. `createRouter` is called exactly as
 *  server.js calls it, `route()` picks the engine through the same rank() and
 *  the same manual() pin, and the action is the shape the agent's own browser
 *  tools produce. If the generated engine only worked against a stand-in
 *  router, this would pass and the product would not.
 *
 *  The refusal half is the half that matters. Building an engine that fails
 *  its test, or that lies about what it did, or that exits zero without
 *  running anything, and then proving the router cannot reach it — that is
 *  what makes "if the test passes, register" a property of the code and not a
 *  promise in a comment.
 * ====================================================================== */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const forge = require('../forge');
const automation = require('../ai/automation');

const ECHO = 'echo-engine';
const BROKEN = 'liar-engine';
const ECHO_DIR = path.join(forge.ENGINES_DIR, ECHO);

/* the body the agent writes for the echo engine. It is a string in this test
   exactly as it would be a string if an LLM produced it — nothing here
   requires the body to be anything other than source text. */
/* No gate on action.action. The engine declares capabilities ['echo','act'] and
 * the router classifies a bare { text: '...' } as an act, so refusing one would
 * mean refusing work the engine had already said it could do — which is what
 * the first version of this file did, and its own test missed it because every
 * example carried the field it insisted on. */
const ECHO_BODY = [
  '    const a = action || {};',
  '    return { echoed: String(a.text === undefined ? \'\' : a.text) };',
].join('\n');

/* an engine that does insist, so the run-time failure path is tested against a
 * real gate rather than against an engine that accepts everything */
const FUSSY_BODY = [
  '    const a = action || {};',
  '    if (a.action !== \'echo\') throw new Error(ID + \' handles only the "echo" action, got "\' + a.action + \'"\');',
  '    return { echoed: String(a.text === undefined ? \'\' : a.text) };',
].join('\n');

/* an engine that loads, satisfies the contract, and answers with the wrong
   thing. This is the one that must never reach the router. */
const LIAR_BODY = '    return { echoed: 42 };';

/* The driver and the context are the router's two dependencies. They are
   stubs, and they have to be: a real Chrome connection would make this a test
   that fails when the user closes a window. The engine under test never
   touches either — that is the point of the contract, and the generated test
   checks it holds. */
const driver = {
  action: async a => ({ ok: true, action: a }),
  tabs: async () => ({ tabs: [] }),
};
const context = () => ({ connected: true, agentTabId: 'tab_forge', url: 'about:blank' });

/** a router built exactly the way server.js builds one, over a private copy of
 *  the shipped registry so a registration in this file cannot leak into the
 *  module-level default */
function newRouter() {
  return automation.createRouter({ driver, context, engines: automation.DEFAULT_ENGINES.slice() });
}

let pass = 0;
const fails = [];
function check(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass += 1; console.log('  ok   ' + name); })
    .catch(e => { fails.push(name); console.log('  FAIL ' + name + '\n         ' + e.message); });
}

/** the controller a tool is handed, and the only door engine_execute may use */
function controllerFor(router) {
  const seen = [];
  const ctx = {
    browser: {
      /* the two things agentController's action does on the way out, because
         a stub that skips them answers a different question: it returns the
         router's envelope where the product returns the engine's result, and
         it swallows refusals the product turns into a throw. */
      action: async (body) => {
        seen.push(body);
        const out = await router.route(body);
        if (out && out.ok === false) throw new Error(out.error);
        return out && Object.prototype.hasOwnProperty.call(out, 'result') ? out.result : out;
      },
    },
    shell: { exec: async () => { throw new Error('the shell was used'); } },
  };
  ctx.seen = seen;
  return ctx;
}

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* nothing to remove */ } }

(async () => {
  /* start from a known state, so a second run of this suite is the same run */
  rm(ECHO_DIR);
  rm(path.join(forge.ENGINES_DIR, BROKEN));
  fs.mkdirSync(forge.ENGINES_DIR, { recursive: true });

  const router = newRouter();

  console.log('\n  --- the nine steps ------------------------------------');

  /* 1 */
  await check('1. the agent can see which engines exist', () => {
    const s = forge.survey();
    const ids = s.engines.map(e => e.id);
    for (const want of ['native-cdp', 'playwright-mcp', 'stagehand', 'browser-use']) {
      if (!ids.includes(want)) throw new Error('the survey did not report ' + want + ' — it reported ' + ids.join(', '));
    }
    if (s.enginesDir !== forge.ENGINES_DIR) throw new Error('the survey does not say where it writes');
  });

  /* 2 */
  await check('2. the agent can tell that the "echo" capability does not exist yet', () => {
    const s = forge.survey();
    if (s.capabilities.includes('echo')) {
      throw new Error('"echo" is already in the capability set (' + s.capabilities.join(', ') + ') — the premise of this test is gone');
    }
    /* and the router agrees: nothing it can route today claims echo */
    for (const e of automation.DEFAULT_ENGINES) {
      if ((e.capabilities || []).includes('echo')) throw new Error(e.id + ' already claims echo');
    }
  });

  /* 3 + 4 + 5 + 6, driven as one build, because the order is the point */
  let built = null;
  await check('3-6. the agent writes manifest + implementation + test, the test passes, and only then is it registered', () => {
    built = forge.build(router, {
      id: ECHO,
      name: 'Echo',
      capability: 'echo',
      body: ECHO_BODY,
      examples: [
        { action: 'echo', text: 'halo dari agent', expect: { echoed: 'halo dari agent' } },
        { text: 'halo lokal', expect: { echoed: 'halo lokal' } },
        { action: 'echo', text: '', expect: { echoed: '' } },
      ],
    });
    if (!built.ok) throw new Error('build refused: ' + (built.reason || built.error) + (built.output ? '\n' + built.output : ''));
    if (!built.registered) throw new Error('the engine passed but was not registered');

    for (const f of ['manifest.json', 'index.js', 'test.js']) {
      if (!fs.existsSync(path.join(ECHO_DIR, f))) throw new Error('the agent did not write ' + f);
    }
    const m = JSON.parse(fs.readFileSync(path.join(ECHO_DIR, 'manifest.json'), 'utf8'));
    if (m.id !== ECHO || m.capability !== 'echo') throw new Error('the manifest is not about this engine: ' + JSON.stringify(m));

    /* and the test is a real run, not a file that exists */
    const verdict = forge.runTest(ECHO);
    if (!verdict.ok) throw new Error('the generated test does not pass on its own: ' + verdict.reason + '\n' + verdict.output);
    if (!/passed/.test(verdict.output)) throw new Error('the test produced no pass count: ' + verdict.output);
  });

  /* 6, from the router's side */
  await check('6. the router now lists the generated engine, described like any other', () => {
    const d = router.describe();
    const row = d.engines.find(e => e.id === ECHO);
    if (!row) throw new Error('the router does not see ' + ECHO + ' — it sees ' + d.engines.map(e => e.id).join(', '));
    if (!row.enabled) throw new Error('the generated engine is not enabled by default — register added it without a user preference and it should still route');
    if (!router.BY_ID.has(ECHO)) throw new Error('the router cannot find it by id');
  });

  /* 7 + 8 */
  await check('7-8. the agent calls the engine through the router and gets the echo back', async () => {
    const r = await router.route({ action: 'echo', text: 'halo dari agent', engine: ECHO });
    if (!r.ok) throw new Error('the router refused: ' + r.error);
    if (r.engine !== ECHO) throw new Error('the router chose ' + r.engine + ', not the generated engine');
    if (!r.result || r.result.echoed !== 'halo dari agent') {
      throw new Error('the engine returned ' + JSON.stringify(r.result));
    }
  });

  /* 8 again, on the second example, so the answer is a fact about the engine
     and not one hand-fed case */
  await check('8. the echo is correct on a second, different input', async () => {
    const r = await router.route({ action: 'echo', text: 'dua', engine: ECHO });
    if (!r.ok || r.result.echoed !== 'dua') throw new Error('got ' + JSON.stringify(r));
  });

  /* 9 */
  await check('9. an engine whose test fails is NOT registered, and the router cannot reach it', async () => {
    const bad = forge.build(router, {
      id: BROKEN,
      name: 'Liar',
      capability: 'echo',
      body: LIAR_BODY,
      examples: [{ action: 'echo', text: 'halo', expect: { echoed: 'halo' } }],
    });
    if (bad.ok) throw new Error('an engine that failed its test was registered anyway — the gate is not a gate');
    if (bad.registered) throw new Error('the refusal still says registered');
    if (bad.stage !== 'test') throw new Error('it should have failed at the test stage, not at ' + bad.stage);
    if (!/FAIL/.test(bad.output || '')) throw new Error('the refusal did not carry the test output that explains it: ' + JSON.stringify(bad.output));

    if (router.BY_ID.has(BROKEN)) throw new Error('the router has it in BY_ID');
    if (router.ENGINES.some(e => e.id === BROKEN)) throw new Error('the router has it in ENGINES');
    const d = router.describe();
    if (d.engines.some(e => e.id === BROKEN)) throw new Error('the router still describes it');

    /* and a call by name is refused by the router itself, not just absent */
    const r = await router.route({ action: 'echo', text: 'halo', engine: BROKEN });
    if (r.ok) throw new Error('the router routed to an unregistered engine: ' + JSON.stringify(r));
    if (!/no automation engine called/.test(r.error || '')) throw new Error('unexpected refusal: ' + r.error);
  });

  /* the failed engine is still on disk, because losing it would lose the only
     thing that explains the refusal */
  await check('9. the refused engine is kept on disk, so its failure can be read and fixed', () => {
    if (!fs.existsSync(path.join(forge.ENGINES_DIR, BROKEN, 'test.js'))) {
      throw new Error('the failing engine was deleted — a person cannot fix what they cannot see');
    }
  });

  console.log('\n  --- the gate cannot be walked around --------------------');

  await check('register() refuses an engine that has no test at all', () => {
    const dir = path.join(forge.ENGINES_DIR, 'silent-engine');
    rm(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: 'silent-engine', name: 'Silent', capability: 'echo', contract: forge.REQUIRED, examples: [] }));
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = { id: "silent-engine", name: "Silent", type: "generated", capabilities: ["echo","act"], available: async () => ({available:true}), execute: async () => ({}), observe: async () => ({}), recover: async () => ({}) };\n');
    const r = forge.register(router, 'silent-engine');
    rm(dir);
    if (r.ok) throw new Error('an engine with no test was registered');
    if (!/no test\.js/.test(r.reason || '')) throw new Error('unexpected reason: ' + r.reason);
  });

  await check('register() refuses a test that exits 0 without running anything', () => {
    /* The case a naive "exit code 0 means pass" gate waves through. A `node`
       that dies before executing anything also exits 0, and so does a test
       file someone emptied. The forge asks for a pass count, not for a
       non-crash. */
    const id = 'exit-zero-engine';
    const dir = path.join(forge.ENGINES_DIR, id);
    rm(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: 'Exit Zero', capability: 'echo', contract: forge.REQUIRED, examples: [] }));
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = { id: ' + JSON.stringify(id) + ', name: "Exit Zero", type: "generated", capabilities: ["echo","act"], available: async () => ({available:true}), execute: async () => ({}), observe: async () => ({}), recover: async () => ({}) };\n');
    fs.writeFileSync(path.join(dir, 'test.js'), 'process.exit(0);\n');

    const r = forge.register(router, id);
    rm(dir);
    if (r.ok) throw new Error('a test that printed no result was believed');
    if (!/no pass count/.test(r.reason || '')) throw new Error('unexpected reason: ' + r.reason);
  });

  await check('a passing test is not enough — the contract is checked too', () => {
    /* The case a test-only gate waves through, and the more important of the
       two. This engine ships a test that genuinely passes and genuinely exits
       zero, and the engine it tests has no execute() — so the test it shipped
       is the very thing that missed the problem. The forge checks the object
       the router will actually call, not the engine's opinion of itself. */
    const id = 'no-execute-engine';
    const dir = path.join(forge.ENGINES_DIR, id);
    rm(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: 'No Execute', capability: 'echo', contract: forge.REQUIRED, examples: [] }));
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = { id: ' + JSON.stringify(id) + ', name: "No Execute", type: "generated", capabilities: ["echo","act"], available: async () => ({available:true}), observe: async () => ({}), recover: async () => ({}) };\n');
    fs.writeFileSync(path.join(dir, 'test.js'), 'console.log("  3 passed");\nprocess.exit(0);\n');

    const r = forge.register(router, id);
    rm(dir);
    if (r.ok) throw new Error('an engine the router cannot call was registered');
    if (!/contract/.test(r.reason || '')) throw new Error('unexpected reason: ' + r.reason);
    if (router.BY_ID.has(id)) throw new Error('it is in the router anyway');
  });

  await check('an engine whose capability does not match its manifest is refused', () => {
    /* A manifest is a claim, and a claim the engine does not back is a
       misdirection: the agent would go on believing it had a capability it
       never shipped. */
    const id = 'mismatch-engine';
    const dir = path.join(forge.ENGINES_DIR, id);
    rm(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: 'Mismatch', capability: 'echo', contract: forge.REQUIRED, examples: [] }));
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = { id: ' + JSON.stringify(id) + ', name: "Mismatch", type: "generated", capabilities: ["act"], available: async () => ({available:true}), execute: async () => ({}), observe: async () => ({}), recover: async () => ({}) };\n');
    fs.writeFileSync(path.join(dir, 'test.js'), 'console.log("  2 passed");\nprocess.exit(0);\n');

    const r = forge.register(router, id);
    rm(dir);
    if (r.ok) throw new Error('registered despite claiming a capability it does not have');
    if (!/capability its manifest names/.test(r.reason || '')) throw new Error('unexpected reason: ' + r.reason);
  });

  await check('unregister() takes an engine back out of a live router', async () => {
    const r = forge.unregister(router, ECHO);
    if (!r.ok || !r.wasRegistered) throw new Error('unregister did not find it');
    const after = await router.route({ action: 'echo', text: 'halo', engine: ECHO });
    if (after.ok) throw new Error('the router still routes to an unregistered engine');
    forge.register(router, ECHO);   /* back in, for the guards below */
  });

  console.log('\n  --- nothing is written outside engines/ -----------------');

  await check('an id that is not an id is refused before any write', () => {
    const bad = ['../server', '..', 'a/b', 'Server', 'x'.repeat(60), '', 'echo engine', '.'];
    for (const name of bad) {
      let threw = false;
      try { forge.engineDir(name); } catch { threw = true; }
      if (!threw) throw new Error('accepted the id ' + JSON.stringify(name) + ' — it would have become a path');
    }
  });

  await check('a traversal id cannot reach a file outside engines/', () => {
    const target = path.join(__dirname, '..', 'server.js');
    const before = fs.readFileSync(target, 'utf8').length;
    try { forge.create({ id: '../../../server', capability: 'echo' }); } catch { /* refused, as it must be */ }
    if (fs.readFileSync(target, 'utf8').length !== before) throw new Error('server.js changed size');
  });

  await check('create() will not overwrite an engine that already exists', () => {
    const r = forge.create({ id: ECHO, capability: 'echo' });
    if (r.ok) throw new Error('the second create() overwrote a working engine');
    if (!/already an engine/.test(r.error || '')) throw new Error('unexpected error: ' + r.error);
  });

  console.log('\n  --- the dynamic registry ---------------------------------');

  await check('createRouter() gives each router its own registry, not the shared default', () => {
    /* The aliasing this replaced: a router built with no `engines` argument used
       to BE the DEFAULT_ENGINES array, so registering into one router edited the
       default for every router built later in the same process. */
    const a = automation.createRouter({ driver, context });
    const b = automation.createRouter({ driver, context });
    if (a.ENGINES === b.ENGINES) throw new Error('two routers share one ENGINES array');
    if (a.ENGINES === automation.DEFAULT_ENGINES) throw new Error('a router IS the DEFAULT_ENGINES array — the alias is still there');
    const ids = a.ENGINES.map(e => e.id);
    for (const want of ['native-cdp', 'playwright-mcp', 'stagehand', 'browser-use']) {
      if (!ids.includes(want)) throw new Error('the router lost the shipped engine ' + want);
    }
  });

  await check('registering at runtime does not mutate DEFAULT_ENGINES', () => {
    const ids = () => automation.DEFAULT_ENGINES.map(e => e.id);
    const len = automation.DEFAULT_ENGINES.length;
    const snapshot = ids().join(',');

    const r = automation.createRouter({ driver, context });          /* no `engines` argument, exactly like server.js */
    forge.unregister(r, ECHO);
    const reg = forge.register(r, ECHO);
    if (!reg.ok) throw new Error('could not register into a default router: ' + reg.reason);
    if (!r.BY_ID.has(ECHO)) throw new Error('it did not land in the router');

    if (automation.DEFAULT_ENGINES.length !== len) {
      throw new Error('DEFAULT_ENGINES grew from ' + len + ' to ' + automation.DEFAULT_ENGINES.length + ' — registering into one router edited the shared list');
    }
    if (ids().join(',') !== snapshot) throw new Error('DEFAULT_ENGINES changed: was ' + snapshot + ', now ' + ids().join(','));

    const later = automation.createRouter({ driver, context });
    if (later.BY_ID.has(ECHO)) throw new Error('a router built later starts with an engine nobody registered into it');
  });

  await check('DEFAULT_ENGINES refuses to be changed, so no future code can alias it either', () => {
    let threw = false;
    try { automation.DEFAULT_ENGINES.push({ id: 'sneaky' }); } catch { threw = true; }
    if (!threw) { automation.DEFAULT_ENGINES.pop(); throw new Error('the shipped engine list is still mutable'); }
  });

  await check('registerAll() brings back every engine in engines/ that passes, after a restart', async () => {
    /* A fresh router, as if the process had just started: the engines on disk
       are all it has. This is what makes a built engine survive a restart. */
    const boot = automation.createRouter({ driver, context });
    const r = forge.registerAll(boot);
    if (!r.ok) throw new Error(r.error);
    if (!r.registered.includes(ECHO)) {
      throw new Error('registerAll did not bring back ' + ECHO + ' — registered: ' + JSON.stringify(r.registered) + ', failed: ' + JSON.stringify(r.failed));
    }
    if (!boot.BY_ID.has(ECHO)) throw new Error('it is not in BY_ID');
    /* and it is genuinely callable, not merely present */
    const call = await boot.route({ action: 'echo', text: 'setelah restart', engine: ECHO });
    if (!call.ok || call.result.echoed !== 'setelah restart') throw new Error('the restored engine could not run: ' + JSON.stringify(call));
    /* and its capability is now part of what this router can do */
    const row = boot.describe().engines.find(e => e.id === ECHO);
    if (!row || !row.capabilities.includes('echo')) throw new Error('the restored engine does not carry its capability: ' + JSON.stringify(row));
  });

  await check('registerAll() does not register anything twice', () => {
    const boot = automation.createRouter({ driver, context });
    forge.registerAll(boot);
    const before = boot.ENGINES.length;
    const second = forge.registerAll(boot);
    if (!second.alreadyRegistered.includes(ECHO)) {
      throw new Error('the second pass did not recognise ' + ECHO + ' as already registered: ' + JSON.stringify(second));
    }
    if (boot.ENGINES.length !== before) throw new Error('the registry grew on the second pass: ' + before + ' -> ' + boot.ENGINES.length);
    const copies = boot.ENGINES.filter(e => e.id === ECHO).length;
    if (copies !== 1) throw new Error(ECHO + ' appears ' + copies + ' times in ENGINES');
    if (second.registered.length !== 0) throw new Error('the second pass registered something again: ' + JSON.stringify(second.registered));
  });

  await check('an invalid engine is skipped and does not take the server down with it', () => {
    /* The denial case: engines/ is a folder anything can write to, so a
       malformed file in it must be a skipped engine, never a boot failure. */
    const junk = path.join(forge.ENGINES_DIR, 'broken-engine');
    rm(junk);
    fs.mkdirSync(junk, { recursive: true });
    fs.writeFileSync(path.join(junk, 'manifest.json'), 'this is not json at all');
    fs.writeFileSync(path.join(junk, 'index.js'), 'module.exports = { this is not javascript');

    const boot = automation.createRouter({ driver, context });
    let r;
    try { r = forge.registerAll(boot); }
    catch (e) { rm(junk); throw new Error('registerAll threw on a broken engine — the whole registry is down: ' + e.message); }
    rm(junk);
    if (!r.ok) throw new Error('registerAll reported failure: ' + JSON.stringify(r));
    if (r.registered.includes('broken-engine')) throw new Error('it registered a broken engine');
    if (boot.BY_ID.has('broken-engine')) throw new Error('the broken engine is in the registry');
    if (!r.failed.some(f => f.id === 'broken-engine')) throw new Error('the broken engine was not reported as failed: ' + JSON.stringify(r));
    /* and the healthy engine in the same directory was still registered */
    if (!boot.BY_ID.has(ECHO)) throw new Error('one broken engine stopped a good one from being registered');
  });

  await check('a directory that is not a usable engine id is ignored silently', () => {
    const odd = path.join(forge.ENGINES_DIR, 'Not An Id');
    rm(odd);
    fs.mkdirSync(odd, { recursive: true });
    fs.writeFileSync(path.join(odd, 'manifest.json'), '{}');

    const boot = automation.createRouter({ driver, context });
    const r = forge.registerAll(boot);
    rm(odd);
    if (r.failed.some(f => f.id === 'Not An Id')) throw new Error('a non-id directory was treated as a candidate engine');
    if (r.registered.some(id => id === 'Not An Id')) throw new Error('a non-id directory was registered');
  });

  await check('registerAll() refuses an engine whose test fails, exactly as register() does', () => {
    rm(path.join(forge.ENGINES_DIR, BROKEN));
    forge.create({ id: BROKEN, name: 'Liar', capability: 'echo', body: LIAR_BODY,
      examples: [{ action: 'echo', text: 'halo', expect: { echoed: 'halo' } }] });
    const boot = automation.createRouter({ driver, context });
    const r = forge.registerAll(boot);
    rm(path.join(forge.ENGINES_DIR, BROKEN));
    if (r.registered.includes(BROKEN)) throw new Error('registerAll registered an engine that failed its test');
    if (boot.BY_ID.has(BROKEN)) throw new Error('it is in the registry');
    const f = r.failed.find(x => x.id === BROKEN);
    if (!f) throw new Error('the failure was not reported');
    if (!/FAIL/.test(f.output || '')) throw new Error('no test output carried back: ' + JSON.stringify(f));
  });

  await check('registerAll() refuses an engine with no test, and keeps going', () => {
    const id = 'no-test-engine';
    const dir = path.join(forge.ENGINES_DIR, id);
    rm(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: 'No Test', capability: 'echo' }));
    fs.writeFileSync(path.join(dir, 'index.js'),
      'module.exports = { id: ' + JSON.stringify(id) + ', name: "No Test", type: "generated", capabilities: ["echo","act"], available: async () => ({available:true}), execute: async () => ({}), observe: async () => ({}), recover: async () => ({}) };');

    const boot = automation.createRouter({ driver, context });
    const r = forge.registerAll(boot);
    rm(dir);
    if (r.registered.includes(id)) throw new Error('an engine with no test was registered');
    if (!r.failed.some(f => f.id === id)) throw new Error('it was not reported');
    if (!boot.BY_ID.has(ECHO)) throw new Error('the refusal stopped a good engine from registering');
  });

  await check('list() runs each engine test exactly once, and no more', () => {
    /* The double-run this replaced: list() asked canRegister() for the verdict
       and then again for the reason, so a survey over ten engines spawned
       twenty node processes. Counting is how that stays fixed. */

    /* forge.js does `const { spawnSync } = require('child_process')` when it
       loads, so patching child_process after the fact changes nothing — a test
       that did that counts zero and would have passed the buggy version too.
       Dropping it out of the require cache and loading it again against a
       patched module is what makes the number mean something. */
    const forgePath = require.resolve('../forge');
    const realSpawn = cp.spawnSync;
    let runs = 0;
    let engines;

    try {
      delete require.cache[forgePath];
      cp.spawnSync = function () { runs += 1; return realSpawn.apply(this, arguments); };
      const counted = require('../forge');
      runs = 0;
      engines = counted.engineDirectories().length;
      counted.list();
    } finally {
      cp.spawnSync = realSpawn;
      delete require.cache[forgePath];
      require('../forge');          /* the suite's own copy, unpatched */
    }

    if (engines === 0) throw new Error('no engines on disk — this would pass without measuring anything');
    if (runs !== engines) {
      throw new Error('list() spawned ' + runs + ' engine tests for ' + engines + ' engines — it should be exactly one each');
    }
  });

  console.log('\n  --- the tool the agent would call ------------------------');

  await check('install() puts create_engine where ai/engine.js can resolve it', () => {
    const r = forge.installTool(router);
    if (!r.ok) throw new Error(r.error);
    const tools = require('../ai/tools');
    /* The measurement that matters: not that the definition was pushed, but
       that the lookup the agent's turn actually performs finds it. */
    if (tools.toolByName('create_engine') !== forge.TOOL) {
      throw new Error('toolByName("create_engine") does not resolve to the forge tool — the model would call it and be told it does not exist');
    }
    /* and the shipped tools still resolve, which replacing the function rather
       than wrapping it would have broken */
    for (const name of ['browser_navigate', 'browser_tabs', 'browser_screenshot']) {
      if (!tools.toolByName(name)) throw new Error('the patch broke the shipped tool ' + name);
    }
    if (tools.toolByName('tidak_ada') !== null) throw new Error('an unknown tool now resolves to something');
  });

  await check('calling the tool runs the same code path the test just proved', async () => {
    /* survey, through the tool, not through the module — because the tool is
       the thing the model will actually be holding. */
    const seen = await forge.TOOL.run({}, { action: 'survey' });
    if (!seen.engines || !seen.engines.some(e => e.id === ECHO)) {
      throw new Error('the tool does not report the engine that was just built: ' + JSON.stringify(seen.engines && seen.engines.map(e => e.id)));
    }
    if (!seen.capabilities.includes('echo')) {
      throw new Error('"echo" is still not in the capability set after it was built: ' + JSON.stringify(seen.capabilities));
    }
  });

  await check('create_engine is hidden when the profile does not have the engines permission', () => {
    /* The gate that matters most, because it is the one a mistake opens. A tool
       that writes and runs code must not reach a model whose profile never asked
       for it — so the default matters as much as the opt-in. */
    const tools = require('../ai/tools');
    const base = { browser: true, screenshot: true, dom: true, javascript: true, terminal: true, rules: true };
    for (const engines of [undefined, false]) {
      const profile = { id: 'p', skills: [], tools: Object.assign({}, base, { engines }) };
      if (tools.toolsFor(profile).some(t => t.name === 'create_engine')) {
        throw new Error('create_engine is offered with engines=' + engines + ' — it must be off unless the profile asked for it');
      }
      if (tools.schemasFor(profile).some(s => s.name === 'create_engine')) {
        throw new Error('the model is shown a schema for engines=' + engines);
      }
    }
    /* and the shipped default really is off — a fresh profile gets no engines */
    const defaults = require('../ai/store').TOOL_KEYS;
    if (!defaults.includes('engines')) throw new Error('engines is not a recognised permission key at all');
  });

  await check('create_engine appears when the profile has the engines permission', () => {
    const tools = require('../ai/tools');
    const profile = { id: 'p', skills: [], tools: { browser: true, screenshot: true, dom: true, javascript: true, terminal: false, rules: false, engines: true } };
    if (!tools.toolsFor(profile).some(t => t.name === 'create_engine')) {
      throw new Error('a profile with engines:true still does not get create_engine');
    }
    const schema = tools.schemasFor(profile).find(s => s.name === 'create_engine');
    if (!schema) throw new Error('the model is not shown a schema for it');
    if (!schema.parameters || !schema.parameters.properties || !schema.parameters.properties.action) {
      throw new Error('the schema has no shape — the model cannot call what it cannot see: ' + JSON.stringify(schema));
    }
    /* and the permissions are independent, not aliased: engines without terminal */
    /* the two keys are independent in both directions: `engines` alone grants no
       shell, and a shell is not what unlocked the tool in the first place */
    if (tools.toolsFor(profile).some(t => t.name === 'shell_exec')) {
      throw new Error('a shell appeared when only engines was granted — the two keys are not independent');
    }
    if (forge.TOOL.caps[0] !== 'engines') throw new Error('the tool is not gated on the engines key');
  });

  await check('engines is a real permission key in both places that list them', () => {
    const store = require('../ai/store');
    const rules = require('../ai/rules');
    if (!store.TOOL_KEYS.includes('engines')) throw new Error('ai/store.js TOOL_KEYS has no engines key');
    if (!rules.CAP_KEYS.includes('engines')) throw new Error('ai/rules.js CAP_KEYS has no engines key');
    /* the two lists must agree, or a key the UI offers does nothing */
    const onlyStore = store.TOOL_KEYS.filter(k => !rules.CAP_KEYS.includes(k));
    const onlyRules = rules.CAP_KEYS.filter(k => !store.TOOL_KEYS.includes(k));
    if (onlyStore.length) throw new Error('the Settings screen offers keys the agent cannot use: ' + onlyStore.join(', '));
    if (onlyRules.length) throw new Error('the agent accepts keys the Settings screen cannot grant: ' + onlyRules.join(', '));
    /* and it is off by default, like terminal */
    if (store.DEFAULT_TOOLS.engines !== false) throw new Error('engines defaults to on — a fresh profile could write and run code without asking');
  });


  await check('create_engine is not smuggled under an existing permission key', () => {
    if (forge.TOOL.caps.length !== 1 || forge.TOOL.caps[0] !== forge.TOOL_CAP) {
      throw new Error('the tool declares caps ' + JSON.stringify(forge.TOOL.caps) + ' — it must be gated on its own key and nothing else');
    }
  });

  console.log('\n  --- engine_execute -------------------------------------------');

  /* The four refusals are the contract with the model, and each one is written
     as a separate check rather than a table, because the reason a refusal says
     what it says is the thing being tested — not the fact that it refused. */

  await check('a valid engine runs and the result comes back', async () => {
    const ctx = controllerFor(router);
    const r = await forge.runOnEngine(ctx, { engine: ECHO, action: { text: 'halo lokal' } }, router);
    if (!r.ok) throw new Error('refused: ' + r.error);
    if (r.engine !== ECHO) throw new Error('ran ' + r.engine);
    if (!r.result || r.result.echoed !== 'halo lokal') throw new Error('result was ' + JSON.stringify(r.result));
  });

  await check('the exact call the acceptance prompt uses works', async () => {
    const ctx = controllerFor(router);
    const r = await forge.runOnEngine(ctx, { engine: 'echo-engine', action: { text: 'halo lokal' } }, router);
    if (!r.ok || r.result.echoed !== 'halo lokal') throw new Error(JSON.stringify(r));
  });

  await check('no engine is privileged: nothing in the tool names one', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'forge.js'), 'utf8');
    const start = src.indexOf('const EXECUTE_TOOL = {');
    const end = src.indexOf('/**', start);
    const chunk = src.slice(start, end);
    /* The name appears once, in the schema's help text, as an example of the
       shape of an id. That is documentation. What would privilege an engine is
       a comparison against it — a dispatch — and there must be none. */
    if (/engine\s*===?\s*['"]/.test(chunk) || /switch\s*\(\s*engine/.test(chunk)) {
      throw new Error('engine_execute branches on the engine id — it must look it up instead');
    }
    if (/require\(['"]\.\.\/engines/.test(chunk) || /id\s*===\s*ECHO/.test(chunk)) {
      throw new Error('engine_execute reaches for a particular engine');
    }
  });

  await check('any registered engine is callable, not just the generated one', async () => {
    /* A second generated engine, so this is not "the tool works on the one
       engine that happens to be on disk". */
    const id = 'upper-engine';
    rm(path.join(forge.ENGINES_DIR, id));
    forge.create({
      id, name: 'Upper', capability: 'shout',
      body: '    return { shouted: String(action.text || \'\').toUpperCase() };',
      examples: [{ action: 'shout', text: 'halo', expect: { shouted: 'HALO' } }],
    });
    const r2 = automation.createRouter({ driver, context, engines: automation.DEFAULT_ENGINES.slice() });
    const reg = forge.register(r2, id);
    if (!reg.ok) throw new Error('could not register the second engine: ' + reg.reason);

    const out = await forge.runOnEngine(controllerFor(r2), { engine: id, action: { action: 'shout', text: 'halo' } }, r2);
    rm(path.join(forge.ENGINES_DIR, id));
    if (!out.ok) throw new Error('refused: ' + out.error);
    if (out.result.shouted !== 'HALO') throw new Error('got ' + JSON.stringify(out.result));
  });

  await check('unknown engine is refused, and the answer lists what does exist', async () => {
    const r = await forge.runOnEngine(controllerFor(router), { engine: 'tidak-ada', action: { text: 'x' } }, router);
    if (r.ok) throw new Error('it ran an engine that is not registered');
    if (!/there is no engine called/.test(r.error)) throw new Error('unclear refusal: ' + r.error);
    if (!Array.isArray(r.engines) || !r.engines.includes(ECHO)) {
      throw new Error('the refusal did not say what is registered: ' + JSON.stringify(r.engines));
    }
  });

  await check('an engine that is known but unavailable is refused with the reason', async () => {
    const r2 = automation.createRouter({ driver, context, engines: automation.DEFAULT_ENGINES.slice() });
    forge.register(r2, ECHO);
    /* make it unavailable the way a failing engine becomes unavailable, rather
       than by editing health behind the router's back with a fake shape */
    const h = r2.health.get(ECHO);
    h.available = false;
    h.reason = 'it was switched off';

    const r = await forge.runOnEngine(controllerFor(r2), { engine: ECHO, action: { text: 'x' } }, r2);
    if (r.ok) throw new Error('it ran an engine that is not available');
    if (!/is not available/.test(r.error)) throw new Error('unclear refusal: ' + r.error);
    if (!/it was switched off/.test(r.error)) throw new Error('the reason was dropped: ' + r.error);
  });

  await check('an engine the router has not probed yet is not called unavailable', async () => {
    /* health starts at null, which means "not asked", not "no". A tool that
       read null as unavailable would refuse every engine on a fresh session. */
    const r2 = automation.createRouter({ driver, context, engines: automation.DEFAULT_ENGINES.slice() });
    forge.register(r2, ECHO);
    const h = r2.health.get(ECHO);
    if (h.available !== true) throw new Error('register left health at ' + h.available + ', the premise is gone');
    h.available = null;
    const r = await forge.runOnEngine(controllerFor(r2), { engine: ECHO, action: { text: 'halo' } }, r2);
    if (/is not available/.test(r.error || '')) throw new Error('an unprobed engine was called unavailable: ' + r.error);
  });

  await check('a malformed action is refused before anything is called', async () => {
    const ctx = controllerFor(router);
    const cases = [
      [{ engine: ECHO }, 'missing action'],
      [{ engine: ECHO, action: null }, 'null action'],
      [{ engine: ECHO, action: 'halo' }, 'string action'],
      [{ engine: ECHO, action: 42 }, 'number action'],
      [{ engine: ECHO, action: ['a'] }, 'array action'],
    ];
    for (const [args, what] of cases) {
      const r = await forge.runOnEngine(ctx, args, router);
      if (r.ok) throw new Error('accepted a ' + what);
      if (!r.error) throw new Error('refused a ' + what + ' with no explanation');
    }
  });

  await check('a missing engine id is refused with somewhere to go next', async () => {
    for (const args of [{}, { engine: '' }, { engine: '   ' }, { action: { text: 'x' } }]) {
      const r = await forge.runOnEngine(controllerFor(router), args, router);
      if (r.ok) throw new Error('accepted ' + JSON.stringify(args));
      if (!/engine id/.test(r.error)) throw new Error('unclear: ' + r.error);
    }
  });

  await check('an action the engine cannot take is refused, and says what it needed', async () => {
    /* echo-engine declares act, not navigate — a navigate is a different kind of
       work and the router would have refused it. Saying so up front is the
       difference between a reason and a failure. */
    const r = await forge.runOnEngine(controllerFor(router), { engine: ECHO, action: { action: 'navigate', url: 'https://contoh.test/' } }, router);
    if (r.ok) throw new Error('echo-engine ran a navigate');
    if (!/cannot take a "navigate" action/.test(r.error)) throw new Error('unclear: ' + r.error);
    if (!Array.isArray(r.needs) || !r.needs.includes('navigate')) throw new Error('the refusal did not say what it needed: ' + JSON.stringify(r));
    if (!Array.isArray(r.declares) || !r.declares.includes('act')) throw new Error('the refusal did not say what the engine has: ' + JSON.stringify(r));
  });

  await check('an engine that throws is reported as a failure, not as a missing engine', async () => {
    const id = 'throw-engine';
    rm(path.join(forge.ENGINES_DIR, id));
    /* the generated test asserts on the throw, so this engine fails its own
       test and is refused at the gate — the honest case for an engine that is
       broken before it is ever called */
    const r2 = automation.createRouter({ driver, context, engines: automation.DEFAULT_ENGINES.slice() });
    const built = forge.build(r2, {
      id, name: 'Throw', capability: 'boom',
      body: '    throw new Error(\'the engine said no\');',
      examples: [{ action: 'boom', expect: { ok: true } }],
    });
    rm(path.join(forge.ENGINES_DIR, id));
    if (built.ok) throw new Error('an engine that always throws was registered');
    if (built.stage !== 'test') throw new Error('it failed at ' + built.stage + ', not at the test');
    if (!/the engine said no/.test(built.output || '')) {
      throw new Error('the output did not show the engine\'s own error: ' + JSON.stringify(built.output));
    }
  });

  await check('an engine that fails at run time is reported with its own message', async () => {
    /* registered honestly (its test passes), then made to throw by the action
       it is given — the difference between "refused to register" and "ran and
       could not", which an agent cannot otherwise tell apart */
    const id = 'fussy-engine';
    rm(path.join(forge.ENGINES_DIR, id));
    forge.create({
      id, name: 'Fussy', capability: 'echo', body: FUSSY_BODY,
      examples: [{ action: 'echo', text: 'halo', expect: { echoed: 'halo' } }],
    });
    const r2 = automation.createRouter({ driver, context, engines: automation.DEFAULT_ENGINES.slice() });
    const reg = forge.register(r2, id);
    rm(path.join(forge.ENGINES_DIR, id));
    if (!reg.ok) throw new Error('the fussy engine should register: ' + reg.reason);

    const r = await forge.runOnEngine(controllerFor(r2), { engine: id, action: { action: 'nonsense' } }, r2);
    if (r.ok) throw new Error('an action the engine rejects was reported as success');
    if (!/could not run that action/.test(r.error)) throw new Error('unclear: ' + r.error);
    if (!/handles only/.test(r.error)) throw new Error('the engine\'s own reason was lost: ' + r.error);
  });

  await check('an action cannot smuggle a different engine in through its own body', async () => {
    /* The router prefers action.engine over opts.engine, so a nested engine
       would silently redirect the call. The tool has to win. */
    const r2 = automation.createRouter({ driver, context, engines: automation.DEFAULT_ENGINES.slice() });
    forge.register(r2, ECHO);
    const ctx = controllerFor(r2);
    const r = await forge.runOnEngine(ctx, { engine: ECHO, action: { text: 'halo', engine: 'native-cdp' } }, r2);
    if (ctx.seen[0].engine !== ECHO) throw new Error('the action reached the router as engine=' + ctx.seen[0].engine);
    if (!r.ok || r.result.echoed !== 'halo') throw new Error(JSON.stringify(r));
  });

  await check('it goes through ctx.browser.action, so the profile policy still runs', async () => {
    /* The reason this is not a direct call into the router: agentController is
       where the Milestone 2A guard sits. A tool that reached the router would
       move the browser without the policy ever being consulted. */
    const src = fs.readFileSync(path.join(__dirname, '..', 'forge.js'), 'utf8');
    const start = src.indexOf('async function runOnEngine');
    const chunk = src.slice(start, src.indexOf('\n}', start));
    if (!/ctx\.browser\.action/.test(chunk)) throw new Error('runOnEngine does not go through ctx.browser.action');
    if (/\bautomation\.route\b|\brouter\.route\b/.test(chunk)) {
      throw new Error('runOnEngine calls the router directly, which skips the profile guard');
    }
    if (/ctx\.shell/.test(chunk)) throw new Error('engine_execute reaches the shell');
  });

  await check('engine_execute is visible with engines, and not with terminal', () => {
    const tools = require('../ai/tools');
    const base = { browser: true, screenshot: true, dom: true, javascript: true, rules: false };
    const withEngines = tools.toolsFor({ id: 'p', skills: [], tools: Object.assign({}, base, { terminal: false, engines: true }) });
    if (!withEngines.some(t => t.name === 'engine_execute')) throw new Error('engines:true does not offer engine_execute');

    const withTerminal = tools.toolsFor({ id: 'p', skills: [], tools: Object.assign({}, base, { terminal: true, engines: false }) });
    if (withTerminal.some(t => t.name === 'engine_execute')) throw new Error('terminal alone offered engine_execute');
    if (!withTerminal.some(t => t.name === 'shell_exec')) throw new Error('terminal stopped offering shell_exec');

    const withNeither = tools.toolsFor({ id: 'p', skills: [], tools: Object.assign({}, base, { terminal: false, engines: false }) });
    for (const t of ['engine_execute', 'create_engine', 'shell_exec']) {
      if (withNeither.some(x => x.name === t)) throw new Error(t + ' is visible with no permission for it');
    }
  });

  await check('the schema the model sees is minimal and required', () => {
    const s = forge.EXECUTE_TOOL.parameters;
    if (JSON.stringify(s.required) !== JSON.stringify(['engine', 'action'])) throw new Error('required is ' + JSON.stringify(s.required));
    if (s.properties.engine.type !== 'string') throw new Error('engine is not a string');
    if (s.properties.action.type !== 'object') throw new Error('action is not an object');
    if (s.properties.action.additionalProperties !== true) throw new Error('action is closed, so an engine can never receive its own fields');
    if (forge.EXECUTE_TOOL.caps.length !== 1 || forge.EXECUTE_TOOL.caps[0] !== 'engines') throw new Error('caps is ' + JSON.stringify(forge.EXECUTE_TOOL.caps));
  });

  await check('the built-in browser engines still work exactly as before', async () => {
    /* engine_execute must not have become the way the browser is driven, or the
       guard would stop being the only door. These go through ctx.browser.action
       and land on native-cdp the way they always did. */
    const ctx = controllerFor(router);
    const r = await forge.runOnEngine(ctx, { engine: 'native-cdp', action: { action: 'read' } }, router);
    if (!r.ok) throw new Error('native-cdp could not be called through the tool: ' + r.error);
    if (ctx.seen[0].engine !== 'native-cdp') throw new Error('wrong engine reached: ' + ctx.seen[0].engine);
    if (r.engine !== 'native-cdp') throw new Error('reported ' + r.engine);

    /* and the ordinary path, with no tool involved, is untouched */
    const plain = await router.route({ action: 'read' });
    if (!plain.ok) throw new Error('the ordinary browser path broke: ' + plain.error);
    if (plain.engine !== 'native-cdp') throw new Error('auto mode chose ' + plain.engine);
  });

  await check('the tool returns the value the engine produced, unwrapped, like every other tool', async () => {
    /* browser_navigate hands back what native-cdp produced. So does this. An
       extra { ok, engine, result } layer would make every caller reach through
       it, and the model would be reading the wrapper rather than the answer. */
    const r2 = automation.createRouter({ driver, context, engines: automation.DEFAULT_ENGINES.slice() });
    forge.installTool(r2);
    forge.register(r2, ECHO);
    const out = await forge.EXECUTE_TOOL.run(controllerFor(r2), { engine: ECHO, action: { text: 'halo lokal' } });
    if (JSON.stringify(out) !== JSON.stringify({ echoed: 'halo lokal' })) {
      throw new Error('the tool returned ' + JSON.stringify(out));
    }
  });

  await check('the tool throws on a refusal, so the agent is told it failed', async () => {
    /* ai/engine.js turns a throw into ok:false and a message the model can read.
       Returning { ok: false } instead would be recorded as a successful call
       whose payload contains an error — the one shape that is not actionable. */
    const r2 = automation.createRouter({ driver, context, engines: automation.DEFAULT_ENGINES.slice() });
    forge.installTool(r2);
    forge.register(r2, ECHO);
    for (const args of [
      { engine: 'tidak-ada', action: { text: 'x' } },
      { engine: ECHO, action: 'bukan objek' },
      { action: { text: 'x' } },
    ]) {
      let threw = null;
      try { await forge.EXECUTE_TOOL.run(controllerFor(r2), args); }
      catch (e) { threw = e; }
      if (!threw) throw new Error('the tool returned normally for ' + JSON.stringify(args));
      if (!threw.message) throw new Error('it threw with no message');
    }
  });

  await check('a refusal thrown by the tool is what the agent loop would record', async () => {
    /* the same shape ai/engine.js:405 produces, checked here rather than assumed */
    const r2 = automation.createRouter({ driver, context, engines: automation.DEFAULT_ENGINES.slice() });
    forge.installTool(r2);
    forge.register(r2, ECHO);          /* so "what does exist" has something in it to list */
    let failure = null;
    try { await forge.EXECUTE_TOOL.run(controllerFor(r2), { engine: 'tidak-ada', action: {} }); }
    catch (e) { failure = e.message; }
    if (!/there is no engine called/.test(failure || '')) throw new Error('the loop would show the agent: ' + failure);
    if (!failure.includes(ECHO)) throw new Error('the model is not told what does exist: ' + failure);
  });

  await check('neither forge tool can reach the shell', () => {
    for (const tool of [forge.TOOL, forge.EXECUTE_TOOL]) {
      if (tool.caps.includes('terminal')) throw new Error(tool.name + ' is gated on terminal');
      if (tool.caps.length !== 1 || tool.caps[0] !== 'engines') throw new Error(tool.name + ' caps are ' + JSON.stringify(tool.caps));
    }
    const src = fs.readFileSync(path.join(__dirname, '..', 'forge.js'), 'utf8');
    const start = src.indexOf('async function runOnEngine');
    const chunk = src.slice(start, src.indexOf('\n}', start));
    if (/ctx\.shell/.test(chunk)) throw new Error('engine_execute can reach the shell');
  });

  await check('the four shipped tools are still the four shipped tools', () => {
    const tools = require('../ai/tools');
    for (const name of ['browser_navigate', 'browser_click', 'browser_screenshot', 'shell_exec']) {
      if (!tools.toolByName(name)) throw new Error('lost ' + name);
    }
    if (tools.toolByName('engine_execute') !== forge.EXECUTE_TOOL) throw new Error('engine_execute does not resolve to the forge tool');
    if (tools.toolByName('create_engine') !== forge.TOOL) throw new Error('create_engine does not resolve to the forge tool');
  });

  console.log('\n  --- the router was not taught about any of this --------');

  await check('the router source was not taught about any of this', () => {
    /* Precise on purpose. ai/automation/index.js already requires its own
       ./engines/ — that is the four shipped adapters and it has always been
       there. What it must not contain is the *root* engines/ directory, or any
       idea that generated engines exist. */
    const src = fs.readFileSync(path.join(__dirname, '..', 'ai', 'automation', 'index.js'), 'utf8');
    for (const word of ['forge', "require('../forge", "require('../../forge", "'../engines", '"../engines', 'ENGINES_DIR', 'registerGenerated', 'generated engine']) {
      if (src.includes(word)) throw new Error('the router source now mentions "' + word + '" — it was supposed to need nothing');
    }
  });

  await check('forge.js reaches the product through the router and the tool registry, and nothing else', () => {
    /* ai/tools.js is the one product file the forge does require, and requiring
       it is not the same as having changed it — the check that proves the file
       is untouched is the git one below. What must stay off the list is
       anything that would make the forge a second copy of the product rather
       than something standing beside it. */
    const src = fs.readFileSync(path.join(__dirname, '..', 'forge.js'), 'utf8');
    for (const word of ["require('./server", "require('./ai/store", "require('./ai/automation/index'", "require('./dashboard", "require('./ai/engine"]) {
      if (src.includes(word)) throw new Error('forge.js imports ' + word + ' — it is meant to stand beside the product, not inside it');
    }
    /* and it is the *only* product entry point: the router, and the tool
       registry it hands one tool to */
    const requires = [...src.matchAll(/require\('\.\/ai\/([a-z/]+)'\)/g)].map(m => m[1]);
    const allowed = ['automation', 'automation/state', 'automation/context', 'tools', 'rules'];
    for (const r of requires) {
      if (!allowed.includes(r)) throw new Error('forge.js reaches into ai/' + r + ' — only the router and the tool registry are on the list');
    }
  });

  await check('ai/tools.js and dashboard.html are byte-identical to HEAD', () => {
    /* The two off-limits files that this milestone had no reason to touch and no
       permission to touch. Measured against git, not asserted. */
    let changed;
    try {
      changed = cp.execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'ai/tools.js', 'dashboard.html'],
        { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim();
    } catch (e) {
      if (e.code === 'ENOENT' || /not a git repository/i.test(String(e.stderr || e.message))) return;
      throw new Error('git failed: ' + e.message);
    }
    if (changed) throw new Error('modified and not supposed to be:\n         ' + changed.split('\n').join('\n         '));
  });

  await check('the three files this milestone was allowed to touch carry only the change it was given', () => {
    /* ai/store.js, ai/rules.js and ai/automation/index.js were changed on purpose,
       so the useful check is not 'unchanged' but 'changed and nothing else': each
       one is asserted to hold the property it was changed for, and the two files
       next to them are asserted untouched. */
    const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

    const store = read('ai/store.js');
    if (!/TOOL_KEYS\s*=\s*\[[^\]]*'engines'/.test(store)) throw new Error('ai/store.js does not carry the engines key in TOOL_KEYS');
    if (!/DEFAULT_TOOLS\s*=\s*\{[^}]*engines:\s*false/.test(store)) throw new Error('ai/store.js does not default engines to off');

    const rules = read('ai/rules.js');
    if (!/CAP_KEYS\s*=\s*\[[^\]]*'engines'/.test(rules)) throw new Error('ai/rules.js does not carry the engines key in CAP_KEYS');

    const index = read('ai/automation/index.js');
    if (!/Object\.freeze\(\[/.test(index)) throw new Error('the shipped engine list is not frozen');
    if (!/DEFAULT_ENGINES\)\.slice\(\)|DEFAULT_ENGINES\)\.slice\(\)/.test(index)) {
      if (!/:\s*DEFAULT_ENGINES\)\.slice\(\)/.test(index)) throw new Error('createRouter does not copy the shipped list into its own');
    }

    /* ai/tools.js must not have gained a hardcoded entry — the tool is installed
       at runtime, and the file itself is still the four shipped tools plus the
       shell and rules ones, with no import of the forge. */
    if (/require\([^)]*forge/.test(read('ai/tools.js'))) throw new Error('ai/tools.js now imports the forge');
    if (/name:\s*'create_engine'/.test(read('ai/tools.js'))) throw new Error('create_engine was hardcoded into ai/tools.js instead of installed');

    /* and the router is otherwise untouched: no registry code was added to it */
    for (const word of ['registerGenerated', "require('../../forge", "'../engines", '"../engines', 'ENGINES_DIR', 'generated engine']) {
      if (index.includes(word)) throw new Error('the router now mentions "' + word + '"');
    }
  });

  console.log('\n  forge: ' + pass + ' passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ''));
  console.log('  the engine the agent built is on disk at engines/' + ECHO + '/ — manifest, implementation and test');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('\n  suite crashed: ' + e.message); process.exit(1); });
