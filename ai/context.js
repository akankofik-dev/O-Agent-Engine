'use strict';
/* ====================================================================== *
 *  ai/context.js — the context builder.
 *
 *  Every prompt byte an agent sends is assembled here, in a fixed order,
 *  from one source of truth. The engine asks this module for the context;
 *  it never concatenates strings itself.
 *
 *      Profile ─┬─ SOUL.md            (who the agent is)
 *               ├─ systemPrompt       (additional system guidance)
 *               ├─ instructions      (per-agent operating rules)
 *               ├─ skills            (resolved capability grants)
 *               ├─ tools             (what it may call)
 *               ├─ MEMORY.md         (facts it should remember)
 *               └─ runtime           (the page it is looking at right now)
 *                          ↓
 *                    one system message
 * ====================================================================== */

const skills = require('./skills');

/** keep one document from eating the whole context window */
const MAX_DOC_CHARS = 12000;

/* The instructions that only make sense for an agent that drives a page.
 *
 * These used to be the whole of CORE, unconditionally. On a profile with the
 * browser permission off they were not merely unhelpful, they were wrong: the
 * prompt told a model to "read the page before you act on it" while offering it
 * no tool that can reach a page.
 *
 * Observed on exactly that profile, asked "check in our chat why it is so
 * slow". The agent had no instrument for its own run, reached for the only
 * reading tool it had, found a Cloudflare challenge on some unrelated tab, and
 * reported a network diagnosis. Four sentences about pages produced a confident
 * answer to a question they had no access to.
 *
 * So they are included when there is a browser to drive and left out when there
 * is not. A profile that never sees them is not being starved of guidance — the
 * general ones below still stand. */
const BROWSER_CORE = [
  'Read the page before you act on it, and use the CSS selectors you were given rather than guessing any.',
  'After acting, read again to confirm what actually changed before you describe the result.',
  'Only ask the user for things that cannot be read from the page, such as credentials or one-time codes.',
];

/* And the one sentence that holds for every profile: pick your own route. */
const CORE = [
  'You are an agent on this machine with a set of tools. Decide for yourself which of them a task needs — not every task needs the same route, and a task that needs none of them should be answered rather than looked up somewhere.',
  'If a capability you need is missing, check what you already have before assuming you need it.',
  'Do not begin with a tool because it is the most familiar one. Start from what the task actually requires.',
];

/* Whether this profile can actually drive a page.
 *
 * Not "does it have a tool with browser_ in the name". `browser_read` sits
 * behind the `dom` permission and is a read-only peek at a page somebody else
 * opened — an agent holding only that cannot open a tab, cannot click, and
 * cannot get anywhere. Counting it made the first attempt at this include the
 * browser instructions for the very profile they were wrong for, which is the
 * clearest possible sign that the test was asking the wrong question.
 *
 * `browser_tabs` and `browser_navigate` are the two that mean "you have a
 * browser": one opens a tab, the other goes to a URL. */
const hasBrowserTools = toolNames => (toolNames || []).some(n => n === 'browser_tabs' || n === 'browser_navigate');

function coreLines(toolNames) {
  if (!hasBrowserTools(toolNames)) return CORE;
  /* The identity line is added, not swapped in. Dropping CORE's first line to
     make room for it removed "decide for yourself which of them a task needs"
     from precisely the profile that needs it most: the one holding ten browser
     tools and the strongest pull towards always using them. The two sentences
     are not in conflict — a browser agent that picks its own route still reads
     the page before it acts. */
  return [
    'You are a browser automation agent. You control a real Chrome browser on this machine through a fixed set of tools.',
    ...CORE,
    ...BROWSER_CORE,
    'Reply in short plain sentences: what you did, then what you saw.',
  ];
}

function clip(text, max = MAX_DOC_CHARS) {
  const s = String(text || '').trim();
  if (!s) return { text: '', clipped: false };
  if (s.length <= max) return { text: s, clipped: false };
  return { text: s.slice(0, max) + `\n… [${s.length - max} more characters omitted]`, clipped: true };
}

/** HTML comments are scaffolding for the human editing the file, not model input */
function stripComments(md) {
  return String(md || '').replace(/<!--[\s\S]*?-->/g, '').trim();
}

function section(id, title, body, extra) {
  const text = String(body || '').trim();
  return Object.assign({ id, title, chars: text.length, included: !!text, body: text }, extra || {});
}

/**
 * @param {object}   o
 * @param {object}   o.profile   the agent profile row
 * @param {object}   o.files     { soul, memory } raw markdown (from ai/agentfiles)
 * @param {object}   o.skillInfo result of skills.resolve() for this profile
 * @param {object}   o.runtime   { url, title, tabs, activeToolCalls }
 * @param {string[]} o.toolNames names of the tools actually offered to the model
 */
