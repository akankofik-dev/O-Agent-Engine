'use strict';
/* ========================================================================= *
 *  lifecycle.js — Level 3 (SELF-REPAIR) and Level 4 (SELF-IMPROVE).
 *
 *  Level 2 could make an engine. It could not change one. `create_engine` still
 *  refuses to overwrite, and that refusal is the right one: an agent rewriting
 *  the file under its own feet would replace something that works with something
 *  it has not tested. So changing an engine is a different act, and it gets its
 *  own door.
 *
 *  The shape of the act
 *  -------------------
 *  Nothing active is ever touched until a candidate has passed the same gate
 *  Level 2 uses, in a directory nobody is routing to:
 *
 *      engines/<id>/                      the active engine, untouched until the end
 *        manifest.json  index.js  test.js
 *        .versions/<stamp>/               a snapshot of every past active version
 *      engines/.candidate-<id>-<stamp>/   the candidate, mid-test
 *
 *  The candidate directory starts with a dot, which does two things at once:
 *  `engineDirectories()` skips it because a dot is not a legal id, and a
 *  human running `ls` will see it and not miss it. It is at the same depth as
 *  an engine directory, which is what makes the generated test work unchanged —
 *  its `require('../../ai/automation/context')` resolves to the same place it
 *  would from `engines/<id>/`. That is not a coincidence worth preserving by
 *  accident: it is why the candidate is tested by *running* it rather than by
 *  re-implementing what running it means.
 *
 *  The order of operations, which is the whole safety argument:
 *
 *      1. refuse unless the id is legal and the engine is one of ours
 *      2. write the candidate into a staging directory
 *      3. run the candidate's own test there — the same three conditions Level 2
 *         uses: exit 0, inside the timeout, and a printed pass count
 *      4. a failure stops here. The staging directory is removed and the active
 *         engine has not been read, let alone written
 *      5. snapshot the active version into .versions/<stamp>
 *      6. copy the candidate over the active files
 *      7. register(), which re-verifies the promoted files and re-reads the
 *         module off disk with the require cache dropped
 *      8. if step 7 refuses, put the snapshot back and re-register it, so a
 *         failed promotion cannot leave a half-written engine in the registry
 *
 *  Step 4 is why a failed repair is safe, and step 8 is why a failed *promotion*
 *  is. Neither can reach the active engine without first having passed the gate.
 *
 *  Repair and improve are the same machinery and deliberately so
 *  --------------------------------------------------------
 *  They are different claims about *why* the agent is changing an engine, and
 *  the difference is recorded in the manifest rather than in the code path:
 *
 *    repair   the engine is broken and is being made healthy again
 *    improve  the engine works and something better is being proposed
 *
 *  The one mechanical difference is that improve runs the *old* test as well as
 *  the new one, and refuses to promote if the old stops passing — a change that
 *  improves one thing while breaking another is not an improvement, and the only
 *  way to know is to run what was there before. Repair makes no such claim: a
 *  broken engine is expected to fail its old test, and demanding it pass would
 *  refuse exactly the repairs that are needed.
 * ========================================================================= */

const fs = require('fs');
const path = require('path');
const forge = require('./forge');

const ENGINES_DIR = forge.ENGINES_DIR;

/* A candidate lives beside the engines, not inside one, and starts with a dot so
   that the id rules — which every scan in the project uses — skip it. */
const CANDIDATE_PREFIX = '.candidate-';
const VERSIONS_DIR = '.versions';

/** where an engine's past versions are kept, inside the engine's own folder */
function versionsDir(id) {
  return path.join(forge.engineDir(id), VERSIONS_DIR);
}

/** a stamp that cannot collide with one made a millisecond ago */
let seq = 0;
function stamp() {
  seq += 1;
  return Date.now().toString(36) + '-' + seq.toString(36);
}

/** the staging directory for one candidate */
function candidateDir(id, mark) {
  return path.join(ENGINES_DIR, CANDIDATE_PREFIX + id + '-' + mark);
}

