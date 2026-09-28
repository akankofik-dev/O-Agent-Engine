# Browser Automation Workbench

Real Chrome driven over CDP by a zero-dependency Node server, with a
provider-agnostic AI agent behind a Settings panel. Nothing here talks to
hermes or to any other service: the only network targets are this origin and
whichever AI endpoint the user types into Settings.

```
node server.js          →  http://127.0.0.1:8787   (next free port if taken)
```

Node built-ins only — no `npm install`. Chrome is auto-launched with a
dedicated profile at `~/.octop-browser-profile`.

## Layout

```
server.js        transport: CDP client, screencast WS, action executor,
                 AI config routes, agent run (SSE), shell WS
dashboard.html   the whole UI (one file): sidebar, Chat, Browser, Terminal, Settings
ai/store.js      persistence + redaction — the only code that sees a raw key
ai/providers.js  LLMProvider abstraction + wire adapters
ai/compat.js     is this model usable through our chat path? catalogue verdicts
                 and the classification of a single probe
ai/context.js    the context builder — assembles every prompt byte
ai/engine.js     the agent tool-calling loop
ai/tools.js      tool definitions, each tagged with a capability
ai/skills.js     skill catalog: guidance + the capabilities it requires
ai/agentfiles.js SOUL.md / MEMORY.md, scoped to data/agents/<agent-id>/
ai/attachments.js chat file uploads: validate, extract, hand to the model
data/            agent-config.json (never served over HTTP)
data/inbox/      scratch space for chat attachments, swept after an hour
```

## Adding an AI

The dashboard hides the provider / agent machinery behind one flow:

```
+ Add AI  →  pick a service  →  paste the key  →  search the models  →  Use this model  →  chat
```

`Use this model` does the whole wiring in one call — it saves the provider,
creates or updates the agent, assigns the model, activates it, persists the
config, refetches the list and lands you on the chat with the composer focused.
Nothing is created twice: a service already at the same address is reused, and
so is the active agent.

There is no separate provider page. The dialog's first step lists the services
you have already added, so **switching model, editing a service and removing one**
all happen from the same three steps:

| step | what it does |
| ---- | ------------ |
| service | five presets (OpenRouter, OpenAI, Anthropic, Ollama, Other) that only prefill name, protocol and address; below them, the services you already have — click one to switch model, **Edit** for its details, **Remove** to forget it |
| key | the key is posted to the server, stored there, and never returned to the page; the field is cleared every time the dialog opens, and a saved service is never asked for its key again |
| model | `/api/ai/models` as it already was — a plain list of ids, which is the only thing the API contract promises. **Test connection** makes a real request with the model you picked, then **Use this model** |

Optional per-service settings (organization, project, extra headers,
temperature, max tokens, top P, timeout) live in an **Advanced** group inside
step two, so they never crowd the main path.

Model names and vendors are derived **in the browser** from the id
(`anthropic/claude-sonnet-4.5` → *Claude Sonnet 4.5 · Anthropic*), and the id
itself is always shown underneath in monospace, so nothing is invented. The
picker caps what it renders (250 rows) and says how many there really are, so a
catalogue of a few thousand models stays responsive.

Errors are one plain sentence each — the key was not accepted, the service
could not be reached, or it listed no models — and never a stack trace.

### Catalogue model ≠ usable model

A provider's catalogue only means *listed*. It does not mean the model will
serve our request: some models are gated behind a harness, an affiliate link or
an app registration, and reject a perfectly good key with a 403. So the picker
asks two separate questions, and never lets the first stand in for the second.

| question | answered by | cost |
| -------- | ----------- | ---- |
| *What does the provider's own record say?* | `aiCompat.catalogue()` on the server, attached to each model as `compat` | free, no request |
| *Will it actually take our request?* | `POST /api/ai/check`, one probe per model you actually look at | one small request |

The catalogue side is honest about its own limits. OpenRouter's `/models`
publishes `architecture`, `supported_parameters`, `pricing` and `context_length`
for all 458 models this project sees — and says nothing at all about a harness
gate. `thinkingmachines/inkling:free` looks exactly as usable as a model that
works, right down to advertising `tools`. So the catalogue is never used to
guess: it only reports what is really there, and it *does* block a model whose
`output_modalities` contain no `text`, because such a model cannot answer at all.

