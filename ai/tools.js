'use strict';
/* ====================================================================== *
 *  ai/tools.js — the tool layer the agent may call.
 *
 *  Tools know nothing about which LLM is driving them and nothing about
 *  HTTP. They are declared with a capability tag so an agent profile can
 *  switch whole groups on or off, and they receive an injected controller
 *  ({ browser, shell }) from the host so the same definitions work for the
 *  HTTP run endpoint and for tests.
 * ====================================================================== */

const asString = v => (v === undefined || v === null ? '' : String(v));

const skills = require('./skills');
const rules = require('./rules');

/** every tool: name, capability tags, JSON schema, runner */
const TOOLS = [
  {
    name: 'browser_read',
    caps: ['dom'],
    description: 'Read a page: url, title, visible text, headings, links, buttons and form fields, each with a CSS selector and a ref you can act on. Always do this before acting. A long page is cut, and says so in textTruncated; pass a selector to read the part you need instead of the whole page.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'The tab to act on, as tab_<id> from browser_tabs. Defaults to the tab you already own.' },
        selector: { type: 'string', description: 'Read only this region, as a CSS selector, and take the text from it. Use this when a whole-page read came back truncated and you need the part that was cut, or when you only care about one part of the page. Refused if it matches nothing, rather than quietly reading the whole page.' },
      },
      additionalProperties: false,
    },
    run: (ctx, a) => ctx.browser.action({ action: 'read', tabId: asString(a.tabId) || undefined, selector: asString(a.selector) || undefined }),
  },
  {
    name: 'browser_navigate',
    caps: ['browser'],
    description: 'Open a URL. A bare domain gets https://; anything else becomes a search.',
    parameters: {
      type: 'object', properties: {
        tabId: { type: 'string', description: 'The tab to act on, as tab_<id> from browser_tabs. Defaults to the tab you already own.' },
        url: { type: 'string', description: 'Absolute URL or search text' },
      },
      required: ['url'], additionalProperties: false,
    },
    run: (ctx, a) => ctx.browser.action({ action: 'navigate', tabId: asString(a.tabId) || undefined, url: asString(a.url) }),
  },
  {
    name: 'browser_click',
    caps: ['browser'],
    description: 'Click an element. Prefer a selector; nx/ny are normalised 0..1 coordinates on the viewport only.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'The tab to act on, as tab_<id> from browser_tabs. Defaults to the tab you already own.' },
        ref: { type: 'string', description: 'An element handle from browser_read. It belongs to one tab and expires after that tab navigates.' },
        selector: { type: 'string', description: 'CSS selector from browser_read, if you would rather not use a ref' },
        nx: { type: 'number', description: 'Normalised x 0..1' },
        ny: { type: 'number', description: 'Normalised y 0..1' },
      },
      additionalProperties: false,
    },
    run: (ctx, a) => ctx.browser.action({
      action: 'click', tabId: asString(a.tabId) || undefined,
      ref: asString(a.ref) || undefined, selector: a.selector, nx: a.nx, ny: a.ny,
    }),
  },
  {
    name: 'browser_type',
    caps: ['browser'],
    description: 'Focus an element and type text into it.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'The tab to act on, as tab_<id> from browser_tabs. Defaults to the tab you already own.' },
        ref: { type: 'string', description: 'An element handle from browser_read. It belongs to one tab and expires after that tab navigates.' },
        selector: { type: 'string', description: 'CSS selector, if not using a ref' },
        text: { type: 'string' },
        clear: { type: 'boolean', description: 'Select the existing content first so it is replaced' },
      },
      required: ['text'], additionalProperties: false,
    },
    run: (ctx, a) => ctx.browser.action({
      action: 'type', tabId: asString(a.tabId) || undefined,
      ref: asString(a.ref) || undefined, selector: a.selector, text: asString(a.text), clear: !!a.clear,
    }),
  },
  {
    name: 'browser_press',
    caps: ['browser'],
    description: 'Press a key or combo: Enter, Tab, Escape, ArrowDown, Control+a, Shift+Tab…',
    parameters: {
      type: 'object', properties: {
        tabId: { type: 'string', description: 'The tab to act on, as tab_<id> from browser_tabs. Defaults to the tab you already own.' },
        key: { type: 'string' },
      }, required: ['key'], additionalProperties: false,
    },
    run: (ctx, a) => ctx.browser.action({ action: 'press', tabId: asString(a.tabId) || undefined, key: asString(a.key) }),
  },
  {
    name: 'browser_scroll',
    caps: ['browser'],
    description: 'Scroll the page by a pixel amount, or bring an element into view.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'The tab to act on, as tab_<id> from browser_tabs. Defaults to the tab you already own.' },
        deltaY: { type: 'number' },
        direction: { type: 'string', enum: ['up', 'down'] },
        selector: { type: 'string', description: 'Scroll this element into view instead of the viewport' },
      },
      additionalProperties: false,
    },
    run: (ctx, a) => ctx.browser.action({
      action: 'scroll', tabId: asString(a.tabId) || undefined,
      deltaY: a.deltaY, direction: a.direction, selector: a.selector,
    }),
  },
  {
    name: 'browser_drag',
    caps: ['browser'],
    description: 'Press at one point, move, release — for sliders, drag handles and drawing.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'The tab to act on, as tab_<id> from browser_tabs. Defaults to the tab you already own.' },
        x1: { type: 'number', description: 'Start x, normalised 0..1' },
        y1: { type: 'number', description: 'Start y, normalised 0..1' },
        x2: { type: 'number', description: 'End x, normalised 0..1' },
        y2: { type: 'number', description: 'End y, normalised 0..1' },
      },
      required: ['x1', 'y1', 'x2', 'y2'], additionalProperties: false,
    },
    run: (ctx, a) => ctx.browser.action({
      action: 'drag', tabId: asString(a.tabId) || undefined,
      x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2,
    }),
  },
  {
    name: 'browser_history',
    caps: ['browser'],
    description: 'Go back or forward in history.',
    parameters: {
      type: 'object', properties: {
        tabId: { type: 'string', description: 'The tab to act on, as tab_<id> from browser_tabs. Defaults to the tab you already own.' },
        direction: { type: 'string', enum: ['back', 'forward'] },
      },
      required: ['direction'], additionalProperties: false,
    },
    run: (ctx, a) => ctx.browser.action({
      action: a.direction === 'forward' ? 'forward' : 'back', tabId: asString(a.tabId) || undefined,
    }),
  },
  {
    name: 'browser_reload',
    caps: ['browser'],
    description: 'Reload a page.',
    parameters: { type: 'object', properties: {
        tabId: { type: 'string', description: 'The tab to act on, as tab_<id> from browser_tabs. Defaults to the tab you already own.' },
    }, additionalProperties: false },
    run: (ctx, a) => ctx.browser.action({ action: 'reload', tabId: asString(a.tabId) || undefined }),
  },
  {
    name: 'browser_wait',
    caps: ['browser'],
    description: 'Wait for the page to settle before reading it again.',
    parameters: { type: 'object', properties: {
        tabId: { type: 'string', description: 'The tab to act on, as tab_<id> from browser_tabs. Defaults to the tab you already own.' },
      ms: { type: 'number' },
    }, additionalProperties: false },
    run: (ctx, a) => ctx.browser.action({ action: 'wait', tabId: asString(a.tabId) || undefined, ms: a.ms }),
  },
  {
    name: 'browser_tabs',
    caps: ['browser'],
    description: 'Your browser tabs. "list" shows every tab with the id you pass to other tools. "new" opens a tab and returns its id, and makes it the tab you drive. "activate" makes a tab yours. "close" removes one. Your own tab is the one your other tools act on when you do not name one.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new', 'activate', 'close'] },
        tabId: { type: 'string', description: 'Tab id from list or new — required for activate/close' },
        url: { type: 'string', description: 'Optional url for new' },
      },
      required: ['action'], additionalProperties: false,
    },
    run: (ctx, a) => ctx.browser.tabs({
      action: a.action,
      tabId: asString(a.tabId) || undefined,
      url: asString(a.url) || undefined,
    }),
  },
  {
    name: 'browser_screenshot',
    caps: ['screenshot'],
    description: 'Capture a tab\'s viewport as a PNG data URL. Use when you need to see something the DOM text does not describe.',
    parameters: { type: 'object', properties: {
        tabId: { type: 'string', description: 'The tab to act on, as tab_<id> from browser_tabs. Defaults to the tab you already own.' },
    }, additionalProperties: false },
    run: (ctx, a) => ctx.browser.action({ action: 'screenshot', tabId: asString(a.tabId) || undefined }),
  },
  {
    name: 'browser_js',
    caps: ['javascript'],
    description: 'Evaluate JavaScript in the page and return the result. Read-only inspection unless the user asks otherwise.',
    parameters: {
      type: 'object', properties: {
        tabId: { type: 'string', description: 'The tab to act on, as tab_<id> from browser_tabs. Defaults to the tab you already own.' },
        code: { type: 'string', description: 'Expression or statements' },
      },
      required: ['code'], additionalProperties: false,
    },
    run: (ctx, a) => ctx.browser.action({ action: 'javascript', tabId: asString(a.tabId) || undefined, code: asString(a.code) }),
  },
  {
    name: 'shell_exec',
    caps: ['terminal'],
    description: 'Run one shell command on the machine and return its combined output. Use for file, process and git work.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'A single command line' },
        timeoutMs: { type: 'number', description: 'Optional, default 20000' },
      },
      required: ['command'], additionalProperties: false,
    },
    run: (ctx, a) => ctx.shell.exec(asString(a.command), a.timeoutMs),
  },
  {
    name: 'rule_edit',
    caps: ['rules'],
    description: [
      'Propose a correction to one of your own operating rules.',
      'This does NOT change anything yet: the change waits until the user reads it and accepts it, and it is in force from then on. Never report a proposed rule as already in effect.',
      'Use it when a rule you were given is wrong, missing, or contradicts what this machine actually does — and say in the reason which rule and what made you think so.',
      'You may only change name, description and instruction. You may NOT change what tools a rule grants (requires) — that is the user\'s to decide, not yours. To add a rule that does not exist yet, use rule_create instead.',
      'This works on a rule you wrote with rule_create as well as on a shipped one, so if you get one wrong you can correct it rather than asking for a second one alongside it.',
      'A proposal for the same rule and field that is already waiting replaces it rather than adding a second.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        skillId: { type: 'string', description: 'The rule to change: browser-research, web-extraction, screenshot-analysis, coding, terminal, or any rule id you created with rule_create.' },
        field: { type: 'string', enum: rules.EDITABLE, description: 'Which part of the rule to change.' },
        value: { type: 'string', description: 'The full replacement text for that part, not a diff and not an addition.' },
        reason: { type: 'string', description: 'Why the current text is wrong, in one or two sentences. An unexplained change is refused.' },
      },
      required: ['skillId', 'field', 'value', 'reason'], additionalProperties: false,
    },
    run: (ctx, a) => rules.propose(a, 'agent'),
  },
  {
    name: 'rule_create',
    caps: ['rules'],
    description: [
      'Propose a brand new operating rule, for a job you keep having to improvise and that the rules you were given do not cover.',
      'Like rule_edit this does NOT change anything yet: the user reads it and accepts it. Never describe the rule as already in force.',
      'requires is the list of capabilities the rule needs in order to be useful: browser, screenshot, dom, javascript, terminal, rules.',
      'Ask only for what the instruction genuinely uses. A rule that asks for a capability the user has switched off is not refused — it is simply never run, and the page will show it as blocked, so asking for a capability you do not need buys you nothing and hides the ones you do.',
      'Also note that an accepted rule still has to be switched on in a profile before it reaches you. Say so in your reply if you create one, rather than telling the user it is now active.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'A short slug for the new rule: lowercase letters, digits and dashes, starting with a letter, e.g. "invoice-chasing". This is not prose and is not shown to the user.' },
        name: { type: 'string', description: 'Short human-readable name for the rule.' },
        description: { type: 'string', description: 'One line: when this rule applies.' },
        instruction: { type: 'string', description: 'The actual guidance, in the imperative, the way the existing rules are written.' },
        requires: { type: 'array', items: { type: 'string' }, description: 'Capabilities this rule needs. Use only from: browser, screenshot, dom, javascript, terminal, rules. Use [] for a rule that only tells you how to work.' },
        reason: { type: 'string', description: 'Why this rule is needed — what you could not do without it. An unexplained rule is refused.' },
      },
      required: ['id', 'name', 'description', 'instruction', 'requires', 'reason'], additionalProperties: false,
    },
    run: (ctx, a) => rules.propose({
      kind: 'create',
      skill: {
        id: a.id, name: a.name, description: a.description,
        instruction: a.instruction, requires: a.requires,
      },
      reason: a.reason,
    }, 'agent'),
  },
];

