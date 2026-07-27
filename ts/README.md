# leanprompt (TypeScript / Bun)

Zero-dependency prompt compression for LLM applications.

No ML model, no downloads, **zero runtime dependencies**. The local
compressor — `Extract` — is a deterministic, weights-free extractive
algorithm: sentence segmentation → integer term-rarity scoring with
entity/number/identifier/constraint boosts → redundancy filtering → greedy
selection to a keep-ratio. A heuristic classifier gates it so code, errors,
JSON and tool blocks are never touched; prohibitions ("do not ...") always
survive; system messages and the most recent turns are never compressed.

This package is the **reference implementation** of
[`docs/parity-spec.md`](../docs/parity-spec.md); the Rust (`rust/`) and Go
(`go/`) ports reproduce its output byte-for-byte (see `parity/`).

## Install

```bash
npm install leanprompt    # or: bun add leanprompt
```

## Use with your own SDK (recommended)

Keep the official OpenAI/Anthropic SDK you already have — it's your
dependency, not ours — and hand it a compressing fetch:

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
// requests are compressed on the wire; responses gain
// usage.leanpromptTokensSaved / leanpromptRatio / leanpromptMethod
```

Or wrap an existing client instance (duck-typed, works with both SDKs):

```ts
import { wrap } from "leanprompt";
const client = wrap(new OpenAI(), { mode: "on", routing: { prose: "extract" } });
```

## Minimal built-in clients

For simple non-streaming chat calls you can skip the official SDKs entirely:

```ts
import { OpenAI, Anthropic } from "leanprompt"; // minimal clients, not full SDKs

const client = new OpenAI({ leanpromptConfig: { mode: "on", routing: { prose: "extract" } } });
const response = await client.chat.completions.create({ model: "gpt-4o-mini", messages });
```

## Core API

```ts
import { Middleware } from "leanprompt";

const mw = new Middleware({ mode: "on", routing: { prose: "extract" } });
const [compressed, stats] = mw.compressMessages(messages);
```

`SelfLLM` (LLM-delegated summarization over raw fetch, providers:
anthropic/openai/gemini) is available via `routing: { prose: "selfllm" }`
with the async entry point, or standalone as `new SelfLLM({...})`.

## Expected savings — honest math

Only PROSE is compressed; everything the classifier flags as
code/error/structured and all tool/image blocks pass through verbatim.
Total savings ≈ `prose_token_share × (1 − ratio)` plus dedup/purge wins.
Prose-heavy histories: ~40–50% at ratio 0.5. Code/tool-heavy agent
histories: substantially less — measure on your own traffic.

## Development

```bash
bun install
bun test               # 110 tests incl. quality gates
bun x tsc --noEmit
bun scripts/gen-parity.ts   # regenerate ../parity golden vectors
```

PolyForm Noncommercial License 1.0.0, with a small-team commercial exception. See the repo root `LICENSE`.
