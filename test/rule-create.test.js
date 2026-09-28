'use strict';
/* ====================================================================== *
 *  test/rule-create.test.js — the agent writing a new rule of its own.
 *
 *  Run: node test/rule-create.test.js
 *
 *  This is the test for a refusal that turned out to be protecting a door that
 *  was already locked. New skills used to be refused because a new skill
 *  carries its own `requires`, and could therefore arrive asking for exactly
 *  the capability the user had just switched off. Checking that claim against
 *  ai/skills.js is what turned it into permission: resolve() reads the
 *  profile's switches first and drops any skill that asks for more than it is
 *  given, so a rule nobody enabled cannot widen a tool toggle.
 *
 *  The claim is only worth as much as the test underneath it, so the centre of
 *  this file is the gate itself: a created rule requiring `terminal`, resolved
 *  against a profile with terminal off, must be blocked and must contribute
 *  nothing to the capabilities the agent ends up with. If that ever stops being
 *  true the permission above it becomes a back door, and the failure would be
 *  silent — the agent would simply have more tools than the switches allow.
 *
 *  Everything else here is the ordinary life of a created rule: it is proposed
 *  rather than written, it is validated like any other proposal, it can be
 *  thrown away, and a revert removes it because reverting restores a snapshot.
 * ====================================================================== */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rules = require('../ai/rules');
const skills = require('../ai/skills');

let pass = 0;
const fails = [];
function check(name, fn) {
  try { fn(); pass++; } catch (e) { fails.push(name + '\n      ' + e.message); }
}

/* `useDir()` with no argument clears the override — that is its documented
   behaviour, not a getter — so each fresh directory is kept here rather than
   read back out of the module. */
let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-create-'));
const madeDirs = [dir];
rules.useDir(dir);

const skill = over => Object.assign({
  id: 'invoice-chasing',
  name: 'Invoice Chasing',
  description: 'Read an unpaid invoice and work out who to ask.',
  instruction: 'Read the invoice before writing anything. Never guess an amount.',
  requires: ['browser', 'dom'],
}, over || {});

const fresh = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-create-'));
  madeDirs.push(d);
  dir = d;
  rules.useDir(dir);
  return d;
};

/* ---- proposing a rule that does not exist yet ------------------------ */

check('a new rule is proposed, not written', () => {
  fresh();
  const r = rules.propose({ kind: 'create', skill: skill(), reason: 'we keep re-deriving this' }, 'agent');
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.state, 'proposed');
  /* the point of the whole design: nothing is in force until a person says so */
  assert.ok(!rules.byId().has('invoice-chasing'), 'the rule existed before it was accepted');
  assert.strictEqual(rules.listProposals().length, 1);
});

check('the proposal carries the rule and the capabilities it asks for', () => {
  fresh();
  rules.propose({ kind: 'create', skill: skill({ requires: ['terminal'] }), reason: 'needs the shell' }, 'agent');
  const p = rules.listProposals()[0];
  assert.strictEqual(p.kind, 'create');
  assert.strictEqual(p.skillId, 'invoice-chasing');
  assert.deepStrictEqual(p.requires, ['terminal'], 'the reviewer cannot see what it asks for');
  assert.strictEqual(p.from, null, 'a new rule has no previous value to show');
});

check('an unexplained rule is refused', () => {
  fresh();
  const r = rules.propose({ kind: 'create', skill: skill(), reason: '   ' }, 'agent');
  assert.strictEqual(r.ok, false);
  assert.ok(/reason is required/.test(r.error), r.error);
});

/* ---- the gate: the reason the refusal was wrong ----------------------- */

