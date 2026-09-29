'use strict';
/* ========================================================================= *
 *  test/discover.test.js — Level 5 (SELF-DISCOVER).
 *
 *  The test that matters here is the refusal. A planner that always says "build"
 *  passes every test that only checks it can build, and an agent handed that
 *  planner invents an engine for every task. So most of what is checked here is
 *  that the planner says "use this one" and then refuses the second copy.
 * ======================================================================== */

const fs = require('fs');
const path = require('path');
const forge = require('../forge');
const discover = require('../discover');
const automation = require('../ai/automation');

const ID = 'discover-demo';
const driver = { action: async () => ({ ok: true }), tabs: async () => ({ tabs: [] }) };
const context = () => ({ connected: true, agentTabId: 'tab_dc', url: 'about:blank' });
const newRouter = () => automation.createRouter({ driver, context, engines: automation.DEFAULT_ENGINES.slice() });
const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* gone */ } };

let pass = 0; const fails = [];
const check = (name, fn) => Promise.resolve().then(fn)
  .then(() => { pass += 1; console.log('  ok   ' + name); })
  .catch(e => { fails.push(name); console.log('  FAIL ' + name + '\n         ' + e.message); });

/** an engine that provides "shout", and nothing else */
function seedShout() {
  const r = newRouter();
  const made = forge.build(r, { id: ID, name: 'Shout', capability: 'shout',
    body: "    return { shouted: String(action.text || '').toUpperCase() };",
    examples: [{ action: 'shout', text: 'hi', expect: { shouted: 'HI' } }] });
  if (!made.ok) throw new Error('seed failed: ' + (made.reason || made.error));
  return r;
}

