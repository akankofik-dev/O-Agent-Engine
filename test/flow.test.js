'use strict';
/* ====================================================================== *
 *  test/flow.test.js — the canvas: keys, lanes, slots, and the things a
 *  truncated comment can do to them.
 *
 *  Run: node test/flow.test.js
 *
 *  There was no test for any of this. Every one of the bugs below was found by
 *  looking at the screen, and three of them were found in one afternoon while
 *  changing the layout. A canvas bug is the worst kind to find that way: the
 *  symptom is a picture that is slightly wrong, and "slightly wrong" survives a
 *  glance, a careful look, and usually a second opinion.
 *
 *  What is executable, is executed. The pure half of the canvas - the keys, the
 *  lane, the slot, the jitter - lives inline in dashboard.html, and the tempting
 *  move is to copy it into this file and test the copy. That tests nothing: the
 *  copy is correct forever and the original is what ships. So the functions are
 *  lifted OUT OF THE HTML and run here, with the same names and the same
 *  arithmetic they have in the page, and a test fails when someone edits the
 *  page and not this.
 *
 *  What needs a document, is checked by shape. There is no DOM here and no
 *  dependency to bring one in - the project has none, deliberately - so the
 *  claims about the tile, the sub-nodes and the connectors are assertions about
 *  the source. They are weaker, and they are written knowing it: each one is a
 *  bug that actually happened, and each states what it is standing in for.
 *
 *  The last group is the reason this file exists at all. An unclosed block
 *  comment is not a syntax error - it is a comment, and everything after it,
 *  including a statement that pushes a record onto a list, is silently part of
 *  it. The page kept parsing. The page kept passing every other test in this
 *  repository. Plans stopped being drawn at all.
 *
 *  Which of these assertions can actually fail was measured, not assumed. Every
 *  one was checked by putting the bug back into dashboard.html and confirming
 *  this file goes red and names it - fifteen reintroductions, fifteen catches.
 *  Three of them were green with the bug back in the first time round, which is
 *  the part worth keeping: they asserted that a token appeared somewhere in a
 *  function rather than at the place the token does its work, and `const dy = 0`
 *  contains every word the handle test was looking for. An assertion that cannot
 *  fail is worse than no assertion, because it is counted in the total.
 * ====================================================================== */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DASH = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
const SCRIPTS = DASH.match(/<script>([\s\S]*?)<\/script>/g) || [];
const APP = SCRIPTS.map(b => b.replace(/^<script>/, '').replace(/<\/script>$/, '')).join('\n');

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
 *  reading the page
 * ---------------------------------------------------------------------- */

/**
 * One top-level declaration, out of the page, by name.
 *
 * A function ends at the brace that closes it and a const at the semicolon that
 * ends it, both counted with a depth so a `;` inside a body does not end it.
 *
 * The string-aware half matters more here than it looks. Brace counting over raw
 * source reports the wrong end for anything containing a brace in a string or a
 * comment, and this file's own history is the argument: chat-look.test.js
 * documents three parsers that all failed on exactly that, one of them by
 * treating a `{` inside a CSS comment as the end of a rule.
 */
function decl(name) {
  const fnRe = new RegExp('(?:^|\\n)function ' + name + '\\s*\\(');
  const fn = fnRe.exec(APP);
  if (fn) {
    const start = fn.index + (fn[0][0] === '\n' ? 1 : 0);
    const open = APP.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < APP.length; i++) {
      if (APP[i] === '{') depth++;
      else if (APP[i] === '}') { depth--; if (!depth) return APP.slice(start, i + 1); }
    }
    throw new Error('no end for function ' + name);
  }
  const cRe = new RegExp('(?:^|[\\s,;{}()])' + name + '\\s*=');
  const c = cRe.exec(APP);
  if (!c) throw new Error('not found in the page: ' + name);
  const at = c.index + (c[0].length - name.length);
  /* A comma declaration. `const FLOW_LANE_GAP = 46, FLOW_LANE_PITCH = 268;` is
     two constants in one statement, so the name being asked for is not preceded
     by its own `const` - and the first version of this looked for one, could not
     find FLOW_LANE_PITCH anywhere, and reported the page as missing something it
     plainly had. So the start is the nearest const, let or var BEFORE the name,
     and the statement it belongs to is only the same statement if there is no
     semicolon in between. */
  const before = ['const ', 'let ', 'var '].map(k => APP.lastIndexOf(k, at - 1));
  const start = Math.max(...before);
  if (start < 0) throw new Error('no declaration keyword before ' + name);
  if (APP.slice(start, at).indexOf(';') >= 0) {
    throw new Error('the nearest declaration of ' + name + ' is a different statement');
  }
  let depth = 0;
  for (let i = start; i < APP.length; i++) {
    const ch = APP[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ';' && depth === 0) return APP.slice(start, i + 1);
  }
  throw new Error('no end for declaration ' + name);
}

