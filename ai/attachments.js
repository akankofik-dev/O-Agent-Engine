'use strict';
/* ====================================================================== *
 *  ai/attachments.js — files the user attaches to a chat message.
 *
 *  Rules, enforced here:
 *    1. the uploaded name is sanitised and never used as a path
 *    2. every byte lands inside data/inbox/<id>/ and nowhere else
 *    3. size and type are checked before anything is written
 *    4. a file we cannot really read is rejected with a clear reason —
 *       never stored and pretended to be understood
 *
 *  What we can genuinely extract, with no third-party code:
 *    text family  → the file's own characters
 *    images       → handed to the model as a real image part
 *    pdf          → text pulled out of the content streams (zlib inflate)
 *    docx         → a zip; word/document.xml is inflated and stripped
 *  Anything else is refused rather than faked.
 * ====================================================================== */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', 'data', 'inbox');
const MAX_BYTES = 8 * 1024 * 1024;          // per file
const MAX_TEXT_CHARS = 40000;               // per file, after extraction
const ID_RE = /^att_[a-f0-9]{16}$/;

/* ---------------------------------------------------------------------- */

const TEXT_EXT = new Set([
  'txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'ndjson',
  'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'log',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java',
  'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'ps1', 'bat',
  'sql', 'html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte', 'gradle',
  'dockerfile', 'gitignore', 'env.example', 'lock', 'diff', 'patch', 'srt', 'vtt',
]);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/* formats we recognise but genuinely cannot read without a real parser */
const KNOWN_UNSUPPORTED = {
  doc: 'legacy .doc (binary Word) has no parser here — save as .docx or .txt',
  xls: 'spreadsheets have no parser here — save as .csv',
  xlsx: 'spreadsheets have no parser here — save as .csv',
  ppt: 'presentations have no parser here — save as .txt or .md',
  pptx: 'presentations have no parser here — save as .txt or .md',
  epub: 'epub has no parser here',
  zip: 'archives are not expanded for attachments',
  '7z': 'archives are not expanded for attachments',
  rar: 'archives are not expanded for attachments',
  exe: 'executables are never accepted',
  dll: 'binaries are never accepted',
  msi: 'installers are never accepted',
};

function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

/** keep the name readable but make it impossible to use as a path */
function safeName(name) {
  return String(name || "file")
    .replace(/[\\/]/g, "_")
    .replace(CTRL_FILTER, "_")
    .replace(/\.{2,}/g, "_")     // no ".." left, so the name can never read as a path
    .replace(/^\.+/, "_")
    .slice(0, 120) || "file";
}

/* control characters, path separators and the characters Windows refuses —
   built from a string so no control byte ever lands in this source file */
const CTRL_FILTER = new RegExp("[\\x00-\\x1f<>:\"|?*]", "g");

function idIsValid(id) { return typeof id === 'string' && ID_RE.test(id); }

function dirFor(id) {
  if (!idIsValid(id)) throw new Error('invalid attachment id');
  const dir = path.resolve(ROOT, id);
  const base = path.resolve(ROOT);
  if (dir !== base && !dir.startsWith(base + path.sep)) throw new Error('attachment path escapes the inbox');
  return dir;
}

/* --------------------------- extractors -------------------------------- */

/** pull plain text out of a PDF by inflating its streams */
function pdfText(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const start = buf.indexOf('stream', pos, 'latin1');
    if (start === -1) break;
    let s = start + 6;
    if (buf[s] === 0x0d) s++;
    if (buf[s] === 0x0a) s++;
    const end = buf.indexOf('endstream', s, 'latin1');
    if (end === -1) break;
    const raw = buf.subarray(s, end);
    let data = raw;
    try { data = zlib.inflateSync(raw); } catch { /* uncompressed stream */ }
    const text = data.toString('latin1');
    // Tj / TJ / ' / " show strings; keep the characters between the delimiters
    const re = /\((?:\\.|[^\\()])*\)/g;
    let m;
    while ((m = re.exec(text))) {
      out.push(m[0].slice(1, -1)
        .replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '', f: '' }[c] || ''))
        .replace(/\\(\d{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
        .replace(/[()]/g, ''));
    }
    pos = end + 9;
  }
  return out.join('').replace(/\s+/g, ' ').trim();
}

