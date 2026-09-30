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

/* The same set, as a lookup, and computed once.
 *
 * This was the line between "nobody can do this" and "nobody has been told how we
 * do this", and it is MEASURED to be empty. All ten kinds the automation layer can
 * route are already served by one of the four engines this project ships, so a
 * need on its own can never be a knowledge gap here.
 *
 * That is worth knowing rather than worth deleting. It says the shipped registry is
 * complete against the shipped vocabulary, which is the thing a planner is for,
 * and it says the derived half of the guidance rule is currently a safety net
 * rather than a path: it catches a gap the day a new kind is routed and no engine
 * claims it yet, and until then it contributes nothing.
 *
 * So the rule that actually fires is the caller's, in spec.guide. See plan().
 */
const ROUTABLE = new Set(kinds());

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
 * @param {object} spec   {
 *   needs: string[],
 *   task?: string,
 *   guide?: string[],   things the caller needs GUIDANCE on rather than a
 *                       capability. Anything an engine already serves is ignored,
 *                       so this cannot be used to bypass a working registry.
 * }
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
  const have = [], off = [], missing = [], unguided = [];
  for (const c of needs) {
    if (survey.capabilities[c]) have.push(c);
    else if (survey.owners[c]) off.push(c);
    /* And the fourth bucket, which is the one this file was missing.
     *
     * `missing` used to mean one thing: build an engine. It is two things, and
     * they need opposite work.
     *
     *   unguided   nothing serves it as a ROUTED capability, but the automation
     *              layer already knows how to do it. Navigate, extract, act, take
     *              a screenshot - each of these is something a built-in tool does
     *              today. A gap here is a gap in KNOWLEDGE, and the answer is a
     *              skill: a named block of guidance saying how this house does it.
     *              An engine written for it is a second implementation of
     *              something that already works, which is the expensive way of
     *              saying nothing.
     *
     *   missing    nothing serves it and the automation layer has never heard of
     *              it either. There is no machinery to write guidance about, so
     *              guidance cannot be the answer and the gap is real.
     *
     * Both still mean nobody serves this right now, so both are still gaps and
     * both stop a use-existing. Only the REMEDY differs. */
    else if (ROUTABLE.has(c)) unguided.push(c);
    else missing.push(c);
  }

  /* And the ones the CALLER said it needed guidance on, which is the half that
     * actually fires.
     *
     * The derived half above is a real rule and it is currently empty, and that is
     * a measurement rather than an omission: with the engines this project ships,
     * every one of the ten kinds the automation layer can route is already served
     * by one of them. So a need on its own can never be a knowledge gap here, and a
     * planner that relied on the derived half alone would ship a door that never
     * opens.
     *
     * Which is the honest shape of the problem. "I need a capability nobody has"
     * and "I got it done and it was wrong" are different facts, and only the agent
     * in the first person knows which one it has. A need is a need; a thing it
     * cannot do is never a guidance gap. So the caller says so, in a field of its
     * own, and the plan honours it.
     *
     * It is kept separate from `needs` on purpose. Folding the two together would
     * let a capability that an engine already serves be re-planned as a skill
     * because the agent called it one, which is the one way this door could be
     * used to bypass a registry that already works. */
  const asked = (Array.isArray(spec && spec.guide) ? spec.guide : [])
    .map(x => String(x).trim()).filter(Boolean);
  for (const g of asked) {
    /* An engine that serves it wins, whatever the caller said. This is the guard
     * against the door being used to bypass a registry that already works, and it
     * is checked here rather than at the far end so that a plan can never contain
     * the same name in `have` and `unguided`. */
    if (survey.capabilities[g] || survey.owners[g]) continue;
    /* And it is REMOVED from `missing`, not added to `unguided` beside it. The
     * first version only added, so a guided gap appeared in both lists at once:
     * `missing` said there was no machinery for it and `unguided` said there was,
     * and a caller reading either one was told something false. Saying "this is
     * guidance" is a claim about the same gap, not an additional one. */
    const at = missing.indexOf(g);
    if (at >= 0) missing.splice(at, 1);
    if (!unguided.includes(g)) unguided.push(g);
  }
  const gaps = unguided.concat(missing);

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
     two things where one is served still needs something for the other, and
     answering 'use existing' because one of them is covered is the answer
     that sends the agent off to use a shout engine to do a watermark.
     */
  /*
   * Three ways out, and they are in the order of how much they ask of somebody
   * else. Use an engine that works. Turn on one that is switched off. Then write
   * guidance if the machinery exists, and code if it does not.
   *
   * The middle one is the change. A plan that reached for `build` before considering
   * a skill was telling the agent to write an engine in order to be told how to
   * use a tool it already has - and the engine it wrote would then have to be
   * tested, gated and registered before anyone could read the three sentences
   * that were wanted.
   */
  const decision = !gaps.length ? 'use-existing'
    : (unguided.length ? 'propose-skill' : 'build');

  const out = {
    task: String((spec && spec.task) || '').slice(0, 300),
    needs,
    have,
    off,
    missing,
    /* The gap that guidance can answer, named as its own list rather than folded
       into `missing`. A caller that cannot tell them apart has to build. */
    unguided,
    /* Everything nobody serves, in one list, so a caller that only wants "is there
       a hole" does not have to know how the hole is spelled. */
    gaps,
    /* Which of the two rules put something in `unguided`, because a reader of the
       plan has to be able to tell a gap the code found from one the agent named,
       and they are not equally trustworthy. */
    guidedBy: asked.filter(g => unguided.includes(g)),
    derivedGuidance: unguided.filter(g => !asked.includes(g)),
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

  /* One guidance proposal at a time, for the same reason a build is one engine
     at a time: each is separately examined, and a person applies it. A proposal
     queue that arrives as a batch is a queue nobody reads. */
  if (decision === 'propose-skill') {
    out.skill = {
      capability: unguided[0],
      stillUnguidedAfter: unguided.slice(1),
      stillMissingAfter: missing,
      /* What a skill is, in the shape ai/rules.js validates. It is named here
         rather than left to the caller because the id has to be a slug and the
         capability is not one - "dom.extract" is not an id. */
      required: ['id', 'name', 'description', 'instruction'],
      why: 'nothing serves ' + unguided.join(', ') + ' as a routed capability, but the '
        + 'automation layer already knows the kind - so what is missing is how this '
        + 'house does it, which is a skill and not an engine',
    };
  }

  if (decision === 'build') {
    out.build = {
      /* One capability at a time, and the first gap in the order the caller gave.
         A workflow that needs three things and has none of them is three
         engines, and building them one at a time is what lets each one be
         tested and refused on its own. */
      /* `missing` and not `gaps`. A decision of build means every gap was a real
         one, so the two are the same list here - but reaching for gaps[0] would
         be reading a list whose first entry may be a guidance gap, and a build
         that names one builds an engine for something guidance answers. */
      capability: missing[0],
      stillMissingAfter: missing.slice(1),
      /* what the agent has to supply, and what will be refused without it */
      required: ['body', 'examples'],
      why: 'no registered engine declares ' + missing.filter(c => !survey.capabilities[c]).join(', '),
    };
  } else if (decision === 'use-existing' && !gaps.length && !servers.length && disabled.length) {
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
  /* The same four-way answer plan() gives, because a guard that disagrees with the
     plan is worse than no guard: the plan says propose-skill, the agent asks to
     build, and the guard waves it through because it only knew about two answers.
     This was the hole the new decision would otherwise have opened. */
  /* A caller that says the gap is guidance gets the guidance answer, and the
   * registry check above has already run - so this cannot wave through a
   * capability an engine provides. It used to ignore the claim entirely, and a
   * plan saying propose-skill next to a guard saying build is a run that can
   * explain itself two ways. */
  if (request && request.guide === true) {
    return { ok: true, capability: want,
      reason: 'nothing provides "' + want + '" and the caller says this is a '
        + 'knowledge gap rather than a missing capability',
      decision: 'propose-skill' };
  }
  if (ROUTABLE.has(want)) {
    return { ok: true, capability: want,
      reason: 'nothing provides "' + want + '" as a routed capability, and the '
        + 'automation layer already knows the kind - write a skill, not an engine',
      decision: 'propose-skill' };
  }
  return { ok: true, capability: want,
    reason: 'no registered engine provides "' + want + '" and nothing in the '
      + 'automation layer knows the kind either',
    decision: 'build' };
}

module.exports = { capabilities, plan, guardBuild, kinds };
