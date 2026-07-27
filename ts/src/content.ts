/**
 * Shared helpers for reading chat-message content.
 *
 * OpenAI-style messages carry a plain string in `content`. Anthropic-style
 * messages may carry a list of typed blocks — text, image, tool_use,
 * tool_result, document, thinking. Both providers use nested blocks for
 * tool-use flows: a tool_result block's content can itself be a string or
 * another list of blocks.
 *
 * Token counting, the classifier, dedup hashing, and purge logic all need to
 * see the full compressible text — not just top-level text blocks. This
 * module centralizes the recursive extraction.
 *
 * Non-text content types (image, thinking, control blocks) return empty
 * strings. tool_use blocks serialize their `input` so tool arguments (often
 * large — full file contents, long search queries) are visible to the
 * compression trigger.
 */

import type { ChatMessage } from "./types.js";

export function getTextContent(message: ChatMessage): string {
    return extractText(message.content);
}

/** Recursively turn any content shape into a single string. */
export function extractText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const item of content) {
            const t = textFromBlock(item);
            if (t) {
                parts.push(t);
            }
        }
        return parts.join("\n");
    }
    if (content !== null && typeof content === "object") {
        // Some providers wrap a single block in an object rather than a list.
        return textFromBlock(content);
    }
    return "";
}

/** Extract text from a single structured content block. */
function textFromBlock(block: unknown): string {
    if (block === null || typeof block !== "object") {
        return "";
    }
    const b = block as Record<string, unknown>;
    const btype = typeof b.type === "string" ? b.type : "";

    if (btype === "text") {
        return typeof b.text === "string" ? b.text : "";
    }

    if (btype === "tool_use") {
        // Tool call arguments. These can be large (full file paths, long
        // search queries, whole diffs as input) and should count toward the
        // compression trigger. Prefix with the tool name so the compressor's
        // view matches the agent's mental model.
        const name = typeof b.name === "string" ? b.name : "";
        const serialized = serialize(b.input);
        if (name && serialized) {
            return `[tool_use ${name}] ${serialized}`;
        }
        return serialized;
    }

    if (btype === "tool_result") {
        // The tool's output. `content` is either a plain string or a nested
        // list of blocks — recurse.
        return extractText(b.content);
    }

    if (btype === "document") {
        const direct = b.text;
        if (typeof direct === "string" && direct) {
            return direct;
        }
        const source = b.source;
        if (source !== null && typeof source === "object") {
            const data = (source as Record<string, unknown>).data;
            if (typeof data === "string") {
                return data;
            }
        }
        return extractText(b.content);
    }

    // image, thinking, cache_control, and any unknown future block types
    // contribute no compressible text.
    return "";
}

/**
 * Turn a tool-input value into a compressible string representation.
 *
 * Canonical JSON spec (this library's own, not Python's json.dumps): compact
 * separators, object keys sorted lexicographically, non-ASCII preserved as
 * UTF-8. Sorted keys make the serialization deterministic and trivially
 * identical across the TS/Rust/Go implementations (the parity oracle), unlike
 * insertion-order which each language handles differently.
 */
export function serialize(value: unknown): string {
    if (value === null || value === undefined) {
        return "";
    }
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "object") {
        return canonicalJson(value);
    }
    if (typeof value === "boolean") {
        return value ? "true" : "false";
    }
    return String(value);
}

/** Compact JSON with lexicographically sorted object keys. */
export function canonicalJson(value: unknown): string {
    if (value === null || value === undefined) {
        return "null";
    }
    if (typeof value === "string") {
        return JSON.stringify(value);
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return "[" + value.map((v) => canonicalJson(v)).join(",") + "]";
    }
    if (typeof value === "object") {
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj).sort();
        const entries = keys.map(
            (k) => JSON.stringify(k) + ":" + canonicalJson(obj[k]),
        );
        return "{" + entries.join(",") + "}";
    }
    return JSON.stringify(value);
}