check('a rule nobody can run is blocked, and grants nothing', () => {
  fresh();
  const p = rules.propose({ kind: 'create', skill: skill({ requires: ['terminal'] }), reason: 'needs the shell' }, 'agent');
  rules.approve(p.id);

  const on = skills.resolve(['invoice-chasing'], { browser: true, dom: true, terminal: true });
  assert.strictEqual(on.selected.length, 1, 'with terminal on the rule should run');

  /* the assertion the whole permission rests on */
  const off = skills.resolve(['invoice-chasing'], { browser: true, dom: true, terminal: false });
  assert.strictEqual(off.selected.length, 0, 'a rule asking for a switch that is off still reached the agent');
  assert.strictEqual(off.blocked.length, 1);
  assert.deepStrictEqual(off.blocked[0].missing, ['terminal']);
  /* and it must not have granted the capability on its way past. The check is
     `false` rather than `absent` because resolve() fills every key from the
     profile's switches; what matters is that the value stayed off. */
  assert.strictEqual(off.caps.terminal, false, 'the rule granted the capability it was refused');
  assert.strictEqual(off.caps.browser, true, 'a capability the profile does have should still be there');
  assert.strictEqual(skills.instructionBlock(off), '', 'a blocked rule still reached the prompt');
});

check('resolve() reports a blocked rule as blocked rather than dropping it quietly', () => {
  fresh();
  const p = rules.propose({ kind: 'create', skill: skill({ requires: ['terminal'] }), reason: 'r' }, 'agent');
  rules.approve(p.id);
  const r = skills.resolve(['invoice-chasing'], { browser: true, dom: true });
  const b = r.blocked.find(x => x.id === 'invoice-chasing');
  assert.ok(b, 'a blocked rule is invisible, so the page cannot warn about it');
  assert.strictEqual(b.name, 'Invoice Chasing', 'the page has no name to show');
});

check('resolve() says nothing about rules a profile has not picked, on purpose', () => {
  fresh();
  const p = rules.propose({ kind: 'create', skill: skill(), reason: 'r' }, 'agent');
  rules.approve(p.id);
  const r = skills.resolve([], { browser: true, dom: true });
  /* There is no `unselected` list here, and that is a decision rather than an
     oversight. A rule nobody switched on is real — it is in the catalog, marked
     as written by the agent, and the skill cards say which capability it is
     missing. A server-side copy would go stale the moment somebody toggles a
     switch on the form, and this function runs on every tool list. Blocked
     rules are the opposite case and are reported, because a block has no other
     way to become visible. */
  assert.strictEqual(r.unselected, undefined, 'an unread list crept back into the hot path');
  const found = rules.catalog().find(s => s.id === 'invoice-chasing');
  assert.strictEqual(found.created, true, 'so the page has to mark it from the catalog instead');
});

check('an unknown capability is refused at propose time, not left to block forever', () => {
  fresh();
  const r = rules.propose({ kind: 'create', skill: skill({ requires: ['terminal', 'teleport'] }), reason: 'r' }, 'agent');
  assert.strictEqual(r.ok, false);
  assert.ok(/teleport/.test(r.error), 'the error should name the wrong one: ' + r.error);
  assert.ok(/terminal/.test(r.error), 'the error should list the real ones: ' + r.error);
});

/* ---- the ordinary life of a created rule ----------------------------- */

check('accepting it puts it in the catalog as a created rule', () => {
  fresh();
  const p = rules.propose({ kind: 'create', skill: skill(), reason: 'r' }, 'agent');
  const a = rules.approve(p.id);
  assert.strictEqual(a.ok, true, a.error);
  assert.strictEqual(a.kind, 'create');
  const s = rules.byId().get('invoice-chasing');
  assert.ok(s, 'an accepted rule is not in the catalog');
  assert.strictEqual(s.created, true, 'it is indistinguishable from a shipped rule');
  assert.strictEqual(s.requires.length, 2);
});

check('shipped rules are not marked as created', () => {
  fresh();
  assert.strictEqual(rules.byId().get('browser-research').created, false);
});

check('a rule with no capabilities is allowed — it only tells you how to work', () => {
  fresh();
  const p = rules.propose({ kind: 'create', skill: skill({ requires: [] }), reason: 'r' }, 'agent');
  assert.strictEqual(p.ok, true, p.error);
  rules.approve(p.id);
  const r = skills.resolve(['invoice-chasing'], { browser: true });
  assert.strictEqual(r.selected.length, 1, 'a rule needing no capability should still run');
});

