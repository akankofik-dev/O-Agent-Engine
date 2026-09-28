'use strict';
/* ====================================================================== *
 *  scripts/get-browser.js — put a browser of our own inside this project.
 *
 *  Why this exists
 *  ---------------
 *  The agent must drive a browser that belongs to this project, not whatever
 *  happens to be installed on the machine. A system Chrome cannot be pinned,
 *  cannot be trusted to keep the same CDP surface across its own updates, and
 *  a second instance attaching to it fights the first one over the profile
 *  lock. None of that is acceptable for something the agent is supposed to be
 *  in control of.
 *
 *  So we fetch Chrome for Testing: an official, version-pinned, *portable*
 *  build that needs no installer, no root and no system state. It lives in
 *  .browser/ next to server.js and is the only browser this project prefers.
 *
 *  Zero dependencies, like everything else here: the download is fetch(), and
 *  the zip is read with zlib and a walk of the central directory. No npm.
 *
 *      node scripts/get-browser.js            # latest stable
 *      node scripts/get-browser.js 141.0.7390.54
 *      node scripts/get-browser.js --force
 * ====================================================================== */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const BROWSER_DIR = path.join(ROOT, '.browser');
const MANIFEST = path.join(BROWSER_DIR, 'browser.json');

const CFT_API = 'https://googlechromelabs.github.io/chrome-for-testing';
const CFT_BASE = 'https://storage.googleapis.com/chrome-for-testing-public';

/* Chrome for Testing publishes a platform key per build. The zip always unpacks
   into a directory of the same name, which is how the binary is found after
   extraction without guessing at paths. */
