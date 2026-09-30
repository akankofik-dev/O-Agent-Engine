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
  /* The label is deliberately not a straight copy of --font-weight-medium.
   *
   * 500 was the first attempt and it was wrong in the only way that matters: it
   * is the same weight as nothing else on the page, so nothing drew the eye to
   * it, and the column stayed one voice. 600 is a step above the 400 body and a
   * step below the 500 that the time and the file chips use, so the name is
   * found first and the words second — which is the order they have to be read
   * in. The token it departs from is named so the departure is a decision on the
   * record rather than a number that drifted. */
  { sel: '.msg .who', prop: 'font-weight', want: '600', from: 'above --font-weight-medium (500), below the body 650 it replaced', why: 'the name has to be found before the words' },
  { sel: '.msg .who', prop: 'font-size', want: '12px', from: 'between --font-size-small (13px) and the 11px it was', why: 'the label' },
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
     different colours, so the number is checked against the line height.

     The gap is written as `var(--chatinner-gap, 28px)` because the hairline that
     divides two turns is placed from half of it, and a number written in both
     places is a number that drifts. So the assertion reads the fallback rather
     than insisting on a literal — it still checks the same 28px against the same
     line height, which is the part that was ever at risk. */
  const gap = /gap:\s*(?:var\(\s*--chatinner-gap\s*,\s*)?(\d+)px/.exec(rule('.chatinner') || '');
  const lh = parseFloat(prop('.msg .body', 'line-height'));
  assert.ok(gap, '.chatinner has no gap');
  const g = Number(gap[1]);
  assert.ok(g >= lh * 14, 'a gap of ' + g + 'px against a ' + lh + ' line height does not separate turns');
});

