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
import { countMessageTokens } from "../tokens.js";
import type { ChatMessage } from "../types.js";
import type { Compressor, CompressResult } from "./base.js";

/** A pass-through Compressor that preserves messages exactly. */
export class Verbatim implements Compressor {
    readonly name = "verbatim";

    compress(messages: ChatMessage[]): CompressResult {
        const tokens = countMessageTokens(messages);
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
