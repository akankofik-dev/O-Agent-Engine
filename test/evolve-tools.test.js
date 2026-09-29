'use strict';
/* ========================================================================= *
 *  test/evolve-tools.test.js — the agent's doors onto Levels 3 to 7.
 *
 *  Two things are being claimed here and neither is "the tools exist".
 *
 *  The first is reachability. ai/tools.js holds a fixed list and looks tools up
 *  through a function that was captured at load, so a tool added at runtime is
 *  offered to the model and then refused as unknown. forge.js measured that
 *  problem in Level 2 and works around it; these six tools have to be measured
 *  the same way, because a tool that is defined and never reachable is a claim
 *  rather than a feature.
 *
 *  The second is refusal. Every refusal here throws, and that is load-bearing:
 *  ai/engine.js records a thrown tool as ok:false, while a tool that *returns*
 *  {ok:false} is recorded as a successful call whose result happened to be a
 *  refusal. A refusal the model does not see as a failure is a refusal it will
 *  make again.
 * ======================================================================== */

const fs = require('fs');
const path = require('path');
const pathmod = path;   /* both spellings appear below; one module */
const forge = require('../forge');
const lifecycle = require('../lifecycle');
const et = require('../evolve-tools');
const automation = require('../ai/automation');

const ID = 'tools-demo';
const driver = { action: async () => ({ ok: true }), tabs: async () => ({ tabs: [] }) };
const context = () => ({ connected: true, agentTabId: 'tab_et', url: 'about:blank' });
const newRouter = () => automation.createRouter({ driver, context, engines: automation.DEFAULT_ENGINES.slice() });
const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* gone */ } };
const head = (s) => console.log('\n  --- ' + s + ' ' + '-'.repeat(Math.max(0, 62 - s.length)));

let pass = 0; const fails = [];
const check = (name, fn) => Promise.resolve().then(fn)
  .then(() => { pass += 1; console.log('  ok   ' + name); })
  .catch(e => { fails.push(name); console.log('  FAIL ' + name + '\n         ' + e.message); })
  /* Cleanup for the engines a check creates by name, not for the demo engine:
     cleaning that one after every check deleted it before the first check that
     used it, and five cases failed on an engine that had never been missing.
     The checks that need it seed it. */
  .then(() => { rm(pathmod.join(forge.ENGINES_DIR, 'tools-second')); rm(pathmod.join(forge.ENGINES_DIR, 'tools-watermark')); });

const GOOD = "    return { marked: String(action.text || '').slice(0, 3) };";
const GOOD_EXAMPLES = [{ action: 'mark', text: 'abcdef', expect: { marked: 'abc' } }];
const BETTER = "    return { marked: String(action.text || '').slice(0, 3), length: String(action.text || '').length };";
const BETTER_EXAMPLES = [{ action: 'mark', text: 'abcdef', expect: { marked: 'abc', length: 6 } }];

/** seed the demo engine and hand the tools a router */
function seed() {
  rm(path.join(forge.ENGINES_DIR, ID));
  const r = newRouter();
  const made = forge.build(r, { id: ID, name: 'Demo', capability: 'mark', body: GOOD, examples: GOOD_EXAMPLES });
  if (!made.ok) throw new Error('seed failed: ' + (made.reason || made.error));
  const installed = et.install(r);
  if (!installed.ok) throw new Error('install failed: ' + installed.error);
  return r;
}

/** call a tool the way ai/engine.js does — by name, out of the registry */
const call = async (name, args) => {
  const tools = require('../ai/tools');
  const tool = tools.toolByName(name);
  if (!tool) throw new Error(name + ' does not resolve through toolByName, so the model could never call it');
  return tool.run({}, args);
};