check('a rule that already exists is refused, rather than replacing it', () => {
  fresh();
  const p = rules.propose({ kind: 'create', skill: skill(), reason: 'r' }, 'agent');
  rules.approve(p.id);
  /* now it is real, so a second proposal for the same id is a different thing
     from the one that revises a proposal still waiting in the queue */
  const q = rules.propose({ kind: 'create', skill: skill({ name: 'Other' }), reason: 'r' }, 'agent');
  assert.strictEqual(q.ok, false, 'a second proposal for a live rule was accepted');
  assert.ok(/already exists/.test(q.error), q.error);
  assert.strictEqual(rules.byId().get('invoice-chasing').name, 'Invoice Chasing', 'the live rule was replaced');
});

check('approving over a rule that appeared in the meantime is refused', () => {
  fresh();
  const p = rules.propose({ kind: 'create', skill: skill(), reason: 'r' }, 'agent');
  /* someone writes it straight into the file while it waits in the queue */
  fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify({
    version: 1,
    overrides: { 'invoice-chasing': skill() },
    history: [],
  }));
  rules.invalidate();
  const a = rules.approve(p.id);
  assert.strictEqual(a.ok, false, 'it overwrote a rule instead of reporting the conflict');
  assert.ok(/already exists/.test(a.error), a.error);
});

check('reverting removes a created rule, because revert restores a snapshot', () => {
  fresh();
  const p = rules.propose({ kind: 'create', skill: skill(), reason: 'r' }, 'agent');
  const a = rules.approve(p.id);
  assert.ok(rules.byId().has('invoice-chasing'));
  const rv = rules.revert(a.version);
  assert.strictEqual(rv.ok, true, rv.error);
  assert.ok(!rules.byId().has('invoice-chasing'), 'the rule survived its own revert');
});

check('reset takes created rules with it', () => {
  fresh();
  const p = rules.propose({ kind: 'create', skill: skill(), reason: 'r' }, 'agent');
  rules.approve(p.id);
  rules.reset();
  assert.ok(!rules.byId().has('invoice-chasing'), 'a written rule outlived reset');
});

check('rejecting it leaves no trace in the catalog', () => {
  fresh();
  const p = rules.propose({ kind: 'create', skill: skill(), reason: 'r' }, 'agent');
  rules.reject(p.id);
  assert.ok(!rules.byId().has('invoice-chasing'));
  assert.strictEqual(rules.listProposals().length, 0);
});

check('proposing the same rule twice is one question, not two', () => {
  fresh();
  rules.propose({ kind: 'create', skill: skill(), reason: 'r' }, 'agent');
  const again = rules.propose({ kind: 'create', skill: skill(), reason: 'r' }, 'agent');
  assert.strictEqual(again.state, 'already proposed');
  assert.strictEqual(rules.listProposals().length, 1);
});

check('proposing it again with a different body revises the waiting one', () => {
  fresh();
  const a = rules.propose({ kind: 'create', skill: skill(), reason: 'r' }, 'agent');
  const b = rules.propose({ kind: 'create', skill: skill({ instruction: 'Different.' }), reason: 'r2' }, 'agent');
  assert.strictEqual(b.state, 'revised');
  assert.strictEqual(b.id, a.id, 'a second proposal was queued instead of revising the first');
  assert.strictEqual(rules.listProposals().length, 1);
  assert.strictEqual(rules.listProposals()[0].skill.instruction, 'Different.');
});

check('an edit to a shipped rule still works, and still cannot touch requires', () => {
  fresh();
  const r = rules.propose({ skillId: 'browser-research', field: 'instruction', value: 'New text.', reason: 'r' }, 'agent');
  assert.strictEqual(r.ok, true, r.error);
  const cap = rules.propose({ skillId: 'browser-research', field: 'requires', value: 'terminal', reason: 'r' }, 'agent');
  assert.strictEqual(cap.ok, false, 'an existing rule handed out a capability');
  assert.ok(/requires/.test(cap.error), cap.error);
});

