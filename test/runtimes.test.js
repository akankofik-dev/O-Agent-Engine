'use strict';
/* ========================================================================= *
 *  test/runtimes.test.js — the agent runtime layer.
 *
 *  Run: node test/runtimes.test.js
 *
 *  This suite exists because of one claim: `connected` means a request to the
 *  real runtime succeeded during the call that reported it. Every other part of
 *  the feature — the registry, the store, the redaction, the event forwarding —
 *  is ordinary code that is easy to check by reading. This one is not, because
 *  the failure mode is a string that says the right thing: a Hermes that is not
 *  installed still answers every question this project can ask, and a layer that
 *  reports it as connected looks perfect in a screenshot.
 *
 *  So there are no mocks in here at all. Every status is produced by an
 *  http.Server on a real port answering with a real status code, and the tests
 *  assert the mapping for all five states — connected, disconnected,
 *  unavailable, authentication_error, error — because the interesting failures
 *  are the ones where a probe succeeded against the wrong port, or a 404 was
 *  read as a working server, or a transport failure was dressed as disconnected.
 *
 *  The two halves that are asserted most heavily:
 *
 *    - a key is never in any response, including one a runtime produced itself by
 *      echoing the request back in an error body (the substring-scrub, not just
 *      the field allow-list, because a redacted field can still be quoted);
 *
 *    - a runtime's SSE events land in ai/runs.js byte for byte, under the same
 *      lock as any agent run, so the canvas and replay have one source of events.
 * ========================================================================= */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const registry = require(path.join(ROOT, 'ai', 'runtimes'));
const storeModule = require(path.join(ROOT, 'ai', 'runtimes', 'store'));
const { createManager, scrub } = require(path.join(ROOT, 'ai', 'runtimes', 'manager'));
const { HermesAdapter } = require(path.join(ROOT, 'ai', 'runtimes', 'adapters', 'hermes'));
const { BaseAdapter, STATUS, STATUSES } = require(path.join(ROOT, 'ai', 'runtimes', 'adapters', 'base'));
const { createRunRegistry } = require(path.join(ROOT, 'ai', 'runs'));

let pass = 0;
const fails = [];
const check = async (name, fn) => {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fails.push({ name, e }); console.log('  FAIL ' + name + '\n         ' + (e && e.message)); }
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'oagent-runtimes-'));
const FILE = path.join(TMP, 'runtimes.json');

/* ------------------------------------------------------- a real server, not a mock */

/**
 * Start an http server on an ephemeral port. `handler` decides the reply the way
 * a real runtime decides one, from the request.
 */
function serve(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve({
      server: s,
      endpoint: 'http://127.0.0.1:' + s.address().port,
      close: () => new Promise(r => s.close(r)),
    }));
  });
}

/** a hermes that answers the documented contract */
const workingHermes = (caps = { capabilities: ['browser', 'shell', 'plan'], version: '1.4.0' },
  models = { data: [{ id: 'hermes-pro' }, { id: 'hermes-fast' }] }) => async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (p === '/v1/capabilities') return json(200, caps);
  if (p === '/v1/models') return json(200, models);
  if (p === '/v1/runs' && req.method === 'POST') {
    let b = ''; req.on('data', c => (b += c));
    return req.on('end', () => json(201, { id: 'run_1', received: JSON.parse(b || '{}') }));
  }
  if (p === '/v1/runs/run_1/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const e of [
      { type: 'step', text: 'reading the page' },
      { type: 'tool', tool: 'browser.open', target: 'example.test' },
      { type: 'step', text: 'reading the answer' },
      { type: 'final', text: 'the answer is 42' },
    ]) res.write('data: ' + JSON.stringify(e) + '\n\n');
    return res.end();
  }
  if (p === '/v1/runs/run_1/stop') return json(200, { ok: true });
  return json(404, { error: 'not found' });
};

/** a manager over a private store file, and a runs registry it records into */
function newManager(withRuns) {
  /* A fresh file per manager so two tests never see each other's runtimes. The
   * store module is a singleton with mutable module state (the file it points at,
   * the type list), so each test gets a shallow copy rather than the shared one —
   * a copy that can be pointed at its own file without moving anyone else. */
  const f = path.join(TMP, 'store-' + Math.random().toString(36).slice(2) + '.json');
  const s = Object.create(storeModule);
  for (const k of Object.keys(storeModule)) s[k] = storeModule[k];
  s.useFile(f);
  return {
    store: s,
    file: f,
    manager: createManager({ store: s, runs: withRuns === false ? null : createRunRegistry() }),
  };
}

/**
 * Register a throwaway adapter under a new type, run fn, then remove it.
 *
 * A hostile adapter is the one case a stub server cannot produce: a runtime that
 * answers 500 is a runtime that failed, but an adapter whose status() throws — or
 * returns a status name nobody defined — is a plugin bug, and the manager is the
 * only place that can catch it. Registering through the real registry (rather than
 * reaching into the manager) means the store's type list, the spec table and the
 * adapter check all see it exactly as they would a shipped one.
 */
