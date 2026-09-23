// auth.mjs — which brain is actually available, answered honestly.
//
// The cascade the estate has always wanted: frontier when it is genuinely reachable, the local 14b/7b
// otherwise, and NEVER a silent downgrade. A soul that quietly answers from a 7b while the window says
// "Sonnet" is worse than one that says "local only" — the second is a fact, the first is a lie you act
// on. So `resolve()` returns the tier it actually reached and why the ones above it were skipped.
//
// ══ WHERE THE TOKEN LIVES ═══════════════════════════════════════════════════════════════════════
//
// The subscription credential sits in ~/.claude/.credentials.json and it stays there. It is read by
// the local server process and used to call the API from THIS machine. It is never sent to the page,
// never written into localStorage, never logged, never committed. The page talks to localhost; the
// token talks to Anthropic; those are two different conversations and only one of them crosses a
// network the user does not own.
//
// The client id and token URL below are public constants of the Claude Code OAuth app, read out of
// the installed CLI rather than guessed. They identify the application, not the user.
//
// Pure where it can be: `tokenState`, `chooseTier` and `describe` take their inputs and return values.
// Only `readCredential`, `persist` and `refresh` touch the disk or the network, and each takes its
// dependency (path, fetch, clock) as an argument so the gate can drive them without either.
import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const OAUTH_BETA = 'oauth-2025-04-20';
export const CREDENTIALS = join(homedir(), '.claude', '.credentials.json');
export const OLLAMA = 'http://localhost:11434';

// Refresh a little BEFORE expiry. A token that dies mid-request looks like an outage, and the retry
// costs more than the minute of margin.
export const SKEW_MS = 5 * 60 * 1000;

export const TIERS = Object.freeze(['byok', 'oauth', 'local', 'none']);

/** Read the credential file. Returns null when there is none — that is a state, not an error. */
export function readCredential(path = CREDENTIALS) {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    return j && j.claudeAiOauth ? j.claudeAiOauth : null;
  } catch { return null; }
}

/** `missing` · `valid` · `expired` · `refreshable`. Never returns a token. */
export function tokenState(cred, now = Date.now(), skew = SKEW_MS) {
  if (!cred || !cred.accessToken) return cred && cred.refreshToken ? 'refreshable' : 'missing';
  if (!Number.isFinite(cred.expiresAt)) return 'valid';        // no expiry claimed — treat it as live
  if (cred.expiresAt - skew > now) return 'valid';
  return cred.refreshToken ? 'refreshable' : 'expired';
}

/** Does this credential actually grant inference? A profile-only token cannot answer a question. */
export function canInfer(cred) {
  const s = cred && cred.scopes;
  const list = Array.isArray(s) ? s : (s && typeof s === 'object' ? Object.values(s) : []);
  return list.includes('user:inference');
}

/**
 * Exchange the refresh token for a new access token.
 *
 * `fetch` is injected so this is testable without a network, and the result is returned rather than
 * written — persisting is a separate, deliberate step, because a rotated refresh token that is not
 * saved locks the user out of their own subscription on the next call.
 */
export async function refresh(cred, { fetch: f = fetch, now = Date.now } = {}) {
  if (!cred || !cred.refreshToken) throw new Error('no refresh token to exchange');
  const r = await f(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: cred.refreshToken, client_id: OAUTH_CLIENT_ID }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`refresh failed ${r.status}: ${body.slice(0, 200)}`);
  let j;
  try { j = JSON.parse(body); } catch { throw new Error('refresh returned something that is not JSON'); }
  if (!j.access_token) throw new Error('refresh returned no access_token');
  return {
    ...cred,
    accessToken: j.access_token,
    // A rotating server hands back a new refresh token; a non-rotating one does not. Keep the old one
    // in the second case rather than writing undefined over a working credential.
    refreshToken: j.refresh_token || cred.refreshToken,
    expiresAt: now() + (Number(j.expires_in) || 3600) * 1000,
  };
}

/**
 * Write the credential back, atomically, keeping one backup of whatever was there first.
 *
 * Atomic because a half-written credentials file is a locked-out user, and the failure would land on
 * whoever next opened Claude Code rather than on whoever caused it.
 */