/**
 * The same source with every comment removed.
 *
 * A small state machine rather than a regex, because the whole point of this
 * helper is that `/*` inside a string literal is not a comment. The page has
 * plenty of apostrophes in prose, and a stripper that cannot tell an
 * apostrophe from a quote turns half the file into a comment and then reports
 * every later statement as missing.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const two = src.slice(i, i + 2);
    const ch = src[i];
    if (two === '//') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      /* a comment is a line break as far as the parser is concerned, and
         dropping it entirely would join two lines into one */
      out += '\n';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      out += ch; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * One function body, out of the comment-stripped page, by name.
 *
 * It sits here rather than down with the tests that mostly want it, because the
 * tests that need it run first and said so loudly: a const is in its temporal dead
 * zone until its own line executes, and the first version of the push test failed
 * with "Cannot access before initialization" on a page that was correct. A reader
 * belongs beside the other reader.
 */
const body = (name) => {
  const at = CODE_ONLY.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('not found: ' + name);
  let depth = 0, i = CODE_ONLY.indexOf('{', at);
  const from = i;
  for (; i < CODE_ONLY.length; i++) {
    if (CODE_ONLY[i] === '{') depth++;
    else if (CODE_ONLY[i] === '}') { depth--; if (!depth) return CODE_ONLY.slice(from, i + 1); }
  }
  throw new Error('no end: ' + name);
};

const CODE_ONLY = stripComments(APP);

/* The pure half of the canvas, run against the page's own text.
 *
 * The constants are lifted too, and in the order the page declares them, because
 * the geometry IS the constants: a test that supplied its own copy of FLOW_X_GAP
 * would have gone on passing after somebody changed the gap in the page and broke
 * every connector on the sheet. */
const WANTED = [
  'FLOW', 'FLOW_NODE_W', 'FLOW_PAD_X', 'FLOW_X_GAP', 'FLOW_X_PITCH',
  'FLOW_LANE_GAP', 'FLOW_LANE_PITCH', 'FLOW_CHIP_GAP',
  'flowKey', 'flowStepKey', 'flowChipKey', 'flowJitter', 'flowLaneOf',
  'flowSlotOf', 'flowPos',
];

const HARNESS = [
  /* the two things the page gets from the browser, and the one from storage */
  'let SESSION = "s1";',
  'let SAVED = {};',
  'function sessionId() { return SESSION; }',
  'function flowLayout() { return SAVED; }',
  /* and a way in. SAVED is a variable inside the function body, so assigning to
     api.SAVED from out here creates a property on the returned object and the
     page-equivalent never sees it - which is how the first version of the
     dragged-position test came to assert that a saved position of 777 was 259. */
  'function setSaved(v) { SAVED = v; }',
  /* One statement can declare two of the names above - FLOW_LANE_GAP and
     FLOW_LANE_PITCH share a `const` - and asking for both returns the same text
     twice, which is a redeclaration and a SyntaxError. Distinct by value, not by
     name. */
  ...WANTED.map(decl).filter((d, i, all) => all.indexOf(d) === i),
].join('\n');

const api = new Function(
  HARNESS + '\nreturn {' + WANTED.filter(n => !/^[A-Z]/.test(n)).join(',') +
  ', FLOW, FLOW_X_PITCH, FLOW_NODE_W, FLOW_X_GAP, FLOW_LANE_PITCH, setSaved};'
)();