The probe is the part that costs something, so it is kept small and it is only
spent on the model being looked at:

```
messages: one user message, "Reply with the single word: ok"
max_tokens: 12        no tools        no user data
timeout: 15s          no browser      no terminal      never in chat history
```

The API key never leaves the server process. Only the verdict is kept, keyed by
model id in `localStorage["octop:model-verdicts"]` for seven days, so reopening
the dialog costs nothing. Rate limits and timeouts are deliberately **not**
cached — they say nothing about the model.

`aiCompat.classify()` turns a failure into a verdict from its **structure**
first (HTTP status, error type) and the provider's **own wording** second, as a
family of patterns rather than one exact sentence. That wording has to be
separated from our own label, because `ai/providers.js` prefixes every 401 and
403 with *"authentication failed — check the API key"*, and matching against our
own words is how a harness gate ends up blamed on a key that was fine all along.
403 is therefore split in two: wording about the key means the key is wrong;
wording about entitlement means the model cannot be used; **no** wording at all
means we could not tell, and we do not block.

| verdict | what it means | blocks `Use this model` |
| ------- | ------------- | ----------------------- |
| `ok` | the provider served our request | no |
| `unavailable` | gated: harness, affiliate, registration, entitlement, or a rejected plain request | **yes** |
| `not_found` | not in the catalogue after all | **yes** |
| `auth` | the key was rejected | **yes** |
| `rate_limited` | busy right now — not a sign the model is broken | no |
| `unreachable` | timeout or network | no |
| `unknown` | we could not tell either way | no |

A model that fails is shown struck through with a red **Unavailable** badge and
the provider's own sentence underneath, and the button is disabled. A model that
could merely not be verified is still selectable — somebody else's rate limit is
not a reason to stop you. Clicking `Use this model` while a check is still in
flight waits for the verdict it needs rather than dropping the click, and if the
button is already disabled the reason is repeated in the dialog's own message
line, where it cannot be missed by a click that does nothing.

Nothing in `ai/compat.js` names a model, a vendor or a provider. A test asserts
it: the file must not contain `inkling`, `thinkingmachines`, `openrouter`,
`qwen`, `gemma` or `nemotron`.

## The browser session

The agent owns a tab. That is the whole idea, and it is worth being exact about
what it replaced.

Before, the agent had no browser identity at all. It inherited
`STATE.activeTargetId`, one global slot, and that slot was rewritten whenever
**the person** clicked a different Chrome tab. So the agent drove whichever tab
the human happened to be looking at, and a click in another tab moved the work
somewhere else. This was reproduced, not guessed: a raw CDP
`Target.activateTarget` — what Chrome does when a human clicks a tab, with
nothing of this product in the path — moved the agent off its page.

Now the session owns the mapping, and the two questions that were conflated are
separate:

```
agentTabId     the tab the agent drives.  Only the agent changes it.
focusedTabId   the tab the person is looking at.  UI state.  Moves nothing.
```

```
agent ─► browser tool ─► explicit tabId ─► BrowserSession ─► real Page ─► Chrome
                                        │
                                        └──► preview, over the existing stream
```

The identity the agent and the UI see is a **tabId** — `tab_<uuid>`, minted in
`ai/browser/session.js`, meaningless outside. The CDP `targetId` never leaves
this process: not to the tools, not to the events, not to the page, not to the
model. `resolve()` is the only place a tabId becomes a page.

| consumer | how it gets the context |
| -------- | ----------------------- |
| browser tools | `doAction({ tabId })` — resolves through the session; with no tabId it means the tab **the agent owns**, never the one the person is looking at |
| the tab lifecycle | `doTabs()` — `new` mints a tabId and hands it straight back, `activate` assigns the agent's tab, `close` forgets it |
| the preview | the `context`/`status` payload and every `frame`, each stamped with the `tabId` it is for |
| the agent | `agentController().browser.runtime()` — its own `tabId`, and the ids of the tabs it may choose from |
| the automation router | `browserContext()` — `agentTabId` only; `focusedTabId` is not readable by an engine |

**No guessing, in either direction.** An action that names a tab which is not
there is refused and the open ids are listed. An action with no tabId falls back
to the agent's own tab, and if the agent has none, that is said rather than
picking something:

