'use strict';
/* ====================================================================== *
 *  test/readme.test.js — the README's claims, checked against the code.
 *
 *  Run: node test/readme.test.js
 *
 *  The README is the first file a person reads, and it has been wrong three times
 *  in a row. Every one of the three was a claim nobody tested:
 *
 *    1. `git clone <url> browser-automation` — a directory git would not create
 *    2. a rename check that called it clean while the screen still showed the old
 *       name, because it read a label instead of the pixels
 *    3. `systemctl --user status o-agent.service` — a unit the installer never
 *       created. It made octop-browser-automation.service, so the one command in
 *       the README that a Linux user runs first was guaranteed to fail.
 *
 *  A README that has drifted is worse than one that is missing, because it is a
 *  promise the code does not keep and the first thing anybody tries. So every
 *  sentence that can be checked is checked here, and the answers are printed
 *  whether they pass or not.
 * ====================================================================== */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const has = (f, re) => re.test(read(f));

let passed = 0; const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failures.push({ name, error: e }); console.log('  FAIL ' + name + '\n         ' + e.message); }
}

const R = read('README.md');
const pkg = JSON.parse(read('package.json'));
const install = read('scripts/install-ubuntu.sh');
const grab = re => { const m = re.exec(R); return m ? m[1] : null; };
const fail = m => { throw new Error(m); };