/* fixtures */
const plan = (id, n, opts) => Object.assign({
  id: id, kind: null, sessionId: 's1', state: 'approved',
  plan: { summary: 'S', goal: 'g', steps: Array.from({ length: n }, (_, i) => ({ title: 'step ' + i })) },
}, opts || {});
const runRec = (id) => ({
  id: id, kind: 'run', runId: 'run1', sessionId: 's1', state: 'ended',
  plan: { summary: '', goal: '', steps: [] },
});

/* ---------------------------------------------------------------------- *
 *  keys
 *  Eighteen nodes drew on top of each other once, because a run step merged
 *  into a plan's list was addressed by its position in that list.
 * ---------------------------------------------------------------------- */

test('a plan step and a run step in the same record are not the same node', () => {
  const rec = plan(1, 2);
  rec.plan.steps[0] = { title: 'planned' };
  /* the run's first step, merged in at position 2 of a three-step plan */
  rec.plan.steps[2] = { title: 'ran', rkey: 'rstep', i: 0 };
  const planKey = api.flowStepKey(rec, rec.plan.steps[0], 0);
  const runKey = api.flowStepKey(rec, rec.plan.steps[2], 2);
  assert.notStrictEqual(planKey, runKey,
    'a run step at position 2 of a plan is not the same node as the plan step at 0');
  assert.ok(/rstep/.test(runKey), 'a run step is addressed by its rkey: ' + runKey);
});

test("a run step's key is its own index, not where it sits in the merged list", () => {
  const rec = plan(1, 3);
  const step = { title: 'ran', rkey: 'rstep', i: 1 };
  rec.plan.steps[0] = { title: 'planned a' };
  rec.plan.steps[1] = { title: 'planned b' };
  rec.plan.steps[2] = step;
  /* asked for by the position it sits at, which is 2 */
  assert.strictEqual(api.flowStepKey(rec, step, 2), 'r1-rstep-1',
    'the key follows the run index, so a saved position still means something');
  /* and asked for by its own index, which must be the same answer */
  assert.strictEqual(api.flowStepKey(rec, step, 1), api.flowStepKey(rec, step, 2),
    'the two positions the page uses for a run step must agree');
});

test('no two steps in a merged record share a key', () => {
  const rec = plan(7, 4);
  rec.plan.steps[0] = { title: 'a' };
  rec.plan.steps[1] = { title: 'b' };
  rec.plan.steps[2] = { title: 'c', rkey: 'rstep', i: 0 };
  rec.plan.steps[3] = { title: 'd', rkey: 'rstep', i: 1 };
  const keys = rec.plan.steps.map((s, i) => api.flowStepKey(rec, s, i));
  assert.strictEqual(new Set(keys).size, keys.length, 'keys: ' + keys.join(' '));
});

test('a step and its sub-node never share a key', () => {
  const rec = plan(3, 1);
  const s = { title: 'a', tool: 'shell_exec' };
  rec.plan.steps[0] = s;
  assert.notStrictEqual(api.flowStepKey(rec, s, 0), api.flowChipKey(rec, s, 0));
  const r = { title: 'b', tool: 'shell_exec', rkey: 'rstep', i: 0 };
  assert.notStrictEqual(api.flowStepKey(rec, r, 0), api.flowChipKey(rec, r, 0));
  assert.notStrictEqual(api.flowChipKey(rec, s, 0), api.flowChipKey(rec, r, 0));
});

test('the head and the answer are different nodes, and neither is a step', () => {
  const rec = plan(2, 2);
  const head = api.flowKey(rec, 'head', null);
  const end = api.flowKey(rec, 'end', null);
  const s0 = api.flowStepKey(rec, rec.plan.steps[0], 0);
  assert.strictEqual(new Set([head, end, s0]).size, 3);
  assert.ok(!head.includes('undefined') && !end.includes('undefined'),
    'a key with no index must not spell one out: ' + head + ' ' + end);
});

/* ---------------------------------------------------------------------- *
 *  lanes
 *  A run record made on the first event and the plan that arrives after it
 *  both drew in column one and sat exactly on top of each other.
 * ---------------------------------------------------------------------- */

