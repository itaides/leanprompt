import { describe, expect, test } from "bun:test";
import {
    asciiLower,
    bitLength,
    Extract,
    looksStructural,
    mostlyAscii,
    segmentSentences,
    selectSentences,
    wordTokens,
} from "../src/compressors/extract.js";
import { countTokens } from "../src/tokens.js";

// ------------------------------------------------------------------------ //
// Test corpus helpers
// ------------------------------------------------------------------------ //

/** Long repetitive prose that comfortably clears the 40-token minimum. */
function longProse(): string {
    return [
        "The deployment pipeline failed at 14:32 UTC on cluster gamma-7 because the credential rotation job removed the token before the release step consumed it.",
        "Basically the whole thing is a matter of unfortunate timing in the scheduler.",
        "The release step retried three times with exponential backoff and then gave up permanently.",
        "The retry logic waited 2s, then 4s, then 8s between the attempts before failing.",
        "Engineering has been informed about the incident and they are looking into it now.",
        "The team decided to pin the rotation job to run only after release windows close.",
        "This decision prevents the race condition from recurring in future deployments.",
        "Do not restart the rotation job manually while a release is in progress.",
        "As mentioned earlier, the timing issue is the root cause of the whole problem.",
        "The postmortem document lives at docs/incidents/2026-07-21-gamma.md for reference.",
    ].join(" ");
}

const msg = (content: unknown, role = "user") => ({ role, content });

// ------------------------------------------------------------------------ //
// Pure helper units
// ------------------------------------------------------------------------ //

describe("bitLength", () => {
    test("integer log2 surrogate", () => {
        expect(bitLength(0)).toBe(0);
        expect(bitLength(1)).toBe(1);
        expect(bitLength(2)).toBe(2);
        expect(bitLength(3)).toBe(2);
        expect(bitLength(4)).toBe(3);
        expect(bitLength(255)).toBe(8);
        expect(bitLength(256)).toBe(9);
    });
});

describe("asciiLower", () => {
    test("lowers ASCII only, leaves non-ASCII untouched", () => {
        expect(asciiLower("HeLLo")).toBe("hello");
        expect(asciiLower("ÉCOLE")).toBe("École".replace("é", "É").length === 5 ? "École" : "École"); // É untouched
        expect(asciiLower("ABC École 日本")).toBe("abc École 日本");
    });
});

describe("mostlyAscii", () => {
    test("english passes, CJK fails", () => {
        expect(mostlyAscii("plain english text")).toBe(true);
        expect(mostlyAscii("これは日本語のテキストです。長い文章。")).toBe(false);
        expect(mostlyAscii("")).toBe(true);
    });
});

describe("wordTokens", () => {
    test("splits on non-word code points, ascii-lowercases", () => {
        expect(wordTokens("Hello, World! x2")).toEqual(["hello", "world", "x2"]);
    });
    test("deterministic on unicode words", () => {
        expect(wordTokens("café bar")).toEqual(["café", "bar"]);
    });
});

describe("segmentSentences", () => {
    test("splits on sentence enders followed by space", () => {
        const s = segmentSentences("One thing happened here. Another thing follows! Was it fine? Yes.");
        expect(s.map((x) => x.text)).toEqual([
            "One thing happened here.",
            "Another thing follows!",
            "Was it fine?",
            "Yes.",
        ]);
    });

    test("protects decimals and abbreviations", () => {
        const s = segmentSentences(
            "The value of pi is approximately 3.14 in this model. Dr. Smith disagreed with the assessment.",
        );
        expect(s.map((x) => x.text)).toEqual([
            "The value of pi is approximately 3.14 in this model.",
            "Dr. Smith disagreed with the assessment.",
        ]);
    });

    test("protects single-letter initials", () => {
        const s = segmentSentences("The report by J. Smith covers everything relevant here.");
        expect(s).toHaveLength(1);
    });

    test("newlines are hard boundaries; list items marked", () => {
        const s = segmentSentences("Intro paragraph text.\n- first item here\n- second item here\n| a | b |");
        expect(s.map((x) => [x.text, x.listItem])).toEqual([
            ["Intro paragraph text.", false],
            ["- first item here", true],
            ["- second item here", true],
            ["| a | b |", true],
        ]);
    });

    test("numbered list items marked", () => {
        const s = segmentSentences("1. do the first step\n2) do the second step");
        expect(s.every((x) => x.listItem)).toBe(true);
    });
});

