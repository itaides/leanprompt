/**
 * SelfLLM — compression by delegation to the user's own configured LLM.
 *
 * Rather than running a local algorithm (Extract), SelfLLM calls out to an
 * LLM — typically a smaller/cheaper sibling of the model the main request
 * targets (Haiku compressing for a Sonnet request, gpt-4o-mini for gpt-5) —
 * and asks it to produce a compact summary.
 *
 * Zero-dependency: provider calls go through the built-in `fetch` (raw HTTP,
 * no provider SDKs). Supported providers: anthropic / openai / gemini.
 *
 * Async-only: JavaScript has no synchronous HTTP. Routing `selfllm` requires
 * the async middleware entry point (`compressMessagesAsync`); the sync
 * `compress()` throws.
 */

import { getTextContent } from "../content.js";
import { makeStats } from "../stats.js";
import type { ChatMessage } from "../types.js";
import type { Compressor, CompressResult } from "./base.js";

const SUPPORTED_PROVIDERS = new Set(["anthropic", "openai", "gemini"] as const);
export type SelfLLMProvider = "anthropic" | "openai" | "gemini";

// Sensible cheap default per provider. Users override via `model` when they
// want frontier quality on compression too.
//
// The OpenAI default is gpt-4o-mini rather than a gpt-5 nano tier because the
// nano tier is a reasoning model — for summarization it quietly burns the
// completion-token budget on hidden reasoning tokens. Users who pick a
// reasoning model still work: callOpenAI auto-applies reasoning_effort=minimal.
const DEFAULT_MODELS: Record<SelfLLMProvider, string> = {
    anthropic: "claude-haiku-4-5",
    openai: "gpt-4o-mini",
    gemini: "gemini-2.5-flash",
};

const DEFAULT_BASE_URLS: Record<SelfLLMProvider, string> = {
    anthropic: "https://api.anthropic.com",
    openai: "https://api.openai.com",
    gemini: "https://generativelanguage.googleapis.com",
};

// OpenAI model prefixes that are reasoning models: they need
// reasoning_effort="minimal" or they consume the completion budget on
// internal reasoning rather than visible output.
const OPENAI_REASONING_PREFIXES = ["gpt-5", "o1", "o3", "o4"];

// Gemini 2.5+ models support a "thinking" mode that consumes the output
// budget on hidden reasoning; thinkingBudget: 0 disables it for compression.
const GEMINI_THINKING_PREFIXES = ["gemini-2.5", "gemini-3"];

const SYSTEM_PROMPT = `You are a context compression assistant.
Produce a compact, faithful summary of the provided content that
preserves everything a downstream model would need to continue the
conversation coherently.

Keep:
- specific facts, numbers, entity names, identifiers
- decisions that have already been made
- code snippets, file paths, and error messages verbatim
- the user's stated goals and constraints

Omit:
- repetitive phrasing and polite filler
- intermediate reasoning that reached the same conclusion
- commentary about what was compressed

Return only the summary. No preamble, no explanation.`;

/** Provider-neutral completion response shape. */
interface Completion {
    text: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
}

export interface SelfLLMOptions {
    provider?: SelfLLMProvider;
    model?: string;
    apiKey?: string;
    /** Suggested keep-ratio passed to the LLM prompt (not enforced). */
    ratio?: number;
    maxSummaryTokens?: number;
    /** Override the provider base URL (tests, proxies, self-hosted). */
    baseUrl?: string;
    /** Injectable fetch for tests. Defaults to globalThis.fetch. */
    fetchImpl?: typeof fetch;
}

/** Compressor that delegates to an LLM for summarization over raw HTTP. */
export class SelfLLM implements Compressor {
    readonly name = "selfllm";
    readonly provider: SelfLLMProvider;
    readonly model: string;
    readonly ratio: number;
    readonly maxSummaryTokens: number;
    private readonly apiKey: string | undefined;
    private readonly baseUrl: string;
    private readonly fetchImpl: typeof fetch;

