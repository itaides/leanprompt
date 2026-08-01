/**
 * Unit tests for leanpromptFetch's wire-level contract, independent of any
 * provider client: mode:"off" must be a true no-op, large integers outside
 * the "messages" field must survive byte-for-byte, and the reconstructed
 * response must not carry stale size/encoding headers.
 */

import { describe, expect, test } from "bun:test";
import { leanpromptFetch } from "../src/fetch.js";
import type { LeanpromptConfig } from "../src/types.js";

const ACTIVE: LeanpromptConfig = {
    mode: "on",
    trigger: { thresholdTokens: 10 },
    routing: { prose: "extract" },
    protect: { lastTurns: 0 },
};

function prose(seed: string): string {
    return [
        `The ${seed} report covers a long chain of production events in detail.`,
        "The scheduler fired the rotation job during an active release window.",
        "The release step retried three times with exponential backoff and quit.",
        "Engineering pinned the rotation job to run outside release windows.",
        "This change prevents the race condition from recurring in deployments.",
    ].join(" ");
}

describe("leanpromptFetch — mode off", () => {
    test("returns baseFetch unwrapped: no body parsing, no reconstruction", () => {
        const base: typeof fetch = (async () => new Response("untouched")) as unknown as typeof fetch;
        expect(leanpromptFetch({}, base)).toBe(base);
        expect(leanpromptFetch({ mode: "off" }, base)).toBe(base);
    });

    test("a body that would throw on JSON.parse is never touched", async () => {
        let received: unknown;
        const base: typeof fetch = (async (input, init) => {
            received = init?.body;
            return new Response("ok");
        }) as unknown as typeof fetch;
        const lf = leanpromptFetch({}, base);
        await lf("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            body: "not json at all",
        });
        expect(received).toBe("not json at all");
    });
});

describe("leanpromptFetch — request body precision", () => {
    test("large integers outside 'messages' survive exactly, unrounded by float64", async () => {
        // Written as a literal string, not a JS object, so the digit
        // sequence never passes through a Number literal before reaching
        // the wrapper — this is what a real request body looks like on the
        // wire.
        const messages = JSON.stringify([
            { role: "system", content: "be terse" },
            { role: "user", content: prose("gamma").repeat(10) },
        ]);
        const rawBody =
            `{"model":"gpt-4o","metadata":{"order_id":9223372036854775807},` +
            `"messages":${messages}}`;

        let sentBody: string | null = null;
        const base: typeof fetch = (async (_input, init) => {
            sentBody = init?.body as string;
            return new Response(JSON.stringify({ usage: {} }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }) as unknown as typeof fetch;

        const lf = leanpromptFetch(ACTIVE, base);
        await lf("https://api.openai.com/v1/chat/completions", { method: "POST", body: rawBody });

        expect(sentBody).not.toBeNull();
        expect(sentBody).toContain('"order_id":9223372036854775807');
        const parsed = JSON.parse(sentBody!) as Record<string, unknown>;
        expect(parsed.model).toBe("gpt-4o");
        expect(Array.isArray(parsed.messages)).toBe(true);
    });

    test("falls back to full re-serialization if the splice can't find the field", async () => {
        let sentBody: string | null = null;
        const base: typeof fetch = (async (_input, init) => {
            sentBody = init?.body as string;
            return new Response(JSON.stringify({ usage: {} }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }) as unknown as typeof fetch;
        const lf = leanpromptFetch(ACTIVE, base);
        await lf("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            body: JSON.stringify({ messages: [{ role: "user", content: prose("delta").repeat(10) }] }),
        });
        expect(() => JSON.parse(sentBody!)).not.toThrow();
    });

    test("an escaped 'messages' key is still found by decoded comparison, not byte matching", async () => {
        const messages = JSON.stringify([{ role: "user", content: prose("zeta").repeat(10) }]);
        // a is 'a' — the key is "messages" but not spelled that way in bytes.
        const rawBody =
            `{"model":"gpt-4o","metadata":{"order_id":9223372036854775807},` +
            `"mess\\u0061ges":${messages}}`;

        let sentBody: string | null = null;
        const base: typeof fetch = (async (_input, init) => {
            sentBody = init?.body as string;
            return new Response(JSON.stringify({ usage: {} }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }) as unknown as typeof fetch;
        const lf = leanpromptFetch(ACTIVE, base);
        await lf("https://api.openai.com/v1/chat/completions", { method: "POST", body: rawBody });

        // The splice must have found the escaped key: if it had missed and
        // fallen back to full re-serialization, the big integer elsewhere
        // in the body would have been corrupted by the float64 round-trip.
        expect(sentBody).toContain('"order_id":9223372036854775807');
    });

    test("duplicate top-level 'messages' keys compress the same occurrence JSON.parse reads, not the wrong one", async () => {
        // JSON.parse resolves duplicate keys last-wins; the splice scanner
        // must either match that or safely bail to full re-serialization —
        // never patch the first occurrence while json.parse (and the
        // receiving provider) reads the second, which would silently make
        // compression a no-op despite stats reporting it happened.
        const long = prose("eta").repeat(10);
        const shortMessages = JSON.stringify([{ role: "user", content: "hi" }]);
        const longMessages = JSON.stringify([{ role: "user", content: long }]);
        const rawBody = `{"messages":${shortMessages},"model":"m","messages":${longMessages}}`;

        let sentBody: string | null = null;
        const base: typeof fetch = (async (_input, init) => {
            sentBody = init?.body as string;
            return new Response(JSON.stringify({ usage: {} }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }) as unknown as typeof fetch;
        const lf = leanpromptFetch(ACTIVE, base);
        await lf("https://api.openai.com/v1/chat/completions", { method: "POST", body: rawBody });

        const parsed = JSON.parse(sentBody!) as { messages: Array<{ content: string }> };
        // Compression must have applied to the long (JSON.parse-visible) turn.
        expect(parsed.messages[0]!.content.length).toBeLessThan(long.length);
        expect(parsed.messages[0]!.content.length).toBeGreaterThan(0);
    });
});

describe("leanpromptFetch — response header hygiene", () => {
    test("strips stale content-length/content-encoding from the reconstructed response", async () => {
        const base: typeof fetch = (async () =>
            new Response(JSON.stringify({ usage: {} }), {
                status: 200,
                headers: {
                    "content-type": "application/json",
                    "content-length": "5",
                    "content-encoding": "gzip",
                },
            })) as unknown as typeof fetch;
        const lf = leanpromptFetch(ACTIVE, base);
        const res = await lf("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            body: JSON.stringify({ messages: [{ role: "user", content: prose("eps").repeat(10) }] }),
        });
        expect(res.headers.get("content-length")).toBeNull();
        expect(res.headers.get("content-encoding")).toBeNull();
        const json = (await res.json()) as Record<string, unknown>;
        expect(json.usage).toBeTruthy();
    });
});
