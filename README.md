# leanprompt

[![CI](https://github.com/itaides/leanprompt/actions/workflows/ci.yml/badge.svg)](https://github.com/itaides/leanprompt/actions/workflows/ci.yml)
![zero dependencies](https://img.shields.io/badge/dependencies-zero-brightgreen)
![no ML model](https://img.shields.io/badge/ML%20model-none-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript%2FBun-✓-blue)
![Rust](https://img.shields.io/badge/Rust-✓-orange)
![Go](https://img.shields.io/badge/Go-✓-00ADD8)
[![License: MIT](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

**Zero-dependency prompt compression for LLM applications.**
One deterministic algorithm, three native SDKs — TypeScript/Bun, Rust and Go —
with byte-identical output across all of them.

No ML model, no model download, no tokenizer dependency, no provider SDKs
required. The local compressor, **Extract**, is a weights-free extractive
algorithm: sentence segmentation → integer term-rarity scoring (boosted for
numbers, entities, identifiers and constraints) → redundancy filtering →
greedy selection to a keep-ratio, emitted in original order.

A heuristic **classifier gates everything**: code, stack traces, JSON blobs
and tool-call blocks are never touched; prohibitions ("do not …") always
survive; system messages and the most recent turns are never compressed.

## How it's different

| | leanprompt | Neural compressors (e.g. LLMLingua-2) |
|---|---|---|
| Model download | none | ~1 GB+ |
| Runtime dependencies | zero, in all 3 languages | GPU/ONNX runtime, tokenizer, model weights |
| Cold start | instant | model load (seconds, first call) |
| Output | deterministic, auditable | probabilistic, model-version-dependent |
| Cross-language parity | byte-identical by spec | not applicable — single implementation |
| Code/JSON/tool-call safety | classifier-gated, never touched | depends on wrapper logic |

## The SDKs

| Language | Directory | Runtime deps | Quickstart |
|---|---|---|---|
| TypeScript (Node ≥ 18 / Bun) | [`ts/`](ts/README.md) | **zero** | `npm install leanprompt` |
| Rust | [`rust/`](rust/README.md) | **zero** (`[dependencies]` empty) | `cargo add leanprompt` |
| Go | [`go/`](go/README.md) | **zero** (stdlib only) | `go get github.com/itaides/leanprompt/go` |

The TypeScript package is the reference implementation of
[`docs/parity-spec.md`](docs/parity-spec.md) — a written, normative spec
(pinned character classes, integer-only scoring, explicit tiebreaks,
canonical JSON). The Rust and Go ports assert byte-equality against the
golden vectors in [`parity/`](parity/), so identical inputs produce
identical compressed output in every language.

## Usage

Full option reference (every field, every default, per-language) lives in
[`CONFIG.md`](CONFIG.md). A few common patterns:

### TypeScript — keep your official SDK, compress on the wire

```ts
import OpenAI from "openai";
import { leanpromptFetch } from "leanprompt";

const client = new OpenAI({
    fetch: leanpromptFetch({
        mode: "on",
        trigger: { thresholdTokens: 2000 },
        routing: { prose: "extract" },
    }),
});

const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: LONG_DOCUMENT }],
});
console.log(response.usage.leanpromptTokensSaved);
```

### TypeScript — wrap an existing client instance instead

For SDKs (or SDK wrappers) that don't accept a custom `fetch`:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { wrap } from "leanprompt";

const client = wrap(new Anthropic(), {
    mode: "on",
    routing: { prose: "extract" },
});

const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content: LONG_DOCUMENT }],
});
```

### TypeScript — no official SDK at all (minimal built-in client)

```ts
import { OpenAI } from "leanprompt"; // leanprompt's own minimal client, not the `openai` package

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    leanpromptConfig: { mode: "on", routing: { prose: "extract" } },
});
const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: LONG_DOCUMENT }],
});
```

### TypeScript — call the compression pipeline directly

Useful outside an HTTP request/response cycle (batch jobs, custom transports):

```ts
import { Middleware } from "leanprompt";