check('editing a rule that does not exist points at the way to make one', () => {
  fresh();
  const r = rules.propose({ skillId: 'nope', field: 'instruction', value: 'x', reason: 'r' }, 'agent');
  assert.strictEqual(r.ok, false);
  assert.ok(/create/.test(r.error), 'the error should say how to actually add a rule: ' + r.error);
});

/* ---- a written rule is not frozen ------------------------------------ */

check('a rule the agent wrote can be corrected afterwards', () => {
  fresh();
  const c = rules.propose({ kind: 'create', skill: skill(), reason: 'r' }, 'agent');
  rules.approve(c.id);
  const e = rules.propose({ skillId: 'invoice-chasing', field: 'instruction', value: 'Corrected.', reason: 'said it wrong' }, 'agent');
  assert.strictEqual(e.ok, true, 'a rule that can be written but never fixed: ' + e.error);
  const a = rules.approve(e.id);
  assert.strictEqual(a.ok, true, a.error);
  const s = rules.byId().get('invoice-chasing');
  assert.strictEqual(s.instruction, 'Corrected.');
  assert.strictEqual(s.created, true, 'correcting it stopped it being a written rule');
  assert.deepStrictEqual(s.requires, ['browser', 'dom'], 'the edit dropped the capabilities');
});

check('the history of a written rule records where the text came from', () => {
  fresh();
  const c = rules.propose({ kind: 'create', skill: skill(), reason: 'r' }, 'agent');
  const ca = rules.approve(c.id);
  const e = rules.propose({ skillId: 'invoice-chasing', field: 'instruction', value: 'Corrected.', reason: 'said it wrong' }, 'agent');
  rules.approve(e.id);
  const h = rules.history().find(x => x.version > ca.version);
  assert.ok(h, 'the edit left no history');
  assert.strictEqual(h.from, skill().instruction, 'recorded as coming from nowhere: ' + h.from);
  assert.strictEqual(h.to, 'Corrected.');
});

check('a written rule still cannot have its capabilities changed by an edit', () => {
  fresh();
  const c = rules.propose({ kind: 'create', skill: skill({ requires: ['browser'] }), reason: 'r' }, 'agent');
  rules.approve(c.id);
  const r = rules.propose({ skillId: 'invoice-chasing', field: 'requires', value: 'terminal', reason: 'r' }, 'agent');
  assert.strictEqual(r.ok, false, 'an edit handed a written rule a capability');
  assert.ok(/requires/.test(r.error), r.error);
});

check('reverting a correction of a written rule brings back the first text', () => {
  fresh();
  const c = rules.propose({ kind: 'create', skill: skill(), reason: 'r' }, 'agent');
  rules.approve(c.id);
  const e = rules.propose({ skillId: 'invoice-chasing', field: 'instruction', value: 'Corrected.', reason: 'said it wrong' }, 'agent');
  const ea = rules.approve(e.id);
  rules.revert(ea.version);
  const s = rules.byId().get('invoice-chasing');
  assert.ok(s, 'undoing a correction deleted the rule instead of restoring it');
  assert.strictEqual(s.instruction, skill().instruction, 'it restored the wrong text');
});

/* ---- a hand-edited file gets the same check -------------------------- */

check('a rule written straight into the file is accepted', () => {
  fresh();
  fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify({
    version: 1, overrides: { 'from-a-file': skill({ id: 'from-a-file' }) }, history: [],
  }));
  rules.invalidate();
  assert.ok(rules.byId().has('from-a-file'), 'a hand-written rule is ignored, which makes the file a dead end');
});

check('a half-written rule in the file is dropped rather than carried', () => {
  fresh();
  fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify({
    version: 1,
    overrides: { 'broken-rule': { id: 'broken-rule', name: 'No instruction here' } },
    history: [],
  }));
  rules.invalidate();
  assert.ok(!rules.byId().has('broken-rule'), 'a rule with no instruction would reach the agent as an empty block');
});

