'use strict';
/* ====================================================================== *
 *  ai/store.js — persistence for AI providers + agent profiles.
 *
 *  This file is the ONLY place that ever touches a raw API key.
 *  Everything that leaves the process goes through redact() first, so a
 *  saved key can never reach the dashboard, a log line or an error string.
 * ====================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const skillsLib = require('./skills');
const agentFiles = require('./agentfiles');

const DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'agent-config.json');

const PROTOCOLS = ['openai-compatible', 'anthropic-messages', 'ollama'];
/* `engines` is the odd one out and deliberately sits beside `terminal` rather
 * than in it. Both let an agent run code it wrote, and both are off by default,
 * but they are not the same grant and must not share a switch: `terminal` hands
 * over a shell, `engines` hands over a folder and a test that has to pass. */
const TOOL_KEYS = ['browser', 'screenshot', 'dom', 'javascript', 'terminal', 'rules', 'engines'];
const DEFAULT_TOOLS = { browser: true, screenshot: true, dom: true, javascript: true, terminal: false, rules: false, engines: false };

/* ----------------------------- helpers ------------------------------- */

const nowIso = () => new Date().toISOString();
const uid = (p) => p + '_' + crypto.randomBytes(6).toString('hex');
const str = (v, d = '') => (v === undefined || v === null ? d : String(v));
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** last 4 characters only — enough for the user to recognise a key */
function keyHint(key) {
  const k = String(key || '');
  if (!k) return '';
  return k.length <= 8 ? '*'.repeat(k.length) : '…' + k.slice(-4);
}

function normHeaders(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, v] of Object.entries(input)) {
    const key = str(k).trim();
    if (!key) continue;
    out[key] = str(v);
  }
  return out;
}

function normParams(input) {
  const p = input && typeof input === 'object' ? input : {};
  return {
    temperature: p.temperature === undefined || p.temperature === null || p.temperature === '' ? null : clamp(num(p.temperature, 0), 0, 2),
    maxTokens: p.maxTokens ? Math.max(1, Math.round(num(p.maxTokens, 1024))) : null,
    topP: p.topP === undefined || p.topP === null || p.topP === '' ? null : clamp(num(p.topP, 1), 0, 1),
    timeoutMs: p.timeoutMs ? clamp(Math.round(num(p.timeoutMs, 120000)), 5000, 600000) : 120000,
    // reasoning effort is opt-in: "auto" means we send nothing at all
    reasoning: ['low', 'medium', 'high'].indexOf(p.reasoning) !== -1 ? p.reasoning : 'auto',
  };
}

function normModels(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const m of input) {
    const id = typeof m === 'string' ? m : str(m && m.id);
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= 200) break;
  }
  return out;
}

function normTools(input) {
  const out = {};
  for (const k of TOOL_KEYS) {
    out[k] = input && typeof input === 'object' && input[k] !== undefined
      ? !!input[k]
      : DEFAULT_TOOLS[k];
  }
  return out;
}