/* ---- identity ---- */
check('the title is the product name', () => {
  if (!/^# O Agent$/m.test(R)) fail('the first line is: ' + R.split(/\r?\n/)[0]);
});

check('the old product name is nowhere in it, in any capitalisation', () => {
  const line = R.split(/\r?\n/).find(l => /browser[- ]automation/i.test(l));
  if (line) fail('still there: ' + line.slice(0, 90));
});

check('the clone directory matches the repository name', () => {
  if (!/git clone <repository-url> O-Agent-Engine\r?\ncd O-Agent-Engine/.test(R)) {
    fail('git clone names the directory after the repository, so a mismatch here is a broken first command:\n         ' +
      R.split(/\r?\n/).slice(8, 12).join('\n         '));
  }
});

/* ---- "no framework and no dependencies" ---- */
check('there really are no dependencies', () => {
  const d = Object.keys(pkg.dependencies || {}).length;
  const dev = Object.keys(pkg.devDependencies || {}).length;
  if (d || dev) fail('deps=' + JSON.stringify(pkg.dependencies) + ' dev=' + JSON.stringify(pkg.devDependencies));
});

check('and no suite requires a test framework', () => {
  /* an earlier version of this check grepped for /mocha|jest|tap|ava/ and failed
     on the word "available". The thing to look for is a require, not a substring
     that happens to occur in prose. */
  const bad = fs.readdirSync(path.join(ROOT, 'test')).filter(f => {
    const s = read('test/' + f);
    return /require\(\s*['"](mocha|jest|tap|ava|@jest|node-tap)['"]\s*\)/.test(s);
  });
  if (bad.length) fail('these require a framework: ' + bad.join(', '));
});

check('`npm test` is the runner it names', () => {
  if (!pkg.scripts || pkg.scripts.test !== 'node test/run-all.js') fail('test: ' + (pkg.scripts && pkg.scripts.test));
});

/* ---- "each suite is a plain Node script that prints its own result" ---- */
const suites = fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.test.js'));

check('every suite prints a count the runner can read', () => {
  const quiet = suites.filter(f => !/passed/.test(read('test/' + f)));
  if (quiet.length) fail('no "passed" in: ' + quiet.join(', '));
});

check('every suite exits non-zero on failure', () => {
  const quiet = suites.filter(f => !/process\.exit\(/.test(read('test/' + f)));
  if (quiet.length) fail('never exit: ' + quiet.join(', '));
});

check('the single suite it tells you to run by name exists', () => {
  const named = grab(/node (test\/[\w.-]+\.test\.js)/);
  if (!named) fail('the README names no single suite to run');
  if (!fs.existsSync(path.join(ROOT, named))) fail('it tells you to run ' + named + ', which is not there');
});

/* ---- "they run one at a time, because two of them bind a port" ---- */
check('the number of port-binding suites is the number it quotes', () => {
  /* Binding a port is not the same as talking to one. A suite that needs the
     product already running does not bind anything, and counting it as if it did
     would make this fail for the wrong reason.
     *
     * This file has to exclude itself. It contains the very pattern it is looking
     * for, so a plain count finds three port binders when there are two, and the
     * first run of this check failed on its own source. A guard that counts its
     * own detector is not measuring the thing it claims to measure. */
  const binders = suites.filter(f => f !== path.basename(__filename) && /createServer|\.listen\(/.test(read('test/' + f)));
  console.log('         yang buka server: ' + binders.join(', '));
  console.log('         yang hanyaClient: ' + suites.filter(f => /127\.0\.0\.1:8787/.test(read('test/' + f))).join(', '));
  /* The number is 3 rather than 2 because runtimes.test.js was added: it needs a
   * real socket, because a stubbed adapter cannot produce the one thing this
   * whole layer is about — a runtime that answers 401, or 404, or not at all.
   *
   * Worth being precise about what the count does and does not mean. Every one
   * of these calls listen(0), which asks the OS for a free port, so none of them
   * can collide with another suite or with the product on 8787. This check
   * therefore counts suites that OPEN a server, not suites that contend for one,
   * and the README now says the same thing rather than implying a port fight
   * that does not happen. A suite that bound a fixed port would be a real
   * problem, and the count above would not be the thing to catch it. */
  assert.strictEqual(binders.length, 3, 'the README says three; the code has ' + binders.length + ': ' + binders.join(', '));
});

check('the runner agrees with the README about that', () => {
  if (!/two of these bind a port/.test(read('test/run-all.js'))) fail('run-all.js no longer says the same thing');
});

/* ---- the systemd unit, which the README got wrong ---- */
check('the unit it names is the unit the installer creates', () => {
  const svc = grab(/systemctl --user status ([\w.-]+\.service)/);
  if (!svc) fail('the README names no unit');
  const made = /SERVICE_NAME="([^"]+)"/.exec(install);
  if (!made) fail('the installer has no SERVICE_NAME, so the README cannot be checked against it');
  assert.strictEqual(made[1], svc, 'README: ' + svc + '   installer: ' + made[1]);
  if (install.includes('SERVICE_FILE="$SERVICE_DIR/octop-browser-automation.service"')) {
    fail('the unit is still written under the old name');
  }
});

check('the unit is enabled under the name it is written under', () => {
  if (!/systemctl --user enable --now "\$SERVICE_NAME"/.test(install)) {
    fail('the enable line does not use $SERVICE_NAME, so the two can drift apart again');
  }
});

check('the retired unit is stopped and removed before the new one is enabled', () => {
  /* Without this, an already-installed machine keeps the old unit enabled and the
     two both want port 8787: one binds, one restart-loops on EADDRINUSE. A
     rename that leaves the old name installed is a rename that breaks upgrades. */
  if (!/disable --now "\$OLD_SERVICE_NAME"/.test(install)) fail('the old unit is never disabled');
  if (!/rm -f "\$OLD_SERVICE_FILE"/.test(install)) fail('the old unit file is never removed');
  const retire = install.indexOf('disable --now "$OLD_SERVICE_NAME"');
  const enable = install.indexOf('enable --now "$SERVICE_NAME"');
  if (retire > enable) fail('the old unit is retired after the new one is enabled, so they overlap');
});

check('the installer prints the product name, not the old one', () => {
  const line = install.split(/\r?\n/).find(l => /Octop/.test(l));
  if (line) fail('still says: ' + line.trim().slice(0, 80));
  if (!/Description=O Agent/.test(install)) {
    fail('the unit description is: ' + (/Description=(.*)/.exec(install) || [])[1] +
      ' — systemctl status shows this to whoever installed it');
  }
});

check('the installer is valid bash', () => {
  /* A syntax error here would only be found by somebody running the installer on
     Ubuntu, which is the one thing no CI in this repo does. So it is checked —
     and when bash is not on the machine the check says it did not run rather than
     quietly passing. */
  try {
    execFileSync('bash', ['-n', path.join(ROOT, 'scripts/install-ubuntu.sh')], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (e.code === 'ENOENT') { console.log('         (bash tidak ada di mesin ini — cek ini tidak dijalankan)'); return; }
    const said = String(e.stderr || '').split(/\r?\n/).find(l => l.trim());
    fail('bash -n said: ' + (said || e.message));
  }
});

/* ---- the run commands ---- */
check('the one-off run commands it gives are real', () => {
  if (!fs.existsSync(path.join(ROOT, 'scripts/get-browser.js'))) fail('scripts/get-browser.js is not there');
  if (!/get-browser\.js/.test(install)) fail('the installer does not call it either');
  if (pkg.scripts.start !== 'node server.js') fail('start script is: ' + pkg.scripts.start);
  if (!/node server\.js/.test(R)) fail('the README does not mention node server.js');
});

check('the pinned runtime really does land in `.browser/`', () => {
  const g = read('scripts/get-browser.js');
  if (!/\.browser/.test(g)) fail('get-browser.js never mentions .browser/');
  if (!/Chrome for Testing|chrome-for-testing|forTesting/i.test(g)) fail('and nothing about a pinned channel');
});

check('the port the README tells you to open is the port the server uses', () => {
  if (!/127\.0\.0\.1:8787/.test(R)) fail('the README does not name the port');
  if (!/PORT=8787/.test(install)) fail('the unit does not set PORT=8787');
  if (!/8787/.test(read('server.js'))) fail('server.js does not mention 8787');
});

/* ---- the numbers it quotes ---- */
check('AI_RETRY_DELAYS_MS is quoted as the code sets it', () => {
  const def = (/if \(!raw\) return (\[[^\]]+\])/.exec(read('ai/engine.js')) || [])[1];
  if (!def) fail('the default is not a literal any more, so it cannot be compared by reading');
  const quoted = /1000,3000,8000/.test(R.replace(/\s/g, ''));
  assert.ok(quoted, 'the README does not quote 1000,3000,8000');
  assert.strictEqual(def.replace(/\s/g, ''), '[1000,3000,8000]', 'engine.js says ' + def);
  if (!/AI_RETRY_DELAYS_MS/.test(read('ai/engine.js'))) fail('the env var the README names is not read');
});

check('AI_CONTEXT_CHARS is quoted as the code sets it', () => {
  const m = /CONTEXT_BUDGET_CHARS\s*=\s*Number\(process\.env\.AI_CONTEXT_CHARS\)\s*\|\|\s*(\d+)/.exec(read('ai/engine.js'));
  if (!m) fail('the default is not a literal in ai/engine.js any more');
  assert.ok(R.includes(m[1]), 'the README quotes a different number from the code default ' + m[1]);
  /* "roughly 30k tokens" — at four characters a token, which is the usual rule
     of thumb, so a wrong order of magnitude here would be a wrong claim */
  const tokens = Number(m[1]) / 4;
  assert.ok(Math.abs(tokens - 30000) < 5000, m[1] + ' chars is about ' + Math.round(tokens) + ' tokens, not 30k');
});

/* ---- the rules section ---- */
for (const t of ['rule_edit', 'rule_create']) {
  check('`' + t + '` is a real tool name', () => {
    if (!new RegExp('[\'"]' + t + '[\'"]').test(read('ai/tools.js'))) fail('ai/tools.js has no tool called ' + t);
  });
}
check('the things the rules section names all exist', () => {
  if (!has('ai/skills.js', /resolve/)) fail('skills.resolve() is not there');
  if (!has('server.js', /capsOff/)) fail('/api/rules does not report capsOff');
  if (!has('ai/skills.js', /rules/) || !has('ai/store.js', /rules/)) fail('there is no rules capability');
  if (!/truncated/.test(R)) fail('the README does not mention truncation');
  if (!has('ai/engine.js', /truncated/)) fail('but the code does not use the word either');
});

check('the suite it credits exists, under the name it credits', () => {
  /* the README writes it in backticks, so there is a ` between the file name and
     the word "covers" — the first pattern for this forgot that and reported that
     the README credits nothing, which is a different sentence */
  const named = grab(/test\/([\w.-]+\.test\.js)`?\s+covers/);
  if (!named) fail('the README credits no suite');
  if (!fs.existsSync(path.join(ROOT, 'test', named))) fail('it credits test/' + named + ', which is not there');
});

console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  for (const f of failures) console.log('  - ' + f.name + ': ' + f.error.message);
  process.exit(1);
}
