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

/**
 * NormalizeStrategy — lossless cleanup ("level 0"), runs before dedup.
 *
 * Everything here is byte-safe: line endings, ANSI escapes, invisible
 * format characters, excess blank lines, and JSON-insignificant whitespace.
 * Nothing a model relies on semantically is dropped, which is why it is the
 * only transform allowed on code, error and structured content — and why it
 * runs first, so CRLF/ANSI variants of the same output dedup to one. As a
 * side effect, stripping zero-width characters closes a prompt-injection
 * hiding channel.
 *
 * Which rules apply is gated by the message's classifier class, computed on
 * the ORIGINAL message before any rewriting: N1/N2 on every non-system
 * span, N3/N4 on prose only, N5 on structured only. `role == "system"`
 * messages are never modified.
 */
export class NormalizeStrategy implements Strategy {
    readonly name = "normalize";
    private readonly json: boolean;

    /** `json: false` disables N5 (JSON whitespace minification) only. */
    constructor(json = true) {
        this.json = json;
    }

    apply(messages: ChatMessage[]): ChatMessage[] {
        return messages.map((msg) => {
            if (msg.role === "system") {
                return msg;
            }
            const cls = classify(msg);
            const content = normalizeContent(msg.content, cls, this.json);
            return content === msg.content ? msg : { ...msg, content };
        });
    }
}

function normalizeContent(
    content: unknown,
    cls: ContentType,
    json: boolean,
): unknown {
    if (typeof content === "string") {
        return normalizeSpan(content, cls, json);
    }
    if (Array.isArray(content)) {
        return mapChanged(content, (block) => normalizeBlock(block, cls, json));
    }
    if (content !== null && typeof content === "object") {
        return normalizeBlock(content, cls, json);
    }
    return content;
}

function normalizeBlock(
    block: unknown,
    cls: ContentType,
    json: boolean,
): unknown {
    if (block === null || typeof block !== "object" || Array.isArray(block)) {
        return block;
    }
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
        const text = normalizeSpan(b.text, cls, json);
        return text === b.text ? block : { ...b, text };
    }
    if (b.type === "tool_result") {
        const inner = b.content;
        if (typeof inner === "string") {
            const text = normalizeSpan(inner, cls, json);
            return text === inner ? block : { ...b, content: text };
        }
        if (Array.isArray(inner)) {
            const out = mapChanged(inner, (item) =>
                normalizeBlock(item, cls, json),
            );
            return out === inner ? block : { ...b, content: out };
        }
    }
    return block;
}

/** Map items, returning the original array reference when nothing changed. */
function mapChanged(items: unknown[], fn: (item: unknown) => unknown): unknown {
    let changed = false;
    const out = items.map((item) => {
        const next = fn(item);
        if (next !== item) {
            changed = true;
        }
        return next;
    });
    return changed ? out : items;
}

function normalizeSpan(text: string, cls: ContentType, json: boolean): string {
    let out = stripCrlf(text);
    out = stripAnsi(out);
    if (cls === ContentType.PROSE) {
        out = collapseBlankRuns(stripInvisible(out));
    } else if (cls === ContentType.STRUCTURED && json) {
        out = minifyJsonWhitespace(out);
    }
    return out;
}

/** N1: `\r\n` → `\n`, then remaining lone `\r` → `\n`. */
function stripCrlf(text: string): string {
    if (!text.includes("\r")) {
        return text;
    }
    const cps = [...text];
    const out: string[] = [];
    for (let i = 0; i < cps.length; i++) {
        if (cps[i] === "\r") {
            out.push("\n");
            if (cps[i + 1] === "\n") {
                i++;
            }
        } else {
            out.push(cps[i]!);
        }
    }
    return out.join("");
}

/**
 * N2: remove ANSI escape sequences. CSI (`ESC [` params intermediates
 * final), OSC (`ESC ]` payload terminated by BEL or `ESC \`; unterminated
 * runs to end of span), and two-byte Fe sequences (`ESC` + 0x40-0x5F).
 * Anything else — a malformed CSI, `ESC` before other bytes — is left as-is.
 */
