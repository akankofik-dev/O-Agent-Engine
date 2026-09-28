'use strict';
/* ====================================================================== *
 *  ai/providers.js — LLM provider abstraction.
 *
 *  The agent engine only ever sees `chat()` / `test()` / `listModels()`
 *  on a normalised request/response shape. It never knows which vendor
 *  is behind the socket, and no adapter knows anything about the browser.
 *
 *  protocol        url                                  auth
 *  --------------  -----------------------------------  --------------------------
 *  openai-compatible  {base}/chat/completions           Authorization: Bearer
 *  anthropic-messages {base}/messages                   x-api-key + version
 *  ollama             {base}/api/chat                   none (local)
 * ====================================================================== */

/* The wording families live in compat.js because that is where a model's
   usability is decided; this only borrows the matcher so a 403 is not reported
   as a bad key when the provider actually said something else. compat.js
   requires nothing, so pointing at it from here cannot become a cycle. */
const compat = require('./compat');

const PROTOCOLS = {
  'openai-compatible': 'openai-compatible',
  'anthropic-messages': 'anthropic-messages',
  ollama: 'ollama',
};

const DEFAULTS = {
  'openai-compatible': 'https://api.openai.com/v1',
  'anthropic-messages': 'https://api.anthropic.com/v1',
  ollama: 'http://127.0.0.1:11434',
};

function joinUrl(baseUrl, protocol) {
  let base = String(baseUrl || DEFAULTS[protocol] || '').trim().replace(/\/+$/, '');
  return base || DEFAULTS[protocol];
}

/** never let a stored key leak through an error string */
function scrub(text, secret) {
  let s = String(text == null ? '' : text);
  if (secret) s = s.split(secret).join('«redacted»');
  return s.replace(/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, '$1…');
}

class ProviderError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'ProviderError';
    Object.assign(this, info);
  }
}

function classify(status) {
  if (status === 401 || status === 403) return 'auth_error';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 422) return 'bad_request';
  if (status >= 500) return 'upstream_error';
  return 'unknown';
}

/* A 429 has two meanings that need opposite advice, and only the provider's own
   wording tells them apart: "busy, come back in a moment" recovers on its own,
   while a spent daily/monthly allowance does not and no amount of waiting helps.
   Getting this backwards is what tells a user to retry something that can only
   fail, so the provider's sentence is the only evidence we are willing to use. */
const RATE_TRANSIENT = /\b(rate[-_ ]?limit|too many requests|slow down|try again|overloaded)\b/i;
const RATE_QUOTA = /\b(quota|per[-_ ]?day|per[-_ ]?month|per[-_ ]?week|monthly|daily|weekly|billing|credit|insufficient|exceeded your|usage limit)\b/i;

function rateLimitScope(detail) {
  const s = String(detail || '');
  if (RATE_QUOTA.test(s)) return 'quota';
  if (RATE_TRANSIENT.test(s)) return 'transient';
  // The provider said nothing useful. Waiting is the read that costs least when
  // we are wrong: a transient that we call a quota only wastes one retry.
  return 'transient';
}

async function readBody(res) {
  const text = await res.text();
  try { return { json: JSON.parse(text), text }; } catch { return { json: null, text }; }
}

function errorFromResponse(res, body, secret, url) {
  const kind = classify(res.status);
  const detail = scrub(
    (body.json && (body.json.error && (body.json.error.message || body.json.error) || body.json.message)) || body.text,
    secret
  ).slice(0, 400);
  const label = {
    auth_error: 'authentication failed — check the API key',
    not_found: 'endpoint or model not found',
    rate_limited: 'rate limited by the provider',
    bad_request: 'the provider rejected the request',
    upstream_error: 'the provider returned a server error',
    unknown: 'request failed',
  }[kind];
  /* Only a 429 carries the extra fact, and only the ones that can wait for it
     are worth retrying. */
  const scope = kind === 'rate_limited' ? rateLimitScope(detail) : null;

  /* A 403 is two different situations wearing one status code, and calling
     both of them a bad key is how somebody ends up retyping a key that was
     perfectly fine. Some providers refuse a model they will only serve to an
     application they recognise, and say so in as many words — that is not an
     authentication problem, and no amount of retyping the key changes it. */
  const gated = kind === 'auth_error' && compat.looksGated(detail);
  /* When the provider talks about the key, believe it. When it says nothing
     that identifies the cause, do not assert one — "your key is wrong" is a
     claim, and on a 403 it is wrong often enough to send people off retyping a
     key that never needed touching. */
  const aboutKey = kind === 'auth_error' && compat.looksLikeKeyProblem(detail);

  let headline = null;
  if (gated) headline = 'this model is not available to this application';
  else if (kind === 'auth_error' && res.status === 403 && !aboutKey) {
    headline = 'the provider refused this request — the reason is not stated';
  } else if (scope === 'quota') headline = 'the provider’s allowance for this model is used up';

  return new ProviderError(`${headline || res.status + ' ' + label}${detail ? ` — ${detail}` : ''}`, {
    status: res.status, errorType: kind, url, body: detail,
    rateScope: scope, gated, aboutKey,
    retryable: kind === 'rate_limited' && scope === 'transient',
  });
}

