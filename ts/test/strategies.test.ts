import { describe, expect, test } from "bun:test";
import {
    DedupStrategy,
    NormalizeStrategy,
    PurgeErrorsStrategy,
} from "../src/strategies.js";

const msg = (content: unknown, role = "user") => ({ role, content });

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);
const ZWSP = String.fromCodePoint(0x200b);
const WJ = String.fromCodePoint(0x2060);
const BOM = String.fromCodePoint(0xfeff);
const ZWNJ = String.fromCodePoint(0x200c);
const ZWJ = String.fromCodePoint(0x200d);

/** A JSON blob long/dense enough to classify STRUCTURED. */
function prettyJson(entries = 12): string {
    const lines = Array.from(
        { length: entries },
        (_, i) => `  "key${String(i).padStart(2, "0")}": "value ${i}"`,
    );
    return `{\n${lines.join(",\n")},\n  "big": 12345678901234567890\n}`;
}

describe("DedupStrategy", () => {
    test("drops later duplicates, keeps first", () => {
        const s = new DedupStrategy();
        const out = s.apply([msg("a"), msg("b"), msg("a"), msg("c"), msg("b")]);
        expect(out.map((m) => m.content)).toEqual(["a", "b", "c"]);
    });

    test("state is per-call: same input twice gives same output", () => {
        const s = new DedupStrategy();
        const input = [msg("x"), msg("y")];
        expect(s.apply(input)).toHaveLength(2);
        expect(s.apply(input)).toHaveLength(2); // NOT dropped on the second call
    });

    test("never drops tool-linkage messages even when identical", () => {
        const s = new DedupStrategy();
        const tool = () =>
            msg([{ type: "tool_result", tool_use_id: "t", content: "same" }]);
        const out = s.apply([tool(), tool()]);
        expect(out).toHaveLength(2);
    });

    test("never drops OpenAI tool-role messages even when identical", () => {
        const s = new DedupStrategy();
        const tool = (id: string) => ({
            role: "tool",
            tool_call_id: id,
            content: "same output",
        });
        const out = s.apply([tool("a"), tool("b")]);
        expect(out).toHaveLength(2);
        expect(out.map((m) => m.tool_call_id)).toEqual(["a", "b"]);
    });

    test("never drops assistant tool_calls / function_call messages", () => {
        const s = new DedupStrategy();
        const call = () => ({
            role: "assistant",
            content: null,
            tool_calls: [
                { id: "x", type: "function", function: { name: "ls", arguments: "{}" } },
            ],
        });
        const fn = () => ({
            role: "assistant",
            content: "",
            function_call: { name: "grep", arguments: "{}" },
        });
        expect(s.apply([call(), call()])).toHaveLength(2);
        expect(s.apply([fn(), fn()])).toHaveLength(2);
    });

    test("never drops single-object tool blocks or system messages", () => {
        const s = new DedupStrategy();
        const single = () =>
            msg({ type: "tool_result", tool_use_id: "t", content: "same" });
        expect(s.apply([single(), single()])).toHaveLength(2);
        const sys = () => msg("same rules", "system");
        expect(s.apply([sys(), sys()])).toHaveLength(2);
    });

    test("role-distinct duplicates survive", () => {
        const s = new DedupStrategy();
        const out = s.apply([msg("ok", "user"), msg("ok", "assistant")]);
        expect(out).toHaveLength(2);
    });
});

