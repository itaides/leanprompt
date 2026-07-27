/**
 * Integration-layer smoke tests against a mocked provider HTTP server:
 *   - minimal clients (OpenAI / Anthropic)
 *   - leanpromptFetch custom-fetch middleware
 *   - wrap() duck-typed instance wrapper
 *
 * Asserts messages are compressed on the wire and usage.leanprompt* telemetry is
 * attached on the response.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Anthropic } from "../src/anthropic.js";
import { leanpromptFetch } from "../src/fetch.js";
import { OpenAI } from "../src/openai.js";
import type { LeanpromptConfig } from "../src/types.js";
import { wrap } from "../src/wrap.js";

/** Long prose (> threshold below) the Extract compressor will visibly cut. */
function prose(seed: string): string {
    return [
        `The ${seed} report covers a long chain of production events in detail.`,
        "The scheduler fired the rotation job during an active release window.",
        "Basically this was all just terrible timing between two systems.",
        "The release step retried three times with exponential backoff and quit.",
        "Engineering pinned the rotation job to run outside release windows.",
        "This change prevents the race condition from recurring in deployments.",
        "The postmortem lives at docs/incidents/report.md for future reference.",
    ].join(" ");
}

const CONFIG: LeanpromptConfig = {
    mode: "on",
    trigger: { thresholdTokens: 10 },
    routing: { prose: "extract" },
    protect: { lastTurns: 0 },
};

// One mock server for all provider shapes; records the last request body.
let lastBody: Record<string, unknown> | null = null;
const server = Bun.serve({
    port: 0,
    async fetch(req) {
        const url = new URL(req.url);
        lastBody = (await req.json()) as Record<string, unknown>;
        if (url.pathname.endsWith("/chat/completions")) {
            return Response.json({
                id: "cmpl-1",
                choices: [{ message: { role: "assistant", content: "ok" } }],
                usage: { prompt_tokens: 42, completion_tokens: 3 },
            });
        }
        if (url.pathname.endsWith("/messages")) {
            return Response.json({
                id: "msg-1",
                content: [{ type: "text", text: "ok" }],
                usage: { input_tokens: 42, output_tokens: 3 },
            });
        }
        return new Response("not found", { status: 404 });
    },
});
const BASE = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

function sentMessages(): Array<{ role: string; content: string }> {
    return (lastBody?.messages ?? []) as Array<{ role: string; content: string }>;
}

describe("minimal OpenAI client", () => {
    test("compresses request messages and attaches telemetry", async () => {
        const client = new OpenAI({
            apiKey: "test-key",
            baseUrl: BASE,
            leanpromptConfig: CONFIG,
        });
        const original = prose("alpha");
        const response = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: original }],
        });

        expect(sentMessages()[0]!.content.length).toBeLessThan(original.length);
        const usage = response.usage as Record<string, unknown>;
        expect(usage.leanpromptMethod).toBe("extract");
        expect(usage.leanpromptTokensSaved as number).toBeGreaterThan(0);
        expect(usage.leanpromptRatio as number).toBeLessThan(1);
    });

    test("mode off leaves messages untouched", async () => {
        const client = new OpenAI({ apiKey: "k", baseUrl: BASE });
        const original = prose("beta");
        await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: original }],
        });
        expect(sentMessages()[0]!.content).toBe(original);
    });
});

describe("minimal Anthropic client", () => {
    test("compresses request messages and attaches telemetry", async () => {
        const client = new Anthropic({
            apiKey: "test-key",
            baseUrl: BASE,
            leanpromptConfig: CONFIG,
        });
        const original = prose("gamma");
        const response = await client.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 100,
            messages: [{ role: "user", content: original }],
        });

        expect(sentMessages()[0]!.content.length).toBeLessThan(original.length);
        const usage = response.usage as Record<string, unknown>;
        expect(usage.leanpromptMethod).toBe("extract");
        expect(usage.leanpromptTokensSaved as number).toBeGreaterThan(0);
    });
});

describe("leanpromptFetch middleware", () => {
    test("compresses bodies to message endpoints and annotates usage", async () => {
        const lf = leanpromptFetch(CONFIG);
        const original = prose("delta");
        const response = await lf(`${BASE}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: original }],
            }),
        });
        const json = (await response.json()) as Record<string, unknown>;

        expect(sentMessages()[0]!.content.length).toBeLessThan(original.length);
        const usage = json.usage as Record<string, unknown>;
        expect(usage.leanpromptMethod).toBe("extract");
        expect(usage.leanpromptTokensSaved as number).toBeGreaterThan(0);
    });

    test("non-message endpoints pass through untouched", async () => {
        const lf = leanpromptFetch(CONFIG);
        const response = await lf(`${BASE}/v1/other`, {
            method: "POST",
            body: JSON.stringify({ messages: [{ role: "user", content: prose("eps") }] }),
        });
        expect(response.status).toBe(404);
        // body forwarded verbatim (server recorded the uncompressed content)
        expect(sentMessages()[0]!.content).toBe(prose("eps"));
    });

    test("works when given a Request object", async () => {
        const lf = leanpromptFetch(CONFIG);
        const original = prose("zeta");
        const request = new Request(`${BASE}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                model: "m",
                messages: [{ role: "user", content: original }],
            }),
        });
        const response = await lf(request);
        expect(response.status).toBe(200);
        expect(sentMessages()[0]!.content.length).toBeLessThan(original.length);
    });
});

describe("wrap() duck-typed wrapper", () => {
    /** A fake SDK-shaped client with internal state, like the real ones. */
    function fakeSdkClient() {
        const seen: Array<Record<string, unknown>> = [];
        return {
            seen,
            unrelated: { value: 7 },
            ping() {
                return "pong";
            },
            chat: {
                completions: {
                    async create(params: Record<string, unknown>) {
                        seen.push(params);
                        return {
                            choices: [{ message: { content: "ok" } }],
                            usage: { prompt_tokens: 5, completion_tokens: 1 },
                        };
                    },
                },
            },
            messages: {
                async create(params: Record<string, unknown>) {
                    seen.push(params);
                    return {
                        content: [{ type: "text", text: "ok" }],
                        usage: { input_tokens: 5, output_tokens: 1 },
                    };
                },
            },
        };
    }

    test("intercepts chat.completions.create and messages.create", async () => {
        const raw = fakeSdkClient();
        const client = wrap(raw, CONFIG);
        const original = prose("wrap-one");

        const r1 = (await client.chat.completions.create({
            model: "m",
            messages: [{ role: "user", content: original }],
        })) as { usage: Record<string, unknown> };
        const sent1 = raw.seen[0]!.messages as Array<{ content: string }>;
        expect(sent1[0]!.content.length).toBeLessThan(original.length);
        expect(r1.usage.leanpromptMethod).toBe("extract");

        const r2 = (await client.messages.create({
            model: "m",
            messages: [{ role: "user", content: original }],
        })) as { usage: Record<string, unknown> };
        const sent2 = raw.seen[1]!.messages as Array<{ content: string }>;
        expect(sent2[0]!.content.length).toBeLessThan(original.length);
        expect(r2.usage.leanpromptMethod).toBe("extract");
    });

    test("everything else passes through", () => {
        const raw = fakeSdkClient();
        const client = wrap(raw, CONFIG);
        expect(client.ping()).toBe("pong");
        expect(client.unrelated.value).toBe(7);
    });
});
