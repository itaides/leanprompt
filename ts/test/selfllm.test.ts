import { describe, expect, spyOn, test } from "bun:test";
import { SelfLLM } from "../src/compressors/selfllm.js";
import { countTokens } from "../src/tokens.js";

const msg = (content: unknown, role = "user") => ({ role, content });

/** Long prose span (> 40 estimator tokens) that clears the span guard. */
function prose(seed: string): string {
    return [
        `The ${seed} incident report describes a lengthy sequence of unfortunate events in production.`,
        "The scheduler fired the rotation job during an active release window on the gamma cluster.",
        "Basically this was all just terrible timing between two independent systems.",
        "The release step retried three times with exponential backoff and gave up.",
        "Engineering pinned the rotation job to run outside of release windows only.",
        "This change prevents the race condition from recurring in future deployments.",
        "The postmortem lives at docs/incidents/report.md for future reference purposes.",
    ].join(" ");
}

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

const anthropicSummary = (text: string) => ({
    content: [{ text }],
    usage: { input_tokens: 90, output_tokens: 12 },
});

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
    test("summarizes each message in place with estimator stats", async () => {
        const { impl, calls } = fakeFetch(anthropicSummary("the summary"));
        const s = new SelfLLM({ provider: "anthropic", apiKey: "k", fetchImpl: impl });
        const inputs = [msg(prose("one"), "user"), msg(prose("two"), "assistant")];
        const [out, stats] = await s.compressAsync(inputs);

        expect(out).toEqual([
            { role: "user", content: "the summary" },
            { role: "assistant", content: "the summary" },
        ]);
        expect(stats.method).toBe("selfllm");
        // Estimator counts, not provider usage.
        const inTok = countTokens(prose("one")) + countTokens(prose("two"));
        expect(stats.inputTokens).toBe(inTok);
        expect(stats.outputTokens).toBe(2 * countTokens("the summary"));

        expect(calls).toHaveLength(2);
        expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
        expect(calls[0]!.headers.get("x-api-key")).toBe("k");
        expect(calls[0]!.body.system).toContain("context compression assistant");
        const bodyMsgs = calls[0]!.body.messages as Array<{ content: string }>;
        expect(bodyMsgs[0]!.content).toContain("<content>");
        expect(bodyMsgs[0]!.content).toContain(prose("one"));
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

    test("HTTP error falls back by default", async () => {
        const warn = spyOn(console, "warn").mockImplementation(() => {});
        try {
            const impl = (async () => new Response("nope", { status: 500 })) as typeof fetch;
            const s = new SelfLLM({ apiKey: "bad", fetchImpl: impl });
            const input = [msg(prose("fallback"))];
            const [out, stats] = await s.compressAsync(input);
            expect(out).toEqual(input);
            expect(stats.method).toBe("selfllm-fallback");
            expect(stats.inputTokens).toBe(stats.outputTokens);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0]![0]).toContain("leanprompt: selfllm fallback:");
            expect(warn.mock.calls[0]![0]).toContain("HTTP 500");
        } finally {
            warn.mockRestore();
        }
    });

    test("fetch rejection falls back by default", async () => {
        const warn = spyOn(console, "warn").mockImplementation(() => {});
        try {
            const impl = (async () => {
                throw new Error("socket hangup");
            }) as typeof fetch;
            const s = new SelfLLM({ apiKey: "k", fetchImpl: impl });
            const input = [msg(prose("network"))];
            const [out, stats] = await s.compressAsync(input);
            expect(out).toEqual(input);
            expect(stats.method).toBe("selfllm-fallback");
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0]![0]).toContain("socket hangup");
        } finally {
            warn.mockRestore();
        }
    });

    test("onError throw rethrows the provider error", async () => {
        const impl = (async () => new Response("nope", { status: 401 })) as typeof fetch;
        const s = new SelfLLM({ apiKey: "bad", fetchImpl: impl, onError: "throw" });
        await expect(s.compressAsync([msg(prose("boom"))])).rejects.toThrow(/HTTP 401/);
    });

    test("timeout aborts the request and falls back", async () => {
        const warn = spyOn(console, "warn").mockImplementation(() => {});
        try {
            const impl = ((_input: unknown, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () =>
                        reject(new DOMException("The operation was aborted", "AbortError")),
                    );
                })) as typeof fetch;
            const s = new SelfLLM({ apiKey: "k", fetchImpl: impl, timeoutMs: 20 });
            const input = [msg(prose("slow"))];
            const [out, stats] = await s.compressAsync(input);
            expect(out).toEqual(input);
            expect(stats.method).toBe("selfllm-fallback");
            expect(warn).toHaveBeenCalledTimes(1);
        } finally {
            warn.mockRestore();
        }
    });
});

