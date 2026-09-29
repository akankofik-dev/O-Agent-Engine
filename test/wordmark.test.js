'use strict';
/* ====================================================================== *
 *  test/wordmark.test.js — read the mark, do not trust the label.
 *
 *  Run: node test/wordmark.test.js
 *
 *  The rename reported itself finished twice while the chat panel still spelled
 *  the old name, and both times it was because the check read the wrong thing.
 *
 *  The mark in the chat panel is not text. It is a 5x7 dot-matrix wordmark built
 *  out of about a hundred <rect> elements, and the only place the old name
 *  appeared as a string was its aria-label — which is what a screen reader
 *  announces and nothing a person sees. Renaming the label changed the
 *  announcement and left every pixel exactly where it was. The person looking at
 *  the screen was told one thing and shown another.
 *
 *  So this decodes the bitmap and recognises the letters. A pixel that moves
 *  fails here by name.
 * ====================================================================== */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const H = 7, CW = 5;

/* 5x7, one string per row. Only the letters the two names need — a test that
   carried the whole alphabet would be a test nobody checked for typos. */
const FONT = {
  O: ['.###.', '#####', '#...#', '#...#', '#...#', '#...#', '.###.'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  N: ['#...#', '##..#', '##..#', '#.#.#', '#..##', '#..##', '#...#'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  B: ['####.', '#####', '#...#', '####.', '#####', '#...#', '####.'],
  R: ['####.', '#####', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  W: ['#...#', '#...#', '#...#', '#...#', '#...#', '#.#.#', '.###.'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
};

/* the shapes each letter must not be confused with — a cell that is blank, or a
   near-miss, is a failure, and saying which is the difference between a test
   that reports "something changed" and one that reports "the R became an A" */
const ALMOST = {};
for (const [a, ra] of Object.entries(FONT)) {
  for (const [b, rb] of Object.entries(FONT)) {
    if (a === b) continue;
    const d = ra.reduce((n, r, i) => n + [...r].filter((c, j) => c !== rb[i][j]).length, 0);
    if (d > 0 && d < 3) (ALMOST[a] = ALMOST[a] || []).push(b + '(' + d + ')');
  }
}

let passed = 0; const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failures.push({ name, error: e }); console.log('  FAIL ' + name + '\n         ' + e.message); }
}

/** pull the mark out of the page and read it back as a grid of characters */
function readMark(html) {
  const at = html.indexOf('<div class="chat-mark">');
  if (at < 0) throw new Error('the chat panel has no .chat-mark any more');
  const open = html.indexOf('<svg', at);
  const openEnd = html.indexOf('>', open);
  const tag = html.slice(open, openEnd + 1);
  const body = html.slice(open, html.indexOf('</svg>', open));
  const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(tag);
  if (!vb) throw new Error('the mark has no viewBox, so its grid cannot be known');
  if (Number(vb[2]) !== H) throw new Error('the mark is ' + vb[2] + ' rows tall and the letters are ' + H);

  const filled = new Set();
  const byClass = {};
  for (const m of body.matchAll(/<g class="ob-mark-(\w+)">([\s\S]*?)<\/g>/g)) {
    byClass[m[1]] = [];
    for (const r of m[2].matchAll(/<rect x="(\d+)" y="(\d+)" width="1" height="1"\/>/g)) {
      const k = Number(r[1]) + ',' + Number(r[2]);
      filled.add(k);
      byClass[m[1]].push(k);
    }
  }
  const W = Number(vb[1]);
  const grid = [];
  for (let y = 0; y < H; y++) {
    let s = '';
    for (let x = 0; x < W; x++) s += filled.has(x + ',' + y) ? '#' : '.';
    grid.push(s);
  }
  return { grid, W, H, byClass, tag, label: (/aria-label="([^"]*)"/.exec(tag) || [])[1] || '' };
}

/** split on blank columns and name each cell, or say why it could not be named */
function recognise(mark) {
  const used = new Set();
  for (let y = 0; y < mark.H; y++) for (let x = 0; x < mark.W; x++) if (mark.grid[y][x] === '#') used.add(x);

  const cells = [];
  const sorted = [...used].sort((a, b) => a - b);
  let run = [sorted[0]];
  const runs = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > 1) { runs.push(run); run = []; }
    run.push(sorted[i]);
  }
  runs.push(run);

  for (const cols of runs) {
    const x0 = cols[0];
    const rows = mark.grid.map(r => r.slice(x0, x0 + CW));
    const got = rows.join('');
    let ch = null;
    for (const [letter, rr] of Object.entries(FONT)) if (rr.join('') === got) ch = letter;
    cells.push({ x0, rows, ch, got, wide: cols[cols.length - 1] - x0 + 1 > CW });
  }
  return cells;
}

const html = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');

/* Reading the mark must not be able to take the process down.
 *
 * A stray or empty <svg class="ob-mark"> made readMark() throw while the file was
 * still being required, so the suite exited non-zero with a stack trace and no
 * failing check. That counts as caught, and it is a bad way to be caught: a
 * reader sees a crash instead of the sentence "the mark has no viewBox", which is
 * the thing that would tell them what to fix. So the read is a check like the
 * rest of them.
 */
let mark = null; let cells = [];
try {
  mark = readMark(html);
  cells = recognise(mark);
} catch (e) {
  check('the chat mark can be read at all', () => { throw e; });
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  process.exit(1);
}

/* what it should say, and what would have been a bug rather than a name */
const WANT = 'OAGENT';

