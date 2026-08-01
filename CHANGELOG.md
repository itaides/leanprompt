# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). `ts`/`rust` versions are kept
in lockstep (enforced by CI); Go has no manifest version and is released
via its own `go/vX.Y.Z` git tag.

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
