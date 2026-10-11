import { describe, expect, test } from "bun:test";
import { DedupStrategy, PurgeErrorsStrategy } from "../src/strategies.js";

const msg = (content: unknown, role = "user") => ({ role, content });

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
