'use strict';
/* ====================================================================== *
 *  ai/runtimes/adapters/hermes.js — the Hermes agent runtime.
 *
 *  Hermes is reached over its API server, not by driving a CLI: it already
 *  speaks HTTP, it already streams runs, and a subprocess that has to be parsed
 *  would be a worse integration of something that has a better one.
 *
 *  The contract, all of it optional except the first two:
 *
 *    GET  /v1/capabilities        what this build can do — the one that decides
 *                                whether a run is possible at all
 *    GET  /v1/models             the models it will serve
 *    GET  /v1/health              liveness, on some builds
 *    POST /v1/chat/completions    one shot, no tools of ours involved
 *    POST /v1/runs                a run with events
 *    GET  /v1/runs/{id}           poll a run
 *    GET  /v1/runs/{id}/events    stream a run's events
 *    POST /v1/runs/{id}/stop      stop it
 *
 *  Three rules this adapter holds itself to, and they are the reason it is worth
 *  having as its own file rather than a config flag on the custom adapter:
 *
 *  1. connected is only ever reported from a successful HTTP response. A Hermes
 *     that is not installed produces `unavailable` with the reason, and a Hermes
 *     that is installed but idle produces the same thing with a different reason.
 *     Neither is ever dressed up as disconnected-and-fine.
 *
 *  2. Capabilities come from /v1/capabilities, not from a list written here. A
 *     hard-coded list is a list of what somebody believed in the month it was
 *     written, and it goes on the screen as though it were a fact.
 *
 *  3. Events are forwarded verbatim. This file does not translate, rename, or
 *     synthesise, because ai/runs.js records what it is given and the canvas and
 *     the activity dock read that record. An event invented here would be shown
 *     to the user as something Hermes said.
 *
 *  The default endpoint is localhost because that is where the API server binds
 *  by default. It is a DEFAULT, in the store and in the form, and it is
 *  overwritten the moment anyone types a different one.
 * ====================================================================== */

const {
  BaseAdapter, STATUS, RuntimeError,
  joinUrl, timedFetch, transportStatus, httpStatus,
} = require('./base');

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8642';
const DEFAULT_TIMEOUT_MS = 4000;

/* The endpoints, named once. A path that changes is a change here and nowhere
   else, and a path that is not in this list is not called. */
const EP = {
  capabilities: '/v1/capabilities',
  models: '/v1/models',
  health: '/health',
  runs: '/v1/runs',
};

class HermesAdapter extends BaseAdapter {
  static get runtimeType() { return 'hermes'; }

