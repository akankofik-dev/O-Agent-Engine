'use strict';
/* ====================================================================== *
 *  test/runs.test.js — the run lock, and the registry around it.
 *
 *  Run: node test/runs.test.js
 *
 *  No framework, matching the rest of the project: the assertions are in here
 *  and the exit code is the answer. Every case below is a bug this file is
 *  meant to make impossible to reintroduce.
 * ====================================================================== */

const assert = require('assert');
const { createRunRegistry } = require('../ai/runs');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    failures.push({ name, error: e });
    console.log('  FAIL ' + name + '\n         ' + e.message);
  }
}

/* ---------------------------------------------------------------------- *
 *  the lock
 * ---------------------------------------------------------------------- */

test('a first claim succeeds and hands back a run record', () => {
  const r = createRunRegistry();
  const c = r.claim('run_1', 'sess_1');
  assert.strictEqual(c.ok, true);
  assert.strictEqual(c.run.runId, 'run_1');
  assert.strictEqual(c.run.sessionId, 'sess_1');
  assert.strictEqual(c.run.finished, false);
  assert.strictEqual(c.run.stopped, false);
  assert.deepStrictEqual(c.run.events, []);
});

test('a second claim while the first is live is refused, and names the holder', () => {
  const r = createRunRegistry();
  r.claim('run_1', 'sess_1');
  const second = r.claim('run_2', 'sess_2');
  assert.strictEqual(second.ok, false, 'the second claim must not succeed');
  assert.strictEqual(second.live.runId, 'run_1', 'it must name the run holding the lock');
  assert.strictEqual(second.live.sessionId, 'sess_1');
});

test('the lock is not keyed by session — two conversations still collide', () => {
  // This is the bug the lock exists for. Different sessionIds are two
  // different conversations, but they share one browser and one agentTabId.
  const r = createRunRegistry();
  r.claim('run_1', 'sess_A');
  const other = r.claim('run_2', 'sess_B');
  assert.strictEqual(other.ok, false, 'a different session must not get its own browser');
});

test('the same runId cannot be claimed twice', () => {
  const r = createRunRegistry();
  r.claim('run_1', 'sess_1');
  assert.strictEqual(r.claim('run_1', 'sess_1').ok, false);
});

test('finishing releases the lock', () => {
  const r = createRunRegistry();
  const c = r.claim('run_1', 'sess_1');
  r.finish(c.run);
  assert.strictEqual(r.live(), null, 'a finished run must not hold the lock');
  assert.strictEqual(r.claim('run_2', 'sess_1').ok, true, 'the next turn must be allowed');
});

test('a stop request does NOT release the lock — the run is still winding down', () => {
  // Releasing here would hand the tab to the next caller at exactly the moment
  // the current run is still issuing actions against it.
  const r = createRunRegistry();
  const c = r.claim('run_1', 'sess_1');
  r.cancel('run_1');
  assert.strictEqual(c.run.stopped, true, 'stop must be recorded on the record');
  assert.strictEqual(r.live().stopped, true, 'live() must report it as stopping');
  assert.strictEqual(r.claim('run_2', 'sess_1').ok, false, 'a stopping run still holds the browser');
});

test('record() finishing the run releases the lock via the event funnel', () => {
  // This is the path a normal turn takes: the engine emits `final`, and that
  // alone has to free the lock before the finally block runs.
  const r = createRunRegistry();
  const c = r.claim('run_1', 'sess_1');
  r.record(c.run, { type: 'text', text: 'hi' });
  assert.ok(r.live(), 'a text event must not finish the run');
  r.record(c.run, { type: 'final', ok: true, text: 'done' });
  assert.strictEqual(c.run.finished, true);
  assert.strictEqual(r.live(), null);
});

test('an error event also finishes the run', () => {
  const r = createRunRegistry();
  const c = r.claim('run_1', 'sess_1');
  r.record(c.run, { type: 'error', message: 'boom' });
  assert.strictEqual(c.run.finished, true);
  assert.strictEqual(r.live(), null, 'a failed turn must not hold the lock forever');
});

/* ---------------------------------------------------------------------- *
 *  the event buffer
 * ---------------------------------------------------------------------- */

test('events are capped, and the oldest go first', () => {
  const r = createRunRegistry({ eventCap: 3 });
  const c = r.claim('run_1', 'sess_1');
  for (let i = 1; i <= 6; i++) r.record(c.run, { type: 'text', text: 'e' + i });
  assert.strictEqual(c.run.events.length, 3, 'the cap must hold');
  assert.deepStrictEqual(c.run.events.map(e => e.text), ['e4', 'e5', 'e6']);
});

test('view() hands out a copy of the events, not the live array', () => {
  // Otherwise a caller could push into the buffer a replay reads from.
  const r = createRunRegistry();
  const c = r.claim('run_1', 'sess_1');
  r.record(c.run, { type: 'text', text: 'hello' });
  const v = r.view('run_1');
  v.events.push({ type: 'injected' });
  assert.strictEqual(c.run.events.length, 1, 'view() must not leak the live buffer');
});

test('view() is null for a run the registry never had', () => {
  const r = createRunRegistry();
  assert.strictEqual(r.view('nope'), null);
  assert.strictEqual(r.get('nope'), null);
});

