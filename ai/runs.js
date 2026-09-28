'use strict';
/* ====================================================================== *
 *  ai/runs.js — the registry of agent runs, and the lock that keeps a run
 *  to one at a time.
 *
 *  Why a run needs a registry at all
 *  ---------------------------------
 *  A run outlives the fetch that started it. The dashboard can be refreshed
 *  mid-turn, or closed and reopened tomorrow, and the work is still going on
 *  the server. So the run record has to be findable by its id afterwards, and
 *  it has to keep the events it emitted so a reattaching page can replay them
 *  rather than start a second run. That record lives here.
 *
 *  Why only one at a time
 *  ---------------------
 *  A run drives the browser, and the browser has one identity for "the tab the
 *  agent is driving" — session.agentTabId, a single slot (ai/browser/session.js).
 *  Every tool call that does not name a tab explicitly lands on whatever is in
 *  that slot. So two runs in flight do not get two tabs between them: the last
 *  one to open or activate a tab takes the slot, and the other run's next
 *  click lands on a page the person never asked it to touch. That is silent
 *  wrong action, not a visible error, which is the worst kind there is.
 *
 *  Three more things are shared the same way, and none of them are namespaced
 *  per run:
 *
 *    refs        one Map, FIFO-capped (server.js). One run reading enough
 *                pages evicts the other's element handles, so a ref that was
 *                correct a moment ago starts failing for a reason that has
 *                nothing to do with the page.
 *    the engines  module-level singletons (stagehand.js, playwright-mcp.js,
 *                browser-use.js). Each one holds its own reference to a page,
 *                so a concurrent call from another run moves it underneath
 *                this one.
 *    health      one mutable map of success/failure counts (automation/index.js),
 *                which both runs would be scoring into at once.
 *
 *  A lock is the honest fix. The alternative — giving every run its own tab
 *  binding, its own ref namespace and its own engine instances — is a large
 *  change to the browser identity model, and the browser itself still has one
 *  profile and one page-lock behind it all.
 *
 *  This is not a new restriction. The page has refused to start a second turn
 *  while one is running since sesIdle() (dashboard.html); the server just
 *  never said so, so a second tab, a second client or a curl could get
 *  through. Now it does.
 *
 *  claim() is the whole lock, and it is atomic: it contains no await, and Node
 *  runs one turn of the event loop to completion, so two claims cannot both
 *  see an empty registry.
 * ====================================================================== */

const RUN_KEEP_MS = 120000;   // a finished run stays replayable this long
const RUN_EVENT_CAP = 240;    // and never grows without bound
const MAX_RECORDS = 32;       // registry ceiling; a live run is never evicted

function createRunRegistry(opts = {}) {
  const keepMs = opts.keepMs === undefined ? RUN_KEEP_MS : opts.keepMs;
  const eventCap = opts.eventCap === undefined ? RUN_EVENT_CAP : opts.eventCap;
  const maxRecords = opts.maxRecords === undefined ? MAX_RECORDS : opts.maxRecords;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  const runs = new Map();

  /**
   * The run that has not finished, if there is one. A run that has been asked
   * to stop still counts: the engine is winding down between rounds and it
   * still holds the browser until it does, so treating it as free here would
   * hand the tab to the next caller at exactly the moment the current one is
   * still using it.
   */
  function live() {
    for (const [runId, run] of runs) {
      if (!run.finished) {
        return {
          runId,
          startedAt: run.startedAt,
          sessionId: run.sessionId || null,
          stopped: !!run.stopped,
        };
      }
    }
    return null;
  }

  /**
   * Take the lock and start a record, or report the run already holding it.
   * Callers must have validated the request before calling this: a turn that
   * is merely misconfigured deserves its own error, not "busy".
   */
  function claim(runId, sessionId) {
    const busy = live();
    if (busy) return { ok: false, live: busy };
    const run = {
      runId,
      sessionId: sessionId || null,
      stopped: false,
      finished: false,
      startedAt: now(),
      endedAt: 0,
      events: [],
    };
    runs.set(runId, run);
    prune();
    return { ok: true, run };
  }

  /**
   * Record one emitted event. This is also what marks a run finished, because
   * a turn that never reached a final or an error is a turn whose status would
   * lie to the next person who asks.
   */
  function record(run, ev) {
    run.events.push(ev);
    if (run.events.length > eventCap) run.events.shift();
    if (ev && (ev.type === 'final' || ev.type === 'error')) run.finished = true;
    return ev;
  }

  /**
   * Release the lock. Separate from record() on purpose: a run is finished
   * when the loop is over, which is not the same as when the last event was
   * written, and the difference is exactly where a stuck lock comes from.
   */
  function finish(run) {
    run.finished = true;
    run.endedAt = now();
    return run;
  }

  /**
   * Drop finished runs past their keep time, and only if the registry is over
   * its ceiling. A live run is never a candidate: it is the lock, and dropping
   * it would both lose the run and free the browser for whoever asks next.
   */
  function prune() {
    if (runs.size <= maxRecords) return 0;
    let n = 0;
    for (const [id, run] of runs) {
      if (run.finished && now() - run.startedAt > keepMs) { runs.delete(id); n += 1; }
    }
    return n;
  }

  function get(runId) {
    return runs.get(String(runId || '')) || null;
  }

  /** what a reattaching page is told; null when the server never had it */
  function view(runId) {
    const run = get(runId);
    if (!run) return null;
    return {
      runId: run.runId,
      running: !run.finished,
      finished: !!run.finished,
      failed: !!run.failed,
      stopped: !!run.stopped,
      startedAt: run.startedAt,
      endedAt: run.endedAt || null,
      sessionId: run.sessionId || null,
      events: run.events.slice(),
    };
  }

  /** ask a run to stop. Recorded, not merely signalled: a page that comes
   *  back has to be able to see that it was stopped. */
  function cancel(runId) {
    const run = get(runId);
    if (!run) return null;
    run.stopped = true;
    return run;
  }

  /**
   * Forget a conversation's runs once the person has deleted the transcript
   * on their side. A run still going is kept: deleting the record of a
   * conversation is not a way to stop the work in it, and making it one would
   * turn a delete button into a silent kill switch.
   */
  function forgetSession(sessionId) {
    let dropped = 0, keptRunning = 0;
    for (const [id, run] of runs) {
      if (run.sessionId !== sessionId) continue;
      if (!run.finished) { keptRunning += 1; continue; }
      runs.delete(id);
      dropped += 1;
    }
    return { dropped, keptRunning };
  }

  function size() { return runs.size; }

  return { runs, live, claim, record, finish, prune, get, view, cancel, forgetSession, size };
}

module.exports = { createRunRegistry, RUN_KEEP_MS, RUN_EVENT_CAP, MAX_RECORDS };
