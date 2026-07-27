/**
 * LangChain.js integration smoke test, against a mocked HTTP server —
 * exercises the real leanpromptLangChain() -> ChatOpenAI/ChatAnthropic wiring,
 * not just leanpromptFetch in isolation (that's already covered by
 * integrations.test.ts).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { leanpromptLangChain } from "../src/integrations/langchain.js";
import type { LeanpromptConfig } from "../src/types.js";

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

let lastBody: Record<string, unknown> | null = null;
const server = Bun.serve({
    port: 0,
    async fetch(req) {
        const url = new URL(req.url);
        lastBody = (await req.json()) as Record<string, unknown>;
        if (url.pathname.endsWith("/chat/completions")) {
            return Response.json({
                id: "cmpl-1",
                object: "chat.completion",
                created: 0,
                model: "gpt-4o-mini",
                choices: [
                    { index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } },
                ],
                usage: { prompt_tokens: 42, completion_tokens: 3, total_tokens: 45 },
            });
        }
        if (url.pathname.endsWith("/messages")) {
            return Response.json({
                id: "msg-1",
                type: "message",
                role: "assistant",
                model: "claude-sonnet-4-6",
                content: [{ type: "text", text: "ok" }],
                stop_reason: "end_turn",
                usage: { input_tokens: 42, output_tokens: 3 },
            });
        }
        return new Response("not found", { status: 404 });
    },
});
const BASE = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

function sentMessages(): Array<{ role: string; content: unknown }> {
    return (lastBody?.messages ?? []) as Array<{ role: string; content: unknown }>;
}

describe("leanpromptLangChain + ChatOpenAI", () => {
    test("compresses via configuration.fetch", async () => {
        const model = new ChatOpenAI({
            apiKey: "test-key",
            model: "gpt-4o-mini",
            configuration: {
                baseURL: BASE,
                ...leanpromptLangChain(CONFIG),
            },
        });
        const original = prose("alpha");
        await model.invoke(original);

        const sent = sentMessages();
        const sentContent = String(sent[sent.length - 1]!.content);
        expect(sentContent.length).toBeLessThan(original.length);
    });

    test("mode off leaves messages untouched", async () => {
        const model = new ChatOpenAI({
            apiKey: "test-key",
            model: "gpt-4o-mini",
            configuration: { baseURL: BASE, ...leanpromptLangChain() },
        });
        const original = prose("beta");
        await model.invoke(original);

        const sent = sentMessages();
        expect(String(sent[sent.length - 1]!.content)).toBe(original);
    });
});

describe("leanpromptLangChain + ChatAnthropic", () => {
    test("compresses via clientOptions.fetch", async () => {
        const model = new ChatAnthropic({
            apiKey: "test-key",
            model: "claude-sonnet-4-6",
            clientOptions: {
                baseURL: BASE,
                ...leanpromptLangChain(CONFIG),
            },
        });
        const original = prose("gamma");
        await model.invoke(original);

        const sent = sentMessages();
        const sentContent = String(sent[sent.length - 1]!.content);
        expect(sentContent.length).toBeLessThan(original.length);
    });
});