describe("SelfLLM block preservation", () => {
    test("array content: text spans summarized in place, everything else verbatim", async () => {
        const { impl, calls } = fakeFetch(anthropicSummary("sum"));
        const s = new SelfLLM({ apiKey: "k", fetchImpl: impl });
        const image = { type: "image", source: { data: "AAAA" } };
        const [out] = await s.compressAsync([
            {
                role: "user",
                name: "agent",
                content: [
                    { type: "tool_result", tool_use_id: "t1", content: prose("tool") },
                    { type: "text", text: prose("question") },
                    image,
                ],
            },
        ]);

        const blocks = out[0]!.content as Array<Record<string, unknown>>;
        expect(blocks).toHaveLength(3);
        expect(blocks.map((b) => b.type)).toEqual(["tool_result", "text", "image"]);
        expect(blocks[0]!.tool_use_id).toBe("t1");
        expect(blocks[0]!.content).toBe("sum");
        expect(blocks[1]!.text).toBe("sum");
        expect(blocks[2]).toBe(image);
        expect(out[0]!.role).toBe("user");
        expect(out[0]!.name).toBe("agent");
        // Two LLM calls: one per compressible span (tool_result + text).
        expect(calls).toHaveLength(2);
    });

    test("tool_result with nested array content recurses", async () => {
        const { impl, calls } = fakeFetch(anthropicSummary("sum"));
        const s = new SelfLLM({ apiKey: "k", fetchImpl: impl });
        const [out] = await s.compressAsync([
            {
                role: "user",
                content: [
                    {
                        type: "tool_result",
                        tool_use_id: "t2",
                        content: [
                            { type: "text", text: prose("inner") },
                            { type: "image", source: { data: "BB" } },
                        ],
                    },
                ],
            },
        ]);
        const blocks = out[0]!.content as Array<Record<string, unknown>>;
        const inner = blocks[0]!.content as Array<Record<string, unknown>>;
        expect(inner[0]!.text).toBe("sum");
        expect(inner[1]).toEqual({ type: "image", source: { data: "BB" } });
        expect(blocks[0]!.tool_use_id).toBe("t2");
        expect(calls).toHaveLength(1);
    });

    test("single-object content is treated as one block", async () => {
        const { impl } = fakeFetch(anthropicSummary("sum"));
        const s = new SelfLLM({ apiKey: "k", fetchImpl: impl });
        const [out] = await s.compressAsync([
            msg({ type: "text", text: prose("solo") }),
        ]);
        const block = out[0]!.content as Record<string, unknown>;
        expect(block.type).toBe("text");
        expect(block.text).toBe("sum");
    });

    test("structural tool_result content is never sent to the LLM", async () => {
        const { impl, calls } = fakeFetch(anthropicSummary("sum"));
        const s = new SelfLLM({ apiKey: "k", fetchImpl: impl });
        const structural = { type: "tool_result", tool_use_id: "t3", content: "```json\n" + "{}\n".repeat(80) + "```" };
        const [out] = await s.compressAsync([{ role: "user", content: [structural] }]);
        const blocks = out[0]!.content as Array<Record<string, unknown>>;
        expect(blocks[0]).toBe(structural);
        expect(calls).toHaveLength(0);
    });

    test("short spans are never sent to the LLM", async () => {
        const { impl, calls } = fakeFetch(anthropicSummary("sum"));
        const s = new SelfLLM({ apiKey: "k", fetchImpl: impl });
        const [out, stats] = await s.compressAsync([msg("short ask, a dozen tokens at most")]);
        expect(out[0]!.content).toBe("short ask, a dozen tokens at most");
        expect(calls).toHaveLength(0);
        expect(stats.inputTokens).toBe(stats.outputTokens);
    });

    test("empty summary keeps the original span", async () => {
        const { impl, calls } = fakeFetch(anthropicSummary(""));
        const s = new SelfLLM({ apiKey: "k", fetchImpl: impl });
        const input = [msg(prose("kept"))];
        const [out, stats] = await s.compressAsync(input);
        expect(out).toEqual(input);
        expect(calls).toHaveLength(1);
        expect(stats.inputTokens).toBe(stats.outputTokens);
        expect(stats.method).toBe("selfllm");
    });

    test("summary not shorter than input keeps the original span", async () => {
        const long = prose("kept") + " " + prose("extra padding makes this longer");
        const { impl, calls } = fakeFetch(anthropicSummary(long));
        const s = new SelfLLM({ apiKey: "k", fetchImpl: impl });
        const input = [msg(prose("kept"))];
        const [out] = await s.compressAsync(input);
        expect(out).toEqual(input);
        expect(calls).toHaveLength(1);
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
        const [out] = await s.compressAsync([msg(prose("oai"))]);
        expect(out[0]!.content).toBe("sum");
        expect(calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
        expect(calls[0]!.headers.get("authorization")).toBe("Bearer k");
        expect(calls[0]!.body.reasoning_effort).toBeUndefined();
    });

    test("reasoning models get reasoning_effort=minimal", async () => {
        for (const model of ["gpt-5-nano", "o1-mini", "o3", "o4-mini"]) {
            const { impl, calls } = fakeFetch(payload);
            const s = new SelfLLM({ provider: "openai", model, apiKey: "k", fetchImpl: impl });
            await s.compressAsync([msg(prose("oai"))]);
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
        const [out] = await s.compressAsync([msg(prose("gem"))]);
        expect(out[0]!.content).toBe("gsum");
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
        await s.compressAsync([msg(prose("gem"))]);
        const genCfg = calls[0]!.body.generationConfig as Record<string, unknown>;
        expect(genCfg.thinkingConfig).toBeUndefined();
    });
});
