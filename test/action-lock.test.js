'use strict';
/* ====================================================================== *
 *  test/action-lock.test.js — one browser action at a time.
 *
 *  Run: node test/action-lock.test.js
 *
 *  The helper is a tail of a promise chain, and it is small enough to lift out
 *  of server.js and test directly. That is the only reason it is factored the
 *  way it is: server.js calls main() on load and exports nothing, so the one
 *  piece of real logic in this change would otherwise be untestable.
 *
 *  What is pinned down:
 *    1. actions run one at a time, in the order they arrived
 *    2. a rejected action does not wedge the queue behind it
 *    3. the count is what the status endpoint promises to show
 *    4. the count returns to zero when everything settles
 *    5. a slow action genuinely delays the next one rather than racing it
 * ====================================================================== */

const assert = require('assert');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try { await fn(); passed += 1; console.log('  ok   ' + name); }
  catch (e) { failures.push({ name, error: e }); console.log('  FAIL ' + name + '\n         ' + (e && e.message)); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * The same helper server.js uses, copied rather than imported so a change to
 * the real one that breaks this contract is caught here rather than assumed.
 * If you change one, change both — the duplication is the cost of server.js
 * being a program instead of a module.
 */
function makeLock() {
  let tail = Promise.resolve();
  let queued = 0;
  const state = { acting: 0 };

  function withActionLock(fn) {
    const mine = tail.then(() => fn(), () => fn());
    tail = mine.then(() => undefined, () => undefined);
    queued += 1;
    state.acting = queued;
    return mine.finally(() => {
      queued -= 1;
      state.acting = queued;
    });
  }

  return { withActionLock, state };
}

async function main() {

  /* ---- 1. order and exclusion ---- */
  await test('actions run one at a time, in the order they arrived', async () => {
    const { withActionLock } = makeLock();
    const order = [];
    let concurrent = 0, maxConcurrent = 0;
    const body = (name, ms) => withActionLock(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(ms);
      order.push(name);
      concurrent -= 1;
    });
    await Promise.all([body('a', 30), body('b', 1), body('c', 1)]);
    assert.strictEqual(maxConcurrent, 1, 'never more than one action at a time — saw ' + maxConcurrent);
    assert.deepStrictEqual(order, ['a', 'b', 'c'], 'and in the order they were called');
  });

  /* ---- 2. a rejection must not wedge the queue ---- */
  await test('an action that throws does not stop the ones queued behind it', async () => {
    const { withActionLock } = makeLock();
    const ran = [];
    const first = withActionLock(async () => { ran.push('first'); throw new Error('action failed'); });
    const second = withActionLock(async () => { ran.push('second'); });
    const third = withActionLock(async () => { ran.push('third'); });

    await assert.rejects(() => first, /action failed/, 'the failure must reach its own caller');
    await second;
    await third;
    assert.deepStrictEqual(ran, ['first', 'second', 'third'],
      'every action must still run, and the caller of the failed one must still see the error');
  });

  await test('a chain of failures does not stop later actions', async () => {
    const { withActionLock } = makeLock();
    const ran = [];
    const rejected = [];
    const jobs = [];
    for (let i = 0; i < 5; i++) {
      const j = withActionLock(async () => {
        if (i % 2 === 0) throw new Error('fail ' + i);
        ran.push(i);
      });
      jobs.push(j.catch(e => { rejected.push(e.message); }));
    }
    await Promise.all(jobs);
    // 0,2,4 throw; 1,3 run — all five actions must have been given their turn
    assert.strictEqual(ran.length, 2, 'the two succeeding actions still ran');
    assert.strictEqual(rejected.length, 3, 'and all three failures reached their own callers');
    assert.ok(rejected.every(m => /^fail \d$/.test(m)),
      'a queue must not swallow or rewrite an error — got ' + JSON.stringify(rejected));
  });

  /* ---- 3. and 4. the count ---- */
  await test('the count is what the status endpoint promises to show', async () => {
    const { withActionLock, state } = makeLock();
    assert.strictEqual(state.acting, 0, 'idle is zero');
    const a = withActionLock(() => sleep(20));
    const b = withActionLock(() => sleep(20));
    assert.strictEqual(state.acting, 2, 'two queued, including the one already running — got ' + state.acting);
    await a;
    assert.strictEqual(state.acting, 1, 'one left');
    await b;
    assert.strictEqual(state.acting, 0, 'and back to idle');
  });

  await test('the count returns to zero even when every action fails', async () => {
    const { withActionLock, state } = makeLock();
    await Promise.all([
      withActionLock(async () => { throw new Error('x'); }).catch(() => { }),
      withActionLock(async () => { throw new Error('y'); }).catch(() => { }),
      withActionLock(async () => { throw new Error('z'); }).catch(() => { }),
    ]);
    assert.strictEqual(state.acting, 0,
      'a counter stuck above zero would tell the UI the agent is busy forever — got ' + state.acting);
  });

  /* ---- 5. a slow action really delays the next ---- */
  await test('a slow action delays the next one instead of racing it', async () => {
    const { withActionLock } = makeLock();
    const marks = [];
    const slow = withActionLock(async () => {
      await sleep(80);
      marks.push('slow-done');
    });
    // queued while the slow one is still running, so it must not start early
    const quick = withActionLock(async () => { marks.push('quick-ran'); });
    await Promise.all([slow, quick]);
    assert.deepStrictEqual(marks, ['slow-done', 'quick-ran'],
      'the second action must not begin until the first has finished');
  });

  /* ---- the real helper in server.js agrees ---- */
  await test('the helper in server.js matches the one under test', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const start = src.indexOf('function withActionLock(fn) {');
    assert.ok(start > 0, 'server.js must have withActionLock');
    const body = src.slice(start, start + 700);
    // the three things that make it correct rather than merely present
    assert.ok(/actionTail\.then\(\(\) => fn\(\), \(\) => fn\(\)\)/.test(body),
      'it must run fn whether the previous action settled or threw');
    assert.ok(/actionTail = mine\.then\(\(\) => undefined, \(\) => undefined\)/.test(body),
      'the tail must not carry a rejection into the next action');
    assert.ok(/STATE\.acting = actionQueued/.test(body),
      'it must keep STATE.acting in step with the queue');
  });

  await test('every place that used to bump STATE.acting now goes through the lock', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const bumps = src.match(/STATE\.acting\s*\+=/g) || [];
    assert.strictEqual(bumps.length, 0,
      'STATE.acting must only be written by the lock, not incremented by hand — found: ' + bumps.join(' '));
    const sites = src.match(/withActionLock\(/g) || [];
    // the definition plus three call sites: doAction, doTabs new, doTabs activate
    assert.ok(sites.length >= 4, 'the lock must be used at every action entry point — found ' + sites.length);
  });

  await test('STATE.acting is actually read somewhere, not just written', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(/acting:\s*STATE\.acting/.test(src),
      'the status object must report it, or the field is write-only again');
  });

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    for (const f of failures) console.log('  - ' + f.name + ': ' + f.error.message);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
