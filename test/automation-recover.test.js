'use strict';
/* ====================================================================== *
 *  test/automation-recover.test.js — the recovery contract, and the router
 *  honouring it.
 *
 *  Run: node test/automation-recover.test.js
 *
 *  The engines are fakes, because what is under test is the router's behaviour
 *  and not any particular engine. What is pinned down:
 *
 *    1. an engine that recovers and asks for a retry gets the same action again
 *    2. an engine that says it has nothing to recover is not retried
 *    3. a recover() that throws does not fail the action — the fallback stands
 *    4. an engine that recovers and then fails again is not retried twice
 *    5. manual mode gets the same one chance, and never a silent engine swap
 *    6. recovery does not flatter the health record
 *    7. a missing tab is still refused before any engine is asked
 * ====================================================================== */

const assert = require('assert');
const { createRouter, DEFAULT_ENGINES } = require('../ai/automation');
const state = require('../ai/automation/state');
const { createSession } = require('../ai/browser/session');
const fs = require('fs');
const path = require('path');

let passed = 0;
const failures = [];

/**
 * The cases await — the router awaits the engines — so the runner has to await
 * them too. A synchronous wrapper would let every assertion run before the
 * promise it is testing had settled, which reports a passing test as a failure.
 */
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

/* ---------------------------------------------------------------------- *
 *  fixtures
 * ---------------------------------------------------------------------- */

/** a BrowserContext with a tab in it, which is all the router insists on */
function contextWithTab() {
  const s = createSession({});
  s.adopt('target-1', { url: 'https://example.com', title: 'Example' });
  s.setAgentTab(s.list()[0].id, 'test');
  return () => ({
    connected: true,
    tabId: s.agentTabId,
    agentTabId: s.agentTabId,
    focusedTabId: s.focusedTabId,
    hasSession: true,
    generation: 0,
    url: 'https://example.com',
    title: 'Example',
    tabs: s.list(),
    session: s,
  });
}

/** a context with no tab at all, which the router must refuse before engines */
function contextWithNoTab() {
  return () => ({ connected: true, tabId: null, agentTabId: null, hasSession: false, tabs: [] });
}

const driver = { action: async () => ({ ok: true }), tabs: async () => ({}) };

/** the full capability set, which is what the built-in engine declares */
const ALL_CAPS = [
  'navigate', 'click', 'type', 'press', 'select', 'scroll', 'drag',
  'screenshot', 'tabs', 'read', 'evaluate', 'wait', 'history', 'reload',
  'observe', 'extract', 'act',
];

/**
 * An engine whose behaviour is a script, so a test says what happens.
 *
 * The capabilities default to everything, and that matters: classify() reads
 * `{action:'click', selector:'#x'}` as a `precise` action, and needed('precise')
 * is ['click','type','act']. A fake offering only 'act' is not merely
 * unimplemented — it is a capability the router is right to refuse, so the test
 * would be measuring the capability filter instead of the recovery path.
 */
function fakeEngine({ id, name, caps, execute, recover, type = 'sdk', builtIn = false }) {
  const e = {
    id, name, type, builtIn,
    capabilities: caps || ALL_CAPS,
    async available() { return { available: true, reason: 'test' }; },
  };
  if (execute) e.execute = execute;
  if (recover) e.recover = recover;
  return e;
}

/** collect what the router told the UI, so a test can assert on it */
function recorder() {
  const events = [];
  return { events, emit: ev => events.push(ev) };
}

/**
 * Pin an engine by hand for the duration of one test, and put the real
 * preference back afterwards.
 *
 * This has to snapshot the module's own file, not just the in-memory value:
 * state.js caches, and `setEngine` writes straight to data/automation.json. A
 * test that changes the preference and forgets to restore it leaves the real
 * product pinned to whatever the last test chose — which is a confusing failure
 * in the app, not in the test. So the raw bytes are kept and written back, and
 * the cache is dropped on both sides so nothing survives in memory either.
 */
async function withPinnedEngine(id, fn) {
  const FILE = state.FILE;
  let original = null;
  try { original = fs.readFileSync(FILE); } catch { /* there was none */ }
  state.reset();
  const restore = () => {
    if (original === null) { try { fs.rmSync(FILE); } catch { /* gone */ } }
    else fs.writeFileSync(FILE, original);
    state.reset();
  };
  try {
    const r = state.setEngine(id);
    assert.ok(r && r.ok, 'the state module must accept the engine id: ' + JSON.stringify(r));
    return await fn();
  } finally {
    restore();
  }
}

/** run one action through a router made of these engines */
function routeWith(engines, action, contextFn) {
  const r = createRouter({ driver, context: contextFn || contextWithTab(), engines });
  const rec = recorder();
  return r.route(action || { action: 'click', selector: '#x' }, { emit: rec.emit })
    .then(out => ({ out, router: r, events: rec.events }));
}

/* ---------------------------------------------------------------------- *
 *  the cases
 * ---------------------------------------------------------------------- */

