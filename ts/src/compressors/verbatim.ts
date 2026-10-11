/**
 * Verbatim — the no-op compressor.
 *
 * Used when content must not be altered: code, diffs, stack traces, tool
 * schemas, short messages that wouldn't compress well. Also the safe default
 * when the classifier emits UNKNOWN.
 *
 * Returns input unchanged with accurate input/output token counts so
 * telemetry still reports meaningful totals (ratio is always 1.0).
 */

import { makeStats } from "../stats.js";
import { countMessageTokens, countTokens } from "../tokens.js";
import type { TokenCounter } from "../tokens.js";
import type { ChatMessage } from "../types.js";
import type { Compressor, CompressResult } from "./base.js";

export interface VerbatimOptions {
    /** Token counter for stats. Defaults to the built-in estimator. */
    tokenCounter?: TokenCounter;
}

/** A pass-through Compressor that preserves messages exactly. */
export class Verbatim implements Compressor {
    readonly name = "verbatim";
    private readonly count: TokenCounter;

    constructor(options: VerbatimOptions = {}) {
        this.count = options.tokenCounter ?? countTokens;
    }

    compress(messages: ChatMessage[]): CompressResult {
        const tokens = countMessageTokens(messages, this.count);
        return [
            messages,
            makeStats({
                inputTokens: tokens,
                outputTokens: tokens,
                ratio: 1.0,
                method: "verbatim",
            }),
        ];
    }

    async compressAsync(messages: ChatMessage[]): Promise<CompressResult> {
        return this.compress(messages);
    }
}