describe("PurgeErrorsStrategy", () => {
    const err = () => msg("Error: something broke very badly");
    const ok = (i: number) => msg(`normal message ${i}`);

    test("short conversations untouched", () => {
        const s = new PurgeErrorsStrategy(4);
        const input = [err(), ok(1), ok(2), ok(3)];
        expect(s.apply(input)).toEqual(input);
    });

    test("old errors purged, recent errors kept", () => {
        const s = new PurgeErrorsStrategy(2);
        const input = [err(), ok(1), ok(2), err(), ok(3)];
        const out = s.apply(input);
        // cutoff = 5 - 2 = 3 → indexes 0..2 purge-eligible
        expect(out[0]!.content).toBe("[errored output purged for context compaction]");
        expect(out[3]!.content).toBe((err() as { content: string }).content);
        expect(out[1]).toEqual(ok(1));
    });

    test("does not mutate original messages", () => {
        const s = new PurgeErrorsStrategy(1);
        const original = err();
        s.apply([original, ok(1), ok(2)]);
        expect(original.content).toContain("Error:");
    });

    test("system messages are never purged", () => {
        const s = new PurgeErrorsStrategy(2);
        const sys = msg("You are a helpful agent. If a tool returns 'Error: not found', retry.", "system");
        const out = s.apply([sys, ok(1), ok(2), ok(3)]);
        expect(out[0]).toBe(sys);
    });

    test("block-array content keeps its shape: only errored blocks are purged", () => {
        const s = new PurgeErrorsStrategy(2);
        const m = msg([
            { type: "tool_result", tool_use_id: "t1", content: "Error: build failed with a large log" },
            { type: "text", text: "fine" },
        ]);
        const out = s.apply([m, ok(1), ok(2), ok(3)]);
        const content = out[0]!.content as Array<Record<string, unknown>>;
        expect(Array.isArray(content)).toBe(true);
        expect(content[0]).toEqual({
            type: "tool_result",
            tool_use_id: "t1",
            content: "[errored output purged for context compaction]",
        });
        expect(content[1]).toEqual({ type: "text", text: "fine" });
    });

    test("nested tool_result block-array content is purged per block", () => {
        const s = new PurgeErrorsStrategy(2);
        const m = msg([
            {
                type: "tool_result",
                tool_use_id: "t2",
                content: [
                    { type: "text", text: "ERROR: boom while compiling" },
                    { type: "text", text: "ok" },
                ],
            },
        ]);
        const out = s.apply([m, ok(1), ok(2), ok(3)]);
        const inner = (out[0]!.content as Array<Record<string, unknown>>)[0]!
            .content as Array<Record<string, unknown>>;
        expect(inner[0]!.text).toBe("[errored output purged for context compaction]");
        expect(inner[1]).toEqual({ type: "text", text: "ok" });
    });

    test("tool-role string error purged, tool_call_id preserved", () => {
        const s = new PurgeErrorsStrategy(2);
        const m = { role: "tool", tool_call_id: "call_1", content: "Error: timed out" };
        const out = s.apply([m, ok(1), ok(2), ok(3)]);
        expect(out[0]).toEqual({
            role: "tool",
            tool_call_id: "call_1",
            content: "[errored output purged for context compaction]",
        });
    });

    test("single-object block content is purged via purgeBlock", () => {
        const s = new PurgeErrorsStrategy(2);
        const m = msg({ type: "tool_result", tool_use_id: "t3", content: "Error: single block" });
        const out = s.apply([m, ok(1), ok(2), ok(3)]);
        expect(out[0]!.content).toEqual({
            type: "tool_result",
            tool_use_id: "t3",
            content: "[errored output purged for context compaction]",
        });
    });
});

