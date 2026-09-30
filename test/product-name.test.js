'use strict';
/* ====================================================================== *
 *  test/product-name.test.js — where the old product name may appear, and why.
 *
 *  Run: node test/product-name.test.js
 *
 *  Three renames went past this repository and each got through because the check
 *  was a blocklist. A blocklist can only say "this file must not mention it", never
 *  "this mention is fine because it is a key" — so every legitimate one looks like
 *  a miss, and the first person who hits that either switches the check off or
 *  adds an exception without reading it.
 *
 *    - 122 lines contained the old name or the old phrase. Nine were a name. The
 *      other 113 were keys, and nobody had written down which was which.
 *    - the README's clone instructions named a directory git would not create
 *    - the chat mark spelled the old name in pixels while its aria-label said the
 *      new one, and the check read the label
 *    - ai/context.js still told a browser-capable model "You are a browser
 *      automation agent" — the same claim that had been removed from the SOUL,
 *      missed because the profile in front of us is never given that line, so
 *      the check that looked for the sentence did not see it in that file
 *
 *  So every occurrence is classified into one of four things, and a fifth is not
 *  accepted:
 *
 *    key      a boundary the other side already agreed to — a cookie, a header,
 *             an env var, a storage key, a format marker, a directory
 *    comment  prose explaining the code
 *    record   the file exists to remember the change, so it has to be able to
 *             quote what was changed
 *    test     a test has to be able to name the thing it is forbidding
 *
 *  The classification is the claim, and a claim that is never checked is the
 *  thing that keeps letting things through. So the keys are listed with the cost
 *  of renaming each, the model-facing string literals are read directly, and the
 *  surfaces a person reads are checked for anything that is not one of the four.
 * ====================================================================== */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SELF = 'test/product-name.test.js';

let passed = 0; const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failures.push({ name, error: e }); console.log('  FAIL ' + name + '\n         ' + e.message); }
}

const OLD = /Octop|octop|OTOP|browser[- ]automation|Browser Automation/;

/**
 * Keys, and what it would actually cost to rename each one.
 *
 * Every entry is a boundary something on the other side has already agreed to.
 * Renaming one does not tidy anything up: it logs people out, empties their saved
 * preferences, orphans a browser profile full of logins, or leaves an already-
 * installed machine running a unit that can no longer be found.
 */
