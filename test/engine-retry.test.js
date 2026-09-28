'use strict';
/* ====================================================================== *
 *  test/engine-retry.test.js — surviving a provider that says no.
 *
 *  Run: node test/engine-retry.test.js
 *
 *  Three failures motivated every assertion here, and all three looked the same
 *  from the outside: the run stopped, and the work already done was gone.
 *
 *    1. A rate limit, a dropped connection or a 500 killed the run outright,
 *       even though `retryable` had been computed and shipped to the page the
 *       whole time. One unlucky blip cost every tool result already gathered.
 *    2. Nothing measured the context, so a long task simply grew past what the
 *       model accepts — and died at the exact point where it had done the most.
 *    3. Trimming by dropping messages one at a time hands a provider tool calls
 *       without their results, which is not a smaller conversation but a
 *       malformed one, and it fails worse than not trimming at all.
 *
 *  The provider under test is a stub with a script; the classifications are read
 *  off a real HTTP server answering with real status codes. A test that builds
 *  the very object it then asserts on proves that the object can be built, not
 *  that anything in the running server is retryable.
 * ====================================================================== */

/* Set before the engine is loaded, so the backoff table is the fast one. The
   wait is real behaviour, but its length is a guess about someone else's
   server — testing 24 seconds of it says nothing the 40ms version does not. */
process.env.AI_RETRY_DELAYS_MS = '5,10,20';

const assert = require('assert');
const http = require('http');
const engine = require('../ai/engine');
const providers = require('../ai/providers');

let pass = 0;
const fails = [];
function check(name, fn) {
  try { fn(); pass++; } catch (e) { fails.push(name + '\n      ' + e.message); }
}
async function acheck(name, fn) {
  try { await fn(); pass++; } catch (e) { fails.push(name + '\n      ' + e.message); }
}

/* ---- harness -------------------------------------------------------- */