describe("NormalizeStrategy", () => {
    const norm = (content: unknown, role = "user", s = new NormalizeStrategy()) =>
        s.apply([msg(content, role)])[0]!;

    describe("N1 line endings", () => {
        test("CRLF and lone CR become LF", () => {
            expect(norm("a\r\nb\rc\nd").content).toBe("a\nb\nc\nd");
        });
    });

    describe("N2 ANSI escapes", () => {
        test("CSI color codes", () => {
            expect(norm(`${ESC}[31mred${ESC}[0m plain`).content).toBe("red plain");
        });

        test("CSI with params, intermediates and final", () => {
            expect(norm(`a${ESC}[1;2Hb`).content).toBe("ab");
            expect(norm(`a${ESC}[?25lb`).content).toBe("ab");
            expect(norm(`a${ESC}[!pb`).content).toBe("ab");
        });

        test("OSC terminated by BEL", () => {
            expect(norm(`a${ESC}]0;title${BEL}b`).content).toBe("ab");
        });

        test("OSC terminated by ST", () => {
            expect(norm(`a${ESC}]0;title${ESC}\\b`).content).toBe("ab");
        });

        test("unterminated OSC removed through end of span", () => {
            expect(norm(`a${ESC}]0;payload`).content).toBe("a");
        });

        test("ESC inside OSC payload not followed by backslash is payload", () => {
            expect(norm(`a${ESC}]8;;x${ESC}y${BEL}b`).content).toBe("ab");
        });

        test("two-byte Fe sequences", () => {
            expect(norm(`a${ESC}Pb`).content).toBe("ab");
            expect(norm(`${ESC}\\`).content).toBe("");
        });

        test("malformed CSI and other ESC uses stay", () => {
            expect(norm(`a${ESC}[31`).content).toBe(`a${ESC}[31`);
            expect(norm(`a${ESC}(B`).content).toBe(`a${ESC}(B`);
            expect(norm(`a${ESC}`).content).toBe(`a${ESC}`);
        });
    });

    describe("N3 invisible characters (prose only)", () => {
        test("ZWSP, WJ and ZWNBSP are removed", () => {
            expect(norm(`a${ZWSP}b${WJ}c${BOM}d`).content).toBe("abcd");
        });

        test("ZWNJ and ZWJ are kept", () => {
            expect(norm(`a${ZWNJ}b${ZWJ}c`).content).toBe(`a${ZWNJ}b${ZWJ}c`);
        });
    });

    describe("N4 blank-line collapse (prose only)", () => {
        test("3+ newlines collapse to 2", () => {
            expect(norm("a\n\n\n\nb").content).toBe("a\n\nb");
        });

        test("whitespace-only lines count as empty", () => {
            expect(norm("a\n  \n \t\nb").content).toBe("a\n\nb");
        });

        test("markdown hard break survives", () => {
            expect(norm("a  \n\n\nb").content).toBe("a  \n\nb");
        });

        test("single blank line stays", () => {
            expect(norm("a\n\nb").content).toBe("a\n\nb");
        });

        test("whitespace at span edges not between newlines is kept", () => {
            expect(norm("  \n\nb\n   ").content).toBe("  \n\nb\n   ");
        });
    });

    describe("class gating", () => {
        test("ERROR gets N1/N2 only", () => {
            const input = `Error: boom${ZWSP}\n\n\n\n${ESC}[31mx${ESC}[0m`;
            expect(norm(input).content).toBe(`Error: boom${ZWSP}\n\n\n\nx`);
        });

        test("CODE gets N1/N2 only — blank runs survive", () => {
            const input = "```\r\nconst a = `x\n\n\n\ny`;\n```";
            expect(norm(input).content).toBe("```\nconst a = `x\n\n\n\ny`;\n```");
        });
    });

    describe("N5 JSON minification (structured only)", () => {
        test("pretty JSON minifies, string internals and numbers verbatim", () => {
            const input = prettyJson();
            const expected =
                "{" +
                Array.from(
                    { length: 12 },
                    (_, i) => `"key${String(i).padStart(2, "0")}":"value ${i}"`,
                ).join(",") +
                ',"big":12345678901234567890}';
            expect(norm(input).content).toBe(expected);
        });

        test("escapes and inner whitespace inside strings are preserved", () => {
            const input =
                `{ "a": "x \\"q\\"  y",` +
                Array.from({ length: 20 }, (_, i) => ` "k${i}": "v ${i}"`).join(",") +
                " }";
            const expected =
                `{"a":"x \\"q\\"  y",` +
                Array.from({ length: 20 }, (_, i) => `"k${i}":"v ${i}"`).join(",") +
                "}";
            expect(norm(input).content).toBe(expected);
        });

        test("unbalanced input left unchanged", () => {
            const input = `{\n${Array.from({ length: 20 }, (_, i) => `  "k${i}": 1,`).join("\n")}`;
            expect(norm(input).content).toBe(input);
        });

        test("unterminated string left unchanged", () => {
            const input =
                `{ "a": "ok",` +
                Array.from({ length: 20 }, (_, i) => ` "k${i}": 1`).join(",") +
                `, "tail": "open`;
            expect(norm(input).content).toBe(input);
        });

        test("trailing garbage left unchanged", () => {
            const input =
                "{" +
                Array.from({ length: 20 }, (_, i) => `"k${i}": 1`).join(",") +
                "} oops";
            expect(norm(input).content).toBe(input);
        });

        test("non-{ start is not attempted", () => {
            const input =
                "note first " +
                Array.from({ length: 20 }, (_, i) => `"k${i}": 1`).join(", ");
            expect(norm(input).content).toBe(input);
        });

        test("json: false disables N5 only", () => {
            const s = new NormalizeStrategy(false);
            expect(norm(prettyJson(), "user", s).content).toBe(prettyJson());
        });
    });

    describe("span walk", () => {
        test("system messages are never modified", () => {
            const m = msg(`a\r\nb${ESC}[31m`, "system");
            expect(new NormalizeStrategy().apply([m])[0]).toBe(m);
        });

        test("tool_result string and nested arrays rewrite, ids preserved", () => {
            const m = msg([
                {
                    type: "tool_result",
                    tool_use_id: "t1",
                    content: [
                        { type: "text", text: `one${ZWSP}\n\n\n\ntwo` },
                        { type: "image", source: { data: "x" } },
                    ],
                },
            ]);
            const out = new NormalizeStrategy().apply([m])[0]!;
            const inner = (out.content as Array<Record<string, unknown>>)[0]!;
            expect(inner.tool_use_id).toBe("t1");
            const blocks = inner.content as Array<Record<string, unknown>>;
            expect(blocks[0]!.text).toBe("one\n\ntwo");
            expect(blocks[1]).toEqual({ type: "image", source: { data: "x" } });
        });

        test("tool_use.input is untouched", () => {
            const m = msg([
                { type: "text", text: "a\r\nb" },
                { type: "tool_use", id: "u", name: "run", input: { cmd: "x\r\ny" } },
            ]);
            const out = new NormalizeStrategy().apply([m])[0]!;
            const blocks = out.content as Array<Record<string, unknown>>;
            expect(blocks[0]!.text).toBe("a\nb");
            expect(blocks[1]).toEqual({
                type: "tool_use",
                id: "u",
                name: "run",
                input: { cmd: "x\r\ny" },
            });
        });

        test("does not mutate the input messages", () => {
            const m = msg("a\r\nb");
            new NormalizeStrategy().apply([m]);
            expect(m.content).toBe("a\r\nb");
        });

        test("unchanged messages keep object identity", () => {
            const m = msg("plain text");
            expect(new NormalizeStrategy().apply([m])[0]).toBe(m);
        });
    });
});
