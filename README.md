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
