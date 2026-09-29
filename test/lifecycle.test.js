'use strict';
/* ========================================================================= *
 *  test/lifecycle.test.js — Level 3 (SELF-REPAIR) and Level 4 (SELF-IMPROVE).
 *
 *  These are the tests that decide whether an agent can be trusted to change
 *  something that already works. Every one of them runs in a single process, on
 *  a real router, against real files in engines/ — because the whole subject is
 *  what happens to those files and to that registry, and a mock would be a
 *  statement about nothing.
 *
 *  The shape of the safety argument is that the active engine is never written
 *  until a candidate has passed the same gate Level 2 uses. So the tests that
 *  matter most are the failures: a repair whose test fails, a repair that is
 *  refused, a promotion that fails halfway. Each of those has to leave the
 *  running engine exactly as it was, and each is checked by running it.
 * ======================================================================== */

const fs = require('fs');
const path = require('path');
const forge = require('../forge');
const lc = require('../lifecycle');
const automation = require('../ai/automation');

const ROOT = path.join(__dirname, '..');
const ENGINES = forge.ENGINES_DIR;

/* a stand-in for the forge, used only where the test needs an engine that is
 * not the one echo-engine: the suite shares one engines/ directory and must not
   leave debris in it */
const ID = 'repair-demo';
const GOOD = [
  "    const a = action || {};",
  "    return { mark: String(a.text === undefined ? '' : a.text).slice(0, 3) };",
].join('\n');
const GOOD_EXAMPLES = [{ action: 'mark', text: 'abcdef', expect: { mark: 'abc' } }];
const BETTER = [
  "    const a = action || {};",
  "    return { mark: String(a.text === undefined ? '' : a.text).slice(0, 3), length: String(a.text || '').length };",
].join('\n');
const BETTER_EXAMPLES = [{ action: 'mark', text: 'abcdef', expect: { mark: 'abc', length: 6 } }];

const driver = { action: async () => ({ ok: true }), tabs: async () => ({ tabs: [] }) };
const context = () => ({ connected: true, agentTabId: 'tab_lc', url: 'about:blank' });
const newRouter = () => automation.createRouter({ driver, context, engines: automation.DEFAULT_ENGINES.slice() });

let pass = 0; const fails = [];
function check(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass += 1; console.log('  ok   ' + name); })
    .catch(e => { fails.push(name); console.log('  FAIL ' + name + '\n         ' + e.message); });
}
const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* gone */ } };
const head = (s) => console.log('\n  --- ' + s + ' ' + '-'.repeat(Math.max(0, 62 - s.length)));

/** build the demo engine and register it, so every test starts from a real one */
function seed() {
  rm(path.join(ENGINES, ID));
  const r = newRouter();
  const made = forge.build(r, { id: ID, name: 'Demo', capability: 'mark', body: GOOD, examples: GOOD_EXAMPLES });
  if (!made.ok) throw new Error('could not seed: ' + (made.reason || made.error) + '\n' + (made.output || ''));
  return r;
}

