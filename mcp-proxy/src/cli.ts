#!/usr/bin/env node
/**
 * Usage:
 *   leanprompt-mcp-proxy [--threshold N] [--keep-ratio R] [--no-expand]
 *       [--expand-cache N] -- <command> [args...]
 *
 * Everything after `--` is the real MCP server this proxy spawns and wraps.
 */

import { runProxy } from "./proxy.js";

function parseArgs(argv: string[]): {
    thresholdTokens: number;
    keepRatio: number;
    expandEnabled: boolean;
    expandCache: number | undefined;
    command: string;
    args: string[];
} {
    const sep = argv.indexOf("--");
    if (sep === -1 || sep === argv.length - 1) {
        console.error(
            "Usage: leanprompt-mcp-proxy [--threshold N] [--keep-ratio R] [--no-expand] [--expand-cache N] -- <command> [args...]",
        );
        process.exit(1);
    }

    const flags = argv.slice(0, sep);
    const [command, ...args] = argv.slice(sep + 1);

    let thresholdTokens = 2000;
    let keepRatio = 0.5;
    let expandEnabled = true;
    let expandCache: number | undefined;
    for (let i = 0; i < flags.length; i++) {
        if (flags[i] === "--threshold") {
            thresholdTokens = Number(flags[++i]);
        } else if (flags[i] === "--keep-ratio") {
            keepRatio = Number(flags[++i]);
        } else if (flags[i] === "--no-expand") {
            expandEnabled = false;
        } else if (flags[i] === "--expand-cache") {
            expandCache = Number(flags[++i]);
        }
    }

    return { thresholdTokens, keepRatio, expandEnabled, expandCache, command: command!, args };
}

const { thresholdTokens, keepRatio, expandEnabled, expandCache, command, args } =
    parseArgs(process.argv.slice(2));

runProxy({
    command,
    args,
    thresholdTokens,
    keepRatio,
    expand: { enabled: expandEnabled, maxEntries: expandCache },
}).catch((err) => {
    console.error("leanprompt-mcp-proxy failed:", err);
    process.exit(1);
});