console.log('== apa yang ditulis mark ==');
for (const row of mark.grid) console.log('  ' + row);
console.log('');
console.log('  ' + mark.W + ' x ' + mark.H + '   aria-label: ' + JSON.stringify(mark.label));
console.log('  kelas: ' + Object.entries(mark.byClass).map(([k, v]) => k + '=' + v.length).join('  '));
console.log('');

check('the chat mark can be read at all', () => {
  assert.ok(mark.W > 0, 'the mark has no width');
  assert.ok(cells.length > 0, 'the mark has no filled pixels');
});

check('the mark spells the product name, letter by letter', () => {
  const unread = cells.filter(c => !c.ch);
  if (unread.length) {
    const why = unread.map(c =>
      'kolom ' + c.x0 + ' (lebar ' + c.wide + ') bukan huruf mana pun:\n           ' + c.rows.join('\n           ') +
      (ALMOST[Object.keys(FONT).find(f => FONT[f].join('') === c.got)] ? '' : '')).join('\n         ');
    throw new Error(why || 'ada sel yang kosong');
  }
  const got = cells.map(c => c.ch).join('');
  assert.strictEqual(got, WANT, 'the mark reads "' + got + '", not "' + WANT + '"');
});

check('the first letter is the mark and the rest is the word', () => {
  assert.ok(cells.length >= 2, 'the mark has one blob, so there is no word to read');
  assert.strictEqual(cells[0].ch, 'O', 'the leading letter is not O');
  /* the word starts after a gap wider than the letter gaps, so the two are not
     being read as one long string */
  const gaps = [];
  for (let i = 1; i < cells.length; i++) gaps.push(cells[i].x0 - (cells[i - 1].x0 + CW));
  assert.ok(Math.max(...gaps) > Math.min(...gaps),
    'the gap after the mark is the same as between the letters, so "O" is not separate: ' + gaps.join(','));
});

check('the label says what the pixels say — that is the whole bug', () => {
  const said = cells.map(c => c.ch).join('');
  assert.ok(mark.label.length > 0, 'the mark has no aria-label, so nothing announces it');
  /* a loose comparison, because the label may be spaced and the pixels are not */
  const loose = mark.label.replace(/[^A-Za-z]/g, '').toUpperCase();
  assert.strictEqual(loose, said,
    'the label reads "' + mark.label + '" while the pixels read "' + said +
    '" — this is exactly the mismatch that shipped the old name past two renames');
});

check('it is still the three-tone mark, and all three tones have pixels', () => {
  for (const c of ['dim', 'strong', 'count']) {
    assert.ok(mark.byClass[c] && mark.byClass[c].length > 0, 'the ' + c + ' group is empty');
  }
  assert.ok(mark.byClass.dim.length > 0 && mark.byClass.dim.length < 20,
    'the dim tone is ' + mark.byClass.dim.length + ' pixels — it was 16, the leading O');
});

check('the CSS still has a rule for every tone the mark uses', () => {
  for (const c of ['dim', 'strong', 'count']) {
    assert.ok(new RegExp('\\.ob-mark-' + c + '\\s+rect\\s*\\{').test(html),
      'there is no .ob-mark-' + c + ' rect rule, so those pixels render with no fill');
  }
});

check('the mark is scaled by CSS, so a narrower viewBox cannot break the layout', () => {
  assert.ok(/\.ob-mark\s*\{[^}]*height:/.test(html), 'the mark has no height in CSS');
  assert.ok(/\.ob-mark\s*\{[^}]*width:auto/.test(html),
    'the mark has a fixed width in CSS, so changing the viewBox would distort it');
  /* the grid is 8px per unit, and that is what makes the two attributes agree */
  const w = Number(/width="(\d+)"/.exec(mark.tag)[1]);
  const h = Number(/height="(\d+)"/.exec(mark.tag)[1]);
  assert.strictEqual(w / mark.W, h / mark.H, 'the width and height imply different pixel scales');
  assert.strictEqual(w / mark.W, 8, 'the scale changed from 8px per grid unit to ' + (w / mark.W));
});

check('not one pixel of the old name is left in it', () => {
  const said = cells.map(c => c.ch || '?').join('');
  assert.ok(!/browser/i.test(mark.label), 'the label still announces it as a browser');
  assert.ok(!/browser/i.test(said), 'the pixels still spell it: ' + said);
  /* B, R, W and S appear only in the old word. A, G, N and T only in the new
     one. Checking the letters rather than a string means this still bites if
     somebody edits a single pixel into something that reads differently. */
  for (const gone of ['B', 'R', 'W', 'S']) {
    assert.ok(!said.includes(gone), 'the mark still carries a "' + gone + '" from the old name: ' + said);
  }
  for (const fresh of ['A', 'G', 'N', 'T']) {
    assert.ok(said.includes(fresh), 'the mark is missing the "' + fresh + '" of the new name: ' + said);
  }
});

check('no other dot-matrix wordmark is hiding in the page', () => {
  const marks = html.match(/class="ob-mark"/g) || [];
  assert.strictEqual(marks.length, 1,
    'there are ' + marks.length + ' marks on the page; only one of them can be the name');
  assert.strictEqual((html.match(/class="chat-mark"/g) || []).length, 1,
    'there is more than one chat panel mark');
});

console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  for (const f of failures) console.log('  - ' + f.name + ': ' + f.error.message);
  process.exit(1);
}
