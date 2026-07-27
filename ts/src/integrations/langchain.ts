/**
 * LangChain.js integration.
 *
 * Both `@langchain/openai`'s `ChatOpenAI` and `@langchain/anthropic`'s
 * `ChatAnthropic` construct their underlying official SDK client (`openai` /
 * `@anthropic-ai/sdk`) from a `configuration` / `clientOptions` object that
 * accepts a custom `fetch` — the exact same hook `leanpromptFetch` (see
 * `../fetch.ts`) is designed for. There is nothing LangChain-specific to
 * implement: this module exists to give that wiring a name and a place in
 * the docs, not because the mechanism needs new code.
 *
 * Deliberately has NO import from `@langchain/*` — the returned shape is a
 * plain `{ fetch }` object compatible with any client that accepts a custom
 * fetch, so this file adds no type dependency on the LangChain packages.
 * `@langchain/core` / `@langchain/openai` / `@langchain/anthropic` are
 * listed as optional peerDependencies purely to document intended
 * compatibility — importing "leanprompt/langchain" never pulls them in.
 *
 * Usage:
 *
 *     import { ChatOpenAI } from "@langchain/openai";
 *     import { leanpromptLangChain } from "leanprompt/langchain";
 *
 *     const model = new ChatOpenAI({
 *         configuration: leanpromptLangChain({ mode: "on", routing: { prose: "extract" } }),
 *     });
 *
 *     import { ChatAnthropic } from "@langchain/anthropic";
 *     const model2 = new ChatAnthropic({
 *         clientOptions: leanpromptLangChain({ mode: "on", routing: { prose: "extract" } }),
 *     });
 */

import { leanpromptFetch } from "../fetch.js";
import type { LeanpromptConfig } from "../types.js";

export interface LeanpromptLangChainClientOptions {
    fetch: typeof fetch;
}

/**
 * Build a `{ fetch }` object to pass as `ChatOpenAI`'s `configuration` or
 * `ChatAnthropic`'s `clientOptions`. Compresses `messages` on every outgoing
 * chat-completion / messages request the model makes.
 */
export function leanpromptLangChain(
    config: LeanpromptConfig = {},
): LeanpromptLangChainClientOptions {
    return { fetch: leanpromptFetch(config) };
}