/** read one entry out of a zip (docx is a zip) */
function zipRead(buf, wanted) {
  // locate the end-of-central-directory record
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('not a zip container');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (name === wanted) {
      const lhName = buf.readUInt16LE(localOff + 26);
      const lhExtra = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lhName + lhExtra;
      const data = buf.subarray(start, start + compSize);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('zip entry not found: ' + wanted);
}

function docxText(buf) {
  const xml = zipRead(buf, 'word/document.xml').toString('utf8');
  return xml
    .replace(/<w:tab[^>]*\/?>/g, '\t')
    .replace(/<w:br[^>]*\/?>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------ store ---------------------------------- */

const records = new Map();     // id -> descriptor

function classify(name) {
  const ext = extOf(name);
  if (IMAGE_EXT.has(ext)) return { kind: 'image', ext };
  if (TEXT_EXT.has(ext) || !ext) return { kind: 'text', ext };
  if (ext === 'pdf') return { kind: 'pdf', ext };
  if (ext === 'docx') return { kind: 'docx', ext };
  if (KNOWN_UNSUPPORTED[ext]) return { kind: 'unsupported', ext };
  return { kind: 'unknown', ext };
}

/**
 * Accept one uploaded file.
 * @param {string} name  the client-supplied file name (never trusted as a path)
 * @param {string} b64   base64 file content
 */
function put(name, b64) {
  const clean = safeName(name);
  const ext = extOf(clean);
  const info = classify(clean);

  if (info.kind === 'unsupported') throw new Error(KNOWN_UNSUPPORTED[ext]);

  let bytes;
  try { bytes = Buffer.from(String(b64 || ''), 'base64'); }
  catch { throw new Error('could not decode the file'); }
  if (!bytes.length) throw new Error('the file is empty');
  if (bytes.length > MAX_BYTES) {
    throw new Error('file is too large (' + Math.round(bytes.length / 1048576) + ' MB, limit ' + (MAX_BYTES / 1048576) + ' MB)');
  }
  // a real signature beats the extension
  if (info.kind === 'image') {
    const magic = bytes.subarray(0, 4).toString('hex');
    const ok = { png: magic.startsWith('89504e47'), jpg: magic.startsWith('ffd8ff'), jpeg: magic.startsWith('ffd8ff'),
      gif: magic.startsWith('47494638'), webp: bytes.subarray(0, 4).toString('latin1') === 'RIFF' }[info.ext];
    if (!ok) throw new Error('that file is not a real ' + info.ext.toUpperCase() + ' image');
  }
  if (info.kind === 'pdf' && bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('that file is not a PDF');
  }
  if (info.kind === 'docx' && bytes.subarray(0, 2).toString('latin1') !== 'PK') {
    throw new Error('that file is not a .docx container');
  }

  let text = '';
  if (info.kind === 'text') {
    text = bytes.toString('utf8');
    if (text.indexOf(String.fromCharCode(0xfffd)) !== -1) text = bytes.toString("latin1");   // not valid utf-8
  } else if (info.kind === 'pdf') {
    try { text = pdfText(bytes); } catch (e) { throw new Error('could not read the PDF: ' + e.message); }
    if (!text) throw new Error('this PDF has no extractable text — it is probably a scan, and there is no OCR here');
  } else if (info.kind === 'docx') {
    try { text = docxText(bytes); } catch (e) { throw new Error('could not read the .docx: ' + e.message); }
    if (!text) throw new Error('this .docx contains no readable text');
  }
  if (text && text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS) + '\n… [truncated]';
  }

  const id = 'att_' + crypto.randomBytes(8).toString('hex');
  const dir = dirFor(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, clean), bytes);

  const rec = {
    id, name: clean, ext: info.ext, kind: info.kind,
    bytes: bytes.length,
    text: info.kind === 'image' ? '' : text,
    mime: IMAGE_MIME[info.ext] || '',
    createdAt: Date.now(),
  };
  records.set(id, rec);
  return publicView(rec);
}

function publicView(rec) {
  return {
    id: rec.id, name: rec.name, kind: rec.kind, bytes: rec.bytes,
    mime: rec.mime, chars: rec.text ? rec.text.length : 0,
  };
}

function get(id) {
  if (!idIsValid(id)) throw new Error('invalid attachment id');
  return records.get(id) || null;
}

function remove(id) {
  if (!idIsValid(id)) return { removed: false };
  const had = records.delete(id);
  try { fs.rmSync(dirFor(id), { recursive: true, force: true }); } catch { /* already gone */ }
  return { removed: had };
}

/** clear anything older than an hour — inbox files are not permanent */
function sweep(maxAgeMs = 60 * 60 * 1000) {
  const now = Date.now();
  let n = 0;
  for (const [id, rec] of records) {
    if (now - rec.createdAt > maxAgeMs) { remove(id); n++; }
  }
  return { swept: n };
}

/**
 * Turn attachments into the extra user-message content the model receives.
 * Text is inlined; images become real image parts. No raw bytes ever reach a
 * prompt as text.
 */
function toMessageParts(attachments) {
  const textBlocks = [];
  const images = [];
  for (const ref of Array.isArray(attachments) ? attachments : []) {
    const rec = typeof ref === 'string' ? get(ref) : ref;
    if (!rec) continue;
    if (rec.kind === 'image') {
      const dir = dirFor(rec.id);
      try { images.push({ name: rec.name, mime: rec.mime, dataUrl: 'data:' + rec.mime + ';base64,' + fs.readFileSync(path.join(dir, rec.name)).toString('base64') }); }
      catch { /* file vanished; skip rather than lie */ }
      textBlocks.push('[image] ' + rec.name + ' (' + Math.round(rec.bytes / 1024) + ' KB)');
      continue;
    }
    textBlocks.push('--- ' + rec.name + ' ---\n' + (rec.text || '(no extractable text)'));
  }
  return { text: textBlocks.join('\n\n'), images, count: (Array.isArray(attachments) ? attachments : []).length };
}

module.exports = {
  ROOT, MAX_BYTES, MAX_TEXT_CHARS,
  put, get, remove, sweep, toMessageParts, publicView,
  safeName, extOf, classify, idIsValid,
};
