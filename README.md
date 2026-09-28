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