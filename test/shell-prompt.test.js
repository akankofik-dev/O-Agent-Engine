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

const PORT = Number(process.env.PORT || 8787);
const HOST = '127.0.0.1';

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
  const s = { started: null, text: '', prompts: [], close: () => ws.close() };
  ws.on(msg => {
    let m; try { m = JSON.parse(msg); } catch { return; }
    if (m.type === 'started') s.started = m;
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

(async () => {
  console.log('shell prompt and transcript — against a live server on ' + PORT);
  for (const [name, fn] of cases) await test(name, fn);
  console.log('\n  ' + passed + ' passed, ' + failures.length + ' failed');
  process.exit(failures.length ? 1 : 0);
})();
