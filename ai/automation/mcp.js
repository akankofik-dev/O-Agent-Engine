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
        child_ = spawn(command, args, {
          cwd: cwd || undefined,
          env: Object.assign({}, process.env, env),
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          /* On Windows `npx` is npx.cmd, and spawn() does not resolve a bare
             name to a .cmd — it reports ENOENT, so the engine looks permanently
             unavailable on a machine where npx is installed and working. That
             is the difference between an optional engine that works and one
             that never does, and it is invisible on every platform but this
             one. The argument array is handed to the shell as a quoted
             sequence, so nothing here is word-split or re-interpreted on the
             way in. */
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
