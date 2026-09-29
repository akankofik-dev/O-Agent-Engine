// End-to-end proof: does the retry actually happen inside the real server, over
// the real SSE stream, and reach the page? A unit test can only show the engine
// asks twice; this shows the whole path does.
//
// It is in the suite rather than in a scratch script because it earned its
// place: it is the only thing that caught the shrink doing nothing on a short
// conversation, which every unit test built out of large history entries sailed
// straight past. The unit tests are not a substitute for it.
//
// It points the app at a provider that lives in this file, drives a real turn
// over /api/agent/run, and reads the events the page would read. Afterwards it
// puts the config back and removes data/agent-config.json, which is how the app
// was found — and it refuses to run at all if a real config is already there.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const APP = 'http://127.0.0.1:8787';
const CFG_PATH = path.join(__dirname, '..', 'data', 'agent-config.json');

/* The runner reads a pass count out of the output, so a skipped suite still has
   to say one — a line without a number reads as "this printed nothing", which
   is a different and more worrying thing. */
const skip = why => { console.log('\n  retry-live: skipped — ' + why + ' (0 passed, 0 failed)'); process.exit(0); };

/* /api/agent/run is behind the access token now, so this suite has to present
 * one. Read from the file the running server wrote, the same way any other
 * client would. */
const TOKEN = (() => {
  try { return fs.readFileSync(path.join(__dirname, '..', 'data', 'access-token'), 'utf8').trim(); }
  catch { return ''; }
})();
if (!TOKEN) skip('the running server has issued no data/access-token — is it the old build?');
const auth = { 'X-Octop-Token': TOKEN };

let pass = 0; const fails = [];
const check = (name, fn) => { try { fn(); pass++; console.log('  ok    ' + name); } catch (e) { fails.push(name); console.log('  FAIL  ' + name + '\n        ' + e.message); } };

// what the fake provider should do with request n (1-based)
let script = [];
let seenMessages = [];
let port = 0;

const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    let sent = null;
    try { sent = JSON.parse(body); } catch { /* not json, doesn't matter */ }
    if (sent && Array.isArray(sent.messages)) seenMessages.push(sent.messages);
    const step = script.length > 1 ? script.shift() : script[0];
    const n = seenMessages.length;
    if (step === 'rate') {
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Rate limit reached for gpt-fake, slow down' } }));
    }
    if (step === 'overflow') {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: "This model's maximum context length is 4096 tokens" } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'done, from request ' + n }, finish_reason: 'stop' }] }));
  });
});

/** drive one real turn and collect the events the page would see */
function runTurn(text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ text, runId: 'probe_' + Date.now().toString(36) });
    const req = http.request(APP + '/api/agent/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...auth },
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('run route said ' + res.statusCode)); }
      let buf = '';
      const events = [];
      res.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = raw.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          try { events.push(JSON.parse(line.slice(6))); } catch { /* partial */ }
        }
      });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const json = (p, method, body) => new Promise((resolve, reject) => {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const headers = { 'content-type': 'application/json', ...auth };
  if (payload) headers['content-length'] = Buffer.byteLength(payload);
  const req = http.request(APP + p, { method, headers }, res => {
    let out = ''; res.on('data', d => { out += d; });
    res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(new Error(out.slice(0, 200))); } });
  });
  req.on('error', reject); req.end(payload);
});