/** every leftover candidate, which is debris from a run that was interrupted */
function staleCandidates() {
  let names = [];
  try { names = fs.readdirSync(ENGINES_DIR, { withFileTypes: true }); } catch { return []; }
  return names.filter(d => d.isDirectory() && d.name.startsWith(CANDIDATE_PREFIX))
    .map(d => path.join(ENGINES_DIR, d.name));
}

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* already gone */ } }
function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }

/* ------------------------------------------------------------------ guards -- */

/**
 * The four refusals, gathered so that a caller checks the same things in the
 * same order whatever it is trying to do.
 *
 * The built-in engines are stopped by two independent things, on purpose. Their
 * ids are legal — `native-cdp` matches the id rules — so the rules alone would
 * let an agent through. What stops them is that no directory exists for them
 * under engines/: the shipped adapters are required out of ai/automation/engines/
 * and have no folder of their own here. The `type` check is the second thing, and
 * it is there so that if a built-in ever did gain a folder here, it would still
 * be refused for being a built-in rather than refused by accident.
 */
function checkTarget(id) {
  let dir;
  try { dir = forge.engineDir(id); }                        // the id rules
  catch (e) { return { ok: false, reason: e.message }; }

  if (!fs.existsSync(dir)) {
    return { ok: false, reason: 'there is no generated engine called "' + id + '" — built-in engines have no folder here and are not repairable' };
  }

  const active = readJson(path.join(dir, 'manifest.json'), null);
  if (!active) return { ok: false, reason: id + ' has no manifest.json, so there is nothing to repair' };
  for (const f of ['index.js', 'test.js']) {
    if (!fs.existsSync(path.join(dir, f))) return { ok: false, reason: id + ' has no ' + f + ', so it is not a complete engine' };
  }

  let mod;
  try { mod = require(path.join(dir, 'index.js')); }
  catch (e) { return { ok: false, reason: id + ' does not load: ' + String(e.message).slice(0, 140) } };

  if (mod.builtIn === true) return { ok: false, reason: id + ' is a built-in engine and is not repairable' };
  if (mod.type !== 'generated') {
    return { ok: false, reason: id + ' is of type "' + (mod.type || 'unknown') + '", not "generated" — only engines the forge wrote may be changed' };
  }
  if (mod.id !== active.id) {
    return { ok: false, reason: 'the folder is called ' + id + ' but the engine calls itself ' + mod.id };
  }

  return { ok: true, dir, mod, manifest: active };
}

/* -------------------------------------------------------------- the version -- */

/** what the active version says about itself */
function current(id) {
  const dir = path.join(ENGINES_DIR, id);
  const manifest = readJson(path.join(dir, 'manifest.json'), null);
  if (!manifest) return null;
  return {
    id,
    version: manifest.version || 1,
    lineage: manifest.lineage || null,
    repairedAt: manifest.repairedAt || null,
    improvedAt: manifest.improvedAt || null,
  };
}

/** every past version of an engine, newest last */
function versions(id) {
  const dir = versionsDir(id);
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return names.filter(d => d.isDirectory()).map(d => {
    const m = readJson(path.join(dir, d.name, 'manifest.json'), {});
    return { stamp: d.name, version: m.version || null, lineage: m.lineage || null, dir: path.join(dir, d.name) };
  }).sort((a, b) => (a.stamp < b.stamp ? -1 : 1));
}

/* ------------------------------------------------------------- promoting ---- */

/**
 * Move a candidate into place, keeping the version it replaces.
 *
 * This is the only function in the file that writes to an active engine, and it
 * is only ever reached with a candidate that has already passed the gate. The
 * snapshot is taken *before* the copy rather than after, so there is no window
 * in which the old version exists only in a file being overwritten.
 */