test('view() reports running, finished and stopped truthfully', () => {
  const r = createRunRegistry();
  const c = r.claim('run_1', 'sess_1');
  assert.strictEqual(r.view('run_1').running, true);
  r.cancel('run_1');
  assert.strictEqual(r.view('run_1').stopped, true);
  r.finish(c.run);
  const v = r.view('run_1');
  assert.strictEqual(v.running, false);
  assert.strictEqual(v.finished, true);
  assert.ok(v.endedAt > 0, 'ending must be timestamped');
});

/* ---------------------------------------------------------------------- *
 *  pruning
 * ---------------------------------------------------------------------- */

test('prune keeps a live run even when the registry is over its ceiling', () => {
  // Dropping a live run would both lose it and hand the browser to whoever
  // asked next — the two failures this file is about.
  //
  // The finished runs are claimed first and the live one last, because the
  // lock means only one run can be in flight: that is the whole point of it,
  // and a test that quietly assumed otherwise would be testing a world this
  // file exists to rule out.
  const r = createRunRegistry({ maxRecords: 2, keepMs: 0 });
  const a = r.claim('run_a', 'sess_1'); r.finish(a.run);
  const b = r.claim('run_b', 'sess_1'); r.finish(b.run);
  const live = r.claim('run_live', 'sess_1');
  assert.strictEqual(live.ok, true, 'the live run must be claimable once the others finished');
  r.prune();
  assert.ok(r.get('run_live'), 'a live run must survive pruning');
  assert.strictEqual(r.live().runId, 'run_live');
});

test('prune drops finished runs that are past their keep time', () => {
  const r = createRunRegistry({ maxRecords: 1, keepMs: 1000 });
  const first = r.claim('run_old', 'sess_1');
  r.finish(first.run);
  const second = r.claim('run_new', 'sess_2');
  r.finish(second.run);
  // pretend the first run finished long ago
  first.run.startedAt -= 5000;
  r.prune();
  assert.strictEqual(r.get('run_old'), null, 'an aged finished run must go');
  assert.ok(r.get('run_new'), 'a recent run stays');
});

test('prune does nothing below the ceiling', () => {
  const r = createRunRegistry({ maxRecords: 32, keepMs: 0 });
  const c = r.claim('run_1', 'sess_1');
  r.finish(c.run);
  assert.strictEqual(r.prune(), 0, 'must not prune while under the ceiling');
  assert.ok(r.get('run_1'));
});

/* ---------------------------------------------------------------------- *
 *  cancel + forget
 * ---------------------------------------------------------------------- */

test('cancel on an unknown run is null, not a crash', () => {
  const r = createRunRegistry();
  assert.strictEqual(r.cancel('never_existed'), null);
});

test('forgetSession drops a finished run and keeps a running one', () => {
  // Deleting a conversation must not silently kill the work in it. The live
  // run is claimed last so the lock permits it to exist alongside the others.
  const r = createRunRegistry();
  const other = r.claim('run_other', 'sess_2'); r.finish(other.run);
  const done = r.claim('run_done', 'sess_1'); r.finish(done.run);
  r.claim('run_live', 'sess_1');

  const out = r.forgetSession('sess_1');
  assert.strictEqual(out.dropped, 1);
  assert.strictEqual(out.keptRunning, 1);
  assert.strictEqual(r.get('run_done'), null);
  assert.ok(r.get('run_live'), 'a running run must survive a forget');
  assert.ok(r.get('run_other'), 'another session must be untouched');
});

test('forgetSession on a run still holding the lock leaves the lock held', () => {
  const r = createRunRegistry();
  r.claim('run_live', 'sess_1');
  r.forgetSession('sess_1');
  assert.ok(r.live(), 'forgetting must not release the lock');
  assert.strictEqual(r.claim('run_2', 'sess_1').ok, false);
});

/* ---------------------------------------------------------------------- *
 *  the sequence a real turn takes
 * ---------------------------------------------------------------------- */

test('a whole turn: claim, stream events, finish, and the next turn may start', () => {
  const r = createRunRegistry();
  const first = r.claim('run_1', 'sess_1');
  assert.strictEqual(first.ok, true);

  r.record(first.run, { type: 'run', runId: 'run_1' });
  r.record(first.run, { type: 'text', text: 'working' });
  r.record(first.run, { type: 'final', ok: true, text: 'done' });
  r.finish(first.run);

  const second = r.claim('run_2', 'sess_1');
  assert.strictEqual(second.ok, true, 'the next turn must be allowed once the first finished');
  r.finish(second.run);
});

test('two claims in the same tick: only one can win', () => {
  // claim() is the whole lock and it holds no await, so no interleaving is
  // possible between the check and the insert.
  const r = createRunRegistry();
  const a = r.claim('run_a', 'sess_1');
  const b = r.claim('run_b', 'sess_1');
  assert.strictEqual(Number(a.ok) + Number(b.ok), 1, 'exactly one claim may succeed');
});

/* ---------------------------------------------------------------------- */

console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  for (const f of failures) console.log('  - ' + f.name + ': ' + f.error.message);
  process.exit(1);
}
