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
});
