#!/usr/bin/env node
// count-tokens.mjs — a trusted, server-side-only script that calls Anthropic's REAL
// /v1/messages/count_tokens endpoint. Follows auth.mjs's exact security pattern (the same
// one kar-cockpit.mjs already uses): resolve() reads the credential, the token is used ONLY
// in a fetch Authorization header, and is NEVER printed, logged, or returned to the caller —
// only the resulting integer counts are. This is the gold-standard measurement for the
// text-vs-image token cost experiment (2026-09-23), not an estimate.
//
// Usage: node count-tokens.mjs <path-to-json-file>   (or --inline '<json>' for short payloads)
//   file contains a JSON array of content blocks, e.g.:
//   text:  [{"type":"text","text":"hello world"}]
//   image: [{"type":"image","source":{"type":"base64","media_type":"image/png","data":"<b64>"}}]
// File input avoids the OS argv-length limit that a large inline base64 image blows through.
// Prints ONLY: {"ok":true,"inputTokens":N} or {"ok":false,"why":"..."} — nothing else, ever.
import { readFileSync } from 'node:fs';
import { resolve, OAUTH_BETA } from './auth.mjs';

async function main() {
  const arg = process.argv[2];
  if (!arg) { console.log(JSON.stringify({ ok: false, why: 'usage: node count-tokens.mjs <path-to-json-file> | --inline \'<json>\'' })); process.exit(1); }
  let contentJson;
  if (arg === '--inline') contentJson = process.argv[3];
  else { try { contentJson = readFileSync(arg, 'utf8'); } catch (e) { console.log(JSON.stringify({ ok: false, why: 'could not read file: ' + e.message })); process.exit(1); } }
  let content;
  try { content = JSON.parse(contentJson); } catch { console.log(JSON.stringify({ ok: false, why: 'content must be valid JSON' })); process.exit(1); }

  const auth = await resolve();
  if (auth.tier !== 'oauth' && auth.tier !== 'byok') {
    console.log(JSON.stringify({ ok: false, why: 'no frontier tier reachable: ' + auth.why }));
    process.exit(1);
  }

  const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (auth.tier === 'byok') headers['x-api-key'] = auth.key;
  else { headers['Authorization'] = 'Bearer ' + auth.key; headers['anthropic-beta'] = OAUTH_BETA; }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'user', content }] }),
    });
    const body = await r.text();
    if (!r.ok) { console.log(JSON.stringify({ ok: false, why: 'API ' + r.status + ': ' + body.slice(0, 300) })); process.exit(1); }
    const j = JSON.parse(body);
    console.log(JSON.stringify({ ok: true, inputTokens: j.input_tokens }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, why: 'request failed: ' + e.message }));
    process.exit(1);
  }
}
main();