check('a file rule with a capability nobody has is kept, and blocked at runtime', () => {
  fresh();
  fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify({
    version: 1,
    overrides: { 'file-terminal': skill({ id: 'file-terminal', requires: ['terminal'] }) },
    history: [],
  }));
  rules.invalidate();
  const r = skills.resolve(['file-terminal'], { browser: true, dom: true });
  assert.strictEqual(r.selected.length, 0);
  assert.strictEqual(r.caps.terminal, false, 'the file handed out a capability the switches refused');
});

/* ---- shape ----------------------------------------------------------- */

check('a bad id is refused with the rule spelled out', () => {
  fresh();
  for (const id of ['Has Spaces', '9starts-with-digit', 'UPPER', '', 'x']) {
    const r = rules.propose({ kind: 'create', skill: skill({ id }), reason: 'r' }, 'agent');
    assert.strictEqual(r.ok, false, 'id "' + id + '" was accepted');
  }
});

check('every part of a new rule is required', () => {
  fresh();
  for (const field of ['name', 'description', 'instruction']) {
    const s = skill();
    delete s[field];
    const r = rules.propose({ kind: 'create', skill: s, reason: 'r' }, 'agent');
    assert.strictEqual(r.ok, false, 'a rule with no ' + field + ' was accepted');
    assert.ok(new RegExp(field).test(r.error), r.error);
  }
  const noReq = skill();
  delete noReq.requires;
  const r = rules.propose({ kind: 'create', skill: noReq, reason: 'r' }, 'agent');
  assert.strictEqual(r.ok, false, 'requires defaulted itself instead of being asked for');
});

check('a rule is refused if its name is over the limit', () => {
  fresh();
  const r = rules.propose({ kind: 'create', skill: skill({ name: 'x'.repeat(500) }), reason: 'r' }, 'agent');
  assert.strictEqual(r.ok, false);
  assert.ok(/limit/.test(r.error), r.error);
});

/* ---- the tool the agent actually holds -------------------------------- */

check('the agent has a tool for creating a rule, and it is behind the rules switch', () => {
  const tools = require('../ai/tools');
  const t = tools.TOOLS.find(x => x.name === 'rule_create');
  assert.ok(t, 'there is no rule_create tool, so the agent cannot make a rule at all');
  assert.deepStrictEqual(t.caps, ['rules']);
  assert.deepStrictEqual(t.parameters.required.sort(), ['description', 'id', 'instruction', 'name', 'reason', 'requires']);
  /* and it still cannot reach it when the switch is off */
  const gated = tools.toolsFor({ skills: [], tools: { browser: true, rules: false } });
  assert.ok(!gated.some(x => x.name === 'rule_create'), 'the tool is available with the rules switch off');
  const open = tools.toolsFor({ skills: [], tools: { browser: true, rules: true } });
  assert.ok(open.some(x => x.name === 'rule_create'), 'the tool is missing with the rules switch on');
});

check('the tool hands the proposal to the same validator the page uses', () => {
  const tools = require('../ai/tools');
  const t = tools.TOOLS.find(x => x.name === 'rule_create');
  const r = t.run({}, {
    id: 'from-the-tool', name: 'From The Tool', description: 'd',
    instruction: 'i', requires: ['browser'], reason: 'because',
  });
  assert.strictEqual(r.ok, true, r.error);
  const p = rules.listProposals().find(x => x.skillId === 'from-the-tool');
  assert.ok(p, 'the tool returned ok but queued nothing');
  assert.strictEqual(p.by, 'agent');
});

/* ---- cleanup --------------------------------------------------------- */

for (const d of madeDirs) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* windows holds handles */ }
}

console.log('\n  rule-create: ' + pass + ' passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ''));
if (fails.length) { console.log('\n  ' + fails.join('\n  ') + '\n'); process.exit(1); }
