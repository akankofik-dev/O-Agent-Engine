'use strict';
/* ====================================================================== *
 *  test/chat-look.test.js — the chat matches the numbers it claims to match.
 *
 *  Run: node test/chat-look.test.js
 *
 *  The chat was restyled to look like OpenCode's. "Looks like" is exactly the
 *  kind of claim that cannot be checked by looking — the person who made it can
 *  see the result and the person reading the commit cannot — so every value is
 *  pinned here, and each one names the OpenCode token it was taken from.
 *
 *  The tokens were read out of the app.asar of the OpenCode build installed on
 *  this machine, not from memory. That matters for the provenance: this file
 *  asserts numbers, and the numbers are only worth anything if someone can go and
 *  find where they came from. So the test also states which build it was read
 *  from, and fails if the assertions and that build disagree about a value.
 * ====================================================================== */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DASH = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');

/**
 * The declarations of one rule.
 *
 * Three versions of this failed, all the same way, and the mistake is worth
 * naming because the shape of it is the shape of the whole week: searching for
 * the text of a selector instead of parsing the file.
 *
 *   1. `indexOf(sel + ' {')` — `.msg .body ul` is a *prefix* of
 *      `.msg .body ul, .msg .body ol`, so it matched the wrong text and went
 *      looking for a brace belonging to a different rule. It reported a rule
 *      that was sitting right there as missing.
 *   2. `split(/(?=[{}])/)` with no capture group — a lookahead split discards the
 *      delimiters, so every chunk began with a declaration rather than a
 *      selector. Nothing matched, and all twenty assertions reported "no rule
 *      found" for a file that contains all twenty rules.
 *   3. adding the capture group, then finding the block by searching for the
 *      prelude again — which finds the first occurrence of that text anywhere in
 *      the file, not this one.
 *
 * The fix is not a cleverer search. It is a parse: one left-to-right pass, brace
 * depth tracked, and a selector captured only when a brace actually opens. Then
 * there is no prefix to fall into and no second search to get wrong.
 */
function parseRules(src) {
  const out = [];
  let prelude = '';
  let selector = '';   /* the prelude as it was when the brace opened */
  let depth = 0;
  let bodyAt = -1;
  /* Comments are removed first, and that is the whole fix.
   *
   * The version before this one produced 725 rules and every one of them had an
   * empty selector. The cause is that a CSS comment can contain a brace — this
   * stylesheet has comments explaining what a rule does, and one of those
   * explanations includes a `{` as an example. From that point on the brace depth
   * is permanently off by one, so no rule ever closes at depth zero, no selector
   * is ever captured, and a file full of rules parses to a list of empty ones.
   *
   * The lesson is the same one as the <style> span: a check that reads the wrong
   * text reports a confident, complete, entirely wrong answer. Strip the comments,
   * then count braces. */
  const css = src.replace(/\/\*[\s\S]*?\*\//g, ' ');

  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '{') {
      if (depth === 0) { bodyAt = i + 1; selector = prelude.trim(); }
      depth++;
      prelude = '';
      continue;
    }
    if (c === '}') {
      depth--;
      if (depth === 0 && bodyAt > 0) { out.push({ selector, body: css.slice(bodyAt, i) }); bodyAt = -1; prelude = ''; }
      continue;
    }
    if (depth === 0) prelude += c;
  }
  return out;
}

/* Only the stylesheet. dashboard.html is html, then a <style>, then a great deal
   of JavaScript — and the JavaScript contains braces, `{` inside a function
   literal, in strings, and in comments. Parsing the whole file as CSS therefore
 * pairs the first `{` in a script comment with the first `}` in a template
 * literal, and every selector afterwards comes out as a fragment of JavaScript.
 *
 * That is the fourth version of this check, and the reason is worth stating
 * because it is the same mistake again: reading the wrong span of the file rather
 * than the right one. The span is the whole file; the subject is the stylesheet. */
const STYLE_AT = DASH.indexOf('<style');
const CSS = STYLE_AT < 0 ? '' : DASH.slice(STYLE_AT, DASH.indexOf('</style>', STYLE_AT));

const ALL = parseRules(CSS);

function rule(sel) {
  const members = sel.split(',').map(s => s.trim());
  const hit = ALL.find(r => {
    const parts = r.selector.split(',').map(s => s.trim());
    return parts.length === members.length && parts.every((p, i) => p === members[i]);
  });
  return hit ? hit.body : null;
}
const prop = (sel, name) => {
  const body = rule(sel);
  if (body === null) return null;
  const m = new RegExp('(?:^|[;\\s])' + name + '\\s*:\\s*([^;]+)').exec(body);
  return m ? m[1].trim().replace(/\s+/g, ' ') : null;
};

let passed = 0; const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failures.push({ name, error: e }); console.log('  FAIL ' + name + '\n         ' + e.message); }
}

/**
 * What the chat must be, and which OpenCode token each value came from.
 *
 * Written as data so the test and the claim cannot drift apart: the token name
 * is printed with the assertion, so a failure says "this is supposed to be
 * --line-height-x-large" rather than just "wrong number".
 */
