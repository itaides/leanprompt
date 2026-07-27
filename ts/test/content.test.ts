import { describe, expect, test } from "bun:test";
import { canonicalJson, extractText, getTextContent } from "../src/content.js";

describe("getTextContent", () => {
    test("plain string content", () => {
        expect(getTextContent({ role: "user", content: "hello" })).toBe("hello");
    });

    test("empty and missing content", () => {
        expect(getTextContent({ role: "user", content: "" })).toBe("");
        expect(getTextContent({ role: "user", content: null })).toBe("");
        expect(getTextContent({ role: "user", content: undefined })).toBe("");
    });

    test("list of text blocks joined with newline", () => {
        const msg = {
            role: "user",
            content: [
                { type: "text", text: "one" },
                { type: "text", text: "two" },
            ],
        };
        expect(getTextContent(msg)).toBe("one\ntwo");
    });

    test("tool_use serializes input with name prefix", () => {
        const msg = {
            role: "assistant",
            content: [
                { type: "tool_use", name: "grep", input: { query: "foo", limit: 10 } },
            ],
        };
        expect(getTextContent(msg)).toBe('[tool_use grep] {"limit":10,"query":"foo"}');
    });

    test("tool_use with string input, no name", () => {
        const msg = {
            role: "assistant",
            content: [{ type: "tool_use", input: "raw arg" }],
        };
        expect(getTextContent(msg)).toBe("raw arg");
    });

    test("tool_result with nested blocks recurses", () => {
        const msg = {
            role: "user",
            content: [
                {
                    type: "tool_result",
                    tool_use_id: "t1",
                    content: [
                        { type: "text", text: "inner one" },
                        { type: "text", text: "inner two" },
                    ],
                },
            ],
        };
        expect(getTextContent(msg)).toBe("inner one\ninner two");
    });

    test("tool_result with string content", () => {
        const msg = {
            role: "user",
            content: [{ type: "tool_result", content: "plain output" }],
        };
        expect(getTextContent(msg)).toBe("plain output");
    });

    test("document block: text, source.data, nested content fallbacks", () => {
        expect(
            extractText([{ type: "document", text: "doc text" }]),
        ).toBe("doc text");
        expect(
            extractText([{ type: "document", source: { data: "src data" } }]),
        ).toBe("src data");
        expect(
            extractText([
                { type: "document", content: [{ type: "text", text: "nested" }] },
            ]),
        ).toBe("nested");
    });

    test("image/thinking/unknown blocks contribute nothing", () => {
        const msg = {
            role: "user",
            content: [
                { type: "image", source: { data: "base64..." } },
                { type: "thinking", thinking: "private" },
                { type: "mystery_block", payload: "??" },
                { type: "text", text: "visible" },
            ],
        };
        expect(getTextContent(msg)).toBe("visible");
    });

    test("single block wrapped in object (not list)", () => {
        expect(extractText({ type: "text", text: "solo" })).toBe("solo");
    });

    test("malformed blocks degrade to empty, not throw", () => {
        expect(extractText([null, 42, "str-item", {}, { type: "text" }])).toBe("");
    });

    test("unicode text passes through unchanged", () => {
        expect(getTextContent({ role: "user", content: "héllo wörld — 日本語" })).toBe(
            "héllo wörld — 日本語",
        );
    });
});

describe("canonicalJson", () => {
    test("sorts object keys lexicographically", () => {
        expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    });

    test("nested structures", () => {
        expect(canonicalJson({ z: [1, { y: "x", a: true }], b: null })).toBe(
            '{"b":null,"z":[1,{"a":true,"y":"x"}]}',
        );
    });

    test("compact separators, no spaces", () => {
        const out = canonicalJson({ k: [1, 2, 3] });
        expect(out).not.toContain(" ");
    });

    test("non-ASCII preserved", () => {
        expect(canonicalJson({ msg: "日本語" })).toBe('{"msg":"日本語"}');
    });
});
