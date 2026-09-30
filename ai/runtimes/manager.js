'use strict';
/* ====================================================================== *
 *  ai/runtimes/manager.js — the layer between stored configs and running code.
 *
 *  Four jobs, and it is worth saying why each is here rather than in the route:
 *
 *  1. build      turn a stored record into an adapter, and refuse a type this
 *                build has no adapter for
 *  2. status     ask the runtime, now, and report what it said
 *  3. run        hand a run to a runtime and put its events into ai/runs.js
 *  4. redact     make sure a key cannot leave through a message, a log line or
 *                an error string
 *
 *  The status rule, which is the whole point
 *  -----------------------------------------
 *  There is no cached status, anywhere, on purpose. A page asks what the state of
 *  Hermes is, and the answer is the result of a request made during that call. The
 *  consequence people dislike is that the list is not instant, and the alternative
 *  — a status field that says `connected` and was last true eleven minutes ago —
 *  is exactly the kind of lie this feature was asked not to tell. So: probe, and
 *  probe as often as the page asks.
 *
 *  In-flight probes are shared, though, and that is a performance property rather
 *  than a truthfulness one. A page that polls every two seconds while a runtime
 *  takes four seconds to time out would otherwise stack requests without bound,
 *  and the list would get slower the longer somebody watched it. Two callers
 *  asking at the same moment get the same answer from the same request.
 *
 *  Why run() records into ai/runs.js
 *  ---------------------------------
 *  Because that is where the canvas, the activity dock and replay already read
 *  from. A runtime that emitted its events somewhere else would need a second
 *  transport, a second replay path, and a second thing to go wrong. So the events
 *  Hermes writes are the events this project has always stored, byte for byte:
 *  this file does not rename them, and the page decides which ones it recognises.
 *  The run takes the same lock every agent run takes, for the same reason — one
 *  browser, one tab, one owner (see ai/runs.js).
 * ====================================================================== */

const registry = require('./index');
const defaultStore = require('./store');
const { STATUS, STATUSES, RuntimeError } = require('./adapters/base');

/* registry and store have to agree on what a type is and what its default
   endpoint is, and the registry is the one that knows both. Wired per store
   rather than once at import, so a test — or a second manager with its own file —
   gets the same answers as the server does and cannot accidentally be looser. */
function wireStore(target) {
  if (typeof target.setTypes !== 'function') return target;
  target.setTypes(registry.TYPES);
  target.setDefaults((type) => {
    const spec = registry.specFor(type);
    return (spec && spec.defaultEndpoint) || '';
  });
  return target;
}

/* Remove a secret from a string that is about to be shown to somebody or written
   to a log. Substring, not field removal: a runtime is free to echo its own
   config back in an error, and a key that came back that way is still the key. */
function scrub(text, config) {
  let s = String(text === undefined || text === null ? '' : text);
  const key = String((config && config.apiKey) || '');
  /* A short "key" would match ordinary words, so a key this short is not masked
     out of unrelated text — it is still never returned by publicView(). */
  if (key.length >= 6) s = s.split(key).join('••••');
  return s;
}

/** clip a reason to something a status row can hold */
function clip(s, n = 300) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n); }