/** per-agent browser policy — enforced by the agent runtime, not the UI */
function normBrowser(input) {
  const b = input && typeof input === 'object' ? input : {};
  const clean = v => (Array.isArray(v) ? v : String(v || '').split(/[\s,]+/))
    .map(x => {
      let s = String(x).trim().toLowerCase();
      if (s.includes('://')) s = s.replace(/^[a-z0-9+.-]+:\/\//, '').split('/')[0];   // pasted as a url
      else if (s.includes('/')) return '';                                        // a path, not a host
      return s;
    })
    .filter(x => x && !x.includes('..') && /^[a-z0-9.-]+$/.test(x) && x.includes('.'));
  return {
    allowedDomains: Array.from(new Set(clean(b.allowedDomains))).slice(0, 200),
    blockedDomains: Array.from(new Set(clean(b.blockedDomains))).slice(0, 200),
    allowSubdomains: b.allowSubdomains === undefined ? true : !!b.allowSubdomains,
  };
}

/**
 * true when `url` is allowed by the policy. An empty allowlist means
 * "no restriction"; a blocked hit always wins over an allowed one.
 */
function browserAllows(policy, url) {
  const p = normBrowser(policy);
  let host;
  try { host = new URL(String(url)).hostname.toLowerCase(); }
  catch { return { ok: false, reason: 'that is not a valid absolute url' }; }
  if (!host) return { ok: false, reason: 'could not read a hostname from that url' };

  const hit = (d) => host === d || (p.allowSubdomains && host.endsWith('.' + d));
  if (p.blockedDomains.some(hit)) return { ok: false, reason: host + ' is blocked by this agent profile' };
  if (p.allowedDomains.length && !p.allowedDomains.some(hit)) {
    return { ok: false, reason: host + ' is not in this agent profile allowlist (' + p.allowedDomains.join(', ') + ')' };
  }
  return { ok: true, host };
}

function normProvider(input, prev) {
  if (!input || typeof input !== 'object') return null;
  const id = str(input.id || (prev && prev.id) || uid('pv')).trim();
  const protocol = PROTOCOLS.includes(input.protocol) ? input.protocol : 'openai-compatible';
  const baseUrl = str(input.baseUrl ?? (prev && prev.baseUrl) ?? '').trim().replace(/\/+$/, '');
  const name = str(input.name, '').trim() || baseUrl || id;

  // a key is only replaced when a new one is actually supplied, so editing a
  // provider without retyping the key never destroys the stored one
  const incomingKey = str(input.apiKey, '');
  const apiKey = incomingKey
    ? incomingKey
    : (prev && prev.apiKey) || '';

  return {
    id,
    name,
    protocol,
    baseUrl,
    apiKey,
    keyPrefix: str(input.keyPrefix, (prev && prev.keyPrefix) || ''),
    model: str(input.model ?? (prev && prev.model) ?? '', '').trim(),
    models: normModels(input.models || (prev && prev.models)),
    headers: normHeaders(input.headers || (prev && prev.headers)),
    organization: str(input.organization, ''),
    projectId: str(input.projectId, ''),
    params: normParams(input.params || (prev && prev.params)),
    isCustom: input.isCustom === undefined ? (prev ? !!prev.isCustom : true) : !!input.isCustom,
    createdAt: (prev && prev.createdAt) || nowIso(),
    updatedAt: nowIso(),
  };
}

function normProfile(input, prev) {
  if (!input || typeof input !== 'object') return null;
  const id = str(input.id || (prev && prev.id) || uid('ag')).trim();

  const tools = normTools(input.tools || (prev && prev.tools));
  // selecting a skill really grants the tools it needs, so a skill is never
  // a decorative checkbox. The grant is unconditional — it comes from the
  // catalog, not from whether the flag happens to be on already.
  const skillIds = skillsLib.sanitize(input.skills || (prev && prev.skills) || []);
  for (const id of skillIds) {
    const s = skillsLib.known(id);
    if (!s) continue;
    for (const cap of s.requires) tools[cap] = true;
  }

  return {
    id,
    name: str(input.name, '').trim() || 'Agent',
    providerId: str(input.providerId ?? (prev && prev.providerId) ?? ''),
    model: str(input.model, '').trim(),          // empty = use provider default
    tools,
    skills: skillIds,
    instructions: str(input.instructions, prev ? (prev.instructions || '') : ''),
    systemPrompt: str(input.systemPrompt, prev ? (prev.systemPrompt || '') : ''),
    browser: normBrowser(input.browser || (prev && prev.browser)),
    maxRounds: clamp(Math.round(num(input.maxRounds ?? (prev && prev.maxRounds) ?? 8), 1), 1, 40),
    createdAt: (prev && prev.createdAt) || nowIso(),
    updatedAt: nowIso(),
  };
}

function normalize(raw) {
  const j = raw && typeof raw === 'object' ? raw : {};
  const providers = (Array.isArray(j.providers) ? j.providers : [])
    .map(p => normProvider(p))
    .filter(Boolean);
  const profiles = (Array.isArray(j.profiles) ? j.profiles : [])
    .map(p => normProfile(p))
    .filter(Boolean);
  let activeProfileId = str(j.activeProfileId, '');
  if (activeProfileId && !profiles.some(p => p.id === activeProfileId)) activeProfileId = '';
  if (!activeProfileId && profiles.length) activeProfileId = profiles[0].id;
  return { version: 1, providers, profiles, activeProfileId };
}

/* ------------------------------ store -------------------------------- */

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = normalize(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch {
    cache = normalize(null);
  }
  return cache;
}

function persist() {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort on Windows */ }
  fs.renameSync(tmp, FILE);
}