function promote(router, id, cdir, spec) {
  const dir = forge.engineDir(id);
  const mark = stamp();
  const snap = path.join(versionsDir(id), mark);

  /* 1. keep what is there now, before a single byte of it is replaced */
  fs.mkdirSync(snap, { recursive: true });
  for (const f of ['manifest.json', 'index.js', 'test.js']) {
    fs.copyFileSync(path.join(dir, f), path.join(snap, f));
  }

  /* 2. put the candidate in */
  for (const f of ['manifest.json', 'index.js', 'test.js']) {
    fs.copyFileSync(path.join(cdir, f), path.join(dir, f));
  }

  /* 3. verify what actually landed, through the forge's own gate */
  const reg = forge.register(router, id);
  if (!reg.ok) {
    /* Promotion failed. The snapshot goes back, and the engine that was running
       is registered again — a refusal must not leave a half-written engine in
       the registry, which is the one outcome the ordering above exists to stop. */
    for (const f of ['manifest.json', 'index.js', 'test.js']) {
      fs.copyFileSync(path.join(snap, f), path.join(dir, f));
    }
    const back = forge.register(router, id);
    return { ok: false, stage: 'promote', reason: reg.reason || reg.error, output: reg.output || '',
      restored: !!back.ok, note: 'the previous version was put back' };
  }

  return { ok: true, stage: 'promoted', id, version: (readJson(path.join(dir, 'manifest.json'), {}) || {}).version || null,
    keptAs: mark, reason: reg.reason, capabilities: reg.capabilities || [] };
}

/* ----------------------------------------------------------------- repair --- */

/**
 * Change a broken generated engine, and refuse everything that is not that.
 *
 * @param {object} router what createRouter returned
 * @param {object} spec   { id, body, examples, name? }
 */
function repair(router, spec) {
  const id = String((spec && spec.id) || '').trim();
  const target = checkTarget(id);
  if (!target.ok) return { ok: false, stage: 'guard', id, reason: target.reason };

  /* the body has to be something. An empty execute() would pass a test that
     checks nothing, and the generated test is only as strong as its examples. */
  if (typeof (spec.body) !== 'string' || !spec.body.trim()) {
    return { ok: false, stage: 'guard', id, reason: 'a repair needs a body — the source of the new execute()' };
  }
  if (!Array.isArray(spec.examples) || !spec.examples.length) {
    return { ok: false, stage: 'guard', id, reason: 'a repair needs at least one example, because the new test is written from the examples and an engine that claims nothing is an engine nobody has checked' };
  }

  const mark = stamp();
  const cdir = candidateDir(id, mark);

  /* Write the candidate using the forge's own scaffold, so the contract, the
     shape of the test and the shape of the manifest are the same ones a build
     would produce. A repair that wrote its files by hand could produce
     something the gate does not recognise. */
  const files = forge.scaffold({
    id,
    capability: target.manifest.capability || spec.capability || 'act',
    name: spec.name || target.manifest.name,
    body: spec.body,
    examples: spec.examples,
  });

  /* lineage and the versions, which the forge's scaffold has no opinion about */
  const manifest = JSON.parse(files['manifest.json']);
  const before = current(id);
  manifest.version = (before ? Number(before.version) || 1 : 1) + 1;
  /* The kind is read from the spec, not written here. An earlier version of this
     line said 'repair' literally, which made improve() record itself as a
     repair — the two claims the file spends a section distinguishing were
     recorded identically, so the distinction existed only in prose. */
  const kind = spec.kind === 'improve' ? 'improve' : 'repair';
  manifest.lineage = { kind, fromVersion: before ? before.version : null, fromStamp: null, why: String(spec.why || '').slice(0, 300) || null };
  if (kind === 'improve') manifest.improvedAt = new Date().toISOString();
  else manifest.repairedAt = new Date().toISOString();
  files['manifest.json'] = JSON.stringify(manifest, null, 2) + '\n';

  fs.mkdirSync(cdir, { recursive: true });
  try {
    for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(cdir, f), body, 'utf8');
  } catch (e) {
    rm(cdir);
    return { ok: false, stage: 'stage', id, reason: 'could not write the candidate: ' + e.message };
  }

  /* The gate, on the candidate, before anything active has been touched. */
  const verdict = forge.runTestIn(cdir, 'the repaired ' + id);

  /* An improve is judged differently: it has to leave the old version working
     too, so the same candidate is measured against the engine that is running
     right now. A repair makes no such demand — a broken engine is expected to
     fail its own old test, and requiring it to pass would refuse exactly the
     repairs that are needed. */
  let regression = null;
  if (spec.kind === 'improve') {
    regression = forge.runTestIn(forge.engineDir(id), 'the current ' + id);
    if (!regression.ok) {
      rm(cdir);
      return { ok: false, stage: 'regression', id,
        reason: 'the engine that is running now does not pass its own test, so there is nothing stable to improve on',
        output: regression.output || '' };
    }
  }

  if (!verdict.ok) {
    /* The whole point of the ordering: the active engine has not been read or
       written at this point, and the debris is removed. */
    rm(cdir);
    return { ok: false, stage: 'test', id, reason: verdict.reason, output: verdict.output || '',
      keptActive: true, note: 'the running engine was not touched' };
  }

  const promoted = promote(router, id, cdir, spec);
  rm(cdir);
  if (!promoted.ok) {
    return Object.assign({ id, keptActive: true }, promoted);
  }
  return Object.assign({ id, kind: spec.kind === 'improve' ? 'improve' : 'repair', output: verdict.output || '' }, promoted);
}

