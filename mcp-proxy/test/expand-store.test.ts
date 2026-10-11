import { describe, expect, test } from "bun:test";
import { ExpandStore } from "../src/expand-store.js";

describe("ExpandStore", () => {
    test("put/get round trip", () => {
        const store = new ExpandStore();
        const content = [{ type: "text", text: "original output" }];
        const ref = store.put(content, 42);
        expect(ref).toMatch(/^lp-[0-9a-z]{8,}$/);
        const entry = store.get(ref);
        expect(entry?.content).toEqual(content);
        expect(entry?.tokens).toBe(42);
        expect(store.size).toBe(1);
    });

    test("get returns undefined for unknown refs", () => {
        const store = new ExpandStore();
        store.put([{ type: "text", text: "x" }], 1);
        expect(store.get("lp-00000000")).toBeUndefined();
    });

    test("entry cap evicts least recently used, get() refreshes", () => {
        const store = new ExpandStore({ maxEntries: 3 });
        const a = store.put([{ type: "text", text: "a" }], 1);
        const b = store.put([{ type: "text", text: "b" }], 1);
        store.put([{ type: "text", text: "c" }], 1);
        // Touch "a" so "b" becomes the LRU entry.
        store.get(a);
        store.put([{ type: "text", text: "d" }], 1);
        expect(store.get(b)).toBeUndefined();
        expect(store.get(a)).toBeDefined();
        expect(store.size).toBe(3);
    });

    test("byte cap evicts oldest until under", () => {
        // ~60 bytes per entry; cap of 100 keeps at most one.
        const small = { maxEntries: 100, maxBytes: 100 };
        const store = new ExpandStore(small);
        const big = (s: string) => [{ type: "text", text: s.repeat(50) }];
        const first = store.put(big("a"), 1);
        const second = store.put(big("b"), 1);
        expect(store.get(first)).toBeUndefined();
        expect(store.get(second)).toBeDefined();
        expect(store.size).toBe(1);
    });
});