```
action navigate -> no such tab: tab_9f2c… — open tabs: tab_126d94e2…, tab_2756386b…
action navigate -> this agent has no browser tab yet — pass one of these as tabId: tab_126d94e2…
```

Closing the tab the agent is driving leaves it with **no** tab. It is not
re-picked from whatever is on top; the agent chooses again. The tab bar is how
it gets one back.

**Element references are scoped and they expire.** `browser_read` mints a handle
per element, carrying the tab and the generation it was minted at. A handle from
another tab, or from before that tab navigated, is refused — never silently
turned into a different element:

```
element ref e10 belongs to another tab; read the tab you are acting on
element ref e9 is stale: the page navigated since it was read. Read it again.
```

**Frames are filtered, not accepted.** Every page session casts, so a frame is
broadcast only when it belongs to the agent's tab, and the page drops any frame
whose `tabId` is not the one it is bound to.

**Real events only.** The preview follows `Target.targetInfoChanged`,
`Page.screencastFrame`, `Page.frameNavigated`,
`Page.screencastVisibilityChanged`, and the session's own
`tab.created`/`tab.closed`/`tab.activated`/`tab.navigated`. Nothing is polled
and no interval was added — the one `setInterval` in the page is the
pre-existing status refresh. A person switching tabs in Chrome is recorded as
`focusedTabId` and **nothing else**; the agent does not move.

**A lost browser is announced.** When the CDP socket closes, the targets belonged
to a connection that no longer exists, so the session is emptied and the page is
told — the preview says Chrome is not connected and that it will come back on its
own. It never quietly switches to another browser. Reconnecting re-seeds the
agent's tab from the visible page, which is the only time a page is ever chosen
by asking what is on top.

**The floating chat inherits it for free.** There is one `.chat` element, one
agent and one browser session; opening the chat inside the Browser workspace
moves that element into the window and nothing else changes. No session is
opened. The Terminal floating chat and the plain Chat page are untouched.

The agent is told which tab it controls and what the other ids are — never the
CDP websocket, a target id, cookies, headers, tokens or keys.

## Voice and agent activity

Two small additions to the composer, both driven by the real engine:

- **🎤 voice input** uses the browser's own `SpeechRecognition`. Words appear
  live, the finished sentence lands in the composer so you can edit it, and
  nothing is ever sent for you. No audio is stored and no audio goes to the
  server. An unsupported browser, a denied microphone and silence each get
  their own sentence, and typing always works.
- **▸ Thinking…** is a single collapsible line above the composer, fed by the
  events the engine already emits: `start`, `tool_call`, `tool_result`,
  `assistant`, `final`. It shows *what the agent is doing* — `Using browser`,
  `Reading the page`, `Running a terminal command` — and never the model's own
  reasoning, the system prompt, tool arguments or credentials. The display can
  be switched off, and reasoning effort (Auto / Low / Medium / High) is only
  offered for OpenAI-compatible endpoints, and only sent when it is not `auto`.

Both live inside the chat element, so the floating windows get them for free —
same code, same agent, same stream.

## The UI

Four destinations, and the sidebar is the only navigation between them.

**Chat is the landing page.** The workspace header is hidden so the
conversation gets the full height. Messages are quiet: a labelled block for you,
plain text for the agent. All of a run's tool activity collapses into one line —
`▸ Used 3 actions` — that you can open if you want the detail. The composer has
three things in it: attach, input, and a single send button that becomes a stop
button while the agent is working. The line above it names the active agent and
model at 11px, so you always know who is answering.

**Settings is one scrolling page of three collapsible sections** — Appearance,
AI providers, Agents. The agent editor is a single form, not a tab strip: name,
provider, model and rounds up top, then collapsible Behaviour, Skills,
Capabilities and Browser permissions. SOUL, Instructions, System prompt and
Memory are four compact rows with an **Edit** button each; the markdown opens in
a dialog and saves straight to the backend. Provider editing follows the same
shape — the five useful fields first, org/project/headers/parameters/timing
folded into **Advanced**.

Every mutation refetches from the server, so the lists, the summary lines and
the chat header all reflect the backend immediately. There is no reload path
anywhere in the UI.

## Floating chat

The Browser and Terminal workspaces each have a **Chat** button that opens the
chat in a floating window over that workspace. The window is a host, not a
second chat: `mountChat()` moves the one existing `.chat` element between the
Chat page (`#chatHome`) and the window body. There is therefore always exactly
one conversation, one agent, one history, one attachment queue and one in-flight
run, whichever surface you are looking at.

