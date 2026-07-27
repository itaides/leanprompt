import { describe, expect, test } from "bun:test";
import { classify, hasToolLinkage, RepeatTracker } from "../src/classifier.js";
import { ContentType } from "../src/types.js";

const msg = (content: unknown, role = "user") => ({ role, content });

describe("classify", () => {
    test("empty content → UNKNOWN", () => {
        expect(classify(msg(""))).toBe(ContentType.UNKNOWN);
        expect(classify(msg("   \n  "))).toBe(ContentType.UNKNOWN);
        expect(classify(msg(null))).toBe(ContentType.UNKNOWN);
    });

    test("plain prose → PROSE", () => {
        expect(
            classify(msg("The quarterly report shows steady growth in all regions.")),
        ).toBe(ContentType.PROSE);
    });

    test("error markers → ERROR", () => {
        expect(
            classify(msg("Traceback (most recent call last):\n  File x.py")),
        ).toBe(ContentType.ERROR);
        expect(classify(msg("thread 'main' panicked at src/main.rs:12:5"))).toBe(
            ContentType.ERROR,
        );
        expect(classify(msg("Error: connection refused"))).toBe(ContentType.ERROR);
        expect(classify(msg("panic: runtime error in goroutine"))).toBe(
            ContentType.ERROR,
        );
    });

    test("fenced code block → CODE", () => {
        expect(classify(msg("Here:\n```py\nprint('hi')\n```"))).toBe(ContentType.CODE);
    });

    test("two code-prefix lines → CODE", () => {
        expect(classify(msg("import os\nfrom sys import path"))).toBe(
            ContentType.CODE,
        );
        expect(classify(msg("func main() {\npackage main"))).toBe(ContentType.CODE);
    });

    test("single code keyword in prose stays PROSE", () => {
        expect(classify(msg("the import statement is tricky to learn"))).toBe(
            ContentType.PROSE,
        );
    });

    test("ERROR beats CODE", () => {
        expect(
            classify(msg("```\nError: bad\n```")),
        ).toBe(ContentType.ERROR);
    });

    test("dense JSON blob → STRUCTURED", () => {
        const record = '{"id": 123, "name": "row", "status": "ok", "tags": ["a"]},';
        const blob = Array(20).fill(record).join("\n");
        expect(blob.length).toBeGreaterThanOrEqual(200);
        expect(classify(msg(blob))).toBe(ContentType.STRUCTURED);
    });

    test("short JSON snippet stays PROSE (density too noisy under 200 chars)", () => {
        expect(classify(msg('one setting: {"key": "value"} and nothing more here'))).toBe(
            ContentType.PROSE,
        );
    });

    test("prose with an occasional quoted colon stays PROSE", () => {
        const text =
            'She said the phrase "well then: onwards" and continued walking down the ' +
            "long road toward the village, noting the weather had turned colder than " +
            "expected for this time of year in the northern hills.";
        expect(classify(msg(text))).toBe(ContentType.PROSE);
    });
});

describe("RepeatTracker", () => {
    test("flags second occurrence of identical content", () => {
        const t = new RepeatTracker();
        expect(t.isRepeat(msg("same text"))).toBe(false);
        expect(t.isRepeat(msg("same text"))).toBe(true);
        expect(t.isRepeat(msg("same text"))).toBe(true);
    });

    test("role distinguishes identical text", () => {
        const t = new RepeatTracker();
        expect(t.isRepeat(msg("ok", "user"))).toBe(false);
        expect(t.isRepeat(msg("ok", "assistant"))).toBe(false);
        expect(t.isRepeat(msg("ok", "user"))).toBe(true);
    });

    test("empty content never flagged", () => {
        const t = new RepeatTracker();
        expect(t.isRepeat(msg(""))).toBe(false);
        expect(t.isRepeat(msg(""))).toBe(false);
    });

    test("tool-linkage messages never flagged", () => {
        const t = new RepeatTracker();
        const toolMsg = msg([
            { type: "tool_result", tool_use_id: "t1", content: "output" },
        ]);
        expect(t.isRepeat(toolMsg)).toBe(false);
        expect(t.isRepeat(toolMsg)).toBe(false);
    });

    test("reset clears memory", () => {
        const t = new RepeatTracker();
        t.isRepeat(msg("x"));
        t.reset();
        expect(t.isRepeat(msg("x"))).toBe(false);
    });
});

describe("hasToolLinkage", () => {
    test("detects tool_use and tool_result blocks", () => {
        expect(hasToolLinkage(msg([{ type: "tool_use", name: "f", input: {} }]))).toBe(true);
        expect(hasToolLinkage(msg([{ type: "tool_result", content: "x" }]))).toBe(true);
        expect(hasToolLinkage(msg([{ type: "text", text: "x" }]))).toBe(false);
        expect(hasToolLinkage(msg("string content"))).toBe(false);
    });
});
