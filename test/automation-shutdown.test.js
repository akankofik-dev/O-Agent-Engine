'use strict';
/* ====================================================================== *
 *  test/automation-shutdown.test.js — letting go of what an engine holds.
 *
 *  Run: node test/automation-shutdown.test.js
 *
 *  Three of the four engines own something outside this process: a child `npx`
 *  for Playwright MCP, a browser connection for Stagehand, a session for
 *  browser-use. Every one of them has had a shutdown() written, and none of
 *  them was ever called — so stopping the server left all of it running.
 *
 *  What is pinned down:
 *    1. an engine with shutdown() is called
 *    2. an engine without one is skipped, not an error
 *    3. one engine throwing does not stop the others
 *    4. one engine hanging does not stop the others, or the caller
 *    5. the report says what was stopped and what was left
 * ====================================================================== */

const assert = require('assert');
const { createRouter } = require('../ai/automation');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try { await fn(); passed += 1; console.log('  ok   ' + name); }
  catch (e) { failures.push({ name, error: e }); console.log('  FAIL ' + name + '\n         ' + (e && e.message)); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const ALL_CAPS = ['navigate', 'click', 'type', 'act', 'observe', 'read'];

function engineWith(id, shutdown) {
  return {
    id, name: id, type: 'sdk', builtIn: false, capabilities: ALL_CAPS,
    async available() { return { available: true, reason: 'test' }; },
    async execute() { return { via: id }; },
    shutdown,
  };
}

function routerOf(engines) {
  return createRouter({
    driver: { action: async () => ({}), tabs: async () => ({}) },
    context: () => ({ connected: true, tabId: 't', agentTabId: 't', hasSession: true, tabs: [] }),
    engines,
  });
}

async function main() {

  await test('every engine that declares shutdown() is called', async () => {
    const called = [];
    const engines = [
      engineWith('a', async () => { called.push('a'); }),
      engineWith('b', async () => { called.push('b'); }),
      engineWith('c', async () => { called.push('c'); }),
    ];
    const out = await routerOf(engines).shutdownAll();
    assert.deepStrictEqual(called, ['a', 'b', 'c'], 'all three must be stopped');
    assert.deepStrictEqual(out.stopped, ['a', 'b', 'c']);
    assert.strictEqual(out.failed.length, 0);
  });

  await test('an engine with no shutdown() is skipped, not an error', async () => {
    // native-cdp is this one: it owns no process, only the CDP connection the
    // host closes itself
    const n = {
      id: 'plain', name: 'Plain', type: 'cdp', builtIn: true, capabilities: ALL_CAPS,
      async available() { return { available: true, reason: 'built in' }; },
      async execute() { return { via: 'plain' }; },
    };
    const other = engineWith('b', async () => { });
    const out = await routerOf([n, other]).shutdownAll();
    assert.deepStrictEqual(out.stopped, ['b'], 'only the engine that asked to be stopped');
    assert.strictEqual(out.failed.length, 0, 'a missing shutdown() is not a failure');
  });

  await test('one engine throwing does not stop the others', async () => {
    const called = [];
    const engines = [
      engineWith('boom', async () => { throw new Error('could not close'); }),
      engineWith('after', async () => { called.push('after'); }),
    ];
    const out = await routerOf(engines).shutdownAll();
    assert.deepStrictEqual(called, ['after'], 'the engine after the failure must still be stopped');
    assert.deepStrictEqual(out.stopped, ['after']);
    assert.strictEqual(out.failed.length, 1, 'and the failure must be reported');
    assert.strictEqual(out.failed[0].id, 'boom');
    assert.ok(/could not close/.test(out.failed[0].error), 'with the reason intact: ' + out.failed[0].error);
  });

  await test('one engine hanging does not stop the others, or the caller', async () => {
    const called = [];
    const engines = [
      // never settles: a child that will not die is the real version of this
      engineWith('hangs', () => new Promise(() => { })),
      engineWith('after', async () => { called.push('after'); }),
    ];
    const t0 = Date.now();
    const out = await routerOf(engines).shutdownAll({ graceMs: 150 });
    const took = Date.now() - t0;

    assert.deepStrictEqual(called, ['after'], 'the engine after the hang must still be stopped');
    assert.deepStrictEqual(out.stopped, ['after']);
    assert.strictEqual(out.failed.length, 1);
    assert.strictEqual(out.failed[0].id, 'hangs');
    assert.ok(/did not finish/.test(out.failed[0].error),
      'a hang must be named as one, not as a thrown error — ' + out.failed[0].error);
    assert.ok(took < 1500, 'and it must not have waited forever — took ' + took + 'ms');
  });

  await test('the report survives a mix of every outcome', async () => {
    const engines = [
      engineWith('ok1', async () => { }),
      engineWith('throws', async () => { throw new Error('nope'); }),
      engineWith('hangs', () => new Promise(() => { })),
      { id: 'nostop', name: 'NoStop', type: 'cdp', builtIn: true, capabilities: ALL_CAPS,
        async available() { return { available: true, reason: 'x' }; }, async execute() { return {}; } },
      engineWith('ok2', async () => { }),
    ];
    const out = await routerOf(engines).shutdownAll({ graceMs: 120 });
    assert.deepStrictEqual(out.stopped, ['ok1', 'ok2'], 'the healthy ones, in order');
    assert.deepStrictEqual(out.failed.map(f => f.id), ['throws', 'hangs'],
      'and the two that could not, each for its own reason');
  });

  await test('a secret in a shutdown error is scrubbed before it is reported', async () => {
    // the report is logged, and safeError is what makes a log line safe to keep
    const engines = [engineWith('leaky', async () => { throw new Error('failed for ws://127.0.0.1:9222/devtools with sk-abcdef123456'); })];
    const out = await routerOf(engines).shutdownAll();
    assert.ok(!/ws:\/\//.test(out.failed[0].error), 'the endpoint must be masked: ' + out.failed[0].error);
    assert.ok(!/sk-abcdef/.test(out.failed[0].error), 'the key must be masked: ' + out.failed[0].error);
  });

  /* ---- the shipped engines answer it ---- */
  await test('the three engines that own something all declare shutdown()', () => {
    const { DEFAULT_ENGINES } = require('../ai/automation');
    const owning = DEFAULT_ENGINES.filter(e => e.id !== 'native-cdp');
    assert.strictEqual(owning.length, 3, 'three engines own something outside the process');
    for (const e of owning) {
      assert.strictEqual(typeof e.shutdown, 'function',
        e.id + ' owns a process or a connection and must be able to let go of it');
    }
  });

  await test('each owning engine actually releases its singleton', () => {
    const fs = require('fs');
    const path = require('path');
    for (const id of ['playwright-mcp', 'stagehand', 'browser-use']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'ai', 'automation', 'engines', id + '.js'), 'utf8');
      const start = src.indexOf('async shutdown(');
      assert.ok(start > 0, id + ' must declare shutdown()');
      const body = src.slice(start, start + 700);
      // the singleton has to be nulled, not merely closed, or the next start
      // would find it already set and reuse a dead one
      const name = id === 'playwright-mcp' ? 'client' : id === 'stagehand' ? 'stage' : 'session';
      assert.ok(new RegExp(name + '\\s*=\\s*null').test(body),
        id + '.shutdown() must set ' + name + ' to null, or a later start reuses a dead one');
    }
  });

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    for (const f of failures) console.log('  - ' + f.name + ': ' + f.error.message);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
