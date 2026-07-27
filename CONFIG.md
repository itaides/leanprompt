# Configuration reference

Every option the pipeline accepts, in all three SDKs. The underlying shape is
identical everywhere (see [`docs/parity-spec.md`](docs/parity-spec.md) §9);
only the surface idiom differs — TypeScript takes a nested config object,
Rust/Go take a flat `Config` struct with integer ratios (thousandths) instead
of floats.

## `mode`

Gates the whole pipeline.

| Value | Behavior |
|---|---|
| `"off"` (default) | Passthrough. Messages returned unchanged, zero-valued stats. |
| `"passthrough"` | Same as `"off"`. |
| `"disabled"` | Same as `"off"`. |
| `"on"` | Active: strategies run, threshold gate applies, routing/compression happens. |
| `"hybrid"` | Same activation as `"on"`. (Not to be confused with `stats.method === "hybrid"`, which the middleware reports automatically when a single call routed different messages through different compressors — that's an output, not something you set.) |

```ts
new Middleware({ mode: "on" })
```
```rust
Config { mode: "on".into(), ..Config::default() }
```
```go
Config{Mode: "on"}
```

## `trigger.thresholdTokens` (TS) / `threshold_tokens` (Rust) / `ThresholdTokens` (Go)

Below this many (estimated) tokens across the whole message list, the call is
passthrough (`method: "below-threshold"`) even when `mode` is active. Protects
short turns from ever entering the pipeline. **Default: `2000`.**

```ts
{ mode: "on", trigger: { thresholdTokens: 500 } }
```

## `routing`

Maps a classifier label to a compressor by name. Any label with no entry (or
an entry naming an unregistered compressor) falls back to **`verbatim`** —
the pipeline is safe-by-default; it never guesses.

**Classifier labels** (see `docs/parity-spec.md` §6 for the exact heuristics):

| Label | Meaning | Emitted by the classifier? |
|---|---|---|
| `prose` | Free text | yes |
| `code` | Fenced blocks or ≥2 code-shaped lines | yes |
| `error` | Traceback/panic/error markers | yes |
| `structured` | Dense JSON-shaped text (≥200 chars, high `"key":` density) | yes |
| `unknown` | Empty/whitespace-only content | yes |
| `repeat` | Reserved | no — not currently emitted |
| `long_important` | Reserved | no — not currently emitted |

**Compressor names** available out of the box: `"verbatim"` (no-op, the
default for everything), `"extract"` (the local algorithm), and — in the
TypeScript SDK only — `"selfllm"` (registered automatically by `import
"leanprompt"`; see below). Custom compressors can be registered via
`registerCompressor(name, factory)` (TS) or by implementing the `Compressor`
trait/interface directly (Rust/Go) and calling `Router.register`.

`structured` always defaults to `verbatim` regardless of what `prose` is
routed to — sentence-segmenting JSON destroys it, so there's no gentler
auto-route for it (unlike some neural-compressor designs). Route it explicitly
if you really want it compressed.

```ts
{ routing: { prose: "extract", error: "verbatim" } }
```
```rust
Config { routing: vec![("prose".into(), "extract".into())], ..Config::default() }
```
```go
Config{Routing: map[string]string{"prose": "extract"}}
```

## `extract.ratio` (TS) / `extract_ratio_millis` (Rust) / `ExtractRatioMillis` (Go)

Fraction of tokens the `Extract` compressor **keeps**, applied per prose
message. TS takes a float in `(0, 1]`; Rust/Go take the same value ×1000 as an
integer (`500` = keep 50%) — see the parity spec's integer-scoring rule.
**Default: `0.5`** (`500` in Rust/Go).

Lower = more aggressive. Below the algorithm's internal minimums (< 3
sentences, < 40 estimated tokens, < 60% ASCII share, or content flagged
structural — fenced code / tracebacks) the span is left untouched regardless
of ratio; see `ts/src/compressors/extract.ts` for the full guard list.

```ts
{ routing: { prose: "extract" }, extract: { ratio: 0.3 } }  // aggressive
```
```rust
Config { extract_ratio_millis: 300, ..Config::default() }
```
```go
Config{ExtractRatioMillis: 300}
```

## `protect.lastTurns` (TS) / `protect_last_turns` (Rust) / `ProtectLastTurns` (Go)

The most recent N messages are **always** routed to `verbatim`, regardless of
`routing`. **Default: `2`.** `role === "system"` messages are *always*
protected too, unconditionally, independent of this setting. Set to `0` to
disable the recency protection (system messages are still exempt).

```ts
{ protect: { lastTurns: 4 } }
```
```rust
Config { protect_last_turns: 4, ..Config::default() }
```
```go
Config{ProtectLastTurns: 4}
```

