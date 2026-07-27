# leanprompt

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

## Repository layout

```
ts/       TypeScript SDK — reference implementation (bun test)
rust/     Rust crate (cargo test)
go/       Go module (go test ./...)
parity/   golden vectors generated from ts/ (bun ts/scripts/gen-parity.ts)
docs/     parity-spec.md — the normative cross-language spec
```

## License

MIT. See [LICENSE](LICENSE).