test('two records in one session are in two different lanes', () => {
  api.FLOW.plans.length = 0;
  const a = plan(1, 1), b = runRec(2);
  api.FLOW.plans.push(a, b);
  assert.notStrictEqual(api.flowLaneOf(a), api.flowLaneOf(b),
    'two records in one session must not share a lane');
});

test('a lane is a position in the live list, not a number stored when it was made', () => {
  api.FLOW.plans.length = 0;
  const a = plan(1, 1), b = plan(2, 1), c = plan(3, 1);
  /* b and c were both made while only a existed, so a stored lane number would
     be 1 for both of them */
  a.col = 0; b.col = 0; c.col = 0;
  api.FLOW.plans.push(a, b, c);
  assert.strictEqual(new Set([a, b, c].map(api.flowLaneOf)).size, 3,
    'records made at the same moment still need three lanes');
});

test('a record that leaves takes its lane with it, and nobody else collides', () => {
  api.FLOW.plans.length = 0;
  const a = plan(1, 1), b = plan(2, 1), c = plan(3, 1);
  api.FLOW.plans.push(a, b, c);
  api.FLOW.plans.splice(1, 1);          /* b leaves - a revision superseded */
  const lanes = [a, c].map(api.flowLaneOf);
  assert.deepStrictEqual(lanes, [0, 1],
    'the survivors close up and stay distinct: ' + lanes.join(','));
  /* The survivors DO move, and that is right: an un-dragged card is laid out
     again, and closing the gap is the tidier result. What must not move is a
     card somebody positioned, and that is the next test rather than this one -
     a saved position outranks a lane, and flowPos is where that is decided. */
});

test("another session's records do not take up a lane", () => {
  api.FLOW.plans.length = 0;
  const mine = plan(1, 1), theirs = plan(2, 1);
  theirs.sessionId = 's2';
  api.FLOW.plans.push(mine, theirs);
  assert.strictEqual(api.flowLaneOf(mine), 0, 'only this session counts');
});

/* ---------------------------------------------------------------------- *
 *  slots and positions
 * ---------------------------------------------------------------------- */

test('a lane reads left to right: head, the steps in order, then the answer', () => {
  const rec = plan(1, 3);
  const keys = [api.flowKey(rec, 'head', null)]
    .concat(rec.plan.steps.map((s, i) => api.flowStepKey(rec, s, i)))
    .concat([api.flowKey(rec, 'end', null)]);
  const slots = keys.map(k => api.flowSlotOf(rec, k, rec.plan.steps));
  assert.deepStrictEqual(slots, [0, 1, 2, 3, 4],
    'four steps make five cards, and the answer is one past the last step');
});

test('two steps make four cards, not three', () => {
  const rec = plan(1, 2);
  const end = api.flowKey(rec, 'end', null);
  assert.strictEqual(api.flowSlotOf(rec, end, rec.plan.steps), 3,
    'the answer sits past the last step, so it is not sharing a slot with it');
});

test('every card in a lane is further right than the one before it', () => {
  const rec = plan(4, 5);
  const cards = [api.flowPos(rec, 'head', null)]
    .concat(rec.plan.steps.map((s, i) => api.flowPos(rec, 'step', i)))
    .concat([api.flowPos(rec, 'end', null)]);
  /* Asked with the arguments the page asks with. The first version passed
     kind 'step' and index 0 for every key, which puts the head card and the
     first step in the same slot - so the assertion below was really asserting
     that flowPos ignores its own arguments, and it passed for the wrong reason
     until the jitter made two neighbours tie. */
  for (let i = 1; i < cards.length; i++) {
    assert.ok(cards[i].x > cards[i - 1].x,
      'card ' + i + ' at x=' + cards[i].x + ' is not right of ' + cards[i - 1].x);
  }
  assert.strictEqual(new Set(cards.map(c => Math.round(c.x / 10))).size, cards.length,
    'two cards landed in the same column');
});

test('the gap between cards is air, not an overlap', () => {
  assert.ok(api.FLOW_X_GAP > 40,
    'the gap has to leave room for a connector and a dot: ' + api.FLOW_X_GAP);
  assert.strictEqual(api.FLOW_X_PITCH, api.FLOW_NODE_W + api.FLOW_X_GAP,
    'the pitch is the card plus the air, and nothing else');
  assert.ok(api.FLOW_X_PITCH > api.FLOW_NODE_W);
});

