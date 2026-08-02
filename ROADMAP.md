# Roadmap

Compression for more developer-facing AI tools, following the same
"wrap your own client's fetch" model already used for the OpenAI/Anthropic
SDKs and LangChain.js — no core changes, only new documented wiring paths:

- **Claude Desktop — shipped**, as [`mcp-proxy/`](mcp-proxy/README.md).
  Claude Desktop's own chat traffic still isn't interceptable — it's a
  closed-source client with no custom-fetch hook, so `leanprompt` can't sit
  in front of your conversations with Claude itself. What `mcp-proxy` does
  instead: wraps any MCP server as a transparent stdio proxy and compresses
  what actually gets big in that channel — oversized `tools/call` results,
  deferred `tasks/result` payloads, and outbound `sampling/createMessage`
  requests — while leaving `structuredContent`, `tools/list`, and everything
  else untouched. Verified end-to-end against the real
  `@modelcontextprotocol/server-filesystem` in Claude Desktop.
- **OpenAI Codex CLI** — investigate whether Codex CLI's request path
  (proxy / base-URL configuration) exposes a hook `leanpromptFetch` can sit
  behind, the same way `ChatOpenAI`/`ChatAnthropic`'s `configuration.fetch`
  does for the LangChain.js integration. Not yet verified against Codex
  CLI's actual extension surface — no compatibility claim until it's tested
  and documented.

This document tracks intent, not a committed timeline.
