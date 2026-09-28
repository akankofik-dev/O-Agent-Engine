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

/* ---- keeping the conversation inside the window ---------------------- *
 * A run adds to the context on every round: 12k of tool result, plus whatever
 * the assistant said. Nothing was measuring that, so a long enough task simply
 * grew past what the model accepts and the run died — taking every tool result
 * it had already paid for with it. The cap below is deliberately conservative
 * (≈30k tokens) so it fits models far smaller than the ones people usually
 * point this at, and the engine lowers it further if the provider says the
 * request was still too big. */
const CONTEXT_BUDGET_CHARS = Number(process.env.AI_CONTEXT_CHARS) || 120000;
/* A floor, but a small one. It was 8000, which looked like a safety net and was
   the opposite: a conversation of 1829 characters is under 8000, so every shrink
   landed on the floor, the retry went out byte-identical, and the run burned all
   four attempts being refused for the same reason. The floor only has to stop
   the budget reaching zero — below that, fitting is the clipper's job. */
const MIN_BUDGET_CHARS = 200;
const MAX_SHRINKS = 4;

function messageChars(m) {
  if (typeof m.content === 'string') return m.content.length;
  try { return JSON.stringify(m.content).length; } catch { return String(m.content || '').length; }
}

/* An assistant turn that asked for tools, and the results answering it, are one
   indivisible unit. A provider handed the calls without their results — or the
   results without their calls — sees a malformed conversation and fails the
   whole request, so the trimmer drops whole groups and never half of one. */
function blockify(messages) {
  const blocks = [];
  for (const m of messages) {
    const prev = blocks[blocks.length - 1];
    if (m.role === 'tool' && prev) { prev.messages.push(m); continue; }
    blocks.push({ messages: [m] });
  }
  return blocks;
}

/**
 * Drop the oldest turns until the request fits `budget`.
 * Oldest goes first because that is where the loss costs least: the newest tool
 * results are the ones the agent is about to act on, and a half-remembered
 * exchange from earlier is the part it can most afford to lose.
 * @returns {{messages: Array, dropped: number, chars: number}}
 */
const totalChars = list => list.reduce((a, m) => a + messageChars(m), 0);

/**
 * Shorten a group of messages to fit `room`, keeping every role and, where a
 * message is left at all, a piece of it. Roles are never dropped: a trimmed
 * conversation is smaller, a conversation missing its tool results is broken.
 */
function clipTo(messages, room) {
  if (totalChars(messages) <= room) return messages;
  const NOTE = '…[cut to fit]';
  const out = [];
  let left = room;
  for (const m of messages) {
    if (left <= 0) break;
    const len = messageChars(m);
    if (typeof m.content === 'string' && len > left) {
      /* Below the length of the note there is no room to say anything, so the
         note is dropped rather than allowed to push the result back over the
         budget it was cut to meet. */
      out.push(left <= NOTE.length
        ? { ...m, content: m.content.slice(0, left) }
        : { ...m, content: m.content.slice(0, left - NOTE.length) + NOTE });
      left = 0;
    } else {
      out.push(m);
      left -= len;
    }
  }
  return out;
}

/**
 * Fit a conversation into `budget`, dropping the oldest turns first.
 *
 * The two rules that matter: the system prompt is never dropped, and the result
 * is never *bigger* than what came in. Both were found the hard way — a system
 * prompt left whole makes every shrink a no-op, and a "always keep the newest
 * turn whole" rule can hand back a request larger than the one that was
 * refused, which is how a run dies having learned nothing from four attempts.
 */
function fitContext(messages, budget) {
  const before = totalChars(messages);
  if (before <= budget) return { messages, dropped: 0, chars: before };

  const blocks = blockify(messages);
  const system = blocks[0] || { messages: [] };
  const tail = blocks.slice(1);

  const head = clipTo(system.messages, Math.floor(budget * 0.6));
  const room = Math.max(0, budget - totalChars(head));

  const kept = [];
  let used = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const blockSize = totalChars(tail[i].messages);
    if (used + blockSize > room) break;
    kept.unshift(tail[i]);
    used += blockSize;
  }
  /* Nothing fitted, so the newest turn is clipped into what is left rather than
     dropped whole: an empty request is an error nobody can act on, and one that
     is merely smaller is still worth sending. */
  if (!kept.length && tail.length) kept.push({ messages: clipTo(tail[tail.length - 1].messages, room) });

  const out = head.concat(...kept.map(b => b.messages));
  return { messages: out, dropped: tail.length - kept.length, chars: totalChars(out) };
}