test('a run step inside a merged plan record gets a slot of its own', () => {
  const rec = plan(5, 3);
  rec.plan.steps[0] = { title: 'a' };
  rec.plan.steps[1] = { title: 'b' };
  rec.plan.steps[2] = { title: 'c' };
  /* a run step carrying its own index, sitting at position 2 of the merged list */
  const r = { title: 'ran', rkey: 'rstep', i: 0 };
  rec.plan.steps.push(r);
  const key = api.flowStepKey(rec, r, 3);
  const slot = api.flowSlotOf(rec, key, rec.plan.steps);
  /* Four steps, so the cards are the head at 0, the four steps at 1 to 4, and
     the answer at 5. The run step is the last of the four, so it is card 4 -
     the first version said 3, which is what a five-entry list would give. */
  assert.strictEqual(slot, 4);
  assert.notStrictEqual(slot, api.flowSlotOf(rec, api.flowStepKey(rec, rec.plan.steps[0], 0), rec.plan.steps),
    'and it is not sharing a slot with the first plan step');
});

test('a position somebody dragged is returned exactly as it was saved', () => {
  api.setSaved({ s1: { 'r1-step-0': { x: 777, y: 333 } } });
  const rec = plan(1, 2);
  const p = api.flowPos(rec, 'step', 0);
  assert.strictEqual(p.x, 777);
  assert.strictEqual(p.y, 333);
  api.setSaved({});
});

test('an unsaved position is derived, and is never off the sheet', () => {
  api.setSaved({});
  api.FLOW.laneY = [52];
  const rec = plan(1, 1);
  const head = api.flowPos(rec, 'head', null);
  assert.ok(head.x >= 0 && head.y >= 0, 'the first card cannot be at a negative coordinate');
  const end = api.flowPos(rec, 'end', null);
  assert.ok(end.x > head.x);
});

test('the first card of a record with no measured lane is still on the sheet', () => {
  api.FLOW.laneY = [];
  const rec = plan(1, 1);
  const p = api.flowPos(rec, 'head', null);
  assert.ok(p.x > 0 && p.y > 0,
    'a brand new record is painted one frame before it is measured, and that frame '
    + 'has to put it somewhere sensible');
});

/* ---------------------------------------------------------------------- *
 *  the measured randomness
 * ---------------------------------------------------------------------- */

test('the same node is in the same place on every repaint', () => {
  for (const k of ['r1-head', 'r1-step-0', 'r2-rstep-3', 'r2-rchip-1']) {
    assert.deepStrictEqual(api.flowJitter(k), api.flowJitter(k),
      'a node whose offset changes on every repaint walks out from under the pointer: ' + k);
  }
});

test('a node is nudged, not thrown', () => {
  let maxX = 0, maxY = 0;
  for (let i = 0; i < 400; i++) {
    const j = api.flowJitter('r1-step-' + i);
    maxX = Math.max(maxX, Math.abs(j.x));
    maxY = Math.max(maxY, Math.abs(j.y));
  }
  assert.ok(maxX <= 30, 'horizontal nudge is out of bounds: ' + maxX);
  assert.ok(maxY <= 3, 'the vertical nudge is meant to break a baseline, not the row gap: ' + maxY);
});

test('a nudged card cannot reach the one beside it', () => {
  /* the two cards either side of one gap, both pulled as far towards each other
     as the hash can possibly pull them */
  for (let i = 0; i < 400; i++) {
    const a = api.flowJitter('r1-step-' + i);
    const b = api.flowJitter('r1-step-' + (i + 1));
    const closest = Math.abs((a.x - b.x) - api.FLOW_X_GAP);
    assert.ok(closest >= 0 && api.FLOW_X_PITCH - Math.abs(a.x - b.x) >= api.FLOW_NODE_W,
      'cards ' + i + ' and ' + (i + 1) + ' could touch: dx=' + Math.abs(a.x - b.x));
  }
});