(async () => {
  console.log('\n  Level 5 — SELF-DISCOVER');
  let router = seedShout();

  await check('capabilities come from the live registry, not a hardcoded list', () => {
    const c = discover.capabilities(router);
    if (!c.capabilities.shout) throw new Error('shout is not in the survey: ' + JSON.stringify(Object.keys(c.capabilities)));
    if (!c.capabilities.navigate) throw new Error('native-cdp\'s navigate is missing — the survey is not reading the router');
    if (!c.engines.some(e => e.id === 'native-cdp')) throw new Error('the built-ins are not in the survey');
  });

  await check('an engine on disk but not registered has no capabilities to plan with', () => {
    /* The router is what hands an engine to the agent, so an engine the router
       will not route is not something a plan can count on. */
    const bare = newRouter();
    if (discover.capabilities(bare).capabilities.shout) throw new Error('shout is visible without being registered');
  });

  await check('a requirement an engine already satisfies is served, not rebuilt', () => {
    const p = discover.plan(router, { needs: ['shout'], task: 'make it loud' });
    if (p.decision !== 'use-existing') throw new Error('decision = ' + p.decision + ' — ' + JSON.stringify(p.missing));
    if (!p.canServeNow) throw new Error('canServeNow is false');
    if (!p.servers.includes(ID)) throw new Error('servers = ' + JSON.stringify(p.servers));
    if (p.missing.length) throw new Error('missing = ' + JSON.stringify(p.missing));
    if (p.build) throw new Error('a build was proposed when an engine already serves it');
  });

  await check('a requirement nobody satisfies is planned as a build', () => {
    const p = discover.plan(router, { needs: ['shout', 'watermark'], task: 'loud and watermarked' });
    if (p.missing.length !== 1 || p.missing[0] !== 'watermark') throw new Error('missing = ' + JSON.stringify(p.missing));
    if (p.decision !== 'build') throw new Error('decision = ' + p.decision);
    if (!p.build) throw new Error('no build was described');
    if (p.build.capability !== 'watermark') throw new Error('build.capability = ' + p.build.capability);
    if (!p.build.why) throw new Error('the build has no reason recorded');
  });

  await check('a plan covers what it can and names only the gap', () => {
    const p = discover.plan(router, { needs: ['navigate', 'shout', 'watermark'] });
    if (!p.have.includes('navigate') || !p.have.includes('shout')) throw new Error('have = ' + JSON.stringify(p.have));
    if (JSON.stringify(p.missing) !== JSON.stringify(['watermark'])) throw new Error('missing = ' + JSON.stringify(p.missing));
    /* the engines already doing part of the job are still named, so the agent
       can use them for the part that is covered */
    if (!p.servers.includes(ID)) throw new Error('servers = ' + JSON.stringify(p.servers));
  });

  await check('GUARD: building something that already exists is refused, and the owner is named', () => {
    const g = discover.guardBuild(router, { capability: 'shout' });
    if (g.ok) throw new Error('a build was allowed for a capability an engine already provides');
    if (!g.useIncludes === undefined) { /* no-op */ }
    if (!Array.isArray(g.useInstead) || !g.useInstead.includes(ID)) {
      throw new Error('the refusal did not name the engine to use: ' + JSON.stringify(g));
    }
    if (g.decision !== 'use-existing') throw new Error('decision = ' + g.decision);
  });

  await check('GUARD: the refusal survives a model that asks twice', () => {
    /* An agent that is refused and then asks again is the case the guard is for.
       Nothing about the second request is different, so it must also be refused,
       and the plan must still say the same thing. */
    for (let i = 0; i < 3; i++) {
      const g = discover.guardBuild(router, { capability: 'shout' });
      if (g.ok) throw new Error('refusal number ' + (i + 1) + ' let the build through');
    }
    if (discover.plan(router, { needs: ['shout'] }).decision !== 'use-existing') throw new Error('the plan changed under a repeated request');
  });

  await check('GUARD: a build is allowed only for a capability nobody has', () => {
    const g = discover.guardBuild(router, { capability: 'watermark' });
    if (!g.ok) throw new Error('refused a genuine gap: ' + g.reason);
    if (g.decision !== 'build') throw new Error('decision = ' + g.decision);
  });

  await check('GUARD: a build with no capability named is refused', () => {
    for (const bad of [{}, { capability: '' }, { capability: '   ' }, { capability: 42 }]) {
      const g = discover.guardBuild(router, bad);
      if (g.ok) throw new Error('allowed ' + JSON.stringify(bad));
    }
  });

  await check('an engine that is switched off is "not available", not "missing"', () => {
    /* The distinction decides what the agent does next. Saying "missing" when an
       engine exists and is off sends it to build a second copy; saying "off"
       sends it to turn the first one on. */
    /* A second router with the engine already on disk registered into it, then
       switched off underneath. Re-seeding cannot work: create() refuses to
       overwrite, which is the Level 2 rule this suite must not weaken. */
    const r2 = newRouter();
    if (!forge.register(r2, ID).ok) throw new Error('could not register the engine already on disk');
    const h = r2.health.get(ID);
    h.available = false;
    h.reason = 'switched off for the test';

    const c = discover.capabilities(r2);
    if (c.capabilities.shout) throw new Error('a disabled engine is still counted as providing shout');
    if (!c.engines.some(e => e.id === ID && !e.available)) throw new Error('it is not listed as unavailable either');

    const g = discover.guardBuild(r2, { capability: 'shout' });
    if (g.ok) throw new Error('a second copy was allowed while the first is merely off');
    if (!g.turnOn || !g.turnOn.includes(ID)) throw new Error('the refusal did not point at the engine to turn on: ' + JSON.stringify(g));
  });

  await check('planning never builds and never writes anything', () => {
    const before = fs.readdirSync(forge.ENGINES_DIR).sort();
    discover.plan(router, { needs: ['never-heard-of-it'] });
    discover.guardBuild(router, { capability: 'never-heard-of-it' });
    const after = fs.readdirSync(forge.ENGINES_DIR).sort();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error('planning changed engines/: ' + JSON.stringify(before) + ' -> ' + JSON.stringify(after));
    }
    const src = fs.readFileSync(path.join(__dirname, '..', 'discover.js'), 'utf8');
    /* The separation is the safety property, so it is asserted rather than
       assumed: planning must not require the forge at all. An earlier version
       of this check excused that require and then insisted the file touch
       forge.ID_RE, which is the same claim backwards. */
    const REQUIRES_FORGE = "require('./forge')";
    if (src.includes(REQUIRES_FORGE)) throw new Error('discover.js requires the forge — a planner that can build is a builder that talks itself into it');
    for (const forbidden of ['forge.create', 'forge.build', 'lifecycle.', 'child_process', 'spawn']) {
      if (src.includes(forbidden)) throw new Error('discover.js reaches for ' + forbidden + ' — planning must not build or run anything');
    }
    const ROUTER_REQUIRE = "require('./ai/automation')";
    if (!src.includes(ROUTER_REQUIRE)) throw new Error("it does not read the router, so a plan would be written in a vocabulary nothing routes on");
  });

  await check('an empty requirement is served rather than built', () => {
    for (const bad of [{}, { needs: [] }, { needs: null }, { needs: ['', '  '] }]) {
      const p = discover.plan(router, bad);
      if (p.decision !== 'use-existing') throw new Error('an empty requirement planned a build: ' + p.decision);
      if (p.build) throw new Error('an empty requirement produced a build');
    }
  });

  await check('the survey names the router\'s own vocabulary', () => {
    const k = discover.kinds();
    for (const want of ['navigate', 'act', 'read', 'observe', 'screenshot', 'tabs', 'click', 'type']) {
      if (!k.includes(want)) throw new Error('the router kind "' + want + '" is missing from ' + JSON.stringify(k));
    }
  });

  await check('echo-engine and the other registered engine are visible to planning', () => {
    /* echo-engine has to be registered into this router first. A fresh router
       holds the four built-ins and nothing else, and the survey reads the
       router rather than the disk — so asking about an unregistered engine was
       asking about something the agent could not have used anyway. */
    forge.register(router, 'echo-engine');
    const c = discover.capabilities(router);
    for (const e of ['echo-engine', 'native-cdp', ID]) {
      if (!c.engines.some(x => x.id === e)) throw new Error(e + ' is not in the survey');
    }
    if (!c.capabilities.echo) throw new Error('echo is missing from ' + JSON.stringify(Object.keys(c.capabilities)));
  });

  rm(path.join(forge.ENGINES_DIR, ID));
  console.log('\n  discover: ' + pass + ' passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ''));
  process.exit(fails.length ? 1 : 0);
})().catch(e => {
  rm(path.join(forge.ENGINES_DIR, ID));
  console.error('\n  suite crashed: ' + e.message);
  process.exit(1);
});