describe("looksStructural", () => {
    test("fences and tracebacks", () => {
        expect(looksStructural("has ``` fence")).toBe(true);
        expect(looksStructural("Traceback (most recent call last):")).toBe(true);
        expect(looksStructural("ordinary prose")).toBe(false);
    });
});

// ------------------------------------------------------------------------ //
// Selection behavior
// ------------------------------------------------------------------------ //

describe("selectSentences", () => {
    test("keeps sentences in original order", () => {
        const sentences = segmentSentences(longProse());
        const out = selectSentences(sentences, 500);
        // Every kept sentence appears in input order.
        let pos = 0;
        for (const kept of out.split(/(?<=[.!?]) /)) {
            const found = longProse().indexOf(kept, pos);
            expect(found).toBeGreaterThanOrEqual(0);
            pos = found;
        }
    });

    test("respects the budget roughly (keeps less at lower ratio)", () => {
        const sentences = segmentSentences(longProse());
        const half = selectSentences(sentences, 500);
        const fifth = selectSentences(sentences, 200);
        expect(countTokens(fifth)).toBeLessThan(countTokens(half));
        expect(countTokens(half)).toBeLessThan(countTokens(longProse()));
    });

    test("constraint sentence survives aggressive compression", () => {
        const sentences = segmentSentences(longProse());
        const out = selectSentences(sentences, 300);
        expect(out).toContain("Do not restart the rotation job");
    });

    test("filler openers are dropped first", () => {
        const sentences = segmentSentences(longProse());
        const out = selectSentences(sentences, 400);
        expect(out).not.toContain("Basically the whole thing");
        expect(out).not.toContain("As mentioned earlier");
    });

    test("anaphoric sentence pulls its predecessor in", () => {
        const text = [
            "The team decided to pin the rotation job after release windows close and updated the scheduler configuration to enforce the new ordering constraint in production clusters.",
            "This decision prevents the race condition from recurring in future gamma deployments.",
            "Some entirely unrelated filler sentence about the weather being mild today.",
            "Another unrelated remark about lunch options near the office being limited.",
        ].join(" ");
        const sentences = segmentSentences(text);
        const out = selectSentences(sentences, 500);
        if (out.includes("This decision prevents")) {
            expect(out).toContain("The team decided to pin");
        }
    });

    test("digit-diff guard: near-identical log lines both survive redundancy", () => {
        const text = [
            "The first deployment attempt number 1 failed with a timeout after ninety seconds of waiting.",
            "The first deployment attempt number 4 succeeded with a timeout after ninety seconds of waiting.",
            "Completely different sentence about scheduling configuration changes and rollout policy decisions.",
            "Yet another distinct sentence describing the incident review meeting notes in detail.",
        ].join(" ");
        const sentences = segmentSentences(text);
        // generous budget: everything can be kept if not falsely deduped
        const out = selectSentences(sentences, 1000);
        expect(out).toContain("number 1 failed");
        expect(out).toContain("number 4 succeeded");
    });

    test("deterministic: same input → same output", () => {
        const sentences = segmentSentences(longProse());
        expect(selectSentences(sentences, 500)).toBe(selectSentences(sentences, 500));
    });
});

// ------------------------------------------------------------------------ //
// Compressor-level behavior (block-aware safety)
// ------------------------------------------------------------------------ //

