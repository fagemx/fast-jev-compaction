# fast-jev-compaction

Context compaction that keeps history verbatim: every tool call and result is
scored by Jev in one fast request, stale ones are cut, everything kept stays
word for word. Ships as a [Pi extension](#pi-extension), a
[Claude Code plugin](#claude-code-plugin) and an npm library.

> This is the maintained fork at
> [fagemx/fast-jev-compaction](https://github.com/fagemx/fast-jev-compaction) of
> [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction).
> On top of upstream it adds the Pi extension, redacts secrets from every Jev
> request, cuts text on code point boundaries, rejects malformed Jev
> probabilities and estimates dense tokens better; several of these come from
> open upstream pull requests, credited in the commits.

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This library never rewrites anything. It only deletes tool
calls and tool results Jev says are no longer needed, and it asks Jev while
showing it the whole conversation. User and assistant text stays verbatim and
in order.

The repository is an npm package (`src/`), a Claude Code plugin (`hooks/`,
`.claude-plugin/`) and a Pi package (`pi/`); both hosts use the package in
place of their built-in compaction summary.

## How it works

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. The **state** sent to Jev is the whole conversation so far, oldest first,
   with every tool result replaced by a short note (`ok, 4213 chars (omitted)`).
   Tool inputs are included, texts are included, nothing is summarized.
3. The state is fitted into `maxStateTokens` (25k by default) in stages, each
   applied only if the previous one was not enough: tool inputs truncated to
   1000, then 200, then 60 characters; long texts abridged to head + tail,
   oldest non-pinned messages first; old non-pinned messages collapsed to a
   `[… N chars omitted …]` note; old tool calls reduced to one line each
   (`t12 Read file_path=src/a.ts → ok 480ch`); old call-less messages left
   out; runs of old call-only messages folded into one entry. If it still
   does not fit, compaction throws. Tokens are estimated without a tokenizer (a
   word per six letters, half a token per digit, ~one per other symbol),
   calibrated to land a little above the counts Jev reports.
4. For every non-pinned call Jev gets two `noul` questions: should the **call**
   stay (knowing it was made, with its input, still matters), and should the
   **result** stay verbatim (its contents are still needed and re-running the
   tool would not do).
5. Questions are split into as many requests as needed so state plus questions
   stays under `maxRequestTokens` (30k by default, under Jev's 32k request
   limit). The same full state is resent with every request; requests run
   concurrently and their answers are merged.
6. Decisions per call, against `keepThreshold`:
   - `keepResult ≥ threshold` → keep call and result;
   - else `keepCall ≥ threshold` → keep the call, truncate the result to its
     first `truncateHeadChars` characters plus a one-line note;
   - else → remove the call together with its result.
7. The message list is rebuilt: a message that loses all its content is
   removed, untouched messages are returned as the same objects, and no result
   is ever left without its call.

Jev failures, malformed answers, a missing key, or a history that cannot be
fitted throw; the caller (or the Claude Code hook) decides what to fall back to.

## Install and usage

Build the library from this repository:

```sh
git clone https://github.com/fagemx/fast-jev-compaction
cd fast-jev-compaction && npm install && npm run build
cd /your/project && npm install /path/to/fast-jev-compaction
export TYPESAFE_API_KEY=...
```

The `fast-jev-compaction` package on npm is published by a third party, not
from this repository or from upstream.

```ts
import { compactMessages, reductionRatio, type Message } from 'fast-jev-compaction';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
  // …
];

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript
can be passed in as is.

To bring your own transport, implement `JevAsker` (one `ask(state, questions)`
method) and call `compact(messages, asker, options)`; `buildJevRequest` and
`parseJevResponse` give you the HTTP request body and response validation.
The building blocks (`collectToolCalls`, `fitState`, `batchCalls`,
`decideCall`, `applyDecisions`) are exported too.

`apiKey` defaults to `process.env.TYPESAFE_API_KEY`. Never commit the key or
put it in a source file.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key (`compactMessages`/`JevClient`) |
| `model` | `jev-latest` | Jev model name |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | System One endpoint |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 user prompts | Ongoing task description included in the state |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |

`result.stats` reports message and character counts before and after, the
per-reason decision counts, the state size in estimated tokens, which fitting
stage was needed, and the number of requests.

## Limitations

- Only tool calls and results are candidates; text messages are never removed
  or shortened in the output (they are only abridged in the state Jev sees).
- Token sizes are estimates from character counts, not a tokenizer.
- Calibration is at the request level; a probability is not a proof that a
  result is safe to delete. The assistant can always re-run the tool.
- The full state is repeated with every request, so a history near the state
  ceiling costs one request per handful of questions.
- The state carries the conversation's text and tool inputs to the Jev
  endpoint. `buildJevRequest` redacts credential-shaped substrings (provider
  keys, JWTs, `Bearer` values, `KEY=value`, URL passwords, opaque blobs) and the
  API key itself, but the redaction is pattern-based, not a guarantee.

## Claude Code plugin

The repository root is a Claude Code function-hook plugin: `hooks/fast-jev.ts`
is a thin adapter that feeds `session.compact` transcripts through `src/` and
falls back to Claude Code's built-in summary on errors or insufficient
reduction. See [`hooks/README.md`](hooks/README.md) for configuration and the
Claude Code 2.1.274 type reference.

### Install in Claude Code

Function hooks are an early-access Claude Code feature (2.1.274+), so the
opt-in flag must be set wherever Claude Code runs, e.g. in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "TYPESAFE_API_KEY": "<your key>" } }
```

Then add this repository as a plugin marketplace and install the plugin,
either from the shell or as slash commands inside a session:

```sh
claude plugin marketplace add fagemx/fast-jev-compaction
claude plugin install fast-jev-compaction@fast-jev-compaction
```

The install prompts for the plugin options (API key, thresholds, `truncateHeadChars`,
…); leave them at their defaults to use `TYPESAFE_API_KEY` from the environment.
Restart Claude Code or run `/reload-plugins`. From then on `/compact` (and
auto-compaction) goes through Jev: the toast reads
`fast-jev-compaction: kept N/M messages, no summary (…)` when the pruned history
replaced the built-in summary, or `fallback to built-in summary (…)` when Jev
could not remove enough (short sessions, or when it fails).

To run from a checkout without installing: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`
from the repository root. No publishing step is required; the marketplace is
just the repo's `.claude-plugin/marketplace.json`.

## Pi extension

`pi/fast-jev.ts` makes [Pi](https://pi.dev) compact with Jev instead of an LLM
summary. It needs Pi 0.87 or newer (the `context_edit` API); it is tested on
Pi 1.0.

### Install

```sh
pi install git:github.com/fagemx/fast-jev-compaction
```

Update later with `pi update --extension git:github.com/fagemx/fast-jev-compaction`.
To try a checkout for one run: `pi -e /path/to/fast-jev-compaction`.

### Give it Jev access

The extension reads its key from the environment Pi starts in. A key set
somewhere else, such as Claude Code's `settings.json`, is not visible to Pi.
Pick one route:

| Route | Set | Key used |
| --- | --- | --- |
| OpenRouter, recommended when Pi already uses OpenRouter | `FAST_JEV_PROVIDER=openrouter` | `OPENROUTER_API_KEY`, or Pi's own OpenRouter login when that is unset |
| TypeSafe directly | `TYPESAFE_API_KEY=<your key>` | that key |

Windows, in PowerShell (stored for your user; open a new terminal afterwards):

```powershell
[Environment]::SetEnvironmentVariable('FAST_JEV_PROVIDER', 'openrouter', 'User')
# or
[Environment]::SetEnvironmentVariable('TYPESAFE_API_KEY', '<your key>', 'User')
```

macOS or Linux, in `~/.zshrc` or `~/.bashrc`:

```sh
export FAST_JEV_PROVIDER=openrouter
# or
export TYPESAFE_API_KEY=<your key>
```

Check it from the terminal you start Pi in: `$env:FAST_JEV_PROVIDER` or
`[bool]$env:TYPESAFE_API_KEY` in PowerShell, `echo $FAST_JEV_PROVIDER` or
`echo ${TYPESAFE_API_KEY:+set}` in a POSIX shell. Without access the
extension edits nothing and says so, for example
`fast-jev: /compact: TYPESAFE_API_KEY is not set; Pi summarizes instead`.

### What it does

Two paths, neither of which asks an LLM for a summary.

**While you work.** At the end of a turn whose context is at or above
`FAST_JEV_COMPACT_AT_PERCENT` (60%), Jev decides which older tool calls and
results still matter, and the rest shrink through Pi's append-only
`context_edit` entries. A dropped result keeps its first
`FAST_JEV_TRUNCATE_HEAD_CHARS` characters and a note. A dropped call is
stubbed rather than deleted: it stays in its assistant entry, long input
strings cut to their head, and its result becomes the note alone
(`[fast-jev-compaction truncated N chars of this tool result; re-run the tool
if needed]`). The history keeps a call behind every report the assistant made,
and the gap is marked inside a tool result, not in the assistant's own words,
which a model has been seen to imitate (#65, #123). The next run waits until
the context grows by another 10% of the window, or drops below the threshold.

**When Pi compacts** (`/compact`, its own threshold at
`contextWindow - reserveTokens`, or overflow recovery). Jev scores the history
Pi would summarize, with Pi's kept window as pinned context, and that history
goes into the compaction entry verbatim (thinking left out), stale tool
outputs cut the same way, after the previous summary and followed by the files
it read and changed. `/compact <instructions>` leads the goal Jev scores
against. No summarization model is called, so compaction takes about a second.
The compaction entry also keeps that history as messages, in its
`details.fastJev`; the next compaction takes them back and Jev scores them
again with the new work, so the verbatim history does not pile up from one
compaction to the next, and a result kept then can still be cut later.

Raw history, the TUI and exports keep everything; only the model context
shrinks. Each turn-end run appends a `custom` entry
(`customType: "fast-jev-compaction"`) with its stats and per-call decisions, and
a compaction keeps them in its `details.fastJev`. In the TUI each run shows a
notification such as `fast-jev: 3 context edits, no summary (…)` or
`fast-jev: /compact by Jev, no LLM summary (…)`.

Pi's own summary stays the fallback, and the notification says why, when:

- at turn end, Jev cannot remove `FAST_JEV_MIN_REDUCTION_RATIO` (25%) of the
  history;
- when compacting, Jev finds nothing stale to cut, or the compacted context
  would still take more than `FAST_JEV_COMPACT_TARGET` (50%) of Pi's
  compaction threshold, the window minus `reserveTokens`. This is measured
  against Pi's own threshold, scaled from Pi's token count, rather than as a
  share of the window, because the window Pi assumes can be wrong:
  openai-codex models are listed at 272k and accept more;
- there is no key, Jev fails, or it gives no answer within
  `FAST_JEV_TIMEOUT_MS`; an interrupted turn stops the request too.

Whichever route is used, credential-shaped text is redacted from every Jev
request before it leaves the machine, and the goal Jev scores against comes
from your own prompts, not Pi's summaries, bash runs or other extensions'
messages.

### When Pi's context window is wrong

The extension sizes its decisions by Pi's own numbers: turn-end runs start at
a share of the model's context window, and a compaction must leave room under
Pi's compaction threshold (the window minus `reserveTokens`). Some built-in
models are listed with a smaller window than the provider serves; Pi lists
openai-codex's gpt-6 models at 272k, yet requests past 277k tokens succeed.
Set the window your provider actually serves in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "openai-codex": {
      "modelOverrides": {
        "gpt-6-astra": { "contextWindow": 1000000 }
      }
    }
  }
}
```

To have Pi compact before the very edge, raise the reserve for that model in
`~/.pi/agent/settings.json`; with a 1M window, 100k compacts at 900k:

```json
{ "compaction": { "modelOverrides": { "openai-codex/gpt-6-astra": { "reserveTokens": 100000 } } } }
```

`pi --list-models` shows the window Pi uses. On a 1M window the default
`FAST_JEV_COMPACT_AT_PERCENT` of 60 starts turn-end runs at 600k tokens; a
lower value such as 30 trims stale tool output sooner.

### Options

All are environment variables, read when Pi starts.

| Variable | Default | Meaning |
| --- | --- | --- |
| `FAST_JEV_PROVIDER` | `typesafe` | `typesafe` or `openrouter` |
| `FAST_JEV_BASE_URL` | the provider's | Any other endpoint that speaks the Jev protocol |
| `FAST_JEV_MODEL` | `jev-latest`; `typesafe/jev-1.13` on OpenRouter | Jev model name |
| `FAST_JEV_TIMEOUT_MS` | `15000` | Deadline for one Jev request |
| `FAST_JEV_COMPACT_AT_PERCENT` | `60` | Context percentage at which turn-end compaction runs |
| `FAST_JEV_MIN_REDUCTION_RATIO` | `0.25` | Least share of characters a turn-end run must remove |
| `FAST_JEV_COMPACT_TARGET` | `0.5` | Largest share of Pi's compaction threshold the context may take after a Jev compaction |
| `FAST_JEV_KEEP_THRESHOLD` | `0.5` | Least keep probability for a call or result to stay |
| `FAST_JEV_PRESERVE_RECENT_MESSAGES` | `6` at turn end; Pi's kept window when compacting | Newest messages never touched |
| `FAST_JEV_TRUNCATE_HEAD_CHARS` | `300` | Characters a truncated result or input keeps |
| `FAST_JEV_MAX_STATE_TOKENS` | `25000` | Estimated token ceiling for the state sent to Jev |
| `FAST_JEV_MAX_REQUEST_TOKENS` | `30000` | Estimated ceiling for state plus one batch of questions |
| `FAST_JEV_GOAL` | your last 3 prompts | Task description Jev scores against |

## Development

```sh
npm install
npm run typecheck        # library + hook + Pi extension
npm test
npm run build
npm run validate:plugin  # claude plugin validate
TYPESAFE_API_KEY="$(cat ~/.typesafe_key)" npm run demo
```

The unit tests use a fake Jev and never contact TypeSafe. The demo is the live
network check.

## Animated demo (macOS)

`demo/JevDemo` is a small native SwiftUI app that plays a scripted, dramatized
version of the compaction flow inside a Claude Code-style terminal: the tool
calls of a canned transcript are scored, results and calls Jev lets go turn red
and collapse away, and the rest stays verbatim. It never calls the API; it
exists to be screen recorded.

```sh
demo/JevDemo/build.sh   # builds demo/JevDemo/build/JevDemo.app and launches it
```

Press space in the app to replay from the start.
