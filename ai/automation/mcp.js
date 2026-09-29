'use strict';
/* ========================================================================= *
 *  A very small MCP client — JSON-RPC 2.0 over a child's stdio.
 *
 *  Playwright MCP is an MCP server, not a library, so integrating it honestly
 *  means speaking its protocol: initialize, tools/list, tools/call. This is
 *  that, and nothing more. No dependencies, no invented endpoints.
 *
 *  Two rules:
 *    - the child's stderr is captured for diagnostics and never forwarded into
 *      an event, a log line, or a response;
 *    - a child that will not start is reported as unavailable, never as a
 *      success with no tools.
 * ========================================================================= */

const { spawn } = require('child_process');

const PROTOCOL = '2024-11-05';
const CALL_TIMEOUT_MS = 120000;

/**
 * @param {object} o
 * @param {string} o.command     the executable
 * @param {string[]} o.args      its arguments
 * @param {object} [o.env]       extra environment for the child only
 * @param {string} [o.cwd]
 */
/**
 * Quote one argument for a Windows command line.
 *
 * Needed because of what `shell: true` does to the argument array, which is not
 * what the old comment here claimed. With a shell, Node joins [command, ...args]
 * with spaces into a single string and hands it to cmd.exe. Nothing in that
 * array is quoted on the way. Measured on this machine, node v24:
 *
 *     args  : ['a b', 'c&d', 'e|f']
 *     arrives as : ['a', 'b', 'c']
 *
 * A space becomes two arguments and the rest is discarded, and & | > < ; would
 * each be read as a command separator. So the old note — "nothing here is
 * word-split or re-interpreted on the way in" — described the opposite of what
 * happens, and Node says as much in DEP0190 on every start.
 *
 * What this does fix: spaces, & | < > ; and embedded quotes all survive.
 *
 * What it does not, and what no amount of quoting here can fix, because it
 * happens in cmd.exe before the child program ever runs:
 *   - `^` is cmd's own escape character and is consumed. `m^n` still arrives
 *     as `mn`.
 *   - `%NAME%` is still expanded by cmd.
 * Both are stated rather than hidden. An argument the caller needs to survive
 * those two cannot be passed to a .cmd on Windows at all, and pretending
 * otherwise would be the same mistake the old comment made.
 */
function quoteForShell(arg) {
  return '"' + String(arg).replace(/"/g, '\\"') + '"';
}

function createClient({ command, args = [], env = {}, cwd }) {
  let child = null;
  let nextId = 1;
  let buffer = '';
  const waiting = new Map();
  let ready = null;
  let readyError = null;
  let stderr = '';
  let closed = false;

  function failAll(err) {
    for (const [, entry] of waiting) entry.reject(err);
    waiting.clear();
  }

  function start() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      let child_;
      try {
        child_ = spawn(command, args.map(quoteForShell), {
          cwd: cwd || undefined,
          env: Object.assign({}, process.env, env),
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          /* The shell is not optional on Windows and cannot be worked around:
             npx ships only as npx.cmd, and spawn() refuses to run a .cmd
             without one — measured here, node v24, `shell: false` gives EINVAL
             and `shell: true` gives exit 0. Without the shell this engine
             looks permanently unavailable on a machine where npx works, which
             is invisible on every other platform.
             The price of the shell is that the argument array is concatenated
             rather than passed, so it is quoted first — see quoteForShell()
             above for what that does and does not fix. */
          shell: process.platform === 'win32',
        });
      } catch (e) {
        readyError = e;
        return reject(new Error('could not start ' + command + ': ' + e.message));
      }
      child = child_;

      child.on('error', e => {
        readyError = e;
        // ENOENT is the honest answer to "is it installed?"
        failAll(new Error(command + ' is not installed or not runnable: ' + e.message));
        reject(new Error(command + ' is not installed or not runnable: ' + e.message));
      });

      child.stderr.on('data', d => {
        // kept for the probe's error message, capped, never streamed anywhere
        if (stderr.length < 4000) stderr += String(d);
      });

      child.stdout.on('data', d => {
        buffer += String(d);
        for (;;) {
          const nl = buffer.indexOf('\n');
          if (nl === -1) break;
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }   // servers often log plain text
          if (msg && msg.id && waiting.has(msg.id)) {
            const entry = waiting.get(msg.id);
            waiting.delete(msg.id);
            if (msg.error) entry.reject(new Error(String((msg.error && msg.error.message) || 'mcp error')));
            else entry.resolve(msg.result);
          }
        }
      });

      child.on('exit', (code, signal) => {
        closed = true;
        const err = new Error(command + ' stopped (code ' + code + ', signal ' + (signal || 'none') + ')');
        if (!readyError) { readyError = err; reject(err); }
        failAll(err);
      });

      // initialize, then say we are ready, then see what it can do. rawCall
      // throughout: this is all happening inside start().
      rawCall('initialize', {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: 'octop-automation', version: '1' },
      }).then(init => {
        notify('notifications/initialized', {});
        return rawCall('tools/list', {}).then(() => resolve(init));
      }).catch(e => {
        readyError = e;
        reject(e);
      });
    });
    return ready;
  }

  function write(obj) {
    if (!child || closed) throw new Error('the mcp server is not running');
    child.stdin.write(JSON.stringify(obj) + '\n');
  }

  function notify(method, params) {
    try { write({ jsonrpc: '2.0', method, params }); } catch { /* it is going away anyway */ }
  }

  /**
   * One request, without waiting for start(). start() itself uses this, so
   * calling the public call() from inside start() would await the very promise
   * start() is in the middle of resolving.
   */
  function rawCall(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(method + ' timed out after ' + CALL_TIMEOUT_MS + 'ms'));
      }, CALL_TIMEOUT_MS);
      waiting.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
      try { write({ jsonrpc: '2.0', id, method, params: params || {} }); }
      catch (e) { clearTimeout(timer); waiting.delete(id); reject(e); }
    });
  }

  function call(method, params) {
    return start().then(() => rawCall(method, params));
  }

  return {
    start,
    call,
    notify,
    async tools() {
      const r = await call('tools/list', {});
      return Array.isArray(r && r.tools) ? r.tools : [];
    },
    async callTool(name, args) {
      const r = await call('tools/call', { name, arguments: args || {} });
      // MCP reports failures in the payload as well as in the envelope
      const text = (r && Array.isArray(r.content) ? r.content : [])
        .map(c => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
      if (r && r.isError) throw new Error(text || (name + ' failed'));
      return { text, raw: r };
    },
    lastStderr() { return stderr.slice(-600); },
    isClosed() { return closed; },
    async stop() {
      if (!child || closed) return;
      closed = true;
      try { child.stdin.end(); } catch { /* ignore */ }
      try { child.kill(); } catch { /* ignore */ }
    },
  };
}

module.exports = { createClient, PROTOCOL };
