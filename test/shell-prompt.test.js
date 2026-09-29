'use strict';
/* ====================================================================== *
 *  test/shell-prompt.test.js — the terminal must look like a terminal.
 *
 *  Run: node test/shell-prompt.test.js
 *
 *  These drive a real shell over the real socket, because every assertion here
 *  is about bytes on a pipe. None of it can be checked by reading the source:
 *  the bug this file exists for was a prompt whose opening marker was silently
 *  eaten on its way out of the shell, which is invisible until a person watches
 *  a working directory scroll past as if it were output.
 *
 *  So: the shell, the transport, the decoding and the transcript, end to end.
 * ====================================================================== */

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8787);
const HOST = '127.0.0.1';

/* The shell socket now needs a credential as well as the right Origin, so this
 * suite has to identify itself the way a real client would: read the token the
 * running server issued. The alternative — asking the server to skip the check
 * when it looks like a test — would be a switch that disables the boundary,
 * and a switch like that is exactly what a later change would leave switched
 * off in production. */
const TOKEN = (() => {
  try { return fs.readFileSync(path.join(__dirname, '..', 'data', 'access-token'), 'utf8').trim(); }
  catch { return ''; }
})();
if (!TOKEN) {
  console.error('\n  no data/access-token — is the server running with the new code?');
  process.exit(1);
}

/**
 * Say the server is not there, once, before any of it runs.
 *
 * This suite cannot start its own server, and the reason is not tidiness. It
 * binds the port the product is actually served on, so a suite that owned it
 * would either fail to bind or knock over the running one. It would also
 * reissue the access token the other five suites read at load — five suites
 * that all want the credential the current server issued, and a server that
 * starts a new one on every boot is exactly what makes that awkward. So: the
 * server is started by a person, once, and these suites use it.
 *
 * What was missing was not the ability to start one. It was saying so. The only
 * preflight here read data/access-token, and that file survives the server going
 * away — it is rewritten on every start, not deleted on every stop. So with the
 * server down the token check passed and the suite then produced fourteen
 * connection errors, none of which said what to do about it. One probe here
 * turns that into one sentence.
 */
function requireServer() {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: HOST, port: PORT, path: '/api/automation/engines', method: 'GET',
      headers: { 'X-Octop-Token': TOKEN, origin: 'http://' + HOST + ':' + PORT },
    }, res => { res.resume(); res.on('end', () => {
      if (res.statusCode === 200) return resolve();
      reject(new Error('the server on ' + PORT + ' answered ' + res.statusCode
        + ' — it may be running older code, or the token is stale. Restart it: npm start'));
    }); });
    req.on('error', e => reject(new Error('nothing is answering on ' + HOST + ':' + PORT
      + ' (' + e.code + '). These suites run against a server you started: npm start, then npm test')));
    req.setTimeout(4000, () => { req.destroy(); reject(new Error('the server on ' + PORT + ' did not answer in 4s')); });
    req.end();
  });
}

let passed = 0;
const failures = [];