const KEYS = [
  { re: /\boctop:[a-z][a-z-]*/i, why: 'a localStorage key; renaming it resets every preference the person has already saved in this browser' },
  { re: /['"]octop:['"]/, why: 'the namespace prefix those storage keys share, written on its own so the stored-data list can find every key the app owns; renaming it on its own would hide every key at once and the list would claim nothing is stored while all of it still is' },
  { re: /COOKIE_NAME\s*=\s*['"]octop['"]/i, why: 'the name of the login cookie; renaming it logs out every browser that has one' },
  { re: /x-octop-token/i, why: 'the auth header; renaming it makes every client send a header the server no longer accepts' },
  { re: /['"]octop=/i, why: 'the login cookie as a client sends it; the server still reads that name' },
  { re: /\bOCTOP_[A-Z_]+/i, why: 'an environment variable the code reads; renaming it ignores the value whoever already exported' },
  { re: /octop-agent-profile/i, why: 'the marker on an exported profile bundle; a bundle exported before the rename can no longer be imported' },
  { re: /octop-automation['"]/i, why: 'the MCP client identifier sent to the server; a server that checks it would refuse a client that changed it' },
  { re: /octop-browser-automation/i, why: 'the browser manifest format on disk, and the old unit name; without it the installer cannot find the unit an already-installed machine is still running' },
  { re: /\.octop-browser-profile/i, why: 'the Chrome profile directory; it holds every login the person has in that browser' },
  { re: /octop-shellrc-/i, why: 'a temp file name; a shell session open right now still holds the old one open, and the new name would orphan it' },
  { re: /octop\/dashboard\//i, why: 'a source path in a comment; where the design tokens were copied from is a fact, and a renamed path points at nothing' },
];

/** files that exist to remember this change, so they must be able to quote it */
const RECORDS = {
  'ARCHITECTURE.md': 'this file is the record of the rename and of what was deliberately not renamed',
  'README.md': 'only for a line that documents the old name; a name claim is still refused below',
};

/** a test has to be able to name the thing it is forbidding */
const isTest = f => f.startsWith('test/');

/** surfaces a person or a model reads. A key or a comment is fine. A name is not. */
const RENDERED = {
  'README.md': 'the first file anyone reads',
  'package.json': 'what npm shows, and the package identity on the registry',
  'dashboard.html': 'the whole interface, including every string the browser draws',
  'scripts/install-ubuntu.sh': 'the installer prints to a terminal and writes a unit systemd displays',
  'ai/agentfiles.js': 'the identity file, read into the context on every run',
  'ai/context.js': 'the runtime context, read into the context on every run',
  'server.js': 'serves every one of those surfaces',
};

/**
 * Strip comments line by line, keeping the line numbers, so that a line which
 * merely *talks about* the old name is not mistaken for one that ships it.
 *
 * Block comments are tracked rather than stripped blindly, because the sentences
 * that matter here live inside them — the comment in ai/agentfiles.js that quotes
 * the sentence that was removed is a five-line HTML-comment block whose middle
 * lines start with no marker at all. A line-based test called that code, and then
 * reported a documentation file as though it were shipping the old name.
 *
 * Returns one entry per input line: the part of it that is not a comment.
 */
function stripComments(src, file) {
  const out = [];
  /* which block comment we are inside, if any: "slash" for a C-style one,
     "html" for an HTML one. Written without a sample of either in this comment,
     because the obvious way to spell "slash" here contains the two characters
     that end the comment, and this file then failed to parse. */
  let block = null;
  src.split(/\r?\n/).forEach(line => {
    let kept = '';
    let i = 0;
    let inStr = null;
    while (i < line.length) {
      if (block) {
        const end = block === 'html' ? '-->' : '*/';
        const at = line.indexOf(end, i);
        if (at < 0) { i = line.length; break; }
        block = null; i = at + end.length; continue;
      }
      const two = line.slice(i, i + 2);
      if (!inStr && two === '/*') { block = 'slash'; i += 2; continue; }
      if (!inStr && line.slice(i, i + 4) === '<!--') { block = 'html'; i += 4; continue; }
      const c = line[i];
      if (inStr) { kept += c; if (c === inStr) inStr = null; i++; continue; }
      if (c === "'" || c === '"' || c === '`') { inStr = c; kept += c; i++; continue; }
      if (c === '#' && /\.(sh|ya?ml)$/.test(file) && kept.trim() === '') { i = line.length; break; }
      if (two === '//') { i = line.length; break; }
      kept += c; i++;
    }
    out.push(kept);
  });
  return out;
}

/** every occurrence in the repository, with each line's code part marked */
function occurrences() {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean)
    /* the browser runtime manifest is written by the installer and is not in git,
       but it is on this machine, and it is one of the files the old name is
       allowed in — so it is read too */
    .concat(['.browser/browser.json'])
    .filter(f => /\.(js|html|json|md|sh|css)$/.test(f) || f === '.browser/browser.json')
    .filter(f => fs.existsSync(path.join(ROOT, f)));

  const found = [];
  for (const f of tracked) {
    const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/);
    const code = stripComments(lines.join('\n'), f);
    lines.forEach((text, i) => {
      if (!OLD.test(text)) return;
      /* the line ships the old name only if the same line has it outside a
         comment; a line that is entirely inside one does not */
      found.push({ file: f, n: i + 1, text, inCode: OLD.test(code[i] || '') });
    });
  }
  return found;
}

const found = occurrences().filter(o => o.file !== SELF);

/* ------------------------------------------------------------------ *
 *  the classification
 * ------------------------------------------------------------------ */
const buckets = { key: [], comment: [], record: [], test: [], unexplained: [] };
for (const o of found) {
  const k = KEYS.find(k => k.re.test(o.text));
  if (k) { buckets.key.push(Object.assign({ because: k.why }, o)); continue; }
  if (isTest(o.file)) { buckets.test.push(o); continue; }
  if (!o.inCode) { buckets.comment.push(o); continue; }
  if (RECORDS[o.file]) { buckets.record.push(o); continue; }
  buckets.unexplained.push(o);
}

console.log('== klasifikasi ==');
console.log('  kunci / marker / path : ' + String(buckets.key.length).padStart(3));
console.log('  komentar              : ' + String(buckets.comment.length).padStart(3));
console.log('  record                : ' + String(buckets.record.length).padStart(3));
console.log('  test                  : ' + String(buckets.test.length).padStart(3));
console.log('  TIDAK TERKLASIFIKASI  : ' + String(buckets.unexplained.length).padStart(3));
console.log('');

check('every occurrence is a key, a comment, a record, or a test', () => {
  assert.strictEqual(buckets.unexplained.length, 0,
    'these carry the old name and nothing explains why, in live code:\n         ' +
    buckets.unexplained.map(o => o.file + ':' + o.n + '  ' + o.text.trim().slice(0, 100)).join('\n         '));
});

check('a file listed as a record is documentation, and says so', () => {
  for (const [f, why] of Object.entries(RECORDS)) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), f + ' is on the record list and does not exist');
    assert.ok(why.length > 30, f + ' has no stated reason on the record list');
  }
  assert.ok(buckets.record.every(o => RECORDS[o.file]),
    'a record allowance is being used by a file that is not on the list');
});

/* ------------------------------------------------------------------ *
 *  1. nothing a person reads may contain it as anything but a key or prose
 * ------------------------------------------------------------------ */
check('no surface a person reads ships the old name', () => {
  const bad = [];
  for (const f of Object.keys(RENDERED)) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) { bad.push(f + ' (tidak ada)'); continue; }
    for (const o of found.filter(x => x.file === f)) {
      if (KEYS.some(k => k.re.test(o.text))) continue;   /* a key is not read */
      if (!o.inCode) continue;                            /* prose is not shipped */
      if (f === 'README.md' && buckets.record.includes(o)) continue;
      bad.push(f + ':' + o.n + '  ' + o.text.trim().slice(0, 90));
    }
  }
  assert.strictEqual(bad.length, 0, bad.join('\n         '));
});

/* ------------------------------------------------------------------ *
 *  2. what the model is given, read as literals rather than as a file
 * ------------------------------------------------------------------ */
check('nothing sent to the model claims what the agent is', () => {
  const agentfiles = fs.readFileSync(path.join(ROOT, 'ai/agentfiles.js'), 'utf8');
  const soul = agentfiles.slice(agentfiles.indexOf('const DEFAULT_SOUL'), agentfiles.indexOf('const DEFAULT_MEMORY'));
  const shipped = soul.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!OLD.test(shipped), 'the default identity still says it:\n         ' + shipped.trim().slice(0, 200));

  const ctx = fs.readFileSync(path.join(ROOT, 'ai/context.js'), 'utf8');
  /* Every string literal in this file is either model input or a section title, so
     every one of them is checked — not the one in coreLines, and not the file.
     The first version read only the literals inside coreLines and found two of
     them, which is fewer than it expected, so it demanded three and failed; and
     before that it read the raw text and matched straight through a comment
     containing an apostrophe, and reported the comment as model input. Comments
     are stripped first, and CORE and BROWSER_CORE are included, because those are
     the lines the model reads on every single turn. */
  const literals = [...stripComments(ctx, 'ai/context.js').join('\n').matchAll(/'([^']*)'/g)]
    .map(m => m[1])
    .filter(s => s.length > 20 && s.length < 600);
  assert.ok(literals.length >= 20, 'only ' + literals.length + ' literals found — the check would pass on a file it cannot read');
  for (const l of literals) {
    assert.ok(!OLD.test(l), 'a line sent to the model still says it: ' + JSON.stringify(l));
    /* the narrower claim: not "You are a browser", "You are an automation…".
       A blanket ban on "You are" was tried and is wrong — CORE opens with "You
       are an agent on this machine with a set of tools", which is a fact about
       the process and the one line that tells it to choose. */
    assert.ok(!/\byou are (a|an) [^.]*\b(browser|automation|chrome|cdp)\b/i.test(l),
      'a line sent to the model says what it is: ' + JSON.stringify(l));
  }
  /* and it must still say the true thing, or a browser-capable profile is told
     nothing about what it can reach */
  assert.ok(/Chrome browser on this machine/.test(ctx),
    'the browser capability line is gone — a profile that can open tabs is now told nothing');
});

/* ------------------------------------------------------------------ *
 *  3. the keys, and the cost of touching one
 * ------------------------------------------------------------------ */
check('the keys are still keys, in the places that read them', () => {
  const dash = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
  const keys = new Set(dash.match(/octop:[a-z][a-z-]*/gi) || []);
  assert.ok(keys.size >= 25, 'only ' + keys.size + ' storage keys found — a rename may already have happened');
  for (const k of ['octop:preview-theme', 'octop:preview-palette', 'octop:ai-sessions']) {
    assert.ok(keys.has(k), 'the storage key ' + k + ' is gone — every saved preference resets');
  }
  assert.ok(/COOKIE_NAME\s*=\s*['"]octop['"]/i.test(fs.readFileSync(path.join(ROOT, 'access.js'), 'utf8')),
    'the login cookie name moved — everyone is logged out');
  assert.ok(/\.octop-browser-profile/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')),
    'the Chrome profile directory moved — the browser starts empty');
  assert.ok(/format:\s*'octop-browser-automation'/.test(fs.readFileSync(path.join(ROOT, 'scripts/get-browser.js'), 'utf8')),
    'the browser manifest format marker moved — the installed manifest no longer matches what the installer writes');
});

check('the installer can still retire the unit it used to be called', () => {
  const s = fs.readFileSync(path.join(ROOT, 'scripts/install-ubuntu.sh'), 'utf8');
  assert.ok(/OLD_SERVICE_NAME="octop-browser-automation\.service"/.test(s),
    'the installer no longer knows the old unit name, so it cannot retire it, and two units end up fighting for port 8787');
  assert.ok(/SERVICE_NAME="o-agent\.service"/.test(s), 'the new unit name is missing');
  assert.ok(s.indexOf('disable --now "$OLD_SERVICE_NAME"') < s.indexOf('enable --now "$SERVICE_NAME"'),
    'the old unit is retired after the new one is enabled, so they overlap');
});

check('every key allowance states what it would cost, in a sentence', () => {
  for (const k of KEYS) {
    assert.ok(k.why.length > 45, 'this allowance is too short to be a cost: ' + k.re + ' — ' + k.why);
    assert.ok(/;|—/.test(k.why), 'this allowance is not a sentence with a consequence:\n         ' + k.why);
  }
});

/* ------------------------------------------------------------------ *
 *  4. and the new name is the one that is shown
 * ------------------------------------------------------------------ */
check('the product name is the one a person is shown', () => {
  const dash = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.name, 'o-agent', 'package name: ' + pkg.name);
  assert.ok(/^# O Agent$/m.test(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')), 'the README title');
  assert.ok(/<title>O Agent<\/title>/.test(dash), 'the tab title');
  assert.ok(/<body data-brand="O Agent">/.test(dash), 'the body brand');
  assert.ok(/aria-label="O Agent conversation"/.test(dash), 'the chat region label');
  assert.ok(/who === "u" \? "You" : "O Agent"/.test(dash), 'the speaker label on message bubbles');
  assert.ok(/label: kind === "error" \? "Error" : "O Agent"/.test(dash), 'the speaker label on notes');
  assert.ok(/<input id="agName" placeholder="O Agent"/.test(dash), 'the suggested name for a new agent');
  assert.ok(/service: 'o-agent'/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')),
    '/api/health does not answer with the product name');
  assert.ok(!/octopOrigin/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')),
    'the internal origin property still carries the old name');
});

check('the label that grew by two characters cannot be truncated', () => {
  const dash = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
  const who = (/\.msg \.who \{([^}]*)\}/.exec(dash) || [])[1] || '';
  const time = (/\.msg \.time \{([^}]*)\}/.exec(dash) || [])[1] || '';
  assert.ok(!/max-width|text-overflow|overflow:\s*hidden/.test(who), '.who can truncate: ' + who);
  assert.ok(/margin-left:\s*auto/.test(time), '.time is not pushed right, so a longer label wraps: ' + time);
});

console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  for (const f of failures) console.log('  - ' + f.name + ': ' + f.error.message);
  process.exit(1);
}