/* Backoff for a request that never got an answer. Long enough that a busy
   endpoint has room to breathe, short enough that a person watching a spinner
   does not decide the app has hung. Overridable because the wait is a guess
   about someone else's server, and a different endpoint is a different guess. */
const RETRY_DELAYS_MS = (() => {
  const raw = String(process.env.AI_RETRY_DELAYS_MS || '').trim();
  if (!raw) return [1000, 3000, 8000];
  const parsed = raw.split(',').map(n => Number(n.trim())).filter(n => Number.isFinite(n) && n >= 0);
  return parsed.length ? parsed : [1000, 3000, 8000];
})();

/** wait, but give up the moment the user stops — a retry that outlives the stop
 *  button is a run that keeps working after the user walked away from it */
function waitOrStop(ms, stopped) {
  return new Promise(resolve => {
    const step = 100;
    let left = ms;
    const tick = () => {
      if (stopped() || left <= 0) return resolve(stopped());
      /* the delay is taken from what is left *before* it is spent, or a wait
         shorter than one step hands setTimeout a negative number */
      const wait = Math.min(step, left);
      left -= wait;
      setTimeout(tick, wait);
    };
    tick();
  });
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
  /* Lowers for the rest of the run if a provider ever says the request was too
     big — a limit learned from an actual refusal beats one guessed up front. */
  let budget = CONTEXT_BUDGET_CHARS;

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

    /* A round is not one request. It is one request plus whatever it takes to
       get an answer, because a dropped connection and a busy endpoint say
       nothing about whether the work so far was any good — and the tool results
       already sitting in `messages` cannot be re-earned by making a person
       press send again. */
    let out = null, failure = null, retries = 0, shrinks = 0;
    for (;;) {
      if (stopped()) { emit({ type: 'stopped', rounds: round - 1, text: finalText }); return { ok: true, rounds: round - 1, text: finalText, stopped: true }; }

      const fitted = fitContext(messages, budget);
      if (fitted.dropped) {
        emit({ type: 'context_trimmed', round, dropped: fitted.dropped, chars: fitted.chars, budget });
      }

      try {
        out = await provider.chat({ messages: fitted.messages, tools: toolSchemas });
        failure = null;
        break;
      } catch (e) {
        /* Too big is not a rejection. The same conversation at a smaller size is
           a different request, and what it costs is the oldest turns — the
           work in hand is untouched. So the budget comes down and the same
           round is asked again. Once there is nothing left to give, the answer
           is no: resending the same size is not a retry, it is the same
           request again, and paying for it three more times buys nothing. */
        if (e.contextOverflow) {
          if (shrinks >= MAX_SHRINKS) { failure = e; break; }
          shrinks++;
          budget = Math.max(MIN_BUDGET_CHARS, Math.floor(fitted.chars * 0.6));
          emit({ type: 'context_shrunk', round, attempt: shrinks, budget, chars: fitted.chars });
          continue;
        }
        const canRetry = e.retryable === true && retries < RETRY_DELAYS_MS.length;
        if (!canRetry) { failure = e; break; }
        const waitMs = RETRY_DELAYS_MS[retries++];
        emit({
          type: 'retry', round,
          attempt: retries, of: RETRY_DELAYS_MS.length + 1, waitMs,
          errorType: e.errorType || 'unknown',
          message: providers.scrub(e.message, provider.secret),
          model: provider.model,
        });
        if (await waitOrStop(waitMs, stopped)) {
          emit({ type: 'stopped', rounds: round - 1, text: finalText });
          return { ok: true, rounds: round - 1, text: finalText, stopped: true };
        }
      }
    }

    if (failure) {
      emit({
        type: 'error',
        round,
        message: providers.scrub(failure.message, provider.secret),
        errorType: failure.errorType || 'unknown',
        status: failure.status || null,
        /* A 429 is either "busy, retry in a moment" or "this allowance is
           spent, nothing you do now will help". The page cannot tell those
           apart from the sentence alone, so the fact is carried out with the
           message rather than left to be guessed from the wording. */
        rateScope: failure.rateScope || null,
        retryable: failure.retryable === true,
        contextOverflow: failure.contextOverflow === true,
        gated: failure.gated === true,
        model: provider.model,
      });
      return {
        ok: false, rounds, text: finalText, error: failure.message,
        contextOverflow: failure.contextOverflow === true,
      };
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

module.exports = { runAgent, prepareContext, sanitiseHistory, fitContext, MAX_RESULT_CHARS, CONTEXT_BUDGET_CHARS };
