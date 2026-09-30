'use strict';
/* ====================================================================== *
 *  ai/runtimes/adapters/base.js — what every agent runtime has to be able to do.
 *
 *  This is deliberately the same shape as ai/providers.js: one normalised
 *  interface, a registry keyed by a short type name, and a create() that hands
 *  back something the caller never has to type-check. The agent engine only ever
 *  sees run()/stop() and an event callback, and never knows which runtime is
 *  behind the socket — the same property that keeps a vendor from reaching the
 *  browser controller.
 *
 *  The five states, and why there are five
 *  --------------------------------------
 *    connected            a real probe of the real runtime succeeded, just now
 *    disconnected         the runtime is there and refused us
 *    unavailable          nothing is listening / nothing is installed
 *    authentication_error the runtime answered and said the credential is wrong
 *    error                anything else
 *
 *  The first one is the only one that is allowed to be reported on the strength
 *  of anything other than a successful call. There is no "configured" state that
 *  reads as working, and there is no cached connected: a status that was true when
 *  it was asked and is not true now is a lie with a timestamp on it. status()
 *  probes every time it is called, and the manager never memoises it.
 *
 *  A missing runtime is a first-class answer, not a failure of this module.
 *  Hermes is not installed on every machine and the refusal has to be legible:
 *  "unavailable: nothing is listening on 127.0.0.1:8642" tells somebody what to
 *  do, and "error" does not.
 * ====================================================================== */

const STATUS = {
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  UNAVAILABLE: 'unavailable',
  AUTH: 'authentication_error',
  ERROR: 'error',
};

/** every status a runtime may report, for validation at the store boundary */
const STATUSES = Object.values(STATUS);

/** an error that carries a status, so a caller does not have to map a message */
class RuntimeError extends Error {
  constructor(message, status, fact) {
    super(String(message || '').slice(0, 400));
    this.name = 'RuntimeError';
    this.status = STATUSES.includes(status) ? status : STATUS.ERROR;
    if (fact && typeof fact === 'object') this.fact = fact;
  }
}

/** the shape every adapter fills in, so a missing method fails at construction
 *  rather than the first time somebody presses Run */
const REQUIRED = ['connect', 'disconnect', 'status', 'run', 'stop', 'capabilities'];

/* ---------------------------------------------------------------- helpers */

/** a base URL with no trailing slash, so join() below is predictable */
function joinUrl(base, suffix) {
  const b = String(base || '').trim().replace(/\/+$/, '');
  const s = String(suffix || '').replace(/^\/+/, '');
  return b ? b + '/' + s : s;
}

/** the last four of a secret, and nothing else. The key itself never leaves. */
function keyHint(key) {
  const k = String(key || '');
  if (!k) return '';
  return k.length <= 4 ? '••••' : '••••' + k.slice(-4);
}

/**
 * A fetch with a timeout, because a runtime that accepts a connection and then
 * says nothing is the single most common way a status check hangs the page.
 *
 * AbortController rather than a race on the promise: a timed-out fetch that is
 * only raced leaves the request open and the socket held, and a status endpoint
 * polled every few seconds adds up.
 */
async function timedFetch(url, opts) {
  const o = opts || {};
  const ms = Math.max(200, Number(o.timeoutMs) || 4000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      method: o.method || 'GET',
      headers: o.headers || {},
      body: o.body,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** map a transport failure onto a status, so no adapter invents its own wording */
function transportStatus(err) {
  const m = String((err && (err.name + ' ' + err.message)) || err || '');
  if (/abort|timeout/i.test(m)) return STATUS.UNAVAILABLE;
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|fetch failed|socket/i.test(m)) {
    return STATUS.UNAVAILABLE;
  }
  return STATUS.ERROR;
}

/** the auth failures a runtime is likely to answer with, as a family */
const AUTH_STATUS = new Set([401, 403]);

/**
 * Classify an HTTP response into a status.
 *
 * The body is read because most runtimes say *why* in it, and a reviewer looking
 * at a red row needs the sentence rather than the number. It is clipped hard
 * because a runtime that is misconfigured can echo its own config back, and this
 * string is going to a browser.
 */
function httpStatus(res, body) {
  if (res.ok) return STATUS.CONNECTED;
  if (AUTH_STATUS.has(res.status)) return STATUS.AUTH;
  if (res.status === 404 || res.status === 502 || res.status === 503) return STATUS.UNAVAILABLE;
  return STATUS.ERROR;
}

/* ------------------------------------------------------------------ base */

class BaseAdapter {
  /**
   * @param {object} config the stored, normalised runtime record
   */
  constructor(config) {
    this.config = config || {};
    this.id = this.config.id || '';
    this.name = this.config.name || this.id;
    /* Subclasses set this. It is the one thing the manager needs before it can
       call anything else, and a missing one is a bug in the adapter rather than
       something to discover at probe time. */
    this.type = this.constructor.runtimeType || 'custom';
    this.connected = false;
  }

  /* what this adapter is called in the registry */
  static get runtimeType() { return 'base'; }

  /* one line, for the list row. The default is honest about being generic. */
  describe() {
    return { type: this.type, name: this.name, endpoint: this.config.endpoint || '' };
  }

  /* The five below are the contract. The base answers honestly for all of them
     rather than throwing, so a half-written adapter produces a runtime that says
     "unavailable" instead of a crash in the middle of a status poll. */

  async connect() { return this.status(); }
  async disconnect() { this.connected = false; return { status: STATUS.DISCONNECTED }; }

  async status() {
    return { status: STATUS.UNAVAILABLE, reason: 'this adapter does not know how to check', detail: {} };
  }

  async run() {
    throw new RuntimeError('this adapter cannot run anything', STATUS.UNAVAILABLE);
  }

  async stop() { return { stopped: false }; }

  /**
   * What this runtime can actually do, right now.
   *
   * Probed, never declared. An adapter that returns a hard-coded list is lying
   * about a machine it has not looked at, and the list ends up on a screen as
   * though it were a fact.
   */
  async capabilities() { return { ok: false, tools: [], reason: 'not probed' }; }
}

BaseAdapter.STATUS = STATUS;
BaseAdapter.STATUSES = STATUSES;
BaseAdapter.RuntimeError = RuntimeError;
BaseAdapter.REQUIRED = REQUIRED;
BaseAdapter.joinUrl = joinUrl;
BaseAdapter.keyHint = keyHint;
BaseAdapter.timedFetch = timedFetch;
BaseAdapter.transportStatus = transportStatus;
BaseAdapter.httpStatus = httpStatus;
BaseAdapter.AUTH_STATUS = AUTH_STATUS;

module.exports = {
  BaseAdapter,
  STATUS,
  STATUSES,
  RuntimeError,
  REQUIRED,
  joinUrl,
  keyHint,
  timedFetch,
  transportStatus,
  httpStatus,
  AUTH_STATUS,
};
