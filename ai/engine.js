'use strict';
/* ====================================================================== *
 *  ai/engine.js — the agent engine.
 *
 *  Layer order is enforced here:
 *
 *      LLMProvider  (ai/providers.js)  — transport + wire format
 *            ↓
 *      ContextBuilder (ai/context.js) — assembles every prompt byte
 *            ↓
 *      AgentEngine  (this file)        — the tool-calling loop
 *            ↓
 *      Tool runner  (ai/tools.js)      — one tool = one browser/shell action
 *            ↓
 *      controller                      — CDP / child_process, injected by server
 *
 *  The engine never learns a vendor name, never reads a file itself and never
 *  touches Chrome: it asks the context builder for the system message and then
 *  calls provider.chat() and controller.browser.action().
 * ====================================================================== */

const tools = require('./tools');
const providers = require('./providers');
const skillsLib = require('./skills');
const contextLib = require('./context');
const agentFiles = require('./agentfiles');
const attachments = require('./attachments');

/** keep one tool result from eating the whole context window */
const MAX_RESULT_CHARS = 12000;

function clip(value) {
  let text;
  if (typeof value === 'string') text = value;
  else {
    try { text = JSON.stringify(value); } catch { text = String(value); }
  }
  if (text === undefined) text = '';
  if (text.length > MAX_RESULT_CHARS) {
    return text.slice(0, MAX_RESULT_CHARS) + `\n… [truncated ${text.length - MAX_RESULT_CHARS} more characters]`;
  }
  return text;
}

/** trim anything the previous provider shape cannot represent */
function sanitiseHistory(history) {
  const out = [];
  for (const m of Array.isArray(history) ? history : []) {
    if (!m || !m.role) continue;
    if (m.role === 'user' || m.role === 'assistant') {
      const text = typeof m.content === 'string' ? m.content : clip(m.content);
      if (text.trim()) out.push({ role: m.role, content: text });
    }
    // tool / tool_call turns are intentionally dropped: they reference ids
    // from a provider response this process no longer has
  }
  return out.slice(-24);
}

/**
 * Gather everything the context builder needs.
 * Used by runAgent and by the Settings "preview context" route, so both see
 * byte-identical context.
 */
async function prepareContext({ profile, controller }) {
  const skillInfo = skillsLib.resolve(profile.skills, profile.tools);
  const toolDefs = tools.toolsFor(profile);

  let files = { soul: '', memory: '' };
  try {
    const f = agentFiles.read(profile.id);
    files = { soul: f.soul, memory: f.memory };
  } catch { /* an agent with no usable id simply gets no documents */ }

  let runtime = {};
  try {
    if (controller && controller.browser && typeof controller.browser.runtime === 'function') {
      runtime = (await controller.browser.runtime()) || {};
    }
  } catch { /* no page attached is a normal state */ }
  runtime.at = new Date().toISOString();

  const built = contextLib.buildContext({
    profile,
    files,
    skillInfo,
    runtime,
    toolNames: toolDefs.map(t => t.name),
  });

  return {
    skillInfo,
    toolDefs,
    toolSchemas: toolDefs.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })),
    caps: skillInfo.caps,
    files,
    runtime,
    context: built,
  };
}

/**
 * Run one turn.
 *
 * @param {object}   o
 * @param {object}   o.provider    instance from providers.create()
 * @param {object}   o.profile     resolved agent profile
 * @param {string}   o.text        the user's message
 * @param {Array}    [o.history]     prior user/assistant turns
 * @param {Array}    [o.attachments] attachment ids from ai/attachments
 * @param {Function} [o.shouldStop]  polled between rounds and tool calls
 * @param {object}   o.controller    { browser: {action, tabs, runtime}, shell: {exec} }
 * @param {Function} o.onEvent       (event) => void   — streaming sink
 */
