'use strict';
/* ========================================================================= *
 *  test/evolve-skill.test.js — the second door: a gap that guidance answers.
 *
 *  Run: node test/evolve-skill.test.js
 *
 *  Before this, the self-extension story had exactly one answer to "I need a
 *  capability nobody has": write a JavaScript engine, and let the forge gate it.
 *  That is right for a capability nothing can do, and it is the expensive way to
 *  say three sentences for a capability the built-in tools already do — and the
 *  built-in tools do a great many. Asking an agent to write, test, gate and
 *  register an engine in order to be told how to navigate is a bad trade, and
 *  before this file the only way out of it was to not propose anything at all.
 *
 *  So the plan now has four answers instead of three, and this file is about the
 *  new one. It runs the real discover, the real rules store and the real evolve
 *  arm against a temporary directory, because the three claims worth making are:
 *
 *    1. a gap the automation layer already knows is planned as a skill, and NOT
 *       as a build — and the two are told apart by reading the same tables the
 *       built-in tools are written against, not by a heuristic;
 *
 *    2. reaching the door with nothing to put through it is refused, because a
 *       proposal with no reason is a queue entry nobody can judge;
 *
 *    3. a proposal stops there. A person applies it. The run does not gain the
 *       capability, does not compose, does not execute, and says so — which is
 *       the claim most likely to be got wrong, because returning ok:true would
 *       look like progress.
 *
 *  It also checks the two properties that make the new door safe rather than
 *  merely new: the guard and the plan must agree (a guard that only knew two
 *  answers would wave a build through), and a skill may not widen a capability
 *  toggle (which is ai/rules.js and ai/skills.js, asserted here because this is
 *  the door that makes it reachable).
 * ========================================================================= */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const automation = require(path.join(ROOT, 'ai', 'automation'));
const rules = require(path.join(ROOT, 'ai', 'rules'));
const skills = require(path.join(ROOT, 'ai', 'skills'));
const discover = require(path.join(ROOT, 'discover'));
const { evolve } = require(path.join(ROOT, 'evolve'));

let pass = 0;
const fails = [];
const check = async (name, fn) => {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fails.push({ name, e }); console.log('  FAIL ' + name + '\n         ' + e.message); }
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'oagent-skill-'));
rules.useDir(TMP);

/* A router with the built-in engines and nothing else, which is the interesting
 * case: every capability is a gap, and the only question is which KIND.
 *
 * The driver and the context are the ones evolve.test.js uses, because
 * createRouter() refuses a driver that is missing action() or tabs() - so the first
 * version of this file, with a driver of navigate() alone, failed all ten planning
 * cases on "the router needs the existing browser driver" and reported it as if
 * the new decision were wrong. */
const driver = { action: async () => ({ ok: true }), tabs: async () => ({ tabs: [] }) };
const context = () => ({ connected: true, agentTabId: 'tab_skill', url: 'about:blank' });
const newRouter = () => automation.createRouter({
  driver,
  context,
  engines: automation.DEFAULT_ENGINES.slice(),
});

/* The same, plus one engine that claims a capability, for the guard cases.
 *
 * `engines` is an ARRAY of objects with an `id` - createRouter() reads
 * `engines.length` and maps `e.id`, so an object literal registers nothing and the
 * registry comes back as the four shipped engines. The first version of this
 * helper passed an object, and the case using it reported a guard that had not
 * refused anything when in fact the engine was never in the registry. */
const withEngine = (id, capability) => automation.createRouter({
  driver,
  context,
  engines: automation.DEFAULT_ENGINES.concat([
    { id, name: id, capabilities: [capability], route: () => null },
  ]),
});

/* A capability the automation layer routes today, and one it has never heard
   of. Both are read from the real tables rather than written here, so this file
   cannot go on passing after the vocabulary moves. */