const PLATFORMS = {
  'win32': { key: 'win64', dir: 'chrome-win64', bin: 'chrome.exe' },
  'darwin': { key: null, dir: null, bin: null },   // resolved by arch below
  'linux': { key: null, dir: null, bin: null },
};
function platformFor(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return arch === 'arm64' ? { key: 'win64', dir: 'chrome-win64', bin: 'chrome.exe' } : PLATFORMS.win32;
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? { key: 'mac-arm64', dir: 'chrome-mac-arm64', bin: 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' }
      : { key: 'mac-x64', dir: 'chrome-mac-x64', bin: 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' };
  }
  if (platform === 'linux') {
    return arch === 'arm64'
      ? { key: 'linux-arm64', dir: 'chrome-linux-arm64', bin: 'chrome' }
      : { key: 'linux64', dir: 'chrome-linux64', bin: 'chrome' };
  }
  throw new Error('this project has no bundled browser for ' + platform + '/' + arch);
}

const log = (...a) => console.log(...a);
const fail = (m) => { console.error('error:', m); process.exit(1); };

/* ---------------------------------------------------------------------- *
 *  A minimal zip reader.
 *
 *  Enough of the format to unpack a Chrome for Testing build: walk the central
 *  directory, then read each entry from its local header. The executable bit
 *  is carried across, because on Linux the browser simply will not start
 *  without it and the failure is a bare "permission denied".
 * ---------------------------------------------------------------------- */

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function findEocd(buf) {
  // the comment length is the last two bytes, so the record cannot be further
  // back than that plus its own size
  const maxBack = Math.min(buf.length, 0xffff + 22);
  for (let i = buf.length - 22; i >= buf.length - maxBack; i--) {
    if (i < 0) break;
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('not a zip file (no end-of-central-directory record)');
}

function readEntries(buf) {
  const eocd = findEocd(buf);
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const madeBy = buf.readUInt16LE(p + 4);
    const extAttrs = buf.readUInt32LE(p + 38);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.push({ name, method, compSize, localOff, extAttrs, madeBy });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

function readEntryData(buf, entry) {
  const o = entry.localOff;
  if (buf.readUInt32LE(o) !== LOC_SIG) throw new Error('bad local header for ' + entry.name);
  const nameLen = buf.readUInt16LE(o + 26);
  const extraLen = buf.readUInt16LE(o + 28);
  const start = o + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error('unsupported compression method ' + entry.method + ' for ' + entry.name);
}

/** unix permissions live in the high 16 bits of the external attributes, and
 *  only when the archive was made on a unix host */
function unixMode(entry) {
  if ((entry.madeBy >> 8) !== 3) return null;
  return (entry.extAttrs >>> 16) & 0xffff;
}

function extractZip(buf, destDir, onProgress) {
  const entries = readEntries(buf);
  let files = 0, dirs = 0, bytes = 0;
  /** the mode we asked for on each file. Windows cannot store unix permission
   *  bits — chmod only toggles the read-only flag there — so this is what the
   *  caller (and the tests) check rather than the filesystem, which would
   *  report 0666 on Windows and the real value on Linux. */
  const modes = Object.create(null);
  for (const e of entries) {
    // zip-slip: a build archive from a well-known source is still untrusted
    // input, and a path that climbs out of the destination is never legitimate
    const rel = e.name.replace(/\\/g, '/');
    if (rel.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(rel)) {
      throw new Error('refusing an archive entry that escapes the destination: ' + e.name);
    }
    const target = path.resolve(destDir, rel);
    if (target !== path.resolve(destDir) && !target.startsWith(path.resolve(destDir) + path.sep)) {
      throw new Error('refusing an archive entry that escapes the destination: ' + e.name);
    }
    if (rel.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); dirs++; continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const data = readEntryData(buf, e);
    fs.writeFileSync(target, data);
    const mode = unixMode(e);
    if (mode) {
      const perm = mode & 0o777;
      modes[rel] = perm;
      try { fs.chmodSync(target, perm); } catch { /* best effort */ }
    }
    files++; bytes += data.length;
    if (onProgress && files % 200 === 0) onProgress(files, entries.length);
  }
  return { files, dirs, bytes, modes };
}

/* ---------------------------------------------------------------------- *
 *  version resolution + download
 * ---------------------------------------------------------------------- */

async function latestStable() {
  const res = await fetch(`${CFT_API}/last-known-good-versions-with-downloads.json`, {
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error('could not read the Chrome for Testing version list: HTTP ' + res.status);
  const json = await res.json();
  const stable = json && json.channels && json.channels.Stable;
  if (!stable || !stable.version) throw new Error('the version list has no Stable channel');
  return String(stable.version);
}

function findDownloadUrl(listJson, version, platformKey) {
  const stable = listJson && listJson.channels && listJson.channels.Stable;
  const set = stable && stable.downloads && stable.downloads.chrome;
  if (!Array.isArray(set)) return null;
  const hit = set.find(d => d.platform === platformKey);
  return hit ? hit.url : null;
}

async function download(url, destFile, onProgress) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!res.ok || !res.body) throw new Error('download failed: HTTP ' + res.status + ' ' + url);
  const total = Number(res.headers.get('content-length') || 0);
  const tmp = destFile + '.part';
  const out = fs.createWriteStream(tmp);
  let got = 0, lastAt = 0;
  for await (const chunk of res.body) {
    got += chunk.length;
    if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
    if (onProgress && Date.now() - lastAt > 700) { onProgress(got, total); lastAt = Date.now(); }
  }
  await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
  fs.renameSync(tmp, destFile);
  return got;
}

function mb(n) { return (n / 1048576).toFixed(1) + ' MB'; }

/* ---------------------------------------------------------------------- */

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const pinned = args.find(a => !a.startsWith('--')) || null;
  const plat = platformFor();
  const targetBin = path.join(BROWSER_DIR, plat.dir, plat.bin);

  if (!force && fs.existsSync(targetBin) && fs.existsSync(MANIFEST)) {
    const m = readManifest();
    log('a browser is already in .browser/ — ' + (m ? m.version : 'unknown version'));
    log('  ' + targetBin);
    log('re-run with --force to replace it');
    return;
  }

  log('platform : ' + process.platform + '/' + process.arch + '  (' + plat.key + ')');
  log('destination: ' + BROWSER_DIR);

  let version = pinned;
  let url;
  if (pinned) {
    // the storage layout is stable, so a pinned version needs no metadata call
    url = `${CFT_BASE}/${pinned}/${plat.key}/chrome-${plat.key}.zip`;
    log('version  : ' + pinned + ' (pinned)');
  } else {
    version = await latestStable();
    log('version  : ' + version + ' (latest stable)');
  }

  fs.mkdirSync(BROWSER_DIR, { recursive: true });
  const zipPath = path.join(BROWSER_DIR, 'chrome-' + plat.key + '.zip');

  log('\nfetching the version list…');
  const listJson = pinned ? null : await (await fetch(`${CFT_API}/last-known-good-versions-with-downloads.json`)).json();
  const listed = listJson ? findDownloadUrl(listJson, version, plat.key) : null;
  if (listed) url = listed;

  log('downloading…');
  log('  ' + url);
  const size = await download(url, zipPath, (got, total) => {
    process.stdout.write('\r  ' + mb(got) + (total ? ' / ' + mb(total) : '') + '   ');
  });
  process.stdout.write('\r  ' + mb(size) + ' downloaded                    \n');

  log('unpacking…');
  const t0 = Date.now();
  const buf = fs.readFileSync(zipPath);
  const res = extractZip(buf, BROWSER_DIR, (n, total) => process.stdout.write('\r  ' + n + ' / ' + total + ' entries   '));
  process.stdout.write('\r  ' + res.files + ' files, ' + mb(res.bytes) + '                 \n');

  if (!fs.existsSync(targetBin)) {
    // a partial or repackaged archive lands here; the message has to say what
    // to actually look for rather than just that something is wrong
    const found = fs.readdirSync(BROWSER_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
    fail('the archive unpacked but ' + targetBin + ' is not there.\n'
      + '  expected the directory ' + plat.dir + '\n'
      + '  what is in .browser/: ' + (found.join(', ') || '(nothing)'));
  }
  try { fs.chmodSync(targetBin, 0o755); } catch { /* already correct */ }

  // the zip is 300 MB and re-downloadable in one command; keeping it only makes
  // .browser/ twice the size it needs to be
  fs.rmSync(zipPath, { force: true });

  const installed = {
    format: 'octop-browser-automation',
    version: 1,
    source: 'chrome-for-testing',
    version_number: version,
    platform: plat.key,
    dir: plat.dir,
    binary: plat.bin,
    path: path.relative(ROOT, targetBin).replace(/\\/g, '/'),
    installed_at: new Date().toISOString(),
  };
  fs.writeFileSync(MANIFEST, JSON.stringify(installed, null, 2) + '\n');

  log('\ninstalled in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  log('  ' + installed.path);
  log('  ' + version + '  (' + plat.key + ')');
  log('\nstart the server — it will use this browser and nothing else.');
}

function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return null; }
}

/* the same lookup the server does, exported so both agree on one answer */
function bundledBinary() {
  const plat = platformFor();
  const exe = path.join(BROWSER_DIR, plat.dir, plat.bin);
  try {
    if (!fs.existsSync(exe)) return null;
  } catch { return null; }
  const m = readManifest();
  return {
    path: exe,
    source: 'bundled',
    version: (m && m.version_number) || null,
    platform: plat.key,
  };
}

module.exports = { BROWSER_DIR, MANIFEST, bundledBinary, platformFor, extractZip, readManifest };

if (require.main === module) {
  main().catch(e => fail(e && e.message ? e.message : String(e)));
}