test('a lane is not a ruler', () => {
  const xs = new Set();
  for (let i = 0; i < 40; i++) xs.add(api.flowJitter('r1-step-' + i).x);
  assert.ok(xs.size >= 20,
    'forty steps produced only ' + xs.size + ' distinct offsets, which draws as a column');
});

/* ---------------------------------------------------------------------- *
 *  a truncated comment
 * ---------------------------------------------------------------------- */

test('a proposal still reaches the list of things to draw', () => {
  /* Scoped to actPlan, not searched for anywhere. The first version grepped the
     whole script for the call, and there are two of them - flowRunRecord pushes
     the run's record the same way - so commenting out the one in actPlan left
     the other one to satisfy it. That is what a mutation check is for: the test
     was green with the bug back in. */
  const actPlan = body('actPlan');
  assert.ok(/FLOW\.plans\.push\(rec\)/.test(actPlan),
    'FLOW.plans.push(rec) is inside a comment, so it never happens. An unclosed '
    + 'block comment is not a syntax error: the page parses, every other test in '
    + 'this repository passes, and no plan is ever drawn.');
  assert.ok(/FLOW\.open\s*=\s*rec/.test(CODE_ONLY),
    'the open record is assigned in code, not in prose');
});

test('every function the canvas calls is one the page declares', () => {
  const declared = new Set();
  for (const m of CODE_ONLY.matchAll(/(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=)/g)) {
    declared.add(m[1] || m[2]);
  }
  const called = new Set();
  for (const m of CODE_ONLY.matchAll(/\b(flow[A-Za-z]\w*)\s*\(/g)) called.add(m[1]);
  const missing = [...called].filter(c => !declared.has(c));
  assert.deepStrictEqual(missing, [],
    'called but never declared - a typo is the only way to get here, and the page '
    + 'throws at the first call: ' + missing.join(', '));
});

test('the page\'s own scripts parse', () => {
  for (const [i, body] of SCRIPTS.entries()) {
    const code = body.replace(/^<script>/, '').replace(/<\/script>$/, '');
    try {
      new Function(code);
    } catch (e) {
      assert.fail('script block ' + (i + 1) + ' does not parse: ' + e.message);
    }
  }
});

/* ---------------------------------------------------------------------- *
 * ---------------------------------------------------------------------- */

test('the tile is drawn before the caption, not after it', () => {
  const c = body('flowCard');
  assert.ok(/insertBefore\(\s*tile\s*,\s*el\.firstChild\s*\)/.test(c),
    'flowCard appends the tile. The caption is in normal flow, so appending puts the '
    + 'words ABOVE the box: every tile on the sheet had a caption hovering over it '
    + 'and an empty strip under it, and the connectors were 50px below their boxes.');
});

test('the stamp is written under the card, not inside it', () => {
  const c = body('flowCard');
  const tile = /TILE\s*=\s*\[([^\]]*)\]/.exec(c);
  const caption = /CAPTION\s*=\s*\[([^\]]*)\]/.exec(c);
  assert.ok(tile && caption, 'flowCard still has its two lists');
  assert.ok(!/\.fl-stamp/.test(tile[1]),
    'the stamp is prose about the run, and it belongs under the box with the name');
  assert.ok(/\.fl-stamp/.test(caption[1]), 'and it has to be somewhere');
  assert.ok(/\.fl-tick/.test(tile[1]),
    'the tick is positioned in a corner of the tile, so it is not a caption');
});

test('a connector is drawn before it is marked', () => {
  const c = body('flowEdges');
  /* The binding, not the order of two strings.
   *
   * The first version compared the index of `curve(` with the index of the marking
   * call, and a mutation that inlines the curve into the marking call still draws
   * first - so the assertion held with the bug back in. What actually went wrong
   * was a name used before it was assigned, and that is only visible if the path is
   * bound to something the marking line then uses. */
  assert.ok(/const path = curve\(x1, y1, x2, y2/.test(c),
    'the connector is never assigned to anything, so the line that marks it for the '
    + 'completed-step crossing has no path to mark');
  const marked = /([\s\S]{0,120}?)setAttribute\("data-from", fromKey\)/.exec(c);
  assert.ok(marked && /\bpath\b/.test(marked[1]),
    'the crossing marks a name that is not the one the curve was assigned to');
});

test('the sheet is measured in sheet coordinates', () => {
  /* The loop that sizes the canvas, not the function. flowEdges calls flowBox in
     three places and only the first decides how big the sheet is; the first
     version asserted the word appeared anywhere in the function, so swapping the
     measurement back to offsetLeft - the bug - left it green. */
  const c = body('flowEdges');
  const measure = /querySelectorAll\("\.fl-node, \.fl-chip"\)([\s\S]{0,400}?)\n  \}\);/.exec(c);
  assert.ok(measure, 'the sheet-sizing loop is gone');
  assert.ok(/flowBox\(n\)/.test(measure[1]),
    'the sheet is measured with offsetLeft. The tile is position:relative inside a '
    + 'node that is position:absolute, so the node is the tile offsetParent and '
    + 'tile.offsetLeft is 0 for every tile on the sheet.');
});

