/**
 * Strategies — deterministic pre-compression filters.
 *
 * Applied by the Middleware before classification/routing. Each strategy
 * takes the full message list and returns a (possibly) reduced list.
 */

import { classify, looksLikeError, RepeatTracker } from "./classifier.js";
import { extractText } from "./content.js";
import { ContentType } from "./types.js";
import type { ChatMessage } from "./types.js";

export interface Strategy {
    readonly name: string;
    apply(messages: ChatMessage[]): ChatMessage[];
}

/**
 * DedupStrategy — drop duplicate messages *within a single request*.
 *
 * Agent conversation histories often accumulate identical tool outputs — the
 * same grep query, the same status check, the same retrieved doc surfaced by
 * two retrieval paths. DedupStrategy walks each request's message list and
 * keeps only the first occurrence of any given text content.
 *
 * Scope is per-call, not per-client: each apply() uses a fresh tracker, so
 * identical user prompts across independent requests are never dropped.
 * Messages carrying tool_use/tool_result linkage are never deduped (dropping
 * a "duplicate" tool_result would orphan its paired tool_use).
 */
export class DedupStrategy implements Strategy {
    readonly name = "dedup";

    apply(messages: ChatMessage[]): ChatMessage[] {
        const tracker = new RepeatTracker();
        return messages.filter((m) => !tracker.isRepeat(m));
    }
}

const DEFAULT_PURGE_PLACEHOLDER = "[errored output purged for context compaction]";

/**
 * PurgeErrorsStrategy — trim content of old errored messages.
 *
 * A failed tool call in turn 3 is typically useful context for a few turns
 * afterwards, then becomes dead weight: the error was handled, the input that
 * triggered it may be very large, and neither will be referenced again.
 *
 * Replaces the content of errored messages older than `afterTurns` ago with a
 * short placeholder. The fact of the error survives; the bulk doesn't.
 * System messages are never purged, and structured content is trimmed per
 * block -- a `tool_result` keeps its block shape and linkage ids so its paired
 * `tool_use` is never orphaned.
 */
export class PurgeErrorsStrategy implements Strategy {
    readonly name = "purge_errors";
    readonly afterTurns: number;
    readonly placeholder: string;

    constructor(afterTurns = 4, placeholder = DEFAULT_PURGE_PLACEHOLDER) {
        this.afterTurns = afterTurns;
        this.placeholder = placeholder;
    }

    apply(messages: ChatMessage[]): ChatMessage[] {
        if (messages.length <= this.afterTurns) {
            return messages;
        }
        const cutoff = messages.length - this.afterTurns;
        return messages.map((msg, i) => {
            if (
                i >= cutoff ||
                msg.role === "system" ||
                classify(msg) !== ContentType.ERROR
            ) {
                return msg;
            }
            return { ...msg, content: this.purgeContent(msg.content) };
        });
    }

    private purgeContent(content: unknown): unknown {
        if (typeof content === "string") {
            return this.placeholder;
        }
        if (Array.isArray(content)) {
            return content.map((block) => this.purgeBlock(block));
        }
        if (content !== null && typeof content === "object") {
            return this.purgeBlock(content);
        }
        return content;
    }

    private purgeBlock(block: unknown): unknown {
        if (block === null || typeof block !== "object") {
            return block;
        }
        const b = block as Record<string, unknown>;
        if (!looksLikeError(extractText(b))) {
            return block;
        }
        if (b.type === "text") {
            return { ...b, text: this.placeholder };
        }
        if (b.type === "tool_result") {
            const inner = b.content;
            if (typeof inner === "string") {
                return { ...b, content: this.placeholder };
            }
            if (Array.isArray(inner)) {
                return { ...b, content: inner.map((item) => this.purgeBlock(item)) };
            }
        }
        return block;
    }
}