export function persist(cred, path = CREDENTIALS) {
  const backup = path + '.soul-backup';
  try { if (existsSync(path) && !existsSync(backup)) copyFileSync(path, backup); } catch { /* best effort */ }
  const existing = (() => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; } })();
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify({ ...existing, claudeAiOauth: cred }, null, 2));
  renameSync(tmp, path);
  return path;
}

/** Is a local model actually up? Injected fetch, short timeout — a hung probe is a down probe. */
export async function localUp({ fetch: f = fetch, base = OLLAMA, timeoutMs = 1500 } = {}) {
  try {
    const r = await f(base + '/api/tags', { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { up: false, models: [] };
    const j = await r.json();
    return { up: true, models: (j.models || []).map(m => m.name) };
  } catch { return { up: false, models: [] }; }
}

/**
 * Pick the tier from facts already gathered. Pure — no I/O, no clock — so the gate can drive every
 * combination, including the ones that are awkward to produce for real (an expired token AND a dead
 * Ollama, a token with no inference scope).
 */
export function chooseTier({ apiKey, oauth, local }) {
  const notes = [];
  if (apiKey) return { tier: 'byok', why: 'ANTHROPIC_API_KEY is set', notes };
  notes.push('no ANTHROPIC_API_KEY');

  if (oauth === 'valid') return { tier: 'oauth', why: 'subscription token is live', notes };
  notes.push(oauth === 'missing' ? 'no subscription credential on disk'
    : oauth === 'noscope' ? 'the credential does not grant user:inference'
    : oauth === 'refresh-failed' ? 'the refresh token was rejected — run `claude` once to sign in again'
    : `subscription token ${oauth}`);

  if (local && local.up) return { tier: 'local', why: `Ollama is up (${local.models.length} models)`, notes };
  notes.push('Ollama is not answering on ' + OLLAMA);
  return { tier: 'none', why: 'no brain is reachable', notes };
}

/** One line a human can read, in the window and in the log. */
export function describe(res) {
  const head = { byok: 'frontier · API key', oauth: 'frontier · subscription', local: 'local only', none: 'NO MODEL' }[res.tier];
  return `${head} — ${res.why}`;
}

/**
 * The whole resolution: read, refresh if it is worth refreshing, probe local, choose.
 *
 * Refreshing is attempted at most once per call and its failure is a NOTE, never a throw — a dead
 * subscription must fall through to the local model, not take the window down with it.
 */
export async function resolve({
  env = process.env, credPath = CREDENTIALS, fetch: f = fetch, now = Date.now, base = OLLAMA,
} = {}) {
  const apiKey = (env.ANTHROPIC_API_KEY || '').trim() || null;
  let cred = readCredential(credPath);
  let state = tokenState(cred, now());
  let refreshed = false;

  if (cred && !canInfer(cred)) state = 'noscope';
  else if (state === 'refreshable') {
    try {
      cred = await refresh(cred, { fetch: f, now });
      persist(cred, credPath);
      refreshed = true;
      state = tokenState(cred, now());
    } catch { state = 'refresh-failed'; }
  }

  const local = await localUp({ fetch: f, base });
  const picked = chooseTier({ apiKey, oauth: state, local });
  return {
    ...picked, refreshed, local,
    // the token itself is returned to the SERVER process only, and never appears in any /health body
    key: picked.tier === 'byok' ? apiKey : picked.tier === 'oauth' ? cred.accessToken : null,
    expiresAt: picked.tier === 'oauth' && cred ? cred.expiresAt : null,
  };
}

/** Strip anything secret before this crosses to the page. */
export function publicStatus(res) {
  return {
    tier: res.tier, why: res.why, notes: res.notes, refreshed: !!res.refreshed,
    local: { up: !!(res.local && res.local.up), models: (res.local && res.local.models) || [] },
    expiresAt: res.expiresAt || null,
    line: describe(res),
  };
}

export default { OAUTH_TOKEN_URL, OAUTH_CLIENT_ID, OAUTH_BETA, CREDENTIALS, OLLAMA, TIERS, SKEW_MS,
  readCredential, tokenState, canInfer, refresh, persist, localUp, chooseTier, describe, resolve, publicStatus };
