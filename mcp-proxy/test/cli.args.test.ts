import { describe, expect, test } from "bun:test";

import { parseArgs } from "../src/args.js";

describe("parseArgs", () => {
    test("stdio upstream: command and args after --", () => {
        const cfg = parseArgs(["--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"]);
        expect(cfg.upstream).toEqual({
            type: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        });
        expect(cfg.thresholdTokens).toBe(2000);
        expect(cfg.keepRatio).toBe(0.5);
    });

    test("--threshold and --keep-ratio apply in both modes", () => {
        const stdio = parseArgs(["--threshold", "10", "--keep-ratio", "0.25", "--", "srv"]);
        expect(stdio.thresholdTokens).toBe(10);
        expect(stdio.keepRatio).toBe(0.25);
        const http = parseArgs(["--threshold", "10", "--keep-ratio", "0.25", "--url", "https://x.example/mcp"]);
        expect(http.thresholdTokens).toBe(10);
        expect(http.keepRatio).toBe(0.25);
    });

    test("--url accepts http and https", () => {
        for (const raw of ["http://127.0.0.1:8080/mcp", "https://gateway.example.com/mcp"]) {
            const cfg = parseArgs(["--url", raw]);
            expect(cfg.upstream.type).toBe("http");
            expect((cfg.upstream as { url: URL }).url.href).toBe(new URL(raw).href);
            expect((cfg.upstream as { headers: Record<string, string> }).headers).toEqual({});
        }
    });

    test("--header is repeatable and splits on the first colon", () => {
        const cfg = parseArgs([
            "--url", "https://gateway.example.com/mcp",
            "--header", "Authorization: Bearer tok:en",
            "--header", "X-Tenant:acme",
        ]);
        expect(cfg.upstream.type).toBe("http");
        expect((cfg.upstream as { headers: Record<string, string> }).headers).toEqual({
            Authorization: "Bearer tok:en",
            "X-Tenant": "acme",
        });
    });

    test("errors when neither upstream is given", () => {
        expect(() => parseArgs([])).toThrow(/exactly one upstream/);
        expect(() => parseArgs(["--threshold", "5"])).toThrow(/exactly one upstream/);
        expect(() => parseArgs(["--"])).toThrow(/command after/);
        expect(() => parseArgs(["--url", "https://x.example/mcp", "--"])).toThrow(/command after/);
    });

    test("--url and -- <command> are mutually exclusive", () => {
        expect(() => parseArgs(["--url", "https://x.example/mcp", "--", "srv"])).toThrow(/mutually exclusive/);
    });

    test("--header requires --url", () => {
        expect(() => parseArgs(["--header", "A: b", "--", "srv"])).toThrow(/requires `--url`/);
        expect(() => parseArgs(["--header", "A: b"])).toThrow(/requires `--url`/);
    });

    test("--url must be a valid http(s) URL", () => {
        expect(() => parseArgs(["--url", "not-a-url"])).toThrow(/not a valid URL/);
        expect(() => parseArgs(["--url", "ftp://x.example/mcp"])).toThrow(/http:\/\/ or https:\/\//);
        expect(() => parseArgs(["--url", "ws://x.example/mcp"])).toThrow(/http:\/\/ or https:\/\//);
        expect(() => parseArgs(["--url"])).toThrow(/requires a value/);
    });

    test("malformed flags error clearly", () => {
        expect(() => parseArgs(["--header", "no-colon", "--url", "https://x/mcp"])).toThrow(/Name: value/);
        expect(() => parseArgs(["--header", ": v", "--url", "https://x/mcp"])).toThrow(/Name: value/);
        expect(() => parseArgs(["--url", "https://x/mcp", "--header"])).toThrow(/requires a value/);
        expect(() => parseArgs(["--threshold", "abc", "--", "srv"])).toThrow(/expects a number/);
        expect(() => parseArgs(["--bogus", "--", "srv"])).toThrow(/unknown option/);
    });
});
