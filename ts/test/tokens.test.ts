import { describe, expect, test } from "bun:test";
import { countMessageTokens, countTokens } from "../src/tokens.js";

describe("countTokens", () => {
    test("empty string → 0", () => {
        expect(countTokens("")).toBe(0);
    });

    test("single short word → 1", () => {
        expect(countTokens("hi")).toBe(1);
    });

    test("long word splits into multiple tokens", () => {
        // 16 chars → ceil(16/4) = 4
        expect(countTokens("internationaliza")).toBe(4);
    });

    test("punctuation counts", () => {
        expect(countTokens("a, b.")).toBe(4); // a + , + b + .
    });

    test("prose lands in a plausible range (~1 token per short word)", () => {
        const text = "the quick brown fox jumps over the lazy dog";
        const n = countTokens(text);
        expect(n).toBeGreaterThanOrEqual(9);
        expect(n).toBeLessThanOrEqual(12);
    });

    test("deterministic", () => {
        const text = "Some repeated text with numbers 12345 and symbols !@#";
        expect(countTokens(text)).toBe(countTokens(text));
    });

    test("scales roughly linearly", () => {
        const unit = "a sentence with some reasonable words here. ";
        const one = countTokens(unit);
        const ten = countTokens(unit.repeat(10));
        expect(ten).toBeGreaterThanOrEqual(one * 9);
        expect(ten).toBeLessThanOrEqual(one * 11);
    });
});

describe("countMessageTokens", () => {
    test("sums across messages", () => {
        const messages = [
            { role: "user", content: "hello world" },
            { role: "assistant", content: "hi there" },
        ];
        expect(countMessageTokens(messages)).toBe(
            countTokens("hello world") + countTokens("hi there"),
        );
    });

    test("includes tool_use input text", () => {
        const messages = [
            {
                role: "assistant",
                content: [{ type: "tool_use", name: "run", input: { cmd: "ls -la" } }],
            },
        ];
        expect(countMessageTokens(messages)).toBeGreaterThan(0);
    });

    test("empty list → 0", () => {
        expect(countMessageTokens([])).toBe(0);
    });
});