async function runAgent({ provider, profile, text, history, attachments: attachmentIds, shouldStop, controller, onEvent }) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const stopped = typeof shouldStop === 'function' ? shouldStop : () => false;

  const prepared = await prepareContext({ profile, controller });
  const { skillInfo, toolSchemas, caps, context } = prepared;

  const ctx = {
    browser: {
      action: body => controller.browser.action(body),
      tabs: a => controller.browser.tabs(a),
    },
    shell: controller.shell,
  };

  const maxRounds = (profile && profile.maxRounds) || 8;

  /* Attachments are resolved here so the user message is the only thing the
     provider sees. With no attachments this is byte-identical to before. */
  const parts = attachments.toMessageParts(attachmentIds);
  let userText = String(text || '');
  if (parts.text) userText += (userText ? '\n\n' : '') + parts.text;
  const userMessage = { role: 'user', content: userText };
  if (parts.images.length) userMessage.images = parts.images;

  const messages = [
    { role: 'system', content: context.system },
    ...sanitiseHistory(history),
    userMessage,
  ];

  let finalText = '';
  let rounds = 0;

  emit({
    type: 'start',
    model: provider.model,
    protocol: provider.protocol,
    profile: profile ? profile.name : null,
    tools: toolSchemas.map(t => t.name),
    skills: skillInfo.selected.map(s => s.id),
    capabilities: Object.keys(caps).filter(k => caps[k]),
    contextChars: context.chars,
    contextSections: context.sections,
    attachments: parts.count,
  });

  for (let round = 1; round <= maxRounds; round++) {
    if (stopped()) { emit({ type: 'stopped', rounds: round - 1, text: finalText }); return { ok: true, rounds: round - 1, text: finalText, stopped: true }; }
    rounds = round;
    let out;
    try {
      out = await provider.chat({ messages, tools: toolSchemas });
    } catch (e) {
      emit({
        type: 'error',
        round,
        message: providers.scrub(e.message, provider.secret),
        errorType: e.errorType || 'unknown',
        status: e.status || null,
        /* A 429 is either "busy, retry in a moment" or "this allowance is
           spent, nothing you do now will help". The page cannot tell those
           apart from the sentence alone, so the fact is carried out with the
           message rather than left to be guessed from the wording. */
        rateScope: e.rateScope || null,
        retryable: e.retryable === true,
        gated: e.gated === true,
        model: provider.model,
      });
      return { ok: false, rounds, text: finalText, error: e.message };
    }

    messages.push({ role: 'assistant', content: out.text || '', toolCalls: out.toolCalls || [] });
    if (out.text) {
      finalText = out.text;
      emit({ type: 'assistant', round, text: out.text });
    }

    if (!out.toolCalls || !out.toolCalls.length) {
      emit({ type: 'done', rounds: round, text: finalText });
      return { ok: true, rounds: round, text: finalText };
    }

    for (const call of out.toolCalls) {
      if (stopped()) { emit({ type: 'stopped', rounds: round, text: finalText }); return { ok: true, rounds: round, text: finalText, stopped: true }; }
      emit({ type: 'tool_call', id: call.id, name: call.name, args: call.args, label: tools.label(call.name, call.args) });

      const def = tools.toolByName(call.name);
      let payload, ok = true, failure = null;
      if (!def) {
        ok = false;
        failure = `unknown tool: ${call.name}`;
      } else if (!def.caps.some(c => caps[c])) {
        ok = false;
        failure = `tool ${call.name} is disabled in this agent profile`;
      } else {
        try {
          payload = await def.run(ctx, call.args || {});
        } catch (e) {
          ok = false;
          failure = e.message;
        }
      }

      const text = ok ? clip(payload) : `error: ${failure}`;
      emit({ type: 'tool_result', id: call.id, name: call.name, ok, error: failure, result: ok ? payload : null });

      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: text });
    }
  }

  emit({ type: 'done', rounds, text: finalText, truncated: true });
  return { ok: true, rounds, text: finalText, truncated: true };
}

module.exports = { runAgent, prepareContext, sanitiseHistory, MAX_RESULT_CHARS };
