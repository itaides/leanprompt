# leanprompt-mcp-proxy

Wraps a real MCP server and compresses what actually gets big: oversized tool
results and outbound sampling requests. Everything else (`tools/list`,
resources, prompts) passes through untouched.

```
Claude Desktop ──stdio──▶ leanprompt-mcp-proxy ──stdio──▶ real MCP server
```

## What it compresses, and what it doesn't

| Path | Behavior |
|---|---|
| `tools/call` result, plain text content | Compressed with leanprompt's Extract algorithm above `--threshold` tokens |
| `tools/call` result also carrying `structuredContent` | The `content` text block is still compressed the same way; `structuredContent` itself is never touched (some tools, e.g. the official filesystem server's `read_text_file`, mirror the same text into `structuredContent` just to satisfy an outputSchema — skipping compression there would make the proxy a no-op on one of the most common, expensive MCP calls there is) |
| `tools/call` result from a task-augmented call | Left untouched at this point — it's a task handle (`{ task: {...} }`), not the real payload yet |
| `tasks/result` payload (a completed task's deferred result) | Compressed the same way as a direct `tools/call` result once it's actually retrieved |
| `tasks/get` (status/polling) | Passed straight through — no payload to compress |
| `sampling/createMessage` request (server → client) | Compressed the same way before being relayed to the connected client |

## Build

```bash
cd ts && npm run build   # leanprompt itself must be built first
cd ../mcp-proxy && npm install && npm run build
```

## Try it standalone

```bash
node dist/cli.js --threshold 2000 --keep-ratio 0.5 -- npx -y @modelcontextprotocol/server-filesystem /path/to/dir
```

Everything after `--` is the real MCP server command being wrapped.

## Use it in Claude Desktop

Edit Claude Desktop's config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS) and point `command`/`args` at the proxy instead of the real server directly, moving the real server's own command/args after `--`:

```json
{
  "mcpServers": {
    "filesystem-compressed": {
      "command": "node",
      "args": [
        "/absolute/path/to/leanprompt/mcp-proxy/dist/cli.js",
        "--threshold", "2000",
        "--keep-ratio", "0.5",
        "--",
        "npx", "-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"
      ]
    }
  }
}
```

Restart Claude Desktop, then check that the tool still works as expected. There's no UI indicator for compression — inspect `_meta["io.leanprompt/compression-stats"]` on a tool result (e.g. via Claude Desktop's MCP log output, or by calling the tool directly against the proxy with the SDK's `Client` for a quick manual check) to confirm it's firing.

## Verified end-to-end in Claude Desktop

The proxy was tested against the real `@modelcontextprotocol/server-filesystem`, both directly and wrapped, reading the same file through two separate Claude Desktop connectors in one chat:

| | `filesystem-raw-test` (no proxy) | `leanprompt-proxy-test` (wrapped) |
|---|---|---|
| File | `quarterly-report.txt` — one paragraph repeated 25× (padded test fixture) | same file |
| Text size returned | 14,075 chars (~3,519 est. tokens) | 561 chars (~140 est. tokens) |
| `_meta["io.leanprompt/compression-stats"]` | — | `{ tokensSaved: 3864, ratio: 0.04, method: "extract" }` |
| Content Claude read back | the paragraph, repeated 25× | the same paragraph, **deduplicated to a single copy** |
| Facts preserved | all | all — 12% revenue growth, 4% churn, 1,800 tickets, billing system 3 weeks early, flat marketing spend, +1/3 lead volume, board's follow-up request, finance's invoicing discrepancy, "cautiously optimistic" sentiment |

The size drop is mostly leanprompt's redundancy filter collapsing the 25 near-identical repeated sentences, not the extractive ratio alone — a realistic file without deliberate repetition will compress less dramatically, closer to the ~40–50% typically seen on prose-heavy content (see the main [README](../README.md#what-savings-to-expect--honest-math)).

## Limitations

- **No compression telemetry surfaces in Claude Desktop's UI.** `_meta["io.leanprompt/compression-stats"]` is attached to results, but MCP has no standard place for a client to display it — you won't see savings reported anywhere in the app itself.
- **Only helps with large tool outputs, task payloads, and sampling requests**, not the system prompt or the model's own accumulating conversation history — the biggest cost in a long session is untouched by this proxy.
- **`tasks/list` and `tasks/cancel` aren't proxied** — only the two methods that can carry a large payload (`tasks/get` for status, `tasks/result` for the deferred result) are handled.

## Test

```bash
npm test
```

Covers the pure compression logic in `src/compress.ts` (tool-result compression, compressing alongside a real `structuredContent` payload without touching it, and the sampling-message wrap/unwrap) — no live MCP connection required.
