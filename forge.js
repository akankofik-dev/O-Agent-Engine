'use strict';
/* ========================================================================= *
 *  forge.js — the agent builds an engine, watches it fail, and only then lets
 *  it near the router.
 *
 *  What this is for
 *  ----------------
 *  One thing, proven end to end: an agent can notice a capability it does not
 *  have, write an engine that provides it, test that engine, and get the
 *  router to use it — with the router, the engine contract, native-cdp and the
 *  Workbench all exactly as they were.
 *
 *  The three rules
 *  ---------------
 *  1. Nothing is written outside `engines/`. Every path is built from a
 *     validated id and then checked to have landed inside that one directory,
 *     so a name like `../../server` cannot become a write. The project is not
 *     a canvas here; the agent gets a folder and nothing else.
 *
 *  2. A test is the only way in. `register()` runs the engine's own test and
 *     refuses on a non-zero exit, on a timeout, and on output that does not say
 *     it passed. There is no flag that skips it and no path that reaches the
 *     router around it, because the writer of this file is the thing most able
 *     to take that shortcut and is therefore the one that must not have it.
 *
 *  3. A refused engine stays on disk, registered to nothing. The work is not
 *     thrown away — the user can read the failure and fix it — but nothing can
 *     reach it until it passes. Failing and disappearing are different
 *     mistakes, and this is only the first one.
 *
 *  The honest limit, stated here rather than in a comment three files away
 *  ---------------------------------------------------------------------
 *  Running an engine's test means running code this process just wrote, with
 *  this user's privileges, on this machine. That is not sandboxed and cannot
 *  be, without a container or a second user, neither of which this product has.
 *  So the boundary this file actually enforces is *where the code may be
 *  written* and *whether it may run at all* — not *what it may do once it
 *  runs*. An agent that can call create_engine is an agent that can run
 *  arbitrary code, and the permission to do that has to be a decision someone
 *  made on purpose, not a side effect of a tool existing.
 *
 *  What it does not do: it does not add an engine to the router by editing
 *  ai/automation/index.js. It hands the engine to the router object that
 *  already exists, through the three fields createRouter() already returns.
 * ========================================================================= */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const ENGINES_DIR = path.join(ROOT, 'engines');

/* An id becomes a directory name, a require() path and a key in three maps, so
   it is held to the narrowest shape all three are happy with. Anything looser
   is a name, not an id. */
const ID_RE = /^[a-z][a-z0-9-]{1,40}$/;

/* how long an engine's own test may take before it is called a failure. Long
   enough for a real test, short enough that a hung one cannot wedge a turn. */
const TEST_TIMEOUT_MS = 20000;

/* the contract index.js actually calls. Missing any of these is not a warning,
   it is an engine the router cannot reason about, so it is refused before the
   router is ever handed the object. */
const REQUIRED = ['id', 'name', 'type', 'capabilities', 'available', 'execute', 'observe', 'recover'];

/* ------------------------------------------------------------------ paths -- */

/**
 * The one place a path is built, and the one place it is checked.
 *
 * Both halves matter and neither substitutes for the other. Validating the id
 * stops the obvious names; resolving the result and comparing it to ENGINES_DIR
 * stops the ones nobody thought of. The check is on the *resolved* path on
 * purpose — a prefix test on the unresolved string is defeated by `a/../b`, and
 * this is filesystem code, so it gets the version that is actually true.
 */
