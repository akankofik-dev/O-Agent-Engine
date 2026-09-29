'use strict';
/* ========================================================================= *
 *  discover.js — Level 5 (SELF-DISCOVER).
 *
 *  The problem this exists for
 *  --------------------------
 *  An agent that can build engines will build them. Give it `create_engine` and
 *  a task like "take the data from X and turn it into format Y", and the
 *  shortest path to looking busy is to invent an engine. That is the failure
 *  this file is built to make impossible, and the guard is the whole point:
 *
 *      an engine is proposed only when a capability is measured to be missing
 *      and no registered engine declares it
 *
 *  Not when the model would like one. Not when a task is hard. Only when the
 *  registry has been asked and the answer was no.
 *
 *  What it reads
 *  -------------
 *  Capabilities come out of the live registry — the engines the router can
 *  actually route to right now — and not out of a hardcoded list. An engine that
 *  is on disk but not registered has no capabilities as far as planning is
 *  concerned, because an agent cannot use what the router will not hand it.
 *
 *  What it does not do
 *  -------------------
 *  It does not build anything. Planning and building are separate acts, and the
 *  separation is the safety property: the plan is a decision that can be
 *  examined and refused before any code exists, and building still goes through
 *  create_engine and its gate. A planner that built engines would be a builder
 *  that could talk itself into it.
 * ========================================================================= */

/* Planning reads the router and nothing else. It deliberately does not require
 * the forge: a planner that could build is a builder that can talk itself into
 * it, and the separation is the safety property. Nothing in this file writes.
 *
 * The vocabulary a plan is written in is the router's own: a requirement names
 * what it needs execute() to do, and the router's `needed()` is what decides
 * whether an engine can be handed that kind of action. A different word here
 * would mean planning against a capability nothing routes on. */
const KNOWN_KINDS = require('./ai/automation').needed;

/** every kind the router can route, as a flat list */
function kinds() {
  const out = new Set();
  for (const k of ['navigate', 'observe', 'screenshot', 'tabs', 'precise', 'act', 'semantic', 'extract', 'task', 'default']) {
    for (const c of KNOWN_KINDS(k)) out.add(c);
  }
  return Array.from(out).sort();
}

/**
 * What the registry can do right now, read from the engines the router holds.
 *
 * @param {object} router what createRouter returned
 */
