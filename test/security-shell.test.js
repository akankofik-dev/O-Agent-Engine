'use strict';
/* ====================================================================== *
 *  security-shell.test.js — the shell socket needs a credential, not just
 *  an Origin header.
 *
 *  What broke
 *  ----------
 *  The upgrade handler asked one question: "if an Origin was sent, is it
 *  ours?" A client that sends none therefore passed by default, and a client
 *  that sends `Origin: null` passed too. Both got a live bash. Proved against
 *  the running server before this file existed: 101, and an `echo` came back.
 *
 *  What this locks in
 *  ------------------
 *  The token is the gate and Origin is the second lock, so a caller has to
 *  satisfy both. Each refusal below was a way in before.
 * ====================================================================== */

const fs = require('fs');
const path = require('path');
const ws = require('./ws-client');

const PORT = Number(process.env.PORT || 8787);
const HOST = '127.0.0.1';
const LOCAL = `http://${HOST}:${PORT}`;
const TOKEN_FILE = path.join(__dirname, '..', 'data', 'access-token');

let pass = 0;
const fails = [];
function check(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass += 1; console.log('  ok   ' + name); })
    .catch(e => { fails.push(name); console.log('  FAIL ' + name + '\n         ' + e.message); });
}

/** the token the running server issued, or null if it never made one */
function token() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null; }
  catch { return null; }
}

/**
 * Try the shell socket and report whether it was upgraded. A refusal is the
 * normal outcome here, so a thrown error is data, not a failure.
 */
async function tryShell(opts) {
  try {
    const r = await ws.open({ host: HOST, port: PORT, path: '/api/shell', ...opts });
    r.socket.destroy();
    return { upgraded: true, frames: r.frames };
  } catch (e) {
    return { upgraded: false, why: e.message };
  }
}

(async () => {
  console.log('\n  shell socket boundary — live server on ' + PORT);

  await check('the server issued a token at all', () => {
    const t = token();
    if (!t) throw new Error('no data/access-token — the server has no credential to check, which is the hole');
    if (t.length < 32) throw new Error('token is only ' + t.length + ' characters');
  });

  await check('the token file is not readable as a directory or empty', () => {
    const st = fs.statSync(TOKEN_FILE);
    if (!st.isFile()) throw new Error('access-token is not a regular file');
  });

  /* --- every way in that worked before --------------------------------- */

  await check('no Origin and no token is refused', async () => {
    const r = await tryShell({});
    if (r.upgraded) throw new Error('upgraded anyway — a shell with no credentials');
  });

  await check('Origin: null and no token is refused', async () => {
    const r = await tryShell({ origin: 'null' });
    if (r.upgraded) throw new Error('upgraded anyway — "null" is what a sandboxed frame sends');
  });

  await check('a foreign Origin and no token is refused', async () => {
    const r = await tryShell({ origin: 'https://asing.example' });
    if (r.upgraded) throw new Error('upgraded anyway');
  });

  await check('the correct Origin but no token is refused', async () => {
    /* this is the one that matters most: it looks exactly like the dashboard
       to anything reading the code, and it is still not the dashboard */
    const r = await tryShell({ origin: LOCAL });
    if (r.upgraded) throw new Error('upgraded anyway — Origin alone is still enough');
  });

  await check('a wrong token is refused', async () => {
    const r = await tryShell({ origin: LOCAL, token: 'x'.repeat(48) });
    if (r.upgraded) throw new Error('upgraded anyway — the token is not being compared');
  });

  /* --- Origin still has to hold even with a good token ----------------- */

  await check('a valid token with a foreign Origin is refused', async () => {
    const r = await tryShell({ origin: 'https://asing.example', token: token() });
    if (r.upgraded) throw new Error('upgraded anyway — a stolen token is enough from a web page');
  });

  /* --- and the real thing still works ---------------------------------- */

  await check('a valid token and the local Origin gets a working shell', async () => {
    const t = token();
    if (!t) throw new Error('no token to present');
    const marker = 'SECBOUNDARY_' + Date.now().toString(36);
    let seen = '';
    let upgraded = false;
    await ws.open({ host: HOST, port: PORT, path: '/api/shell', origin: LOCAL, token: t },
      (socket, frames) => {
        upgraded = true;
        setTimeout(() => ws.sendText(socket, JSON.stringify({ type: 'cmd', text: 'echo ' + marker })), 250);
        const poll = setInterval(() => {
          seen = frames.join('');
          if (seen.includes(marker)) { clearInterval(poll); socket.destroy(); }
        }, 150);
        setTimeout(() => { clearInterval(poll); socket.destroy(); }, 6000);
      });
    await ws.wait(1200);
    if (!upgraded) throw new Error('the legitimate client was refused — the boundary is too tight');
    if (!seen.includes(marker)) throw new Error('the shell opened but the command produced no output');
  });

  await check('a valid token as a cookie, not a header, also works', async () => {
    /* this is the path the browser actually takes, and it is the one that has
       to keep working without the dashboard knowing anything about tokens */
    const r = await tryShell({ origin: LOCAL, headers: { Cookie: 'octop=' + token() } });
    if (!r.upgraded) throw new Error('the cookie the browser would send was refused: ' + r.why);
  });

  /* --- the live view carries the same weight as the shell --------------- */

  await check('the screencast socket is refused without a token', async () => {
    const r = await tryShell({ path: '/api/browser/stream' });
    if (r.upgraded) throw new Error('upgraded anyway — the page screenshot and tab list leak to any local process');
  });

  await check('the screencast socket is opened with a token', async () => {
    const r = await tryShell({ path: '/api/browser/stream', origin: LOCAL, token: token() });
    if (!r.upgraded) throw new Error('the dashboard lost its live view: ' + r.why);
  });

  console.log('\n  shell boundary: ' + pass + ' passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ''));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('\n  suite crashed: ' + e.message); process.exit(1); });
