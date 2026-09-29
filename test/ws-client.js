'use strict';
/* A minimal WebSocket client, shared by the security tests.
 * The runner only picks up *.test.js, so this file is never run as a suite. */

const http = require('http');
const crypto = require('crypto');

/**
 * Open a socket and hand it to `onOpen(socket, send)` once the handshake is
 * done. Rejects if the server refuses the upgrade.
 */
function open({ host = '127.0.0.1', port, path, origin, token, headers = {} }, onOpen) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const h = {
      Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
    };
    if (origin !== undefined) h.Origin = origin;
    if (token !== undefined) h['X-Octop-Token'] = token;
    Object.assign(h, headers);

    const req = http.request({ host, port, path, headers: h, timeout: 8000 });
    req.on('upgrade', (res, socket) => {
      let buf = Buffer.alloc(0);
      const frames = [];
      socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) return;
          const op = buf[0] & 0x0f;
          let len = buf[1] & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const payload = buf.slice(off, off + len).toString();
          buf = buf.slice(off + len);
          if (op === 1) frames.push(payload);
        }
      });
      socket.on('error', () => { /* the server may hang up first; frames still count */ });
      if (onOpen) onOpen(socket, frames);
      resolve({ socket, frames });
    });
    req.on('response', res => { res.resume(); reject(new Error('refused with HTTP ' + res.statusCode)); });
    req.on('error', e => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('handshake timed out')); });
    req.end();
  });
}

/** a masked client text frame — a browser cannot send an unmasked one */
function sendText(socket, text) {
  const data = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i & 3];
  const head = data.length < 126
    ? Buffer.from([0x81, 0x80 | data.length])
    : Buffer.concat([Buffer.from([0x81, 0xfe]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(data.length); return b; })()]);
  socket.write(Buffer.concat([head, mask, masked]));
}

const wait = ms => new Promise(r => setTimeout(r, ms));

module.exports = { open, sendText, wait };