async function main() {

  /* ---- 1. recovers and asks for a retry: the same action runs again ---- */
  await test('an engine that recovers gets the same action again, and the retry is the result', async () => {
    let calls = 0;
    const eng = fakeEngine({
      id: 'flaky', name: 'Flaky', 
      // fails the first time, works the second — the stale-state case
      execute: async () => {
        calls += 1;
        if (calls === 1) throw new Error('the client is not running');
        return { via: 'flaky', result: 'worked on attempt ' + calls };
      },
      recover: async () => ({ retried: true, reason: 'restarted' }),
    });
    const { out, events } = await routeWith([eng]);
    assert.strictEqual(calls, 2, 'the action must be handed to the engine twice');
    assert.strictEqual(out.ok, true, 'the recovered attempt must be the result');
    assert.strictEqual(out.recovered, true, 'the result must say it was recovered');
    assert.ok(events.some(e => /trying again/.test(e.label)), 'the UI must be told about the retry');
  });

  /* ---- 2. says it has nothing to recover: not retried, but still asked ---- */
  await test('recover() is asked even when it will refuse, and its refusal is honoured', async () => {
    let calls = 0, recovers = 0;
    const eng = fakeEngine({
      id: 'plain', name: 'Plain', 
      execute: async () => { calls += 1; throw new Error('nope'); },
      recover: async () => { recovers += 1; return { retried: false, reason: 'nothing to recover' }; },
    });
    const { out } = await routeWith([eng]);
    assert.strictEqual(calls, 1, 'retried:false must mean no second attempt');
    assert.strictEqual(recovers, 1, 'recover() must still be asked — that is the contract');
    assert.strictEqual(out.ok, false, 'the action should still fail');
  });

  /* ---- 3. a throwing recover() must not lose the action ---- */
  await test('a recover() that throws does not fail the action — the fallback still runs', async () => {
    let floorCalls = 0;
    const broken = fakeEngine({
      id: 'broken', name: 'Broken', 
      execute: async () => { throw new Error('first failure'); },
      recover: async () => { throw new Error('recover exploded'); },
    });
    const floor = fakeEngine({
      id: 'floor', name: 'Floor', builtIn: true,
      execute: async () => { floorCalls += 1; return { via: 'floor', result: 'the fallback did it' }; },
    });
    const { out } = await routeWith([broken, floor]);
    assert.strictEqual(floorCalls, 1, 'the fallback must still run');
    assert.strictEqual(out.ok, true, 'a throwing recover() must not lose the action');
    assert.strictEqual(out.via, 'floor', 'the floor must be the one that did it');
  });

  /* ---- 4. recovers then fails again: that is the end of it ---- */
  await test('an engine that recovers and then fails again gets no further attempt', async () => {
    let calls = 0;
    const regrow = fakeEngine({
      id: 'regrow', name: 'Regrow', 
      execute: async () => { calls += 1; throw new Error('failed attempt ' + calls); },
      recover: async () => ({ retried: true, reason: 'let me try again' }),
    });
    const floor = fakeEngine({
      id: 'floor', name: 'Floor', builtIn: true,
      execute: async () => ({ via: 'floor', result: 'fallback' }),
    });
    const { out } = await routeWith([regrow, floor]);
    assert.strictEqual(calls, 2, 'exactly one recovery retry, not an unbounded loop');
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.via, 'floor', 'after the retry fails the chain moves on');
  });

  /* ---- 5. manual mode: same one chance, no silent swap ---- */
  await test('a hand-picked engine gets the same one recovery, and is not swapped out', () => withPinnedEngine('stagehand', async () => {
    let calls = 0;
    // the id must be one the real state module accepts: a hand-picked engine is
    // chosen by a name the product knows, not an arbitrary label
    const eng = fakeEngine({
      id: 'stagehand', name: 'Chosen',
      execute: async () => { calls += 1; if (calls === 1) throw new Error('stale'); return { via: 'stagehand', ok: 1 }; },
      recover: async () => ({ retried: true, reason: 'restarted' }),
    });
    const { out } = await routeWith([eng]);
    assert.strictEqual(calls, 2, 'a hand-picked engine gets its one recovery too');
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.via, 'stagehand', 'it must still be the chosen engine');
  }));

  await test('a hand-picked engine that declines recovery fails, with no silent fallback', () => withPinnedEngine('stagehand', async () => {
    let calls = 0;
    const chosen = fakeEngine({
      id: 'stagehand', name: 'Pinned',
      execute: async () => { calls += 1; throw new Error('refused'); },
      recover: async () => ({ retried: false, reason: 'nothing to do' }),
    });
    const other = fakeEngine({
      id: 'native-cdp', name: 'Other', builtIn: true,
      execute: async () => ({ via: 'native-cdp', result: 'should never run' }),
    });
    const { out } = await routeWith([chosen, other]);
    assert.strictEqual(calls, 1, 'no retry when the engine declines');
    assert.strictEqual(out.ok, false, 'a hand-picked engine that fails means failure');
    assert.deepStrictEqual(out.tried, ['stagehand'], 'nothing else may appear in tried');
  }));

  /* ---- 6. health is not flattered by a recovery ---- */
  await test('a recovery does not erase the failure that caused it', async () => {
    // One router, two actions. The health map belongs to the router, so a second
    // routeWith() would have built a second router and the counts would be read
    // off a fresh one that had seen nothing.
    const eng = fakeEngine({
      id: 'flaky', name: 'Flaky',
      execute: async () => { throw new Error('always fails'); },
      recover: async () => ({ retried: true, reason: 'try again' }),
    });
    const router = createRouter({ driver, context: contextWithTab(), engines: [eng] });
    const rec = recorder();
    await router.route({ action: 'click', selector: '#x' }, { emit: rec.emit });
    await router.route({ action: 'click', selector: '#x' }, { emit: rec.emit });

    const view = router.describe().engines.find(e => e.id === 'flaky');
    /* After the first action the engine has failed more often than it has
       succeeded, so it goes into cooldown and the second action never reaches
       it at all — the router steps over it rather than counting a failure it did
       not ask for. So one action means one counted failure, twice over two
       actions, and the recovery retry inside the first action is part of that
       same failure. What must hold is that recovery never *clears* the record:
       successCount stays 0 and the engine is cooling down. */
    assert.strictEqual(view.health.successCount, 0, 'a recovery that fails must not count as a success');
    assert.ok(view.health.failureCount >= 2, 'the failures must still be on the record — got ' + view.health.failureCount);
    assert.ok(view.health.coolingDown, 'a repeatedly failing engine must be stepped over');
    assert.ok(view.health.lastError, 'and the last error must still be there to read');
  });

  /* ---- 7. a missing tab is still refused before any engine is asked ---- */
  await test('the router refuses work with no browser tab, before any engine is asked', async () => {
    let calls = 0;
    const eng = fakeEngine({
      id: 'flaky', name: 'Flaky', 
      execute: async () => { calls += 1; return { via: 'flaky' }; },
      recover: async () => ({ retried: true }),
    });
    const { out, events } = await routeWith([eng], { action: 'click', selector: '#x' }, contextWithNoTab());
    assert.strictEqual(calls, 0, 'no engine may be asked when there is no tab');
    assert.strictEqual(out.ok, false);
    assert.ok(/no browser tab/.test(out.error), 'the refusal must name the real reason: ' + out.error);
    assert.ok(events.some(e => /no browser tab/.test(e.label)), 'and the UI must be told');
  });

  /* ---- 8. no recover() at all must still work ---- */
  await test('an engine with no recover() at all still routes', async () => {
    const eng = {
      id: 'plain', name: 'Plain', type: 'sdk', builtIn: false, capabilities: ALL_CAPS,
      async available() { return { available: true, reason: 'test' }; },
      async execute() { return { via: 'plain' }; },
      // deliberately no recover(): an engine that predates the contract
    };
    const { out } = await routeWith([eng]);
    assert.strictEqual(out.ok, true, 'a missing recover() must not break routing');
    assert.strictEqual(out.via, 'plain', 'and the engine must be named as the one that ran');
    // tried lists the engines that FAILED, so a first-try success leaves it empty
    assert.deepStrictEqual(out.tried, [], 'a clean first-try success has nothing in tried');
  });

  /* ---- 9. the shipped engines answer the contract ---- */
  await test('every shipped engine declares execute() and recover()', () => {
    assert.ok(DEFAULT_ENGINES.length >= 4, 'the four shipped engines are expected');
    for (const e of DEFAULT_ENGINES) {
      assert.strictEqual(typeof e.execute, 'function', e.id + ' must declare execute()');
      assert.strictEqual(typeof e.recover, 'function', e.id + ' must declare recover()');
    }
  });

  await test('the floor engine declines recovery, because it has no state to reset', async () => {
    const native = require('../ai/automation/engines/native');
    const r = await native.recover();
    assert.strictEqual(r.retried, false, 'native-cdp must never claim a retry');
    assert.ok(r.reason, 'and it must say why');
  });

  await test('the three optional engines clear their probe cache when recovering', () => {
    // The whole point of these: a cached probe that still says "available" is
    // what makes a dead engine keep getting chosen. Recovery must invalidate it.
    for (const id of ['playwright-mcp', 'stagehand', 'browser-use']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'ai', 'automation', 'engines', id + '.js'), 'utf8');
      const start = src.indexOf('async recover(');
      assert.ok(start > 0, id + ' must declare recover()');
      const body = src.slice(start, start + 2200);
      assert.ok(/probeCache\s*=\s*\{\s*at:\s*0/.test(body),
        id + '.recover() must drop the probe cache, or a dead engine stays "available"');
    }
  });

  /* ---- report ---- */

  /* A test that leaves the real preference pinned is a bug that shows up later,
   * in the app, as "why is it only using one engine". So the file is checked one
   * last time, after every case has had its chance to leak it. */
  await test('the real engine preference is left exactly as it was found', () => {
    const cfg = state.load();
    assert.strictEqual(cfg.engine, 'auto',
      'these tests must not leave data/automation.json pinned to an engine');
  });

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    for (const f of failures) console.log('  - ' + f.name + ': ' + f.error.message);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
