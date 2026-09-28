'use strict';
/* ====================================================================== *
 *  test/run-all.js — every suite, one command, one number.
 *
 *  Run: node test/run-all.js
 *
 *  There were five suites here and no way to run them all: each had to be
 *  started by its own name, and two of them bind a port, so running them
 *  "in parallel to save time" is how you end up with a red cross that means
 *  nothing. Which is the worst property a test suite can have — a suite you
 *  cannot run is a suite that silently stops being run.
 *
 *  They run in order, one at a time, and the exit code is the answer.
 * ====================================================================== */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.test.js')).sort();

/* two of these bind a port, so they must never be in flight at the same time */
const run = file => new Promise(resolve => {
  const started = Date.now();
  const child = spawn(process.execPath, [path.join(DIR, file)], { cwd: path.join(DIR, '..') });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.on('close', code => resolve({ file, code, out, ms: Date.now() - started }));
});

/* every suite ends with "<n> passed, <n> failed" in some shape; a suite that
   prints no count is a suite whose result this runner cannot read, and saying
   so is better than reporting a total that quietly means nothing */
function counts(out) {
  const passed = [...out.matchAll(/(\d+)\s+passed/g)].reduce((a, m) => a + Number(m[1]), 0);
  const failed = [...out.matchAll(/(\d+)\s+failed/g)].reduce((a, m) => a + Number(m[1]), 0);
  return { passed, failed, readable: /passed/.test(out) };
}

(async () => {
  if (!files.length) { console.error('no suites found in test/'); process.exit(1); }

  const results = [];
  for (const file of files) results.push(await run(file));

  const unreadable = [];
  let pass = 0, fail = 0, ms = 0;

  for (const r of results) {
    const c = counts(r.out);
    const bad = r.code !== 0 || c.failed > 0;
    ms += r.ms;
    if (!c.readable) unreadable.push(r.file);
    pass += c.passed;
    fail += c.failed;
    console.log(
      '  ' + (bad ? 'FAIL' : ' ok ') + '  ' + r.file.padEnd(30)
      + (c.readable ? (c.passed + ' passed' + (c.failed ? ', ' + c.failed + ' failed' : '')).padEnd(28) : '(printed no count)'.padEnd(28))
      + (r.ms + 'ms')
    );
    if (bad) console.log(r.out.split('\n').map(l => '        ' + l).join('\n'));
  }

  console.log('\n  ' + pass + ' passed' + (fail ? ', ' + fail + ' FAILED' : '') + ' across ' + results.length + ' suites in ' + (ms / 1000).toFixed(1) + 's');
  if (unreadable.length) {
    console.log('\n  these suites printed no pass/fail count, so they are not counted above:');
    for (const f of unreadable) console.log('    ' + f);
  }
  process.exit(results.some(r => r.code !== 0) ? 1 : 0);
})();
