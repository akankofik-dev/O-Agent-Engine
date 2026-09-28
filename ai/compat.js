/* ===================================================================== *
 *  ai/compat.js — is this model actually usable through our chat path?
 *
 *  A provider's catalogue only means "listed". It does not mean the model
 *  will serve our requests: some models are gated behind a harness, an
 *  affiliate link, an app registration or an entitlement, and reject a
 *  perfectly good key with a 403. Nothing in the catalogue says so, so the
 *  only trustworthy signal is one small request.
 *
 *    catalogue(meta)  what the metadata already tells us, for free
 *    classify(err)    what a single failed (or succeeded) probe tells us
 *
 *  No model id is named anywhere in this file.
 * ===================================================================== */

const VERDICT = {
  OK: 'ok',
  UNAVAILABLE: 'unavailable',   // the provider will not serve it to us
  AUTH: 'auth',                 // the key itself is the problem
  RATE: 'rate_limited',         // transient: busy, try later
  GONE: 'not_found',            // it is not in the catalogue after all
  UNREACHABLE: 'unreachable',   // transient: network or timeout
  UNKNOWN: 'unknown',           // we could not tell; do not block the user
};

/* Wording families for "you may not use this through the plain chat API".
   Patterns, not one exact sentence: every provider and every release words
   the same restriction differently. */
const GATED = [
  /\bonly\s+(?:available|usable|supported|works?)\s+(?:on|via|through|with|for|using)\b/i,
  /\b(?:requires?|needs?|only\s+with)\s+(?:a\s+|an\s+|the\s+|being\s+|to\s+be\s+)?(?:registered|listed|approved|supported|affiliated|partner|enrolled)\b/i,
  /\bagentic\s+(?:harness|client|surface)s?\b/i,
  /\b(?:affiliate|referral)\s+link\b/i,
  /\bnot\s+(?:available|supported|permitted|allowed)\s+(?:for|to|on|via|with)\s+(?:this|your|your\s+key|your\s+account|direct|raw|plain|standard)\b/i,
  /\bapi\s+access\s+(?:is\s+)?(?:restricted|not\s+enabled|not\s+available|unavailable)\b/i,
  /\bnot\s+open\s+to\s+(?:the\s+)?(?:public|general|api)\b/i,
  /\bcontact\s+(?:support|sales|us)\b/i,
  /\bdirect\s+api\s+access\b/i,
  /\bzero[-\s]data[-\s]retention\b/i,
  /\bon\s+https?:\/\/\S+\/(?:apps|integrations|partners)\b/i,
  /* Entitlement wording. It arrives as a refusal of *this model* rather than of
     the key, so it belongs with the gates — and treating it as an
     authentication problem tells the user to retype a key that was fine. */
  /\b(?:no|not)\s+(?:permission|access|entitlement|licen[cs]e)\s+(?:to|for)\b/i,
  /\b(?:permission|access)\s+denied\b/i,
  /\bdoes\s+not\s+have\s+(?:permission|access)\b/i,
  /\brequires?\s+(?:an?\s+)?(?:paid|pro|premium|subscription|plan|credits?|a\s+subscription)\b/i,
  /\bupgrad(?:e|ing)\s+(?:your\s+)?(?:plan|subscription|account)\b/i,
];

/* Wording that means the key is the problem, so a 403 is not a gate. */
const KEY_PROBLEM = [
  /\b(invalid|incorrect|revoked|expired|unknown|malformed)\b[^.]*\b(key|token|api[_ -]?key)\b/i,
  /\bapi\s*key\b[^.]*\b(not\s+found|missing|no\s+longer|mismatch)\b/i,
  /\bunauthori[sz]ed\b/i,
  /\bauthentication\b/i,
  /\bno\s+(?:api\s+)?key\b/i,
  /\bapi[\s_-]?key\b[^.]*\bnot\s+authori[sz]ed\b/i,
  /\bforbidden\b[^.]*\b(key|permission|account|organisation|organization|tenant)\b/i,
  /\bpermission[^.]*\bdenied\b/i,
];

