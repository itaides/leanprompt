# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). `ts`/`rust` versions are kept
in lockstep (enforced by CI); Go has no manifest version and is released
via its own `go/vX.Y.Z` git tag.

## [Unreleased]

### Fixed
- `DedupStrategy` no longer drops messages with tool linkage beyond
  Anthropic `tool_use`/`tool_result` blocks: `tool`/`function` roles,
  `tool_calls`, `function_call`, and single-object block content now also
  mark a message as linked. Two identical OpenAI `role: "tool"` results are
  kept, so a dedup can no longer orphan a `tool_calls` entry (OpenAI 400).
- `PurgeErrorsStrategy` no longer purges `system` messages whose text
  merely contains an error marker.
- `PurgeErrorsStrategy` no longer flattens block-array `content` to the
  placeholder string. It now trims per block -- a `tool_result` keeps its
  shape, `tool_use_id`, and (for OpenAI tool messages) `tool_call_id`, so
  purging can no longer orphan a paired `tool_use` (Anthropic 400).
- `DedupStrategy`/`RepeatTracker` no longer hash `system` messages, so
  duplicate system prompts are kept.
- SelfLLM preserves message and block shape: string `content`, block arrays
  (including nested `tool_result` content), and single-object `content` are
  summarized in place instead of being replaced by a bare summary message.
  `tool_use`, `image`, `thinking` and unknown blocks plus all message/block
  fields (`tool_use_id`, `tool_call_id`, `name`, ...) survive untouched.
  Empty or non-shorter provider summaries now keep the original span instead
  of emitting empty or growing content.

### Changed
- Middleware pipeline order: the token count and threshold gate now run on
  the ORIGINAL message list, before strategies. Below-threshold calls
  return the input untouched (strategies no longer run), and
  `inputTokens`/`leanpromptTokensSaved` now include dedup/purge savings.
- SelfLLM `CompressionStats.inputTokens`/`outputTokens` are estimator counts
  of the span before/after compression, not provider-reported usage.
- SelfLLM (TS) defaults to `onError: "fallback"`: a provider or network
  error returns the original message unchanged with method
  `"selfllm-fallback"` and a single `console.warn`; `"throw"` keeps the old
  rejecting behavior. Provider requests now time out after `timeoutMs`
  (default 15000).
- `Middleware.compressMessagesAsync` runs per-message compressors
  concurrently and assembles results by index; output order is unchanged.

### Added
- `selfllm.timeoutMs` (TS): aborts the provider request after N ms.
- `selfllm.onError` (TS): `"fallback"` | `"throw"`.

## [0.2.0] — 2026-08-02

### Added
- [`mcp-proxy/`](mcp-proxy/README.md) — an MCP server wrapper compressing
  oversized `tools/call` results, deferred `tasks/result` payloads (2025-11-25
  spec's experimental durable tasks), and outbound `sampling/createMessage`
  requests, for Claude Desktop or any MCP client. `structuredContent`,
  `tools/list`, and everything else pass through untouched. Verified
  end-to-end against the real `@modelcontextprotocol/server-filesystem` in
  Claude Desktop, comparing a wrapped vs. unwrapped connector on the same
  file (25 repeated paragraphs → deduplicated to 1, all facts preserved).

### Changed
- [`ROADMAP.md`](ROADMAP.md) and the main README's Roadmap section: Claude
  Desktop support marked shipped (via `mcp-proxy`) instead of planned.

## [0.1.1] — 2026-08-02

### Fixed
- `leanpromptFetch` (TS) no longer touches the request/response body at
  all when compression is off (the default) — it now returns the caller's
  original `fetch` unwrapped instead of silently JSON-round-tripping every
  request regardless of config.
- Large integers outside the `messages` field (e.g. a `metadata` ID) no
  longer lose precision through a full-body JSON round-trip: only the
  `messages` field's bytes are rewritten in place, including when the key
  is JSON-escaped (`"messages"`) or duplicated at the top level.
- Reconstructed responses no longer carry stale `content-length`/
  `content-encoding` headers describing the old body.
- The token estimator charged CJK/Thai/Lao/Khmer/Myanmar text at the same
  per-character rate as space-delimited English, undercounting real BPE
  token usage by roughly 2-3x. Added a dedicated divisor for these
  scripts, ported identically across `ts`/`rust`/`go` with updated
  `parity/tokens.json` golden vectors.

### Added
- CI check that fails the build if `ts/package.json` and
  `rust/Cargo.toml` versions drift.
- [`ROADMAP.md`](ROADMAP.md) — planned support for Claude Desktop (via an
  MCP-server wiring path) and OpenAI Codex CLI.
- README caveats documenting `leanpromptFetch`'s path-suffix endpoint
  matching and the token estimator's per-script limits.

### Changed
- `ts` `peerDependencies` range for `@langchain/*` tightened from
  `>=0.3.0` to `>=1.0.0` to match what's actually tested in
  `devDependencies`.

## [0.1.0] — initial release

- Zero-dependency prompt compression in TypeScript, Rust, and Go, byte-
  identical across all three (asserted against `parity/*.json` golden
  vectors).
- Deterministic extractive compressor (`Extract`), classifier-gated
  pipeline, dedup/purge-errors strategies, `SelfLLM` LLM-delegated
  summarization.
- Fetch middleware and minimal OpenAI/Anthropic clients (TypeScript);
  bring-your-own-HTTP-client `Middleware` (Rust, Go).
- LangChain.js integration (`leanprompt/langchain`), zero core
  dependencies preserved via optional peer dependencies.
- `bench/` tooling: compression-quality-vs-baseline, cross-language
  consistency dashboard, real-workload measurement CLI.
- Publishing instructions in each package's README.
