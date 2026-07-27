/**
 * Strategies — deterministic pre-compression filters.
 *
 * Applied by the Middleware before classification/routing. Each strategy
 * takes the full message list and returns a (possibly) reduced list.
 */

import { classify, RepeatTracker } from "./classifier.js";
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
            if (i < cutoff && classify(msg) === ContentType.ERROR) {
                return { ...msg, content: this.placeholder };
            }
            return msg;
        });
    }
}