function capabilities(router) {
  /* Two maps, and the difference between them is the whole point of this
     function. `owners` counts every engine that declares a capability;
     `capabilities` counts only the ones that are available. An engine that is
     switched off is in the first and not the second, which is what lets a plan
     say "you have this, it is off" instead of "nobody has this" — and those
     two answers send the agent in opposite directions. The first version of
     this file had one map, which made the first answer unreachable and left
     plan().disabled permanently empty. */
  const owners = new Map();
  const byCapability = new Map();
  const engines = [];
  if (!router || !router.BY_ID) return { capabilities: {}, owners: {}, engines: [], total: 0 };

  for (const id of router.BY_ID.keys()) {
    const h = router.health.get(id);
    /* An engine that is not available cannot serve a task, so it is counted
       separately rather than lumped in with the ones that can. Refusing a plan
       because an engine exists but is switched off would be the wrong way
       round: the honest answer is "nothing has it right now", and the agent
       then has a reason to ask for it to be enabled rather than a reason to
       build a second copy. */
    const live = !h || h.available !== false;
    const caps = (h && Array.isArray(h.capabilities) ? h.capabilities : [])
      .concat((router.BY_ID.get(id) || {}).capabilities || []);
    const uniq = Array.from(new Set(caps)).sort();
    engines.push({ id, available: live, reason: (h && h.reason) || '', capabilities: uniq });
    for (const c of uniq) {
      if (!owners.has(c)) owners.set(c, []);
      owners.get(c).push(id);
    }
    if (!live) continue;
    for (const c of uniq) {
      if (!byCapability.has(c)) byCapability.set(c, []);
      byCapability.get(c).push(id);
    }
  }
  const toObject = (m) => Object.fromEntries(Array.from(m.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  return {
    capabilities: toObject(byCapability),
    owners: toObject(owners),
    engines: engines.sort((a, b) => (a.id < b.id ? -1 : 1)),
    total: byCapability.size,
  };
}

/**
 * Decide what to do about a requirement, from what is registered.
 *
 * `needs` is the list of capabilities the task cannot proceed without — the
 * things the agent is about to try and cannot do. A capability nothing declares
 * is a gap; a gap with no owner is the only thing here that ever justifies
 * building.
 *
 * @param {object} router
 * @param {object} spec   { needs: string[], task?: string }
 */
function plan(router, spec) {
  const needs = (Array.isArray(spec && spec.needs) ? spec.needs : [])
    .map(x => String(x).trim()).filter(Boolean);

  const survey = capabilities(router);

  /* Three buckets, and the division is the whole point:

       have      something available provides it
       off       something provides it but is switched off
       missing   nobody provides it at all

   Only the third one justifies building. An earlier version read `missing`
   from the available-only map, so `off` fell into `missing` and the plan told
   the caller to build a duplicate of an engine that already existed.
   */
  const have = [], off = [], missing = [];
  for (const c of needs) {
    if (survey.capabilities[c]) have.push(c);
    else if (survey.owners[c]) off.push(c);
    else missing.push(c);
  }

  /* Which engines can serve — the ones that declare a needed capability and are
     actually available. This is the set that stops a build: if it is not empty,
     the task can be done and building would be a second copy of something that
     already works. */
  const servers = Array.from(new Set(needs
    .filter(c => survey.capabilities[c])
    .flatMap(c => survey.capabilities[c])))
    .filter(id => {
      const e = survey.engines.find(x => x.id === id);
      return e && e.available;
    }).sort();

  /* Engines that declare something needed but are switched off. Named
     separately because the answer to "I have no such capability" is sometimes
     "you do, and it is off" — and the right move there is to turn it on, not
     to rebuild it. */
  const disabled = Array.from(new Set(needs
    .filter(c => survey.owners[c])
    .flatMap(c => survey.owners[c])))
    .filter(id => {
      const e = survey.engines.find(x => x.id === id);
      return e && !e.available;
    }).sort();

  /* The decision follows the gap, not the best-covered part. A task needing
     two things where one is served still needs building for the other, and
     answering 'use existing' because one of them is covered is the answer
     that sends the agent off to use a shout engine to do a watermark. A
     capability is in `missing` precisely because nothing declares it, so
     there is nothing left to weigh: a gap is a build. */
  const decision = missing.length ? 'build' : 'use-existing';

  const out = {
    task: String((spec && spec.task) || '').slice(0, 300),
    needs,
    have,
    off,
    missing,
    decision,
    engines: survey.engines,
    servers,
    disabled,
    canServeNow: servers.length > 0,
    /* The engines to turn on, named up front rather than left to the caller to
       work out from `disabled`. It is the one thing to do instead of building,
       so it should not have to be assembled by hand. */
    turnOn: decision === 'use-existing' && off.length ? disabled.filter(id =>
      off.some(c => (survey.owners[c] || []).includes(id))) : [],
  };

  if (decision === 'build') {
    out.build = {
      /* One capability at a time, and the first gap in the order the caller gave.
         A workflow that needs three things and has none of them is three
         engines, and building them one at a time is what lets each one be
         tested and refused on its own. */
      capability: missing[0],
      stillMissingAfter: missing.slice(1),
      /* what the agent has to supply, and what will be refused without it */
      required: ['body', 'examples'],
      why: 'no registered engine declares ' + missing.filter(c => !survey.capabilities[c]).join(', '),
    };
  } else if (decision === 'use-existing' && !missing.length && !servers.length && disabled.length) {
    out.turnOn = disabled;
  }

  return out;
}

/**
 * The refusal an agent gets when it asks to build something that already exists.
 *
 * Separated from plan() on purpose. Planning says what to do; this says no, and
 * it is the check that makes "do not build because you feel like it" a rule
 * rather than a hope. A build request that names a capability the registry
 * already serves is refused and the engine that has it is named instead.
 */
function guardBuild(router, request) {
  const raw = request && request.capability;
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, reason: 'a build request must name a capability, as a string' };
  }
  const want = raw.trim();

  const survey = capabilities(router);
  const owners = (survey.capabilities[want] || []).filter(id => {
    const e = survey.engines.find(x => x.id === id);
    return e && e.available;
  });

  if (owners.length) {
    return { ok: false, reason: 'nothing needs building: ' + owners.join(', ') + ' already provides "' + want + '"',
      useInstead: owners, decision: 'use-existing' };
  }
  /* Read from `owners`, not from `capabilities`: a switched-off engine is not
     in the available map, so looking there for one is looking in the one place
     it cannot be. */
  const off = (survey.owners[want] || []);
  if (off.length) {
    return { ok: false, reason: '"' + want + '" exists but is not available: ' + off.join(', ') + ' — turn it on rather than building a second one',
      turnOn: off, decision: 'use-existing' };
  }
  return { ok: true, capability: want, reason: 'no registered engine provides "' + want + '"', decision: 'build' };
}

module.exports = { capabilities, plan, guardBuild, kinds };
