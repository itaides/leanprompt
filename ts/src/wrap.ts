/**
 * wrap(client, config) — duck-typed instance wrapper.
 *
 * For users who can't (or don't want to) pass a custom fetch: hand us an
 * already-constructed client object and get back a Proxy that intercepts the
 * chat-message creation methods (`chat.completions.create(...)` and
 * `messages.create(...)`), compresses `params.messages` first, and attaches
 * leanprompt telemetry to the response usage. Every other property, method and
 * nested path passes through to the original object untouched.
 *
 * Duck typing, zero deps: works with the official OpenAI and Anthropic JS
 * SDKs and with anything shaped like them.
 */

import { Middleware } from "./middleware.js";
import { attachTelemetry } from "./telemetry.js";
import type { ChatMessage, LeanpromptConfig } from "./types.js";

/** Property paths whose `create` calls carry a compressible messages array. */
const INTERCEPT_PATHS = new Set(["chat.completions", "messages"]);

export function wrap<T extends object>(client: T, config: LeanpromptConfig = {}): T {
    const middleware = new Middleware(config);
    return proxyAt(client, client, "", middleware);
}

function proxyAt<T extends object>(
    node: T,
    root: object,
    path: string,
    middleware: Middleware,
): T {
    return new Proxy(node, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (typeof prop !== "string") {
                return value;
            }
            const childPath = path === "" ? prop : `${path}.${prop}`;

            // Intercept the create() at a known messages endpoint path.
            if (prop === "create" && INTERCEPT_PATHS.has(path) && typeof value === "function") {
                const fn = value as (...args: unknown[]) => unknown;
                return async (...args: unknown[]) => {
                    const params = args[0];
                    if (
                        params !== null &&
                        typeof params === "object" &&
                        Array.isArray((params as Record<string, unknown>).messages)
                    ) {
                        const p = params as Record<string, unknown>;
                        const [compressed, stats] = await middleware.compressMessagesAsync(
                            p.messages as ChatMessage[],
                        );
                        args = [{ ...p, messages: compressed }, ...args.slice(1)];
                        const response = await fn.apply(target, args);
                        if (p.stream !== true) {
                            attachTelemetry(response, stats);
                        }
                        return response;
                    }
                    return fn.apply(target, args);
                };
            }

            // Bind plain methods to their original receiver so SDK internals
            // (`this._client` etc.) keep working.
            if (typeof value === "function") {
                return (value as (...args: unknown[]) => unknown).bind(target);
            }

            // Recurse into plain objects along potential intercept paths so
            // `client.chat.completions.create` resolves through proxies.
            if (
                value !== null &&
                typeof value === "object" &&
                isInterceptPrefix(childPath)
            ) {
                return proxyAt(value as object, root, childPath, middleware);
            }
            return value;
        },
    });
}

function isInterceptPrefix(path: string): boolean {
    for (const target of INTERCEPT_PATHS) {
        if (target === path || target.startsWith(`${path}.`) || path.startsWith(`${target}.`)) {
            return true;
        }
    }
    return false;
}
