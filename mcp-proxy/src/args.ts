/**
 * CLI argument parsing for leanprompt-mcp-proxy.
 *
 * Two upstream modes, exactly one required:
 *   -- <command> [args...]    spawn and wrap a stdio MCP server
 *   --url <http(s)://...>     wrap a remote Streamable HTTP MCP endpoint,
 *                             optionally with repeatable --header "Name: value"
 */

import type { ProxyConfig } from "./proxy.js";

export const USAGE =
    "Usage: leanprompt-mcp-proxy [--threshold N] [--keep-ratio R] [--no-expand] [--expand-cache N] -- <command> [args...]\n" +
    '       leanprompt-mcp-proxy [same flags] --url <http(s)://endpoint> [--header "Name: value"]...';

export function parseArgs(argv: string[]): ProxyConfig {
    const sep = argv.indexOf("--");
    const flags = sep === -1 ? argv : argv.slice(0, sep);
    const command = sep === -1 ? [] : argv.slice(sep + 1);

    if (sep !== -1 && command.length === 0) {
        throw new Error("expected a command after `--`");
    }

    let thresholdTokens = 2000;
    let keepRatio = 0.5;
    let urlArg: string | undefined;
    let expandEnabled = true;
    let expandCache: number | undefined;
    const headers: Record<string, string> = {};

    const flagValue = (i: number): string => {
        const v = flags[i + 1];
        if (v === undefined) {
            throw new Error(`${flags[i]} requires a value`);
        }
        return v;
    };

    for (let i = 0; i < flags.length; i++) {
        const flag = flags[i]!;
        if (flag === "--threshold") {
            thresholdTokens = Number(flagValue(i));
            if (!Number.isFinite(thresholdTokens)) {
                throw new Error(`--threshold expects a number, got "${flags[i + 1]}"`);
            }
            i++;
        } else if (flag === "--keep-ratio") {
            keepRatio = Number(flagValue(i));
            if (!Number.isFinite(keepRatio)) {
                throw new Error(`--keep-ratio expects a number, got "${flags[i + 1]}"`);
            }
            i++;
        } else if (flag === "--url") {
            urlArg = flagValue(i);
            i++;
        } else if (flag === "--header") {
            const raw = flagValue(i);
            const colon = raw.indexOf(":");
            if (colon === -1 || raw.slice(0, colon).trim() === "") {
                throw new Error(`--header expects "Name: value", got "${raw}"`);
            }
            headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
            i++;
        } else if (flag === "--no-expand") {
            expandEnabled = false;
        } else if (flag === "--expand-cache") {
            expandCache = Number(flagValue(i));
            if (!Number.isFinite(expandCache)) {
                throw new Error(`--expand-cache expects a number, got "${flags[i + 1]}"`);
            }
            i++;
        } else if (flag.startsWith("--")) {
            throw new Error(`unknown option ${flag}`);
        }
    }

    if (urlArg !== undefined && command.length > 0) {
        throw new Error("`--url` and `-- <command>` are mutually exclusive — pick one upstream");
    }
    if (urlArg === undefined && Object.keys(headers).length > 0) {
        throw new Error("`--header` requires `--url`");
    }
    if (urlArg === undefined && command.length === 0) {
        throw new Error("exactly one upstream is required: `-- <command>` or `--url <endpoint>`");
    }

    const expand = { enabled: expandEnabled, maxEntries: expandCache };
    if (urlArg === undefined) {
        return {
            upstream: { type: "stdio", command: command[0]!, args: command.slice(1) },
            thresholdTokens,
            keepRatio,
            expand,
        };
    }

    let url: URL;
    try {
        url = new URL(urlArg);
    } catch {
        throw new Error(`--url is not a valid URL: "${urlArg}"`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`--url must be an http:// or https:// URL, got "${urlArg}"`);
    }
    return { upstream: { type: "http", url, headers }, thresholdTokens, keepRatio, expand };
}
