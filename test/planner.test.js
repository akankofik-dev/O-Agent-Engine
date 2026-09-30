// ai/planner.js — the planning phase in front of the tool loop.
//
// The planner decides whether an instruction is chat (kind "answer") or work
// (kind "plan"), and a plan is only trusted after validate() has checked it
// against the tool catalog. These tests pin both sides: the extraction of a
// plan out of whatever the model actually answered, and the refusal of plans
// that name tools nobody gave out.
'use strict';
const assert = require('assert');
const planner = require('../ai/planner');

let pass = 0; const fails = [];
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

const CATALOG = [
  { name: 'shell_exec', description: 'Run one shell command' },
  { name: 'browser_navigate', description: 'Open a URL' },
];

/* ------------------------------------------------------------- validate -- */

check('validate accepts a well-formed plan', () => {
  const v = planner.validate({
    kind: 'plan',
    summary: 'Do the thing',
    steps: [
      { id: 'one', title: 'Run the command', tool: 'shell_exec', args: { command: 'ls' } },
      { id: 'two', title: 'Open the page' },
    ],
  }, CATALOG.map(t => t.name));
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.plan.steps.length, 2);
  assert.strictEqual(v.plan.steps[1].tool, undefined);
});

check('validate normalises a missing summary to empty, not garbage', () => {
  const v = planner.validate({ kind: 'plan', steps: [{ id: 'a', title: 'x' }] }, []);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.plan.summary, '');
});

check('validate accepts kind "answer" with text', () => {
  const v = planner.validate({ kind: 'answer', answer: 'halo' }, []);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.plan.kind, 'answer');
});

check('validate refuses an answer with no text', () => {
  const v = planner.validate({ kind: 'answer' }, []);
  assert.strictEqual(v.ok, false);
});

check('validate refuses a missing or unknown kind', () => {
  assert.strictEqual(planner.validate({}, []).ok, false);
  assert.strictEqual(planner.validate({ kind: 'do-it' }, []).ok, false);
});

check('validate refuses a non-object plan', () => {
  assert.strictEqual(planner.validate(null, []).ok, false);
  assert.strictEqual(planner.validate([1, 2], []).ok, false);
});

check('validate refuses more than ' + planner.MAX_STEPS + ' steps, whatever was asked', () => {
  const steps = Array.from({ length: planner.MAX_STEPS + 1 }, (_, i) => ({ id: 's' + i, title: 'step ' + i }));
  const v = planner.validate({ kind: 'plan', steps }, []);
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /limit is/);
});

check('validate refuses duplicate step ids', () => {
  const v = planner.validate({ kind: 'plan', steps: [{ id: 'a', title: 'x' }, { id: 'a', title: 'y' }] }, []);
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /two steps/);
});

check('validate refuses ids that are not slugs', () => {
  const v = planner.validate({ kind: 'plan', steps: [{ id: 'Not A Slug!', title: 'x' }] }, []);
  assert.strictEqual(v.ok, false);
});

check('validate refuses a step naming a tool that is not in the catalog', () => {
  const v = planner.validate({ kind: 'plan', steps: [{ id: 'a', title: 'x', tool: 'rm_rf_everything' }] }, CATALOG.map(t => t.name));
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /not in the catalog/);
});

check('validate refuses args that are not an object', () => {
  const v = planner.validate({ kind: 'plan', steps: [{ id: 'a', title: 'x', tool: 'shell_exec', args: 'ls' }] }, CATALOG.map(t => t.name));
  assert.strictEqual(v.ok, false);
});

check('validate refuses a step with no title', () => {
  const v = planner.validate({ kind: 'plan', steps: [{ id: 'a' }] }, []);
  assert.strictEqual(v.ok, false);
});

check('validate refuses an empty step list', () => {
  assert.strictEqual(planner.validate({ kind: 'plan', steps: [] }, []).ok, false);
  assert.strictEqual(planner.validate({ kind: 'plan' }, []).ok, false);
});

/* ---------------------------------------------------------------- extract -- */

check('extract takes the submit_plan tool call first', () => {
  const out = {
    text: 'garbage prose that is not a plan',
    toolCalls: [{ id: 'c1', name: 'submit_plan', args: { kind: 'answer', answer: 'hi' } }],
  };
  assert.deepStrictEqual(planner.extract(out), { kind: 'answer', answer: 'hi' });
});

check('extract falls back to bare JSON text', () => {
  const raw = { kind: 'plan', summary: 's', steps: [{ id: 'a', title: 't' }] };
  assert.deepStrictEqual(planner.extract({ text: JSON.stringify(raw), toolCalls: [] }), raw);
});