const BY_NAME = new Map(TOOLS.map(t => [t.name, t]));

/** the tool list a profile is allowed to use, including capabilities its
 *  selected skills require */
function toolsFor(profile) {
  const resolved = skills.resolve((profile && profile.skills) || [], (profile && profile.tools) || {});
  return TOOLS.filter(t => t.caps.some(c => resolved.caps[c]));
}

/** the exact schema array handed to the LLM */
function schemasFor(profile) {
  return toolsFor(profile).map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

function toolByName(name) {
  return BY_NAME.get(name) || null;
}

/** short label for the chat tool chip in the UI */
function label(name, args) {
  const a = args || {};
  switch (name) {
    case 'browser_navigate': return a.url || '';
    case 'browser_tabs': return a.tabId ? a.action + ' ' + a.tabId.slice(0, 12) : (a.action || 'list');
    case 'browser_type': return (a.selector || '') + ' ' + JSON.stringify(a.text || '');
    case 'browser_press': return a.key || '';
    case 'browser_history': return a.direction || '';
    case 'browser_click': return a.selector || (a.nx != null ? `${Number(a.nx).toFixed(2)},${Number(a.ny).toFixed(2)}` : '');
    case 'browser_drag': return `${a.x1},${a.y1} → ${a.x2},${a.y2}`;
    case 'browser_scroll': return a.direction || (a.deltaY ? `${a.deltaY}px` : '');
    case 'browser_wait': return a.ms ? `${a.ms}ms` : '';
    case 'browser_js': return String(a.code || '').slice(0, 60);
    case 'shell_exec': return a.command || '';
    default: return '';
  }
}

module.exports = { TOOLS, toolsFor, schemasFor, toolByName, label };
