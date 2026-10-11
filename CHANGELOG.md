# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). `ts`/`rust` versions are kept
in lockstep (enforced by CI); Go has no manifest version and is released
via its own `go/vX.Y.Z` git tag.

## [Unreleased]

**mcp-proxy** — new remote upstream mode: `leanprompt-mcp-proxy --url
<http(s)://endpoint>` fronts a Streamable HTTP MCP server (e.g. a hosted
gateway) instead of spawning a stdio command. `--header "Name: value"`
(repeatable) adds HTTP headers such as `Authorization` to every upstream
request; `--url` and `-- <command>` are mutually exclusive, and compression
flags behave identically in both modes.

### Added
- New `normalize` strategy — a lossless "level 0" cleanup that runs FIRST
  in the middleware pipeline (before dedup, so CRLF/ANSI variants of the
  same output dedup to one message). On by default in all three SDKs.
  `system` messages are never modified; which rules apply is gated by the
  message's classifier class computed on the original message:
  - N1 (all classes): `\r\n`/`\r` → `\n`.
  - N2 (all classes): ANSI escape removal (CSI, OSC, two-byte Fe).
  - N3 (prose only): strips U+200B/U+2060/U+FEFF — also closes a
    prompt-injection hiding channel; ZWNJ/ZWJ are kept.
  - N4 (prose only): collapses 3+ newline runs to exactly 2; markdown hard
    breaks survive.
  - N5 (structured only): lossless JSON whitespace minification for
    complete balanced values; malformed input passes through unchanged.
  Config: `strategies.normalize` / `{ json: false }` (TS),
  `normalize` / `normalize_json` (Rust), `NormalizeDisabled` /
  `NormalizeJSONDisabled` (Go). New golden vector file
  `parity/normalize.json`.

### Changed
- Extract marker matching now requires a word-start boundary (`do not` no
  longer fires inside `pseudo notation`, `never ` inside `whenever `,
  `always` inside `hallways`), and the quoted-span boost requires the
  opener to start at a word boundary and the closer to end at one, so
  apostrophes inside words (`don't`, `it's`) no longer score as quoted
  phrases.

**mcp-proxy 0.2.0** — the proxy is now transparent in both directions: the
downstream server advertises whatever capabilities the upstream server
reports (plus `tasks` and the `io.leanprompt/compression-stats`
experimental flag) and mirrors its `instructions`. `resources/*`,
`prompts/*`, `logging/setLevel`, `completion/complete`, `ping`, and
`roots/list` forward verbatim; upstream notifications (`tools`/`resources`/
`prompts` `list_changed`, `resources/updated`, `notifications/message`,
`notifications/progress`) reach the client, and the client's
`roots/list_changed` reaches upstream. Request cancellation propagates via
AbortSignals so `notifications/cancelled` reaches upstream with the correct
request id. `tools/call`, `tasks/get`, `tasks/result`, and
`sampling/createMessage` are compressed/handled exactly as before.

**mcp-proxy 0.3.0** — lossless by reference: every result the proxy
actually compresses now keeps its original `content` in a bounded
per-process store (256 entries / 64 MiB, LRU) and appends a `[leanprompt]`
note telling the model it was compressed, from how many tokens to how
many, and that it can recover the original by calling the new
`leanprompt_expand` tool with the quoted `ref`. The tool answers locally
(verbatim, never recompressed), is always listed in `tools/list` (the only
tool when the wrapped server exposes none), and returns `isError` for
unknown or evicted refs. `--no-expand` disables store + tool + note
entirely; `--expand-cache N` tunes the entry cap.

## [0.3.0] — 2026-10-11

This is a behavior-changing minor release: the middleware pipeline order,
Extract output shape, SelfLLM block handling, and RepeatTracker semantics
all changed, and the parity vectors were regenerated accordingly. Output
remains byte-identical across the TypeScript, Rust, and Go ports — see the
sections below for each change.

### Fixed
- ts `VERSION` constant had drifted to 0.1.0; now checked by CI.
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
- Go: `Config{}` now defaults `ProtectLastTurns` to 2, matching TypeScript
  and Rust (previously the zero value disabled recency protection). To
  protect nothing, set `ProtectLastTurnsDisabled: true`.

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
- Bench scripts iterate corpora in sorted order so `bench/results/` output
  is deterministic across filesystems.
- `mcp-proxy` reads its version from `src/version.ts` (`check-version` runs
  before tests) and `prepack` refuses to pack while `dependencies.leanprompt`
  is a `file:` link. Transitive dev/runtime advisories resolved via
  `npm audit fix`.
- Extract preserves line structure: selected sentences are emitted in
  original order separated by a space when they shared a source line, a
  blank line (`\n\n`) across paragraph breaks, and a single newline
  otherwise. Markdown lists, tables, and paragraph boundaries survive
  compression instead of being flattened onto one line.
- `RepeatTracker` keys on the exact `role|text` string instead of a
  SHA-256 digest; the TypeScript core no longer imports any Node builtins,
  so it runs in browsers and edge runtimes.

### Added
- `selfllm.timeoutMs` (TS): aborts the provider request after N ms.
- `selfllm.onError` (TS): `"fallback"` | `"throw"`.
- Contributor process: CONTRIBUTING.md, PR and issue templates, Dependabot,
  and hardened CI (format/lint/test/build/parity gates, `cargo fmt`
  enforcement, `mcp-proxy` in CI, version-sync checks).

**mcp-proxy 0.1.1** — version is now sourced from `src/version.ts` and
guarded by `check-version`; `prepack` refuses to publish with a `file:`
`leanprompt` dependency; the README gained a Publishing note and a
Limitations section listing the un-proxied MCP surface; `npm audit fix`
cleared the reported transitive advisories.

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
