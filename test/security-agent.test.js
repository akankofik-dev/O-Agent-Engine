'use strict';
/* ====================================================================== *
 *  security-agent.test.js — "who are you" and "is anything configured" are
 *  two different questions, and the server used to answer the second one to
 *  anyone who asked the first.
 *
 *  What broke
 *  ----------
 *  `POST /api/agent/run` with no credentials of any kind answered
 *  `400 no agent profile yet — create one in Settings`. That sentence is true
 *  and it is the wrong answer: it tells an unauthenticated caller that the
 *  door is unlocked, and the reason given is that the furniture has not been
 *  delivered yet. Add a provider in Settings and the same call starts spending
 *  the key.
 *
 *  What this locks in
 *  ------------------
 *  401 without a credential, whatever the configuration is. 400 with one and no
 *  profile, so the message the page shows a real user is untouched.
 * ====================================================================== */

const fs = require('fs');
const http = require('http');
const path = require('path');

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

function token() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null; }
  catch { return null; }
}

/**
 * Start an agent run, read the one event that answers the credential
 * question, and stop the run again.
 *
 * The status line is still the answer — 401 without a token, 200 with one — and
 * it arrives before anything else. What a 200 additionally means here is that
 * the server is now working on a turn, and a run nobody is watching holds the
 * one-at-a-time lock until it finishes. Hanging up without stopping it is how a
 * test suite leaves a ghost and the next person is answered with 409, so the run
 * is cancelled on the way out.
 *
 * One event is read rather than zero, because cancelling needs a name: the first
 * event the server sends is the one that carries the runId.
 */
