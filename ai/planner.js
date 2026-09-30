'use strict';
/* ====================================================================== *
 *  ai/planner.js — the planning phase, in front of the tool loop.
 *
 *  What it is
 *  ----------
 *  The user may instruct the agent freely. Before anything on the machine
 *  is touched, one small request decides how the instruction is handled:
 *
 *      chat / a question needing no action  →  kind "answer"
 *      anything the machine must DO         →  kind "plan"
 *
 *  A plan is a short list of steps written for the USER to read and judge.
 *  Nothing runs until they approve it (or edit it and approve that). The
 *  planner therefore optimises for readable, honest steps — a plan the user
 *  cannot understand is a plan they cannot approve.
 *
 *  A step may name a tool, with literal args, but does not have to: the
 *  executing agent (the ordinary tool loop in ai/engine.js) decides HOW a
 *  step is done. Naming tools is for cases where the instruction already
 *  fully determines the call; everything else stays a sentence.
 *
 *  Output contract
 *  ---------------
 *  The reply must come through the submit_plan tool. Models do not always
 *  obey, so a raw-JSON fallback is parsed out of the text; if neither is
 *  there, the result is an error, not a guessed plan. A check that never
 *  fails is not a check.
 * ====================================================================== */

const engine = require('./engine');

/** hard ceilings — whatever the model asks for */
const MAX_STEPS = 12;
const MAX_REPLANS = 3;
const MAX_SUMMARY_CHARS = 300;
const MAX_TITLE_CHARS = 200;
const MAX_ANSWER_CHARS = 4000;
const CATALOG_DESC_CHARS = 160;

const STEP_ID = /^[a-z0-9][a-z0-9-]{0,30}$/;

/** the only tool the planner is offered */
const SUBMIT_PLAN = {
  name: 'submit_plan',
  description: 'How the instruction will be handled. Call it exactly once: kind "answer" for chat that needs no action, kind "plan" with steps when the machine must do something.',
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['plan', 'answer'], description: 'answer = no action needed; plan = the machine must do something' },
      summary: { type: 'string', description: 'One line, in the user\'s language, of what the plan will do. Empty for answer.' },
      answer: { type: 'string', description: 'For kind "answer" only: a short note for the user. The agent writes the real reply.' },
      steps: {
        type: 'array',
        description: 'For kind "plan" only: the steps, in execution order.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'short slug: lowercase letters, digits, dashes, e.g. "fetch-data"' },
            title: { type: 'string', description: 'One imperative sentence the user can read and judge, in the user\'s language.' },
            tool: { type: 'string', description: 'Optional: the tool this step will use, from the catalog you were given. Leave empty when how-to is not fully decided yet.' },
            args: { type: 'object', description: 'Optional, only with tool: the literal arguments for that call.' },
          },
          required: ['id', 'title'],
        },
      },
    },
    required: ['kind'],
    additionalProperties: false,
  },
};

/* ------------------------------------------------------------- validation -- */

/**
 * Check a plan before it is shown to anyone.
 *
 * Refusals name the reason, because a plan card that says only "refused" is
 * one the user cannot fix. Tools are checked against the catalog the plan
 * was built from: a step naming a tool this profile does not have would run
 * (or, worse, not run) at execution time, far away from here.
 */
function validate(raw, toolNames) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'a plan has to be an object' };
  }
  const kind = raw.kind;
  if (kind !== 'plan' && kind !== 'answer') {
    return { ok: false, reason: 'kind has to be "plan" or "answer", got ' + JSON.stringify(kind) };
  }

  if (kind === 'answer') {
    const answer = String(raw.answer || '').trim();
    if (!answer) return { ok: false, reason: 'kind is "answer" but no answer text was given' };
    return { ok: true, plan: { kind: 'answer', answer: answer.slice(0, MAX_ANSWER_CHARS) } };
  }

  const rawSteps = raw.steps;
  if (!Array.isArray(rawSteps) || !rawSteps.length) {
    return { ok: false, reason: 'a plan needs at least one step' };
  }
  if (rawSteps.length > MAX_STEPS) {
    return { ok: false, reason: 'a plan of ' + rawSteps.length + ' steps is refused — the limit is ' + MAX_STEPS };
  }

  const catalog = new Set(toolNames || []);
  const seen = new Set();
  const steps = [];
  for (let i = 0; i < rawSteps.length; i++) {
    const s = rawSteps[i];
    const at = 'step ' + (i + 1);
    if (!s || typeof s !== 'object' || Array.isArray(s)) return { ok: false, reason: at + ' is not an object' };

    const id = String(s.id || '').trim();
    if (!STEP_ID.test(id)) {
      return { ok: false, reason: at + ' has id ' + JSON.stringify(s.id) + ' — it has to be a short slug of lowercase letters, digits and dashes' };
    }
    if (seen.has(id)) return { ok: false, reason: 'two steps are called "' + id + '"' };
    seen.add(id);

    const title = String(s.title || '').trim();
    if (!title) return { ok: false, reason: at + ' has no title' };

    const step = { id, title: title.slice(0, MAX_TITLE_CHARS) };
    if (s.tool !== undefined && s.tool !== null && s.tool !== '') {
      const tool = String(s.tool);
      if (!catalog.has(tool)) {
        return { ok: false, reason: at + ' names tool "' + tool + '", which is not in the catalog: ' + (toolNames.length ? toolNames.join(', ') : '(none)') };
      }
      step.tool = tool;
      if (s.args !== undefined) {
        if (!s.args || typeof s.args !== 'object' || Array.isArray(s.args)) {
          return { ok: false, reason: at + ' has args that are not an object' };
        }
        step.args = s.args;
      }
    }
    steps.push(step);
  }

  return {
    ok: true,
    plan: {
      kind: 'plan',
      summary: String(raw.summary || '').trim().slice(0, MAX_SUMMARY_CHARS),
      steps,
    },
  };
}

