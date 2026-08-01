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
 *   - A word run of N isWordChar code points that are NOT pinned dense-script
 *     code points (see isDenseScriptChar) contributes max(1, ceil(N / 4))
 *     tokens.
 *   - A run of N pinned dense-script code points contributes
 *     max(1, ceil(N * 2 / 3)) tokens. Dense scripts (CJK ideographs, Hangul,
 *     Hiragana/Katakana, Thai, Lao, Khmer, Myanmar) are not space-delimited
 *     and real BPE tokenizers run far denser than 4 chars/token on them
 *     (commonly ~1.5-2.5 chars/token) — bucketing them through the
 *     space-delimited-word divisor undercounts by 2-3x. This divisor is
 *     itself only an estimate, isolated to this file: isWordChar/isSpaceChar
 *     are unchanged and still used unmodified by the Extract compressor's
 *     word-tokenization (see extract.ts) and elsewhere.
 *   - Every other non-word, non-space code point contributes 1 token.
 *   - Total = max(1, wordTokens + denseTokens + symbolTokens) for non-empty
 *     text.
 */

import { getTextContent } from "./content.js";
import type { ChatMessage } from "./types.js";

const CHARS_PER_TOKEN = 4;
// ceil(N * DENSE_NUM / DENSE_DEN) approximates ~1.5 chars/token.
const DENSE_NUM = 2;
const DENSE_DEN = 3;

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
 * Pinned dense-script code point ranges: scripts with no space-delimited
 * word boundaries, where real BPE tokenizers run far denser than the
 * space-delimited-word 4-chars/token divisor. Used only by countTokens'
 * per-run charge below — isWordChar/isSpaceChar classification is unchanged.
 */
function isDenseScriptChar(cp: number): boolean {
    return (
        (cp >= 0x0e00 && cp <= 0x0e7f) || // Thai
        (cp >= 0x0e80 && cp <= 0x0eff) || // Lao
        (cp >= 0x1000 && cp <= 0x109f) || // Myanmar
        (cp >= 0x1100 && cp <= 0x11ff) || // Hangul Jamo
        (cp >= 0x1780 && cp <= 0x17ff) || // Khmer
        (cp >= 0x3040 && cp <= 0x309f) || // Hiragana
        (cp >= 0x30a0 && cp <= 0x30ff) || // Katakana
        (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Unified Ideographs Extension A
        (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
        (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
        (cp >= 0xf900 && cp <= 0xfaff) // CJK Compatibility Ideographs
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
    let wordRunLen = 0;
    let denseRunLen = 0;

    for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        if (isWordChar(cp)) {
            if (isDenseScriptChar(cp)) {
                if (wordRunLen > 0) {
                    tokens += Math.max(1, Math.ceil(wordRunLen / CHARS_PER_TOKEN));
                    wordRunLen = 0;
                }
                denseRunLen += 1;
            } else {
                if (denseRunLen > 0) {
                    tokens += Math.max(1, Math.ceil((denseRunLen * DENSE_NUM) / DENSE_DEN));
                    denseRunLen = 0;
                }
                wordRunLen += 1;
            }
            continue;
        }
        if (wordRunLen > 0) {
            tokens += Math.max(1, Math.ceil(wordRunLen / CHARS_PER_TOKEN));
            wordRunLen = 0;
        }
        if (denseRunLen > 0) {
            tokens += Math.max(1, Math.ceil((denseRunLen * DENSE_NUM) / DENSE_DEN));
            denseRunLen = 0;
        }
        if (!isSpaceChar(cp)) {
            tokens += 1;
        }
    }
    if (wordRunLen > 0) {
        tokens += Math.max(1, Math.ceil(wordRunLen / CHARS_PER_TOKEN));
    }
    if (denseRunLen > 0) {
        tokens += Math.max(1, Math.ceil((denseRunLen * DENSE_NUM) / DENSE_DEN));
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
