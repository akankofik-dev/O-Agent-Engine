# Octop Browser Automation

Simple browser automation console with a live browser preview, AI agents, terminal access, and a pinned Chrome for Testing runtime.

## Ubuntu

Requirements: Ubuntu 22.04/24.04 with `apt-get` and either root or `sudo`. The installer bootstraps Node.js 20 when the installed Node version is missing or too old, installs the Chrome runtime libraries, and downloads the pinned browser build.

```bash
git clone <repository-url> browser-automation
cd browser-automation
bash scripts/install-ubuntu.sh
```

The installer downloads the platform-matched Chrome for Testing build into `.browser/` and creates a user-level systemd service. It does not require root. Open `http://127.0.0.1:8787` after installation.

Useful checks:

```bash
curl -fsS http://127.0.0.1:8787/api/health
curl -fsS http://127.0.0.1:8787/api/ready
systemctl --user status octop-browser-automation.service
```

For a one-off run without systemd:

```bash
node scripts/get-browser.js
node server.js
```

## Tests

There is no framework and no dependencies: each suite is a plain Node script
that prints its own result and exits non-zero on failure. Run all of them with:

```bash
npm test
```

Or a single suite by name:

```bash
node test/engine-retry.test.js
```

They run one at a time, because two of them bind a port. The runner prints a
total and says so if a suite printed no count of its own, rather than reporting
a number that quietly does not mean anything.

## When a provider says no

The agent treats three provider failures differently, because they need
different things from the user — and two of them are worth surviving on their own:

- **Busy (429 transient, 5xx, dropped connection, timeout)** — retried with a
  backoff, up to three times per round. A blip should cost one round, not the
  tool work already gathered. Tunable with `AI_RETRY_DELAYS_MS=1000,3000,8000`.
- **Request too large** — the oldest turns are dropped and the same round is
  asked again, down to a floor. Tool calls are never separated from their
  results, because a provider handed one without the other rejects the whole
  request. The page is told when this happens. The starting budget is
  `AI_CONTEXT_CHARS` (default 120000, roughly 30k tokens) and it lowers itself
  for the rest of the run if a provider ever says the request was still too big.
- **Refused (401/403, spent quota, malformed request)** — not retried. Re-sending
  a rejected request only spends the user's time; for a bad key it re-sends the
  bad key.

A run that reaches its round limit is reported as **truncated**, not as done —
hitting the step cap is not finishing the task.

## The agent writing its own rules

The agent has two tools for changing the guidance it runs on, both behind the
`rules` capability switch, which is off by default:

- `rule_edit` — rewrite the name, description or instruction of a rule that
  already exists. It cannot change what a rule grants.
- `rule_create` — propose a rule that does not exist yet, including the
  capabilities it asks for.

Neither changes anything on its own. Both write to the proposals queue, and a
rule is in force only after a person accepts it, from the next message onwards.
Reverting restores a snapshot, so an accepted rule — created or edited — is
undone the same way.

A new rule carrying its own capabilities used to be refused, on the reasoning that
it could ask for exactly what the user had just switched off. Checking that
against the code turned the refusal into permission: `skills.resolve()` reads the
profile's switches first and drops any skill that asks for more than it is given,
before it contributes anything. A rule nobody enabled cannot widen a tool
toggle, because the toggle is read first and the rule never gets past it.

What that costs is silence, and silence is worse than a refusal. A rule that
cannot run, and a rule that is not switched on in any profile, both used to be
invisible — the agent would have done the work and the work would do nothing, and
nothing on the page would say so. So:

- the proposals panel shows a new rule in full, including the capabilities it
  asks for, and warns in red when one of them is switched off;
- `skills.resolve()` reports a blocked rule by name and by missing capability —
  a block has no other way to become visible, and it is the case where an
  accepted rule silently does nothing;
- the skill cards in Settings mark a rule the agent wrote and name the
  capability that is switched off;
- `/api/rules` reports `capsOff` for the active profile, computed on the server so
  that "what is on" has exactly one answer in the system. Which rules a profile
  has selected is the settings form's own business and is not duplicated here —
  a server-side copy would be stale the moment somebody toggles a switch.

`test/rule-create.test.js` covers the gate itself: a rule requiring `terminal`,
resolved against a profile with `terminal` off, is blocked and grants nothing.
That is the assertion the permission rests on, and it fails loudly if the
reasoning above ever stops being true about this codebase.