/* ====================================================================== *
 *  base
 * ====================================================================== */

class BaseProvider {
  constructor(config) {
    this.config = config;
    this.protocol = PROTOCOLS['openai-compatible'];
  }
  get baseUrl() { return joinUrl(this.config.baseUrl, this.protocol); }
  get model() { return this.config.model || ''; }
  get params() { return this.config.params || {}; }
  get secret() { return this.config.apiKey || ''; }

  /** extra headers the user configured, plus provider-specific extras */
  commonHeaders() {
    const h = { 'content-type': 'application/json', ...(this.config.headers || {}) };
    if (this.config.organization) h['openai-organization'] = this.config.organization;
    if (this.config.projectId) h['openai-project'] = this.config.projectId;
    return h;
  }

  async fetchJson(url, init) {
    const timeout = this.params.timeoutMs || 120000;
    let res;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
      throw new ProviderError(
        timedOut
          ? `no response after ${Math.round(timeout / 1000)}s — is the endpoint reachable?`
          : `could not reach ${url} — ${scrub(e.cause && e.cause.message ? e.cause.message : e.message, this.secret)}`,
        { errorType: timedOut ? 'timeout' : 'network_error', url }
      );
    }
    const body = await readBody(res);
    if (!res.ok) throw errorFromResponse(res, body, this.secret, url);
    return body.json;
  }

  async listModels() {
    return [];
  }
  async chat() { throw new ProviderError('chat() not implemented for ' + this.protocol); }
  async test() {
    const t0 = Date.now();
    const out = await this.chat({
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 4,
    });
    return { ok: true, model: out.model || this.model, latencyMs: Date.now() - t0 };
  }
}

/* ====================================================================== *
 *  OpenAI-compatible — the compatibility layer every custom endpoint uses
 * ====================================================================== */

class OpenAICompatibleProvider extends BaseProvider {
  constructor(config) { super(config); this.protocol = 'openai-compatible'; }

  url(suffix) {
    const base = this.baseUrl;
    if (!suffix) return base;
    if (/\/chat\/completions$/i.test(base)) return base;
    return base + suffix;
  }

  authHeaders() {
    const h = this.commonHeaders();
    if (this.secret) h.authorization = `Bearer ${this.secret}`;
    return h;
  }

