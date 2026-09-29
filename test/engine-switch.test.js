'use strict';
/* ====================================================================== *
 *  test/engine-switch.test.js — the switch the dashboard draws must work.
 *
 *  Run: node test/engine-switch.test.js
 *
 *  The dashboard shows an engine, and beside it a switch. Pressing that switch
 *  used to come back `{"ok":false,"error":"unknown engine: echo-engine"}` for
 *  every engine the agent had built, because `ai/automation/state.js` decided
 *  what an engine id may name from a four-entry array at the top of the file.
 *  The panel had already been changed to draw a switch for every engine, so the
 *  control was drawn, was reachable, and refused.
 *
 *  Nothing tested this. Every other suite faked a router or checked a
 *  capability map, and the one thing a person actually presses with a mouse went
 *  unexamined through four milestones.
 *
 *  What is pinned down here:
 *    1. an engine that is not one of the four can be switched off and on
 *    2. that switch survives a reload — a decision is not a cache entry
 *    3. a pin to a generated engine survives a reload too
 *    4. something that could never be an id is refused, not stored
 *    5. a missing or wrongly typed `enabled` is refused, not read as "off"
 *    6. a preference with no engine behind it is reported, not silently kept
 *    7. the server asks the registry, so it cannot drift back to a hardcoded list
 * ====================================================================== */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const state = require('../ai/automation/state');
const { createRouter } = require('../ai/automation');

const ROOT = path.join(__dirname, '..');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    failures.push({ name, error: e });
    console.log('  FAIL ' + name + '\n         ' + (e && e.message));
  }
}

/* ------------------------------------------------------------------------ *
 *  The real preference file is snapshot and restored, byte for byte.
 *
 *  These tests write data/automation.json because that is the only way to prove
 *  a switch is real. A test that leaves the product pinned to a throwaway engine
 *  fails later in the app, not here, so the raw bytes go back at the end no
 *  matter what — and the module cache is dropped on both sides, because
 *  state.js caches and a restored file plus a warm cache disagree.
 * ------------------------------------------------------------------------ */
const FILE = state.FILE;
const PRISTINE = (() => { try { return fs.readFileSync(FILE); } catch { return null; } })();

function restore() {
  try {
    if (PRISTINE === null) fs.rmSync(FILE, { force: true });
    else fs.writeFileSync(FILE, PRISTINE);
  } catch (e) {
    console.log('  ! could not restore ' + FILE + ': ' + e.message);
  }
  state.reset();
}

/** start every case from a known file, not from whatever the last one left */
function seed(obj) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(obj, null, 2));
  state.reset();
}

/** an engine shaped like a generated one, so the router has something to hold */
function fakeEngine(id, up) {
  const available = up !== false;
  return {
    id,
    name: 'Fake ' + id,
    type: 'generated',
    capabilities: ['act', 'observe', 'navigate'],
    available: async () => (available
      ? { available: true, reason: 'fake', capabilities: ['act', 'observe', 'navigate'] }
      : { available: false, reason: 'not installed' }),
    execute: async () => ({ ok: true }),
    recover: async () => ({ retried: false }),
    shutdown: async () => {},
  };
}

/**
 * Build a router over fake engines.
 *
 * Two shapes are accepted, and the difference matters: `['a', 'b']` for engines
 * that are all present, and `[['a', true], ['b', false]]` when availability has
 * to be arranged — which is the only way to reach the case where the working
 * engine is the one that was switched off.
 */
function routerWith(ids) {
  const list = Array.isArray(ids[0]) ? ids : ids.map(id => [id, true]);
  return createRouter({
    driver: { action: async () => ({}), tabs: async () => [] },
    context: () => ({}),
    engines: list.map(([id, up]) => fakeEngine(id, up)),
  });
}

/* ------------------------------------------------------------------------ *
 *  Reading source, without reading the prose about the source.
 *
 *  The first version of the guard below searched the whole handler for
 *  `body.enabled === true` and failed on a clean server.js — because the fix's
 *  own comment explains that this used to be the bug, and quotes the expression
 *  while doing it. A guard that cannot tell code from the sentence describing it
 *  will fail the day someone documents the bug, which is the day it is least
 *  wanted. So the comments come out first.
 *
 *  Only whole-line comments are removed. A trailing `//` after real code is left
 *  in place, because guessing where a line comment ends means guessing about
 *  `//` inside a string or a regex, and a stripper that guesses is a stripper
 *  that will occasionally delete the check.
 * ------------------------------------------------------------------------ */
function code(src) {
  return src.split(/\r?\n/).filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
}

const CODE_ONLY = { server: null, state: null };