function test(name, fn) {
  return fn()
    .then(() => { passed += 1; console.log('  ok   ' + name); })
    .catch(e => { failures.push({ name, error: e }); console.log('  FAIL ' + name + '\n         ' + e.message); });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* A websocket client, small enough to not be a dependency and real enough to
 * not be a mock: it does the handshake, masks its frames and decodes theirs. */
function connect(url) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
        Origin: 'http://' + u.host,
        'X-Octop-Token': TOKEN,
      },
    });
    req.on('upgrade', (res, socket) => {
      let buf = Buffer.alloc(0);
      const handlers = [];
      socket.on('data', d => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (buf.length < 2) return;
          const l0 = buf[1] & 127;
          let off = 2, len = l0;
          if (l0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (l0 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const payload = buf.slice(off, off + len).toString('utf8');
          buf = buf.slice(off + len);
          for (const h of handlers) h(payload);
        }
      });
      resolve({
        send(obj) {
          const data = Buffer.from(JSON.stringify(obj));
          const mask = crypto.randomBytes(4);
          const masked = Buffer.alloc(data.length);
          for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
          let head;
          if (data.length < 126) head = Buffer.from([0x81, 0x80 | data.length]);
          else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(data.length, 2); }
          socket.write(Buffer.concat([head, mask, masked]));
        },
        on(fn) { handlers.push(fn); },
        close() { socket.destroy(); },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** One shell session, with the transcript split the way the panel splits it. */
async function session() {
  const ws = await connect('ws://' + HOST + ':' + PORT + '/api/shell');
  const s = { started: null, restarted: null, text: '', prompts: [], close: () => ws.close(), ws };
  ws.on(msg => {
    let m; try { m = JSON.parse(msg); } catch { return; }
    /* A restart sends a second 'started'. Keeping the first and noting the
       second is what lets a test say the replacement arrived and is a
       different process, rather than merely that something was printed. */
    if (m.type === 'started') { if (s.started) s.restarted = m; else s.started = m; }
    if (m.type === 'stream') for (const seg of m.segs || []) {
      if (seg.p !== undefined) s.prompts.push(seg.p);
      else if (seg.o !== undefined) s.text += seg.o;
    }
  });
  /* Wait for the shell's first prompt instead of sleeping a fixed 1600ms.
   *
   * Measured on this machine: the first prompt arrives at a median of 625ms
   * when the box is quiet, and at 3.6 seconds when a few hundred leaked shells
   * are sitting on it. A fixed 1600ms is comfortable in the first case and too
   * short in the second, which is why the failure looked random: it was really
   * "how much junk is already on the machine".
   *
   * The prompt is what the opening cases assert on, so the prompt is what this
   * waits for. Note `started` is NOT a substitute: the server sends it before
   * the prompt, so breaking on it would hand the first case a session with no
   * prompt and it would fail exactly as it used to.
   *
   * The ceiling is a backstop, so a shell that genuinely never comes up still
   * fails instead of hanging the runner. */
  const readyCeiling = Date.now() + 20000;
  while (s.prompts.length < 1 && Date.now() < readyCeiling) await sleep(20);
  s.run = async (cmd, ms) => {
    const before = s.text.length;
    const promptsBefore = s.prompts.length;
    ws.send({ type: 'cmd', text: cmd });
    /* Wait for the shell to print the next prompt instead of waiting a fixed
       number of milliseconds. The prompt is the only thing here that says the
       command finished; a sleep is a guess about how long a printf takes, and
       a guess that is wrong on a busy machine turns a working shell into a red
       cross — which is how this suite came to pass on its own and fail inside
       the full run. The ceiling stays as a backstop, so a shell that genuinely
       never prompts still fails rather than hanging the runner. */
    const ceiling = Date.now() + (ms || 1200) * 4;
    while (s.prompts.length <= promptsBefore && Date.now() < ceiling) await sleep(20);
    return s.text.slice(before);
  };
  return s;
}

/* The shell writes the command back, because a real terminal does, so a run
 * comes back as the command on one line and its output on the next. Assertions
 * about what a command *printed* have to skip the line that is the command —
 * otherwise "cherry" is found in `| head -2`, and a test that cannot tell the
 * two apart will pass a broken shell and fail a working one.
 *
 * This used to cut at the first newline anywhere after the command, which looks
 * equivalent and is not. Bash echoes the characters as they are typed but does
 * not always flush the newline that ends them in the same write, so the run
 * sometimes arrives as three pieces:
 *
 *     printf '10%%\r20%%\r100%%\n'   <- the command, no newline yet
 *     100%\n                          <- the output
 *     \n                              <- the command's newline, arriving late
 *
 * Cutting at the first newline then slices inside the output and hands the
 * assertion a bare "\n" — reported as "the final state was not kept" for a
 * command that printed exactly the right thing.
 *
 * Measured, by running each of the three affected cases 200 times on its own:
 * the carriage return case 3, the emoji case 3, the backspace case 3. All six
 * captured failures are this same shape, byte for byte:
 *
 *     printf 'abc\b\b\bXYZ\n'     the command, no newline yet
 *     XYZ\n                       the output
 *     \n                          the command's newline, arriving late
 *
 * The old cut returned "\n" for every one of them. Nothing was mangled on the
 * way: the accented letters, the CJK and the emoji come back intact in all 200
 * emoji runs, which is worth saying because "accented Latin was mangled" is the
 * message that sent this looking for an encoding fault.
 *
 * Two earlier attempts to explain this as a timing problem both failed, and
 * they failed the same way: the text was never late. All three pieces arrived
 * in one message, in that order, with identical timestamps. Waiting longer, for
 * a prompt, or under load changed nothing, which is what sent the search after
 * a race that was not there.
 *
 * So the cut is made at the end of the command itself, and one line ending is
 * taken off afterwards if there is one. When the newline is in its usual place
 * this is the old behaviour; when it is late the output is already on the same
 * line and there is nothing to take off. */
function printed(run, cmd) {
  const at = run.indexOf(cmd);
  if (at < 0) return run;
  return run.slice(at + cmd.length).replace(/^\r?\n/, '');
}

/* ---------------------------------------------------------------------- *
 *  the prompt has to survive the trip out of the shell
 * ---------------------------------------------------------------------- */

const cases = [];

cases.push(['the shell reports what it is, and how it behaves', async () => {
  const s = await session();
  try {
    assert.ok(s.started, 'the shell never announced itself');
    assert.ok(/bash/i.test(s.started.shell), 'shell is ' + s.started.shell);
    assert.strictEqual(s.started.promptMark, '$', 'a POSIX shell ends a prompt with $');
    assert.strictEqual(s.started.echoesInput, true, 'bash echoes its own input');
  } finally { s.close(); }
}]);

cases.push(['a prompt arrives whole — opening marker, path, closing marker', async () => {
  const s = await session();
  try {
    // the bug: a control character at the very front of a prompt is eaten on the
    // way out, leaving a path followed by a closing marker and no opening one.
    // that is indistinguishable from output, so the panel cannot know where the
    // shell is and the path scrolls past as text.
    assert.ok(s.prompts.length >= 1, 'no prompt marker was parsed at all');
    for (const p of s.prompts) {
      assert.ok(p.length > 0, 'a prompt marker arrived empty');
      assert.ok(!/[\u0000-\u0008]/.test(p), 'a prompt carried a stray control byte: ' + JSON.stringify(p));
    }
    const last = s.prompts[s.prompts.length - 1];
    assert.ok(last.startsWith('/') || /^[A-Za-z]:[\\/]/.test(last),
      'a prompt that is not a path: ' + JSON.stringify(last));
  } finally { s.close(); }
}]);

cases.push(['the working directory follows a cd', async () => {
  const s = await session();
  try {
    const before = s.prompts[s.prompts.length - 1];
    await s.run('cd ai', 1300);
    const after = s.prompts[s.prompts.length - 1];
    assert.notStrictEqual(after, before, 'the prompt did not move when the directory did');
    assert.ok(/\/ai$/.test(after), 'the prompt did not follow cd: ' + JSON.stringify(after));
  } finally { s.close(); }
}]);

/* ---------------------------------------------------------------------- *
 *  the transcript has to be a record of what was run
 * ---------------------------------------------------------------------- */

cases.push(['a command is written down once, not twice', async () => {
  const s = await session();
  try {
    const out = await s.run('echo once-only', 1300);
    const hits = (out.match(/echo once-only/g) || []).length;
    assert.strictEqual(hits, 1, 'the command appears ' + hits + ' times in the transcript');
  } finally { s.close(); }
}]);

cases.push(['the shell does not open with a complaint', async () => {
  const s = await session();
  try {
    // bash on a pipe says it cannot set a process group and has no job control.
    // true, irrelevant, and two lines at the top of every transcript.
    assert.ok(!/cannot set terminal process group/.test(s.text), 'the process-group complaint leaked through');
    assert.ok(!/no job control/.test(s.text), 'the job-control complaint leaked through');
    // and the prefix goes with the message: stripping one and not the other
    // leaves `bash: bash: ` behind, which reads like bash failing to start
    assert.ok(!/bash: bash:/.test(s.text), 'a stripped complaint left its prefix behind');
  } finally { s.close(); }
}]);

cases.push(['a real error is still shown', async () => {
  const s = await session();
  try {
    // the filter above drops two known lines and nothing else. an error that
    // matters has to survive, or the filter has become a way of hiding them.
    const out = await s.run('octop-no-such-command-xyz', 1200);
    assert.ok(/not found|No such file/i.test(out), 'a genuine error was swallowed: ' + JSON.stringify(out));
  } finally { s.close(); }
}]);

/* ---------------------------------------------------------------------- *
 *  the bytes a program writes have to arrive as themselves
 * ---------------------------------------------------------------------- */

cases.push(['accented letters, CJK and emoji survive the round trip', async () => {
  const s = await session();
  try {
    // real characters, typed as a person would type them. an escape sequence
    // would only prove that bash can print an escape sequence, which is a
    // different claim and an easier one.
    const cmd = 'printf \'h\u00e9llo w\u00f6rld \u65e5\u672c\u8a9e \ud83c\udf89\\n\'';
    const out = printed(await s.run(cmd, 1300), cmd);
    // the shell has to be in a UTF-8 locale for this, which is why the session
    // is started with one rather than inheriting whatever the server had
    assert.ok(out.includes('h\u00e9llo'), 'accented Latin was mangled: ' + JSON.stringify(out));
    assert.ok(out.includes('\u65e5\u672c\u8a9e'), 'CJK was mangled: ' + JSON.stringify(out));
    assert.ok(out.includes('\ud83c\udf89'), 'the emoji was mangled: ' + JSON.stringify(out));
    assert.ok(!out.includes('\ufffd'), 'something came back as a replacement character');
  } finally { s.close(); }
}]);

cases.push(['a file with a non-ASCII name can be made and found', async () => {
  const s = await session();
  try {
    // this is the round trip that matters: the name is typed in, arrives in the
    // shell as itself, and comes back out of ls as itself
    const name = '\u00fcn\u00efcode f\u00efl\u00e9.txt';
    const cmd = 'touch \'' + name + '\' && ls -d \u00fcn*';
    const out = printed(await s.run(cmd, 1700), cmd);
    assert.ok(out.includes(name), 'the name did not survive: ' + JSON.stringify(out));
    await s.run('rm -f \'' + name + '\'', 900);
  } finally { s.close(); }
}]);

cases.push(['a carriage return collapses instead of stacking', async () => {
  const s = await session();
  try {
    // a progress bar is one line rewritten over and over; passed straight
    // through it is thousands of characters, and a two minute install is
    // unreadable rather than merely ugly
    const cmd = 'printf \'10%%\\r20%%\\r100%%\\n\'';
    const out = printed(await s.run(cmd, 1200), cmd);
    assert.ok(out.includes('100%'), 'the final state was not kept: ' + JSON.stringify(out));
    assert.ok(!/10%/.test(out), 'the earlier states were left behind: ' + JSON.stringify(out));
  } finally { s.close(); }
}]);

cases.push(['a backspace erases rather than printing', async () => {
  const s = await session();
  try {
    const cmd = 'printf \'abc\\b\\b\\bXYZ\\n\'';
    const out = printed(await s.run(cmd, 1200), cmd);
    assert.ok(out.includes('XYZ'), 'the overwrite did not happen: ' + JSON.stringify(out));
    assert.ok(!out.includes('abc'), 'the backspaced text was left on screen: ' + JSON.stringify(out));
  } finally { s.close(); }
}]);

cases.push(['a colour escape arrives as a colour, not as text', async () => {
  const s = await session();
  try {
    // the codes are not stripped here, they are handed on and rendered; what
    // matters here is only that the bytes survive the trip, because a program
    // that colours its output and a terminal that shows the code are two
    // different experiences and the panel is the one that decides
    const out = await s.run('printf \'\\033[32mGREEN\\033[0m\\n\'', 1200);
    assert.ok(out.includes('\u001b[32m'), 'the colour code was lost in transit: ' + JSON.stringify(out));
    assert.ok(out.includes('GREEN'), 'the coloured text was lost: ' + JSON.stringify(out));
  } finally { s.close(); }
}]);

/* ---------------------------------------------------------------------- *
 *  and the utilities that make it a shell rather than a command box
 * ---------------------------------------------------------------------- */

cases.push(['a pipeline into a real utility works', async () => {
  const s = await session();
  try {
    const cmd = 'printf \'banana\\napple\\ncherry\\n\' | sort | head -2';
    const out = printed(await s.run(cmd, 1500), cmd);
    assert.ok(out.includes('apple') && out.includes('banana'), 'the pipeline did not run: ' + JSON.stringify(out));
    assert.ok(!out.includes('cherry'), 'head did not limit the output: ' + JSON.stringify(out));
  } finally { s.close(); }
}]);

cases.push(['text processing tools are present', async () => {
  const s = await session();
  try {
    const out = await s.run('echo hello-world | sed \'s/world/bash/\'', 1400);
    assert.ok(out.includes('hello-bash'), 'sed did not work: ' + JSON.stringify(out));
  } finally { s.close(); }
}]);

/* ---------------------------------------------------------------------- *
 *  closing a session has to take its shell with it
 * ---------------------------------------------------------------------- */

cases.push(['closing a session kills the shell it started', async () => {
  const s = await session();
  const pid = s.started && s.started.pid;
  assert.ok(pid, 'the server did not report a pid, so there is nothing to watch');
  assert.doesNotThrow(() => process.kill(pid, 0), 'the shell was already gone before the session closed');

  /* The client closes with socket.destroy(), which sends no WebSocket close
   * frame. That leaves the server holding a socket whose readable side has
   * ended, and if nothing listens for that end the connection parks in
   * CLOSE_WAIT for good: onclose never runs, and the shell behind it is never
   * killed.
   *
   * This used to be invisible and it cost the suite its reliability. Each shell
   * is two bash processes, this file opens thirteen per run, and the server was
   * measured carrying 659 of them — enough that spawning one more took 3.6
   * seconds instead of 0.6, which is what turned a 1600ms wait into a failure.
   * The leak was the flake, and a flake is a resource bug wearing a timing
   * problem's coat.
   *
   * process.kill(pid, 0) is the check because it asks the operating system
   * whether the process exists, rather than asking this file's own bookkeeping
   * whether it thinks it asked for one to die. */
  s.close();

  const gone = Date.now() + 8000;
  let alive = true;
  while (Date.now() < gone && alive) {
    await sleep(100);
    try { process.kill(pid, 0); } catch { alive = false; }
  }
  assert.ok(!alive, 'the shell (pid ' + pid + ') was still running 8s after the session closed');
}]);

cases.push(['restarting brings a new shell and buries the old one', async () => {
  /* restart() is the one path through killProcessTree() that expects the tree to
   * go and then a replacement to appear, and it had no coverage at all: the
   * suite only ever closed a session, which is destroy(). The two differ —
   * restart() sets killedBy and leans on the child's exit event to call
   * start(), so a kill that took the child with it but left the exit event
   * unaccounted for would leave a session with no shell and no error. */
  const s = await session();
  const first = s.started && s.started.pid;
  assert.ok(first, 'the server did not report a pid to restart away from');
  s.prompts.length = 0;
  s.ws.send({ type: 'restart' });

  const ceiling = Date.now() + 25000;
  while (!s.restarted && Date.now() < ceiling) await sleep(25);
  if (!s.restarted) throw new Error('no second shell reported itself within 25s of the restart');
  /* the replacement is in `restarted`, not `started` — `started` is the shell
     that was replaced, and reading the pid off it compares a pid with itself */
  const second = s.restarted.pid;
  if (!second) throw new Error('the replacement shell reported no pid: ' + JSON.stringify(s.restarted).slice(0, 160));
  if (second === first) throw new Error('the restart reported the same pid ' + second + ' — nothing was replaced');

  /* the old one has to be gone, or restart leaks a shell per press */
  const gone = Date.now() + 8000;
  let alive = true;
  while (Date.now() < gone && alive) {
    await sleep(100);
    try { process.kill(first, 0); } catch { alive = false; }
  }
  assert.ok(!alive, 'the shell the restart replaced (pid ' + first + ') was still running 8s later');

  /* and the new one has to actually work, not merely exist */
  const out = await s.run('printf restarted-ok', 2000);
  assert.ok(out.indexOf('restarted-ok') >= 0, 'the replacement shell does not run commands: ' + JSON.stringify(out.slice(0, 120)));
  s.close();
}]);

cases.push(['the escalation kills a tree that ignored the polite signals', async () => {
  /* The POSIX branch of killProcessTree() cannot run on this machine, because
   * IS_WINDOWS is true here and the branch is guarded by it. A test that spawns
   * a real process group would be a test of Node's signal handling on Windows,
   * which answers a different question.
   *
   * So the branch's real source is lifted out of server.js and run against a
   * recorded process boundary: the same text the server executes, with
   * process.kill replaced by a recorder and a fake child that decides when its
   * pipes close. That is enough to pin the three things that could silently
   * regress — the order of the signals, that SIGKILL is delayed rather than
   * immediate, and that the timer is cancelled once the tree is finished — and
   * it cannot drift from the code, because it is the code. */
  const text = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = text.indexOf('const KILL_ESCALATE_MS');
  if (start < 0) throw new Error('server.js no longer names KILL_ESCALATE_MS');
  const end = text.indexOf('\nfunction shellExec(', start);
  if (end < 0) throw new Error('could not find the end of killProcessTree() in server.js');
  const lifted = text.slice(start, end);
  if (!/function killProcessTree/.test(lifted)) throw new Error('the lifted text is not killProcessTree() — server.js moved');

  /* One way to build it, used twice. The earlier version of this check built a
   * second copy inline and passed a different number of arguments to it, so the
   * second tree never had a function to call and the check reported a lifting
   * failure rather than the thing it was looking at.
   *
   * The stub is an object with a `kill` on it, not a function: the lifted code
   * calls process.kill(...), and handing it a bare function gives it a `process`
   * whose kill is undefined — which reads as "no signals were sent" rather than
   * as a broken stub, and sent this looking at the signal order. */
  const lift = (kill) => {
    const factory = new Function('process', 'IS_WINDOWS', 'execFile',
      'return (function() {' + lifted + '\nreturn killProcessTree; })();');
    return factory({ kill }, false, () => {});
  };

  /* a child whose pipes close when we say so */
  const handlers = {};
  const child = { pid: 4242, once: (ev, fn) => { handlers[ev] = fn; } };
  const calls = [];
  const killProcessTree = lift((pid, sig) => { calls.push({ pid, sig }); });
  if (typeof killProcessTree !== 'function') throw new Error('could not lift killProcessTree() out of server.js');

  /* real timers, so the delay is actually observed rather than asserted */
  const t0 = Date.now();
  killProcessTree(child);
  const atReturn = calls.map(c => c.sig);
  if (atReturn.join(',') !== 'SIGHUP,SIGTERM') {
    throw new Error('the signals sent up front are ' + JSON.stringify(atReturn) + ', expected SIGHUP then SIGTERM');
  }
  if (calls.length !== 2) throw new Error('something was sent synchronously that should have waited: ' + JSON.stringify(calls));
  for (const c of calls) if (c.pid !== -4242) throw new Error('signalled pid ' + c.pid + ', not the group -4242');

  /* let the escalation land, without waiting on a fixed sleep */
  const ceiling = Date.now() + 6000;
  while (calls.length < 3 && Date.now() < ceiling) await sleep(25);
  if (calls.length < 3) throw new Error('SIGKILL never arrived; the escalation is not firing');
  if (calls[2].sig !== 'SIGKILL') throw new Error('the third signal is ' + calls[2].sig);
  const delay = Date.now() - t0;
  if (delay < 1200) throw new Error('SIGKILL came after only ' + delay + 'ms — it is meant to be a fallback, not the first thing tried');

  /* a tree that finished first must not be signalled again. Signalling a group by
   * negative pid after it has exited can land on whatever group the operating
   * system has since handed that number to, which is somebody else entirely. */
  const calls2 = [];
  const handlers2 = {};
  const child2 = { pid: 777, once: (ev, fn) => { handlers2[ev] = fn; } };
  lift((pid, sig) => calls2.push({ pid, sig }))(child2);
  if (calls2.length !== 2) throw new Error('the second tree was not signalled politely first');
  if (typeof handlers2.close !== 'function') throw new Error('nothing is listening for the child closing, so the escalation can never be cancelled');
  handlers2.close();
  await sleep(2000);
  if (calls2.length !== 2) {
    throw new Error('SIGKILL was sent ' + (calls2.length - 2) + ' time(s) after the tree had already closed: ' + JSON.stringify(calls2));
  }

  /* the Windows branch must be untouched by all of this */
  if (!/if \(!IS_WINDOWS\)/.test(lifted)) throw new Error('the POSIX branch is no longer guarded by IS_WINDOWS');
  if (!/taskkill/.test(lifted)) throw new Error('the Windows taskkill path is gone from killProcessTree()');
  /* The unref is what keeps the escalation from holding the event loop open for
   * 1.5s after the last session closed — the freeze killProcessTree() was
   * originally rewritten to avoid. Asserted on the lifted source because that is
   * the only way to see it: a timer that is not unref-d is invisible until the
   * process refuses to exit, which is not something a test suite can wait for. */
  if (!/\.unref\(\)/.test(lifted)) throw new Error('the escalation timer is never unref-d, so it holds the event loop open');
}]);

(async () => {
  try {
    await requireServer();
  } catch (e) {
    console.error('\n  ' + e.message);
    process.exit(1);
  }
  console.log('shell prompt and transcript — against a live server on ' + PORT);
  for (const [name, fn] of cases) await test(name, fn);
  console.log('\n  ' + passed + ' passed, ' + failures.length + ' failed');
  process.exit(failures.length ? 1 : 0);
})();