| control | behaviour |
| ------- | --------- |
| header drag | move the window anywhere inside its workspace, with alignment guides |
| any edge or corner | resize — all eight handles, and the west and north ones move the origin too |
| `⋯` or right-click the title bar | the size menu: tile to a half or fill, reset, or turn snapping off |
| `–` | minimize to **just the title bar**; the header click brings it back |
| `□` | fill the workspace, or double-click the title bar; becomes `❐` and says *Restore* while maximized |
| `✕` | close; the chat returns to the Chat page and the workspace keeps running |
| arrow keys | move; `shift` + arrow resizes by one pixel, otherwise twelve |
| `alt`+`ctrl` + arrows | tile left / right / top / bottom, `0` fills, `R` resets, `S` toggles snapping |
| `esc` | close the window |
| click anywhere | bring to front, using a managed z-counter — never random values |

Three things that are easy to get wrong, and are therefore pinned by tests:

- **A minimized window is its title bar and nothing else.** The height comes from
  the measured header, and the clamp reads the minimized flag *before* it clamps
  — otherwise the minimum height leaves a strip of dead space under a 36px bar.
- **Dragging never resizes.** Alignment snaps position only, and draws a guide
  when it does, so a window cannot change size under the cursor. Resizing is
  something you do with a handle, the keyboard, or a tile.
- **The layout inside the window follows the window, not the screen.** A 300px
  window on a 1600px monitor still has to lay out like a 300px thing, and a
  media query cannot see that — so the window is its own `container-type` and the
  narrow rules are container queries.

Position, size and the minimized / maximized flags are stored per host under
`localStorage["octop:float-chat"]`. **Only pixel geometry is stored** — no
endpoint, no key, no provider. A saved position is clamped into the workspace on
open and on every viewport change, and a workspace too small for a floating
window gets a near-fullscreen sheet instead. The Chat page is still the landing
page: switching to it docks the chat home and dismisses the window.

## Layer order

Dependencies flow one way only. A provider adapter has no idea the browser
exists; the engine never touches Chrome directly; tools never speak HTTP.

```
        LLMProvider            ai/providers.js   transport + wire format
              ↓
        ContextBuilder         ai/context.js     one system message
              ↓
        AgentEngine            ai/engine.js      the tool-calling loop
              ↓
        Tool runner            ai/tools.js       one tool = one action
              ↓
        Controller             server.js         doAction() / doTabs() / shellExec()
              ↓
        Browser automation     Chrome over CDP
```

`server.js` injects the controller, so the tool layer stays testable and the
engine stays provider-agnostic. `ai/context.js` is the **only** place that
concatenates prompt text; the engine asks it for the system message and never
builds one itself.

## Providers

`protocol` picks the adapter. Adding a new vendor means adding one class to
`ai/providers.js` with the same three methods — no change to the engine, the
tools, or the browser layer.

| `protocol`            | request                     | auth                          |
| --------------------- | --------------------------- | ----------------------------- |
| `openai-compatible`   | `{base}/chat/completions`   | `Authorization: Bearer`       |
| `anthropic-messages`  | `{base}/messages`           | `x-api-key` + `anthropic-version` |
| `ollama`              | `{base}/api/chat`           | none (local)                  |

A provider stores: name, protocol, base URL, API key, model, optional
organization / project id, optional extra headers, and model parameters
(temperature, max tokens, top P, timeout).

## Agent profiles

A profile is the agent's whole configuration. It picks a provider, optionally
overrides the model, and carries its own identity, memory, skills and policy.

| field | stored in | effect at runtime |
| ----- | --------- | ----------------- |
| provider + model | `agent-config.json` | which LLM is called |
| **SOUL.md** | `data/agents/<id>/SOUL.md` | `## Who this agent is` — identity and behaviour |
| **Agent Instructions** | `agent-config.json` | `## Operating instructions` |
| **System Prompt** | `agent-config.json` | `## Additional system prompt` |
| **MEMORY.md** | `data/agents/<id>/MEMORY.md` | `## Project memory` — facts, not behaviour |
| **Skills** | `agent-config.json` | `## Skills` + grants the tools it needs |
| **Tools** | `agent-config.json` | `## Tools available to you`; a disabled capability is never even offered to the model |
| **Browser permissions** | `agent-config.json` | enforced before Chrome is touched |

