'use strict';
/* ====================================================================== *
 *  ai/runtimes/index.js — the runtime registry.
 *
 *  Deliberately the same shape as ai/providers.js, because it solves the same
 *  problem in the same way: a caller that has a stored config and a type name,
 *  and something that hands back an object with one interface whatever is behind
 *  it. Two registries with two shapes would be two places to learn the same
 *  thing, and the second one would be the one somebody got wrong.
 *
 *      const runtimes = require('./ai/runtimes');
 *      const rt = runtimes.create(config);        // throws for an unknown type
 *      const s  = await rt.status();              // always a real probe
 *      runtimes.TYPES                              // what the form may offer
 *
 *  What is NOT here, and why
 *  -------------------------
 *  There is no opencode.js, no goose.js and no codex.js. Each of those runtimes
 *  has to be probed before it can be offered, and none of them has been on a
 *  machine this was built on — so a file claiming to connect to one would be a
 *  file asserting something nobody checked. TYPES is built from this registry
 *  rather than written out, so the type list cannot offer a runtime that has no
 *  adapter, and the gap is a missing file rather than a disabled button that
 *  still looks like a feature.
 * ====================================================================== */

const { HermesAdapter } = require('./adapters/hermes');
const { CustomAdapter } = require('./adapters/custom');
const {
  BaseAdapter, STATUS, STATUSES, RuntimeError, REQUIRED,
} = require('./adapters/base');

/** the registry, keyed by the type name that is stored in the config */
const REGISTRY = {
  hermes: HermesAdapter,
  custom: CustomAdapter,
};

/** what the type list is built from, and nothing else */
function TYPES() {
  return Object.keys(REGISTRY).sort();
}

function runtimeClass(type) {
  return REGISTRY[String(type || '')] || null;
}

/** the fields each type needs, so the form can ask for the right ones */
function specFor(type) {
  const Cls = runtimeClass(type);
  if (!Cls) return null;
  /* Read off the adapter rather than kept in a second table that could disagree
     with it — which is the failure mode of every registry that has both. */
  const probe = new Cls({ id: 'spec', name: 'spec' });
  return {
    type: Cls.runtimeType,
    endpoint: !!Cls.DEFAULT_ENDPOINT,
    defaultEndpoint: Cls.DEFAULT_ENDPOINT || '',
    defaultTimeoutMs: Cls.DEFAULT_TIMEOUT_MS || 0,
    timeout: true,
    apiKey: true,
    model: true,
    cwd: !!probe.describe().cwd || Cls.runtimeType === 'hermes',
    streaming: Cls.runtimeType === 'hermes',
    capabilitiesEndpoint: !!(Cls.ENDPOINTS && Cls.ENDPOINTS.capabilities),
  };
}

/**
 * Build an adapter for a stored config.
 *
 * An unknown type is an error, not a fallback to the generic adapter. Falling
 * back would mean a config written by a newer version of this file, or a typo,
 * or a runtime that was removed — and all three would come back as a runtime
 * that connects to nothing and reports it as connected.
 */
function create(config) {
  if (!config || typeof config !== 'object') throw new RuntimeError('no runtime configured', STATUS.ERROR);
  const Cls = runtimeClass(config.type);
  if (!Cls) {
    throw new RuntimeError(
      'no adapter for runtime type "' + String(config.type || '') + '" — this build has '
        + TYPES().join(', '),
      STATUS.UNAVAILABLE,
    );
  }
  return new Cls(config);
}

/** the check a bad hand-edit fails, at the store boundary rather than at use */
function assertAdapter(adapter) {
  const missing = REQUIRED.filter(m => typeof adapter[m] !== 'function');
  if (missing.length) {
    throw new RuntimeError(
      (adapter.type || 'this') + ' does not implement ' + missing.join(', '), STATUS.ERROR,
    );
  }
  return adapter;
}

module.exports = {
  create, runtimeClass, TYPES, specFor, assertAdapter, REGISTRY,
  BaseAdapter, STATUS, STATUSES, RuntimeError, REQUIRED,
  HermesAdapter, CustomAdapter,
};