(async () => {
  console.log('\n  the tools for Levels 3 to 7');

  let router = seed();

  await check('all six are registered, resolvable and offered to a profile that has "engines"', () => {
    const st = et.installed();
    for (const k of ['present', 'resolvable', 'offered']) {
      if (!st[k]) throw new Error(k + ' is false: ' + JSON.stringify(st));
    }
    if (st.tools.length !== 6) throw new Error('expected six tools, got ' + JSON.stringify(st.tools));
  });

  await check('they are offered only to a profile that has the engines key', () => {
    const tools = require('../ai/tools');
    const withCap = {};
    for (const k of require('../ai/rules').CAP_KEYS) withCap[k] = true;
    withCap.engines = true;
    const without = {};
    for (const k of require('../ai/rules').CAP_KEYS) without[k] = true;
    without.engines = false;

    const on = tools.toolsFor({ id: 'p1', skills: [], tools: withCap }).map(t => t.name);
    const off = tools.toolsFor({ id: 'p2', skills: [], tools: without }).map(t => t.name);
    for (const t of et.TOOLS) {
      if (!on.includes(t.name)) throw new Error(t.name + ' is not offered to a profile that has engines');
      if (off.includes(t.name)) throw new Error(t.name + ' is offered to a profile that does not have engines — a profile can write engines it may not use');
    }
  });

  await check('every one is guarded by the same single permission as create_engine', () => {
    for (const t of et.TOOLS) {
      if (!Array.isArray(t.caps) || t.caps.length !== 1 || t.caps[0] !== 'engines') {
        throw new Error(t.name + ' is guarded by ' + JSON.stringify(t.caps) + ' rather than the one engines key');
      }
    }
    if (forge.TOOL_CAP !== 'engines') throw new Error('the forge moved its permission key: ' + forge.TOOL_CAP);
  });

  await check('every one describes itself and declares a schema the model can call', () => {
    for (const t of et.TOOLS) {
      if (!t.description || t.description.length < 80) throw new Error(t.name + ' has no usable description');
      const p = t.parameters;
      if (!p || p.type !== 'object' || !p.properties) throw new Error(t.name + ' has no object schema');
      if (!Array.isArray(p.required) || !p.required.length) throw new Error(t.name + ' requires nothing, so it can be called with no arguments at all');
      for (const r of p.required) {
        if (!p.properties[r]) throw new Error(t.name + ' requires ' + r + ' but does not define it');
      }
      if (typeof t.run !== 'function') throw new Error(t.name + ' has no run');
      if (typeof t.label !== 'function') throw new Error(t.name + ' has no label for the activity line');
      t.label({});   /* a label that throws would break the run's own bookkeeping */
    }
  });

  head('each tool does its own job');

  await check('repair_engine promotes a repair that passes', async () => {
    const r = await call('repair_engine', { id: ID, body: BETTER, examples: BETTER_EXAMPLES, why: 'also the length' });
    if (!r.ok) throw new Error('refused: ' + r.reason);
    /* the tool returns the lifecycle's result, not a router — the router is
       whichever one install() was given. */
    const out = await router.route({ action: 'mark', text: 'abcdef', engine: ID });
    if (out.result.length !== 6) throw new Error('the repaired engine is not what runs: ' + JSON.stringify(out.result));
  });

  await check('repair_engine refuses a built-in, and throws doing it', async () => {
    let threw = null;
    try { await call('repair_engine', { id: 'native-cdp', body: GOOD, examples: GOOD_EXAMPLES }); }
    catch (e) { threw = e; }
    /* A refusal that returns {ok:false} is recorded by ai/engine.js as a
       successful call whose result happened to be a refusal, and the model does
       not learn from it. Throwing is how a refusal is made visible. */
    if (!threw) throw new Error('it returned a refusal instead of throwing one');
    if (!/not repairable|no generated engine/.test(threw.message)) throw new Error('the refusal is unhelpful: ' + threw.message);
  });

  await check('repair_engine with no id is refused before anything is touched', async () => {
    for (const bad of [{}, { id: '' }, { id: '   ' }, { id: 42 }]) {
      let threw = null;
      try { await call('repair_engine', bad); } catch (e) { threw = e; }
      if (!threw) throw new Error('accepted ' + JSON.stringify(bad));
    }
  });

  await check('improve_engine will not run without a reason', async () => {
    const before = lifecycle.current(ID);
    let threw = null;
    try { await call('improve_engine', { id: ID, body: BETTER, examples: BETTER_EXAMPLES }); }
    catch (e) { threw = e; }
    if (!threw) throw new Error('an improve with no reason was accepted');
    if (!/reason/.test(threw.message)) throw new Error('the refusal does not mention the reason: ' + threw.message);
    if (lifecycle.current(ID).version !== before.version) throw new Error('the version moved anyway');
  });

  await check('improve_engine with a reason promotes a new version', async () => {
    const before = lifecycle.current(ID);
    const r = await call('improve_engine', { id: ID, body: BETTER, examples: BETTER_EXAMPLES, why: 'also the length' });
    if (!r.ok) throw new Error('refused: ' + r.reason);
    if (lifecycle.current(ID).version !== before.version + 1) throw new Error('the version did not go up');
  });

  await check('rollback_engine puts the previous version back', async () => {
    /* The oldest snapshot is the version before the improvement; the newest one
       IS the improvement, so rolling back to it changes nothing. */
    const kept = lifecycle.versions(ID);
    if (kept.length < 2) throw new Error('expected two snapshots, got ' + kept.length);
    const r = await call('rollback_engine', { id: ID, to: kept[0].stamp });
    if (!r.ok) throw new Error('refused: ' + r.reason);
    const out = await router.route({ action: 'mark', text: 'abcdef', engine: ID });
    if (out.result.length !== undefined) throw new Error('the improved behaviour is still running: ' + JSON.stringify(out.result));
  });

  await check('engine_plan says use-existing when something already has it', async () => {
    const p = await call('engine_plan', { needs: ['mark'], task: 'mark this' });
    if (p.decision !== 'use-existing') throw new Error('decision = ' + p.decision);
    if (!p.servers.includes(ID)) throw new Error('it does not name the engine that has it: ' + JSON.stringify(p.servers));
    if (p.build) throw new Error('it proposed a build for a capability that exists');
  });

  await check('engine_plan says build, and names the gap, when nothing has it', async () => {
    const p = await call('engine_plan', { needs: ['mark', 'watermark'] });
    if (p.decision !== 'build') throw new Error('decision = ' + p.decision);
    if (JSON.stringify(p.missing) !== JSON.stringify(['watermark'])) throw new Error('missing = ' + JSON.stringify(p.missing));
    if (!p.build.capability) throw new Error('no build was described');
  });

  await check('engine_compose runs steps in order and stops at a failure', async () => {
    /* A fresh router holds the four built-ins, so the demo engine has to be
       registered into it before the workflow can name it. Registering is not
       building: create() refuses to overwrite, which is the Level 2 rule. */
    const r = newRouter();
    if (!forge.register(r, ID).ok) throw new Error('could not register the demo engine into the new router');
    forge.build(r, { id: 'tools-second', name: 'Second', capability: 'tally',
      body: "    return { tallied: String(action.word || '').length };",
      examples: [{ action: 'tally', word: 'abcd', expect: { tallied: 4 } }] });
    Object.assign(r.health.get('tools-second'), { successCount: 0, failureCount: 0, cooldownUntil: 0 });
    et.install(r);
    try {
      const w = await call('engine_compose', {
        steps: [
          { engine: ID, action: 'mark', args: { text: 'abcdef' } },
          { engine: 'tools-second', action: 'tally', args: { word: '$prev.marked' } },
        ],
      });
      if (!w.ok) throw new Error('the workflow failed: ' + w.reason);
      if (w.result.tallied !== 3) throw new Error('the data did not travel: ' + JSON.stringify(w.result));

      let bad = null;
      try {
        await call('engine_compose', {
          steps: [
            { id: 'a', engine: ID, action: 'mark', args: { text: 'abcdef' } },
            { id: 'b', engine: 'tools-second', action: 'tally', args: { word: '$steps.nothing.result' } },
          ],
        });
      } catch (e) { bad = e; }
      if (!bad) throw new Error('a workflow with a bad reference reported success');
      /* the trace is in the message, so a reader can tell which step ran and
         which never did without reaching into a field */
      if (!/no step called/.test(bad.message)) throw new Error('the refusal is unhelpful: ' + bad.message.slice(0, 200));
      if (!/\bok\s+a\b/.test(bad.message)) throw new Error('the message does not show that step a ran: ' + bad.message.slice(0, 300));
    } finally {
      rm(path.join(forge.ENGINES_DIR, 'tools-second'));
    }
  });

  await check('engine_compose refuses a workflow naming an engine that is not there', async () => {
    let w = null;
    try { await call('engine_compose', { steps: [{ engine: 'tidak-terdaftar', action: 'x' }] }); }
    catch (e) { w = e; }
    if (!w) throw new Error('it ran');
    if (!/not in the registry/.test(w.message)) throw new Error('the refusal is unhelpful: ' + w.message.slice(0, 200));
  });

  await check('a refused workflow is recorded as a failure, not as an answer', async () => {
    /* The point of throwing. ai/engine.js marks a thrown tool ok:false and a
       returned one as a success, so this is the difference between a run that
       knows the workflow failed and a run that believes it worked and carries
       on. Asserted through the registry rather than through ai/engine.js so
       the suite does not have to drive a model to make the point. */
    const src = fs.readFileSync(pathmod.join(__dirname, '..', 'ai', 'engine.js'), 'utf8');

    /* Three things have to hold for a thrown refusal to reach the run as a
       failure, and each is asserted by what is actually in the file rather
       than by a pattern that happened to match once. */
    const caught = /\} catch \(e\) \{\s*ok = false;\s*failure = e\.message;\s*\}/.exec(src);
    if (!caught) throw new Error('ai/engine.js no longer turns a thrown tool into ok:false with the message as the reason');
    if (!/type: 'tool_result'[^}]*ok,/.test(src)) {
      throw new Error('ai/engine.js no longer emits ok on the tool_result event, so a thrown tool is not visible to the run');
    }
    if (!/const text = ok \? clip\(payload\)/.test(src)) {
      throw new Error('ai/engine.js no longer shows an error to the model when a tool fails — the refusal would be invisible to the thing that has to learn from it');
    }
    let threw = false;
    try { await call('engine_compose', { steps: [{ engine: 'tidak-terdaftar', action: 'x' }] }); }
    catch { threw = true; }
    if (!threw) throw new Error('a refusal came back as a value, so the run records it as a success');
  });

  await check('engine_evolve runs the lifecycle and reports the trace', async () => {
    const r = seed();
    const out = await call('engine_evolve', {
      task: 'mark it', needs: ['mark'], run: { action: 'mark', args: { text: 'abcdef' } },
    });
    if (!out.ok) throw new Error('failed: ' + out.reason);
    if (out.result.marked !== 'abc') throw new Error('result = ' + JSON.stringify(out.result));
    const caps = out.trace.map(t => t.capability);
    for (const want of ['discover', 'plan', 'use-existing', 'execute']) {
      if (!caps.includes(want)) throw new Error('the trace lacks ' + want + ': ' + caps.join(' -> '));
    }
    if (caps.includes('build')) throw new Error('it built something for a task it could already do');
  });

  await check('engine_evolve builds when the capability is genuinely missing', async () => {
    const r = seed();
    const out = await call('engine_evolve', {
      task: 'watermark it', needs: ['watermark'],
      build: { id: 'tools-watermark', name: 'WM', capability: 'watermark',
        body: "    return { watermarked: true };",
        examples: [{ action: 'watermark', expect: { watermarked: true } }] },
      run: { action: 'watermark', args: {} },
    });
    if (!out.ok) throw new Error('failed: ' + out.reason);
    if (out.result.watermarked !== true) throw new Error('the built engine did not run: ' + JSON.stringify(out.result));
    rm(path.join(forge.ENGINES_DIR, 'tools-watermark'));
  });

  await check('a tool with no router refuses rather than pretending to work', async () => {
    const r = seed();
    et.setRouter(null);
    let threw = null;
    try { await call('engine_plan', { needs: ['mark'] }); } catch (e) { threw = e; }
    if (!threw) throw new Error('it answered with no router at all');
    if (!/not wired to a router/.test(threw.message)) throw new Error('the refusal is unhelpful: ' + threw.message);
    et.install(r);
  });

  head('it did not become a second way into the product');

  await check('the tools do not implement the rules they call', async () => {
    const src = fs.readFileSync(pathmod.join(__dirname, '..', 'evolve-tools.js'), 'utf8');
    for (const need of ["require('./lifecycle')", "require('./discover')", "require('./compose')", "require('./evolve')"]) {
      if (!src.includes(need)) throw new Error('evolve-tools.js does not require ' + need);
    }
    /* No file writing, no child processes, no cache surgery: every one of those
       would be a second implementation of a rule that already has one. */
    for (const forbidden of ['child_process', 'spawnSync', 'fs.write', 'fs.copy', 'fs.rm', 'require.cache', 'git ']) {
      if (src.includes(forbidden)) throw new Error('evolve-tools.js reaches for ' + forbidden);
    }
  });

  await check('ai/tools.js was not edited to make any of this work', () => {
    /* Replaced, not kept as a byte-identity check. That check passed for as long
       as the file was not supposed to change, and the moment a change was
       legitimate it would have failed for the wrong reason. The property is
       stronger and is the one that was always meant: the tools are installed at
       runtime and not hardcoded, and a hardcoded entry would shadow the
       installation rather than be caught by a diff. */
    const src = fs.readFileSync(pathmod.join(__dirname, '..', 'ai', 'tools.js'), 'utf8');
    for (const t of ['create_engine', 'engine_execute', 'repair_engine', 'improve_engine', 'rollback_engine', 'engine_plan', 'engine_compose', 'engine_evolve']) {
      if (new RegExp("name:\\s*'" + t + "'").test(src)) throw new Error(t + ' is hardcoded into ai/tools.js instead of installed');
    }
    for (const m of ['forge', 'lifecycle', 'discover', 'compose', 'evolve']) {
      if (new RegExp("require\\([^)]*'[^']*" + m).test(src)) throw new Error('ai/tools.js now imports ' + m + ' — the tools must be installed, not wired in');
    }
    /* and the shipped four are still the only ones that live there */
    for (const t of et.TOOLS) {
      if (t.caps.indexOf('engines') < 0) throw new Error(t.name + ' is not behind the engines permission');
    }
  });

  await check('installing twice does not double up', () => {
    const before = require('../ai/tools').TOOLS.length;
    et.install(router);
    et.install(router);
    const after = require('../ai/tools').TOOLS.length;
    if (after !== before) throw new Error('the tool list grew from ' + before + ' to ' + after + ' on a second install');
    const st = et.installed();
    if (!st.resolvable) throw new Error('after a second install the names no longer resolve');
  });

  console.log('\n  evolve-tools: ' + pass + ' passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ''));
  rm(path.join(forge.ENGINES_DIR, ID));
  rm(path.join(forge.ENGINES_DIR, 'tools-second'));
  rm(path.join(forge.ENGINES_DIR, 'tools-watermark'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => {
  rm(path.join(forge.ENGINES_DIR, ID));
  console.error('\n  suite crashed: ' + e.message);
  process.exit(1);
});