test('the length of a sub-node lead is computed, not left undefined', () => {
  const c = body('flowEdges');
  /* The arithmetic itself, not the presence of a name. `const dy = 0` keeps every
     token the first version looked for and draws a straight line through the
     words, which is exactly the failure - and the test was green. */
  assert.ok(/const dy = Math\.max\(4, \(y2 - y1\)\s*\/\s*3\)/.test(c),
    'the sub-edge handle is not a third of the gap any more. A handle that does '
    + 'not scale with the gap either loops back on itself or runs the lead '
    + 'straight through the caption it belongs to.');
  const draw = /const path = document\.createElementNS\(NS, "path"\);([\s\S]{0,300}?)fl-subedge/.exec(c);
  assert.ok(draw && /y2 - dy/.test(draw[1]), 'and it is not used in the path either');
});

test('a sub-node hangs below the caption, not across it', () => {
  const c = body('flowStack');
  assert.ok(/chip\.style\.top\s*=\s*\(\s*b\.y\s*\+\s*el\.offsetHeight/.test(c),
    'the sub-node is placed from the TILE height. The caption is between the tile '
    + 'and the sub-node, so the tool lands on top of the words and its own name is '
    + 'unreadable.');
  /* The port is styled, not built: the sub-node connector is a rule in the
     stylesheet and the script only asks for it by name. Asserting on the script
     for a selector is looking for CSS in JavaScript. */
  assert.ok(/\.fl-port\.sub\s*\{[^}]*bottom\s*:\s*-5px/.test(DASH),
    'the sub-node connector is still on the bottom edge of the tile, which is right');
});

test('a dragged sub-node keeps the gap an undragged one has', () => {
  const drag = /chip\.style\.top = \(y \+ FLOW\.drag\.node\.offsetHeight \+ ([^)]*)\)/.exec(CODE_ONLY);
  assert.ok(drag, 'a dragged step does not bring its sub-node at all');
  assert.ok(/FLOW_CHIP_GAP/.test(drag[1]),
    'the drag uses its own number, ' + drag[1] + ', and the two disagree on the gap');
});