function buildContext({ profile, files, skillInfo, runtime, toolNames }) {
  const p = profile || {};
  const f = files || {};
  const sk = skillInfo || skills.resolve(p.skills, p.tools);
  const rt = runtime || {};

  const sections = [];

  sections.push(section('core', 'Core agent instructions', coreLines(toolNames).join('\n')));

  const soul = clip(stripComments(f.soul));
  sections.push(section('soul', 'Who this agent is (SOUL.md)', soul.text, {
    clipped: soul.clipped,
    note: soul.text ? undefined : 'SOUL.md is still the untouched template',
  }));

  const instructions = clip(stripComments(p.instructions));
  sections.push(section('instructions', 'Operating instructions', instructions.text, {
    clipped: instructions.clipped,
    note: instructions.text ? undefined : 'no per-agent instructions set',
  }));

  const sysPrompt = clip(stripComments(p.systemPrompt));
  sections.push(section('systemPrompt', 'Additional system prompt', sysPrompt.text, {
    clipped: sysPrompt.clipped,
    note: sysPrompt.text ? undefined : 'none',
  }));

  const skillBlock = skills.instructionBlock(sk);
  sections.push(section('skills', 'Skills', skillBlock, {
    note: sk.selected.length ? undefined : 'no skills selected',
    detail: {
      selected: sk.selected.map(s => s.id),
      blocked: sk.blocked,
      grantedCaps: Object.keys(sk.granted),
    },
  }));

  const caps = Object.keys(p.tools || {}).filter(k => p.tools[k]);
  const toolLines = (toolNames && toolNames.length ? toolNames : [])
    .map(n => `- \`${n}\``)
    .join('\n');
  sections.push(section('tools', 'Tools available to you', toolLines, {
    note: toolNames && toolNames.length ? `capabilities: ${caps.join(', ') || 'none'}` : 'no tools are enabled for this agent',
  }));

  const memory = clip(stripComments(f.memory));
  sections.push(section('memory', 'Project memory (MEMORY.md)', memory.text, {
    clipped: memory.clipped,
    note: memory.text ? undefined : 'MEMORY.md is still the untouched template',
  }));

  /* The browser context the agent is driving. Enough to know where it is and
     that the browser is there; never anything about the connection itself. */
  const rtLines = [];
  if (rt.connected === false) {
    rtLines.push('- browser: NOT connected — you cannot act on a page right now');
  } else if (rt.session) {
    rtLines.push(`- browser: connected (${rt.session})`);
  }
  if (rt.activeTab) {
    // the identity comes before the description: every tool takes this
    rtLines.push(`- the tab you control: ${rt.tabId}`);
    rtLines.push(`  showing: ${rt.activeTab.title || rt.activeTab.url || '(untitled)'}`);
  } else if (rt.connected !== false) {
    /* Only point at browser_tabs if this profile is actually offered it.
     *
     * The line used to be written whenever Chrome was connected and no tab was
     * attached, with no reference to what the model has. On a profile with the
     * browser permission off, `browser_tabs` is filtered out of the tool list —
     * and the prompt then told the model to open a tab with a tool it does not
     * have. That is worse than saying nothing: a model told to call a tool that
     * is not there either calls it and gets an error, or invents the result.
     *
     * Measured on the profile this was found on: ten tools offered, eight of
     * them engine tools, and not one of them able to open a tab. */
    const hasTabs = (toolNames || []).includes('browser_tabs');
    rtLines.push(hasTabs
      ? '- the tab you control: none — open one with browser_tabs action "new"'
      : '- the tab you control: none, and you have no tool that can open one — work with what you can reach');
  }
  if (rt.url) rtLines.push(`- current page: ${rt.url}`);
  if (rt.title) rtLines.push(`- page title: ${rt.title}`);
  if (rt.tabs && rt.tabs.length) {
    for (const x of rt.tabs) {
      rtLines.push(`- ${(x.active ? '*' : ' ')} ${x.id}  ${x.url || '(no url)'}`);
    }
    rtLines.push('- * marks the tab you control; pass any of these ids as tabId to act on that one instead');
    rtLines.push('- refs from browser_read belong to one tab and stop working once that tab navigates');
  }
  if (rt.at) rtLines.push(`- taken at: ${rt.at}`);
  sections.push(section('runtime', 'Runtime browser context', rtLines.join('\n'), {
    note: rtLines.length ? undefined : 'no page attached',
  }));

  const parts = [];
  for (const s of sections) {
    if (!s.included) continue;
    parts.push(`## ${s.title}\n\n${s.body}`);
  }

  return {
    system: parts.join('\n\n'),
    sections: sections.map(s => ({
      id: s.id, title: s.title, chars: s.chars, included: s.included,
      clipped: !!s.clipped, note: s.note || null, detail: s.detail || null,
    })),
    chars: parts.join('\n\n').length,
  };
}

/** a compact one-liner for the Settings UI */
function summary(result) {
  return result.sections
    .filter(s => s.included)
    .map(s => `${s.title} (${s.chars})`)
    .join(' · ');
}

module.exports = { buildContext, summary, CORE, MAX_DOC_CHARS, clip, stripComments };
