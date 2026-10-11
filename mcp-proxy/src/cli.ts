#!/usr/bin/env node
/**
 * Usage:
 *   leanprompt-mcp-proxy [--threshold N] [--keep-ratio R] [--no-expand]
 *       [--expand-cache N] -- <command> [args...]
 *   leanprompt-mcp-proxy [...same flags] --url <http(s)://endpoint> [--header "Name: value"]...
 *
 * With `--`, everything after the separator is the real MCP server this proxy
 * spawns and wraps over stdio. With `--url`, the proxy fronts a remote
 * Streamable HTTP MCP endpoint instead; `--header` adds HTTP headers (e.g.
 * Authorization) to every upstream request.
 */

import { parseArgs, USAGE } from "./args.js";
import { runProxy } from "./proxy.js";

let config;
try {
    config = parseArgs(process.argv.slice(2));
} catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(USAGE);
    process.exit(1);
}

runProxy(config).catch((err) => {
    console.error("leanprompt-mcp-proxy failed:", err);
    process.exit(1);
});