check('extract finds JSON inside prose', () => {
  const raw = { kind: 'answer', answer: 'sure' };
  const out = planner.extract({ text: 'Here you go:\n```json\n' + JSON.stringify(raw) + '\n```\nDone.', toolCalls: [] });
  assert.deepStrictEqual(out, raw);
});

check('extract returns null when there is nothing usable', () => {
  assert.strictEqual(planner.extract({ text: 'no plan here', toolCalls: [] }), null);
  assert.strictEqual(planner.extract({ text: '{broken json', toolCalls: [] }), null);
  assert.strictEqual(planner.extract({ text: '', toolCalls: [] }), null);
});

/* ------------------------------------------------------------------- plan -- */

const providerFrom = chat => ({ model: 'fake', protocol: 'openai-compatible', chat });

check('plan returns a validated plan from a submit_plan call', async () => {
  const p = await planner.plan({
    provider: providerFrom(async () => ({
      text: '',
      toolCalls: [{ id: 'c1', name: 'submit_plan', args: { kind: 'plan', summary: 'List files', steps: [{ id: 'ls', title: 'List the files', tool: 'shell_exec', args: { command: 'ls' } }] } }],
    })),
    text: 'lihat isi folder ini',
    toolSchemas: CATALOG,
  });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.plan.kind, 'plan');
  assert.strictEqual(p.plan.steps[0].tool, 'shell_exec');
});

check('plan answers chat instructions without demanding approval', async () => {
  const p = await planner.plan({
    provider: providerFrom(async () => ({ text: '', toolCalls: [{ id: 'c1', name: 'submit_plan', args: { kind: 'answer', answer: 'just chatting' } }] })),
    text: 'halo',
    toolSchemas: CATALOG,
  });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.plan.kind, 'answer');
});

check('plan refuses a plan that names a tool outside the catalog', async () => {
  const p = await planner.plan({
    provider: providerFrom(async () => ({ text: '', toolCalls: [{ id: 'c1', name: 'submit_plan', args: { kind: 'plan', steps: [{ id: 'a', title: 'x', tool: 'unknown_thing' }] } }] })),
    text: 'do something',
    toolSchemas: CATALOG,
  });
  assert.strictEqual(p.ok, false);
  assert.match(p.reason, /not in the catalog/);
});

check('plan fails honestly when the model answers neither with the tool nor JSON', async () => {
  const p = await planner.plan({
    provider: providerFrom(async () => ({ text: 'I will not obey', toolCalls: [] })),
    text: 'do something',
    toolSchemas: CATALOG,
  });
  assert.strictEqual(p.ok, false);
  assert.match(p.reason, /no usable plan/);
});

check('plan tells the model why a previous plan was rejected', async () => {
  let seen = null;
  await planner.plan({
    provider: providerFrom(async ({ messages }) => { seen = messages; return { text: '', toolCalls: [{ id: 'c1', name: 'submit_plan', args: { kind: 'answer', answer: 'ok' } }] }; }),
    text: 'do it',
    toolSchemas: CATALOG,
    note: 'too many steps, keep it to two',
  });
  const user = seen.find(m => m.role === 'user');
  assert.match(user.content, /REJECTED/);
  assert.match(user.content, /too many steps, keep it to two/);
});

check('plan system prompt lists the tool catalog', async () => {
  let seen = null;
  await planner.plan({
    provider: providerFrom(async ({ messages }) => { seen = messages; return { text: '', toolCalls: [{ id: 'c1', name: 'submit_plan', args: { kind: 'answer', answer: 'ok' } }] }; }),
    text: 'hi',
    toolSchemas: CATALOG,
  });
  const sys = seen.find(m => m.role === 'system');
  assert.match(sys.content, /`shell_exec`/);
  assert.match(sys.content, /`browser_navigate`/);
});

/* ------------------------------------------------------------ renderPlanText -- */

check('renderPlanText shows the summary and every step title', () => {
  const text = planner.renderPlanText({
    kind: 'plan', summary: 'Back up the folder',
    steps: [{ id: 'a', title: 'Copy files' }, { id: 'b', title: 'Verify the copy', tool: 'shell_exec' }],
  });
  assert.match(text, /APPROVED PLAN/);
  assert.match(text, /Back up the folder/);
  assert.match(text, /1\. Copy files/);
  assert.match(text, /2\. Verify the copy \(tool: shell_exec\)/);
});

(async () => {
  for (const [name, fn] of checks) {
    try { await fn(); pass++; console.log('  ok    ' + name); }
    catch (e) { fails.push(name); console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
  }
  console.log('\n  ' + pass + ' passed, ' + fails.length + ' failed');
  process.exit(fails.length ? 1 : 0);
})();