    constructor(options: SelfLLMOptions = {}) {
        const provider = options.provider ?? "anthropic";
        if (!SUPPORTED_PROVIDERS.has(provider)) {
            throw new Error(
                `SelfLLM provider ${JSON.stringify(provider)} not supported — ` +
                    `use one of ${[...SUPPORTED_PROVIDERS].sort().join(", ")}`,
            );
        }
        this.provider = provider;
        this.model = options.model ?? DEFAULT_MODELS[provider];
        this.apiKey = options.apiKey ?? envApiKey(provider);
        this.ratio = options.ratio ?? 0.3;
        this.maxSummaryTokens = options.maxSummaryTokens ?? 500;
        this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URLS[provider]).replace(/\/+$/, "");
        this.fetchImpl = options.fetchImpl ?? fetch;
    }

    compress(_messages: ChatMessage[]): CompressResult {
        throw new Error(
            "SelfLLM is async-only (HTTP has no sync path in JS) — " +
                "use compressAsync / Middleware.compressMessagesAsync",
        );
    }

    async compressAsync(messages: ChatMessage[]): Promise<CompressResult> {
        if (messages.length === 0) {
            return [messages, makeStats({ method: "selfllm" })];
        }
        const text = messages.map((m) => getTextContent(m)).join("\n\n");
        if (!text.trim()) {
            return [messages, makeStats({ method: "selfllm" })];
        }

        const completion = await this.call(this.userPrompt(text));

        const role = typeof messages[0]!.role === "string" ? messages[0]!.role : "user";
        const out: ChatMessage[] = [{ role, content: completion.text }];

        return [
            out,
            makeStats({
                inputTokens: completion.inputTokens,
                outputTokens: completion.outputTokens,
                ratio: completion.inputTokens
                    ? completion.outputTokens / completion.inputTokens
                    : 1.0,
                method: "selfllm",
                costUsd: completion.costUsd,
            }),
        ];
    }

    private userPrompt(text: string): string {
        const pct = Math.round(this.ratio * 100);
        return (
            `Compress the content below to roughly ${pct}% of its ` +
            `original length while preserving all information a downstream ` +
            `model would need to continue.\n\n<content>\n${text}\n</content>`
        );
    }

    private async call(userPrompt: string): Promise<Completion> {
        switch (this.provider) {
            case "anthropic":
                return this.callAnthropic(userPrompt);
            case "openai":
                return this.callOpenAI(userPrompt);
            case "gemini":
                return this.callGemini(userPrompt);
        }
    }

    private async callAnthropic(userPrompt: string): Promise<Completion> {
        const body = {
            model: this.model,
            max_tokens: this.maxSummaryTokens,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: userPrompt }],
        };
        const json = await this.postJson(`${this.baseUrl}/v1/messages`, {
            "x-api-key": this.apiKey ?? "",
            "anthropic-version": "2023-06-01",
        }, body);
        const content = (json.content as Array<{ text?: string }>) ?? [];
        const usage = (json.usage as Record<string, number>) ?? {};
        return {
            text: content[0]?.text ?? "",
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            costUsd: 0,
        };
    }

    private async callOpenAI(userPrompt: string): Promise<Completion> {
        const body: Record<string, unknown> = {
            model: this.model,
            max_completion_tokens: this.maxSummaryTokens,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userPrompt },
            ],
        };
        // Reasoning models spend the completion budget on hidden reasoning
        // unless told not to; compression needs none.
        if (OPENAI_REASONING_PREFIXES.some((p) => this.model.startsWith(p))) {
            body.reasoning_effort = "minimal";
        }
        const json = await this.postJson(`${this.baseUrl}/v1/chat/completions`, {
            authorization: `Bearer ${this.apiKey ?? ""}`,
        }, body);
        const choices = (json.choices as Array<{ message?: { content?: string } }>) ?? [];
        const usage = (json.usage as Record<string, number>) ?? {};
        return {
            text: choices[0]?.message?.content ?? "",
            inputTokens: usage.prompt_tokens ?? 0,
            outputTokens: usage.completion_tokens ?? 0,
            costUsd: 0,
        };
    }

    private async callGemini(userPrompt: string): Promise<Completion> {
        const generationConfig: Record<string, unknown> = {
            maxOutputTokens: this.maxSummaryTokens,
        };
        // Gemini 2.5+ thinking otherwise burns the output budget on hidden
        // thinking tokens, leaving an empty/truncated visible response.
        if (GEMINI_THINKING_PREFIXES.some((p) => this.model.startsWith(p))) {
            generationConfig.thinkingConfig = { thinkingBudget: 0 };
        }
        const body = {
            system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: "user", parts: [{ text: userPrompt }] }],
            generationConfig,
        };
        const json = await this.postJson(
            `${this.baseUrl}/v1beta/models/${this.model}:generateContent`,
            { "x-goog-api-key": this.apiKey ?? "" },
            body,
        );
        const candidates =
            (json.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }>) ?? [];
        const parts = candidates[0]?.content?.parts ?? [];
        const usage = (json.usageMetadata as Record<string, number>) ?? {};
        return {
            text: parts.map((p) => p.text ?? "").join(""),
            inputTokens: usage.promptTokenCount ?? 0,
            outputTokens: usage.candidatesTokenCount ?? 0,
            costUsd: 0,
        };
    }

    private async postJson(
        url: string,
        headers: Record<string, string>,
        body: unknown,
    ): Promise<Record<string, unknown>> {
        const response = await this.fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const detail = await response.text().catch(() => "");
            throw new Error(
                `SelfLLM ${this.provider} request failed: HTTP ${response.status} ${detail.slice(0, 300)}`,
            );
        }
        return (await response.json()) as Record<string, unknown>;
    }
}

function envApiKey(provider: SelfLLMProvider): string | undefined {
    const env = (globalThis as { process?: { env?: Record<string, string> } }).process?.env;
    if (!env) {
        return undefined;
    }
    switch (provider) {
        case "anthropic":
            return env.ANTHROPIC_API_KEY;
        case "openai":
            return env.OPENAI_API_KEY;
        case "gemini":
            return env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY;
    }
}