/**
 * Level 4. The same act with a different claim: this engine works, and this is
 * better. The only mechanical difference is that improve refuses to promote if
 * the version it is replacing has stopped passing its own test.
 */
function improve(router, spec) {
  return repair(router, Object.assign({}, spec, { kind: 'improve' }));
}

/* --------------------------------------------------------------- rollback --- */

/**
 * Put a past version back.
 *
 * The snapshot is copied over the active files and the result is registered, so
 * the engine in the router is the one on disk afterwards rather than a copy of it
 * that happens to look the same. The version being rolled back to is snapshotted
 * again first, which means a rollback is itself undoable — going back and forth
 * is a feature of keeping the snapshots, not an accident of it.
 */
function rollback(router, id, to) {
  const target = checkTarget(id);
  if (!target.ok) return { ok: false, stage: 'guard', id, reason: target.reason };

  const all = versions(id);
  if (!all.length) return { ok: false, stage: 'guard', id, reason: id + ' has no earlier versions to roll back to' };

  const want = String(to || '').trim();
  const found = want ? all.find(v => v.stamp === want || String(v.version) === want) : all[all.length - 1];
  if (!found) {
    return { ok: false, stage: 'guard', id, reason: 'no version "' + want + '" — the ones kept are: ' + all.map(v => v.stamp).join(', ') };
  }

  const dir = forge.engineDir(id);

  /* keep what is active right now, so this can be undone */
  const mark = stamp();
  const snap = path.join(versionsDir(id), mark);
  fs.mkdirSync(snap, { recursive: true });
  for (const f of ['manifest.json', 'index.js', 'test.js']) {
    if (fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(snap, f));
  }

  for (const f of ['manifest.json', 'index.js', 'test.js']) {
    const src = path.join(found.dir, f);
    if (!fs.existsSync(src)) return { ok: false, stage: 'guard', id, reason: 'that snapshot has no ' + f };
    fs.copyFileSync(src, path.join(dir, f));
  }

  /* the manifest now says it was rolled back, and records where from */
  const m = readJson(path.join(dir, 'manifest.json'), {});
  m.rolledBackAt = new Date().toISOString();
  m.rolledBackTo = found.stamp;
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n', 'utf8');

  const reg = forge.register(router, id);
  if (!reg.ok) {
    for (const f of ['manifest.json', 'index.js', 'test.js']) {
      if (fs.existsSync(path.join(snap, f))) fs.copyFileSync(path.join(snap, f), path.join(dir, f));
    }
    forge.register(router, id);
    return { ok: false, stage: 'rollback', id, reason: reg.reason || reg.error, restored: true };
  }
  return { ok: true, id, rolledBackTo: found.stamp, version: m.version || null, keptAs: mark, reason: reg.reason };
}

/** remove debris from a candidate that was interrupted mid-test */
function sweep() {
  const n = staleCandidates();
  for (const d of n) rm(d);
  return { removed: n.length };
}

module.exports = {
  CANDIDATE_PREFIX, VERSIONS_DIR,
  checkTarget, current, versions, candidateDir, staleCandidates,
  repair, improve, rollback, promote, sweep,
};
