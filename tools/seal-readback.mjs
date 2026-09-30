#!/usr/bin/env node
// tools/seal-readback.mjs — writes data/readback-prereg.json, the read-back's pre-registration, from the committed
// files: the held-out ids, each picture's sha256, the hashes of every input. Nothing in it is typed except the words
// of the call and the bars, which are the decisions being sealed. Committed and pushed BEFORE the first paid call.
//   node tools/seal-readback.mjs          writes it (refuses to overwrite)
//   node tools/seal-readback.mjs --check  exits 1 if the committed file differs from what this writes
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { cheaper } from '../kernel.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const buf = (f) => readFileSync(join(ROOT, f));
const J = (f) => JSON.parse(buf(f).toString('utf8'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const OUT = join(ROOT, 'data', 'readback-prereg.json');

const corpus = J('data/corpus.json'), renders = J('data/renders.json'), prereg = J('data/prereg.json');
const held = J('data/counts-heldout.json'), cal = J('data/counts-calibration.json');
const ids = prereg.heldout.ids;
const renderOf = Object.fromEntries(renders.renders.map((r) => [r.id, r]));
const countOf = Object.fromEntries(held.rows.map((r) => [r.id, r]));
const PLUMB = corpus.samples.find((s) => s.split !== 'heldout').id;   // the first calibration picture
const plumbCount = cal.rows.find((r) => r.id === PLUMB);

const SYSTEM = 'You transcribe text from images.';
const INSTRUCTION = 'Transcribe all of the text in this image exactly as it appears, character for character, keeping the line breaks. Output only the transcription — no commentary, no code fences.';

const doc = {
  kind: 'kar-pixel-cost-readback-prereg', v: 1, written: '2026-09-30',
  statement: 'Sealed, committed and pushed before the first paid read-back call. The saving in data/prereg.json counts tokens; a saving is worth nothing if the picture is misread. This fixes, in advance, how every held-out picture is shown to the model, how each transcript is graded, the bars it must clear, and how the spend is reported. The result is published whichever way it lands.',
  question: 'Shown only the picture, does the model whose tokens were counted read the held-out text back exactly?',
  inputs: {
    'data/corpus.json': sha(buf('data/corpus.json')),
    'data/renders.json': sha(buf('data/renders.json')),
    'data/prereg.json': sha(buf('data/prereg.json')),
    'data/counts-heldout.json': sha(buf('data/counts-heldout.json')),
    'prices.lock.json': sha(buf('prices.lock.json')),
  },
  call: {
    model: 'claude-sonnet-5',
    route: 'the official claude CLI, one process per picture — the credential on this machine is a subscription, and si-didy measured that the raw API refuses subscription tokens from third-party clients; the CLI is the sanctioned path, so it is the one used',
    args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-5', '--system-prompt', '<system>', '--tools', '', '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--no-chrome', '--max-budget-usd', '0.05'],
    cwd: 'a fresh empty directory under C:\\tmp for every call — outside the user profile, so walking up from it finds no CLAUDE.md (amendment 1)',
    whatTheCliAdds: 'read from the CLI\'s own outgoing request, captured by a local sink that answers 400 so nothing was sent or billed: its two fixed system lines (a billing header, and "You are a Claude agent, built on Anthropic\'s Claude Agent SDK."), a one-line reminder of the per-call budget, and a context line with the date and the account email; max_tokens 64000; adaptive thinking at high effort, billed as output. No tools. None of it carries any source text.',
    system: SYSTEM,
    content: ['image: the committed PNG, base64, media type image/png', 'text: the instruction'],
    instruction: INSTRUCTION,
    sampling: 'the CLI default (adaptive thinking, high effort) — temperature is not settable on this path, so each picture is read once and that read is the one graded',
    oneCallPerPicture: true,
  },
  blind: 'The model is given the system line, the picture and the instruction — nothing else. No tools (--tools ""), no MCP servers, no settings but the empty project scope, and an empty working directory, so it cannot open the corpus. The source text never appears in any argument or message. Each call\'s own init event (its tool list, MCP servers and credential source) is recorded as the receipt of that.',
  plumbing: {
    id: PLUMB, split: 'calibration', countedImageTokens: plumbCount.imageTokens,
    why: 'one calibration picture (its text is already public here and is not held out) goes through the identical path first, to prove the pipe before any held-out picture is spent on',
    passIf: ['the call succeeds', 'the init event lists no tools and no MCP servers', 'the only model in the per-model usage is claude-sonnet-5', 'all input tokens (fresh, cache write, cache read) are no more than the picture\'s counted image tokens + 300 — i.e. nothing but the system line, the picture and the instruction went in'],
    ifItFails: 'no held-out picture is sent; the pipe is fixed, the fix is committed and pushed as an amendment to this file, and the plumbing check is re-run on the same calibration picture',
    counted: 'its tokens are included in the reported spend',
  },
  heldout: {
    n: ids.length,
    ids,
    pngSha256: Object.fromEntries(ids.map((id) => [id, renderOf[id].pngSha256])),
    cheaperAsImage: ids.filter((id) => cheaper(countOf[id].textTokens, countOf[id].imageTokens) === 'image'),
  },
  grading: {
    by: 'the kernel, deterministically — no model judges a model',
    expected: 'expectedLayout(sample.text, renders.metrics): the committed source text, broken into the renderer\'s lines',
    clean: 'normalizeRead: CRLF to LF; a reply wholly inside one code fence is unwrapped; trailing spaces cut from each line; blank lines at the very start and end dropped. Nothing else.',
    content: 'every non-whitespace character, in order. contentExact = all of them match. contentCer = Levenshtein edits over the expected content length.',
    layout: 'layoutExact (line breaks and spaces too) is reported for every picture, and judges nothing',
    missing: 'a picture with no transcript (a failed or refused call) is graded as the empty transcript: contentCer 1, not exact',
  },
  rules: [
    { id: 'median-cer', rule: 'the median contentCer over all 64 is at most 1%' },
    { id: 'exact-overall', rule: 'at least 70% of the 64 are contentExact' },
    { id: 'exact-hex', rule: 'at least 75% of the hex pictures are contentExact' },
    { id: 'exact-base64', rule: 'at least 75% of the base64 pictures are contentExact' },
    { id: 'no-wreck', rule: 'no picture has a contentCer above 10%' },
  ],
  verdict: 'readbackJudge(rows) in the kernel applies exactly these five; the verdict is how many hold',
  banked: 'the held-out pictures that are both cheaper as an image AND read back contentExact — the saving that survives the read',
  purse: { module: 'si-didy/purse.mjs', how: 'mayCall before each call, charged after with the provider\'s own token counts (all input kinds + output)', heldout: { calls: ids.length, tokens: 150000 }, plumbing: { calls: 1, tokens: 2000 } },
  spend: 'the provider\'s own token counts from each call\'s result, priced by kind (amendment 1): fresh input at the locked list input price for claude-sonnet-5 in prices.lock.json, cache writes and reads at the multiples below, output at the locked output price, then the locked pound rate — kernel spend(). The CLI\'s own cost figure is recorded but not used: CLI 2.1.201 prices Sonnet 5 at $3/$15 per million, while the pricing page says $2/$10 is the standard price and the scheduled rise will not occur. Which credential paid is recorded from the CLI\'s init event and stated plainly: on a subscription the list-price figure is what an API key would have paid, not new money. The plumbing calls are included.',
  cacheMultiples: { write5m: 1.25, write1h: 2, read: 0.1, of: 'the base input price', source: 'https://platform.claude.com/docs/en/about-claude/pricing', checked: '2026-09-30' },
  amendments: [
    {
      n: 1, date: '2026-09-30', madeBefore: 'any held-out picture was sent',
      trigger: 'the first plumbing check failed its own token rule: 3,267 input tokens (2 fresh + 3,265 written to the 1-hour cache) against a ceiling of 423. Its read of prose-03 was exact; that is recorded and judges nothing. Kept as data/readback-plumbing-1.json.',
      cause: 'a local sink captured the CLI\'s outgoing request (no call made): about 7,400 characters of C:\\Users\\sjgan\\.claude\\CLAUDE.md were loaded as project instructions, because the per-call directory sat under the user profile and the CLI walks up from its working directory. Blindness was not breached — no source text — but it was not a clean call.',
      changes: [
        'the per-call directory moves under C:\\tmp (the sink confirmed the CLAUDE.md block is gone); the runner now refuses a directory with an instruction file above it',
        'spend is priced by kind, because the provider bills 1-hour cache writes at 2x the input price and the first plumbing call was almost all cache write',
        'the held-out token cap rises from 60,000 to 150,000, because the CLI runs adaptive thinking at high effort and thinking is billed as output — a cap that stopped the run part-way would lose pictures, and 150,000 is still a hard ceiling',
        'what the CLI adds to every call is written down (call.whatTheCliAdds)',
      ],
      unchanged: 'the model, the pictures, the system line, the instruction, the grading, the five rules and their bars, the predictions',
    },
  ],
  predictions: {
    said: 'before the run, by Kar',
    'median-cer': 'pass — most pictures read clean',
    'exact-overall': 'pass, around 80%',
    'exact-hex': 'pass, 7 of 8',
    'exact-base64': 'FAIL — 5 of 8; a line of base64 is the likeliest place for O/0 and l/I/1 slips',
    'no-wreck': 'pass',
    overall: '4 of 5',
  },
};

const text = JSON.stringify(doc, null, 1) + '\n';
if (process.argv.includes('--check')) {
  const same = existsSync(OUT) && readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') === text;
  console.log(same ? 'read-back pre-registration matches its inputs' : 'data/readback-prereg.json differs from what the committed inputs give');
  process.exit(same ? 0 : 1);
}
if (existsSync(OUT)) { console.error('data/readback-prereg.json exists — it is sealed; amendments are committed by hand, with the reason'); process.exit(1); }
writeFileSync(OUT, text);
console.log('sealed data/readback-prereg.json · sha256 ' + sha(Buffer.from(text)) + ' · ' + ids.length + ' held-out pictures · plumbing on ' + PLUMB);