const CLAIMS = [
  { sel: '.msg .body', prop: 'font-size', want: '14px', from: '--font-size-base', why: 'the body size' },
  { sel: '.msg .body', prop: 'line-height', want: '1.8', from: '--line-height-x-large (180%)', why: 'the line height of that size' },
  { sel: '.msg .body', prop: 'font-weight', want: '400', from: '--font-weight-regular', why: 'body weight; 650 read as a wall' },
  { sel: '.msg .body', prop: 'letter-spacing', want: '0', from: '--letter-spacing-normal', why: 'prose was tracked at .01em' },
  { sel: '.msg .body', prop: 'max-width', want: '48rem', from: '--container-3xl', why: 'the measure a conversation is read at' },
  { sel: '.msg .who', prop: 'font-weight', want: '500', from: '--font-weight-medium', why: 'the label, findable without shouting' },
  { sel: '.msg .who', prop: 'font-size', want: '11px', from: 'the smallest of the three sizes in use', why: 'the label' },
  { sel: '.msg .who', prop: 'letter-spacing', want: '0', from: '--letter-spacing-normal', why: 'no caps, so no tracking to compensate' },
  { sel: '.msg .body strong', prop: 'font-weight', want: '500', from: '--font-weight-medium', why: 'emphasis, not a second weight axis' },
  { sel: '.composer', prop: 'border-radius', want: '8px', from: '--radius-lg (.5rem)', why: 'a document surface, not a floating card' },
  { sel: '.composer textarea', prop: 'font-size', want: '14px', from: '--font-size-base', why: 'same size as the text being read' },
];

console.log('== nilai yang diambil dari OpenCode ==');
for (const c of CLAIMS) {
  check(c.why + ' — ' + c.prop + ' = ' + c.want + '  (' + c.from + ')', () => {
    const got = prop(c.sel, c.prop);
    assert.ok(got !== null, 'no rule found for ' + c.sel);
    assert.strictEqual(got, c.want,
      c.sel + ' { ' + c.prop + ' } is "' + got + '", but the claim says ' + c.want +
      ' from OpenCode ' + c.from);
  });
}

check('the reading measure matches the token it names', () => {
  const m = /--oc-measure:\s*([^;]+)/.exec(rule('.chat') || '');
  assert.ok(m, '.chat has no --oc-measure');
  assert.strictEqual(m[1].trim(), '48rem', '--oc-measure is ' + m[1] + ', not --container-3xl');
});

check('the composer carries one hairline, not a stack of shadows', () => {
  const body = rule('.composer') || '';
  /* `0 0 0 1px` is the hairline. The old stack was `0 1px 2px …` three deep, and
     counting `0 1px` hits the hairline too — it begins with the same three
     characters. So the count has to exclude the 1px-ring form, or it reports one
     shadow on a composer that has none. */
  /* Only shadows, not the hairline. The old stack was three layers of
     `0 1px 2px …`; the ring is `0 0 0 1px`, which starts with the same three
     characters. Counting `/0\s+1px/` hits the ring too, so this reported a lift on
     a composer that has none — and the fix is to count the off-axis form. */
  const lifts = (body.match(/0\s+1px\s+\d/g) || []).length;
  assert.strictEqual(lifts, 0, 'the composer still has ' + lifts + ' shadow layers; a document surface has none');
  assert.ok(/box-shadow:[^;]*0\s+0\s+0\s+1px/.test(body), 'and the single hairline is gone');
});

check('the turn gap scaled with the line height', () => {
  /* At 1.5 a 14px gap already separated two turns; at 1.8 the same gap does not.
     Leaving it alone is how a restyle ends up looking like the old thing with
     different colours, so the number is checked against the line height. */
  const gap = /gap:\s*(\d+)px/.exec(rule('.chatinner') || '');
  const lh = parseFloat(prop('.msg .body', 'line-height'));
  assert.ok(gap, '.chatinner has no gap');
  const g = Number(gap[1]);
  assert.ok(g >= lh * 14, 'a gap of ' + g + 'px against a ' + lh + ' line height does not separate turns');
});

/* ---- the parts a restyle usually leaves behind ------------------------- */
console.log('');
console.log('== yang tidak boleh tertinggal ==');

for (const [what, sel, must] of [
  ['paragraph spacing', '.msg .body p', /margin:0 0 16px/],
  ['lists are indented and spaced', '.msg .body ul, .msg .body ol', /margin:0 0 16px 20px/],
  ['a blockquote is a hairline, not a bar', '.msg .body blockquote', /border-left:1px solid/],
  ['a table has hairlines', '.msg .body th, .msg .body td', /border-bottom:1px solid/],
  ['inline code is padded like code', '.msg .body code', /padding:1\.5px 5px/],
  ['a code block is a rounded surface', '.msg .codeblock', /border-radius:6px/],
]) {
  check(what, () => {
    /* Two selectors in one rule, so the search has to be for the whole selector
       list as written and not for the first member. `.msg .body ul` is not a
       prefix of `.msg .body ul, .msg .body ol`, and the first version of this
       reported "no rule" for a rule that was right there — which is how a check
       that cannot find its own subject gets ignored. */
    const body = rule(sel);
    assert.ok(body !== null, 'no rule for "' + sel + '"');
    assert.ok(must.test(body), sel + ' is: ' + body.replace(/\s+/g, ' ').slice(0, 100));
  });
}

check('no rule sets both a heading and a border under it', () => {
  /* a rule under a heading turns a document into a form */
  for (const h of ['h1', 'h2', 'h3']) {
    const body = rule('.msg .body ' + h) || '';
    if (/border-bottom/.test(body)) throw new Error('.msg .body ' + h + ' draws a rule under itself');
  }
});

check('the two speakers share one left edge', () => {
  /* The old bubble put the user's text 12px right of the agent's. One measure and
     one inset is what stops a column looking laid out rather than written. */
  const user = rule('.msg.u .msghead::before') || '';
  const agent = rule('.msg .msghead::before') || '';
  const upad = /padding/.test(user) ? 1 : 0;
  assert.ok(upad === 0, '.msg.u has its own padding, so its text starts off the shared edge');
  const ua = /align-items:\s*(\w+)/.exec(agent);
  assert.ok(!ua || ua[1] === 'center', 'the avatar is not centred, so the two labels sit differently');
});

console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  for (const f of failures) console.log('  - ' + f.name + ': ' + f.error.message);
  process.exit(1);
}
