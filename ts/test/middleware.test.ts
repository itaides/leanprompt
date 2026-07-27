import { describe, expect, test } from "bun:test";
import { Middleware } from "../src/middleware.js";

const msg = (content: unknown, role = "user") => ({ role, content });

/** Long prose paragraph (> 40 tokens) that the Extract compressor will cut. */
function prose(seed: string): string {
    return [
        `The ${seed} incident report describes a lengthy sequence of unfortunate events in production.`,
        "The scheduler fired the rotation job during an active release window on the gamma cluster.",
        "Basically this was all just terrible timing between two independent systems.",
        "The release step retried three times with exponential backoff and gave up.",
        "Engineering pinned the rotation job to run outside of release windows only.",
        "This change prevents the race condition from recurring in future deployments.",
        "The postmortem lives at docs/incidents/report.md for future reference purposes.",
    ].join(" ");
}

describe("Middleware gates", () => {
    test("mode off → passthrough, untouched", () => {
        const mw = new Middleware({ mode: "off" });
        const input = [msg(prose("alpha"))];
        const [out, stats] = mw.compressMessages(input);
        expect(out).toBe(input);
        expect(stats.method).toBe("passthrough");
    });

    test("default mode is off", () => {
        const mw = new Middleware({});
        const [, stats] = mw.compressMessages([msg("x")]);
        expect(stats.method).toBe("passthrough");
    });

    test("empty message list → empty method", () => {
        const mw = new Middleware({ mode: "on" });
        const [out, stats] = mw.compressMessages([]);
        expect(out).toEqual([]);
        expect(stats.method).toBe("empty");
    });

    test("below threshold → untouched with counted tokens", () => {
        const mw = new Middleware({
            mode: "on",
            trigger: { thresholdTokens: 100000 },
        });
        const input = [msg(prose("beta"))];
        const [out, stats] = mw.compressMessages(input);
        expect(out.map((m) => m.content)).toEqual(input.map((m) => m.content));
        expect(stats.method).toBe("below-threshold");
        expect(stats.inputTokens).toBeGreaterThan(0);
        expect(stats.outputTokens).toBe(stats.inputTokens);
    });
});

describe("Middleware routing + compression", () => {
    const config = {
        mode: "on" as const,
        trigger: { thresholdTokens: 10 },
        routing: { prose: "extract" },
        extract: { ratio: 0.5 },
        protect: { lastTurns: 0 },
    };

    test("prose routed to extract gets compressed", () => {
        const mw = new Middleware(config);
        const [out, stats] = mw.compressMessages([msg(prose("gamma"))]);
        expect(stats.method).toBe("extract");
        expect(stats.outputTokens).toBeLessThan(stats.inputTokens);
        expect((out[0]!.content as string).length).toBeLessThan(prose("gamma").length);
    });

    test("code/error/structured stay verbatim (hybrid method)", () => {
        const mw = new Middleware(config);
        const code = "```py\n" + "x = 1\n".repeat(30) + "```";
        const err = "Error: boom\n" + "at frame\n".repeat(30);
        const [out, stats] = mw.compressMessages([
            msg(prose("delta")),
            msg(code),
            msg(err),
        ]);
        expect(out[1]!.content).toBe(code);
        expect(out[2]!.content).toBe(err);
        expect(stats.method).toBe("hybrid"); // extract + verbatim mix
    });

    test("structured JSON never compressed even with prose→extract", () => {
        const mw = new Middleware(config);
        const record = '{"id": 1, "status": "ok", "name": "row", "tag": "x"},';
        const blob = Array(30).fill(record).join("\n");
        const [out] = mw.compressMessages([msg(prose("eps")), msg(blob)]);
        expect(out[1]!.content).toBe(blob);
    });

    test("unknown compressor name falls back to verbatim", () => {
        const mw = new Middleware({
            mode: "on",
            trigger: { thresholdTokens: 10 },
            routing: { prose: "nonexistent" },
            protect: { lastTurns: 0 },
        });
        const input = prose("zeta");
        const [out, stats] = mw.compressMessages([msg(input)]);
        expect(out[0]!.content).toBe(input);
        expect(stats.method).toBe("verbatim");
    });

    test("async variant matches sync", async () => {
        const mw = new Middleware(config);
        const input = [msg(prose("eta")), msg(prose("theta"))];
        const [syncOut, syncStats] = mw.compressMessages(input);
        const [asyncOut, asyncStats] = await mw.compressMessagesAsync(input);
        expect(asyncOut).toEqual(syncOut);
        expect(asyncStats).toEqual(syncStats);
    });
});

describe("Middleware protection rules", () => {
    test("system messages never compressed", () => {
        const mw = new Middleware({
            mode: "on",
            trigger: { thresholdTokens: 10 },
            routing: { prose: "extract" },
            protect: { lastTurns: 0 },
        });
        const sys = prose("system-rules");
        const [out] = mw.compressMessages([
            msg(sys, "system"),
            msg(prose("body")),
            msg(prose("body-two")),
        ]);
        expect(out[0]!.content).toBe(sys);
        expect((out[1]!.content as string).length).toBeLessThan(prose("body").length);
    });

    test("last K turns protected (default 2)", () => {
        const mw = new Middleware({
            mode: "on",
            trigger: { thresholdTokens: 10 },
            routing: { prose: "extract" },
        });
        const older = prose("older");
        const latest = prose("latest");
        const secondLatest = prose("second-latest");
        const [out] = mw.compressMessages([
            msg(older),
            msg(secondLatest),
            msg(latest),
        ]);
        expect((out[0]!.content as string).length).toBeLessThan(older.length);
        expect(out[1]!.content).toBe(secondLatest);
        expect(out[2]!.content).toBe(latest);
    });
});

describe("Middleware strategies integration", () => {
    test("dedup drops duplicate prose before compression", () => {
        const mw = new Middleware({
            mode: "on",
            trigger: { thresholdTokens: 10 },
            protect: { lastTurns: 0 },
        });
        const p = prose("dup");
        const [out] = mw.compressMessages([msg(p), msg(p), msg("unique tail here")]);
        expect(out).toHaveLength(2);
    });

    test("purge replaces old errors", () => {
        const mw = new Middleware({
            mode: "on",
            trigger: { thresholdTokens: 10 },
            strategies: { purgeErrors: { afterTurns: 1 } },
            protect: { lastTurns: 0 },
        });
        const [out] = mw.compressMessages([
            msg("Error: catastrophic failure with a very long message ".repeat(5)),
            msg(prose("tail-one")),
            msg(prose("tail-two")),
        ]);
        expect(out[0]!.content).toBe("[errored output purged for context compaction]");
    });

    test("strategies disabled via config", () => {
        const mw = new Middleware({
            mode: "on",
            trigger: { thresholdTokens: 10 },
            strategies: { dedup: false, purgeErrors: false },
            protect: { lastTurns: 0 },
        });
        const p = prose("nodedup");
        const [out] = mw.compressMessages([msg(p), msg(p)]);
        expect(out).toHaveLength(2);
    });
});
