'use strict';
/* ========================================================================= *
 *  access.js — the one thing this server has always been missing: a way to
 *  tell the page it is serving apart from any other process on the machine.
 *
 *  What was wrong
 *  --------------
 *  `originAllowed()` answered exactly one question — "did a browser send an
 *  Origin, and is it this one?" — and a question with that shape has a hole
 *  in it by construction. curl sends no Origin at all. So does any Node
 *  client, any script, any other tool that happens to know the port. Both the
 *  shell socket and the live-view socket took the "no Origin" branch and said
 *  yes, and a shell with no credentials is a shell with no boundary.
 *
 *  The boundary, and its honest limit
 *  ----------------------------------
 *  A token, checked on every request, is one. It is NOT a defence against code
 *  already running as this user: such a process can fetch the page and read the
 *  cookie out of the header. That is not a defect to be fixed here, it is what
 *  a loopback-only service is, and pretending otherwise would be the more
 *  dangerous claim. What it does stop is the things that are actually
 *  accidental: another tool on the machine, a browser page, a stray script, and
 *  a bind address that later gets widened by mistake.
 *
 *  Why a cookie and not a login
 *  ----------------------------
 *  A WebSocket handshake cannot carry a header the page sets from JavaScript,
 *  so a header-only scheme would have required editing the dashboard. A cookie
 *  is sent by the browser on its own, so the dashboard needs no change at all:
 *  it loads, the server hands it a cookie, and from then on every request and
 *  every socket carries it. HttpOnly keeps it away from script, and
 *  SameSite=Strict keeps it away from other origins.
 *
 *  The file
 *  ---------
 *  `data/access-token`, mode 0600, never served, holding the token for the
 *  process that wrote it. It is regenerated on every start, so a file left over
 *  from a run that is no longer alive is never a live secret. A client that
 *  cannot send a cookie reads it from there.
 * ========================================================================= */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COOKIE_NAME = 'octop';
const FILE_NAME = 'access-token';
/* 32 bytes: nothing here is guessing at a length, and the value is a bearer
   secret rather than a password, so there is no human factor to protect. */
const BYTES = 32;

/* ------------------------------ the token ------------------------------- */

function generate() {
  return crypto.randomBytes(BYTES).toString('base64url');
}

/**
 * The token for this process.
 *
 * Written on every call, which in practice means every start: a token that
 * outlived the process that issued it is a token nobody is using, and keeping
 * it would only leave a stale secret sitting in the file. The caller holds the
 * returned value for the life of the process, so a page that loaded a minute
 * ago and one that loads a minute from now both work.
 */
function issue(file) {
  const token = generate();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  /* Written through a temporary name so a reader never sees half a token. A
     truncated token is not a weaker token, it is a broken one, and the failure
     would look like a wrong password rather than a torn file. */
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, token + '\n', { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort on Windows */ }
  try { fs.renameSync(tmp, file); }
  catch (e) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
  return token;
}

/* read it back, for a client that has no other way to learn it */
function read(file) {
  try { return fs.readFileSync(file, 'utf8').trim() || null; }
  catch { return null; }
}

/* ---------------------------- comparison ------------------------------- */

/**
 * Constant-time equality, so the answer does not leak how much of a guess was
 * right. `timingSafeEqual` throws on a length mismatch, and the length itself
 * is not a secret — the token is fixed-length — so the length is compared first
 * and the timing of that comparison is not worth defending.
 */
function matches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  if (!presented.length) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ---------------------------- presentation ----------------------------- */

function parseCookies(header) {
  const out = new Map();
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Whatever credential the caller offered, from whichever of the three places
 * it can be, or null.
 *
 * All three are read because they serve three different callers: the browser
 * can only send the cookie, `curl` finds a header natural, and a WebSocket
 * built by hand in a test is easiest to drive with the header. They are the
 * same secret, so accepting any of them says nothing extra.
 *
 * The query string is read too, and only here. A WebSocket built by a browser
 * cannot set a header, and while the cookie covers that case, a client that
 * genuinely cannot hold a cookie needs one path that does not need one.
 */
function presented(req, queryToken) {
  const h = (req && req.headers) || {};
  const cookie = parseCookies(h.cookie).get(COOKIE_NAME);
  if (cookie) return cookie;
  const auth = String(h.authorization || '');
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  const custom = h['x-octop-token'];
  if (custom) return String(custom).trim();
  if (queryToken) return String(queryToken).trim();
  return null;
}

/**
 * The cookie a browser should keep. HttpOnly so script cannot read it,
 * SameSite=Strict so no other origin can send it, and no Secure because the
 * service is loopback-only and a Secure cookie over plain http would simply
 * never be stored.
 */
function cookieHeader(token) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`;
}

/** the name static serving has to refuse, without importing the path rules */
const BLOCKED = FILE_NAME;

module.exports = {
  COOKIE_NAME, FILE_NAME, BLOCKED,
  generate, issue, read, matches, presented, cookieHeader, parseCookies,
};
