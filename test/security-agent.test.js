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

function api(p, { method = 'GET', body, tok, origin = LOCAL } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { origin };
    if (tok) headers['x-octop-token'] = tok;
    if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    const req = http.request({ host: HOST, port: PORT, path: p, method, headers, timeout: 8000 }, res => {
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
    const r = await api('/api/agent/run', { method: 'POST', body: JSON.stringify({ text: 'halo' }), tok: t });
    if (r.status === 401) throw new Error('a valid token was refused');
    /* With no profile configured this is the sentence the page has always
       shown. The point is that it is now only reachable by someone who proved
       they belong here. */
    if (r.status !== 400) throw new Error('expected the configuration 400, got ' + r.status + ': ' + r.body);
    if (!/profile/i.test(r.body)) throw new Error('the message the page depends on changed: ' + r.body);
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