(async () => {
  if (fs.existsSync(CFG_PATH)) skip('data/agent-config.json exists — this machine already has a real provider configured');
  await new Promise(r => fake.listen(0, '127.0.0.1', r)).catch(() => skip('could not open a local port'));
  port = fake.address().port;

  // if the server is not running there is nothing to prove against
  await new Promise(resolve => {
    const probe = http.get(APP + '/api/health', res => { res.resume(); resolve(res.statusCode === 200); });
    probe.on('error', () => resolve(false));
  }).then(alive => { if (!alive) skip('no server on ' + APP + ' — start it with `npm start` first'); });

  const cfg = await json('/api/config/agents', 'PUT', {
    version: 1,
    providers: [{ id: 'fake', name: 'Fake', baseUrl: 'http://127.0.0.1:' + port, apiKey: 'sk-fake', model: 'gpt-fake', protocol: 'openai-compatible' }],
    profiles: [{ id: 'probe', name: 'Probe', providerId: 'fake', model: 'gpt-fake', skills: {}, tools: {}, activate: true }],
    activeProfileId: 'probe',
  });
  check('the app accepts a provider pointed at a local endpoint', () => {
    // PUT answers {ok, config}; GET answers the view itself. Reading the wrong
    // one is a broken assertion, not a broken app.
    const view = cfg.config || cfg;
    if (!view.providers || !view.providers.length) throw new Error('no provider stored: ' + JSON.stringify(cfg).slice(0, 200));
  });

  /* ---- a busy provider: the turn must survive it ---- */
  script = ['rate', 'rate', 'ok'];
  let ev = await runTurn('hello');
  const kinds = ev.map(e => e.type);
  check('a real turn survives two rate limits', () => {
    const final = ev.filter(e => e.type === 'final').pop();
    if (!final) throw new Error('no final event; saw ' + kinds.join(','));
    if (final.ok !== true) throw new Error('turn failed: ' + JSON.stringify(final).slice(0, 200));
  });
  check('the page is told a retry happened, over the real stream', () => {
    if (!kinds.includes('retry')) throw new Error('no retry event; saw ' + kinds.join(','));
  });
  check('the retry event carries a wait the page can show', () => {
    const r = ev.filter(e => e.type === 'retry');
    for (const x of r) if (typeof x.waitMs !== 'number') throw new Error('retry without waitMs: ' + JSON.stringify(x));
  });
  check('the answer actually came back, so the tool loop completed', () => {
    const a = ev.filter(e => e.type === 'assistant').pop();
    if (!a || !/done, from request/.test(a.text)) throw new Error('no assistant text; saw ' + kinds.join(','));
  });

  /* ---- an oversized request: the turn must shrink, not die ---- */
  seenMessages = [];
  script = ['overflow', 'ok'];
  ev = await runTurn('a much longer question');
  check('a context overflow is recovered, not fatal', () => {
    const final = ev.filter(e => e.type === 'final').pop();
    if (!final || final.ok !== true) throw new Error('turn failed: ' + JSON.stringify(final).slice(0, 200));
  });
  check('the page is told the context was shrunk', () => {
    if (!ev.map(e => e.type).includes('context_shrunk')) throw new Error('no context_shrunk; saw ' + ev.map(e => e.type).join(','));
  });
  check('the second ask really was smaller', () => {
    if (seenMessages.length < 2) throw new Error('only ' + seenMessages.length + ' requests reached the provider');
    const size = i => seenMessages[i].reduce((a, m) => a + String(m.content || '').length, 0);
    if (size(1) >= size(0)) throw new Error('second ask was not smaller: ' + size(0) + ' -> ' + size(1));
  });

  fake.close();

  // put the machine back the way it was found: clear it through the app's own
  // API first, because the store keeps the config in memory and deleting the
  // file underneath it would leave the running server still holding a provider
  await json('/api/config/agents', 'PUT', { version: 1, providers: [], profiles: [], activeProfileId: '' });
  const cleared = await json('/api/config/agents', 'GET');
  check('the app can be returned to having no provider at all', () => {
    if (cleared.providers.length) throw new Error('providers still there');
    if (cleared.profiles.length) throw new Error('profiles still there');
    if (cleared.activeProfileId) throw new Error('a profile is still active');
  });
  fs.unlinkSync(CFG_PATH);
  check('data/ is left exactly as found', () => {
    if (fs.existsSync(CFG_PATH)) throw new Error('agent-config.json was not removed');
  });

  console.log('\n  end-to-end: ' + pass + ' passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ''));
  process.exit(fails.length ? 1 : 0);
})().catch(e => {
  fake.close();
  try { if (fs.existsSync(CFG_PATH)) fs.unlinkSync(CFG_PATH); } catch { /* already gone */ }
  console.error('\n  probe crashed: ' + e.message + '\n  (data/agent-config.json removed)');
  process.exit(1);
});
