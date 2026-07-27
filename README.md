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

## 60-second example (TypeScript)

Keep the official SDK you already use and hand it a compressing `fetch`:

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

Every SDK also exposes the core API directly (`Middleware` /
`compress_messages` / `CompressMessages`) plus **SelfLLM** — delegation of
summarization to a cheap model (Anthropic / OpenAI / Gemini) over raw HTTP.

## What savings to expect — honest math

Only PROSE is compressed. Everything the classifier flags as code, error or
structured data — and all tool/image blocks — passes through verbatim by
design. Total savings ≈ `prose_token_share × (1 − keep_ratio)` plus
dedup/purge wins:

- prose-heavy histories: roughly **40–50%** at the default keep-ratio 0.5
- code/tool-heavy agent histories: substantially less — measure on your own
  traffic before quoting a number

## Commands / test reference

| Language | Test | Lint / typecheck | Regenerate parity vectors |
|---|---|---|---|
| TypeScript | `bun test` | `bun x tsc --noEmit` | `bun scripts/gen-parity.ts` (from `ts/`) |
| Rust | `cargo test` | `cargo clippy --all-targets -- -D warnings` | — (asserts against `parity/`) |
| Go | `go test ./...` | `go vet ./...` && `gofmt -l .` | — (asserts against `parity/`) |

## Repository layout

```
ts/       TypeScript SDK — reference implementation (bun test)
rust/     Rust crate (cargo test)
go/       Go module (go test ./...)
parity/   golden vectors generated from ts/ (bun ts/scripts/gen-parity.ts)
docs/     parity-spec.md — the normative cross-language spec
```

## Security

See [SECURITY.md](SECURITY.md) for supported versions and how to report a
vulnerability.

## License

MIT. See [LICENSE](LICENSE).