function createManager(opts = {}) {
  const store = wireStore(opts.store || defaultStore);
  /* ai/runs.js's registry, injected rather than required: the run lock is
     process-wide state and there is one of it, and a test that builds its own
     manager should not be reaching into the server's live run table. */
  const runs = opts.runs || null;
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  /** id -> in-flight probe. Deleted the moment it settles. */
  const inflight = new Map();

  /** runId -> the controller that stops it. What makes stop() reach the runtime
   *  rather than only the lock: the lock is released, but the HTTP request the
   *  adapter is holding open is not, and a cancelled run that keeps streaming is
   *  a run that keeps recording after the page said stop. */
  const running = new Map();

  /* ------------------------------------------------------------------ build */

  /** the stored record plus an adapter, or a reason. */
  function build(id) {
    const cfg = store.getRaw(String(id || ''));
    if (!cfg) return { ok: false, error: 'no such runtime: ' + id };
    try {
      return { ok: true, cfg, adapter: registry.assertAdapter(registry.create(cfg)) };
    } catch (e) {
      return { ok: false, error: scrub(e.message, cfg), status: e.status || STATUS.ERROR };
    }
  }

  /* ----------------------------------------------------------------- status */

  /**
   * Probe one runtime, coalescing concurrent callers.
   *
   * The adapter is rebuilt per probe rather than kept, so an edit to the endpoint
   * or the key is reflected on the next call instead of needing a restart. It is
   * cheap: the constructor only reads fields.
   */
  async function probe(id) {
    const key = String(id || '');
    const already = inflight.get(key);
    if (already) return already;

    const p = (async () => {
      const built = build(key);
      if (!built.ok) {
        return { ok: false, id: key, status: STATUS.UNAVAILABLE, reason: built.error, runtime: null };
      }
      const { cfg, adapter } = built;
      let s;
      try {
        s = await adapter.status();
      } catch (e) {
        /* status() is written not to throw, but an adapter is a plugin and a
           third party could. A thrown probe is `error`, never `connected`. */
        s = { status: STATUS.ERROR, reason: (e && e.message) || String(e), detail: {} };
      }
      const status = STATUSES.includes(s && s.status) ? s.status : STATUS.ERROR;
      return {
        ok: true,
        id: key,
        status,
        reason: clip(scrub(s && s.reason, cfg)),
        detail: scrubDetail(s && s.detail, cfg),
        capabilities: s && s.capabilities ? sanitiseCaps(s.capabilities, cfg) : null,
        models: s && s.models ? sanitiseModels(s.models, cfg) : null,
        checkedAt: Date.now(),
        runtime: store.publicView(cfg),
      };
    })().finally(() => { inflight.delete(key); });

    inflight.set(key, p);
    return p;
  }

  /**
   * Everything a runtime said, with the key taken out.
   *
   * The detail and capability documents come from the far end and are passed
   * through to the browser, so they are scrubbed as strings rather than trusted
   * as structured data. A field that is not a primitive becomes its own text and
   * gets the same treatment.
   */
  function scrubDetail(detail, cfg) {
    if (!detail || typeof detail !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(detail)) {
      if (v === null || v === undefined) { out[k] = v; continue; }
      out[k] = typeof v === 'object' ? scrub(JSON.stringify(v).slice(0, 800), cfg) : scrub(String(v), cfg);
    }
    return out;
  }

  /** capabilities as a plain, bounded list — the far end decides the list, this
   *  decides the shape it arrives in. `source` survives because the adapter went
   *  to the trouble of reporting which field it read, and dropping it here would
   *  leave the page unable to say "read from `tools`" or "the reply had no list". */
  function sanitiseCaps(caps, cfg) {
    if (!caps || typeof caps !== 'object') return { ok: false, tools: [] };
    const tools = Array.isArray(caps.tools) ? caps.tools : [];
    return {
      ok: !!caps.ok && tools.length > 0,
      tools: tools.map(t => clip(scrub(String(t), cfg), 60)).filter(Boolean).slice(0, 200),
      source: caps.source || null,
      version: clip(scrub(String(caps.version || ''), cfg), 60),
      note: clip(scrub(String(caps.note || caps.reason || ''), cfg)),
    };
  }

  function sanitiseModels(m, cfg) {
    if (!m || typeof m !== 'object') return { ok: false, list: [] };
    const list = Array.isArray(m.list) ? m.list : [];
    return {
      ok: !!m.ok && list.length > 0,
      list: list.map(x => clip(scrub(String(x), cfg), 80)).filter(Boolean).slice(0, 200),
    };
  }

  /** The list the page shows: every configured runtime with a status that was
   *  measured during this call. Probes run together, because five sequential
   *  timeouts is a list that takes twenty seconds to appear. */
  async function statusAll() {
    const rows = store.publicAll();
    const probes = await Promise.all(rows.map(r => probe(r.id).catch(e => ({
      id: r.id, status: STATUS.ERROR, reason: clip(scrub((e && e.message) || String(e))),
    }))));
    return rows.map((row, i) => {
      const p = probes[i] || {};
      return {
        ...row,
        status: p.status || STATUS.UNAVAILABLE,
        reason: p.reason || '',
        detail: p.detail || {},
        capabilities: p.capabilities || null,
        models: p.models || null,
        checkedAt: p.checkedAt || 0,
        probeOk: !!p.ok,
      };
    });
  }

  /* --------------------------------------------------------------- lifecycle */

  async function test(id) { return probe(id); }

  /**
   * Probe something that is NOT stored.
   *
   * This exists because of a specific, easy mistake. If Test only accepts an id,
   * then testing an EDIT means either saving first — so a person discovers a
   * broken endpoint by having written it to disk — or probing the saved record,
   * which means typing a new address, pressing Test, and being told about the
   * OLD address. Both are worse than useless: the first is a side effect nobody
   * asked for and the second is a confident answer to the wrong question.
   *
   * So a draft is validated by the same function that validates a save, built
   * into an adapter, and probed — and never written. `id` is what marks a draft
   * as an edit, and it is used ONLY to inherit the stored key, because the page
   * cannot send the key it was never given.
   */
  async function testDraft(draft) {
    if (!draft || typeof draft !== 'object') {
      return { ok: false, id: '', status: STATUS.ERROR, reason: 'nothing to test', runtime: null };
    }
    const prev = draft.id ? store.getRaw(String(draft.id)) : null;
    if (draft.id && !prev) {
      return { ok: false, id: String(draft.id), status: STATUS.UNAVAILABLE, reason: 'no such runtime: ' + draft.id, runtime: null };
    }
    const norm = store.normRuntime(draft, prev);
    if (!norm.ok) {
      return { ok: false, id: String(draft.id || ''), status: STATUS.ERROR, reason: norm.error, runtime: null };
    }
    /* normRuntime() fills the type default endpoint and inherits the stored key,
     * so the adapter sees the same record a save would have produced. */
    const cfg = norm.runtime;
    let adapter;
    try { adapter = registry.assertAdapter(registry.create(cfg)); }
    catch (e) {
      return { ok: false, id: cfg.id, status: STATUS.UNAVAILABLE, reason: scrub(e.message, cfg), runtime: null };
    }
    let s;
    try { s = await adapter.status(); }
    catch (e) { s = { status: STATUS.ERROR, reason: (e && e.message) || String(e), detail: {} }; }
    const status = STATUSES.includes(s && s.status) ? s.status : STATUS.ERROR;
    return {
      ok: true,
      id: cfg.id,
      status,
      reason: clip(scrub(s && s.reason, cfg)),
      detail: scrubDetail(s && s.detail, cfg),
      capabilities: s && s.capabilities ? sanitiseCaps(s.capabilities, cfg) : null,
      models: s && s.models ? sanitiseModels(s.models, cfg) : null,
      checkedAt: Date.now(),
      runtime: store.publicView(cfg),
      /* Told apart on purpose: the page uses it to decide whether a Test was a
       * question about a draft or a measurement of what is on disk. */
      draft: true,
    };
  }

  async function connect(id) {
    const built = build(id);
    if (!built.ok) return { ok: false, status: STATUS.UNAVAILABLE, error: built.error };
    try {
      const r = await built.adapter.connect();
      const s = STATUSES.includes(r && r.status) ? r.status : STATUS.ERROR;
      return {
        ok: s === STATUS.CONNECTED,
        status: s,
        reason: clip(scrub((r && r.reason) || '', built.cfg)),
        detail: scrubDetail(r && r.detail, built.cfg),
        capabilities: r && r.capabilities ? sanitiseCaps(r.capabilities, built.cfg) : null,
        models: r && r.models ? sanitiseModels(r.models, built.cfg) : null,
      };
    } catch (e) {
      return { ok: false, status: STATUS.ERROR, error: scrub((e && e.message) || String(e), built.cfg) };
    }
  }

  async function disconnect(id) {
    const built = build(id);
    if (!built.ok) return { ok: false, status: STATUS.UNAVAILABLE, error: built.error };
    try {
      const r = await built.adapter.disconnect();
      return {
        ok: true,
        status: STATUSES.includes(r && r.status) ? r.status : STATUS.DISCONNECTED,
        reason: clip(scrub((r && r.reason) || '', built.cfg)),
      };
    } catch (e) {
      return { ok: false, status: STATUS.ERROR, error: scrub((e && e.message) || String(e), built.cfg) };
    }
  }

  function save(input) {
    let out;
    try { out = store.upsert(input); }
    catch (e) { return { ok: false, error: scrub(e.message) }; }
    if (!out.ok) return out;
    /* A newly saved runtime has no status yet. Saying so beats omitting the
       field, which the page would have to guess about. */
    return { ok: true, runtime: out.runtime, status: STATUS.UNAVAILABLE, reason: 'not probed yet', checkedAt: 0 };
  }

  function remove(id) {
    const key = String(id || '');
    /* A probe in flight for a runtime that is about to disappear still resolves
       against a record that is gone. Dropping the future does not cancel the
       request — nothing here should interrupt a probe — it only stops the answer
       being attributed to a runtime that no longer exists. */
    inflight.delete(key);
    try { return store.remove(key); }
    catch (e) { return { ok: false, error: scrub(e.message) }; }
  }

  function describe() {
    const rows = store.publicAll();
    return {
      types: registry.TYPES().map(t => {
        const spec = registry.specFor(t) || {};
        return { type: t, ...spec, label: t.charAt(0).toUpperCase() + t.slice(1) };
      }),
      count: rows.length,
      runtimes: rows,
    };
  }

  /* -------------------------------------------------------------------- run */

  /**
   * Hand a run to a runtime, recording its events in this project's own registry.
   *
   * @param {object} req { id, runId, sessionId, text, history, model }
   * @returns {{ok:boolean, runId:string, view:object|null, status:string, error?:string}}
   */
  async function run(req = {}) {
    const id = String(req.id || req.runtimeId || '');
    const runId = String(req.runId || ('rt_' + Date.now().toString(36)));
    const built = build(id);
    if (!built.ok) return { ok: false, runId, status: STATUS.UNAVAILABLE, error: built.error, view: null };

    const { cfg, adapter } = built;

    /* The same lock every agent run takes. Without it two runtimes could drive
       the browser at once, and the second one's click would land wherever the
       first one left the tab. */
    let record = null;
    if (runs) {
      const claimed = runs.claim(runId, req.sessionId);
      if (!claimed.ok) {
        return {
          ok: false, runId, status: STATUS.ERROR, view: null,
          error: 'another run is still going (' + claimed.live.runId + ')',
        };
      }
      record = claimed.run;
    }

    /* A runtime that is not there has to fail as `unavailable`, and it has to
       fail before the lock is taken, or a misconfigured runtime would hold the
       run table against a run that never started. */
    const ctrl = new AbortController();
    running.set(runId, ctrl);
    const emit = (ev) => {
      if (!record) return;
      /* Verbatim. The page ignores what it does not know, which is the right
         behaviour for a runtime ahead of this build; a re-labelled event would
         not be. */
      try { runs.record(record, ev); } catch (e) { log('runtime event rejected:', scrub(e.message, cfg)); }
    };

    try {
      const out = await adapter.run({
        text: req.text,
        history: req.history,
        model: req.model,
        onEvent: emit,
        signal: ctrl.signal,
        runId,
      });

      /* A runtime that returns without ever emitting a final would leave the
         record unfinished and the lock held until the registry aged it out.
         Writing the end here is what releases it, and it is the only event this
         file authors — a statement about the run, not about the runtime's work. */
      if (record && !record.finished) {
        const answered = out && out.finalText ? String(out.finalText) : '';
        runs.record(record, answered
          ? { type: 'final', text: answered, source: cfg.type, external: true }
          : { type: 'final', text: '', source: cfg.type, external: true, empty: true });
      }
      if (record) runs.finish(record);

      return {
        ok: !!(out && out.ok),
        runId,
        status: (out && out.status) || STATUS.CONNECTED,
        externalId: (out && out.externalId) || '',
        error: out && out.ok ? '' : clip(scrub((out && out.reason) || 'the runtime returned nothing', cfg)),
        view: runs ? runs.view(runId) : null,
      };
    } catch (e) {
      const st = (e && e.status) || STATUS.ERROR;
      const msg = clip(scrub((e && e.message) || String(e), cfg));
      /* Recorded, so a page that reattaches sees the failure rather than a run
         that is still going. */
      if (record) { runs.record(record, { type: 'error', error: msg, status: st }); runs.finish(record); }
      return { ok: false, runId, status: st, error: msg, view: runs ? runs.view(runId) : null };
    } finally {
      running.delete(runId);
    }
  }

  /** ask a runtime to stop its own run. Separate from the lock: stopping a run
   *  and freeing the lock are different acts and the caller usually wants both. */
  async function stop(req = {}) {
    const built = build(String(req.id || ''));
    if (!built.ok) return { ok: false, error: built.error };
    if (runs && req.runId) {
      const live = runs.live();
      if (live) runs.cancel(live.runId);
    }
    /* Abort first, then ask the runtime to stop on its own terms. The abort is
       what cuts the stream off this side immediately; the POST is what tells
       Hermes the work is not wanted. Doing only the second leaves this process
       reading a stream nobody is going to act on. */
    const ctrl = running.get(String(req.runId || ''));
    if (ctrl) ctrl.abort();
    try {
      const r = await built.adapter.stop({ id: req.externalId || req.runId || '' });
      return { ok: !!(r && r.stopped), reason: clip(scrub((r && r.reason) || '', built.cfg)), status: STATUS.DISCONNECTED };
    } catch (e) {
      return { ok: false, error: clip(scrub((e && e.message) || String(e), built.cfg)) };
    }
  }

  async function capabilities(id) {
    const built = build(String(id || ''));
    if (!built.ok) return { ok: false, tools: [], error: built.error };
    try {
      const r = await built.adapter.capabilities();
      return sanitiseCaps(r, built.cfg);
    } catch (e) {
      return { ok: false, tools: [], error: scrub((e && e.message) || String(e), built.cfg) };
    }
  }

  return {
    /* configuration — never probes, so it is cheap enough to call on every load */
    list: store.publicAll, describe, save, remove,
    /* live state */
    probe, statusAll, test, testDraft, connect, disconnect, capabilities,
    /* work */
    run, stop,
    /* for tests and for a route that needs the secret server-side */
    store, registry,
  };
}

module.exports = { createManager, scrub, clip, STATUS, RuntimeError };