SOUL and MEMORY are deliberately separate documents: SOUL is *who the agent
is*, MEMORY is *what it must remember*. Editing one never touches the other.

### Capabilities and skills

| capability  | tools                                                        |
| ----------- | ------------------------------------------------------------ |
| `browser`   | navigate, click, type, press, scroll, drag, history, reload, wait, tabs |
| `dom`       | read (url, title, text, headings, links, buttons, fields)      |
| `screenshot`| capture the viewport                                          |
| `javascript`| evaluate JS in the page                                       |
| `terminal`  | run one shell command                                         |

Built-in skills — `browser-research`, `web-extraction`,
`screenshot-analysis`, `coding`, `terminal` — each declare the capabilities
they need. Selecting one **grants** those capabilities, so a skill is never a
decorative checkbox; the grant is persisted into `tools` on save.

### Browser permissions

`allowedDomains` (empty = anywhere), `blockedDomains` (a block always wins) and
`allowSubdomains`. These are checked in the agent runtime, so they constrain the
agent and not the person clicking around the dashboard. A refused navigation
comes back to the model as a tool error so it can explain itself.

### Import / export

`GET /api/agents/export?profileId=` produces a portable bundle with the
profile, SOUL.md, MEMORY.md, instructions, system prompt, skill references,
tool permissions and the browser policy. It deliberately carries **no** API
key, no custom headers and no key prefix — the provider is referenced by id +
name + baseUrl. Import maps the provider by id, then baseUrl, then name, and
fails loudly when none of those match.

## Context

Every prompt byte comes from one place. The order is fixed:

```
## Core agent instructions        always on — what this agent is for
## Who this agent is (SOUL.md)    identity, from data/agents/<id>/SOUL.md
## Operating instructions          the profile's Agent Instructions
## Additional system prompt       the profile's System Prompt
## Skills                         one block per selected skill
## Tools available to you         the exact tool names the model is offered
## Project memory (MEMORY.md)     facts, from data/agents/<id>/MEMORY.md
## Runtime browser context        current url, title, open tabs, timestamp
```

HTML comments are stripped (they are scaffolding for whoever edits the file),
empty sections are omitted entirely, and each document is clipped so one huge
memory file cannot eat the context window. `GET /api/agents/<id>/context`
returns the assembled message and a per-section summary so you can see exactly
what is going to be sent.

The three provider protocols all receive the same single `system` message;
the Anthropic adapter lifts it into the request's `system` field.

## Attachments

The composer can send files to the agent. `ai/attachments.js` accepts an upload
only after checking it, and the checks are deliberately strict:

1. the supplied name is sanitised — separators, control characters, characters
   Windows rejects and any `..` become `_`, so it can never be a path
2. the bytes land in `data/inbox/<att-id>/` and the resolved path is verified to
   still be inside that directory
3. 8 MB per file; the request body gets 16 MB of headroom so an oversized file
   is answered with a real 413 instead of a reset socket
4. the magic bytes are checked — a `.png` that is not a PNG is refused

| kind | what happens |
| ---- | ------------ |
| text, markdown, csv, json, xml, logs, source code | the file's own characters are inlined into the user message |
| pdf | text is pulled out of the content streams (zlib inflate); a scan with no text layer is refused, not faked |
| docx | read as a zip, `word/document.xml` inflated, tags stripped |
| png / jpg / webp / gif | handed to the model as a real image part (`image_url` for OpenAI-compatible, a base64 `source` block for Anthropic) |
| doc, xls, ppt, archives, executables | refused with the reason, in the chat, before anything is stored |

Nothing is silently dropped: if a file could not be read it appears as a red
chip with the server's own reason, and the message will not send until you
remove it. `data/inbox/` is scratch space — uploads are swept an hour after they
arrive and `/data/*` is never served over HTTP.

## Agent files and security

`data/agents/<agent-id>/` holds only `SOUL.md` and `MEMORY.md`. Two rules in
`ai/agentfiles.js` enforce the boundary:

