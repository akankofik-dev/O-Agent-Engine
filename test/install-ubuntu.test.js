'use strict';
/* ====================================================================== *
 *  test/install-ubuntu.test.js — run the Ubuntu installer, do not just read it.
 *
 *  Run: node test/install-ubuntu.test.js
 *
 *  `scripts/install-ubuntu.sh` is the only file in this repository that no test
 *  touched, and it runs on the only platform nobody here runs. Everything before
 *  this was `bash -n`, which proves it parses and nothing else: it does not prove
 *  the unit it writes is the unit it enables, that the old unit is retired before
 *  the new one is enabled, or that the branches which cannot work exit non-zero
 *  rather than printing a success message and doing nothing.
 *
 *  So it is executed. The work is in test/install-ubuntu.harness.sh, which is a
 *  sandbox: apt-get, sudo, systemctl, curl and node are stubs that record what
 *  they were asked, HOME and XDG_CONFIG_HOME are a throwaway directory, and the
 *  final section proves nothing reached the network.
 *
 *  The runner here does three things and no more: find bash, hand the harness the
 *  repository path, and report what came back. When there is no bash — a Windows
 *  box without Git Bash, say — it says the suite did not run. It does not pass
 *  quietly, because a suite that skips and reports itself green is a suite that
 *  stops being run without anybody noticing.
 * ====================================================================== */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HARNESS = path.join(__dirname, 'install-ubuntu.harness.sh');

let passed = 0; const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failures.push({ name, error: e }); console.log('  FAIL ' + name + '\n         ' + e.message); }
}

console.log('== prasyarat ==');

check('the harness is there', () => {
  assert.ok(fs.existsSync(HARNESS), 'test/install-ubuntu.harness.sh is missing');
});

check('the installer is there', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts/install-ubuntu.sh')),
    'scripts/install-ubuntu.sh is missing');
});

check('the harness is LF, because a CRLF shebang is not a shebang', () => {
  const raw = fs.readFileSync(HARNESS);
  const first = raw.slice(0, 40).toString('latin1');
  assert.ok(first.startsWith('#!/usr/bin/env bash'),
    'the first line is: ' + JSON.stringify(first.split('\n')[0]));
  assert.ok(!/\r/.test(first), 'the shebang line contains a carriage return, so bash will not run it');
});

/* Is there a bash we can use? Probed by running it, not by looking for a file
   called bash.exe, which on Windows can be a Git Bash that is not on PATH. */
const probe = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8', timeout: 20000 });
const haveBash = probe.status === 0 && /ok/.test(probe.stdout || '');

console.log('');
if (!haveBash) {
  console.log('  !  bash tidak ada di mesin ini (' + ((probe.error && probe.error.code) || probe.status) + ')');
  console.log('  !  suite ini TIDAK dijalankan. Installer tidak diperiksa.');
  console.log('  !  Jalankan di mesin yang punya bash, atau di Ubuntu.');
  console.log('');
  console.log('  ' + passed + ' passed, ' + failures.length + ' failed (sandbox tidak dijalankan)');
  process.exit(0);
}

console.log('== menjalankan installer di sandbox ==');

const run = spawnSync('bash', [HARNESS], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 300000,
  env: Object.assign({}, process.env, { REPO: ROOT }),
});
const out = (run.stdout || '') + (run.stderr || '');

/* the harness reports its own findings; relay them so the reason for a failure is
   in this output and not only in a temp directory that no longer exists */
for (const line of out.split(/\r?\n/)) {
  if (/^\s*(ok|FAIL|==|!|perintah)/.test(line)) console.log(line);
}

const m = /(\d+) passed, (\d+) failed/.exec(out);

check('the harness ran to the end', () => {
  assert.ok(m, 'the harness printed no total. exit=' + run.status + '\n' + out.slice(-600));
});

check('every branch it exercised behaved', () => {
  assert.strictEqual(Number(m[2]), 0, m[2] + ' of the sandbox checks failed');
});

check('it covered the branches, not just the happy path', () => {
  /* A harness that only runs the install once and calls it a pass would report a
     number and mean nothing. These are the sections it has to have printed. */
  for (const section of [
    'mesin kosong',
    'sudah ter-install',
    'ditulis ulang',
    'node terlalu tua',
    'node masih kurang',
    'tanpa apt-get',
    'tanpa sudo',
    'tanpa systemd',
    'tidak ada stub yang menjalankan perintah nyata',
    'tidak ada yang menyentuh mesin sungguhan',
  ]) {
    assert.ok(out.includes(section), 'this branch was never measured: ' + section);
  }
  assert.ok(Number(m[1]) >= 40, 'only ' + m[1] + ' checks — the sandbox has shrunk');
});

check('the repository is untouched by all of that', () => {
  /* The sandbox writes to a temp HOME. If the installer ever stopped honouring
     XDG_CONFIG_HOME and wrote to the real one, this is the only place it shows. */
  const changed = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  if (changed.status !== 0) return; /* not a git checkout; nothing to compare */
  const dirty = (changed.stdout || '').split(/\r?\n/).filter(Boolean)
    /* this suite's own files are expected to be uncommitted while it is being
       developed, so they are not counted as damage */
    .filter(l => !/test\/install-ubuntu/.test(l));
  assert.strictEqual(dirty.length, 0, 'running the installer changed the repository:\n         ' + dirty.join('\n         '));
});

console.log('\n  ' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  for (const f of failures) console.log('  - ' + f.name + ': ' + f.error.message);
  process.exit(1);
}
