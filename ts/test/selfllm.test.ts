import { describe, expect, test } from "bun:test";
import { SelfLLM } from "../src/compressors/selfllm.js";

const msg = (content: unknown, role = "user") => ({ role, content });

/** Fake fetch capturing the request and returning a canned provider payload. */
function fakeFetch(payload: unknown) {
    const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    const impl = (async (input: unknown, init?: RequestInit) => {
        calls.push({
            url: String(input),
            body: JSON.parse(String(init?.body)) as Record<string, unknown>,
            headers: new Headers(init?.headers),
        });
        return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    }) as typeof fetch;
    return { impl, calls };
}

describe("SelfLLM construction", () => {
    test("rejects unknown provider", () => {
        expect(
            () => new SelfLLM({ provider: "mistral" as unknown as "openai" }),
        ).toThrow(/not supported/);
    });

    test("defaults per provider", () => {
        expect(new SelfLLM({ apiKey: "k" }).model).toBe("claude-haiku-4-5");
        expect(new SelfLLM({ provider: "openai", apiKey: "k" }).model).toBe("gpt-4o-mini");
        expect(new SelfLLM({ provider: "gemini", apiKey: "k" }).model).toBe("gemini-2.5-flash");
    });

    test("sync compress throws (async-only)", () => {
        expect(() => new SelfLLM({ apiKey: "k" }).compress([msg("x")])).toThrow(/async/);
    });
});

describe("SelfLLM anthropic", () => {
    test("summarizes span into one message with stats", async () => {
        const { impl, calls } = fakeFetch({
            content: [{ text: "the summary" }],
            usage: { input_tokens: 90, output_tokens: 12 },
        });
        const s = new SelfLLM({ provider: "anthropic", apiKey: "k", fetchImpl: impl });
        const [out, stats] = await s.compressAsync([
            msg("long text one", "user"),
            msg("long text two", "assistant"),
        ]);

        expect(out).toEqual([{ role: "user", content: "the summary" }]);
        expect(stats.method).toBe("selfllm");
        expect(stats.inputTokens).toBe(90);
        expect(stats.outputTokens).toBe(12);

        expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
        expect(calls[0]!.headers.get("x-api-key")).toBe("k");
        expect(calls[0]!.body.system).toContain("context compression assistant");
        const bodyMsgs = calls[0]!.body.messages as Array<{ content: string }>;
        expect(bodyMsgs[0]!.content).toContain("<content>");
        expect(bodyMsgs[0]!.content).toContain("long text one");
        expect(bodyMsgs[0]!.content).toContain("roughly 30%");
    });

    test("empty span short-circuits without a network call", async () => {
        const { impl, calls } = fakeFetch({});
        const s = new SelfLLM({ apiKey: "k", fetchImpl: impl });
        const [out, stats] = await s.compressAsync([]);
        expect(out).toEqual([]);
        expect(stats.method).toBe("selfllm");
        expect(calls).toHaveLength(0);
    });

    test("HTTP error surfaces with status", async () => {
        const impl = (async () => new Response("nope", { status: 401 })) as typeof fetch;
        const s = new SelfLLM({ apiKey: "bad", fetchImpl: impl });
        await expect(s.compressAsync([msg("text")])).rejects.toThrow(/HTTP 401/);
    });
});

describe("SelfLLM openai", () => {
    const payload = {
        choices: [{ message: { content: "sum" } }],
        usage: { prompt_tokens: 80, completion_tokens: 10 },
    };

    test("non-reasoning model: no reasoning_effort", async () => {
        const { impl, calls } = fakeFetch(payload);
        const s = new SelfLLM({ provider: "openai", apiKey: "k", fetchImpl: impl });
        const [out, stats] = await s.compressAsync([msg("content here")]);
        expect(out[0]!.content).toBe("sum");
        expect(stats.inputTokens).toBe(80);
        expect(calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
        expect(calls[0]!.headers.get("authorization")).toBe("Bearer k");
        expect(calls[0]!.body.reasoning_effort).toBeUndefined();
    });

    test("reasoning models get reasoning_effort=minimal", async () => {
        for (const model of ["gpt-5-nano", "o1-mini", "o3", "o4-mini"]) {
            const { impl, calls } = fakeFetch(payload);
            const s = new SelfLLM({ provider: "openai", model, apiKey: "k", fetchImpl: impl });
            await s.compressAsync([msg("content")]);
            expect(calls[0]!.body.reasoning_effort).toBe("minimal");
        }
    });
});

describe("SelfLLM gemini", () => {
    const payload = {
        candidates: [{ content: { parts: [{ text: "gsum" }] } }],
        usageMetadata: { promptTokenCount: 70, candidatesTokenCount: 9 },
    };

    test("thinking models get thinkingBudget 0", async () => {
        const { impl, calls } = fakeFetch(payload);
        const s = new SelfLLM({ provider: "gemini", apiKey: "k", fetchImpl: impl });
        const [out, stats] = await s.compressAsync([msg("content")]);
        expect(out[0]!.content).toBe("gsum");
        expect(stats.inputTokens).toBe(70);
        expect(calls[0]!.url).toContain("/v1beta/models/gemini-2.5-flash:generateContent");
        expect(calls[0]!.headers.get("x-goog-api-key")).toBe("k");
        const genCfg = calls[0]!.body.generationConfig as Record<string, unknown>;
        expect(genCfg.thinkingConfig).toEqual({ thinkingBudget: 0 });
    });

    test("non-thinking model omits thinkingConfig", async () => {
        const { impl, calls } = fakeFetch(payload);
        const s = new SelfLLM({
            provider: "gemini",
            model: "gemini-1.5-flash",
            apiKey: "k",
            fetchImpl: impl,
        });
        await s.compressAsync([msg("content")]);
        const genCfg = calls[0]!.body.generationConfig as Record<string, unknown>;
        expect(genCfg.thinkingConfig).toBeUndefined();
    });
});
