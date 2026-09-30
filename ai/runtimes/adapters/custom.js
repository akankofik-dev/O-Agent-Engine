'use strict';
/* ====================================================================== *
 *  ai/runtimes/adapters/custom.js — any runtime that speaks one HTTP contract.
 *
 *  The useful thing about this adapter is not that it runs anything. It is that
 *  it is how the next runtime gets added without a new file: a runtime that has
 *  an OpenAI-compatible /v1/models and /v1/chat/completions is describable in
 *  the form, and a person can try one this minute that nobody here has heard of.
 *
 *  It is also the honest floor of the whole system. It has no run streaming — a
 *  plain completions call returns a whole answer, not a sequence of events — so
 *  run() emits one `final` and says that is what happened. A one-shot is not a
 *  stream with the events left out, and pretending otherwise would put a run in
 *  the activity dock that looks like it watched something happen.
 * ====================================================================== */

const {
  BaseAdapter, STATUS, RuntimeError,
  joinUrl, timedFetch, transportStatus, httpStatus,
} = require('./base');

class CustomAdapter extends BaseAdapter {
  static get runtimeType() { return 'custom'; }

  constructor(config) {
    super(config);
    this.endpoint = String(this.config.endpoint || '').trim().replace(/\/+$/, '');
    this.timeoutMs = Math.max(300, Number(this.config.timeoutMs) || 8000);
    this.apiKey = String(this.config.apiKey || '');
    this.model = String(this.config.model || '').trim();
    /* Where a CLI-style runtime expects to be invoked. Accepted and carried
       because the form asks for it and because the next adapter will want it,
       but this one does not use it and does not pretend to. */
    this.cwd = String(this.config.cwd || '').trim();
  }

  describe() {
    return {
      type: this.type, name: this.name, endpoint: this.endpoint,
      model: this.model || 'default', mode: this.cwd ? 'http + cwd' : 'http',
    };
  }

  headers() {
    const h = { accept: 'application/json' };
    if (this.apiKey) h.authorization = 'Bearer ' + this.apiKey;
    return h;
  }

  async get(path) {
    if (!this.endpoint) {
      return { ok: false, status: 0, body: null, text: '', reason: 'no endpoint is configured' };
    }
    try {
      const res = await timedFetch(joinUrl(this.endpoint, path), {
        headers: this.headers(), timeoutMs: this.timeoutMs,
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
   * A custom runtime is connected when it answers /v1/models, because that is
   * the one endpoint an OpenAI-compatible server cannot serve without. A server
   * that answers something else is reported with what it actually said.
   */
  async status() {
    if (!this.endpoint) {
      return { status: STATUS.UNAVAILABLE, reason: 'no endpoint is configured', detail: {}, checkedAt: Date.now() };
    }
    const got = await this.get('/v1/models');
    if (got.status === 0) {
      return {
        status: STATUS.UNAVAILABLE,
        reason: got.reason || ('nothing is answering on ' + this.endpoint),
        detail: { endpoint: this.endpoint, timeoutMs: this.timeoutMs, probe: '/v1/models' },
        models: null, capabilities: null, checkedAt: Date.now(),
      };
    }
    const mapped = httpStatus(got, got.text);
    if (mapped === STATUS.CONNECTED) {
      this.connected = true;
      const list = Array.isArray(got.body) ? got.body
        : Array.isArray(got.body && got.body.data) ? got.body.data : [];
      return {
        status: STATUS.CONNECTED, reason: '',
        detail: { endpoint: this.endpoint, probe: '/v1/models', httpStatus: got.status },
        models: { ok: list.length > 0, list: list.map(m => String((m && (m.id || m.name)) || m)).filter(Boolean) },
        /* No capability document. Said plainly, because an empty list and a list
           nobody asked for look identical on a screen otherwise. */
        capabilities: { ok: false, tools: [], note: 'this runtime has no capability endpoint' },
        checkedAt: Date.now(),
      };
    }
    this.connected = false;
    return {
      status: mapped,
      reason: mapped === STATUS.AUTH ? 'the endpoint refused the credential'
        : 'the endpoint answered ' + got.status + ' on /v1/models',
      detail: { endpoint: this.endpoint, probe: '/v1/models', httpStatus: got.status, said: got.text },
      models: null, capabilities: null, checkedAt: Date.now(),
    };
  }

  async capabilities() {
    const s = await this.status();
    if (s.status !== STATUS.CONNECTED) return { ok: false, tools: [], reason: s.reason || s.status, status: s.status };
    /* Models are not capabilities. What this runtime can DO is unknown until it
       says so, and the two must not be shown as one list. */
    return { ok: false, tools: [], models: s.models.list, reason: 'not declared by this runtime' };
  }

  async connect() {
    const s = await this.status();
    return { ok: s.status === STATUS.CONNECTED, status: s.status, reason: s.reason, detail: s.detail, models: s.models };
  }

  async disconnect() {
    this.connected = false;
    return { status: STATUS.DISCONNECTED, reason: 'nothing is held open between calls' };
  }

  /**
   * One completion, emitted as one final event.
   *
   * The single emitted event is the honest shape of a non-streaming call, and it
   * is deliberately not dressed up as a run with intermediate steps: the activity
   * dock would then show a step that never happened.
   */
  async run({ text, history, model, onEvent, signal } = {}) {
    const s = await this.status();
    if (s.status !== STATUS.CONNECTED) {
      throw new RuntimeError('the endpoint is not available: ' + (s.reason || s.status), s.status, { detail: s.detail });
    }
    if (signal && signal.aborted) return { ok: false, status: STATUS.DISCONNECTED, reason: 'stopped before it started', finalText: '' };

    const messages = []
      .concat(Array.isArray(history) ? history : [])
      .concat([{ role: 'user', content: String(text || '') }]);

    /* The caller's signal and this adapter's timeout, combined into one
       controller. Passing the caller's signal through alone would leave the
       request with no deadline at all, and a run that never returns is a run
       whose lock is never released. */
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const onAbort = () => ctrl.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    let res, body = null, raw = '';
    try {
      res = await fetch(joinUrl(this.endpoint, '/v1/chat/completions'), {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify({
          model: model || this.model || undefined,
          messages,
          stream: false,
        }),
        signal: ctrl.signal,
      });
      raw = await res.text();
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    } catch (e) {
      /* An abort caused by the caller's stop is a stop, not a failure to reach
         the endpoint — saying "unavailable" for it would report the runtime as
         broken when the person simply pressed stop. */
      if (signal && signal.aborted) {
        return { ok: false, status: STATUS.DISCONNECTED, reason: 'stopped', finalText: '' };
      }
      throw new RuntimeError('the completion call failed: ' + ((e && e.message) || e), transportStatus(e), {});
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    if (!res.ok) {
      throw new RuntimeError('the endpoint answered ' + res.status + ': ' + raw.slice(0, 200), httpStatus(res, raw), {});
    }

    const answer = String(
      (body && body.choices && body.choices[0] && (body.choices[0].message || {}).content) || '',
    );
    if (typeof onEvent === 'function') {
      onEvent({ type: 'final', text: answer, source: 'custom', non_streaming: true });
    }
    return { ok: true, status: STATUS.CONNECTED, reason: '', finalText: answer };
  }

  async stop() {
    /* Nothing to stop: the call is in flight or it is not, and the browser
       already has the AbortController for the latter. Saying "stopped: false"
       is the true answer, where a fake true would look like it worked. */
    return { stopped: false, reason: 'this runtime has no run to stop' };
  }
}

module.exports = { CustomAdapter };