1. an agent id must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` — never a path fragment
2. the resolved path must still be inside the agent data directory

So the agent can read its own identity and memory and nothing else, and the
whole `data/` tree is refused by the static file handler. Document contents are
never written to the server log. Deleting a profile removes its directory.

## HTTP surface

| route | purpose |
| ----- | ------- |
| `GET /api/config/agents` | redacted providers + profiles + `activeProfileId` |
| `PUT /api/config/agents` | replace the whole config |
| `POST /api/config/agents/provider` · `DELETE …?id=` | provider CRUD |
| `POST /api/config/agents/profile` · `DELETE …?id=` | profile CRUD |
| `POST /api/config/agents/activate` | choose the active profile |
| `POST /api/config/agents/migrate` | one-way import of the pre-Settings browser config |
| `POST /api/ai/test` | real Test Connection (latency, model, typed error) |
| `POST /api/ai/models` | list the models an endpoint offers, plus each model's own record and its `compat` verdict |
| `POST /api/ai/check` | one minimal probe for one model → `{verdict, reason, blocked}` |
| `POST /api/agent/run` | the agent loop, streamed as SSE |
| `POST /api/agent/attach` · `DELETE …?id=` | chat file upload / removal |
| `POST /api/agent/cancel` | stop a run that is still going |
| `GET /api/agents/skills` | the skill catalog |
| `GET /api/agents/skills` | the skill catalog |
| `GET\|PUT /api/agents/<id>/documents` | read or write SOUL.md / MEMORY.md |
| `POST /api/agents/<id>/documents/reset` | back to the built-in template |
| `GET /api/agents/<id>/context` | the exact system message the model would receive |
| `GET /api/agents/export?profileId=` | portable bundle, no credentials |
| `POST /api/agents/import` | import a bundle, mapping onto an existing provider |
| `POST /api/ai/chat` | single-shot chat; still accepts the old `{endpoint, model, apiKey}` shape |
| `GET /api/browser/status` · `POST /api/browser/action` · `/api/browser/tabs` | browser control |
| `WS /api/browser/stream` | screencast frames + tab/url events |
| `WS /api/shell` | live `cmd.exe` session per connection |

## Secrets

API keys live only in `data/agent-config.json` (written with a `0600` mode
attempt — note that on Windows `chmod` only toggles the read-only flag, so
enforce access with an NTFS ACL if the machine is shared). `redactProvider()`
is the single exit point for anything the browser sees, so a saved key never
reaches the dashboard, a log line or an error string. `GET /api/config/agents`
returns `hasKey` plus a masked `keyHint` (last four characters) instead.

On first load the dashboard hands any pre-Settings `localStorage["octop:ai"]`
value to `/api/config/agents/migrate` and then deletes it, so upgrading never
forces the user to re-enter anything.

`localStorage["octop:model-verdicts"]` holds compatibility verdicts keyed by
model id — a verdict, the provider's own sentence, whether it blocks, and a
timestamp. It contains no key, no address and no account information, is capped
at 200 entries, and only the model ids you actually looked at ever enter it.

## Upgrading an existing install

`OCTOP_AI_BASE_URL` / `OPENAI_BASE_URL`, `OCTOP_AI_API_KEY` / `OPENAI_API_KEY`
and `OCTOP_AI_MODEL` seed a provider and a default profile on first boot. The
seeding is skipped whenever a config file already exists.

## The browser

**The agent drives a browser that belongs to this project, not one it found on
the machine.** Get it once:

```bash
node scripts/get-browser.js              # latest stable Chrome for Testing
node scripts/get-browser.js 141.0.7390.54   # or pin an exact version
node scripts/get-browser.js --force      # replace what is there
```

It unpacks into `.browser/`, and it is the only browser this project prefers.
A system Chrome is used only when `.browser/` is empty, and the boot banner
plus `GET /api/browser/status` always say which binary is in play:

```
browser   : C:\…\browser-automation\.browser\chrome-win64\chrome.exe  [bundled 141.0.7390.54]
```

Why it is worth 300 MB: a system browser cannot be version-pinned, updates
itself underneath the CDP surface everything here depends on, and a second
instance attaching to it fights the first one over the profile lock. The
bundled build has its own `--user-data-dir`, its own port, and its own
version. **Your own browser is never launched and never killed** —
`killChrome()` only ever signals the pid this process started.

`.browser/` is in `.gitignore`; `git clean -xfd` removes it, and one command
puts it back. The downloader is Node built-ins only — `fetch` for the file and
a hand-rolled zip reader over `zlib` — so there is still no `npm install`.

Resolution order, in full:

1. `CHROME_PATH`, if it points at something real
2. the bundled build in `.browser/`
3. Chrome / Edge / Chromium anywhere on the machine, as a fallback

## Environment

| variable | default |
| -------- | ------- |
| `PORT` | `8787` (falls forward to the next free port) |
| `HOST` | `127.0.0.1` |
| `CDP_PORT` | `9222` |
| `CHROME_PATH` | unset — the bundled build in `.browser/` is used instead |
| `CHROME_PROFILE` | `~/.octop-browser-profile` |
| `QUALITY` / `MAX_W` / `MAX_H` | `78` / `1600` / `1000` |

## Automation engines

The agent drives the browser through one **automation router**. The agent does
not know the router exists: `ai/tools.js` still calls `ctx.browser.action(...)`,
and `agentController(profile).action` in `server.js` now passes that action to
`ai/automation/` before it reaches Chrome. Everything else — the agent engine, the
tools, the CDP session, the preview, the session, the floating chats — is the code
it was before.

```text
ai/tools.js            browser_read, browser_click, … (unchanged)
        │  ctx.browser.action({ action, … })
        ▼