  toWire(messages, tools) {
    const wire = [];
    for (const m of messages) {
      if (m.role === 'tool') {
        wire.push({ role: 'tool', tool_call_id: m.toolCallId, content: String(m.content ?? '') });
      } else if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
        wire.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map(c => ({
            id: c.id, type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
          })),
        });
      } else if (m.role === 'user' && Array.isArray(m.images) && m.images.length) {
        wire.push({
          role: 'user',
          content: [
            { type: 'text', text: String(m.content ?? '') },
            ...m.images.map(img => ({ type: 'image_url', image_url: { url: img.dataUrl } })),
          ],
        });
      } else {
        wire.push({ role: m.role, content: String(m.content ?? '') });
      }
    }
    const body = { model: this.model, messages: wire };
    if (tools && tools.length) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} } },
      }));
      body.tool_choice = 'auto';
    }
    const p = this.params;
    if (p.temperature !== null && p.temperature !== undefined) body.temperature = p.temperature;
    if (p.topP !== null && p.topP !== undefined) body.top_p = p.topP;
    if (p.maxTokens) body.max_tokens = p.maxTokens;
    // only sent when the user picked a level; "auto" adds nothing to the request
    if (p.reasoning && p.reasoning !== 'auto') body.reasoning_effort = p.reasoning;
    return body;
  }

  fromWire(json) {
    const choice = (json && json.choices && json.choices[0]) || {};
    const msg = choice.message || choice.delta || {};
    const toolCalls = (msg.tool_calls || []).map((c, i) => {
      let args = {};
      try { args = JSON.parse((c.function && c.function.arguments) || '{}'); } catch { args = {}; }
      return { id: c.id || `call_${i}`, name: (c.function && c.function.name) || '', args };
    }).filter(c => c.name);
    return {
      text: typeof msg.content === 'string' ? msg.content : (Array.isArray(msg.content) ? msg.content.map(x => x.text || '').join('') : ''),
      toolCalls,
      finishReason: choice.finish_reason || (toolCalls.length ? 'tool_calls' : null),
      usage: json.usage || null,
      model: json.model || this.model,
      raw: json,
    };
  }

  async chat({ messages, tools, maxTokens } = {}) {
    const body = this.toWire(messages, tools);
    if (maxTokens) { body.max_tokens = maxTokens; delete body.temperature; }
    const json = await this.fetchJson(this.url('/chat/completions'), {
      method: 'POST', headers: this.authHeaders(), body: JSON.stringify(body),
    });
    return this.fromWire(json);
  }

  async listModels() {
    const json = await this.fetchJson(this.url('/models'), { method: 'GET', headers: this.authHeaders() });
    const list = Array.isArray(json && json.data) ? json.data : Array.isArray(json) ? json : [];
    return list.map(m => (typeof m === 'string' ? m : m.id)).filter(Boolean);
  }

  /**
   * The same list, with the provider's own per-model record when it publishes
   * one. Only fields the picker can honestly display are kept.
   */
  async listModelsDetailed() {
    const json = await this.fetchJson(this.url('/models'), { method: 'GET', headers: this.authHeaders() });
    const list = Array.isArray(json && json.data) ? json.data : Array.isArray(json) ? json : [];
    const out = [];
    for (const m of list) {
      if (typeof m === 'string') { out.push({ id: m }); continue; }
      if (!m || !m.id) continue;
      out.push({
        id: m.id,
        label: typeof m.name === 'string' ? m.name.slice(0, 160) : '',
        description: typeof m.description === 'string' ? m.description.slice(0, 400) : '',
        context_length: Number(m.context_length) || 0,
        architecture: m.architecture && typeof m.architecture === 'object' ? {
          modality: m.architecture.modality || '',
          input_modalities: Array.isArray(m.architecture.input_modalities) ? m.architecture.input_modalities.slice(0, 8) : [],
          output_modalities: Array.isArray(m.architecture.output_modalities) ? m.architecture.output_modalities.slice(0, 4) : [],
        } : null,
        pricing: m.pricing && typeof m.pricing === 'object' ? {
          prompt: m.pricing.prompt, completion: m.pricing.completion,
        } : null,
        supported_parameters: Array.isArray(m.supported_parameters) ? m.supported_parameters.slice(0, 40) : null,
        expiration_date: m.expiration_date || null,
        per_request_limits: m.per_request_limits === undefined ? null : m.per_request_limits,
      });
    }
    return out;
  }
}

/* ====================================================================== *
 *  Anthropic messages API
 * ====================================================================== */

class AnthropicProvider extends BaseProvider {
  constructor(config) { super(config); this.protocol = 'anthropic-messages'; }

  authHeaders() {
    return {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(this.secret ? { 'x-api-key': this.secret } : {}),
      ...(this.config.headers || {}),
    };
  }

