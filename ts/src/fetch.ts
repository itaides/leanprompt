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
 *
 * `mode: "off"` (the default) means off: when the middleware is inactive,
 * `leanpromptFetch` returns `baseFetch` itself, unwrapped — no body parsing,
 * no re-serialization, no response reconstruction. Nothing about the wire
 * format changes until compression is actually turned on.
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
    if (!middleware.isActive) {
        return baseFetch;
    }

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
        // Rewrite only the "messages" field's bytes in place; every other
        // byte of the body (including large integers elsewhere, e.g. a
        // metadata ID beyond Number.MAX_SAFE_INTEGER) is left untouched.
        // JSON.parse/stringify-ing the whole body would silently round-trip
        // such integers through float64 and corrupt them. Fall back to a
        // full re-serialization only if the splice can't find the field
        // (should not happen given the isArray check above, but never
        // regress functionality if some edge-case body shape does slip by).
        const spliced = spliceTopLevelArrayField(
            rawBody,
            "messages",
            JSON.stringify(compressed),
        );
        const newBody = spliced ?? JSON.stringify({ ...parsed, messages: compressed });
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
        // Drop headers describing the *old* body (size, encoding) — the
        // reconstructed body is neither the original bytes nor necessarily
        // the original encoding (fetch delivers already-decoded content
        // while preserving the origin's Content-Encoding header value), so
        // copying them verbatim would mislabel the new body to any consumer
        // that reads raw bytes instead of calling response.json().
        const outHeaders = new Headers(response.headers);
        outHeaders.delete("content-length");
        outHeaders.delete("content-encoding");
        return new Response(JSON.stringify(json), {
            status: response.status,
            statusText: response.statusText,
            headers: outHeaders,
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

/**
 * Replace the JSON array value of a top-level `key` in `rawBody` with
 * `replacementJson`, leaving every other byte of the body untouched. Returns
 * null if `key`'s value isn't found as a top-level array (caller falls back
 * to full re-serialization).
 */
function spliceTopLevelArrayField(
    rawBody: string,
    key: string,
    replacementJson: string,
): string | null {
    const span = findTopLevelArraySpan(rawBody, key);
    if (span === null) {
        return null;
    }
    return rawBody.slice(0, span.start) + replacementJson + rawBody.slice(span.end);
}

/**
 * Find the `[start, end)` byte span of `"key": [...]`'s array value, at the
 * top level of a JSON object, respecting string escaping and nesting. Key
 * strings are decoded (not byte-matched) so an escaped key like
 * `"messages"` still matches. Bails (returns null) on a malformed array
 * value or a duplicate top-level `key` — JSON.parse resolves duplicates via
 * last-key-wins, and guessing which occurrence to patch risks silently
 * compressing the wrong one (or leaving an uncompressed copy the receiving
 * parser prefers); the caller falls back to full re-serialization, which
 * matches JSON.parse's semantics exactly.
 */
function findTopLevelArraySpan(
    text: string,
    key: string,
): { start: number; end: number } | null {
    let depth = 0;
    let i = 0;
    let found: { start: number; end: number } | null = null;
    while (i < text.length) {
        const ch = text[i]!;
        if (ch === '"') {
            const str = readJsonString(text, i);
            if (str === null) {
                return null;
            }
            if (depth === 1 && str.value === key) {
                let j = str.end;
                while (j < text.length && isJsonWhitespace(text[j]!)) j++;
                if (text[j] === ":") {
                    j++;
                    while (j < text.length && isJsonWhitespace(text[j]!)) j++;
                    if (text[j] === "[") {
                        const end = findMatchingBracket(text, j);
                        if (end === null) {
                            return null;
                        }
                        if (found !== null) {
                            return null;
                        }
                        found = { start: j, end: end + 1 };
                        i = end + 1;
                        continue;
                    }
                }
            }
            i = str.end;
            continue;
        }
        if (ch === "{" || ch === "[") {
            depth++;
        } else if (ch === "}" || ch === "]") {
            depth--;
        }
        i++;
    }
    return found;
}

/** Find the index of the `]` matching the `[` at `openIndex`. */
function findMatchingBracket(text: string, openIndex: number): number | null {
    let depth = 0;
    let i = openIndex;
    while (i < text.length) {
        const ch = text[i]!;
        if (ch === '"') {
            const str = readJsonString(text, i);
            if (str === null) {
                return null;
            }
            i = str.end;
            continue;
        }
        if (ch === "[") {
            depth++;
        } else if (ch === "]") {
            depth -= 1;
            if (depth === 0) {
                return i;
            }
        }
        i++;
    }
    return null;
}

/**
 * Decode a JSON string literal starting at `text[start]` (the opening `"`).
 * Returns the decoded value and the index right after the closing quote, or
 * null if `start` isn't a string or the string is malformed/unterminated.
 */
function readJsonString(text: string, start: number): { value: string; end: number } | null {
    if (text[start] !== '"') {
        return null;
    }
    let out = "";
    let i = start + 1;
    while (i < text.length) {
        const ch = text[i]!;
        if (ch === '"') {
            return { value: out, end: i + 1 };
        }
        if (ch === "\\") {
            const esc = text[i + 1];
            switch (esc) {
                case '"':
                    out += '"';
                    i += 2;
                    continue;
                case "\\":
                    out += "\\";
                    i += 2;
                    continue;
                case "/":
                    out += "/";
                    i += 2;
                    continue;
                case "b":
                    out += "\b";
                    i += 2;
                    continue;
                case "f":
                    out += "\f";
                    i += 2;
                    continue;
                case "n":
                    out += "\n";
                    i += 2;
                    continue;
                case "r":
                    out += "\r";
                    i += 2;
                    continue;
                case "t":
                    out += "\t";
                    i += 2;
                    continue;
                case "u": {
                    const hex = text.slice(i + 2, i + 6);
                    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
                        return null;
                    }
                    out += String.fromCharCode(Number.parseInt(hex, 16));
                    i += 6;
                    continue;
                }
                default:
                    return null;
            }
        }
        out += ch;
        i += 1;
    }
    return null;
}

function isJsonWhitespace(ch: string): boolean {
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
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
