/**
 * Compressor protocol.
 *
 * A Compressor takes a span of chat messages and returns a possibly smaller
 * span with matching CompressionStats. Concrete strategies:
 *
 *   - Verbatim — no-op, used when content must not be altered (code, errors,
 *     tool schemas). The safe default.
 *   - Extract — the weights-free heuristic extractive compressor.
 *   - SelfLLM — delegates summarization to the user's own LLM.
 *
 * The Router selects a Compressor per content type.
 */

import type { CompressionStats } from "../stats.js";
import type { ChatMessage } from "../types.js";

export type CompressResult = [ChatMessage[], CompressionStats];

export interface Compressor {
    readonly name: string;

    /**
     * Compress a span of messages. Implementations must:
     *   - return messages in the same shape they received
     *   - never throw for empty inputs — return them unchanged with
     *     zero-valued stats
     */
    compress(messages: ChatMessage[]): CompressResult;

    /** Async variant. Default implementations may just await the sync form. */
    compressAsync(messages: ChatMessage[]): Promise<CompressResult>;
}