/* ---------------------------------------------------------------- rendering -- */

/** the catalog lines that go into the planner's system prompt */
function catalogLines(toolSchemas) {
  return (toolSchemas || []).map(t => {
    const desc = String(t.description || '').replace(/\s+/g, ' ').trim();
    return '- `' + t.name + '` — ' + (desc.length > CATALOG_DESC_CHARS ? desc.slice(0, CATALOG_DESC_CHARS) + '…' : desc);
  });
}

function renderPlanText(plan) {
  const lines = [
    'APPROVED PLAN — the user has read and approved this plan. Execute it now.',
    '',
    'Summary: ' + (plan.summary || '(no summary)'),
    '',
    'Steps:',
  ];
  plan.steps.forEach((s, i) => {
    lines.push((i + 1) + '. ' + s.title + (s.tool ? ' (tool: ' + s.tool + ')' : ''));
  });
  lines.push(
    '',
    'Work through the steps in order, using your tools. How a step is done is yours',
    'to choose, but do not skip a step and do not stop early. If a step fails, say',
    'plainly what failed and stop rather than improvising around it.',
  );
  return lines.join('\n');
}

/* ----------------------------------------------------------------- planning -- */

function systemPrompt(toolSchemas) {
  const lines = [
    'You are the planner of an agent that works on the user\'s own machine.',
    'The user gives you an instruction. You decide how it is handled and you',
    'reply ONLY by calling submit_plan — never with plain text.',
    '',
    'Two kinds of instruction:',
    '- chat, greetings, or a question that needs no action on the machine',
    '  → kind "answer". Keep the note short; the agent writes the real reply.',
    '- anything the machine must DO (run commands, change files, use the',
    '  browser, call an API...) → kind "plan".',
    '',
    'For a plan:',
    '- Break the instruction into the fewest concrete steps that get it done,',
    '  at most ' + MAX_STEPS + '. One step is one thing.',
    '- Write each title as an imperative sentence in the user\'s own language,',
    '  so the user can read it and judge it.',
    '- Name a tool on a step only when the instruction already fully decides',
    '  that call, with literal args. Otherwise leave the tool out — the',
    '  executing agent chooses how to do the step.',
    '- Never name a tool that is not in the catalog below. Never put secrets',
    '  or API keys into args.',
    '- The plan is shown to the user BEFORE anything runs; they can edit,',
    '  approve or reject it.',
    '',
    'Tool catalog:',
    ...catalogLines(toolSchemas),
  ];
  return lines.join('\n');
}

/** pull a plan object out of a provider reply: the tool call first, raw JSON in the text as fallback */
function extract(out) {
  const call = (out.toolCalls || []).find(c => c.name === SUBMIT_PLAN.name);
  if (call) return call.args;
  const text = String(out.text || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* not bare JSON */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* not JSON either */ } }
  return null;
}

/**
 * Plan one instruction.
 *
 * @param {object}   o
 * @param {object}   o.provider    instance from providers.create()
 * @param {string}   o.text        the user's instruction
 * @param {Array}    [o.history]   prior user/assistant turns
 * @param {Array}    o.toolSchemas the executing agent's tool catalog
 * @param {string}   [o.note]      why a previous plan was rejected (replan)
 * @returns {Promise<{ok:true, plan:object} | {ok:false, reason:string}>}
 */
async function plan({ provider, text, history, toolSchemas, note }) {
  const toolNames = (toolSchemas || []).map(t => t.name);

  const user = String(text || '').trim();
  const noteBlock = note
    ? '\n\nYour previous plan was REJECTED by the user. Their reason: ' + note
      + '\nProduce a revised plan that addresses the reason. Call submit_plan again.'
    : '';

  const out = await provider.chat({
    messages: [
      { role: 'system', content: systemPrompt(toolSchemas) },
      ...engine.sanitiseHistory(history),
      { role: 'user', content: user + noteBlock },
    ],
    tools: [SUBMIT_PLAN],
  });

  const raw = extract(out);
  if (!raw) {
    return { ok: false, reason: 'the planner gave no usable plan — it did not call submit_plan and its text was not JSON' };
  }
  const v = validate(raw, toolNames);
  if (!v.ok) return { ok: false, reason: 'the planner\'s plan was refused: ' + v.reason };
  return { ok: true, plan: v.plan };
}

module.exports = { plan, validate, extract, renderPlanText, systemPrompt, SUBMIT_PLAN, MAX_STEPS, MAX_REPLANS };
