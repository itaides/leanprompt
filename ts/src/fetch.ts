/**
 * leanpromptFetch — compression as a `fetch` middleware.
 *
 * The zero-dependency "drop-in" story: users keep their own official
 * OpenAI/Anthropic SDK (their dependency, not ours) and hand it a custom
 * fetch. Both official JS SDKs accept one in their constructor:
 *
 *     import OpenAI from "openai";
 *     import { leanpromptFetch } from "leanprompt";
 *
 *     const client = new OpenAI({ fetch: leanpromptFetch({ mode: "on", ... }) });
 *
 * The returned fetch intercepts POST requests to chat-completion/messages
 * endpoints, compresses `messages` in the JSON body, forwards the request,
 * and — for non-streaming JSON responses — annotates `usage` with
 * leanpromptTokensSaved / leanpromptRatio / leanpromptMethod. Streaming responses are
 * forwarded untouched (request-side compression still applies).
 */

import { Middleware } from "./middleware.js";
import type { ChatMessage, LeanpromptConfig } from "./types.js";

// Endpoint paths whose bodies carry a compressible `messages` array.
const MESSAGE_ENDPOINTS = ["/chat/completions", "/v1/messages", "/messages"];

export function leanpromptFetch(
    config: LeanpromptConfig = {},
    baseFetch: typeof fetch = fetch,
): typeof fetch {
    const middleware = new Middleware(config);

    const wrapped = async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
        const url = requestUrl(input);
        const method = (init?.method ?? requestMethod(input) ?? "GET").toUpperCase();

        if (method !== "POST" || !isMessagesEndpoint(url)) {
            return baseFetch(input, init);
        }

        const rawBody = await readBody(input, init);
        if (rawBody === null) {
            return baseFetch(input, init);
        }

        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
            return baseFetch(input, init);
        }
        if (!Array.isArray(parsed.messages)) {
            return baseFetch(input, init);
        }

        const [compressed, stats] = await middleware.compressMessagesAsync(
            parsed.messages as ChatMessage[],
        );
        const newBody = JSON.stringify({ ...parsed, messages: compressed });
        const response = await forward(baseFetch, input, init, newBody);

        // Annotate non-streaming JSON responses; forward streams untouched.
        if (parsed.stream === true) {
            return response;
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
            return response;
        }
        let json: Record<string, unknown>;
        try {
            json = (await response.clone().json()) as Record<string, unknown>;
        } catch {
            return response;
        }
        const usage = json.usage;
        if (usage === null || typeof usage !== "object") {
            return response;
        }
        const annotated = usage as Record<string, unknown>;
        annotated.leanpromptTokensSaved = stats.inputTokens - stats.outputTokens;
        annotated.leanpromptRatio = stats.ratio;
        annotated.leanpromptMethod = stats.method;
        return new Response(JSON.stringify(json), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    };

    return wrapped as typeof fetch;
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
    if (typeof input === "string") {
        return input;
    }
    if (input instanceof URL) {
        return input.toString();
    }
    return input.url;
}

function requestMethod(input: Parameters<typeof fetch>[0]): string | undefined {
    if (typeof input === "object" && input !== null && "method" in input) {
        return (input as Request).method;
    }
    return undefined;
}

function isMessagesEndpoint(url: string): boolean {
    let pathname: string;
    try {
        pathname = new URL(url).pathname;
    } catch {
        pathname = url;
    }
    return MESSAGE_ENDPOINTS.some((e) => pathname.endsWith(e));
}

/** Extract the request body as text, from init or a Request object. */
async function readBody(
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
): Promise<string | null> {
    const body = init?.body;
    if (typeof body === "string") {
        return body;
    }
    if (body instanceof Uint8Array) {
        return new TextDecoder().decode(body);
    }
    if (body === undefined && input instanceof Request) {
        try {
            return await input.clone().text();
        } catch {
            return null;
        }
    }
    return null;
}

async function forward(
    baseFetch: typeof fetch,
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1] | undefined,
    newBody: string,
): Promise<Response> {
    if (input instanceof Request && init?.body === undefined) {
        return baseFetch(new Request(input, { body: newBody, method: "POST" }));
    }
    return baseFetch(input, { ...init, body: newBody });
}