## `strategies` — pre-compression filters, applied before classification/routing

Run in this order, before the threshold gate: **dedup**, then **purgeErrors**.

### `strategies.dedup` (TS) / `dedup` (Rust) / `DedupDisabled` (Go, inverted)

Drops later messages whose text content exactly duplicates an earlier one in
the *same call* (fresh tracker per call — no cross-call state). Messages
carrying `tool_use`/`tool_result` blocks are never deduped (dropping one would
orphan its paired block). **Default: `true`** (enabled).

```ts
{ strategies: { dedup: false } }
```
```rust
Config { dedup: false, ..Config::default() }   // inverted: `dedup: bool`
```
```go
Config{DedupDisabled: true}   // inverted field name in Go
```

### `strategies.purgeErrors` (TS) / `purge_errors_after_turns` (Rust, `Option`) / `PurgeErrorsAfterTurns` (Go, sentinel)

Replaces the content of `error`-classified messages older than N turns with
the placeholder `[errored output purged for context compaction]`. The fact
that an error occurred survives; the (often huge) traceback/output doesn't.
**Default: enabled, `afterTurns: 4`.**

```ts
{ strategies: { purgeErrors: { afterTurns: 2 } } }   // or `purgeErrors: false` to disable
```
```rust
Config { purge_errors_after_turns: Some(2), ..Config::default() }  // None disables
```
```go
Config{PurgeErrorsAfterTurns: 2}   // negative value disables; 0 means "use default (4)"
```

## `selfllm` — LLM-delegated summarization

An alternative to `extract`: sends the span's text to a real LLM with a fixed
compression prompt instead of running the local algorithm. Costs a real API
call per compressed span; use where quality matters more than latency/cost.
Available in TS as a routing target out of the box; in Rust/Go, construct
`SelfLlm`/`SelfLLM` directly (they need an HTTP transport you provide — see
each package's README).

| Field | Default | Notes |
|---|---|---|
| `provider` | `"anthropic"` | `"anthropic"` \| `"openai"` \| `"gemini"` |
| `model` | per-provider: `claude-haiku-4-5` / `gpt-4o-mini` / `gemini-2.5-flash` | Reasoning models get automatic handling: OpenAI `gpt-5*`/`o1`/`o3`/`o4` get `reasoning_effort: "minimal"`; Gemini `2.5+`/`3` get `thinkingBudget: 0`. Otherwise those families silently burn the output budget on hidden reasoning. |
| `apiKey` | reads `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` (TS only; Rust/Go require it explicitly) | |
| `ratio` | `0.3` | A **prompt hint** to the LLM ("compress to roughly N%"), not an enforced constraint like `extract.ratio`. |
| `maxSummaryTokens` | `500` | Passed as the completion's max-token budget. |
| `baseUrl` | provider's real API endpoint | Override for testing or a proxy. TS also accepts `fetchImpl` to inject a fake `fetch`. |

```ts
{ routing: { prose: "selfllm" }, selfllm: { provider: "openai", ratio: 0.2 } }
```

SelfLLM entirely replaces a compressed span with one summary message (role
taken from the first message in the span) rather than compressing in place —
different from `extract`, which preserves per-block structure.

## Minimal-client constructor options (TS only: `Anthropic`, `OpenAI`)

```ts
new Anthropic({ apiKey?, baseUrl?, leanpromptConfig?: LeanpromptConfig, fetchImpl? })
new OpenAI({ apiKey?, baseUrl?, leanpromptConfig?: LeanpromptConfig, fetchImpl? })
```
`apiKey` falls back to `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. `fetchImpl`
defaults to the global `fetch`; override it in tests.

## Integration entry points (TS)

- `leanpromptFetch(config, baseFetch?)` → a `fetch` you pass to your own
  official OpenAI/Anthropic SDK's constructor. Intercepts POSTs to
  `/chat/completions`, `/v1/messages`, `/messages`; annotates non-streaming
  JSON responses with `usage.leanpromptTokensSaved` / `leanpromptRatio` /
  `leanpromptMethod`; forwards everything else (including streams) untouched.
- `wrap(client, config)` → a `Proxy` over an existing client instance,
  duck-typed to intercept `chat.completions.create` / `messages.create`.
  Everything else on the client passes through unmodified.

## Everything at once (TS shape — Rust/Go fields are the same, flattened)

```ts
{
  mode: "on",
  trigger: { thresholdTokens: 1500 },
  routing: { prose: "extract", structured: "verbatim" },
  extract: { ratio: 0.4 },
  protect: { lastTurns: 3 },
  strategies: { dedup: true, purgeErrors: { afterTurns: 6 } },
  selfllm: { provider: "anthropic", model: "claude-haiku-4-5", ratio: 0.25 },
}
```