/** seed from env on first boot so a pre-existing env config keeps working */
function seedFromEnv(env) {
  const cfg = load();
  if (cfg.providers.length) return false;
  const baseUrl = str(env.OCTOP_AI_BASE_URL || env.OPENAI_BASE_URL || env.OPENAI_API_BASE, '').trim();
  const apiKey = str(env.OCTOP_AI_API_KEY || env.OPENAI_API_KEY, '').trim();
  const model = str(env.OCTOP_AI_MODEL || env.OPENAI_MODEL, '').trim();
  if (!baseUrl && !apiKey) return false;

  const provider = normProvider({
    id: 'pv_env',
    name: 'Environment',
    protocol: 'openai-compatible',
    baseUrl: baseUrl || 'https://api.openai.com/v1',
    apiKey,
    model: model || 'gpt-4o-mini',
    isCustom: false,
  });
  const profile = normProfile({
    id: 'ag_env',
    name: 'Default agent',
    providerId: provider.id,
    model: provider.model,
    tools: DEFAULT_TOOLS,
  });
  cache.providers.push(provider);
  cache.profiles.push(profile);
  cache.activeProfileId = profile.id;
  persist();
  return true;
}

/* ---------------------------- redaction ------------------------------ */

/** the single exit point for anything the browser is allowed to see */
function redactProvider(p) {
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    model: p.model,
    models: p.models,
    headers: { ...p.headers },
    organization: p.organization,
    projectId: p.projectId,
    params: p.params,
    isCustom: p.isCustom,
    keyPrefix: p.keyPrefix,
    hasKey: !!p.apiKey,
    keyHint: keyHint(p.apiKey),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function redactProfile(p, providers) {
  if (!p) return null;
  const provider = providers.find(x => x.id === p.providerId);
  return {
    id: p.id,
    name: p.name,
    providerId: p.providerId,
    providerName: provider ? provider.name : null,
    model: p.model || (provider ? provider.model : ''),
    tools: p.tools,
    skills: p.skills || [],
    instructions: p.instructions || '',
    systemPrompt: p.systemPrompt || '',
    browser: p.browser || { allowedDomains: [], blockedDomains: [], allowSubdomains: true },
    maxRounds: p.maxRounds,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** exactly what GET /api/config/agents returns */
function publicView() {
  const cfg = load();
  return {
    version: cfg.version,
    protocols: PROTOCOLS,
    toolKeys: TOOL_KEYS,
    providers: cfg.providers.map(redactProvider),
    profiles: cfg.profiles.map(p => redactProfile(p, cfg.providers)),
    activeProfileId: cfg.activeProfileId,
    configFile: FILE,
  };
}

/* ----------------------------- mutations ----------------------------- */

function upsertProvider(input) {
  const cfg = load();
  const i = cfg.providers.findIndex(p => p.id === input.id);
  const next = normProvider(input, i >= 0 ? cfg.providers[i] : null);
  if (!next) throw new Error('invalid provider');
  if (!next.baseUrl) throw new Error('baseUrl is required');
  if (i >= 0) cfg.providers[i] = next; else cfg.providers.push(next);
  // keep profiles pointing at a model that still exists on the provider
  for (const prof of cfg.profiles) {
    if (prof.providerId === next.id && !prof.model) prof.model = next.model;
  }
  persist();
  return redactProvider(next);
}

function deleteProvider(id) {
  const cfg = load();
  const i = cfg.providers.findIndex(p => p.id === id);
  if (i === -1) throw new Error('no such provider: ' + id);
  cfg.providers.splice(i, 1);
  for (let k = cfg.profiles.length - 1; k >= 0; k--) {
    if (cfg.profiles[k].providerId === id) cfg.profiles.splice(k, 1);
  }
  if (cfg.activeProfileId && !cfg.profiles.some(p => p.id === cfg.activeProfileId)) {
    cfg.activeProfileId = cfg.profiles.length ? cfg.profiles[0].id : null;
  }
  persist();
  return { deleted: id };
}

function upsertProfile(input) {
  const cfg = load();
  if (input.providerId && !cfg.providers.some(p => p.id === input.providerId)) {
    throw new Error('unknown provider: ' + input.providerId);
  }
  const i = cfg.profiles.findIndex(p => p.id === input.id);
  const next = normProfile(input, i >= 0 ? cfg.profiles[i] : null);
  if (!next) throw new Error('invalid profile');
  if (!next.providerId) throw new Error('providerId is required');
  if (i >= 0) cfg.profiles[i] = next; else cfg.profiles.push(next);
  if (input.activate) cfg.activeProfileId = next.id;
  persist();
  return redactProfile(next, cfg.providers);
}

function deleteProfile(id) {
  const cfg = load();
  const i = cfg.profiles.findIndex(p => p.id === id);
  if (i === -1) throw new Error('no such profile: ' + id);
  cfg.profiles.splice(i, 1);
  if (cfg.activeProfileId === id) cfg.activeProfileId = cfg.profiles.length ? cfg.profiles[0].id : null;
  persist();
  try { agentFiles.removeDir(id); } catch { /* no documents were ever written */ }
  return { deleted: id };
}

function activateProfile(id) {
  const cfg = load();
  if (!cfg.profiles.some(p => p.id === id)) throw new Error('no such profile: ' + id);
  cfg.activeProfileId = id;
  persist();
  return { activeProfileId: id };
}

/** full replace, used by Settings "Save" and by the legacy migration */
function replaceAll(input) {
  const cfg = normalize(input);
  if (cfg.providers.some(p => !p.baseUrl)) throw new Error('every provider needs a baseUrl');
  for (const prof of cfg.profiles) {
    if (!cfg.providers.some(p => p.id === prof.providerId)) throw new Error('profile ' + prof.name + ' points at a missing provider');
  }
  cache = cfg;
  persist();
  return publicView();
}

/**
 * One-way import of the pre-Settings shape that used to live in the browser:
 *   { endpoint, model, key }  (localStorage "octop:ai")
 * Nothing is overwritten — an existing provider wins, so an upgrade never
 * forces the user to re-enter anything.
 */
function migrateLegacy(legacy) {
  const cfg = load();
  const baseUrl = str(legacy.endpoint || legacy.baseUrl, '').trim().replace(/\/+$/, '');
  if (!baseUrl) return { migrated: false, reason: 'no endpoint' };

  const already = cfg.providers.find(p => p.baseUrl === baseUrl);
  if (already) {
    return { migrated: false, reason: 'provider already exists', providerId: already.id };
  }

  const provider = normProvider({
    id: uid('pv'),
    name: 'Migrated ' + baseUrl.replace(/^https?:\/\//, '').split('/')[0],
    protocol: 'openai-compatible',
    baseUrl,
    apiKey: str(legacy.key || legacy.apiKey, ''),
    model: str(legacy.model, ''),
    isCustom: true,
  });
  const profile = normProfile({
    id: uid('ag'),
    name: 'Migrated agent',
    providerId: provider.id,
    model: provider.model,
    tools: DEFAULT_TOOLS,
  });
  cfg.providers.push(provider);
  cfg.profiles.push(profile);
  persist();
  return { migrated: true, provider: redactProvider(provider), profile: redactProfile(profile, cfg.providers) };
}

/* --------------------------- resolution ------------------------------ */

function getProvider(id) {
  return load().providers.find(p => p.id === id) || null;
}
function getProfile(id) {
  return load().profiles.find(p => p.id === id) || null;
}
function activeProfile() {
  const cfg = load();
  if (!cfg.activeProfileId) return null;
  return cfg.profiles.find(p => p.id === cfg.activeProfileId) || null;
}
/** the provider + model a profile resolves to */
function resolveProfile(id) {
  const cfg = load();
  const profile = id ? cfg.profiles.find(p => p.id === id) : activeProfile();
  if (!profile) return { profile: null, provider: null, model: null };
  const provider = cfg.providers.find(p => p.id === profile.providerId) || null;
  return { profile, provider, model: profile.model || (provider && provider.model) || '' };
}

/* --------------------------- import / export --------------------------- */

/**
 * Portable bundle. It deliberately carries **no** API key, no custom headers
 * and no key prefix — the provider is referenced by id + name + baseUrl so
 * the importer can map it onto a provider that already exists.
 */
function exportProfile(profileId) {
  const cfg = load();
  const profile = cfg.profiles.find(p => p.id === profileId);
  if (!profile) throw new Error('no such profile: ' + profileId);
  const provider = cfg.providers.find(p => p.id === profile.providerId) || null;
  const files = agentFiles.read(profile.id);
  return {
    format: 'octop-agent-profile',
    version: 1,
    exportedAt: nowIso(),
    profile: {
      name: profile.name,
      model: profile.model,
      tools: profile.tools,
      skills: profile.skills || [],
      instructions: profile.instructions || '',
      systemPrompt: profile.systemPrompt || '',
      browser: profile.browser,
      maxRounds: profile.maxRounds,
    },
    providerRef: provider
      ? { id: provider.id, name: provider.name, protocol: provider.protocol, baseUrl: provider.baseUrl, model: provider.model }
      : null,
    documents: { soul: files.soul, memory: files.memory },
  };
}

/** Map by provider id, then baseUrl, then name — and fail loudly if none fit. */
function importProfile(bundle, opts) {
  const b = bundle && typeof bundle === 'object' ? bundle : null;
  if (!b || b.format !== 'octop-agent-profile') throw new Error('not an Octop agent profile bundle');
  const src = b.profile || {};
  const ref = b.providerRef || {};
  const cfg = load();

  let provider = null;
  if (ref.id) provider = cfg.providers.find(p => p.id === ref.id) || null;
  if (!provider && ref.baseUrl) provider = cfg.providers.find(p => p.baseUrl === ref.baseUrl) || null;
  if (!provider && ref.name) provider = cfg.providers.find(p => p.name === ref.name) || null;
  if (!provider) {
    throw new Error('no provider matches this profile — create one with baseUrl "' +
      (ref.baseUrl || '?') + '" in Settings first, then import again');
  }

  const created = normProfile({
    name: (opts && opts.name) || src.name || 'Imported agent',
    providerId: provider.id,
    model: src.model || '',
    tools: src.tools,
    skills: src.skills,
    instructions: src.instructions,
    systemPrompt: src.systemPrompt,
    browser: src.browser,
    maxRounds: src.maxRounds,
  });
  cfg.profiles.push(created);
  persist();

  const docs = b.documents || {};
  const written = [];
  if (typeof docs.soul === 'string') { agentFiles.write(created.id, { soul: docs.soul }); written.push('soul'); }
  if (typeof docs.memory === 'string') { agentFiles.write(created.id, { memory: docs.memory }); written.push('memory'); }

  return { profile: redactProfile(created, cfg.providers), provider: redactProvider(provider), documents: written };
}

module.exports = {
  DIR, FILE, PROTOCOLS, TOOL_KEYS, DEFAULT_TOOLS,
  load, publicView, seedFromEnv,
  upsertProvider, deleteProvider, upsertProfile, deleteProfile, activateProfile, replaceAll,
  migrateLegacy, getProvider, getProfile, activeProfile, resolveProfile,
  exportProfile, importProfile, browserAllows, normBrowser,
  keyHint,
};