test('the view is fitted until the person takes it over', () => {
  assert.ok(/viewTouched/.test(CODE_ONLY),
    'nothing records that the person has taken the view, so a fit-on-every-repaint '
    + 'would move the canvas under the pointer on every result');
  assert.ok(/addEventListener\("wheel"[\s\S]{0,240}?viewTouched = true/.test(CODE_ONLY),
    'the wheel does not claim the view');
  assert.ok(/FLOW\.panning = \{[\s\S]{0,80}?viewTouched = true/.test(CODE_ONLY),
    'a pan does not claim the view');
});

test('the zoom readout is not the button that changes the view', () => {
  assert.ok(/id="flowZoomPct"/.test(DASH), 'there is no readout element to write to');
  const label = body('flowZoomLabel');
  assert.ok(!/flowZoomReset/.test(label),
    'the percentage is written into the Fit button, so the button says "64%"');
  assert.ok(/flowZoomPct/.test(label), 'and nothing writes the readout at all');
});

/* ---------------------------------------------------------------------- *
 *  the run list, and the plan answer
 *
 *  Two bugs, both found by reading rather than by running, and both about a
 *  number that should have held still and did not.
 * ---------------------------------------------------------------------- */

test('a step is numbered by itself, not by where it sits in the list', () => {
  const push = body('actPush');
  assert.ok(/n: \+\+ACT\.serial/.test(push),
    'a step carries no number of its own. The canvas keys a run step by that number, '
    + 'and the only one available was its position in ACT.steps - which the cap moves.');
  assert.ok(/ACT\.steps\.length > 40\) ACT\.steps\.shift\(\)/.test(push),
    'and the cap is still there, so a position is still not a number that holds');
  const rs = body('flowRunSteps');
  assert.ok(/i: s\.n != null \? s\.n : i/.test(rs),
    'flowRunSteps keys by the array position, so a run of more than forty steps '
    + 'renumbers every node on the sheet as the oldest rows drop off the front.');
});

test('the step number starts again with the run and only ever goes up', () => {
  const act = /const ACT = \{[^}]*\}/.exec(CODE_ONLY);
  assert.ok(act && /serial: 0/.test(act[0]), 'ACT has no serial to count with');
  const reset = body('actReset');
  assert.ok(/ACT\.serial = 0/.test(reset),
    'a new run inherits the last run numbers, and two runs in one page key their '
    + 'steps the same way');
  const save = body('actSave');
  assert.ok(/serial: ACT\.serial/.test(save),
    'a refresh loses the count, so every key moves once when the list is rebuilt');
  const restore = body('actRestore');
  assert.ok(/ACT\.serial = Math\.max/.test(restore) && /n: Number\.isFinite\(s\.n\)/.test(restore),
    'the restored list has to carry the numbers it was saved with');
});

test('a replayed plan is answered against a run id this page actually has', () => {
  const resume = body('runResume');
  assert.ok(/CHAT\.runId = st\.runId/.test(resume),
    'runResume restores RUN.id and not CHAT.runId, and the plan answer reads the '
    + 'other one - so a proposal that survived a refresh could not be answered.');
  const answer = body('planAnswer');
  assert.ok(/const runId = CHAT\.runId \|\| RUN\.id \|\| ""/.test(answer),
    'the answer posts one field and trusts it. It is empty on a fresh page and STALE '
    + 'on a page that has already run once, and a stale one approves the plan against '
    + 'a different run.');
  assert.ok(/if \(!runId\)/.test(answer),
    'and an empty run id is refused in the page rather than posted, because the '
    + 'server answers 409 and the card is then marked dead for the wrong reason.');
});
/* ---------------------------------------------------------------------- *
 *  the suite has to be able to fail
 *  the suite has to be able to fail
 *
 *  Every assertion above was checked by putting the bug back into
 *  dashboard.html and confirming that this file goes red and names it: fifteen
 *  reintroductions, fifteen catches. Three of them were green with the bug in the
 *  first time round, because they asserted that a token appeared somewhere in a
 *  function rather than at the place the token does its work - a handle of zero
 *  keeps every word they were looking for. They are written to the shape now.
 *
 *  This last one is here because of how those three were found. A splice cut this
 *  file off at a comment banner, which removed nine tests and the summary line -
 *  and the file still parsed, the run still exited 0, and every remaining test
 *  still said ok. A truncated test file and a passing test file look exactly the
 *  same from the outside, which is the whole argument for checking.
 * ---------------------------------------------------------------------- */

test('this file is not silently truncated', () => {
  const declared = (fs.readFileSync(__filename, 'utf8').match(/^test\(/gm) || []).length;
  assert.ok(declared >= 37, 'only ' + declared + ' tests are in the file');
  assert.ok(/\n\s*console\.log\('\\n  ' \+ passed/.test(fs.readFileSync(__filename, 'utf8')),
    'the file has no summary line, so it is not finishing its run');
});

if (failures.length) {
  for (const f of failures) {
    console.log('\n  ' + f.name + '\n  ' + (f.error.stack || f.error.message));
  }
  /* process.exit and not process.exitCode, which is what every other suite here
     does and what readme.test.js checks for - a suite that sets a code and falls off
     the end still exits zero if anything before it threw, and a suite that cannot
     be trusted to fail is a suite nobody reads the result of. */
  process.exit(1);
}

console.log('\n  ' + passed + ' passed, ' + failures.length + ' failed');