/** replies come from a script, so "fail once, then answer" is the whole story */
function scripted(script) {
  const calls = [];
  return {
    calls, model: 'test/model', protocol: 'test', secret: 'sk-not-real',
    async chat(req) {
      calls.push(req);
      const step = script.length > 1 ? script.shift() : script[0];
      if (typeof step === 'function') return step({ messages: req.messages, n: calls.length });
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

const CONTROLLER = {
  browser: { runtime: async () => ({}), action: async () => ({ ok: true }), tabs: async () => [] },
  shell: { exec: async () => ({ exitCode: 0 }) },
};
const PROFILE = { id: 'tester', name: 'Tester', skills: {}, tools: {}, maxRounds: 3 };
const DONE = { text: 'all set', toolCalls: [] };

function run(provider, over) {
  const events = [];
  return engine.runAgent({
    provider, profile: PROFILE, text: 'go', controller: CONTROLLER,
    onEvent: e => events.push(e),
    ...(over || {}),
  }).then(out => ({ out, events, kinds: events.map(e => e.type) }));
}

(async () => {
  /* ---- 1. a transient failure costs one round, not the run --------- */

  await acheck('a retryable failure is retried and the run still answers', async () => {
    const p = scripted([new providers.ProviderError('429 slow down', { errorType: 'rate_limited', retryable: true }), DONE]);
    const r = await run(p);
    assert.strictEqual(p.calls.length, 2, 'provider was asked twice, got ' + p.calls.length);
    assert.strictEqual(r.out.ok, true, 'run should succeed after the retry');
    assert.ok(r.kinds.includes('retry'), 'the page is told a retry happened');
  });

  await acheck('the retry event carries the wait, so the UI can show it', async () => {
    const p = scripted([new providers.ProviderError('429 slow down', { errorType: 'rate_limited', retryable: true }), DONE]);
    const r = await run(p);
    const ev = r.events.find(e => e.type === 'retry');
    assert.ok(ev && ev.waitMs >= 0, 'retry must say how long it waits');
    assert.strictEqual(ev.attempt, 1, 'first retry is attempt 1');
    assert.ok(ev.of > 1, 'the page needs to know how many tries are left');
  });

  await acheck('a real refusal is not retried', async () => {
    const p = scripted([new providers.ProviderError('401 bad key', { errorType: 'auth_error', status: 401, retryable: false }), DONE]);
    const r = await run(p);
    assert.strictEqual(p.calls.length, 1, 'provider was asked exactly once, got ' + p.calls.length);
    assert.strictEqual(r.out.ok, false);
    assert.ok(!r.kinds.includes('retry'), 'no retry should have been emitted');
  });

  await acheck('the stop button works during the backoff', async () => {
    let asked = 0;
    const p = { model: 'm', protocol: 't', secret: 'x', async chat() { asked++; throw new providers.ProviderError('500 boom', { errorType: 'upstream_error', retryable: true }); } };
    /* stop as soon as the provider has been asked once — i.e. the user hits ■
       while the engine is sitting in the backoff */
    const r = await run(p, { shouldStop: () => asked >= 1 });
    assert.strictEqual(r.out.stopped, true, 'run reports stopped');
    assert.strictEqual(asked, 1, 'and the provider is not asked again, got ' + asked);
  });

  await acheck('a blip in a later round gets retries of its own', async () => {
    /* Round 1 burns the whole backoff table and then recovers. Round 2 then
       trips over a single blip. If the table were spent once per *run* rather
       than per round, that second blip ends the run — and the blip is exactly
       the situation the table exists for. */
    const seq = [
      new providers.ProviderError('500', { errorType: 'upstream_error', retryable: true }),
      new providers.ProviderError('500', { errorType: 'upstream_error', retryable: true }),
      new providers.ProviderError('500', { errorType: 'upstream_error', retryable: true }),
      { text: '', toolCalls: [{ id: 'c1', name: 'nope', args: {} }] },
      new providers.ProviderError('429 overloaded', { errorType: 'rate_limited', rateScope: 'transient', retryable: true }),
      DONE,
    ];
    const p = scripted(seq);
    const r = await run(p, { profile: { ...PROFILE, maxRounds: 3 } });
    const retries = r.events.filter(e => e.type === 'retry').length;
    assert.strictEqual(retries, 4, '3 retries in round 1 and 1 in round 2, got ' + retries);
    assert.strictEqual(r.out.ok, true, 'the run should finish, got: ' + r.out.error);
    assert.strictEqual(r.out.rounds, 2, 'both rounds ran');
  });

  await acheck('a provider that never recovers fails the run rather than hanging', async () => {
    let asked = 0;
    const p = { model: 'm', protocol: 't', secret: 'x', async chat() { asked++; throw new providers.ProviderError('500', { errorType: 'upstream_error', retryable: true }); } };
    const r = await run(p, { profile: { ...PROFILE, maxRounds: 2 } });
    assert.strictEqual(r.out.ok, false, 'a provider that never answers must fail the run');
    assert.ok(!r.out.stopped, 'and is not reported as a stop');
    /* it must stop asking rather than retrying for ever: the table is finite,
       so a run that kept going would be a run the user cannot end but ■ */
    assert.strictEqual(asked, 4, 'one round of 1 try + 3 retries, then it gives up; asked ' + asked);
  });

  /* ---- 2. the context has to fit ---------------------------------- */

  const seen = [];
  const picky = {
    calls: [], model: 'm', protocol: 't', secret: 'x',
    async chat(req) {
      this.calls.push(req);
      seen.push(req.messages);
      const chars = req.messages.reduce((a, m) => a + String(m.content || '').length, 0);
      if (chars > 20000) {
        throw new providers.ProviderError('maximum context length is 8192 tokens', {
          errorType: 'bad_request', status: 400, contextOverflow: true, retryable: true,
        });
      }
      return DONE;
    },
  };
  const many = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(2000) }));
  const fitted = await run(picky, { history: many });

  await acheck('a context overflow is answered by asking again smaller, not by giving up', async () => {
    assert.ok(picky.calls.length > 1, 'the provider should be asked again, asked ' + picky.calls.length);
    assert.strictEqual(fitted.out.ok, true, 'and the run should then succeed');
  });
  await acheck('the re-ask is genuinely smaller than the first attempt', async () => {
    const size = i => seen[i].reduce((a, m) => a + String(m.content || '').length, 0);
    assert.ok(size(1) < size(0), `second ask was ${size(1)} vs first ${size(0)}`);
  });

  /* A short conversation is the case the big one above cannot reach: if the
     floor on shrinking is larger than the whole conversation, every attempt
     lands on the floor and the retry goes out identical. The end-to-end probe
     hit this at 1829 characters; nothing here did, because everything here was
     built out of 2000-character history entries. */
  await acheck('a short conversation still shrinks, instead of hitting a floor', async () => {
    const sizes = [];
    const small = {
      model: 'm', protocol: 't', secret: 'x',
      async chat(req) {
        const chars = req.messages.reduce((a, m) => a + String(m.content || '').length, 0);
        sizes.push(chars);
        if (sizes.length === 1) {
          throw new providers.ProviderError('maximum context length is 4096 tokens', {
            errorType: 'bad_request', status: 400, contextOverflow: true, retryable: true,
          });
        }
        return DONE;
      },
    };
    const short = await run(small, { history: [{ role: 'user', content: 'a short question' }] });
    assert.ok(sizes.length > 1, 'the provider was asked again');
    assert.ok(sizes[1] < sizes[0], `second ask was ${sizes[1]} vs first ${sizes[0]} — the shrink was a no-op`);
    assert.strictEqual(short.out.ok, true);
  });

  await acheck('shrinking converges instead of repeating itself', async () => {
    const sizes = [];
    const stubborn = {
      model: 'm', protocol: 't', secret: 'x',
      async chat(req) {
        sizes.push(req.messages.reduce((a, m) => a + String(m.content || '').length, 0));
        throw new providers.ProviderError('maximum context length is 512 tokens', {
          errorType: 'bad_request', status: 400, contextOverflow: true, retryable: true,
        });
      },
    };
    const out = await run(stubborn, { history: Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(500) })) });
    assert.ok(sizes.length >= 2, 'it should have tried more than once, tried ' + sizes.length);
    for (let i = 1; i < sizes.length; i++) {
      assert.ok(sizes[i] < sizes[i - 1], `attempt ${i + 1} was not smaller than attempt ${i}: ${sizes[i - 1]} -> ${sizes[i]}`);
    }
    assert.strictEqual(out.out.ok, false, 'a provider that never accepts still fails the run');
  });
  await acheck('the shrink is visible to the page, not a silent truncation', async () => {
    assert.ok(fitted.kinds.includes('context_shrunk'), 'expected a context_shrunk event');
  });
  await acheck('an oversized history is trimmed before the provider ever sees it', async () => {
    const chars = seen[0].reduce((a, m) => a + String(m.content || '').length, 0);
    assert.ok(chars <= engine.CONTEXT_BUDGET_CHARS, `first request was ${chars}, over the ${engine.CONTEXT_BUDGET_CHARS} budget`);
  });

  /* ---- 3. trimming must not break the conversation's shape -------- */

  const conv = [
    { role: 'system', content: 'SYSTEM'.repeat(10) },
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'a1', name: 'x', args: {} }] },
    { role: 'tool', toolCallId: 'a1', name: 'x', content: 'old result' },
    { role: 'user', content: 'newest question' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'a2', name: 'y', args: {} }] },
    { role: 'tool', toolCallId: 'a2', name: 'y', content: 'newest result' },
  ];
  const sized = engine.fitContext(conv, 45);

  check('trimming to a tiny budget keeps the system prompt', () => {
    assert.strictEqual(sized.messages[0].role, 'system');
  });
  check('trimming never orphans a tool result from the call that asked for it', () => {
    const calls = new Set(sized.messages.filter(m => m.role === 'assistant' && m.toolCalls).flatMap(m => m.toolCalls.map(c => c.id)));
    for (const m of sized.messages) {
      if (m.role !== 'tool') continue;
      assert.ok(calls.has(m.toolCallId), `tool result ${m.toolCallId} arrived with no matching call — the provider rejects this`);
    }
  });
  check('trimming never leaves a tool result as the first non-system message', () => {
    assert.notStrictEqual(sized.messages[1] && sized.messages[1].role, 'tool', 'a leading tool message is a malformed request');
  });
  check('trimming keeps the newest work and drops the oldest', () => {
    assert.ok(sized.messages.some(m => m.content === 'newest result'), 'the newest tool result must survive');
    assert.ok(!sized.messages.some(m => m.content === 'old result'), 'the oldest should have gone first');
  });
  check('a budget that fits everything is a no-op', () => {
    const roomy = engine.fitContext(conv, 1000000);
    assert.strictEqual(roomy.dropped, 0);
    assert.strictEqual(roomy.messages.length, conv.length);
  });
  check('a single oversized message is kept rather than emptying the request', () => {
    const one = [{ role: 'system', content: 's' }, { role: 'user', content: 'z'.repeat(99999) }];
    assert.ok(engine.fitContext(one, 100).messages.length >= 1, 'an empty request is worse than an overflowing one');
  });

  /* The system prompt is the one block that cannot be dropped, which is exactly
     why it stops the budget going anywhere. Found by the end-to-end probe, not
     by anything above: the shrink event fired, the second request came back 1829
     characters — the same size as the first — and the run was one refused
     request from dying with four attempts spent and nothing learned. */
  check('a budget below the system prompt still makes progress', () => {
    const conv2 = [{ role: 'system', content: 'S'.repeat(1800) }, { role: 'user', content: 'a question' }];
    const out = engine.fitContext(conv2, 1097);
    assert.ok(out.chars < 1829, 'shrinking to 1097 left it at ' + out.chars + ' — the shrink was a no-op');
  });
  check('shrinking repeatedly keeps shrinking, all the way down', () => {
    let msgs = [{ role: 'system', content: 'S'.repeat(5000) }, { role: 'user', content: 'u'.repeat(4000) }];
    let budget = 3000;
    const sizes = [msgs.reduce((a, m) => a + m.content.length, 0)];
    for (let i = 0; i < 5; i++) {
      const fitted = engine.fitContext(msgs, budget);
      msgs = fitted.messages;
      sizes.push(msgs.reduce((a, m) => a + m.content.length, 0));
      budget = Math.floor(fitted.chars * 0.6);
    }
    for (let i = 1; i < sizes.length; i++) {
      assert.ok(sizes[i] < sizes[i - 1], `shrink ${i} did not help: ${sizes[i - 1]} -> ${sizes[i]}`);
    }
  });
  check('clipping the system prompt keeps the newest turn', () => {
    const out = engine.fitContext([{ role: 'system', content: 'S'.repeat(5000) }, { role: 'user', content: 'the question' }], 800);
    assert.ok(out.messages.some(m => m.content === 'the question'), 'the question is the one thing that cannot be lost');
  });
  check('the clip says it happened, rather than silently losing instructions', () => {
    const out = engine.fitContext([{ role: 'system', content: 'S'.repeat(5000) }], 500);
    assert.ok(/cut to fit/.test(out.messages[0].content), 'a silent cut is an agent that quietly stops following its rules');
  });
  check('a cut never hands back more than it was given', () => {
    for (const room of [0, 5, 14, 15, 100, 4999]) {
      const out = engine.fitContext([{ role: 'system', content: 'S'.repeat(5000) }], room);
      const got = out.messages.reduce((a, m) => a + m.content.length, 0);
      assert.ok(got <= Math.max(room, 0), `room ${room} produced ${got} characters`);
    }
  });

  /* ---- 4. running out of steps is not finishing ------------------- */

  const spin = {
    model: 'm', protocol: 't', secret: 'x',
    async chat() { return { text: '', toolCalls: [{ id: 'c', name: 'nope', args: {} }] }; },
  };
  const spun = await run(spin, { profile: { ...PROFILE, maxRounds: 2 } });

  check('hitting the round limit is reported as truncated', () => {
    assert.strictEqual(spun.out.truncated, true, 'the caller must be able to tell this from done');
  });
  check('truncated and stopped are different facts', () => {
    assert.ok(!spun.out.stopped, 'a truncated run did not get stopped');
  });
  check('the page is told the run was cut short', () => {
    const done = spun.events.filter(e => e.type === 'done').pop();
    assert.strictEqual(done.truncated, true);
  });

  /* ---- 5. what a real provider is judged retryable ---------------- */

  /* The provider builds its own path from the protocol, so the status cannot be
     carried in the URL — each case sets what the server answers with instead. */
  let wantStatus = 500;
  const server = http.createServer((req, res) => {
    const bodies = {
      400: { error: { message: "This model's maximum context length is 8192 tokens" } },
      401: { error: { message: 'Incorrect API key provided: sk-nope' } },
      429: { error: { message: 'Rate limit reached for gpt-x' } },
      500: { error: { message: 'internal server error' } },
      503: { error: { message: 'upstream unavailable' } },
    };
    res.writeHead(wantStatus, { 'content-type': 'application/json' });
    res.end(JSON.stringify(bodies[wantStatus] || { error: { message: 'nope' } }));
  });
  await new Promise(r2 => server.listen(0, '127.0.0.1', r2));
  const base = 'http://127.0.0.1:' + server.address().port;

  const ask = async (status) => {
    wantStatus = status;
    const client = providers.create({ baseUrl: base, apiKey: 'sk-not-real', model: 'm' });
    try { await client.chat({ messages: [{ role: 'user', content: 'hi' }] }); return null; }
    catch (e) { return e; }
  };

  await acheck('a 500 is retryable — the request never reached a decision', async () => {
    const e = await ask(500);
    assert.strictEqual(e.retryable, true, 'got: ' + e.message);
  });
  await acheck('a 503 is retryable', async () => {
    const e = await ask(503);
    assert.strictEqual(e.retryable, true, 'got: ' + e.message);
  });
  await acheck('a 400 context overflow is retryable and names the real cause', async () => {
    const e = await ask(400);
    assert.strictEqual(e.contextOverflow, true, 'got: ' + e.message);
    assert.strictEqual(e.retryable, true);
    assert.ok(/context window/i.test(e.message), 'message should name the cause: ' + e.message);
  });
  await acheck('a 400 that is not a context overflow is a refusal, and is not retried', async () => {
    wantStatus = 400;
    const client = providers.create({ baseUrl: base, apiKey: 'sk-not-real', model: 'm' });
    let thrown = null;
    /* a malformed request answered with 422 rather than the overflow wording */
    const alt = http.createServer((req, res) => { res.writeHead(422, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'invalid schema for tools[0]' } })); });
    await new Promise(r2 => alt.listen(0, '127.0.0.1', r2));
    const altClient = providers.create({ baseUrl: 'http://127.0.0.1:' + alt.address().port, apiKey: 'k', model: 'm' });
    try { await altClient.chat({ messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { thrown = e; }
    alt.close();
    assert.ok(thrown, 'a 422 should throw');
    assert.strictEqual(thrown.retryable, false, 'a malformed request must not be resent, got: ' + thrown.message);
    assert.strictEqual(thrown.contextOverflow, false);
  });
  await acheck('a 401 is not retryable, however many times it is asked', async () => {
    const e = await ask(401);
    assert.strictEqual(e.retryable, false, 'got: ' + e.message);
  });
  await acheck('a busy 429 is transient and retryable', async () => {
    const e = await ask(429);
    assert.strictEqual(e.rateScope, 'transient');
    assert.strictEqual(e.retryable, true, 'got: ' + e.message);
  });
  await acheck('a spent allowance is not a busy endpoint', async () => {
    wantStatus = 429;
    const alt = http.createServer((req, res) => { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'You exceeded your current quota, check your plan and billing details' } })); });
    await new Promise(r2 => alt.listen(0, '127.0.0.1', r2));
    const client = providers.create({ baseUrl: 'http://127.0.0.1:' + alt.address().port, apiKey: 'k', model: 'm' });
    let thrown = null;
    try { await client.chat({ messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { thrown = e; }
    alt.close();
    assert.ok(thrown, 'a quota 429 should throw');
    assert.strictEqual(thrown.rateScope, 'quota', 'got: ' + thrown.message);
    assert.strictEqual(thrown.retryable, false, 'waiting cannot refill an allowance');
  });
  await acheck('an unreachable host is retryable, not a final answer', async () => {
    const client = providers.create({ baseUrl: 'http://127.0.0.1:1/', apiKey: 'k', model: 'm' });
    let thrown = null;
    try { await client.chat({ messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { thrown = e; }
    assert.ok(thrown, 'an unreachable host should throw');
    assert.strictEqual(thrown.retryable, true, 'got: ' + thrown.message);
  });
  await acheck('the secret never reaches the error message', async () => {
    const e = await ask(401);
    assert.ok(!/sk-not-real/.test(e.message), 'the key leaked into: ' + e.message);
  });

  server.close();

  console.log('\n  engine-retry: ' + pass + ' passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ''));
  if (fails.length) { console.log('\n  ' + fails.join('\n  ') + '\n'); process.exit(1); }
})().catch(e => { console.error('\n  harness crashed:\n  ', e); process.exit(1); });