/* Two different things, and the file keeps them apart.
 *
 * ROUTABLE is a capability the automation layer can route at all - the machinery
 * exists. GUIDE is a name the run says it needs guidance on.
 *
 * ROUTABLE[0] cannot serve as the gap, and the first version of this file used it
 * as one. All ten routable kinds are served by an engine this project ships, so it
 * was never a gap, and every case after the first reported a decision that was
 * correct. A gap has to be a name nothing provides. */
const ROUTABLE = discover.kinds();
const GUIDE = 'house-convention';
const UNKNOWN = (() => {
  let n = 0;
  while (ROUTABLE.includes('skill-test-nothing-' + n)) n++;
  return 'skill-test-nothing-' + n;
})();

/* The real names: listProposals and reject. An earlier version of this file
   called rules.listProposals() and rules.dismiss(), which do not exist, and every
   case after the first one failed on a TypeError instead of on the claim it was
   making - which is a suite that looks busy and asserts nothing after line 80. */
const cleanQueue = () => {
  for (const p of rules.listProposals()) rules.reject(p.id);
};

(async () => {
  console.log('\n  Generic skill adaptation — the guidance door');

  // ---------------------------------------------------------------- planning
  await check('a gap the automation layer already knows is planned as a skill, not a build', () => {
    const r = newRouter();
    const p = discover.plan(r, { needs: [GUIDE], guide: [GUIDE], task: 'x' });
    assert.strictEqual(p.decision, 'propose-skill',
      'decision was ' + p.decision + ' for ' + ROUTABLE[0]);
    assert.deepStrictEqual(p.unguided, [GUIDE]);
    assert.deepStrictEqual(p.missing, [], 'a routable kind is not a machine gap');
    assert.deepStrictEqual(p.gaps, [GUIDE], 'but it is still a gap');
    assert.ok(p.skill, 'and the plan carries what the caller has to supply');
    assert.strictEqual(p.skill.capability, GUIDE);
    assert.ok(p.skill.required.includes('instruction'));
    assert.ok(!p.build, 'and there is no build to do');
  });

  await check('a gap nothing knows at all is still a build', () => {
    const p = discover.plan(newRouter(), { needs: [UNKNOWN], task: 'x' });
    assert.strictEqual(p.decision, 'build', 'decision was ' + p.decision);
    assert.strictEqual(p.build.capability, UNKNOWN);
    assert.deepStrictEqual(p.unguided, []);
  });

  await check('one guidance gap and one real gap: guidance is asked for first', () => {
    const p = discover.plan(newRouter(), { needs: [UNKNOWN], guide: [GUIDE], task: 'x' });
    assert.strictEqual(p.decision, 'propose-skill',
      'writing a guidance block costs a minute and building costs a gate, so the '
      + 'cheaper sufficient answer is the one to take first');
    assert.deepStrictEqual(p.unguided, [GUIDE]);
    assert.deepStrictEqual(p.missing, [UNKNOWN],
      'and the real gap is still named, because it will still be there afterwards');
  });

  await check('the guard agrees with the plan about which door', () => {
    const r = newRouter();
    const g1 = discover.guardBuild(r, { capability: GUIDE, guide: true });
    const g2 = discover.guardBuild(r, { capability: UNKNOWN });
    assert.strictEqual(g1.decision, 'propose-skill',
      'the guard said "' + g1.decision + '" for a routable kind. A guard that only '
      + 'knew two answers would wave a build through and the new door would be a '
      + 'door with no lock on it.');
    assert.strictEqual(g2.decision, 'build');
  });

  await check('a guidance claim cannot override an engine that already serves it', () => {
    /* The safety property, and it was not asserted at all until a mutation check
     * pointed at it: eleven ways of breaking this file were tried and removing the
     * line that stops a guidance claim overriding a working registry broke nothing
     * the file could see, because no case asked for guidance on something an engine
     * already provided.
     *
     * So the door has to be asked for something it must refuse, or "a skill cannot
     * widen a capability toggle" is a claim about skills and not about this. */
    const served = discover.plan(newRouter(), { needs: [ROUTABLE[0]], task: 'x' });
    assert.strictEqual(served.decision, 'use-existing',
      'the premise: a shipped engine already serves ' + ROUTABLE[0]
      + ', otherwise this case is testing nothing');

    const asked = discover.plan(newRouter(), {
      needs: [], guide: [ROUTABLE[0]], task: 'x',
    });
    assert.strictEqual(asked.decision, 'use-existing',
      'the run asked for guidance on a capability an engine provides, and got a skill. '
      + 'That is the door being used to bypass a registry that already works.');
    assert.deepStrictEqual(asked.unguided, [], 'and it is not in the guidance list');
    assert.ok(!asked.skill, 'and there is no skill to propose');
  });

  await check('a gap nothing knows is still refused when an engine already serves it', () => {
    /* The refusal half has to keep working on the new path, so this uses an
       engine that exists, which is the case the guard exists for. */
    const r = withEngine('guard-probe', ROUTABLE[0]);
    const g = discover.guardBuild(r, { capability: ROUTABLE[0] });
    assert.strictEqual(g.ok, false, 'an engine serves it, so nothing is needed');
    assert.ok(g.useInstead && g.useInstead.includes('guard-probe'));
  });

  // ------------------------------------------------------------------ evolve
  await check('a run that reaches the door with no guidance to offer is refused', async () => {
    cleanQueue();
    const out = await evolve(newRouter(), { needs: [], guide: [GUIDE], task: 'x' });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.stage, 'propose-skill',
      'it stopped at ' + out.stage + ' rather than the guidance door');
    const entry = out.trace.find(t => t.capability === 'propose-skill');
    assert.ok(entry && entry.ok === false, 'and the trace says so');
    assert.strictEqual(rules.listProposals().length, 0, 'and nothing was proposed');
  });

  await check('a proposal needs a reason, because a queue is read by a person', async () => {
    cleanQueue();
    const out = await evolve(newRouter(), {
      needs: [], guide: [GUIDE], task: 'x',
      skill: { name: 'House navigation', instruction: 'Navigate, then read the page before deciding.' },
    });
    assert.strictEqual(out.stage, 'propose-skill');
    assert.ok(/reason/i.test(out.reason),
      'the refusal names the missing part: ' + out.reason);
    assert.strictEqual(rules.listProposals().length, 0);
  });

  await check('a complete proposal reaches the queue and the run stops there', async () => {
    cleanQueue();
    const id = 'house-navigation';
    const out = await evolve(newRouter(), {
      needs: [], guide: [GUIDE], task: 'x',
      skill: {
        id, name: 'House navigation',
        description: 'How this house navigates.',
        instruction: 'Navigate to the url, then read the page before deciding anything.',
        requires: ['browser'],
        reason: 'the agent navigated and guessed, and the built-in tool can do it',
      },
    });

    const entry = out.trace.find(t => t.capability === 'propose-skill');
    assert.ok(entry && entry.ok === true, 'the guidance door ran: ' + JSON.stringify(entry));
    assert.strictEqual(out.decision, 'propose-skill');

    const queue = rules.listProposals();
    assert.strictEqual(queue.length, 1, 'exactly one proposal, not a batch');
    assert.strictEqual(queue[0].kind, 'create');
    assert.strictEqual(queue[0].skillId, id);

    /* The part that is easiest to get wrong. */
    assert.strictEqual(out.ok, false,
      'the run reports success. Nothing gained the capability: a person has to apply '
      + 'the proposal, and the run saying otherwise is a claim it cannot support.');
    assert.strictEqual(out.skill.awaitingPerson, true);
    assert.ok(!out.result, 'and it did not run anything');
    assert.ok(!out.engine, 'and it did not route to anything');
    assert.ok(out.reached.includes('propose-skill'));
    assert.ok(!out.reached.includes('execute'),
      'it executed, which means it went past a door it had not been let through');
    assert.ok(!out.reached.includes('compose'));
    assert.ok(!out.reached.includes('build'),
      'it built, which is the whole thing this door exists to avoid');
  });

  await check('the same proposal twice is one question, not two', async () => {
    cleanQueue();
    const spec = {
      needs: [], guide: [GUIDE], task: 'x',
      skill: {
        id: 'twice-only', name: 'Twice', description: 'd',
        instruction: 'i', reason: 'r',
      },
    };
    const first = await evolve(newRouter(), spec);
    const second = await evolve(newRouter(), spec);
    assert.strictEqual(rules.listProposals().length, 1, 'two proposals for the same gap');
    assert.strictEqual(first.skill.state, 'proposed');
    assert.strictEqual(second.skill.state, 'already proposed');
    assert.strictEqual(second.skill.duplicate, true);
  });

  await check('the proposal is only a proposal: the catalog is unchanged', async () => {
    /* It proposes its own, rather than reading what the case above left behind.
     * Every case here clears the queue on the way in, so a case that asserted
     * about a previous case's proposal was asserting about nothing - and it passed
     * for as long as the ordering held. */
    cleanQueue();
    const id = 'catalog-untouched';
    const out = await evolve(newRouter(), {
      needs: [], guide: [GUIDE], task: 'x',
      skill: {
        id, name: 'Catalog untouched', description: 'd',
        instruction: 'i', reason: 'r',
      },
    });
    assert.strictEqual(out.skill.state, 'proposed', 'the proposal was made: ' + out.reason);
    const ids = rules.catalog().map(s => s.id);
    assert.ok(!ids.includes(id),
      'the skill is in the catalog already. A person applies a proposal, and this '
      + 'file must not have found a way around them.');
    assert.ok(rules.listProposals().some(p => p.skillId === id),
      'and it is in the queue where a person will see it');
  });

  await check('the agent can actually reach the door from the tools it is given', () => {
    /* The version of this that shipped first had all of the above and none of this:
     * discover and evolve knew about guidance, the tests exercised both directly,
     * and the only two things the agent is ever handed - engine_plan and
     * engine_evolve - had no field to say it with. A door nobody can walk through
     * passes every test written about the room behind it, which is why the
     * assertion has to be about the tools' own parameters. */
    const { PLAN_TOOL, EVOLVE_TOOL } = require(path.join(ROOT, 'evolve-tools'));

    assert.ok(PLAN_TOOL.parameters.properties.guide,
      'engine_plan has no guide parameter, so the plan tool can never return '
      + 'propose-skill however right the answer is');
    assert.ok(/guide: args\.guide/.test(PLAN_TOOL.run.toString()),
      'and engine_plan does not pass it through');
    assert.ok(/propose-skill/.test(PLAN_TOOL.description),
      'and the model is not told the third answer exists, so it has no reason to send it');

    const props = EVOLVE_TOOL.parameters.properties;
    assert.ok(props.guide, 'engine_evolve cannot say a gap is guidance');
    assert.ok(props.skill, 'and cannot carry the guidance to propose');
    const skill = props.skill.properties || {};
    for (const field of ['name', 'instruction', 'reason']) {
      assert.ok(skill[field], 'the skill parameter has no ' + field
        + ', so a proposal cannot be made through the tool at all');
    }
    assert.ok(/PROPOSED/.test(EVOLVE_TOOL.description),
      'and the model is not told that a skill is proposed rather than applied — which '
      + 'is the difference between a run that stops and a run that lies');
  });

  await check('end to end, through the tool the agent is actually given', async () => {
    /* The parameter check above says the door is in the tool's shape. This says the
     * door opens when the tool is used — which is a different claim, and the one that
     * would catch a tool that declares guide and then drops it on the floor between
     * the schema and the call. A schema is a promise about a shape; only a run
     * through run() is a promise about a behaviour. */
    const { PLAN_TOOL, EVOLVE_TOOL, setRouter } = require(path.join(ROOT, 'evolve-tools'));
    cleanQueue();
    setRouter(newRouter());

    const id = 'through-the-tool';
    const planned = await PLAN_TOOL.run({}, {
      needs: [], guide: [GUIDE], task: 'through the tool',
    });
    assert.strictEqual(planned.decision, 'propose-skill',
      'engine_plan returned ' + planned.decision);
    assert.strictEqual(planned.skill.capability, GUIDE);
    assert.deepStrictEqual(planned.guidedBy, [GUIDE],
      'and it says the gap was named rather than derived');

    /* The tool refuses by THROWING, and that is the right shape: a refusal the
     * agent reads as an error is a refusal, and one returned as a value is
     * something a model will quietly carry on from. So this asserts on the
     * throw - and on what it says, because the words are what the agent gets. */
    let refused = null;
    try {
      await EVOLVE_TOOL.run({}, {
        needs: [], guide: [GUIDE], task: 'through the tool',
        skill: {
          id, name: 'Through the tool', description: 'd',
          instruction: 'i', reason: 'because the run asked',
        },
      });
    } catch (e) { refused = e; }

    assert.ok(refused, 'engine_evolve returned instead of refusing. A run that has '
      + 'proposed a skill has gained nothing, and returning quietly is how that '
      + 'becomes a report of success.');
    assert.ok(/propose-skill/.test(String(refused.message || refused)),
      'the refusal does not name the stage: ' + String(refused.message).slice(0, 160));
    assert.ok(/a person has to apply/i.test(String(refused.message || refused)),
      'and it does not say the run stopped at a person, which is the one thing the '
      + 'agent has to be told: ' + String(refused.message).slice(0, 160));

    const fact = (refused && refused.fact) || {};
    assert.strictEqual(fact.stage, 'propose-skill');
    assert.strictEqual(fact.decision, 'propose-skill');
    const step = (fact.trace || []).find(t => t.capability === 'propose-skill');
    assert.ok(step && step.ok === true, 'and the trace does not show the door running');
    assert.ok(!fact.trace.some(t => t.capability === 'execute'),
      'the run executed something after proposing, which means it went past a door it '
      + 'had not been let through');

    const queued = rules.listProposals().filter(p => p.skillId === id);
    assert.strictEqual(queued.length, 1,
      'the proposal is not in the queue, so nobody is going to read it');
    assert.strictEqual(queued[0].reason, 'because the run asked',
      'and the reason is not on it, so there is nothing for the reviewer to judge');
  });

  await check('a skill cannot widen a capability toggle', async () => {
    /* The door that makes skills reachable from a run is also the door through
       which "I will grant myself the terminal" would arrive, so the refusal is
       asserted here rather than assumed from ai/rules.js being careful. */
    const resolved = skills.resolve(['terminal'], { browser: true, dom: true });
    assert.deepStrictEqual(resolved.selected, [],
      'a profile with terminal off cannot run a skill that needs it, whatever the '
      + 'catalog says about requires');
    assert.ok(resolved.blocked.some(b => b.id === 'terminal'));
    assert.strictEqual(resolved.caps.terminal, false,
      'and the resolved caps do not gain it either');
  });

  await check('a skill that needs nothing extra is granted with its capability', async () => {
    const on = skills.resolve(['web-extraction'], { dom: true, browser: true });
    assert.strictEqual(on.selected.length, 1, 'the skill is not blocked');
    assert.strictEqual(on.blocked.length, 0);
    assert.ok(on.caps.dom);
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows */ }
  console.log('\n  evolve-skill: ' + pass + ' passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ''));
  if (fails.length) for (const f of fails) console.log('\n  ' + f.name + '\n  ' + f.e.stack);
  process.exit(fails.length ? 1 : 0);
})().catch(e => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows */ }
  console.error('\n  suite crashed: ' + e.message);
  process.exit(1);
});