  constructor(config) {
    super(config);
    /* Read once, at construction, and never mutated afterwards. A probe that
       re-reads its endpoint could answer from two different servers inside one
       poll, and the two answers would disagree. */
    this.endpoint = String(this.config.endpoint || DEFAULT_ENDPOINT).trim().replace(/\/+$/, '');
    this.timeoutMs = Math.max(300, Number(this.config.timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.apiKey = String(this.config.apiKey || '');
    this.model = String(this.config.model || '').trim();
    /* Probed once per status() call and handed to the rest of it, so one poll
       makes one round trip rather than four. */
    this._probe = null;
  }

  describe() {
    return { type: this.type, name: this.name, endpoint: this.endpoint, model: this.model || 'default' };
  }

  /* ---------------------------------------------------------------- http */

  headers() {
    const h = { accept: 'application/json' };
    /* Only sent when there is one. Sending `Authorization: Bearer ` with an
       empty token is a 401 from a server that would otherwise have let an
       unauthenticated local request through. */
    if (this.apiKey) h.authorization = 'Bearer ' + this.apiKey;
    return h;
  }

  url(path) { return joinUrl(this.endpoint, path); }

  /**
   * One GET, and a status out of it. Never throws: a status check that throws
   * takes the whole poll down, and the one thing a reviewer needs when Hermes is
   * down is to be told so.
   */
  async get(path) {
    try {
      const res = await timedFetch(this.url(path), { headers: this.headers(), timeoutMs: this.timeoutMs });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      return { ok: res.ok, status: res.status, body, text: String(text || '').slice(0, 400) };
    } catch (e) {
      return { ok: false, status: 0, body: null, error: e, status5: transportStatus(e) };
    }
  }

  /* ------------------------------------------------------------- status */

  /**
   * The real question, asked of the real runtime.
   *
   * /v1/capabilities is the probe because it is the only endpoint whose absence
   * means "this is not a Hermes" rather than "this build does not do that". A
   * 404 there is `unavailable`; a 401 is `authentication_error`; anything else
   * that answered is `error`. A transport failure is `unavailable` with the
   * reason spelled out, which is the difference between a message somebody can
   * act on and one they have to guess at.
   */
  async status() {
    const probe = await this.get(EP.capabilities);
    this._probe = probe;

    if (probe.status === 0) {
      /* Not running, or not there. The endpoint is named because "unavailable"
         on its own sends people looking in the wrong place. */
      const why = probe.error && probe.error.name === 'AbortError'
        ? 'no answer from ' + this.endpoint + ' within ' + this.timeoutMs + 'ms'
        : 'nothing is answering on ' + this.endpoint;
      return {
        status: STATUS.UNAVAILABLE,
        reason: why,
        detail: { endpoint: this.endpoint, timeoutMs: this.timeoutMs, probe: EP.capabilities },
        capabilities: null,
        models: null,
        checkedAt: Date.now(),
      };
    }

    const mapped = httpStatus(probe, probe.text);
    if (mapped === STATUS.CONNECTED) {
      this.connected = true;
      const caps = this.readCapabilities(probe.body);
      /* One more call, and only on the success path: if capabilities came back
         200 then asking for the model list is cheap and tells the reviewer
         whether this build can actually serve a run. */
      const models = await this.get(EP.models);
      return {
        status: STATUS.CONNECTED,
        reason: '',
        detail: {
          endpoint: this.endpoint,
          probe: EP.capabilities,
          httpStatus: probe.status,
          /* The raw reply, but ONLY when the capability document was not one this
             adapter recognises. A reader who is told "connected, and here is
             nothing I can list" needs to see what actually came back in order to
             add the shape, and an empty list on its own reads as "this runtime
             can do nothing", which is a different and wrong statement. */
          ...(caps.ok ? {} : { said: probe.text }),
        },
        capabilities: caps,
        models: this.readModels(models),
        checkedAt: Date.now(),
      };
    }

    this.connected = false;
    return {
      status: mapped,
      reason: mapped === STATUS.AUTH
        ? 'Hermes refused the credential'
        : 'Hermes answered ' + probe.status + ' on ' + EP.capabilities,
      detail: { endpoint: this.endpoint, probe: EP.capabilities, httpStatus: probe.status, said: probe.text },
      capabilities: null,
      models: null,
      checkedAt: Date.now(),
    };
  }

  /**
   * Read the capability document without assuming its shape.
   *
   * The order matters and the first version of this got it wrong in a way that
   * was invisible: a body of {capabilities:[...], version:"1.4"} has keys, so
   * "read the keys" looked like it worked and returned the two field NAMES as
   * though they were capabilities. So the named containers are checked first, and
   * a body that is itself a list is read as a list.
   *
   * What is deliberately NOT here is a fallback that reads a bare object as a map
   * of tool names. It would have handled `{browser:{},shell:{}}`, and it also
   * turned `{version:"1.4"}` into a capability called "version" and
   * `{note:"nope"}` into a capability called "note" — invented facts, produced
   * from a document whose actual shape nobody has confirmed. Four real shapes are
   * recognised; a reply in none of them yields an empty list plus the raw body in
   * the status detail, which is something a person can act on and a guess is not.
   */
  readCapabilities(body) {
    if (!body || typeof body !== 'object') {
      return { ok: false, tools: [], source: null, note: 'no capability document in the reply' };
    }
    const names = (v) => {
      if (Array.isArray(v)) return v.map(x => String((x && (x.id || x.name)) || x)).filter(Boolean);
      if (v && typeof v === 'object') return Object.keys(v);
      return [];
    };

    if (Array.isArray(body)) {
      const tools = body.map(String).filter(Boolean).sort();
      return { ok: tools.length > 0, tools, source: tools.length ? 'array' : null, version: '', note: tools.length ? '' : 'the list was empty' };
    }

    for (const key of ['capabilities', 'tools', 'features']) {
      if (body[key] == null) continue;
      const tools = names(body[key]).sort();
      if (tools.length) {
        return { ok: true, tools, source: key, version: body.version || body.hermes || '', note: '' };
      }
    }
    return {
      ok: false,
      tools: [],
      source: null,
      version: body.version || body.hermes || '',
      note: 'the reply carried no capability list in any shape this adapter knows',
    };
  }

  readModels(got) {
    if (!got || !got.ok || !got.body) return { ok: false, list: [] };
    const b = got.body;
    const list = Array.isArray(b) ? b
      : Array.isArray(b.data) ? b.data
        : Array.isArray(b.models) ? b.models : [];
    return {
      ok: list.length > 0,
      list: list.map(m => (typeof m === 'string' ? m : String((m && (m.id || m.name)) || ''))).filter(Boolean),
    };
  }

  /* --------------------------------------------------------- capabilities */

  /** What Hermes can actually do, asked now and not remembered. */
  async capabilities() {
    const s = await this.status();
    if (s.status !== STATUS.CONNECTED) {
      return { ok: false, tools: [], reason: s.reason || s.status, status: s.status };
    }
    return { ok: true, tools: s.capabilities.tools, models: s.models.list, version: s.capabilities.version };
  }

  async connect() {
    const s = await this.status();
    /* connect() and status() are the same act for an HTTP runtime and saying so is
       better than pretending there is a handshake. What differs is only the
       framing of the answer. */
    return {
      ok: s.status === STATUS.CONNECTED,
      status: s.status,
      reason: s.reason,
      detail: s.detail,
      capabilities: s.capabilities,
      models: s.models,
    };
  }

  async disconnect() {
    /* There is no session to close. Hermes holds no per-client state, so the
       honest implementation of disconnect for an HTTP runtime is: forget that
       we were connected, and say so. Pretending to tear something down here
       would be the first fake in this file. */
    this.connected = false;
    this._probe = null;
    return { status: STATUS.DISCONNECTED, reason: 'Hermes holds no session; nothing to close' };
  }

  /* ------------------------------------------------------------------ run */

  /**
   * Start a run, and forward its events as they arrive.
   *
   * Events go out byte-for-byte as Hermes wrote them. runApply() in the browser
   * ignores the ones it does not know, which is the right behaviour for a
   * runtime that is ahead of this page, and the wrong behaviour for an adapter
   * that renames them into things this page does recognise.
   */
  async run({ text, history, model, onEvent, signal, runId } = {}) {
    const s = await this.status();
    if (s.status !== STATUS.CONNECTED) {
      throw new RuntimeError('Hermes is not available: ' + (s.reason || s.status), s.status, { detail: s.detail });
    }

    const body = {
      input: String(text || ''),
      ...(history && history.length ? { history } : {}),
      ...(this.model || model ? { model: model || this.model } : {}),
      ...(runId ? { external_run_id: runId } : {}),
    };

    const started = await this.post(EP.runs, body);
    if (!started.ok) {
      throw new RuntimeError('Hermes refused the run: ' + (started.text || started.status), started.status5 || STATUS.ERROR, {});
    }
    const id = String((started.body && (started.body.id || started.body.run_id)) || '');
    if (!id) {
      throw new RuntimeError('Hermes accepted the run and returned no id, so there is nothing to follow', STATUS.ERROR, {});
    }

    /* Hermes owns the run from here. This returns as soon as it is created, and
       the events arrive over the stream below — which is what lets the caller
       record the run in ai/runs.js at the same moment Hermes does, rather than
       after. */
    const streamed = await this.stream({ id, onEvent, signal });
    return {
      ok: true,
      externalId: id,
      status: streamed.status,
      reason: streamed.reason,
      finalText: streamed.finalText,
    };
  }

  async post(path, payload) {
    try {
      const res = await timedFetch(this.url(path), {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs: this.timeoutMs,
      });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      return { ok: res.ok, status: res.status, body, text: String(text || '').slice(0, 400), status5: httpStatus(res, text) };
    } catch (e) {
      return { ok: false, status: 0, body: null, text: '', error: e, status5: transportStatus(e) };
    }
  }

  /**
   * Follow a run's events.
   *
   * Server-sent events, parsed by hand, because this project has no ws or
   * eventsource dependency on the server side and adding one to read a text
   * format would be a strange trade. The parser is the same shape as the one in
   * server.js's own SSE writer consumes on the client.
   */
  async stream({ id, onEvent, signal } = {}) {
    const emit = typeof onEvent === 'function' ? onEvent : () => {};
    const url = this.url(EP.runs + '/' + encodeURIComponent(id) + '/events');
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) return { status: STATUS.DISCONNECTED, reason: 'stopped before it started', finalText: '' };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    let res;
    try {
      res = await fetch(url, { headers: this.headers(), signal: ctrl.signal });
    } catch (e) {
      if (signal) signal.removeEventListener('abort', onAbort);
      throw new RuntimeError('could not open the event stream: ' + ((e && e.message) || e), transportStatus(e), {});
    }
    if (!res.ok || !res.body) {
      if (signal) signal.removeEventListener('abort', onAbort);
      const mapped = httpStatus(res, '');
      throw new RuntimeError('the event stream returned ' + res.status, mapped, {});
    }

    let finalText = '';
    let lastStatus = STATUS.CONNECTED;
    try {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6);
            let ev = null;
            try { ev = JSON.parse(raw); } catch { continue; }
            if (!ev || typeof ev !== 'object') continue;
            /* Forwarded whole. Whatever Hermes called it, ai/runs.js records it and
               the page decides what it understands. */
            emit(ev);
            if (ev.type === 'final' || ev.type === 'run.completed') {
              finalText = String(ev.text || ev.output || ev.answer || finalText || '');
              lastStatus = STATUS.CONNECTED;
            }
            if (ev.type === 'error') lastStatus = STATUS.ERROR;
          }
        }
      }
    } catch (e) {
      if (signal && signal.aborted) {
        lastStatus = STATUS.DISCONNECTED;
      } else {
        throw new RuntimeError('the event stream broke: ' + ((e && e.message) || e), transportStatus(e), {});
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      try { await reader && reader.cancel && reader.cancel(); } catch { /* already closed */ }
    }
    return { status: lastStatus, reason: '', finalText };
  }

  async stop({ id } = {}) {
    if (!id) return { stopped: false, reason: 'no run id' };
    const res = await this.post(EP.runs + '/' + encodeURIComponent(id) + '/stop', {});
    return { stopped: res.ok, reason: res.ok ? '' : (res.text || res.status) };
  }
}

HermesAdapter.DEFAULT_ENDPOINT = DEFAULT_ENDPOINT;
HermesAdapter.DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
HermesAdapter.ENDPOINTS = EP;

module.exports = { HermesAdapter, DEFAULT_ENDPOINT, DEFAULT_TIMEOUT_MS, EP };