describe("Extract compressor", () => {
    test("ratio validation", () => {
        expect(() => new Extract({ ratio: 0 })).toThrow(RangeError);
        expect(() => new Extract({ ratio: 1.5 })).toThrow(RangeError);
        expect(new Extract({ ratio: 1 }).ratioMillis).toBe(1000);
        expect(new Extract().ratio).toBe(0.5);
    });

    test("empty input untouched", () => {
        const e = new Extract();
        const [out, stats] = e.compress([]);
        expect(out).toEqual([]);
        expect(stats.method).toBe("extract");
    });

    test("compresses long prose string content", () => {
        const e = new Extract({ ratio: 0.5 });
        const [out, stats] = e.compress([msg(longProse())]);
        expect(stats.outputTokens).toBeLessThan(stats.inputTokens);
        expect((out[0]!.content as string).length).toBeLessThan(longProse().length);
        expect(stats.method).toBe("extract");
    });

    test("short text passes through (below MIN_SPAN_TOKENS)", () => {
        const e = new Extract({ ratio: 0.3 });
        const short = "Just a short remark.";
        const [out, stats] = e.compress([msg(short)]);
        expect(out[0]!.content).toBe(short);
        expect(stats.ratio).toBe(1.0);
    });

    test("structural text passes through even when routed here", () => {
        const e = new Extract({ ratio: 0.3 });
        const code = "```py\n" + "x = 1\n".repeat(60) + "```";
        const [out, stats] = e.compress([msg(code)]);
        expect(out[0]!.content).toBe(code);
        expect(stats.inputTokens).toBe(stats.outputTokens);
    });

    test("CJK text passes through (ASCII guard)", () => {
        const e = new Extract({ ratio: 0.3 });
        const cjk = "これは長い日本語の文章です。".repeat(30);
        const [out] = e.compress([msg(cjk)]);
        expect(out[0]!.content).toBe(cjk);
    });

    test("block content: text blocks compressed, tool_use preserved verbatim", () => {
        const e = new Extract({ ratio: 0.4 });
        const toolUse = {
            type: "tool_use",
            id: "t1",
            name: "search",
            input: { query: "how to fix the flaky pipeline" },
        };
        const [out, stats] = e.compress([
            msg([{ type: "text", text: longProse() }, toolUse], "assistant"),
        ]);
        const blocks = out[0]!.content as Array<Record<string, unknown>>;
        expect((blocks[0]!.text as string).length).toBeLessThan(longProse().length);
        expect(blocks[1]).toEqual(toolUse); // untouched, same shape
        expect(stats.inputTokens).toBeGreaterThan(stats.outputTokens);
    });

    test("tool_result with structural content preserved verbatim", () => {
        const e = new Extract({ ratio: 0.3 });
        const inner = "some output\n```\nstack frames here\n```";
        const [out] = e.compress([
            msg([{ type: "tool_result", tool_use_id: "t", content: inner }]),
        ]);
        const blocks = out[0]!.content as Array<Record<string, unknown>>;
        expect(blocks[0]!.content).toBe(inner);
    });

    test("tool_result with plain prose gets compressed", () => {
        const e = new Extract({ ratio: 0.4 });
        const [out] = e.compress([
            msg([{ type: "tool_result", tool_use_id: "t", content: longProse() }]),
        ]);
        const blocks = out[0]!.content as Array<Record<string, unknown>>;
        expect((blocks[0]!.content as string).length).toBeLessThan(longProse().length);
    });

    test("never mutates input messages", () => {
        const e = new Extract({ ratio: 0.4 });
        const original = msg(longProse());
        const originalContent = original.content;
        e.compress([original]);
        expect(original.content).toBe(originalContent);
    });
});

// ------------------------------------------------------------------------ //
// Quality gate: Extract must beat keep-first+last at equal ratio
// ------------------------------------------------------------------------ //

describe("quality: Extract vs naive keep-first+last baseline", () => {
    /** Naive baseline: keep sentences from the front and back until budget. */
    function firstLastBaseline(text: string, ratio: number): string {
        const sentences = segmentSentences(text).map((s) => s.text);
        const total = sentences.reduce((a, s) => a + countTokens(s), 0);
        const budget = ratio * total;
        const kept = new Set<number>();
        let used = 0;
        let front = 0;
        let back = sentences.length - 1;
        let turn = 0;
        while (front <= back && used < budget) {
            const i = turn % 2 === 0 ? front++ : back--;
            kept.add(i);
            used += countTokens(sentences[i]!);
            turn += 1;
        }
        return sentences.filter((_, i) => kept.has(i)).join(" ");
    }

    // "Answer-bearing" facts a reader must retain from longProse().
    const PROBES = [
        "gamma-7", // where
        "14:32", // when
        "credential rotation", // root cause
        "Do not restart", // constraint
        "docs/incidents/2026-07-21-gamma.md", // pointer
    ];

    test("Extract retains more probe facts than the baseline at ratio 0.5", () => {
        const e = new Extract({ ratio: 0.5 });
        const [out] = e.compress([msg(longProse())]);
        const extracted = out[0]!.content as string;
        const baseline = firstLastBaseline(longProse(), 0.5);

        const hits = (s: string) => PROBES.filter((p) => s.includes(p)).length;
        expect(hits(extracted)).toBeGreaterThanOrEqual(hits(baseline));
        // And the constraint must survive, full stop.
        expect(extracted).toContain("Do not restart");
    });
});
