# Roadmap

Where leanprompt goes next, roughly in order. The two invariants — zero
runtime dependencies, byte-identical output across TypeScript/Rust/Go —
apply to everything below.

## Compression quality

- **Intent-conditioned extraction.** Extract currently scores sentences
  generically. An optional "focus" input (the calling `tool_use.input`, or
  the last user message) would boost sentences sharing rare terms with
  what the agent was actually trying to do — query-aware pruning is the
  main quality lever the research (Squeez et al.) shows. Stays
  deterministic and integer-only; spec + vectors + all three ports.
- **Needle-retention benchmark.** The benches measure token savings and
  coverage proxies; they don't answer "did we keep the one fact that
  mattered." A planted-fact retention suite over both corpora, reported
  with confidence intervals, is the number skeptics ask for.
- **Token-budget mode.** `tokenCounter` (0.4.0) makes this cheap: instead
  of a keep-ratio, "fit the history to N tokens, compress oldest tool
  results first" — closer to how people actually think about context
  windows.

## mcp-proxy

- **`resources/read` contents.** Large resource contents are a real token
  sink the proxy currently passes verbatim; same pattern as
  `compressToolResult` + `leanprompt_expand`.
- **Tool-schema trimming.** `tools/list` passes verbatim, but verbose
  descriptions and bloated `inputSchema`s are the "MCP context" line item
  every gateway dashboard flags. A conservative shortener here is
  proxy-only work — no parity impact.
- **Output-format option.** The `normalize` N5 minifier already gives
  "JSON Compact" for free; converting tool-result JSON to CSV/YAML where
  safe is a plausible `--format` knob. TOON is interesting but too young
  to pin to yet.

## New wiring paths

Same model as the OpenAI/Anthropic SDKs and LangChain.js — wrap the
client's fetch, no core changes:

- **OpenAI Codex CLI** — investigate whether Codex CLI's request path
  (proxy / base-URL configuration) exposes a hook `leanpromptFetch` can
  sit behind. Not yet verified against its actual extension surface — no
  compatibility claim until tested and documented.
- **Python SDK** — the biggest gap. The agent ecosystem is Python-first
  and a fourth parity implementation is a real commitment (spec + vectors
  + test suite + release machinery). Open question: is there enough
  demand to justify it? Gauge via GitHub Discussions before starting.

## Enterprise / gateway integration

With `--url`/`--header` (mcp-proxy 0.4.0) the proxy sits in front of any
hosted MCP endpoint, including governed gateways like Willow — Willow
audits the full response, the agent gets the compressed copy plus an
`expand` ref. Remaining work here is packaging and outreach, not code:
marketplace/plugin listings, and pitching leanprompt as the execution
layer behind gateway "optimize" recommendations.

This document tracks intent, not a committed timeline.
