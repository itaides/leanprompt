/**
 * Shared types for the leanprompt pipeline.
 */

/** A single chat message in OpenAI- or Anthropic-shaped form. */
export interface ChatMessage {
    role: string;
    content: unknown;
    [key: string]: unknown;
}

/**
 * Classification labels emitted by the classifier. The Router uses these to
 * pick which Compressor handles a given message. Values are strings so config
 * files can reference them directly, e.g. `routing: { code: "verbatim",
 * prose: "extract" }`.
 */
export const ContentType = {
    UNKNOWN: "unknown",
    PROSE: "prose",
    CODE: "code",
    ERROR: "error",
    STRUCTURED: "structured",
    REPEAT: "repeat",
    LONG_IMPORTANT: "long_important",
} as const;

export type ContentType = (typeof ContentType)[keyof typeof ContentType];

/** All valid ContentType string values, for config validation. */
export const CONTENT_TYPE_VALUES: ReadonlySet<string> = new Set(
    Object.values(ContentType),
);

/** User-facing configuration (camelCase, JS idiom). */
export interface LeanpromptConfig {
    mode?: "off" | "passthrough" | "disabled" | "on" | "hybrid";
    trigger?: {
        thresholdTokens?: number;
    };
    routing?: Record<string, string>;
    extract?: {
        ratio?: number;
    };
    /**
     * Protection rules: messages never handed to a lossy compressor.
     * System-role messages are always protected; the last `lastTurns`
     * messages (default 2) are protected for recency.
     */
    protect?: {
        lastTurns?: number;
    };
    selfllm?: {
        provider?: "anthropic" | "openai" | "gemini";
        model?: string;
        apiKey?: string;
        ratio?: number;
        maxSummaryTokens?: number;
    };
    strategies?: {
        dedup?: boolean;
        purgeErrors?: boolean | { afterTurns?: number };
    };
}