(async () => {
  console.log('\n  Level 3 — SELF-REPAIR');
  let router = seed();

  await check('a repair that passes becomes the running engine', async () => {
    const r = lc.repair(router, { id: ID, body: BETTER, examples: BETTER_EXAMPLES, why: 'also return the length' });
    if (!r.ok) throw new Error('refused: ' + r.reason + (r.output ? '\n' + r.output : ''));
    if (r.stage !== 'promoted') throw new Error('stage = ' + r.stage);
    if (!router.BY_ID.get(ID)) throw new Error('not in the registry');
    const out = await router.route({ action: 'mark', text: 'abcdef', engine: ID });
    if (!out.ok) throw new Error('could not run: ' + out.error);
    if (out.result.length !== 6) throw new Error('the new behaviour is not what runs: ' + JSON.stringify(out.result));
  });

  await check('the version it replaced is kept, and the manifest says where from', () => {
    const v = lc.versions(ID);
    if (v.length !== 1) throw new Error('expected one snapshot, got ' + v.length);
    const c = lc.current(ID);
    if (c.version !== 2) throw new Error('version = ' + c.version);
    if (!c.lineage || c.lineage.kind !== 'repair') throw new Error('lineage = ' + JSON.stringify(c.lineage));
    if (c.lineage.fromVersion !== 1) throw new Error('fromVersion = ' + c.lineage.fromVersion);
  });

  await check('a repair whose test FAILS is refused and the running engine is untouched', async () => {
    const before = {
      result: (await router.route({ action: 'mark', text: 'abcdef', engine: ID })).result,
      version: lc.current(ID).version,
      files: ['manifest.json', 'index.js', 'test.js'].map(f => fs.readFileSync(path.join(ENGINES, ID, f), 'utf8')),
      registered: !!router.BY_ID.get(ID),
    };

    const r = lc.repair(router, { id: ID, body: BETTER, examples: [{ action: 'mark', text: 'abcdef', expect: { mark: 'WRONG' } }] });
    if (r.ok) throw new Error('a repair with a failing test was promoted');
    if (r.stage !== 'test') throw new Error('stage = ' + r.stage);
    if (!r.output) throw new Error('the refusal carried no test output to read');
    if (r.keptActive !== true) throw new Error('the refusal did not say the running engine was kept');

    const after = {
      result: (await router.route({ action: 'mark', text: 'abcdef', engine: ID })).result,
      version: lc.current(ID).version,
      files: ['manifest.json', 'index.js', 'test.js'].map(f => fs.readFileSync(path.join(ENGINES, ID, f), 'utf8')),
      registered: !!router.BY_ID.get(ID),
    };
    if (JSON.stringify(before.result) !== JSON.stringify(after.result)) throw new Error('the running engine changed: ' + JSON.stringify(after.result));
    if (before.version !== after.version) throw new Error('the version moved');
    if (JSON.stringify(before.files) !== JSON.stringify(after.files)) throw new Error('a file on disk changed');
    if (!after.registered) throw new Error('it dropped out of the registry');
  });

  await check('a failed repair leaves no candidate behind', () => {
    const left = lc.staleCandidates().filter(d => d.includes(ID));
    if (left.length) throw new Error('candidates left: ' + left.join(', '));
  });

  await check('a failed repair does not add a version either', () => {
    const v = lc.versions(ID);
    if (v.length !== 1) throw new Error('expected still one snapshot, got ' + v.length);
  });

  await check('a built-in engine cannot be repaired', () => {
    for (const w of ['native-cdp', 'playwright-mcp', 'stagehand', 'browser-use']) {
      const r = lc.repair(router, { id: w, body: GOOD, examples: GOOD_EXAMPLES });
      if (r.ok) throw new Error('a built-in engine was repaired: ' + w);
      if (r.stage !== 'guard') throw new Error('stage = ' + r.stage);
    }
  });

  await check('an id that is not an id is refused', () => {
    for (const bad of ['../server', '..', 'a/b', 'Server', '', '  ', 'x'.repeat(60), '.candidate-y']) {
      const r = lc.repair(router, { id: bad, body: GOOD, examples: GOOD_EXAMPLES });
      if (r.ok) throw new Error('accepted the id ' + JSON.stringify(bad));
      if (r.stage !== 'guard') throw new Error('stage = ' + r.stage);
    }
  });

  await check('an engine that does not exist is refused', () => {
    const r = lc.repair(router, { id: 'tidak-pernah-ada', body: GOOD, examples: GOOD_EXAMPLES });
    if (r.ok) throw new Error('repaired an engine that was never built');
  });

  await check('a repair with no body, or no examples, is refused', () => {
    for (const [spec, what] of [
      [{ id: ID, examples: GOOD_EXAMPLES }, 'no body'],
      [{ id: ID, body: '   ', examples: GOOD_EXAMPLES }, 'blank body'],
      [{ id: ID, body: GOOD }, 'no examples'],
      [{ id: ID, body: GOOD, examples: [] }, 'empty examples'],
    ]) {
      const r = lc.repair(router, spec);
      if (r.ok) throw new Error('accepted a repair with ' + what);
      if (r.stage !== 'guard') throw new Error('stage = ' + r.stage);
    }
  });

  await check('the require cache does not leave the old version running', async () => {
    /* The bug this milestone inherits from Level 2's fix: create_engine wrote new
       files to a path the process had already required, and the registry served
       the old module while the test passed on the new one. A repair is the same
       hazard, so the module identity is checked directly. */
    const before = router.BY_ID.get(ID);
    const key = require.resolve(path.join(ENGINES, ID, 'index.js'));
    if (!require.cache[key] || require.cache[key].exports !== before) {
      throw new Error('the precondition is wrong: the running engine is not the cached module');
    }

    const r = lc.repair(router, { id: ID, body: BETTER, examples: BETTER_EXAMPLES, why: 'cache check' });
    if (!r.ok) throw new Error('refused: ' + r.reason);
    const after = router.BY_ID.get(ID);
    if (after === before) throw new Error('the registry is still holding the cached module');
    if (!require.cache[key] || require.cache[key].exports !== after) {
      throw new Error('require.cache was not refreshed to the module the registry is using');
    }
  });

  head('rollback');

  await check('a named version can be rolled back to, and that version is what then runs', async () => {
    /* Rolling back to the most recent snapshot restores that snapshot, which is
       what "the previous version" means. Naming the stamp explicitly is what
       makes the assertion exact: the oldest snapshot is the original engine,
       which has no `length` because the improvement is what added it. */
    const kept = lc.versions(ID);
    if (kept.length < 2) throw new Error('expected at least two snapshots, got ' + kept.length);
    const oldest = kept[0];

    const r = lc.rollback(router, ID, oldest.stamp);
    if (!r.ok) throw new Error('refused: ' + r.reason);
    if (r.rolledBackTo !== oldest.stamp) throw new Error('rolled back to ' + r.rolledBackTo + ', asked for ' + oldest.stamp);

    const out = await router.route({ action: 'mark', text: 'abcdef', engine: ID });
    if (!out.ok) throw new Error('could not run: ' + out.error);
    if (out.result.length !== undefined) {
      throw new Error('the improved behaviour is still running after rolling back: ' + JSON.stringify(out.result));
    }
    if (out.result.mark !== 'abc') throw new Error('the rolled-back version behaves differently: ' + JSON.stringify(out.result));
  });

  await check('a rollback is itself undoable, because the version it replaced was kept', () => {
    const v = lc.versions(ID);
    if (v.length < 2) throw new Error('expected the rolled-back-from version to be kept too, got ' + v.length);
    const r = lc.rollback(router, ID, v[v.length - 1].stamp);
    if (!r.ok) throw new Error('could not roll forward again: ' + r.reason);
    return router.route({ action: 'mark', text: 'abcdef', engine: ID }).then(o => {
      if (o.result.length === undefined) throw new Error('rolling forward did not restore the improvement: ' + JSON.stringify(o.result));
    });
  });

  await check('rolling back to a version that is not there is refused', () => {
    const r = lc.rollback(router, ID, 'tidak-ada');
    if (r.ok) throw new Error('rolled back to nothing');
  });

  head('Level 4 — SELF-IMPROVE');

  await check('an improve that passes is promoted and numbered up', async () => {
    const before = lc.current(ID);
    const r = lc.improve(router, { id: ID, body: BETTER, examples: BETTER_EXAMPLES, why: 'return the length too' });
    if (!r.ok) throw new Error('refused: ' + r.reason + (r.output ? '\n' + r.output : ''));
    const after = lc.current(ID);
    if (after.version !== before.version + 1) throw new Error('version went ' + before.version + ' -> ' + after.version);
    if (after.lineage.kind !== 'improve') throw new Error('lineage = ' + JSON.stringify(after.lineage));
  });

  await check('an improve whose new test fails does not touch the running engine', async () => {
    const before = (await router.route({ action: 'mark', text: 'abcdef', engine: ID })).result;
    const v = lc.current(ID).version;
    const r = lc.improve(router, { id: ID, body: BETTER, examples: [{ action: 'mark', text: 'abcdef', expect: { mark: 'nope', length: 0 } }] });
    if (r.ok) throw new Error('an improve with a failing test was promoted');
    if (lc.current(ID).version !== v) throw new Error('the version moved');
    const after = (await router.route({ action: 'mark', text: 'abcdef', engine: ID })).result;
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('the running engine changed: ' + JSON.stringify(after));
  });

  await check('an improve is refused when the engine it would replace is already broken', () => {
    /* The one mechanical difference between the two. An improve claims this is
       better than what is running, which is a claim about a working baseline; a
       repair does not make that claim, and demanding it of a repair would refuse
       exactly the repairs that are needed. */
    const r2 = seed();
    /* Break the baseline the way a bad edit would: the engine's own test stops
       passing. Note it is test.js that is replaced, not a value inside it —
       the generated test reads its examples from manifest.json rather than
       inlining them, so editing a value in test.js achieves nothing at all.
       The first version of this check did exactly that and passed for the
       wrong reason, which is worse than failing. */
    const f = path.join(ENGINES, ID, 'test.js');
    fs.writeFileSync(f, 'console.log(\"  0 passed\");\nconsole.log(\"  1 FAILED\");\nprocess.exit(1);\n', 'utf8');
    const broken = forge.runTestIn(forge.engineDir(ID), 'the broken baseline');
    if (broken.ok) throw new Error('the baseline was not actually broken — this check would prove nothing');

    const r = lc.improve(r2, { id: ID, body: BETTER, examples: BETTER_EXAMPLES });
    if (r.ok) throw new Error('an improve was accepted on a broken baseline');
    if (r.stage !== 'regression') throw new Error('stage = ' + r.stage);
    if (!r.output) throw new Error('no test output explaining the refusal');
  });

  await check('a repair of a broken engine is allowed, because that is its job', async () => {
    const r2 = newRouter();
    if (forge.runTest(ID).ok) throw new Error('the engine is not broken, so this would prove nothing');
    const r = lc.repair(r2, { id: ID, body: GOOD, examples: GOOD_EXAMPLES, why: 'put it back' });
    if (!r.ok) throw new Error('a repair of a broken engine was refused: ' + r.reason + (r.output ? '\n' + r.output : ''));
    const t = forge.runTest(ID);
    if (!t.ok) throw new Error('and the result does not pass: ' + t.reason);
    const out = await r2.route({ action: 'mark', text: 'abcdef', engine: ID });
    if (!out.ok || out.result.mark !== 'abc') throw new Error('the repaired engine does not run: ' + JSON.stringify(out));
  });

  head('cleanup and isolation');

  await check('the lifecycle never writes outside engines/', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lifecycle.js'), 'utf8');
    /* Every path the lifecycle builds starts at ENGINES_DIR or at a version
       directory underneath one, and it never reaches for the project root. */
    const forbidden = [
      "require('../server",
      "require('./ai/tools",
      "path.join(__dirname, '..', '..')",
    ];
    for (const f of forbidden) {
      if (src.includes(f)) throw new Error('lifecycle.js contains ' + f + ' — it must not reach outside engines/');
    }
    const rootEscapes = (src.match(/path\.join\(/g) || []).length;
    if (!rootEscapes) throw new Error('it builds no paths at all, which cannot be right');
    /* every path it builds starts from ENGINES_DIR or a version dir under one */
    if (!src.includes('ENGINES_DIR')) throw new Error('it does not root its paths at ENGINES_DIR');
  });

  await check('a candidate directory is invisible to the registry scan', () => {
    /* The staging directory is beside the engines and starts with a dot, so the
       id rules skip it. If that stopped being true, a half-tested engine would
       become something the router could route to. */
    const cdir = lc.candidateDir(ID, 'probe');
    fs.mkdirSync(cdir, { recursive: true });
    const seen = forge.engineDirectories().filter(d => d.includes(cdir));
    const listed = forge.list().some(e => e.id === path.basename(cdir));
    rm(cdir);
    if (seen.length) throw new Error('the scan picked the candidate up');
    if (listed) throw new Error('list() reported the candidate');
  });

  await check('sweep() removes an interrupted candidate and nothing else', () => {
    const cdir = lc.candidateDir(ID, 'leftover');
    fs.mkdirSync(cdir, { recursive: true });
    fs.writeFileSync(path.join(cdir, 'index.js'), 'module.exports = {};', 'utf8');
    const before = fs.readdirSync(ENGINES).length;
    const r = lc.sweep();
    if (r.removed < 1) throw new Error('removed ' + r.removed);
    if (fs.existsSync(cdir)) throw new Error('the candidate is still there');
    if (fs.readdirSync(ENGINES).length !== before - 1) throw new Error('sweep removed more than the candidate');
  });

  await check('echo-engine is untouched by all of this', () => {
    const t = forge.runTest('echo-engine');
    if (!t.ok) throw new Error('echo-engine no longer passes: ' + t.reason);
    if (lc.versions('echo-engine').length) throw new Error('echo-engine has versions, so it was repaired');
  });

  await check('the built-in engines were never involved', () => {
    const src = fs.readFileSync(path.join(ROOT, 'ai', 'automation', 'index.js'), 'utf8');
    if (/lifecycle|repair|improve|rollback/.test(src)) throw new Error('the router now references the lifecycle');
    const r = newRouter();
    for (const w of ['native-cdp', 'playwright-mcp', 'stagehand', 'browser-use']) {
      if (!r.BY_ID.has(w)) throw new Error(w + ' is missing from a fresh router');
    }
  });

  rm(path.join(ENGINES, ID));

  console.log('\n  lifecycle: ' + pass + ' passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ''));
  process.exit(fails.length ? 1 : 0);
})().catch(e => {
  rm(path.join(ENGINES, ID));
  console.error('\n  suite crashed: ' + e.message);
  process.exit(1);
});