server.js              agentController().action  →  the router
        │
        ▼
ai/automation/         classify → rank → execute, with bounded fallback
        ├── native-cdp        the built-in engine; wraps the existing doAction()
        ├── playwright-mcp    an MCP server, spoken over stdio (ai/automation/mcp.js)
        ├── stagehand         semantic actions, attached to the same Chrome
        └── browser-use       a whole task, given the same Chrome and a model
        │
        ▼  every engine reaches Chrome only through the driver it is handed
server.js              doAction({ tabId }) → BrowserSession → the one CDP session
        │
        ▼
                        agentTabId → the preview
```

### The four rules the router keeps

1. **One context.** Every engine is handed the BrowserContext the agent is
   driving (`browserContext()`, the only reader) and can reach Chrome only through
   the driver. No engine can find, choose, or launch a browser. With no context the
   answer is `No browser is connected to this chat` — never "let me find one".
2. **One choice, made once.** Auto picks by capability and by what the action
   actually is: a selector goes to the precise engine, words in place of a selector
   go to a semantic one, a whole goal in words goes to the autonomous one.
3. **Bounded fallback.** A failure moves down the chain, each engine at most once,
   and only if it is enabled, available, and able. An engine that has failed twice
   more often than it has succeeded is stepped over for 45s.
4. **Honest states.** An engine that is not installed says so. An engine the user
   picked by hand and that cannot run is reported, never quietly replaced.

### What is actually installed

Only `native-cdp` is built in, and it is the fallback floor. The other three are
optional: they are detected at runtime, and until they are really there Settings
shows them as unavailable with the reason. Nothing about them is a hard dependency,
and the project still has no `package.json` and no `node_modules`.

| engine | what it is for | how it attaches to this Chrome |
| --- | --- | --- |
| `native-cdp` | exact actions with selectors | it is the CDP connection the product already has |
| `playwright-mcp` | Playwright's tools, over MCP | `--cdp-endpoint`, pointed at the existing browser |
| `stagehand` | "click the checkout button" | attached to the existing browser, or it reports itself unavailable |
| `browser-use` | a whole task in words | attached to the existing browser; its model comes from the agent's own provider |

The CDP endpoint is handed to an engine in this process only. It is not on `STATE`,
so it cannot reach a status response, and it is not logged — the boot line names the
browser version, not the websocket.

### Settings, and the activity

Settings → Automation holds one choice (`Auto`, or a named engine) and a row per
engine with its real state and an on/off switch; the built-in one cannot be turned
off because it is the fallback. The router reports on the run's own event stream,
so the activity shows which engine it chose, that it fell back, and that something
failed — as real events, with no animation and nothing invented.

### Files

```text
ai/automation/index.js          the registry, the router, the health
ai/automation/state.js          the one preference, persisted like ai/store.js
ai/automation/context.js        the one question all four engines ask
ai/automation/mcp.js            a small MCP client: initialize, tools/list, tools/call
ai/automation/engines/*.js      one adapter each
data/automation.json            written only when a preference changes
```
