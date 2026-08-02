/**
 * Pure compression helpers — no MCP transport, no I/O. Kept separate from
 * proxy.ts so the compression decisions can be unit tested without spinning
 * up a real stdio child process.
 */

import { Middleware } from "leanprompt";
import type { CompressionStats } from "leanprompt";

/** SEP-2133 style reverse-DNS extension identifier for our stats side-channel. */
export const EXT_ID = "io.leanprompt/compression-stats";

export interface ToolResultLike {
    content: unknown[];
    structuredContent?: unknown;
    _meta?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface SamplingMessageLike {
    role: "user" | "assistant";
    content: unknown;
    [key: string]: unknown;
}

function statsMeta(stats: CompressionStats): Record<string, unknown> | null {
    const saved = stats.inputTokens - stats.outputTokens;
    if (saved <= 0) return null;
    return { tokensSaved: saved, ratio: stats.ratio, method: stats.method };
}

/**
 * Compress a CallToolResult's text content in place.
 *
 * `structuredContent` itself is never touched — it's read programmatically
 * by some clients/tool chains, and we can't safely assume every field in it
 * is prose rather than data a caller depends on byte-for-byte. The `content`
 * text block IS always compressed regardless of whether `structuredContent`
 * is also present: an earlier version of this function skipped compression
 * whenever `structuredContent` existed, on the assumption that meant "a
 * schema-aware client reads that instead, so the text block is a dead
 * fallback." That's false in practice — the official
 * `@modelcontextprotocol/server-filesystem`'s `read_text_file` tool returns
 * `structuredContent: { content: "<same file text>" }` right alongside the
 * identical text block, purely to satisfy its outputSchema, not because
 * `content` goes unread. Skipping there made the proxy a no-op on one of the
 * single most common, expensive MCP operations there is: reading a file.
 *
 * `mw` must be configured with `protect: { lastTurns: 0 }`. leanprompt's
 * default protection never touches the last N messages of whatever array it's
 * given — meant for "don't compress the live turns of a conversation." Here
 * each tool result is wrapped as a lone single-message array to reuse the
 * compression pipeline, so with the default (lastTurns: 2) it would always
 * count as "the last 2 turns" and never actually compress anything.
 */
export function compressToolResult(
    result: ToolResultLike,
    mw: Middleware,
): ToolResultLike {
    const [[compressedMsg], stats] = mw.compressMessages([
        { role: "user", content: result.content },
    ]);

    const meta = statsMeta(stats);
    if (!meta) {
        return result;
    }

    return {
        ...result,
        content: Array.isArray(compressedMsg.content) ? compressedMsg.content : result.content,
        _meta: { ...result._meta, [EXT_ID]: meta },
    };
}

/**
 * Compress the `messages` array of a sampling/createMessage request.
 *
 * Each SamplingMessage.content is a single content block object (not an
 * array like tool results) — leanprompt's compressors only rewrite string or
 * array content in place and pass anything else through untouched, so a bare
 * block object has to be wrapped in a one-element array before compression
 * and unwrapped after, or nothing gets compressed at all.
 */
export function compressSamplingMessages(
    messages: SamplingMessageLike[],
    mw: Middleware,
): [SamplingMessageLike[], CompressionStats] {
    const wrapped = messages.map((m) => ({ role: m.role, content: [m.content] }));
    const [compressed, stats] = mw.compressMessages(wrapped);

    const out = compressed.map((m, i) => {
        const original = messages[i]!;
        const block = Array.isArray(m.content) ? m.content[0] : undefined;
        return block !== undefined ? { ...original, content: block } : original;
    });

    return [out, stats];
}