function stripAnsi(text: string): string {
    const cps = [...text].map((c) => c.codePointAt(0)!);
    if (!cps.includes(0x1b)) {
        return text;
    }
    const out: string[] = [];
    let i = 0;
    while (i < cps.length) {
        const cp = cps[i]!;
        if (cp !== 0x1b) {
            out.push(String.fromCodePoint(cp));
            i++;
            continue;
        }
        const next = cps[i + 1];
        if (next === 0x5b) {
            // CSI: params (0x30-0x3F)*, intermediates (0x20-0x2F)*, final
            // (0x40-0x7E). No valid final byte → not an escape, leave it.
            let j = i + 2;
            while (j < cps.length && cps[j]! >= 0x30 && cps[j]! <= 0x3f) {
                j++;
            }
            while (j < cps.length && cps[j]! >= 0x20 && cps[j]! <= 0x2f) {
                j++;
            }
            if (j < cps.length && cps[j]! >= 0x40 && cps[j]! <= 0x7e) {
                i = j + 1;
            } else {
                out.push(String.fromCodePoint(cp));
                i++;
            }
            continue;
        }
        if (next === 0x5d) {
            // OSC: payload ends at BEL or ST (ESC \). An ESC inside the
            // payload not followed by \ is payload.
            let j = i + 2;
            let end = cps.length;
            while (j < cps.length) {
                if (cps[j] === 0x07) {
                    end = j + 1;
                    break;
                }
                if (cps[j] === 0x1b && cps[j + 1] === 0x5c) {
                    end = j + 2;
                    break;
                }
                j++;
            }
            i = end;
            continue;
        }
        if (next !== undefined && next >= 0x40 && next <= 0x5f) {
            i += 2;
            continue;
        }
        out.push(String.fromCodePoint(cp));
        i++;
    }
    return out.join("");
}

/** N3: remove ZWSP, WJ, ZWNBSP — never ZWNJ/ZWJ (real orthography, emoji). */
function stripInvisible(text: string): string {
    return [...text]
        .filter((c) => {
            const cp = c.codePointAt(0)!;
            return cp !== 0x200b && cp !== 0x2060 && cp !== 0xfeff;
        })
        .join("");
}

/**
 * N4: collapse runs of 3+ newlines into exactly 2. Whitespace-only lines
 * between newlines count as empty and are stripped; trailing whitespace on
 * non-empty lines (markdown hard breaks) is preserved.
 */
function collapseBlankRuns(text: string): string {
    const cps = [...text];
    const out: string[] = [];
    let i = 0;
    while (i < cps.length) {
        if (cps[i] !== "\n") {
            out.push(cps[i]!);
            i++;
            continue;
        }
        let count = 0;
        let j = i;
        for (;;) {
            count++;
            j++;
            let k = j;
            while (k < cps.length && (cps[k] === " " || cps[k] === "\t")) {
                k++;
            }
            if (k < cps.length && cps[k] === "\n") {
                j = k;
            } else {
                break;
            }
        }
        out.push("\n");
        if (count > 1) {
            out.push("\n");
        }
        i = j;
    }
    return out.join("");
}

/**
 * N5: JSON whitespace minification, lossless by construction — only
 * space/\t/\n/\r outside strings is removed; string contents, key order and
 * number literals are copied verbatim. Any malformed input is returned
 * unchanged.
 */
function minifyJsonWhitespace(text: string): string {
    const isWs = (cp: string) =>
        cp === " " || cp === "\t" || cp === "\n" || cp === "\r";
    const cps = [...text];
    let start = 0;
    while (start < cps.length && isWs(cps[start]!)) {
        start++;
    }
    if (cps[start] !== "{" && cps[start] !== "[") {
        return text;
    }
    const out: string[] = [];
    let inString = false;
    let escaped = false;
    let depth = 0;
    let ended = false;
    for (let i = start; i < cps.length; i++) {
        const cp = cps[i]!;
        if (inString) {
            out.push(cp);
            if (escaped) {
                escaped = false;
            } else if (cp === "\\") {
                escaped = true;
            } else if (cp === '"') {
                inString = false;
            }
            continue;
        }
        if (isWs(cp)) {
            continue;
        }
        if (ended) {
            return text; // trailing garbage after a complete value
        }
        if (cp === '"') {
            inString = true;
        } else if (cp === "{" || cp === "[") {
            depth++;
        } else if (cp === "}" || cp === "]") {
            depth--;
            if (depth < 0) {
                return text; // unbalanced
            }
            if (depth === 0) {
                ended = true;
            }
        }
        out.push(cp);
    }
    if (inString || depth !== 0) {
        return text; // unterminated string / unbalanced brackets
    }
    return out.join("");
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
