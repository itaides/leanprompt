/**
 * Token counting — self-contained estimator, zero dependencies.
 *
 * The middleware trigger (compress when a span exceeds N tokens) and
 * CompressionStats reporting both need a token count. Rather than pull in a
 * BPE tokenizer (tiktoken and friends are large native deps), leanprompt ships a
 * deterministic heuristic estimator. It is an *estimate*, not exact
 * provider-BPE — accurate enough for gating and ratio reporting, and identical
 * across the TS/Rust/Go implementations.
 *
 * DETERMINISM SPEC (normative for all language ports):
 *   - All iteration is over Unicode code points (scalar values), never UTF-16
 *     code units, bytes, or grapheme clusters.
 *   - Character classes are the pinned functions below (isWordChar /
 *     isSpaceChar), NOT the host language's Unicode tables — those vary by
 *     Unicode version across runtimes.
 *   - A word run of N code points contributes max(1, ceil(N / 4)) tokens.
 *   - Every non-word, non-space code point contributes 1 token.
 *   - Total = max(1, wordTokens + symbolTokens) for non-empty text.
 */

import { getTextContent } from "./content.js";
import type { ChatMessage } from "./types.js";

const CHARS_PER_TOKEN = 4;

/**
 * Pinned word-character rule (code point):
 *   - ASCII letters and digits are word chars.
 *   - Non-ASCII: any code point that is not pinned whitespace and not in the
 *     pinned punctuation blocks below is a word char. (CJK ideographs, accented
 *     letters, Cyrillic, etc. all count as word chars under this rule.)
 */
export function isWordChar(cp: number): boolean {
    if (cp < 0x80) {
        return (
            (cp >= 0x30 && cp <= 0x39) || // 0-9
            (cp >= 0x41 && cp <= 0x5a) || // A-Z
            (cp >= 0x61 && cp <= 0x7a) // a-z
        );
    }
    if (isSpaceChar(cp)) {
        return false;
    }
    return !isPunctChar(cp);
}

/** Pinned whitespace rule (code point). */
export function isSpaceChar(cp: number): boolean {
    return (
        cp === 0x20 ||
        cp === 0x09 ||
        cp === 0x0a ||
        cp === 0x0d ||
        cp === 0x0b ||
        cp === 0x0c ||
        cp === 0x85 || // NEL
        cp === 0xa0 || // NBSP
        (cp >= 0x2000 && cp <= 0x200b) || // en/em/thin spaces + ZWSP
        cp === 0x2028 ||
        cp === 0x2029 ||
        cp === 0x202f ||
        cp === 0x205f ||
        cp === 0x3000 || // ideographic space
        cp === 0xfeff // BOM/ZWNBSP
    );
}

/** Pinned non-ASCII punctuation blocks (code point). */
function isPunctChar(cp: number): boolean {
    return (
        (cp >= 0x2010 && cp <= 0x2027) || // hyphens, dashes, quotes, bullets
        (cp >= 0x2030 && cp <= 0x205e) || // general punctuation (rest)
        (cp >= 0x3001 && cp <= 0x303f) || // CJK symbols and punctuation
        (cp >= 0xfe50 && cp <= 0xfe6f) || // small form variants
        (cp >= 0xff01 && cp <= 0xff0f) || // fullwidth ! " # $ % & ' ( ) * + , - . /
        (cp >= 0xff1a && cp <= 0xff20) || // fullwidth : ; < = > ? @
        (cp >= 0xff3b && cp <= 0xff40) || // fullwidth [ \ ] ^ _ `
        (cp >= 0xff5b && cp <= 0xff65) // fullwidth { | } ~ + halfwidth punct
    );
}

/**
 * Estimate the number of tokens in `text`.
 *
 * BPE splits long/rare words into multiple tokens, so a word run contributes
 * roughly ceil(len / 4) tokens (min 1); each other non-space code point
 * (punctuation, symbols) counts as one.
 */
export function countTokens(text: string): number {
    if (!text) {
        return 0;
    }

    let tokens = 0;
    let runLen = 0;

    for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        if (isWordChar(cp)) {
            runLen += 1;
            continue;
        }
        if (runLen > 0) {
            tokens += Math.max(1, Math.ceil(runLen / CHARS_PER_TOKEN));
            runLen = 0;
        }
        if (!isSpaceChar(cp)) {
            tokens += 1;
        }
    }
    if (runLen > 0) {
        tokens += Math.max(1, Math.ceil(runLen / CHARS_PER_TOKEN));
    }

    return Math.max(1, tokens);
}

/**
 * Sum token counts across a list of chat messages. Includes only the
 * compressible text of each message (role tokens and per-message framing
 * overhead are excluded, matching the reference design).
 */
export function countMessageTokens(messages: ChatMessage[]): number {
    let total = 0;
    for (const msg of messages) {
        total += countTokens(getTextContent(msg));
    }
    return total;
}