/** the POST /api/automation/engine handler, comments gone */
function engineHandler() {
  if (CODE_ONLY.server === null) {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const at = src.indexOf("pathname === '/api/automation/engine' && req.method === 'POST'");
    if (at < 0) throw new Error('the engine toggle route is not in server.js any more');
    const end = src.indexOf("pathname === '/api/automation/engine/install'", at);
    const chunk = end > 0 ? src.slice(at, end) : src.slice(at, at + 6000);
    CODE_ONLY.server = code(chunk);
  }
  return CODE_ONLY.server;
}

async function main() {

  /* ---- 1. the switch the panel draws ---- */
  await test('an engine the agent built can be switched off, and describe() says so', async () => {
    seed({ version: 1, engine: 'auto', engines: {} });
    const router = routerWith(['echo-engine']);

    const r = state.setEnabled('echo-engine', false);
    assert.ok(r && r.ok, 'the switch was refused: ' + JSON.stringify(r));
    assert.strictEqual(r.id, 'echo-engine', 'and it did not name what it changed');

    const row = router.describe().engines.find(e => e.id === 'echo-engine');
    assert.ok(row, 'the engine vanished from describe()');
    assert.strictEqual(row.enabled, false, 'describe() still shows it enabled — the panel would lie');
    assert.strictEqual(row.status, 'disabled', 'and it does not say why: ' + row.status);
  });

  await test('and switched back on again', async () => {
    seed({ version: 1, engine: 'auto', engines: {} });
    const router = routerWith(['echo-engine']);

    state.setEnabled('echo-engine', false);
    const back = state.setEnabled('echo-engine', true);
    assert.ok(back.ok, 'switching back on was refused: ' + JSON.stringify(back));
    assert.strictEqual(router.describe().engines.find(e => e.id === 'echo-engine').enabled, true,
      'it stayed off after being switched on');
  });

  await test('a switched-off engine is not offered for the work it could do', async () => {
    seed({ version: 1, engine: 'auto', engines: {} });
    const router = routerWith(['echo-engine']);
    await router.probeAll({});

    state.setEnabled('echo-engine', false);
    router.invalidate();
    await router.probeAll({});

    assert.ok(!router.usable(router.health.get('echo-engine'), ['act']),
      'a disabled engine was still judged usable');
  });

  /* ---- 2. and 3. a decision outlives the process ---- */
  await test('the switch is still there after the file is read afresh', async () => {
    seed({ version: 1, engine: 'auto', engines: {} });
    state.setEnabled('echo-engine', false);
    state.reset();
    const cfg = state.load();
    assert.ok(cfg.engines['echo-engine'], 'the entry was dropped on the way back in');
    assert.strictEqual(cfg.engines['echo-engine'].enabled, false,
      'normalise() discarded a decision because the id was not one of the four');
  });

  await test('a pin to a generated engine is not reset to auto on the next load', async () => {
    seed({ version: 1, engine: 'auto', engines: {} });
    const r = state.setEngine('echo-engine');
    assert.ok(r.ok, 'pinning a generated engine was refused: ' + JSON.stringify(r));
    state.reset();
    assert.strictEqual(state.load().engine, 'echo-engine',
      'the pin was thrown away on reload, so the product quietly went back to auto');
  });

  await test('an engine with no preference is on, because a missing choice is not a choice', async () => {
    seed({ version: 1, engine: 'auto', engines: {} });
    const router = routerWith(['never-mentioned']);
    assert.strictEqual(router.describe().engines.find(e => e.id === 'never-mentioned').enabled, true,
      'an engine nobody configured came up disabled');
  });

  /* ---- 4. what could never be an id ---- */
  await test('a key that could never be an engine id is refused, not stored', async () => {
    seed({ version: 1, engine: 'auto', engines: {} });
    for (const bad of ['', '..', 'a/b', 'Echo-Engine', '1leading-digit', 'x', 'has space', null, undefined, { a: 1 }]) {
      const r = state.setEnabled(bad, false);
      assert.ok(!r.ok, JSON.stringify(bad) + ' was accepted as an engine id');
    }
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    assert.deepStrictEqual(Object.keys(raw.engines), [],
      'a refused id still reached the file: ' + JSON.stringify(raw.engines));
  });

  await test('a file edited by hand keeps its good entries and loses the impossible ones', async () => {
    seed({
      version: 1,
      engine: 'auto',
      engines: {
        'echo-engine': { enabled: false },
        'ok-two': { enabled: true },
        'Not An Id': { enabled: false },
        '../escape': { enabled: false },
        'no-flag': {},
        'wrong-type': { enabled: 'yes' },
      },
    });
    const cfg = state.load();
    assert.strictEqual(cfg.engines['echo-engine'].enabled, false, 'a real decision was lost');
    assert.strictEqual(cfg.engines['ok-two'].enabled, true, 'a real decision was lost');
    for (const k of Object.keys(cfg.engines)) {
      assert.ok(state.ID_RE.test(k), 'an impossible id survived: ' + k);
    }
    assert.ok(!('no-flag' in cfg.engines), 'an entry with no decision was kept');
    assert.ok(!('wrong-type' in cfg.engines), '"yes" was accepted as a boolean');
  });

  await test('all four shipped engines still come back on when their entry is deleted', async () => {
    seed({ version: 1, engine: 'auto', engines: { 'native-cdp': { enabled: false } } });
    const cfg = state.load();
    for (const id of state.KNOWN) {
      assert.ok(cfg.engines[id], id + ' came back as a hole rather than as the default');
      assert.strictEqual(typeof cfg.engines[id].enabled, 'boolean', id + ' has no decision');
    }
    assert.strictEqual(cfg.engines['native-cdp'].enabled, false, 'the one entry that existed was not honoured');
  });

  /* ---- 5. a malformed toggle is a mistake, not a decision ---- */
  await test('enabled that is not a boolean is refused rather than read as off', async () => {
    seed({ version: 1, engine: 'auto', engines: { 'echo-engine': { enabled: true } } });
    for (const bad of [undefined, null, 'true', 1, 0, {}]) {
      const r = state.setEnabled('echo-engine', bad);
      assert.ok(!r.ok, JSON.stringify(bad) + ' was taken as a decision');
    }
    state.reset();
    assert.strictEqual(state.load().engines['echo-engine'].enabled, true,
      'the engine was switched off by a payload that never said false');
  });

  /* ---- 6. nothing quietly kept ---- */
  await test('a switch with no engine behind it is reported as an orphan', async () => {
    seed({ version: 1, engine: 'auto', engines: { 'built-then-deleted': { enabled: false } } });
    const view = routerWith(['echo-engine']).describe();
    assert.ok(Array.isArray(view.orphans), 'describe() does not report orphans at all');
    assert.ok(view.orphans.includes('built-then-deleted'),
      'a preference for an engine that is gone is kept and never mentioned: ' + JSON.stringify(view.orphans));
    assert.ok(!view.orphans.includes('echo-engine'), 'a real engine was called an orphan');
    /* and it is still off if the engine comes back — that was the point of keeping it */
    state.setEnabled('echo-engine', true);
    assert.ok(!routerWith(['echo-engine']).describe().orphans.includes('echo-engine'),
      'an engine that is present is still reported as an orphan');
  });

  /* ---- 7. the server cannot drift back ---- */
  /* First: the guard has to be able to fail. A check never seen catching
     anything cannot be told apart from one that cannot catch anything, and the
     first version of this spent a whole run matching a comment. */
  await test('the source guard catches the bug it is looking for', () => {
    const planted = code([
      "if (pathname === '/api/automation/engine' && req.method === 'POST') {",
      '  if (body.id) { const r = state.setEnabled(String(body.id), body.enabled === true); }',
      '}',
    ].join('\n'));
    assert.ok(/body\.enabled\s*===\s*true/.test(planted),
      'the guard cannot see the expression it exists to catch');

    const noRegistry = code([
      "if (pathname === '/api/automation/engine' && req.method === 'POST') {",
      '  const r = state.setEnabled(String(body.id), body.enabled);',
      '}',
    ].join('\n'));
    assert.ok(!/BY_ID\.has\(/.test(noRegistry), 'the registry probe matches on nothing at all');

    /* and it has to stay quiet about prose, which is how the first one failed */
    const explained = code([
      "if (pathname === '/api/automation/engine' && req.method === 'POST') {",
      '  /* `body.enabled === true` was the previous reading, and it is a boolean',
      '     whatever arrived, so a bad payload switched an engine off. */',
      '  const r = state.setEnabled(String(body.id), body.enabled);',
      '}',
    ].join('\n'));
    assert.ok(!/body\.enabled\s*===\s*true/.test(explained),
      'the guard reads the comment explaining the bug as the bug being back');
  });

  await test('the server checks the engine against the registry, not against a list in a file', () => {
    const chunk = engineHandler();
    assert.ok(/automation\.BY_ID\.has\(/.test(chunk),
      'the toggle no longer asks the registry which engines exist — a hardcoded list has crept back in');
    assert.ok(!/state\.KNOWN\b/.test(chunk),
      'the toggle is deciding from state.KNOWN again, which is the four-entry list that caused this');
    assert.ok(!/body\.enabled\s*===\s*true/.test(chunk),
      '`body.enabled === true` is back: it is a boolean whatever arrived, so a bad payload switches an engine off');
    assert.ok(/typeof body\.enabled\s*!==\s*'boolean'/.test(chunk),
      'a payload that says nothing about enabled is no longer reported as a mistake');
  });

  await test('state.js no longer gates engine ids on its own list of four', () => {
    const src = code(fs.readFileSync(path.join(ROOT, 'ai/automation/state.js'), 'utf8'));
    /* KNOWN may still be exported and still seeds the four shipped defaults —
       that is legitimate. What must be gone is membership in it being the test
       for whether an id may be named. */
    assert.ok(!/KNOWN\.includes\(\s*(id|key|want)\s*\)/.test(src),
      'a decision is still being gated on membership in KNOWN');
    assert.ok(/ID_RE/.test(src), 'there is no id shape check left to replace it');
  });

  /* ---- 8. the refusal names the switch, not the machine ---- */
  await test('a switched-off engine is reported as switched off, not as unavailable', async () => {
    seed({ version: 1, engine: 'auto', engines: {} });
    /* the one that works is off, the one that is on was never installed — the
       arrangement that used to produce "unavailable" and send the person to
       install something they had already chosen not to run */
    const router = routerWith([['echo-engine', true], ['never-installed', false]]);
    await router.probeAll({});
    state.setEnabled('echo-engine', false);

    const why = router.explain(['act']);
    assert.ok(/turned off/i.test(why), 'the refusal never mentions the switch: ' + why);
    assert.ok(/Fake echo-engine/.test(why), 'and it does not name the engine: ' + why);
  });

  await test('an engine that is on but not installed still reads as unavailable', async () => {
    seed({ version: 1, engine: 'auto', engines: {} });
    const router = routerWith([['never-installed', false]]);
    await router.probeAll({});
    const why = router.explain(['act']);
    assert.ok(/can run here/.test(why) && /not installed/.test(why),
      'a genuine installation problem is no longer reported as one: ' + why);
    assert.ok(!/turned off/.test(why),
      'an engine that was never switched off is being blamed on the switch: ' + why);
  });

  await test('with every engine off, the refusal says exactly that', async () => {
    seed({ version: 1, engine: 'auto', engines: {} });
    const router = routerWith(['a-one', 'b-two']);
    await router.probeAll({});
    state.setEnabled('a-one', false);
    state.setEnabled('b-two', false);
    const why = router.explain(['act']);
    assert.ok(/every automation engine is turned off/i.test(why),
      'the all-off case is not reported plainly: ' + why);
  });

  /* ---- 9. the file is the user's, and it goes back ----
   *
   * The first version of this suite called process.exit() from inside main() when
   * a case failed, which meant the restore below never ran on exactly the run
   * where it mattered. data/automation.json was left holding two engines called
   * a-one and b-two. The next run then snapshotted *that* as the pristine state,
   * so the damage became the baseline and the file has been wrong ever since.
   *
   * The lesson is the same one forge.test.js learned about rm(): a cleanup that
   * cannot fail is a cleanup that gets skipped, and the failure shows up in the
   * product rather than in the test. So the exit happens after the restore, the
   * restore is in a finally, and one case checks that the file really is back.
   */
  try {
    /* ---- 9. the panel has to show it, or describe() is talking to nobody ---- */
  await test('the settings panel says a switch is being held for a missing engine', () => {
    const html = code(fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8'));
    assert.ok(/v\.orphans/.test(html),
      'describe() reports orphans and the panel never reads the field — state nobody can see');
    assert.ok(/orphans\.length\s*\?\s*orphans\.length\s*\+/.test(html) || /orphanLine/.test(html),
      'the panel has the field but no line for it');
  });

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
    if (failures.length) {
      for (const f of failures) console.log('  - ' + f.name + ': ' + f.error.message);
    }
  } finally {
    restore();
  }

  const after = (() => { try { return fs.readFileSync(FILE); } catch { return null; } })();
  const same = PRISTINE === null ? after === null : after !== null && after.equals(PRISTINE);
  if (!same) {
    console.log('  FAIL data/automation.json was not put back');
    console.log('         it now reads: ' + (after ? after.toString().replace(/\s+/g, ' ').slice(0, 160) : '(no file)'));
    failures.push({ name: 'the preference file is restored', error: new Error('it was left changed') });
  } else {
    passed += 1;
    console.log('  ok   the preference file is back exactly as it was found');
  }

  process.exit(failures.length ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  restore();
  process.exit(1);
});