async function withAdapter(name, make, fn) {
  class TestAdapter extends BaseAdapter {
    static get runtimeType() { return name; }
    constructor(cfg) { super(cfg); this.impl = make(cfg); }
    status() { return this.impl.status(); }
    connect() { return this.impl.connect ? this.impl.connect() : this.status(); }
    capabilities() { return this.impl.capabilities ? this.impl.capabilities() : super.capabilities(); }
  }
  registry.REGISTRY[name] = TestAdapter;
  try { return await fn(); }
  finally { delete registry.REGISTRY[name]; }
}

/* =============================================================== the registry */

(async () => {
  await check('the registry offers only types it has an adapter for', () => {
    const types = registry.TYPES();
    assert.ok(types.includes('hermes'));
    assert.ok(types.includes('custom'));
    /* The point of building the list from the registry: there is no goose, no
     * codex and no opencode here, because none of them has been probed on a
     * machine this was built on. A type with no adapter cannot be offered. */
    for (const absent of ['goose', 'codex', 'opencode']) {
      assert.ok(!types.includes(absent), absent + ' must not be offered without an adapter');
    }
  });

  await check('create() refuses an unknown type instead of falling back to custom', () => {
    assert.throws(() => registry.create({ type: 'goose' }), /no adapter for runtime type/);
    assert.throws(() => registry.create({ type: 'opencode' }), /no adapter for runtime type/);
    assert.throws(() => registry.create(null), /no runtime configured/);
    /* The fallback this guards against: an unopenable config that comes back
     * looking like a runtime that connects to nothing. */
    const c = registry.create({ type: 'custom', endpoint: 'http://x.test' });
    assert.strictEqual(c.type, 'custom');
  });

  await check('an adapter missing a method fails at the registry, not at use', () => {
    /* a bare object, not a subclass: inheriting from BaseAdapter would supply all
     * six methods and prove nothing */
    const broken = { type: 'broken', connect() {}, status() {} };
    assert.throws(() => registry.assertAdapter(broken), /does not implement/);
    assert.throws(() => registry.assertAdapter({ type: 'b' }), /does not implement/);
    const good = registry.create({ type: 'hermes', endpoint: 'http://x.test' });
    assert.strictEqual(registry.assertAdapter(good), good);
    /* and every adapter in the registry actually satisfies the contract */
    for (const type of registry.TYPES()) {
      registry.assertAdapter(registry.create({ type, endpoint: 'http://x.test' }));
    }
  });

  await check('the form spec is read off the adapter, so defaults cannot drift', () => {
    const spec = registry.specFor('hermes');
    assert.strictEqual(spec.defaultEndpoint, HermesAdapter.DEFAULT_ENDPOINT);
    assert.strictEqual(spec.defaultEndpoint, 'http://127.0.0.1:8642');
    assert.ok(spec.apiKey && spec.timeout && spec.model);
    assert.ok(spec.capabilitiesEndpoint, 'hermes probes /v1/capabilities');
    assert.strictEqual(registry.specFor('custom').capabilitiesEndpoint, false);
    assert.strictEqual(registry.specFor('goose'), null);
  });

  await check('the five statuses are the five statuses, and nothing else', () => {
    assert.deepStrictEqual(STATUSES.slice().sort(), [
      'authentication_error', 'connected', 'disconnected', 'error', 'unavailable',
    ]);
    /* A base adapter must answer, not throw: an unprobed runtime that crashes a
     * status poll takes the whole list down with it. */
    return new BaseAdapter({ id: 'a' }).status().then(s => {
      assert.strictEqual(s.status, STATUS.UNAVAILABLE);
      assert.ok(s.reason, 'and says why');
    });
  });

  /* ================================================================== the store */

  await check('a saved runtime never carries its key out of publicView()', () => {
    const { manager } = newManager(false);
    const out = manager.save({ name: 'H', type: 'hermes', apiKey: 'sk-live-4f2a9c1e7b' });
    assert.ok(out.ok, out.error);
    /* the shape a route actually returns, not an internal projection of it */
    const [v] = manager.list();
    assert.strictEqual(v.hasKey, true);
    assert.strictEqual(v.keyHint, '••••1e7b', 'the last four, so a person can tell WHICH key is set');
    assert.ok(!JSON.stringify(v).includes('sk-live'), 'the key itself must not appear');
    assert.ok(!('apiKey' in v), 'the field must not even be present');
    /* and a short key is still a hint, not the whole thing */
    const short = manager.save({ name: 'S', type: 'hermes', apiKey: 'abcd' });
    assert.strictEqual(short.runtime.keyHint, '••••', 'four characters or fewer is not a hint');
  });

  await check('an empty endpoint takes the adapter default; a broken one is refused', () => {
    const { manager } = newManager(false);
    const ok = manager.save({ name: 'H', type: 'hermes' });
    assert.ok(ok.ok, ok.error);
    assert.strictEqual(ok.runtime.endpoint, 'http://127.0.0.1:8642', 'default is a default, and editable');

    const edited = manager.save({ id: ok.runtime.id, endpoint: 'http://10.0.0.5:9000' });
    assert.strictEqual(edited.runtime.endpoint, 'http://10.0.0.5:9000', 'and it is editable');

    for (const bad of ['http:/127.0.0.1:8642', '127.0.0.1:8642', 'ftp://x.test']) {
      const out = manager.save({ name: 'bad', type: 'hermes', endpoint: bad });
      assert.ok(!out.ok, 'must refuse ' + JSON.stringify(bad));
      assert.ok(/url|endpoint/i.test(out.error), out.error);
    }
    /* whitespace-only is empty, and empty means default — not a second way to be
     * malformed. `new URL('http:/x')` not throwing is why the `//` is checked as
     * text; a lone space has no such excuse. */
    for (const blank of ['', '   ']) {
      const out = manager.save({ name: 'blank', type: 'hermes', endpoint: blank });
      assert.ok(out.ok && out.runtime.endpoint === 'http://127.0.0.1:8642', 'default for ' + JSON.stringify(blank));
    }
    /* custom has no default, so empty really is an error there */
    assert.ok(!manager.save({ name: 'c', type: 'custom', endpoint: '' }).ok);
  });

  await check('an edit without a key leaves the stored key alone; clearKey removes it', () => {
    const { manager } = newManager(false);
    const a = manager.save({ name: 'H', type: 'hermes', apiKey: 'sk-one-1111' });
    const b = manager.save({ id: a.runtime.id, name: 'H2' });
    assert.strictEqual(b.runtime.hasKey, true, 'an empty field is not a request to forget the key');
    assert.strictEqual(b.runtime.keyHint, '\u2022\u2022\u2022\u20221111');
    const c = manager.save({ id: a.runtime.id, apiKey: 'sk-two-2222' });
    assert.strictEqual(c.runtime.keyHint, '\u2022\u2022\u2022\u20222222', 'a typed key replaces it');

    const d = manager.save({ id: a.runtime.id, clearKey: true });
    assert.strictEqual(d.runtime.hasKey, false);
    /* clearing wins over a value in the same request, rather than the outcome
       depending on which field the form happened to serialise first */
    assert.strictEqual(
      manager.save({ id: a.runtime.id, apiKey: 'sk-three-3333', clearKey: true }).runtime.hasKey, false);

    /* and a key that merely resembles a command is still a key. The first
       version of this cleared on a sentinel string, which meant a real key
       beginning that way would have silently deleted the credential. */
    const e = manager.save({ name: 'S', type: 'hermes', apiKey: ' clear' });
    assert.strictEqual(e.runtime.hasKey, true, 'a literal string is a key, not a command');
    assert.strictEqual(manager.save({ id: e.runtime.id, apiKey: '' }).runtime.hasKey, true, 'and empty leaves it');
  });

  await check('a runtime of an unknown type is refused, not stored', () => {
    const { manager } = newManager(false);
    for (const t of ['goose', 'codex', 'opencode', 'hermes2']) {
      const out = manager.save({ name: 'x', type: t, endpoint: 'http://x.test' });
      assert.ok(!out.ok, t + ' must be refused');
      assert.ok(/not a runtime this build has an adapter for/.test(out.error), out.error);
    }
  });

  await check('the file is written atomically and holds no status', () => {
    const { manager, file } = newManager(false);
    manager.save({ name: 'H', type: 'hermes', apiKey: 'sk-abc-9876' });
    /* no .tmp left behind: the rename happened */
    assert.ok(!fs.existsSync(file + '.tmp'), 'temp file must not survive a write');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(raw.runtimes.length, 1);
    assert.strictEqual(raw.runtimes[0].apiKey, 'sk-abc-9876', 'the key IS stored, server side');
    /* and nothing that could be read back as a claim about the runtime's health */
    const keys = Object.keys(raw.runtimes[0]);
    for (const forbidden of ['status', 'connected', 'lastProbe', 'lastSeen']) {
      assert.ok(!keys.includes(forbidden), forbidden + ' must never be persisted');
    }
  });

  await check('configuration survives a reload of the process', () => {
    const { manager, store, file } = newManager(false);
    const a = manager.save({ name: 'Hermes', type: 'hermes', endpoint: 'http://127.0.0.1:9999', apiKey: 'sk-persist-1', model: 'h-pro' });
    /* a brand new store over the same file, which is what a restart is */
    const s2 = Object.create(storeModule);
    for (const k of Object.keys(storeModule)) s2[k] = storeModule[k];
    s2.useFile(file);
    const m2 = createManager({ store: s2 });
    const list = m2.list();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, a.runtime.id);
    assert.strictEqual(list[0].endpoint, 'http://127.0.0.1:9999');
    assert.strictEqual(list[0].model, 'h-pro');
    assert.strictEqual(list[0].hasKey, true);
    assert.ok(!JSON.stringify(list).includes('sk-persist'), 'and still not the key');
    assert.strictEqual(s2.getRaw(a.runtime.id).apiKey, 'sk-persist-1', 'the key survived on disk');
  });

  await check('a stored runtime whose type lost its adapter is dropped, not fatal', () => {
    const f = path.join(TMP, 'legacy-' + Math.random().toString(36).slice(2) + '.json');
    fs.writeFileSync(f, JSON.stringify({
      version: 1,
      runtimes: [
        { id: 'r1', name: 'Gone', type: 'goose', endpoint: 'http://x.test' },
        { id: 'r2', name: 'Here', type: 'hermes', endpoint: 'http://127.0.0.1:8642' },
        'not even an object',
        { id: 'r3', name: 'No endpoint', type: 'custom' },
      ],
    }));
    const s = Object.create(storeModule);
    for (const k of Object.keys(storeModule)) s[k] = storeModule[k];
    s.useFile(f);
    const m = createManager({ store: s });
    const ids = m.list().map(r => r.id);
    assert.deepStrictEqual(ids, ['r2'], 'one loadable runtime, no exception thrown');
  });

  /* ============================================== status: the load-bearing claim */

  await check('a real 200 on /v1/capabilities is the ONLY source of connected', async () => {
    const s = await serve(workingHermes());
    const { manager } = newManager(false);
    const v = manager.save({ name: 'H', type: 'hermes', endpoint: s.endpoint });
    const r = await manager.probe(v.runtime.id);
    assert.strictEqual(r.status, STATUS.CONNECTED);
    assert.deepStrictEqual(r.capabilities.tools, ['browser', 'plan', 'shell']);
    assert.strictEqual(r.capabilities.source, 'capabilities');
    /* model order is the SERVER's order, not sorted: the first entry is usually
     * the default model, and reordering it would quietly change which one a run
     * picks when the person did not choose */
    assert.deepStrictEqual(r.models.list, ['hermes-pro', 'hermes-fast']);
    assert.ok(r.checkedAt > 0, 'a probe says when it ran');
    await s.close();
  });

  await check('a refused credential is authentication_error, not a dead runtime', async () => {
    const s = await serve(async (req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"bad key"}}'); });
    const { manager } = newManager(false);
    const v = manager.save({ name: 'H', type: 'hermes', endpoint: s.endpoint, apiKey: 'sk-wrong-0000' });
    const r = await manager.probe(v.runtime.id);
    assert.strictEqual(r.status, STATUS.AUTH);
    assert.ok(/credential/i.test(r.reason), r.reason);
    await s.close();
  });

  await check('a 404 on the capability endpoint means "not a hermes", not "broken"', async () => {
    const s = await serve(async (req, res) => { res.writeHead(404); res.end('{"error":"no such route"}'); });
    const { manager } = newManager(false);
    const v = manager.save({ name: 'H', type: 'hermes', endpoint: s.endpoint });
    const r = await manager.probe(v.runtime.id);
    assert.strictEqual(r.status, STATUS.UNAVAILABLE, 'a wrong service is unavailable, never connected');
    await s.close();
  });

  await check('a 500 is an error, distinct from both of the above', async () => {
    const s = await serve(async (req, res) => { res.writeHead(500); res.end('{"error":"internal"}'); });
    const { manager } = newManager(false);
    const v = manager.save({ name: 'H', type: 'hermes', endpoint: s.endpoint });
    assert.strictEqual((await manager.probe(v.runtime.id)).status, STATUS.ERROR);
    await s.close();
  });

  await check('nothing listening is unavailable, and the reason names the address', async () => {
    /* a server that is then closed: the port is real, and it is genuinely dead */
    const s = await serve(async () => ({ statusCode: 200 }));
    const { manager } = newManager(false);
    const v = manager.save({ name: 'H', type: 'hermes', endpoint: s.endpoint });
    await s.close();
    const r = await manager.probe(v.runtime.id);
    assert.strictEqual(r.status, STATUS.UNAVAILABLE);
    assert.ok(r.reason.includes('127.0.0.1'), 'the reason has to be actionable: ' + r.reason);
  });

  await check('a runtime that answers capabilities but not models is still connected', async () => {
    /* a partial Hermes is still a Hermes; refusing to say connected because an
     * optional second call failed would be the same class of mistake */
    const s = await serve(async (req, res) => {
      const p = new URL(req.url, 'http://x').pathname;
      res.writeHead(p === '/v1/capabilities' ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(p === '/v1/capabilities' ? { tools: ['shell'] } : {}));
    });
    const { manager } = newManager(false);
    const v = manager.save({ name: 'H', type: 'hermes', endpoint: s.endpoint });
    const r = await manager.probe(v.runtime.id);
    assert.strictEqual(r.status, STATUS.CONNECTED);
    assert.deepStrictEqual(r.models.list, []);
    await s.close();
  });

  await check('capability documents are read by content, not by their field names', async () => {
    const a = new HermesAdapter({ id: 'x', name: 'x' });
    /* the bug this catches: {capabilities:[...],version:...} has keys, so reading
     * the keys returned the two FIELD NAMES as if they were capabilities */
    assert.deepStrictEqual(a.readCapabilities({ capabilities: ['shell'], version: '1' }).tools, ['shell']);
    assert.deepStrictEqual(a.readCapabilities(['browser', 'plan']).tools, ['browser', 'plan']);
    assert.deepStrictEqual(a.readCapabilities({ tools: { browser: {}, shell: {} } }).tools, ['browser', 'shell']);
    assert.deepStrictEqual(a.readCapabilities({ features: { a: 1 } }).tools, ['a']);
    assert.strictEqual(a.readCapabilities({ capabilities: ['shell'] }).source, 'capabilities');
  });

  await check('an unrecognised capability shape yields no list, not a guessed one', async () => {
    const a = new HermesAdapter({ id: 'x', name: 'x' });
    /* reading a bare object as a map of tool names would turn {version:'1.4'} into
     * a capability called "version" and {note:'x'} into one called "note" —
     * invented facts, out of a document whose shape nobody has confirmed */
    for (const body of [{ version: '1.4' }, { note: 'nope' }, { oops: 1 }, {}, null, 'text']) {
      const r = a.readCapabilities(body);
      assert.deepStrictEqual(r.tools, [], 'no list invented from ' + JSON.stringify(body));
      assert.strictEqual(r.ok, false);
    }
    /* and the person still gets something to act on: the reply itself */
    const s = await serve(async (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hermes_version: '1.4', beta: ['a'] }));
    });
    const { manager } = newManager(false);
    const v = manager.save({ name: 'H', type: 'hermes', endpoint: s.endpoint });
    const p = await manager.probe(v.runtime.id);
    assert.strictEqual(p.status, STATUS.CONNECTED, 'it IS connected: the probe succeeded');
    assert.deepStrictEqual(p.capabilities.tools, [], 'but the list is empty rather than invented');
    assert.ok(/no capability list/.test(p.capabilities.note), p.capabilities.note);
    assert.ok(p.detail.said && p.detail.said.includes('hermes_version'),
      'and the actual reply is shown, so the shape can be added: ' + JSON.stringify(p.detail));
    await s.close();
  });

  await check('the list probes every runtime, and a throw is error rather than connected', async () => {
    const good = await serve(workingHermes());
    const { manager } = newManager(false);
    const a = manager.save({ name: 'good', type: 'hermes', endpoint: good.endpoint });
    const b = manager.save({ name: 'bad', type: 'hermes', endpoint: 'http://127.0.0.1:1' });

    const rows = await manager.statusAll();
    assert.strictEqual(rows.length, 2);
    const byName = Object.fromEntries(rows.map(r => [r.name, r]));
    assert.strictEqual(byName.good.status, STATUS.CONNECTED);
    assert.strictEqual(byName.bad.status, STATUS.UNAVAILABLE);
    assert.ok(!rows.some(r => r.status === 'connected' && r.name === 'bad'));
    await good.close();
  });

  await check('an adapter whose status() throws is an error, never a connected', async () => {
    /* the case a stub server cannot produce: a plugin bug rather than a runtime
     * failure. The first version of this test declared a `hostile` object and
     * never installed it, so the claim was asserted about nothing. */
    await withAdapter('boomthrow', () => ({
      status: async () => { throw new Error('the adapter exploded'); },
    }), async () => {
      const { manager } = newManager(false);
      const v = manager.save({ name: 'Boom', type: 'boomthrow', endpoint: 'http://x.test' });
      assert.ok(v.ok, v.error);
      const r = await manager.probe(v.runtime.id);
      assert.strictEqual(r.status, STATUS.ERROR);
      assert.ok(/exploded/.test(r.reason), r.reason);

      /* and the same for a whole-list poll, where one bad adapter must not take
       * the other rows down with it */
      const s = await serve(workingHermes());
      const ok = manager.save({ name: 'Good', type: 'hermes', endpoint: s.endpoint });
      const rows = await manager.statusAll();
      const byName = Object.fromEntries(rows.map(r => [r.name, r]));
      assert.strictEqual(byName.Boom.status, STATUS.ERROR);
      assert.strictEqual(byName.Good.status, STATUS.CONNECTED, 'the healthy row is unaffected');
      await s.close();
    });
  });

  await check('a status the manager does not recognise becomes an error', async () => {
    /* an adapter is a plugin: it can return a name that is not one of the five.
     * Passing that through verbatim would put a string on the page that the UI
     * has no branch for, and the row would fall through to its default styling —
     * which is to look fine. */
    for (const bogus of ['connected ', 'ok', 'CONNECTED', 'healthy', '', null, undefined, 42]) {
      await withAdapter('bogusstatus', () => ({ status: async () => ({ status: bogus }) }), async () => {
        const { manager } = newManager(false);
        const v = manager.save({ name: 'B', type: 'bogusstatus', endpoint: 'http://x.test' });
        const r = await manager.probe(v.runtime.id);
        assert.strictEqual(r.status, STATUS.ERROR, 'bogus ' + JSON.stringify(bogus) + ' became ' + r.status);
        assert.ok(STATUSES.includes(r.status), 'the answer is always one of the five');
      });
    }
  });

  await check('saving a runtime never claims a connection it has not probed', async () => {
    /* the mutation this guards against is the whole feature's failure mode: a
     * freshly saved row reading `connected` before anything has been asked. */
    const { manager } = newManager(false);
    const v = manager.save({ name: 'H', type: 'hermes' });
    assert.ok(v.ok, v.error);
    assert.notStrictEqual(v.status, STATUS.CONNECTED, 'a save is not a probe');
    assert.strictEqual(v.status, STATUS.UNAVAILABLE);
    assert.strictEqual(v.checkedAt, 0, 'and it says no probe has happened');
    assert.ok(v.reason, 'and says so in words: ' + v.reason);
    /* the same for an edit */
    const e = manager.save({ id: v.runtime.id, name: 'H2' });
    assert.notStrictEqual(e.status, STATUS.CONNECTED);
  });

  await check('GET without probe=1 says "not probed", and GET with it measures', async () => {
    const s = await serve(workingHermes());
    const { manager } = newManager(false);
    const v = manager.save({ name: 'H', type: 'hermes', endpoint: s.endpoint });
    /* what the route sends on a plain load: the shape the page draws first */
    const plain = { ...manager.describe(), runtimes: manager.list().map(r => ({ ...r, status: null, reason: 'not probed yet', checkedAt: 0 })) };
    assert.strictEqual(plain.runtimes[0].status, null, 'null, not a guess: not connected AND not unavailable');
    assert.strictEqual(plain.types.length, registry.TYPES().length);

    /* and the probed one is a measurement */
    const probed = await manager.statusAll();
    assert.strictEqual(probed[0].id, v.runtime.id);
    assert.strictEqual(probed[0].status, STATUS.CONNECTED);
    assert.ok(probed[0].checkedAt > 0);
    await s.close();
  });

  await check('concurrent probes to one runtime are shared, not stacked', async () => {
    let hits = 0;
    const s = await serve(async (req, res) => {
      if (new URL(req.url, 'http://x').pathname === '/v1/capabilities') hits++;
      await new Promise(r => setTimeout(r, 60));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ capabilities: ['shell'] }));
    });
    const { manager } = newManager(false);
    const v = manager.save({ name: 'H', type: 'hermes', endpoint: s.endpoint });
    const all = await Promise.all([manager.probe(v.runtime.id), manager.probe(v.runtime.id), manager.probe(v.runtime.id)]);
    assert.strictEqual(hits, 1, 'three callers, one request — a poll must not stack up');
    assert.ok(all.every(r => r.status === STATUS.CONNECTED));
    await s.close();
  });

  await check('connect() is a probe, and cannot report success a status() would not', async () => {
    const dead = await serve(async () => ({ statusCode: 200 }));
    const { manager } = newManager(false);
    const v = manager.save({ name: 'H', type: 'hermes', endpoint: dead.endpoint });
    await dead.close();
    const c = await manager.connect(v.runtime.id);
    assert.strictEqual(c.ok, false);
    assert.strictEqual(c.status, STATUS.UNAVAILABLE);
    assert.ok(!c.detail || !c.detail.fake, 'no invented detail');

    const live = await serve(workingHermes());
    const v2 = manager.save({ name: 'H2', type: 'hermes', endpoint: live.endpoint });
    const c2 = await manager.connect(v2.runtime.id);
    assert.strictEqual(c2.ok, true);
    assert.strictEqual(c2.status, STATUS.CONNECTED);
    await live.close();
  });

  await check('disconnect on an http runtime says so instead of pretending to tear down', async () => {
    const s = await serve(workingHermes());
    const { manager } = newManager(false);
    const v = manager.save({ name: 'H', type: 'hermes', endpoint: s.endpoint });
    const d = await manager.disconnect(v.runtime.id);
    assert.strictEqual(d.status, STATUS.DISCONNECTED);
    assert.ok(/no session/i.test(d.reason), 'hermes holds no session; saying otherwise is a fake');
    await s.close();
  });

  /* ================================================================ redaction */

  await check('a key a runtime echoed back in an error is still removed', async () => {
    /* the reason this is a substring scrub and not a field allow-list: the far end
     * decides what it says, and a runtime that repeats the request in its error
     * puts the key into a string this project did not shape. */
    const KEY = 'sk-echo-me-777888999';
    const s = await serve(async (req, res) => {
      const p = new URL(req.url, 'http://x').pathname;
      if (p === '/v1/capabilities') { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'rejected ' + KEY + ' at ' + s.endpointForKey })); return; }
      res.writeHead(404); res.end('{}');
    });
    const { manager } = newManager(false);
    const v = manager.save({ name: 'H', type: 'hermes', endpoint: s.endpoint, apiKey: KEY });
    const r = await manager.probe(v.runtime.id);
    const wire = JSON.stringify(r);
    assert.ok(!wire.includes(KEY), 'the key must not survive into a probe result: ' + wire);
    assert.ok(r.detail && String(r.detail.said).includes('••••'), 'and the text is masked, not deleted');
    assert.strictEqual(r.status, STATUS.AUTH);
    await s.close();
  });

  await check('scrub() masks a long key and leaves ordinary text alone', () => {
    assert.strictEqual(scrub('the run failed at step 3', { apiKey: 'sk-1' }), 'the run failed at step 3');
    const k = 'sk-abcdefgh';
    assert.ok(!scrub('sent ' + k + ' and got 401', { apiKey: k }).includes(k));
    /* a key this short would match ordinary words, so it is not substring-masked */
    assert.strictEqual(scrub('a short key ab in a sentence', { apiKey: 'ab' }), 'a short key ab in a sentence');
    assert.strictEqual(scrub(undefined, {}), '');
  });

  await check('no route-level response can carry the key', async () => {
    /* every shape the manager hands a route, for one runtime that has a key */
    const s = await serve(workingHermes());
    const KEY = 'sk-route-abc123';
    const { manager } = newManager(false);
    const v = manager.save({ name: 'H', type: 'hermes', endpoint: s.endpoint, apiKey: KEY });
    const id = v.runtime.id;
    const shapes = await Promise.all([
      manager.list(), manager.describe(), manager.probe(id), manager.statusAll(),
      manager.test(id), manager.connect(id), manager.disconnect(id), manager.capabilities(id),
    ]);
    for (const shape of shapes) {
      assert.ok(!JSON.stringify(shape).includes(KEY), 'a shape leaked the key: ' + JSON.stringify(shape).slice(0, 200));
    }
    await s.close();
  });

  /* =========================================== events, in this project's registry */

  await check('a runtime SSE stream lands in ai/runs.js byte for byte', async () => {
    const s = await serve(workingHermes());
    const { manager } = newManager();
    const v = manager.save({ name: 'H', type: 'hermes', endpoint: s.endpoint });
    const out = await manager.run({ id: v.runtime.id, runId: 'run_a', sessionId: 'sess_1', text: 'go' });
    assert.strictEqual(out.ok, true, out.error);
    assert.strictEqual(out.externalId, 'run_1');

    /* the same registry the canvas and replay read, unchanged in shape */
    const ev = out.view.events;
    assert.deepStrictEqual(ev.map(e => e.type), ['step', 'tool', 'step', 'final']);
    assert.strictEqual(ev[1].tool, 'browser.open', 'forwarded, not translated');
    assert.strictEqual(ev[1].target, 'example.test');
    assert.strictEqual(ev[3].text, 'the answer is 42');
    assert.strictEqual(out.view.finished, true);
    assert.strictEqual(out.view.sessionId, 'sess_1');
    await s.close();
  });

  await check('the run text reaches the runtime, and the run takes the same lock', async () => {
    const seen = [];
    const s = await serve(async (req, res) => {
      const p = new URL(req.url, 'http://x').pathname;
      const json = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (p === '/v1/capabilities') return json(200, { capabilities: ['shell'] });
      if (p === '/v1/models') return json(200, { data: [] });
      if (p === '/v1/runs') {
        let b = ''; req.on('data', c => (b += c));
        return req.on('end', () => { seen.push(JSON.parse(b || '{}')); json(201, { id: 'run_x' }); });
      }
      if (p === '/v1/runs/run_x/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ type: 'final', text: 'ok' }) + '\n\n');
        return res.end();
      }
      return json(404, {});
    });
    const { manager } = newManager();
    const v = manager.save({ name: 'H', type: 'hermes', endpoint: s.endpoint, model: 'hermes-pro' });
    await manager.run({ id: v.runtime.id, runId: 'r1', sessionId: 'sx', text: 'what is 6*7', history: [{ role: 'user', content: 'earlier' }] });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].input, 'what is 6*7');
    assert.strictEqual(seen[0].model, 'hermes-pro', 'the configured model is sent, not invented');
    assert.deepStrictEqual(seen[0].history, [{ role: 'user', content: 'earlier' }]);
    assert.strictEqual(seen[0].external_run_id, 'r1', 'so a reattaching page can correlate');
    await s.close();
  });

  await check('a second runtime run is refused while one holds the browser lock', async () => {
    const s = await serve(workingHermes());
    const { manager } = newManager();
    const v = manager.save({ name: 'H', type: 'hermes', endpoint: s.endpoint });
    /* the registry claim the manager is bound to, holding the lock */
    const live = manager.run; // not the lock; take it through the same registry
    const runs = createRunRegistry();
    const m2 = createManager({ store: (() => { const x = newManager(false).store; return x; })(), runs });
    const w = m2.save({ name: 'H', type: 'hermes', endpoint: s.endpoint });
    runs.claim('other', 'sess');
    const out = await m2.run({ id: w.runtime.id, runId: 'r2', sessionId: 'sess', text: 'x' });
    assert.strictEqual(out.ok, false);
    assert.ok(/another run is still going \(other\)/.test(out.error), out.error);
    await s.close();
  });

  await check('a runtime that is not there fails as unavailable and takes no lock', async () => {
    const dead = await serve(async () => ({ statusCode: 200 }));
    const { manager } = newManager();
    const v = manager.save({ name: 'H', type: 'hermes', endpoint: dead.endpoint });
    await dead.close();
    const out = await manager.run({ id: v.runtime.id, runId: 'r9', text: 'x' });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.status, STATUS.UNAVAILABLE, 'not a generic error: the reason is specific');
    assert.ok(/not available/i.test(out.error), out.error);
    /* and the lock is free, so a broken runtime cannot wedge the run table */
    const runs = createRunRegistry();
    assert.strictEqual(runs.live(), null);
  });

  await check('a runtime that fails mid-run is recorded as an error, and the lock frees', async () => {
    const runs = createRunRegistry();
    const s = await serve(workingHermes());
    const { manager } = newManager();
    const m2 = createManager({ store: manager.store, runs });
    const v = m2.save({ name: 'H', type: 'hermes', endpoint: s.endpoint });
    const out = await m2.run({ id: v.runtime.id, runId: 'r1', text: 'x' });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(runs.live(), null, 'a finished run releases the lock');
    assert.strictEqual(runs.view('r1').finished, true);
    await s.close();
  });

  await check('a runtime that never sends a final still ends the run', async () => {
    /* otherwise the record stays unfinished, the lock is held, and the next run
     * is refused forever with no visible cause */
    const s = await serve(async (req, res) => {
      const p = new URL(req.url, 'http://x').pathname;
      const json = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (p === '/v1/capabilities') return json(200, { capabilities: ['shell'] });
      if (p === '/v1/models') return json(200, { data: [] });
      if (p === '/v1/runs') return json(201, { id: 'run_silent' });
      if (p === '/v1/runs/run_silent/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ type: 'step', text: 'started' }) + '\n\n');
        return res.end();
      }
      return json(404, {});
    });
    const runs = createRunRegistry();
    const { manager } = newManager();
    const m2 = createManager({ store: manager.store, runs });
    const v = m2.save({ name: 'H', type: 'hermes', endpoint: s.endpoint });
    const out = await m2.run({ id: v.runtime.id, runId: 'r1', text: 'x' });
    assert.strictEqual(out.ok, true);
    const evs = out.view.events;
    assert.strictEqual(evs[evs.length - 1].type, 'final', 'the manager ends the run it was handed');
    assert.strictEqual(evs[evs.length - 1].external, true, 'and says the runtime did not');
    assert.strictEqual(runs.live(), null, 'the lock is free again');
    await s.close();
  });

  await check('a custom runtime is one final event, and says it was not a stream', async () => {
    const s = await serve(async (req, res) => {
      const p = new URL(req.url, 'http://x').pathname;
      if (p === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'm1' }] })); }
      if (p === '/v1/chat/completions') {
        let b = ''; req.on('data', c => (b += c));
        return req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: 'the whole answer' } }] }));
        });
      }
      res.writeHead(404); res.end('{}');
    });
    const { manager } = newManager();
    const v = manager.save({ name: 'Custom', type: 'custom', endpoint: s.endpoint, model: 'm1' });
    const out = await manager.run({ id: v.runtime.id, runId: 'rc', text: 'hi' });
    assert.strictEqual(out.ok, true, out.error);
    assert.strictEqual(out.view.events.length, 1, 'a non-streaming call is not dressed up as steps');
    assert.strictEqual(out.view.events[0].type, 'final');
    assert.strictEqual(out.view.events[0].non_streaming, true);
    assert.strictEqual(out.view.events[0].text, 'the whole answer');
    await s.close();
  });

  await check('a custom runtime that is not there is unavailable with its own reason', async () => {
    const s = await serve(async () => ({ statusCode: 200 }));
    const { manager } = newManager(false);
    const v = manager.save({ name: 'C', type: 'custom', endpoint: s.endpoint });
    await s.close();
    const r = await manager.probe(v.runtime.id);
    assert.strictEqual(r.status, STATUS.UNAVAILABLE);
    assert.ok(r.reason.includes('127.0.0.1'), r.reason);
  });

  await check('capabilities() is probed and refuses to answer for a runtime that is down', async () => {
    const s = await serve(workingHermes());
    const { manager } = newManager(false);
    const v = manager.save({ name: 'H', type: 'hermes', endpoint: s.endpoint });
    const caps = await manager.capabilities(v.runtime.id);
    assert.strictEqual(caps.ok, true);
    assert.deepStrictEqual(caps.tools, ['browser', 'plan', 'shell']);
    await s.close();

    const s2 = await serve(workingHermes());
    const v2 = manager.save({ name: 'H2', type: 'hermes', endpoint: s2.endpoint });
    await s2.close();
    const down = await manager.capabilities(v2.runtime.id);
    assert.strictEqual(down.ok, false);
    assert.deepStrictEqual(down.tools, [], 'never a list invented for a runtime that is not there');
  });

  await check('a custom runtime does not claim to know its capabilities', async () => {
    const s = await serve(async (req, res) => {
      if (new URL(req.url, 'http://x').pathname === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
      }
      res.writeHead(404); res.end('{}');
    });
    const { manager } = newManager(false);
    const v = manager.save({ name: 'C', type: 'custom', endpoint: s.endpoint });
    const caps = await manager.capabilities(v.runtime.id);
    assert.strictEqual(caps.ok, false);
    assert.deepStrictEqual(caps.tools, []);
    assert.ok(/not declared/.test(caps.note), 'models are not capabilities, and the two are not shown as one');
    await s.close();
  });

  await check('removing a runtime takes it out of the list and out of the next probe', async () => {
    const { manager, store } = newManager(false);
    const a = manager.save({ name: 'A', type: 'hermes' });
    assert.strictEqual(manager.list().length, 1);
    const out = manager.remove(a.runtime.id);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(manager.list().length, 0);
    assert.strictEqual(store.getRaw(a.runtime.id), null);
    assert.ok(!manager.remove(a.runtime.id).ok, 'and removing it twice is an error, not a silent ok');
    const r = await manager.probe(a.runtime.id);
    assert.strictEqual(r.status, STATUS.UNAVAILABLE);
    assert.ok(/no such runtime/.test(r.reason), r.reason);
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows */ }
  console.log('\n  runtimes: ' + pass + ' passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ''));
  if (fails.length) for (const f of fails) console.log('\n  ' + f.name + '\n  ' + f.e.stack);
  process.exit(fails.length ? 1 : 0);
})().catch(e => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows */ }
  console.error('\n  suite crashed: ' + (e && e.stack));
  process.exit(1);
});
