/**
 * Content-type classifier.
 *
 * Given a chat message, returns a ContentType label. The Router uses that
 * label to pick a Compressor: code, errors, and structured data get verbatim,
 * prose goes through the extractive compressor, repeated tool outputs get
 * dropped.
 *
 * Conservative heuristic rules — false positives route prose to verbatim
 * (costing compression opportunity) but false negatives risk corrupting code.
 * We err on the side of preservation.
 */

import { createHash } from "node:crypto";
import { getTextContent } from "./content.js";
import { ContentType } from "./types.js";
import type { ChatMessage } from "./types.js";

// Phrases that indicate an error, traceback, or panic. Ordered roughly by how
// strong a signal each is — the first match wins.
const ERROR_MARKERS = [
    "Traceback (most recent call last):",
    "Uncaught exception",
    "UnhandledPromiseRejection",
    "thread 'main' panicked at",
    "panic: ",
    "Exception in thread",
    "FATAL: ",
    "ERROR: ",
    "Error: ",
    "Exception: ",
    "java.lang.",
];

// Tokens that strongly suggest source code at a line start.
const CODE_LINE_PREFIXES = [
    "def ",
    "class ",
    "function ",
    "async function ",
    "import ",
    "from ",
    "export ",
    "package ",
    "#include",
    "fn ",
    "pub fn ",
    "func ",
    "var ",
    "const ",
    "let ",
];

// Minimum code-like lines before a message is classified as CODE (when no
// fenced block is present). Two is enough to avoid a single keyword in prose
// (e.g. "the import statement is tricky") from flipping the classification.
const MIN_CODE_LINES = 2;

// A JSON object key: a quoted token immediately followed by a colon. Bounded
// length keeps a stray colon inside a long quoted prose sentence from
// registering as a key.
const JSON_KEY_RE = /"[^"\n]{1,64}"\s*:/g;

// Above this many JSON keys per 1000 characters, a message is treated as a
// serialized structured-data blob (session logs, records, config) rather than
// prose. Extractive compression shreds JSON structure (braces, keys, colons),
// so such content routes to verbatim.
const STRUCTURED_KEYS_PER_KCHAR = 1.0;

// Below this length the key-density estimate is too noisy to trust.
const STRUCTURED_MIN_CHARS = 200;

/**
 * Classify a single chat message by content shape.
 *
 * Check order: ERROR > CODE > STRUCTURED > PROSE. UNKNOWN when the message has
 * no extractable text at all. STRUCTURED precedes PROSE so a JSON blob is
 * routed to verbatim rather than handed to the (structure-destroying)
 * extractive compressor.
 */
export function classify(message: ChatMessage): ContentType {
    const text = getTextContent(message);
    if (!text.trim()) {
        return ContentType.UNKNOWN;
    }
    if (looksLikeError(text)) {
        return ContentType.ERROR;
    }
    if (looksLikeCode(text)) {
        return ContentType.CODE;
    }
    if (looksLikeStructured(text)) {
        return ContentType.STRUCTURED;
    }
    return ContentType.PROSE;
}

function looksLikeError(text: string): boolean {
    return ERROR_MARKERS.some((marker) => text.includes(marker));
}

function looksLikeCode(text: string): boolean {
    // Fenced code blocks are an unambiguous signal.
    if (text.includes("```")) {
        return true;
    }
    const lines = text.split("\n");
    let codeLines = 0;
    for (const line of lines) {
        const stripped = line.replace(/^\s+/, "");
        if (CODE_LINE_PREFIXES.some((prefix) => stripped.startsWith(prefix))) {
            codeLines += 1;
        }
    }
    return codeLines >= MIN_CODE_LINES;
}

function looksLikeStructured(text: string): boolean {
    const n = text.length;
    if (n < STRUCTURED_MIN_CHARS) {
        return false;
    }
    const keys = (text.match(JSON_KEY_RE) ?? []).length;
    return keys / (n / 1000) >= STRUCTURED_KEYS_PER_KCHAR;
}

/**
 * Tracks content hashes across a session to flag duplicate messages.
 *
 * The same tool call with the same arguments often produces the same output
 * across turns (repeated grep queries, ls, status checks). Flagging duplicates
 * lets the caller drop all but the first copy.
 *
 * Not safe for concurrent use — instantiate one per session.
 */
export class RepeatTracker {
    private seen = new Set<string>();

    /**
     * Return true if this message's content has been seen before. Also records
     * the content as seen, so a subsequent identical message still reports true.
     */
    isRepeat(message: ChatMessage): boolean {
        const h = RepeatTracker.hash(message);
        if (h === "") {
            return false;
        }
        if (this.seen.has(h)) {
            return true;
        }
        this.seen.add(h);
        return false;
    }

    reset(): void {
        this.seen.clear();
    }

    private static hash(message: ChatMessage): string {
        // Skip messages that carry tool-use linkage: tool_use and tool_result
        // blocks pair by id, so dropping a "duplicate" tool_result would orphan
        // the matching tool_use in the preceding assistant message.
        if (hasToolLinkage(message)) {
            return "";
        }
        const text = getTextContent(message);
        if (!text) {
            return "";
        }
        // Include role so a user "ok" and an assistant "ok" don't collapse into
        // one message — those are distinct turns in the conversation.
        const role = typeof message.role === "string" ? message.role : "";
        return createHash("sha256").update(`${role}|${text}`, "utf8").digest("hex");
    }
}

/** True if this message contains tool_use or tool_result blocks. */
export function hasToolLinkage(message: ChatMessage): boolean {
    const content = message.content;
    if (!Array.isArray(content)) {
        return false;
    }
    return content.some(
        (block) =>
            block !== null &&
            typeof block === "object" &&
            ((block as Record<string, unknown>).type === "tool_use" ||
                (block as Record<string, unknown>).type === "tool_result"),
    );
}