const mw = new Middleware({ mode: "on", routing: { prose: "extract" } });
const [compressed, stats] = mw.compressMessages(messages);
console.log(stats.inputTokens, stats.outputTokens, stats.method);
```

### Rust

```rust
use leanprompt::{json, Config, Middleware};

let messages = json::parse(r#"[{"role":"user","content":"..."}]"#)?;
let mw = Middleware::new(Config {
    mode: "on".into(),
    routing: vec![("prose".into(), "extract".into())],
    extract_ratio_millis: 400,
    ..Config::default()
});
let (compressed, stats) = mw.compress_messages(messages.as_arr().unwrap());
```

### Go

```go
import leanprompt "github.com/itaides/leanprompt/go"

mw := leanprompt.NewMiddleware(leanprompt.Config{
    Mode:               "on",
    Routing:            map[string]string{"prose": "extract"},
    ExtractRatioMillis: 400,
})
compressed, stats := mw.CompressMessages(messages) // []map[string]any
```

Every SDK also exposes **SelfLLM** — delegating summarization to a cheap
model (Anthropic / OpenAI / Gemini) over raw HTTP instead of running the
local algorithm. See [`CONFIG.md`](CONFIG.md#selfllm--llm-delegated-summarization)
for its options and each package's README for the language-specific API.

**LangChain.js**: `leanprompt/langchain` (TypeScript only) wires
`leanpromptFetch` into `ChatOpenAI`/`ChatAnthropic` — see
[`ts/README.md`](ts/README.md#langchainjs). Adds no dependency to the core
`leanprompt` import.

## What savings to expect — honest math

Only PROSE is compressed. Everything the classifier flags as code, error or
structured data — and all tool/image blocks — passes through verbatim by
design. Total savings ≈ `prose_token_share × (1 − keep_ratio)` plus
dedup/purge wins:

- prose-heavy histories: roughly **40–50%** at the default keep-ratio 0.5
- code/tool-heavy agent histories: substantially less — measure on your own
  traffic before quoting a number
- the always-on `normalize` pass adds small *lossless* savings even where
  extractive compression never runs: CRLF/ANSI cleanup on code and error
  output, invisible-character and blank-line removal on prose, and
  whitespace minification on balanced JSON blobs

Token counts (the trigger threshold and every `leanprompt*` telemetry field)
come from a zero-dependency heuristic estimator, not the provider's actual
BPE tokenizer — see [`ts/src/tokens.ts`](ts/src/tokens.ts) for the full spec.
It's tuned per-script: space-delimited text (English and other Latin-script
languages) uses a 4-chars/token divisor, and CJK/Hangul/Thai/Lao/Khmer/Myanmar
— scripts with no space-delimited word boundaries, where real tokenizers run
far denser — use a separate ~1.5-chars/token divisor. Both are still
estimates. Measured against real tokenizers
(`bun bench/run-tokenizer-calibration.ts`, results in
[`bench/results/tokenizer-calibration.md`](bench/results/tokenizer-calibration.md)):
on the bundled English corpora the estimator **overcounts by about 1.5x**
versus OpenAI `o200k_base`/`cl100k_base` (every punctuation character is
charged a full token and words are charged `ceil(len/4)`), is within ~10%
on CJK and Cyrillic under `o200k_base`, and undercounts dense log lines by
~25%. Practically: a `thresholdTokens` of 2000 triggers at roughly 1300
real English tokens, and `leanpromptTokensSaved` overstates English savings
by a similar factor. Use the ratio, not the absolute count, when comparing
against your provider's bill.

## Interaction with provider prompt caching

Anthropic and OpenAI discount cached prompt prefixes heavily (typically 90%
and 50% of input price). Compression changes bytes, so it interacts with that
cache in a specific, predictable way:

- Each message is compressed **once**: on the turn it leaves the
  `protect.lastTurns` window (default: the last 2 messages are verbatim).
  Because `Extract` is deterministic, its output for that message is then
  identical on every later turn, so the prefix is stable again from the
  next request on.
- The cost is therefore one cache miss per message, roughly
  `lastTurns` turns after it was sent — not a miss on every request.
- Dedup and purge-errors change the prefix when they fire (a dropped
  duplicate shifts everything after it). Both are default-on; disable them
  via `strategies` if a stable prefix matters more than the savings.
- `SelfLLM` is *not* deterministic (it calls a model), so routing to it
  re-invalidates the prefix whenever the summary differs between calls. Use
  it only where cache hits are not expected anyway.

Rule of thumb: for long agent sessions where the cache is doing most of the
work, raise `protect.lastTurns` so compression happens further behind the
live turns, and prefer `extract` over `selfllm`.

## Trust boundaries

Compressing trusted instructions and untrusted content (web pages, tool
output, retrieved documents) under one shared budget is a known attack
surface: an adversary who controls the untrusted part can steer a lossy
compressor into dropping a guardrail (see
[arXiv:2510.22963](https://arxiv.org/abs/2510.22963)). leanprompt's design
keeps those inputs apart:

- `system` messages are never compressed, deduped or purged, under any
  configuration.
- Compression is strictly **per message**: budget and sentence ranking never
  cross a message boundary, so content in one message cannot influence what
  survives in another.
- Prohibitions (`do not`, `never`, `must not`) are kept unconditionally
  inside the message they appear in; code, JSON, errors and tool-call blocks
  pass through verbatim.

What it does **not** do: it does not detect prompt injection, and extractive
compression of a message does not remove an injected instruction from it.
Scan untrusted content before it enters the pipeline if that is a concern.
See [SECURITY.md](SECURITY.md#trust-boundaries) for the threat model.

## Commands / test reference

| Language | Test | Lint / typecheck | Regenerate parity vectors |
|---|---|---|---|
| TypeScript | `bun test` | `bun x tsc --noEmit` | `bun scripts/gen-parity.ts` (from `ts/`) |
| Rust | `cargo test` | `cargo clippy --all-targets -- -D warnings` | — (asserts against `parity/`) |
| Go | `go test ./...` | `go vet ./...` && `gofmt -l .` | — (asserts against `parity/`) |

## Benchmarks

`bun bench/run-quality.ts` (Extract vs a naive baseline), `bun
bench/run-cross-language.ts` (ts/rust/go agreement dashboard), `bun
bench/run-workload.ts --file <messages.json>` (savings on your own
conversation export). See [`bench/README.md`](bench/README.md).

## Repository layout

```
ts/         TypeScript SDK — reference implementation (bun test)
rust/       Rust crate (cargo test)
go/         Go module (go test ./...)
mcp-proxy/  MCP server wrapper compressing tool/task/sampling payloads (Claude Desktop and any MCP client)
parity/     golden vectors generated from ts/ (bun ts/scripts/gen-parity.ts)
bench/      quality, cross-language and real-workload measurement tooling
docs/       parity-spec.md — the normative cross-language spec
CONFIG.md   every configuration option, all three languages
ROADMAP.md  planned support for OpenAI Codex CLI
CHANGELOG.md notable changes per release
CONTRIBUTING.md contributor setup, checks, and PR rules
AGENTS.md   agent-facing repo guide: invariants, checks, conventions
```

## Roadmap

Claude Desktop support shipped as [`mcp-proxy/`](mcp-proxy/README.md) — an
MCP server wrapper that compresses oversized tool results, task payloads, and
sampling requests for any MCP client, verified end-to-end in Claude Desktop.
See [ROADMAP.md](ROADMAP.md) for what's still planned (OpenAI Codex CLI).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for notable changes per release.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and the PR process,
and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community standards. The one
rule that shapes most contributions: the three SDKs produce byte-identical
output, so a change to compression behavior updates the spec, regenerates the
golden vectors, and ports to all three languages in the same PR.

## Security

See [SECURITY.md](SECURITY.md) for supported versions and how to report a
vulnerability.

## License

MIT. See [LICENSE](LICENSE).