function engineDir(id) {
  const name = String(id || '');
  if (!ID_RE.test(name)) throw new Error('not a usable engine id: ' + JSON.stringify(name) + ' — use lowercase letters, digits and dashes');
  const dir = path.resolve(ENGINES_DIR, name);
  /* the trailing separator is what stops `engines/evil-x` from passing as
     `engines/evil` — a prefix match without it accepts a sibling */
  if (dir !== ENGINES_DIR && !dir.startsWith(ENGINES_DIR + path.sep)) {
    throw new Error('that name does not land inside engines/');
  }
  return dir;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

/* ---------------------------------------------------------------- survey --- */

/**
 * What the agent knows before it builds anything.
 *
 * The point of the third field is that it is a list of things that do not
 * exist yet. An agent that can only see what is available has no way to tell
 * "I should build this" from "I cannot do this", and the difference is the
 * whole question. So the survey reports capabilities as a set, and the gaps
 * fall out of comparing it with the set the router understands.
 *
 * The router's vocabulary is the one in ai/automation/index.js — read, not
 * restated here, because a copy would drift and a drifted copy would be a lie
 * about what the router can do.
 */
function survey() {
  const automation = require('./ai/automation');
  const state = require('./ai/automation/state');

  const built = [];
  for (const e of automation.DEFAULT_ENGINES) {
    built.push({ id: e.id, name: e.name, type: e.type, builtIn: !!e.builtIn, capabilities: e.capabilities || [] });
  }
  const generated = list().filter(e => e.registered);

  const have = new Set();
  for (const e of built.concat(generated)) {
    for (const c of e.capabilities || []) have.add(c);
  }

  return {
    engines: built.concat(generated),
    /* what the router can route on today, and what it would need for something
       new. `ai/automation/index.js` needed() is the only definition of "needs",
       so a capability that appears nowhere there is reported as buildable
       rather than as supported. */
    capabilities: Array.from(have).sort(),
    routerVocabulary: Object.keys(require('./ai/automation')).includes('classify') ? true : false,
    known: state.KNOWN.slice(),
    enginesDir: ENGINES_DIR,
  };
}

/** every engine on disk, registered or not, and whether its test passes now */
function list() {
  let names = [];
  try { names = fs.readdirSync(ENGINES_DIR, { withFileTypes: true }); }
  catch { return []; }
  const out = [];
  for (const d of names) {
    if (!d.isDirectory() || !ID_RE.test(d.name)) continue;
    const dir = path.join(ENGINES_DIR, d.name);
    const m = readJson(path.join(dir, 'manifest.json'), null);

    /* Once, not twice. An earlier version asked canRegister() for the verdict
       and then again for the reason, which ran every engine's test twice over
       on every survey — and the survey is what an agent calls first. */
    const verdict = canRegister(d.name);

    /* capabilities are read off the module, not the manifest, because the
       manifest is a claim and survey() is what the agent decides on. An engine
       that has drifted from its manifest reports what it can actually do. */
    let capabilities = [];
    if (m && Array.isArray(m.capability)) capabilities = m.capability.slice();
    else if (m && m.capability) capabilities = [m.capability];
    if (verdict.ok) {
      try { capabilities = require(path.join(dir, 'index.js')).capabilities || capabilities; }
      catch { /* canRegister already refused it; the manifest's claim stands */ }
    }

    out.push({
      id: d.name,
      name: m && m.name ? m.name : d.name,
      capability: m && m.capability ? m.capability : null,
      capabilities,
      /* "registered" here means "its test passes and the contract holds", which
         is what the router's own bar is. It is deliberately not "someone called
         register()", so a file edited after the fact cannot claim a standing it
         has not earned. */
      registered: verdict.ok,
      why: verdict.reason,
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/* --------------------------------------------------------------- writing --- */

/**
 * The manifest, the implementation and the test, as text.
 *
 * Templates rather than a program that assembles source: the generated code is
 * then readable by a person, which is the only way anyone finds out what the
 * agent actually wrote. Everything the caller controls arrives through
 * JSON.stringify, so a capability name is a string in a file and never a piece
 * of syntax — there is no path here where a name becomes code.
 */
function scaffold(spec) {
  const id = String(spec.id);
  const capability = String(spec.capability);
  const name = String(spec.name || (capability + ' engine'));
  const body = String(spec.body || '');
  const examples = Array.isArray(spec.examples) && spec.examples.length
    ? spec.examples
    : [{ text: 'hello', expect: { echoed: 'hello' } }];

  const manifest = {
    id,
    name,
    capability,
    type: 'generated',
    version: 1,
    /* the contract this engine claims, written down so a reader does not have
       to infer it from the shape of the file */
    contract: REQUIRED.slice(),
    /* what it promises to do, and what doing it looks like. The generated test
       checks the engine against these, which is what makes the test the
       engine's own claim about itself rather than a formality. */
    examples,
    builtBy: 'forge',
  };

  const index = `'use strict';
/* GENERATED by forge.js — engine "${id}".
 * Edit it, edit manifest.json's \`examples\` to match, and re-register. The
 * test below is not a formality: it runs this file and checks it against those
 * examples, so changing the behaviour without changing the claim fails here. */

const { requireContext } = require('../../ai/automation/context');

const ID = ${JSON.stringify(id)};

module.exports = {
  id: ID,
  name: ${JSON.stringify(name)},
  type: 'generated',
  capabilities: [${JSON.stringify(capability)}, 'act'],

  async available() {
    return { available: true, reason: 'generated engine; its test passed at registration' };
  },

  async execute(action, ctx, driver) {
    /* A generated engine has no browser of its own, exactly like native-cdp:
       it is handed a context and a driver and may do nothing else. The tab is
       never chosen here. */
    requireContext(ctx);
${body}
  },

  async observe() {
    return { observed: false, reason: ID + ' reports no observation' };
  },

  async recover() {
    return { retried: false, reason: ID + ' holds no state to recover' };
  },
};
`;

  const test = `'use strict';
/* GENERATED by forge.js — the test for engine "${id}".
 *
 * Two things are checked, and the second is the one that matters:
 *   1. the seven members the router calls all exist
 *   2. execute() does what manifest.json says it does
 *
 * (2) is why this is a real test. An engine that returns nothing, or returns
 * the wrong shape, or throws, fails here — and an engine that fails here is
 * never handed to the router. */

const assert = require('assert');
const path = require('path');
const manifest = require(path.join(__dirname, 'manifest.json'));
const engine = require(path.join(__dirname, 'index.js'));

const METHODS = ['available', 'execute', 'observe', 'recover'];

let passed = 0;
const fails = [];

/* await the callback, not just try. This line is the difference between a
 * test and a rubber stamp. execute() is async, so a failed assertion becomes
 * a rejected promise — and a rejected promise sails straight past a
 * synchronous catch, and gets reported as ok. An earlier version of this
 * generator got that wrong, and the acceptance test caught it registering an
 * engine that answered with the wrong value. */
const check = async (name, fn) => {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { fails.push(name); console.log('  FAIL ' + name + '\\n         ' + (e && e.message ? e.message : e)); }
};

/* A rejection anywhere else is a failure, not a shrug. Without this, a throw
 * outside a check() — a broken require, a top-level await — could leave the
 * process exiting 0 with nothing on screen to say otherwise. */
let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  console.log('\\n  ' + manifest.id + ': ' + passed + ' passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ''));
  process.exit(fails.length ? 1 : 0);
}
process.on('unhandledRejection', e => {
  fails.push('unhandled rejection');
  console.log('  FAIL unhandled rejection\\n         ' + (e && e.message ? e.message : e));
  finish();
});

/* a context with a tab, because requireContext() refuses without one and an
 * engine that needs no tab still has to survive asking for it */
const ctx = { agentTabId: 'tab_forge', connected: true, url: 'about:blank' };
const driver = { action: async a => ({ ok: true, echo: 'driver', action: a }), tabs: async () => ({ tabs: [] }) };

(async () => {
  console.log('\\n  ' + manifest.id + ' — generated engine test');

  await check('the manifest names the engine this file is for', () => {
    assert.strictEqual(engine.id, manifest.id, 'engine.id is ' + engine.id + ', manifest says ' + manifest.id);
  });

  await check('every member the router calls is present, and is a function where it should be', () => {
    for (const k of manifest.contract) {
      assert.ok(engine[k] !== undefined && engine[k] !== null, 'missing: ' + k);
      if (METHODS.includes(k)) {
        assert.strictEqual(typeof engine[k], 'function', k + ' must be a function, it is ' + typeof engine[k]);
      }
    }
  });

  await check('available() answers, and answers in the shape the router reads', async () => {
    const r = await engine.available();
    assert.ok(r && typeof r.available === 'boolean', 'available() must return { available: boolean }, got ' + JSON.stringify(r));
  });

  await check('execute() is a function, because that is the one the router calls', () => {
    assert.strictEqual(typeof engine.execute, 'function', 'execute must be a function, it is ' + typeof engine.execute);
  });

  await check('the capabilities are a non-empty list of strings', () => {
    assert.ok(Array.isArray(engine.capabilities) && engine.capabilities.length, 'capabilities must be a non-empty array');
    for (const c of engine.capabilities) assert.strictEqual(typeof c, 'string', 'capability is not a string: ' + c);
  });

  await check('the manifest promises at least one example, so "it works" is a claim and not an absence', () => {
    assert.ok(Array.isArray(manifest.examples) && manifest.examples.length,
      'manifest.examples is empty — a test with nothing to check passes forever');
  });

  const n = (manifest.examples || []).length;
  for (let i = 0; i < n; i++) {
    const ex = manifest.examples[i];
    await check('example ' + (i + 1) + ': execute(' + JSON.stringify(ex.action) + ') matches what the manifest claims', async () => {
      /* The whole example is handed over, not ex.action. The router calls
         execute(action, ...) with the action object, and an example IS an
         action plus an expectation — so passing ex.action here would test the
         engine against a shape it is never called with, and a test that used a
         different shape than production is a test that proves something else. */
      const got = await engine.execute(ex, ctx, driver);
      assert.deepStrictEqual(got, ex.expect,
        'returned ' + JSON.stringify(got) + ', manifest claims ' + JSON.stringify(ex.expect));
    });
  }

  finish();
})().catch(e => {
  fails.push('suite crashed');
  console.error('  suite crashed: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
`;

  return { 'manifest.json': JSON.stringify(manifest, null, 2) + '\n', 'index.js': index, 'test.js': test };
}

/**
 * Write an engine to disk.
 *
 * Refuses to overwrite. A second `create` with the same id is a mistake worth
 * stopping for, not a case to resolve by deleting whatever was there — that
 * file may be the one engine the user spent an afternoon making work.
 */
function create(spec) {
  const dir = engineDir(spec && spec.id);           // throws before anything is written
  if (fs.existsSync(dir)) {
    return { ok: false, error: 'there is already an engine called "' + path.basename(dir) + '" — edit it instead' };
  }
  const files = scaffold(spec);
  ensureDir(dir);
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body, 'utf8');
  }
  return { ok: true, id: path.basename(dir), dir, files: Object.keys(files) };
}

/* --------------------------------------------------------------- testing --- */

/**
 * Run an engine's own test. The only gate into the router, so it is written to
 * be hard to pass by accident.
 *
 * Three conditions have to hold, and all three are checked:
 *   - the process exits 0
 *   - it finished inside the timeout
 *   - it printed a pass line
 *
 * The third is why a test that crashes silently, or a `node` that dies before
 * running anything, is a failure rather than a shrug. "Exited 0" is what a
 * script that never ran also does.
 */
function runTest(id) {
  const dir = engineDir(id);
  const file = path.join(dir, 'test.js');
  if (!fs.existsSync(file)) return { ok: false, reason: 'there is no test.js in ' + path.basename(dir) };

  const r = spawnSync(process.execPath, [file], {
    cwd: dir,
    timeout: TEST_TIMEOUT_MS,
    encoding: 'utf8',
    windowsHide: true,
    /* Nothing is inherited that could make a test look like it passed. The
       environment is the one place a stray NODE_OPTIONS or CI flag can turn a
       real failure into a quiet exit, and this is a gate, not a convenience. */
    env: { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '', TEMP: process.env.TEMP || '', TMP: process.env.TMP || '' },
  });

  const out = String(r.stdout || '') + String(r.stderr || '');
  if (r.error && r.error.code === 'ETIMEDOUT') {
    return { ok: false, reason: 'its test did not finish in ' + (TEST_TIMEOUT_MS / 1000) + 's', output: out.slice(0, 2000) };
  }
  if (r.status !== 0) {
    return { ok: false, reason: 'its test failed (exit ' + r.status + ')', output: out.slice(0, 2000) };
  }
  if (!/\d+\s+passed/.test(out)) {
    return { ok: false, reason: 'its test printed no pass count, so there is nothing to believe', output: out.slice(0, 2000) };
  }
  return { ok: true, reason: 'its test passed', output: out.slice(0, 2000) };
}

/** the contract, checked where a contract can be checked: against the object */
function contractErrors(engine) {
  const bad = [];
  if (!engine || typeof engine !== 'object') return ['the module did not export an object'];
  for (const k of REQUIRED) {
    const v = engine[k];
    if (v === undefined || v === null) { bad.push('missing ' + k); continue; }
    if (typeof v === 'function') continue;
    if (k === 'capabilities') {
      if (!Array.isArray(v) || !v.length) bad.push('capabilities must be a non-empty array');
      else if (v.some(c => typeof c !== 'string')) bad.push('capabilities must all be strings');
      continue;
    }
    if (typeof v !== 'string') bad.push(k + ' must be a string');
  }
  return bad;
}

/** could this be registered right now? the reason is the useful part */
function canRegister(id) {
  const v = verify(id);
  return { ok: v.ok, reason: v.reason, output: v.output };
}

/**
 * The whole judgement about one engine, made once.
 *
 * Everything that needs to know whether an engine is allowed in — list(),
 * canRegister(), register(), registerAll() — goes through here, and here is why
 * that matters: this is the function that runs the engine's test, and the test
 * is a child process. An earlier version asked for the verdict and then for the
 * reason, and ran every engine's test twice; registerAll() over a directory of
 * ten engines would have run twenty subprocesses to answer one question.
 *
 * The module comes back on the object when the verdict is yes, so a caller that
 * is about to install it does not have to require() it again and hope for the
 * same answer.
 *
 * @returns {{ok:boolean, reason:string, output?:string, capabilities?:string[], engine?:object}}
 */
function verify(id) {
  let dir;
  try { dir = engineDir(id); }
  catch (e) { return { ok: false, reason: e.message }; }
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) return { ok: false, reason: 'no manifest.json' };
  if (!fs.existsSync(path.join(dir, 'index.js'))) return { ok: false, reason: 'no index.js' };

  let engine;
  try { engine = require(path.join(dir, 'index.js')); }
  catch (e) { return { ok: false, reason: 'index.js did not load: ' + String(e.message).slice(0, 160) }; }

  const bad = contractErrors(engine);
  if (bad.length) return { ok: false, reason: 'contract: ' + bad.join('; ') };

  /* The manifest may be missing or unreadable and that is not fatal on its own
     — the contract above is what the router needs. But when a manifest is there
     and disagrees, that is a real refusal: it means the engine and its own
     description have drifted apart, and the agent would go on believing the
     description. */
  const m = readJson(path.join(dir, 'manifest.json'), {});
  if (m.id && m.id !== engine.id) return { ok: false, reason: 'manifest says ' + m.id + ', the engine says ' + engine.id };
  if (m.capability && Array.isArray(engine.capabilities) && !engine.capabilities.includes(m.capability)) {
    return { ok: false, reason: 'the engine does not claim the capability its manifest names (' + m.capability + ')' };
  }

  const t = runTest(id);
  return { ok: t.ok, reason: t.reason, output: t.output, capabilities: engine.capabilities || [], engine: t.ok ? engine : undefined };
}

/* ------------------------------------------------------------ registering -- */

/** is this what createRouter() handed back, and not something that looks like it */
function isRouter(r) {
  return !!r && Array.isArray(r.ENGINES) && r.BY_ID instanceof Map && r.health instanceof Map
    && typeof r.invalidate === 'function';
}

/** every directory under engines/ whose name is a usable id. No tests are run
 *  here on purpose: this is the cheap scan, and verify() is the expensive one. */
function engineDirectories() {
  let entries = [];
  try { entries = fs.readdirSync(ENGINES_DIR, { withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter(d => d.isDirectory() && ID_RE.test(d.name))
    .map(d => d.name)
    .sort();
}

/**
 * Put a module that has already passed verify() into a live registry.
 *
 * This is the only function that writes to the router, and it is not exported.
 * It is reachable only through verify() — register() and registerAll() both come
 * through here, and neither can hand it a module that skipped the test, because
 * verify() is what produced the module in the first place. A future caller that
 * wants to put something in the registry without a passing test has to export
 * this, which is a change someone has to make on purpose and a reviewer can see.
 *
 * No duplicate is possible. An id already in BY_ID is replaced in place, not
 * appended, so registering the same engine twice leaves one entry rather than
 * two — and half of `rank()` iterating a duplicated list would be an engine
 * asked to do the same action twice.
 *
 * `keepStanding` is the difference between the two callers. A re-register after
 * an edit keeps the engine's health, because a new version should not be handed
 * a clean slate it did not earn. A fresh boot-registration does not need to keep
 * anything, because there is nothing there yet.
 */
function installIntoRegistry(router, mod, verdict) {
  const id = mod.id;
  const h = router.health.get(id);

  if (router.BY_ID.has(id)) {
    const at = router.ENGINES.findIndex(e => e && e.id === id);
    if (at >= 0) router.ENGINES.splice(at, 1, mod);
    else router.ENGINES.push(mod);              /* in BY_ID but not ENGINES: repair rather than duplicate */
    if (h) {
      h.available = true;
      h.reason = 'generated engine; its test passed at registration';
      h.capabilities = mod.capabilities || [];
    }
  } else {
    router.ENGINES.push(mod);
    router.health.set(id, {
      id,
      available: true,
      reason: 'generated engine; its test passed at registration',
      capabilities: mod.capabilities || [],
      sharesContext: true,
      lastUsed: 0, lastError: '', successCount: 0, failureCount: 0, cooldownUntil: 0,
    });
  }

  router.BY_ID.set(id, mod);
  router.invalidate();
  return { ok: true, id, registered: true, reason: (verdict && verdict.reason) || 'its test passed', capabilities: mod.capabilities || [] };
}

/**
 * Hand one engine to a router that already exists.
 *
 * The router is not rebuilt and its source is not edited. `createRouter()`
 * already returns `ENGINES`, `BY_ID` and `health`, and those three are the
 * whole registry: the router reads them and nothing else, so an engine added
 * here is chosen by the same rank() that chooses native-cdp, recovers through
 * the same recover(), and is described by the same describe().
 *
 * The two lists that are NOT touched are why this is safe at runtime.
 * `ai/automation/state.js` KNOWN decides which engine ids a *user preference*
 * may name, and an id missing from it is not disabled — describe() treats an
 * absent entry as enabled. So a generated engine routes without ever editing
 * the file that holds the four shipped ids, and the day someone adds it there
 * it starts behaving like any other preference.
 *
 * @param {object} router  what createRouter() returned
 * @param {string} id      the engine's directory name
 */
function register(router, id) {
  if (!isRouter(router)) return { ok: false, error: 'that is not a router — pass what createRouter() returned' };

  const verdict = verify(id);
  if (!verdict.ok) {
    /* Not an exception. The engine stays on disk and registered to nothing, so
       a person can read the test output and fix it. Registering is the only
       step that can be refused, and refusing it is the whole design. */
    return { ok: false, id, registered: false, reason: verdict.reason, output: verdict.output || '', fix: 'edit engines/' + id + ' and register again' };
  }

  return installIntoRegistry(router, verdict.engine, verdict);
}

/**
 * Register everything in engines/ that deserves it, and neither crash nor give
 * up on account of the ones that do not.
 *
 * This is what makes the feature survive a restart. An engine the agent built
 * yesterday is a directory on disk and nothing else; without this, it exists and
 * is unreachable. With it, boot is: scan, verify each, install the ones that
 * pass.
 *
 * The failure rules, stated because each one is a choice:
 *
 *   - an invalid engine is skipped and reported, never thrown. A malformed
 *     index.js in engines/ must not be able to stop the server from starting —
 *     that would make the folder an attack surface for denial rather than a
 *     place to build things.
 *   - a failing test is skipped, exactly as in register().
 *   - an id already in the registry is left alone. This is what stops a second
 *     call, or a boot after a build in the same process, from registering an
 *     engine twice.
 *   - every verdict is returned. A caller that wants to log what was skipped has
 *     it; a caller that does not can ignore the array. What is not allowed is
 *     silence.
 *
 * Each engine's test runs exactly once, which is the reason verify() exists as
 * its own function rather than being folded into register().
 */
function registerAll(router) {
  if (!isRouter(router)) return { ok: false, error: 'that is not a router — pass what createRouter() returned' };

  const out = { ok: true, registered: [], alreadyRegistered: [], failed: [], results: [] };

  for (const id of engineDirectories()) {
    if (router.BY_ID.has(id)) {
      out.alreadyRegistered.push(id);
      out.results.push({ id, ok: true, registered: false, reason: 'already registered' });
      continue;
    }
    const verdict = verify(id);
    if (!verdict.ok) {
      out.failed.push({ id, reason: verdict.reason, output: verdict.output || '' });
      out.results.push({ id, ok: false, registered: false, reason: verdict.reason, output: verdict.output || '' });
      continue;
    }
    const r = installIntoRegistry(router, verdict.engine, verdict);
    out.registered.push(id);
    out.results.push({ id, ok: r.ok, registered: r.ok, reason: r.reason, capabilities: r.capabilities });
  }

  return out;
}
/** take an engine back out. Used by the tests, and by a person changing their mind. */
function unregister(router, id) {
  if (!router || !Array.isArray(router.ENGINES) || !(router.BY_ID instanceof Map)) {
    return { ok: false, error: 'that is not a router' };
  }
  const had = router.BY_ID.delete(id);
  const at = router.ENGINES.findIndex(e => e && e.id === id);
  if (at >= 0) router.ENGINES.splice(at, 1);
  router.health.delete(id);
  router.invalidate();
  return { ok: true, id, wasRegistered: had };
}

/**
 * Build, test and register, in one call — the shape the agent actually wants.
 *
 * Written as one function rather than three because the order is the safety
 * property: an agent that has to remember "test before register" will one day
 * not. Here the order is not a convention anybody can forget, it is the shape
 * of the only door.
 */
function build(router, spec) {
  const made = create(spec);
  if (!made.ok) return { ok: false, stage: 'create', ...made };
  const verdict = canRegister(made.id);
  if (!verdict.ok) {
    return { ok: false, stage: 'test', id: made.id, registered: false, reason: verdict.reason, output: verdict.output || '', dir: made.dir };
  }
  const reg = register(router, made.id);
  return { ok: reg.ok, stage: reg.ok ? 'registered' : 'register', id: made.id, dir: made.dir, ...reg };
}

/* ------------------------------------------------------ the agent's tool -- */

/**
 * The one tool this milestone adds, and how it gets in.
 *
 * There is no `create_engine` in ai/tools.js and this file does not put one
 * there. The tool list is a hardcoded array and the agent's tool set is
 * `TOOLS.filter(t => t.caps.some(c => resolved.caps[c]))` — a filter over a
 * fixed list of permission keys, and a permission key for "this agent may write
 * and run code" is not among them. Adding one is a two-line change to
 * ai/store.js and ai/rules.js, both of which were off limits here, so this
 * ships the tool and the wiring and says plainly what is still missing.
 *
 * What IS done, and measured rather than assumed:
 *   - `TOOLS` is exported and is a plain array, so a tool can be added at
 *     runtime. Measured: toolsFor() and schemasFor() both pick it up.
 *   - `BY_NAME` is built once at load, is NOT exported, and `toolByName()`
 *     reads it — so a runtime-added tool is offered to the model and then
 *     refused as "unknown tool" on every call. Measured.
 *   - `ai/engine.js` calls `tools.toolByName(call.name)`, a property lookup at
 *     call time, not a captured reference. So replacing the exported function
 *     is observed. Measured.
 *
 * Which is why installTool() does both: push the definition, and wrap the lookup so
 * it also finds what the forge added. The alternative — editing the private map
 * — is not available from outside the module, and would be the wrong thing to
 * reach for if it were.
 *
 * And the honest limit of the whole arrangement: this is runtime patching of
 * another module's exports. It is not a hook ai/tools.js agreed to. It works
 * today, and if that file is ever refactored to capture `toolByName` in a local,
 * this stops working — which is why `installed()` reports what is actually true
 * rather than what was true when it was written.
 */

const TOOL_CAP = 'engines';

/** what the agent is told, and the shape it has to call it with */
const TOOL = {
  name: 'create_engine',
  description:
    'Look at what automation engines exist, or build a new one. ' +
    'action "survey" lists every engine and every capability any of them can do, so you can see what is missing. ' +
    'action "create" writes an engine, runs its own test, and registers it only if that test passes — ' +
    'a failing engine is left on disk and refused, never registered.',
  /* `engines`, and not `terminal`: this writes source and runs it, so hanging
     it off the shell key would hand the whole agent a shell just to reach it. */
  caps: [TOOL_CAP],
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['survey', 'create'], description: 'survey lists engines and capabilities; create builds one' },
      id: { type: 'string', description: 'create only: the engine id, lowercase letters digits and dashes, e.g. echo-engine' },
      capability: { type: 'string', description: 'create only: the one capability the new engine provides, e.g. echo' },
      name: { type: 'string', description: 'create only: a human name for the engine' },
      body: { type: 'string', description: 'create only: the source of the body of execute(), as JavaScript. "action", "ctx", "driver" and "requireContext" are in scope; return a plain object.' },
      examples: {
        type: 'array',
        description: 'create only: what the engine promises to do. Its test checks execute() against every one of these, so an engine that does not do them is refused.',
        items: {
          type: 'object',
          required: ['action', 'expect'],
          properties: { action: { type: 'string' }, expect: { type: 'object' } },
        },
      },
    },
  },
  label: (a) => (a && a.action === 'survey' ? 'survey engines' : 'build ' + ((a && a.id) || 'engine')),
  run: async (_ctx, a) => {
    const args = a || {};
    if (args.action === 'survey') return survey();
    if (args.action !== 'create') return { ok: false, error: 'action must be "survey" or "create"' };
    /* The router is captured at install time, because there is exactly one and
       a tool has nowhere to look it up. A second install replaces the capture
       rather than adding a second tool. */
    return build(installedRouter, args);
  },
};

/* --------------------------------------------------------- engine_execute -- */

/**
 * Run an action on one named engine from the registry that already exists.
 *
 * Why this is not just a browser tool with a new name: the agent had a way to
 * reach an engine it had built, and no way to *use* one. Asked to "use
 * echo-engine to return some text", the only tools it had said the word
 * browser, so it called browser_navigate — not because it was confused, but
 * because every route from the agent to an engine went through Chrome. This is
 * that missing route, and it is deliberately the shortest one.
 *
 * The four properties that keep it honest:
 *
 *   1. No engine is named in here. Not echo-engine, not any of them. The engine
 *      comes from the argument and is looked up in the router's own registry, so
 *      anything registered is callable and nothing is privileged.
 *
 *   2. The work goes through `ctx.browser.action`, not the router directly.
 *      That is the same door every other agent tool goes through, and it is the
 *      one that runs the profile's URL policy — the guard added in Milestone
 *      2A. Reaching for the router from here would have made this the one tool
 *      that could move the browser without the policy ever seeing it, and the
 *      cheapest-looking implementation is exactly the one that reopens that
 *      hole.
 *
 *   3. The engine comes from the tool's own `engine` argument, never from the
 *      action body. The router reads `action.engine` first and `opts.engine`
 *      second, so an action carrying its own `engine` would quietly win over
 *      the one the caller asked for — the tool would say it ran echo-engine and
 *      run something else. The field is removed before the action is sent.
 *
 *   4. The pre-checks below use the router's own vocabulary rather than a copy
 *      of it: classify() and needed() decide what the action is, and usable()
 *      decides whether this engine can take it. If the router disagrees, the
 *      router wins, because it is the thing that will actually run the call.
 */
const EXECUTE_TOOL = {
  name: 'engine_execute',
  description:
    'Run an action on one specific automation engine, by name. ' +
    'Use this when an engine other than the browser is the right one — for instance an engine ' +
    'an agent built with create_engine. Call create_engine with action "survey" first if you do not ' +
    'know what engines exist. Do not use a browser tool for work that does not need a browser.',
  caps: [TOOL_CAP],
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['engine', 'action'],
    properties: {
      engine: {
        type: 'string',
        description: 'the id of a registered engine, exactly as describe() reports it, e.g. echo-engine or native-cdp',
      },
      action: {
        type: 'object',
        description:
          "the action to run, passed to that engine's execute() unchanged. " +
          "The shape is the engine's own: the router classifies it (navigate, act, precise, read, tabs, " +
          'screenshot, extract, task) and only hands it over if the engine declares what that kind needs.',
        additionalProperties: true,
      },
    },
  },
  label: (a) => (a && a.engine ? String(a.engine) : ''),
  /* The boundary, and it is not decoration.
   *
   * ai/engine.js:405 turns a thrown tool error into a failed tool call — ok:
   * false, the message as the error, and the model told "error: <message>". A
   * tool that *returns* { ok: false } gets the opposite: recorded as a
   * successful call whose payload happens to contain an error, which is the one
   * shape the model cannot act on. So a refusal throws, and a success returns
   * the engine's own value unwrapped, exactly as browser_navigate returns what
   * native-cdp produced. Double-enveloping it here would have made every caller
   * — including the agent — reach through an extra layer to find the answer. */
  run: async (ctx, a) => {
    const r = await runOnEngine(ctx, a, installedRouter);
    if (!r.ok) throw new Error(r.error);
    return r.result;
  },
};

/**
 * Every refusal from engine_execute, in one shape. One helper so the four
 * failure modes are the same object to every caller, and so the extra fields
 * (which engines exist, what the action needed) are attached the same way
 * each time rather than wherever the author remembered.
 */
function engineRefusal(reason, extra) {
  return Object.assign({ ok: false, error: reason }, extra || {});
}

/**
 * The body of engine_execute.
 *
 * Split out so it can be called and tested without a tool wrapper around it,
 * and so `router` is a parameter rather than a module-level guess — the tests
 * need to point it at a router they built, not at whatever was installed last.
 */
async function runOnEngine(ctx, args, router) {
  const a = args || {};

  /* ---- 1. the arguments ---------------------------------------------- */
  const engine = typeof a.engine === 'string' ? a.engine.trim() : '';
  if (!engine) {
    return engineRefusal('engine_execute needs an engine id — call create_engine with action "survey" to see the registered ones');
  }
  if (!isRouter(router)) {
    return engineRefusal('engine_execute is not wired to a router — it should have been installed with the server');
  }

  const body = a.action;
  if (body === undefined || body === null) {
    return engineRefusal('engine_execute needs an action for ' + engine + " — the action is the object that engine's execute() takes");
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    return engineRefusal('the action for ' + engine + ' must be an object, not ' + (Array.isArray(body) ? 'an array' : typeof body) + ' — it is passed to execute() as-is');
  }

  /* ---- 2. is there such an engine? ------------------------------------ */
  if (!router.BY_ID.has(engine)) {
    const known = router.ENGINES.map(e => e && e.id).filter(Boolean).sort();
    return engineRefusal(
      'there is no engine called "' + engine + '" — the registered ones are: ' + (known.length ? known.join(', ') : '(none)'),
      { engines: known }
    );
  }

  /* ---- 3. can it run at all? ----------------------------------------- */
  const h = router.health.get(engine);
  /* Only an explicit `false` counts. Before the router has probed, health says
     null, and null means "not asked yet" — treating that as unavailable would
     refuse every engine on the very first call of a session. */
  if (h && h.available === false) {
    return engineRefusal(engine + ' is not available: ' + (h.reason || 'no reason given'), { engine });
  }

  /* ---- 4. can it do *this kind* of action? ----------------------------- */
  /* The router's own words, not a paraphrase: classify says what the action
     is, needed says what that requires, usable asks the router whether this
     engine has it. A refusal here is the same one the router would have given,
     said before the call so the agent gets the reason instead of a failure. */
  const automation = require('./ai/automation');
  const kind = automation.classify(body);
  const caps = automation.needed(kind);
  if (!router.usable(h, caps)) {
    const have = Array.isArray(h && h.capabilities) ? h.capabilities : [];
    return engineRefusal(
      engine + ' cannot take a "' + kind + '" action — it declares [' + have.join(', ') + '] and this needs [' + caps.join(', ') + ']',
      { engine, kind, needs: caps, declares: have }
    );
  }

  /* ---- 5. the call itself --------------------------------------------- */
  /* The engine is taken from the tool's argument and nowhere else. The router
     prefers action.engine over opts.engine, so a nested one would silently
     redirect the call; it is removed rather than overwritten so the engine
     cannot be smuggled in through the payload. */
  const payload = Object.assign({}, body);
  delete payload.engine;
  payload.engine = engine;

  if (!ctx || !ctx.browser || typeof ctx.browser.action !== 'function') {
    /* Refused rather than falling back to the router. A direct call would work
       — and would skip the profile's URL policy, which is the whole reason
       this goes through ctx.browser.action at all. Failing loudly is the right
       answer to "the safe door is missing", not reaching around it. */
    return engineRefusal('engine_execute cannot reach the browser controller in this run', { engine });
  }

  try {
    const out = await ctx.browser.action(payload);
    return { ok: true, engine, result: out };
  } catch (e) {
    /* The router throws on a refusal and on a failure, and the two are worth
       telling apart: one means "not that engine", the other means "that engine
       tried and could not". The message is the router's own — safeError has
       already stripped CDP endpoints and keys out of it. */
    const msg = String((e && e.message) || e || 'failed');
    return engineRefusal(engine + ' could not run that action: ' + msg, { engine });
  }
}

let installedRouter = null;

/**
 * Make the tool callable, without editing ai/tools.js.
 *
 * @param {object} router  what createRouter() returned
 */
function installTool(router) {
  if (!router) return { ok: false, error: 'install() needs the router — the tool registers into it' };
  installedRouter = router;

  const tools = require('./ai/tools');
  /* Both tools, one permission. create_engine writes an engine and
     engine_execute calls one, and a profile allowed the first without the
     second could build something it had no way to use — so they are not
     separate decisions. */
  for (const tool of [TOOL, EXECUTE_TOOL]) {
    if (!tools.TOOLS.some(t => t && t.name === tool.name)) tools.TOOLS.push(tool);
  }

  /* ai/engine.js looks tools up as a property, so replacing the exported
     function is enough — measured, not assumed. Wrapped rather than replaced so
     the four shipped tools keep resolving exactly as they did. */
  if (!tools.toolByName.__forgeWrapped) {
    const original = tools.toolByName;
    const wrapped = function toolByName(name) {
      return original(name) || tools.TOOLS.find(t => t && t.name === name) || null;
    };
    wrapped.__forgeWrapped = true;
    tools.toolByName = wrapped;
  }

  return { ok: true, tools: [TOOL.name, EXECUTE_TOOL.name], cap: TOOL_CAP };
}

/** what is actually true right now, not what was true when this was written */
function installed() {
  const tools = require('./ai/tools');
  const present = tools.TOOLS.some(t => t && t.name === TOOL.name);
  const resolvable = tools.toolByName(TOOL.name) === TOOL;
  let offered = false;
  try {
    /* offered needs a profile that has the permission key. With every key on,
       a tool the profile cannot use is still not offered — which is the point
       of this line, and the thing that has to change before the agent sees it. */
    const all = {};
    for (const k of require('./ai/rules').CAP_KEYS) all[k] = true;
    all[TOOL_CAP] = true;
    offered = tools.toolsFor({ id: 'forge-probe', skills: [], tools: all }).some(t => t.name === TOOL.name);
  } catch { /* ai/rules not readable — treat as not offered, never as yes */ }
  return { present, resolvable, offered, cap: TOOL_CAP, router: !!installedRouter };
}

/**
 * The one thing standing between this and the agent seeing the tool.
 *
 * Written as a function so the test can assert it stays true, and so the answer
 * is a measurement rather than a note in a comment that goes stale.
 */
function permissionGap() {
  const keys = require('./ai/rules').CAP_KEYS;
  if (keys.includes(TOOL_CAP)) return null;
  return {
    missing: TOOL_CAP,
    where: [
      'ai/store.js:20  TOOL_KEYS — add ' + JSON.stringify(TOOL_CAP),
      'ai/rules.js     CAP_KEYS — add ' + JSON.stringify(TOOL_CAP),
    ],
    why: 'ai/tools.js offers a tool only when one of its caps is a permission key the profile has, ' +
          'and the key list is fixed in those two files. Until ' + TOOL_CAP + ' is one of them, create_engine ' +
          'is installed and callable but never offered to the model — and hanging it off an existing key would ' +
          'be a lie about what it does.',
  };
}

module.exports = {
  ENGINES_DIR, ID_RE, REQUIRED, TEST_TIMEOUT_MS, TOOL, TOOL_CAP,
  survey, list, scaffold, create, runTest, verify, canRegister, register, registerAll,
  unregister, build, engineDir, engineDirectories,
  installTool, installed, permissionGap, EXECUTE_TOOL, runOnEngine,
};