  toWire(messages, tools) {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const rest = messages.filter(m => m.role !== 'system');
    const wire = [];
    for (const m of rest) {
      if (m.role === 'tool') {
        wire.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: String(m.content ?? '') }] });
        continue;
      }
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
        const content = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const c of m.toolCalls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} });
        wire.push({ role: 'assistant', content });
        continue;
      }
      if (m.role === 'user' && Array.isArray(m.images) && m.images.length) {
        wire.push({
          role: 'user',
          content: [
            { type: 'text', text: String(m.content ?? '') },
            ...m.images.map(img => ({
              type: 'source',
              source: {
                type: 'base64',
                media_type: img.mime || 'image/png',
                data: String(img.dataUrl || '').split(',')[1] || '',
              },
            })),
          ],
        });
        continue;
      }
      wire.push({ role: m.role, content: String(m.content ?? '') });
    }
    const body = {
      model: this.model,
      max_tokens: this.params.maxTokens || 4096,
      messages: wire,
    };
    if (system) body.system = system;
    if (tools && tools.length) {
      body.tools = tools.map(t => ({
        name: t.name, description: t.description,
        input_schema: t.parameters || { type: 'object', properties: {} },
      }));
    }
    const p = this.params;
    if (p.temperature !== null && p.temperature !== undefined) body.temperature = p.temperature;
    if (p.topP !== null && p.topP !== undefined) body.top_p = p.topP;
    return body;
  }

  fromWire(json) {
    const blocks = (json && json.content) || [];
    const text = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('');
    const toolCalls = blocks.filter(b => b.type === 'tool_use')
      .map(b => ({ id: b.id, name: b.name, args: b.input || {} }));
    return {
      text,
      toolCalls,
      finishReason: json.stop_reason || (toolCalls.length ? 'tool_calls' : null),
      usage: json.usage || null,
      model: json.model || this.model,
      raw: json,
    };
  }

  async chat({ messages, tools } = {}) {
    const json = await this.fetchJson(this.baseUrl + '/messages', {
      method: 'POST', headers: this.authHeaders(), body: JSON.stringify(this.toWire(messages, tools)),
    });
    return this.fromWire(json);
  }

  async listModels() {
    const json = await this.fetchJson(this.baseUrl + '/models?limit=100', { method: 'GET', headers: this.authHeaders() });
    return ((json && json.data) || []).map(m => m.id).filter(Boolean);
  }
}

/* ====================================================================== *
 *  Ollama (local)
 * ====================================================================== */

class OllamaProvider extends BaseProvider {
  constructor(config) { super(config); this.protocol = 'ollama'; }

  toWire(messages, tools) {
    const wire = messages.map(m => {
      if (m.role === 'tool') {
        return { role: 'tool', content: String(m.content ?? '') };
      }
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
        return {
          role: 'assistant', content: m.content || '',
          tool_calls: m.toolCalls.map(c => ({ function: { name: c.name, arguments: c.args || {} } })),
        };
      }
      return { role: m.role, content: String(m.content ?? '') };
    });
    const body = { model: this.model, messages: wire, stream: false };
    if (tools && tools.length) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} } },
      }));
    }
    const p = this.params;
    if (p.temperature !== null && p.temperature !== undefined) (body.options ||= {}).temperature = p.temperature;
    if (p.topP !== null && p.topP !== undefined) (body.options ||= {}).top_p = p.topP;
    if (p.maxTokens) (body.options ||= {}).num_predict = p.maxTokens;
    return body;
  }

  fromWire(json) {
    const m = json.message || {};
    return {
      text: m.content || '',
      toolCalls: (m.tool_calls || []).map((c, i) => ({
        id: c.id || `call_${i}`, name: (c.function && c.function.name) || '', args: (c.function && c.function.arguments) || {},
      })),
      finishReason: json.done_reason || null,
      usage: { prompt_tokens: json.prompt_eval_count, completion_tokens: json.eval_count },
      model: json.model || this.model,
      raw: json,
    };
  }

  async chat({ messages, tools } = {}) {
    for (const m of messages || []) {
      if (Array.isArray(m.images) && m.images.length) {
        throw new ProviderError(
          'this provider cannot take image attachments here — attach a text file, or point the agent at an OpenAI-compatible endpoint',
          { errorType: 'unsupported' }
        );
      }
    }
    const json = await this.fetchJson(this.baseUrl + '/api/chat', {
      method: 'POST', headers: this.commonHeaders(), body: JSON.stringify(this.toWire(messages, tools)),
    });
    return this.fromWire(json);
  }

  async listModels() {
    const json = await this.fetchJson(this.baseUrl + '/api/tags', { method: 'GET', headers: this.commonHeaders() });
    return ((json && json.models) || []).map(m => m.name).filter(Boolean);
  }
}

/* ====================================================================== *
 *  registry
 * ====================================================================== */

const REGISTRY = {
  'openai-compatible': OpenAICompatibleProvider,
  'anthropic-messages': AnthropicProvider,
  ollama: OllamaProvider,
};

function providerClass(protocol) {
  return REGISTRY[protocol] || REGISTRY['openai-compatible'];
}

/** build a client for a stored provider config */
function create(config) {
  if (!config) throw new ProviderError('no provider configured');
  const Cls = providerClass(config.protocol);
  return new Cls(config);
}

module.exports = { create, providerClass, REGISTRY, PROTOCOLS, DEFAULTS, ProviderError, scrub, joinUrl };