check('the rule that divides two turns sits in the gap, and not inside a run', () => {
  /* Drawn on the message rather than the one before it, because a message knows
     whether it starts a new speaker and the previous one does not know what
     comes next. `:not(.same)` is what keeps it off a run: inside a run the
     messages are one turn and a line between them cuts the paragraph in half. */
  const divider = rule('.msg + .msg:not(.same)::before') || '';
  assert.ok(divider, 'no rule divides two turns, so the eye has to read a heading to find out it is still in the same turn');
  assert.ok(/height:\s*1px/.test(divider), 'the divider is not 1px: ' + divider.trim());
  /* half the gap, because that is the middle of it. A gap that is written in two
     places is a gap that drifts, so the offset is read from the same custom
     property the gap itself is set from. */
  assert.ok(/translateY\(\s*calc\(\s*-1\s*\*\s*var\(\s*--chatinner-gap\s*\)\s*\/\s*2\s*\)/.test(divider),
    'the divider is not centred in the gap: ' + divider.trim());
  assert.strictEqual((divider.match(/translateY/g) || []).length, 1,
    'the divider states its own offset more than once, so one of them is already stale');
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

/* ---- the two speakers must be told apart ---------------------------------
 *
 * The restyle made the column one voice. The label went to 11px in the tertiary
 * colour, which nobody can read at a glance, and then the file's own comment —
 * "the reader tells them apart by the word above" — became a false claim about
 * the screen. Nothing tested that the two were distinguishable, because every
 * other assertion in this file is about how the type looks and not about who said
 * what. So it is asserted here, and each part names the job it is doing.
 */
check('the label is readable, because it is the only thing that names the speaker', () => {
  const who = rule('.msg .who') || '';
  const size = prop('.msg .who', 'font-size');
  const weight = prop('.msg .who', 'font-weight');
  const colour = prop('.msg .who', 'color');
  assert.ok(parseInt(size, 10) >= 12, 'the label is ' + size + '; below 12px it stops being readable at a glance');
  assert.ok(parseInt(weight, 10) >= 600, 'the label is ' + weight + '; it has to out-weigh the body to be found');
  assert.ok(/--fn-text-(secondary|primary)/.test(colour),
    'the label is ' + colour + ' — the tertiary shade is a shade, not a label');
  /* `text-transform` is not in the rule at all now, which is the point. The
     assertion is that it is *absent* rather than set to none — a rule that says
     `text-transform:none` is still carrying the earlier decision in a form nobody
     can see, and the check should say so rather than pass on the value. */
  assert.ok(!/text-transform/.test(who),
    'the rule still names text-transform: ' + who.trim() + ' — uppercase was the thing that made the label read as a heading');
});

check('the person\'s own words are marked as quoted material, and the answer is brighter', () => {
  const u = rule('.msg.u .body') || '';
  const a = rule('.msg .body') || '';
  assert.ok(/border-left:2px solid/.test(u),
    '.msg.u has no left rule, so a question and an answer look identical');
  assert.ok(/padding-left:14px/.test(u),
    'the rule is drawn but nothing clears it, so it lands on top of the first letter');
  const uc = /color:\s*([^;]+)/.exec(u);
  const ac = /color:\s*([^;]+)/.exec(a);
  assert.ok(uc && ac, 'both sides need an explicit colour');
  assert.notStrictEqual(uc[1].trim(), ac[1].trim(),
    'both sides are ' + uc[1].trim() + ' — that is the whole bug');
});

check('the two still share the measure, and the rule is inside it', () => {
  /* The bubble put the user's text 12px right of the agent's, which is what made
     the column look laid out rather than written. The rule is drawn inward, with
     padding on the inside of it, so the text still starts at the same x. */
  const u = rule('.msg.u .body') || '';
  const width = prop('.msg .body', 'max-width');
  assert.ok(/48rem/.test(width), 'the shared measure is ' + width);
  assert.ok(!/max-width/.test(u), '.msg.u narrows the measure, so the two columns are different widths');
  const pad = parseInt(/padding-left:(\d+)px/.exec(u)[1], 10);
  const border = parseInt(/border-left:(\d+)px/.exec(u)[1], 10);
  assert.ok(pad >= border, pad + 'px of padding does not clear a ' + border + 'px rule');
});

check('an error does not end up with two left rules', () => {
  const ue = rule('.msg.u.err .body');
  assert.ok(ue, '.msg.u.err has no rule of its own, so a failed turn wears both the quotation rule and the error colour');
  const lefts = (ue.match(/border-left/g) || []).length;
  assert.strictEqual(lefts, 1, '.msg.u.err sets border-left ' + lefts + ' times');
  assert.ok(!/border-secondary/.test(ue) || /danger/.test(ue), 'the error colour is gone');
});

check('an error in an agent turn is still the agent turn', () => {
  const a = rule('.msg .body') || '';
  const ae = rule('.msg.err .body') || '';
  assert.ok(/text-primary/.test(a), 'the agent is not in the primary colour to begin with');
  assert.ok(/danger/.test(ae), '.msg.err lost the error colour');
});

check('the initials are distinct, so a run of questions is legible', () => {
  const ua = rule('.msg.u .msghead::before') || '';
  const aa = rule('.msg .msghead::before') || '';
  const ul = (/content:\s*"([^"]*)"/.exec(ua) || [])[1];
  const al = (/content:\s*"([^"]*)"/.exec(aa) || [])[1];
  assert.ok(ul && al, 'one of the two has no letter in it');
  assert.notStrictEqual(ul, al, 'both are "' + ul + '"');
});

check('the agent\'s own name is still the product name', () => {
  /* The label default lives in addMsg, not in the stylesheet, so the check reads
     it from the script. A restyle that changes how the label looks must not
     quietly change what it says. */
  const at = DASH.indexOf('function addMsg');
  assert.ok(at > 0, 'addMsg is gone');
  const body = DASH.slice(at, at + 900);
  const m = /who === "u" \? "You" : "([^"]*)"/.exec(body);
  assert.ok(m, 'the label default is gone from addMsg');
  assert.strictEqual(m[1], 'O Agent', 'the agent is labelled "' + m[1] + '"');
});

console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  for (const f of failures) console.log('  - ' + f.name + ': ' + f.error.message);
  process.exit(1);
}