/* the labels ai/providers.js puts in front of the provider's own message */
const OUR_LABELS = [
  'authentication failed — check the API key',
  'endpoint or model not found',
  'rate limited by the provider',
  'the provider rejected the request',
  'the provider returned a server error',
  'request failed',
];

function matchesAny(text, list) {
  const s = String(text || '');
  return list.some(re => re.test(s));
}

/** is this failure the provider refusing to serve the model to us? */
function looksGated(message) {
  return matchesAny(message, GATED);
}

/* A 429 that is really an exhausted allowance. Same verdict, opposite advice —
   see the 429 branch in classify(). Nothing here names a provider. */
const QUOTA = /\b(quota|per[-_ ]?day|per[-_ ]?month|per[-_ ]?week|monthly|daily|weekly|billing|credit|insufficient|exceeded your|usage limit)\b/i;
function quotaDetail(detail) {
  return QUOTA.test(String(detail || ''));
}
function looksLikeKeyProblem(message) {
  return matchesAny(message, KEY_PROBLEM);
}

/**
 * The provider's own words. Our label says "authentication failed" for every
 * 401 and 403, so it must never be what the patterns are matched against.
 */
function providerDetail(info) {
  const given = String((info && info.detail) || '').trim();
  if (given) return given;
  const whole = String((info && info.message) || '').trim();
  for (const label of OUR_LABELS) {
    const at = whole.indexOf(label);
    if (at === -1) continue;
    const after = whole.slice(at + label.length).replace(/^[\s—–-]+/, '').trim();
    if (after) return after;
  }
  // our label is there but nothing followed it: the provider said nothing
  if (OUR_LABELS.some(l => whole.indexOf(l) !== -1)) return '';
  return whole;
}

/* ---------------------------------------------------------------------- *
 *  1. what the catalogue can tell us, without spending a request
 * ---------------------------------------------------------------------- */

/**
 * @param {object} meta the provider's own record for this model
 */
function catalogue(meta) {
  const m = meta || {};
  const out = { verdict: VERDICT.OK, tools: null, images: false, context: null, free: null, notes: [] };

  const arch = m.architecture || null;
  if (arch) {
    const inputs = arch.input_modalities || [];
    const outputs = arch.output_modalities || [];
    if (Array.isArray(inputs) && inputs.length) out.images = inputs.indexOf('image') !== -1;
    if (Array.isArray(outputs) && outputs.length && outputs.indexOf('text') === -1) {
      out.verdict = VERDICT.UNAVAILABLE;
      out.notes.push('This model does not return text, so it cannot answer in a chat.');
    }
  }
  if (typeof m.context_length === 'number' && m.context_length > 0) out.context = m.context_length;

  const params = m.supported_parameters;
  if (Array.isArray(params) && params.length) {
    out.tools = params.indexOf('tools') !== -1 ? 'yes' : 'no';
    if (out.tools === 'no') out.notes.push('This model does not accept tools, so the agent cannot drive the browser with it.');
  }

  const price = m.pricing;
  if (price && typeof price === 'object') {
    const p = Number(price.prompt);
    const c = Number(price.completion);
    if (Number.isFinite(p) && p === 0 && c === 0) out.free = true;
    else if (Number.isFinite(p)) out.free = false;
  }

  if (m.per_request_limits === null && m.expiration_date) {
    out.notes.push('Listed with an expiry date; the provider may stop serving it.');
  }
  return out;
}

/* ---------------------------------------------------------------------- *
 *  2. what one probe told us
 * ---------------------------------------------------------------------- */

/**
 * Turn a provider failure — or a success — into a verdict.
 * Structural first (status, errorType), the provider's wording second.
 *
 * @param {Error|null} err  null when the probe succeeded
 * @param {object} [info]   { status, errorType, detail, message, reply }
 */
