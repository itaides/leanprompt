# Roadmap

Compression for more developer-facing AI tools, following the same
"wrap your own client's fetch" model already used for the OpenAI/Anthropic
SDKs and LangChain.js — no core changes, only new documented wiring paths:

- **Claude Desktop** — Claude Desktop's own chat traffic isn't
  interceptable: it's a closed-source client with no custom-fetch hook to
  wrap, so `leanprompt` can't sit in front of your conversations with
  Claude itself. What already works today, with zero new code: any MCP
  server you write in Node/Bun is just a regular subprocess, so if that
  server itself calls out to an LLM provider (a tool that hits OpenAI or
  Anthropic as part of its own logic), it can use `leanpromptFetch` exactly
  like any other JS/Bun app. Planned: a documented, runnable MCP-server
  example wiring this up end-to-end.
- **OpenAI Codex CLI** — investigate whether Codex CLI's request path
  (proxy / base-URL configuration) exposes a hook `leanpromptFetch` can sit
  behind, the same way `ChatOpenAI`/`ChatAnthropic`'s `configuration.fetch`
  does for the LangChain.js integration. Not yet verified against Codex
  CLI's actual extension surface — no compatibility claim until it's tested
  and documented.

This document tracks intent, not a committed timeline.
