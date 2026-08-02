import { describe, expect, test } from "bun:test";
import { Middleware } from "leanprompt";
import { compressSamplingMessages, compressToolResult, EXT_ID } from "../src/compress.js";

const LONG_PROSE =
    "The quarterly report shows revenue grew twelve percent year over year. " +
    "Customer churn dropped to four percent, the lowest in company history. " +
    "The support team closed eighteen hundred tickets last month alone. " +
    "Engineering shipped the new billing system three weeks ahead of schedule. " +
    "Marketing spend stayed flat while lead volume increased by a third. " +
    "The board asked for a follow-up analysis of the enterprise segment. " +
    "Finance flagged a small discrepancy in the March invoicing numbers. " +
    "Overall sentiment among the leadership team remains cautiously optimistic.";

function lowThresholdMiddleware(): Middleware {
    return new Middleware({
        mode: "on",
        routing: { prose: "extract" },
        trigger: { thresholdTokens: 5 },
        extract: { ratio: 0.3 },
        protect: { lastTurns: 0 },
    });
}

describe("compressToolResult", () => {
    test("compresses oversized text content and attaches stats", () => {
        const mw = lowThresholdMiddleware();
        const result = compressToolResult(
            { content: [{ type: "text", text: LONG_PROSE }] },
            mw,
        );

        const block = result.content[0] as { type: string; text: string };
        expect(block.text.length).toBeLessThan(LONG_PROSE.length);
        expect(result._meta?.[EXT_ID]).toBeDefined();
        const meta = result._meta![EXT_ID] as { tokensSaved: number };
        expect(meta.tokensSaved).toBeGreaterThan(0);
    });

    test("compresses the text block even when structuredContent is present, without touching structuredContent", () => {
        // Regression test: mirrors the real @modelcontextprotocol/server-filesystem
        // read_text_file shape, which returns structuredContent as a trivial
        // wrapper around the SAME text — not a distinct, "smarter" payload.
        const mw = lowThresholdMiddleware();
        const structuredContent = { content: LONG_PROSE };
        const result = compressToolResult(
            { content: [{ type: "text", text: LONG_PROSE }], structuredContent },
            mw,
        );

        const block = result.content[0] as { type: string; text: string };
        expect(block.text.length).toBeLessThan(LONG_PROSE.length);
        expect(result.structuredContent).toBe(structuredContent);
    });

    test("passes short content through without attaching stats", () => {
        const mw = new Middleware({
            mode: "on",
            routing: { prose: "extract" },
            trigger: { thresholdTokens: 2000 },
        });
        const original = { content: [{ type: "text", text: "short reply" }] };
        const result = compressToolResult(original, mw);
        expect(result._meta?.[EXT_ID]).toBeUndefined();
    });
});

describe("compressSamplingMessages", () => {
    test("compresses a single content-block message (not wrapped in an array)", () => {
        const mw = lowThresholdMiddleware();
        const [out, stats] = compressSamplingMessages(
            [{ role: "user", content: { type: "text", text: LONG_PROSE } }],
            mw,
        );

        const block = out[0]!.content as { type: string; text: string };
        expect(block.text.length).toBeLessThan(LONG_PROSE.length);
        expect(stats.outputTokens).toBeLessThan(stats.inputTokens);
    });
});