function classify(err, info) {
  const i = info || {};
  if (!err) {
    if (i.reply === false) {
      return { verdict: VERDICT.UNAVAILABLE, reason: 'The model answered, but without any text this chat could show.' };
    }
    return { verdict: VERDICT.OK, reason: '' };
  }

  const status = Number(i.status || err.status || 0) || 0;
  const kind = String(i.errorType || err.errorType || '');
  const message = String(i.message || err.message || '');
  // an empty detail means the provider said nothing: do not fall back to our label
  const detail = providerDetail(Object.assign({ message }, i));
  const fail = (verdict, reason) => ({ verdict, reason: reason || message.slice(0, 240) });

  /* transport problems are never about the model */
  if (kind === 'timeout') return fail(VERDICT.UNREACHABLE, 'No answer in time. The endpoint may be slow or unreachable.');
  if (kind === 'network_error') return fail(VERDICT.UNREACHABLE, 'Could not reach the service.');

  /* a gate can be announced with any status, so check the wording first */
  if (looksGated(detail)) return fail(VERDICT.UNAVAILABLE, firstLine(detail));

  switch (status) {
    case 401:
      return fail(VERDICT.AUTH, 'The service rejected the API key.');
    case 403:
      /* 403 is ambiguous: a bad key and a missing entitlement look the same */
      if (looksLikeKeyProblem(detail)) return fail(VERDICT.AUTH, 'The service rejected the API key.');
      return fail(VERDICT.UNKNOWN,
        firstLine(detail) || 'The service refused this model without saying why, so it cannot be confirmed either way.');
    case 404:
      return fail(VERDICT.GONE, 'The provider does not have that model any more.');
    case 429:
      /* A spent allowance must not be described as "try again in a moment":
         waiting cannot bring it back, and telling a user to retry is the one
         piece of advice guaranteed to waste their time. Same verdict either
         way — a rate limit is not the model being unusable — different words. */
      return quotaDetail(detail)
        ? fail(VERDICT.RATE, 'The provider’s allowance for this model is used up, so waiting will not help. Use a different model or add credit.')
        : fail(VERDICT.RATE, 'The provider is busy right now. That is not a sign the model is unusable — try again in a moment.');
    default:
      break;
  }
  if (kind === 'rate_limited') return fail(VERDICT.RATE, 'The provider is rate limiting right now.');
  if (kind === 'not_found') return fail(VERDICT.GONE, 'The provider does not have that model.');
  if (kind === 'auth_error') return fail(VERDICT.AUTH, 'The service rejected the API key.');
  if (kind === 'bad_request') return fail(VERDICT.UNAVAILABLE, firstLine(detail) || 'The provider rejected a plain request for this model.');
  if (kind === 'upstream_error') return fail(VERDICT.UNKNOWN, 'The provider had a server problem. It is worth trying again.');

  return fail(VERDICT.UNKNOWN, firstLine(detail) || 'Could not verify this model.');
}

function firstLine(text) {
  return String(text || '').split('\n')[0].trim().slice(0, 200);
}

/** a verdict we are willing to block the user on */
function blocksUse(verdict) {
  return verdict === VERDICT.UNAVAILABLE || verdict === VERDICT.GONE || verdict === VERDICT.AUTH;
}

/** one short sentence for the user */
function describe(verdict, reason) {
  const r = String(reason || '');
  if (verdict === VERDICT.OK) return 'Usable.';
  if (verdict === VERDICT.UNAVAILABLE) return r || 'This model cannot be used through this app.';
  if (verdict === VERDICT.AUTH) return r || 'Check the API key.';
  if (verdict === VERDICT.RATE) return r || 'Rate limited right now — try again shortly.';
  if (verdict === VERDICT.GONE) return r || 'This model is no longer listed.';
  if (verdict === VERDICT.UNREACHABLE) return r || 'The service could not be reached.';
  return r || 'Could not verify this model.';
}

module.exports = {
  VERDICT, catalogue, classify, blocksUse, describe, providerDetail,
  looksGated, looksLikeKeyProblem, GATED, KEY_PROBLEM, OUR_LABELS,
};