function apiRunThenStop(p, { body, tok, origin = LOCAL, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { origin };
    if (tok) headers['x-octop-token'] = tok;
    if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(body); }

    const answer = { status: 0, contentType: '', runId: '' };
    let settled = false;
    let req = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      try { if (req) req.destroy(); } catch { /* already gone */ }
      if (!answer.runId) { resolve(answer); return; }
      /* stop the run this just started, so the next caller is not told 409 */
      const c = JSON.stringify({ runId: answer.runId });
      const cancel = http.request({
        host: HOST, port: PORT, path: '/api/agent/cancel', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(c), 'x-octop-token': tok, origin },
      }, cr => { cr.resume(); cr.on('end', () => resolve(answer)); });
      cancel.on('error', () => resolve(answer));
      cancel.on('timeout', () => { cancel.destroy(); resolve(answer); });
      cancel.end(c);
    };

    req = http.request({ host: HOST, port: PORT, path: p, method: 'POST', headers, timeout }, res => {
      answer.status = res.statusCode;
      answer.contentType = res.headers['content-type'] || '';
      let buf = '';
      res.on('data', d => {
        buf += String(d);
        const m = buf.match(/"runId":"([^"]+)"/);
        if (m) { answer.runId = m[1]; finish(); }
      });
      res.on('end', finish);
      res.on('error', finish);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function api(p, { method = 'GET', body, tok, origin = LOCAL, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { origin };
    if (tok) headers['x-octop-token'] = tok;
    if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    const req = http.request({ host: HOST, port: PORT, path: p, method, headers, timeout }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch { /* not every route is json */ }
        resolve({ status: res.statusCode, body: b.slice(0, 300), json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  console.log('\n  agent endpoint boundary — live server on ' + PORT);

  /* --- without a credential -------------------------------------------- */

  await check('POST /api/agent/run with nothing is 401, not 400', async () => {
    const r = await api('/api/agent/run', { method: 'POST', body: JSON.stringify({ text: 'halo' }) });
    if (r.status === 400) throw new Error('still answers 400 with a configuration reason: ' + r.body);
    if (r.status !== 401) throw new Error('expected 401, got ' + r.status + ': ' + r.body);
  });

  await check('the 401 body does not describe the machine', async () => {
    const r = await api('/api/agent/run', { method: 'POST', body: JSON.stringify({ text: 'halo' }) });
    if (/profile|provider|model|settings/i.test(r.body)) {
      throw new Error('an unauthenticated caller was told about the configuration: ' + r.body);
    }
  });

  await check('a wrong token on the agent route is 401', async () => {
    const r = await api('/api/agent/run', { method: 'POST', body: JSON.stringify({ text: 'halo' }), tok: 'x'.repeat(48) });
    if (r.status !== 401) throw new Error('expected 401, got ' + r.status);
  });

  await check('the config cannot be read without a credential', async () => {
    const r = await api('/api/config/agents');
    if (r.status !== 401) throw new Error('expected 401, got ' + r.status + ': ' + r.body);
  });

  await check('the browser cannot be driven without a credential', async () => {
    const r = await api('/api/browser/action', { method: 'POST', body: JSON.stringify({ action: 'read' }) });
    if (r.status !== 401) throw new Error('expected 401, got ' + r.status);
  });

  /* --- with a credential, the old answer must survive ------------------- */
  await check('a valid token gets the real answer about configuration', async () => {
    const t = token();
    if (!t) throw new Error('no token issued, cannot test the authenticated path');
    /* The credential is decided at the status line — measured at 5ms with a
       valid token and 14ms without one — so this reads from there and hangs
       up. Waiting for the body meant waiting on the provider, and a turn that
       took longer than the suite's ceiling was reported as though the token
       gate had broken. It had not; the provider was just slow. */
    const r = await apiRunThenStop('/api/agent/run', { body: JSON.stringify({ text: 'halo' }), tok: t });
    if (r.status === 401) throw new Error('a valid token was refused');
    if (r.status === 403) throw new Error('a valid token was refused as forbidden');

    /* Every other answer here is the product's own, and each one says the
       request got past the gate. 200 with the event stream is the agent route
       opening for a caller that proved it belongs; 400 is the sentence the
       page shows when no agent is configured; 409 is the run lock, which is
       also a real answer and also not an auth one. */
    if (r.status === 200) {
      if (!/text\/event-stream/.test(r.contentType)) {
        throw new Error('a 200 that is not the event stream the page reads: ' + r.contentType);
      }
      return;
    }
    /* a 200 here started a real turn, so this check has to be the reason it
       stops: a test suite must not leave a live run holding the lock, or the
       next thing anybody tries is answered with 409. */
    if (!r.runId) throw new Error('the run never named itself, so it could not be stopped');
    if (r.status === 409) return;   // a run is in progress — a real answer, not an auth one
    if (r.status !== 400) throw new Error('expected a real answer, got ' + r.status);
  });

  await check('an unknown profile id is a 4xx that is not an auth answer', async () => {
    const t = token();
    if (!t) throw new Error('no token issued');
    const r = await api('/api/agent/run', { method: 'POST', body: JSON.stringify({ text: 'halo', profileId: 'ag_does_not_exist' }), tok: t });
    if (r.status === 401) throw new Error('an authenticated caller was told 401');
    if (r.status < 400 || r.status >= 500) throw new Error('expected a 4xx, got ' + r.status + ': ' + r.body);
  });

  await check('the config can be read with a valid token', async () => {
    const t = token();
    if (!t) throw new Error('no token issued');
    const r = await api('/api/config/agents', { tok: t });
    if (r.status !== 200) throw new Error('the settings page cannot load: ' + r.status);
  });

  /* --- the routes that must stay open ---------------------------------- */

  await check('/api/health is open, so a service check still works', async () => {
    const r = await api('/api/health', { origin: undefined });
    if (r.status !== 200) throw new Error('a health check now needs a credential: ' + r.status);
  });

  await check('/api/ready is open, for the same reason', async () => {
    const r = await api('/api/ready', { origin: undefined });
    if (r.status !== 200) throw new Error('a readiness check now needs a credential: ' + r.status);
  });

  await check('the token file is not served as a static file', async () => {
    const r = await api('/data/access-token', { tok: token() });
    if (r.status === 200) throw new Error('the token was served over HTTP: ' + r.body);
  });

  console.log('\n  agent boundary: ' + pass + ' passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ''));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('\n  suite crashed: ' + e.message); process.exit(1); });
