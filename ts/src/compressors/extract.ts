/**
 * Extract — weights-free heuristic extractive compression.
 *
 * The "new thing" in this SDK: a deterministic, explainable, zero-dependency
 * replacement for neural prompt compressors (LLMLingua-style models). No
 * model weights, no download, no ML runtime — pure statistics over the input
 * itself.
 *
 * Algorithm (per text span):
 *   1. Segment into sentences (procedural scan on .!? + newline boundaries,
 *      protecting decimals, initials and common abbreviations; list/table
 *      lines are marked as such).
 *   2. Term statistics: ASCII-lowercased word tokens; a term's weight is the
 *      bit length of (totalTerms // termCount) — an integer log2 surrogate.
 *      Stopwords contribute 0.
 *   3. Score each sentence (ALL-INTEGER arithmetic — see determinism spec):
 *      length-normalized term-weight sum, boosted for digits, entities,
 *      quoted strings, identifiers/paths, imperative/negation constraints and
 *      first/last position; penalized for filler openers.
 *   4. Greedy-select by (score desc, index asc) until the kept token count
 *      reaches ratio × total. A selected sentence with an anaphoric opener
 *      (This/However/Therefore/...) pulls its predecessor in with it.
 *   5. Redundancy filter during selection: skip a sentence whose 3-word
 *      shingle Jaccard vs an already-kept sentence exceeds 60% — UNLESS it is
 *      a list item, or its digit-bearing tokens differ from the kept twin
 *      (log-like lines that differ only in a number are all signal).
 *   6. Emit kept sentences in original order.
 *
 * DETERMINISM SPEC (normative for all language ports):
 *   - Integer arithmetic only in scoring — no log(), no float accumulation.
 *     Score = (sum(termWeights) * SCALE) integer-div wordCount, plus integer
 *     boosts. SCALE = 1000.
 *   - Lowercasing is ASCII-only (A-Z → a-z); non-ASCII code points unchanged.
 *   - Word tokens are runs of isWordChar code points (see tokens.ts).
 *   - Ranking tiebreak: lower original index wins.
 *   - Budget check: keep while keptTokens * 1000 < ratioMillis * totalTokens.
 *
 * Scope guard: Extract targets space-delimited Latin-script text. Spans whose
 * ASCII share of code points is below 60% pass through verbatim.
 *
 * Block-aware structural safety (inherited from the reference design):
 *   - text blocks: compressed in place
 *   - tool_result blocks: inner string/list content recursively compressed,
 *     EXCEPT content carrying structural markers (``` fences, tracebacks),
 *     which passes verbatim
 *   - tool_use, image, thinking, document, unknown: preserved verbatim,
 *     token-counted so the reported ratio reflects the whole message
 */

import { getTextContent } from "../content.js";
import { makeStats } from "../stats.js";
import { countTokens, isWordChar } from "../tokens.js";
import type { ChatMessage } from "../types.js";
import type { Compressor, CompressResult } from "./base.js";

// ------------------------------------------------------------------------ //
// Tunables (frozen constants — changing any of these breaks cross-language
// golden vectors; bump them only in lockstep across ts/rust/go).
// ------------------------------------------------------------------------ //

/** Default fraction of tokens to KEEP. 0.5 = keep half. */
const DEFAULT_RATIO = 0.5;

/** Fixed-point scale for scores. */
const SCALE = 1000;

/** Integer score boosts. */
const BOOST_DIGITS = 350;
const BOOST_ENTITY = 200;
const BOOST_QUOTED = 200;
const BOOST_IDENTIFIER = 300;
const BOOST_POSITION = 250;
const BOOST_IMPERATIVE = 400;
const PENALTY_FILLER = 400;

/** Redundancy threshold: intersection*100 > REDUNDANCY_PCT*union → redundant. */
const REDUNDANCY_PCT = 60;

/** Lines at or below this many code points are never split further. */
const MIN_SENTENCE_CHARS = 12;

/** Below this many sentences there is nothing meaningful to drop. */
const MIN_SENTENCES_TO_COMPRESS = 3;

/** Spans below this many tokens are left alone (headers, short asks). */
const MIN_SPAN_TOKENS = 40;

/** Minimum ASCII share (percent of code points) for Extract to engage. */
const MIN_ASCII_PCT = 60;

// Structural markers: content containing these must survive verbatim.
const STRUCTURAL_MARKERS = ["```", "Traceback (most recent call last)"];

// Common abbreviations that end with '.' but do not end a sentence.
const ABBREVIATIONS = new Set([
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st",
    "vs", "etc", "e.g", "i.e", "cf", "al", "approx",
    "no", "fig", "eq", "sec", "min", "max", "avg",
]);

// Filler/hedging sentence openers (lowercased, checked as prefixes).
const FILLER_OPENERS = [
    "basically",
    "essentially",
    "as mentioned",
    "as noted",
    "as discussed",
    "as you can see",
    "in other words",
    "needless to say",
    "it goes without saying",
    "to be honest",
    "in my opinion",
    "i think that",
    "it is worth noting",
    "it's worth noting",
    "obviously",
    "of course",
];

// Prohibitions ("do not touch prod") are kept UNCONDITIONALLY — they score
// worst under term-rarity statistics (short, stopword-heavy) yet losing one
// can cause real damage downstream. A boost only makes survival likely; for
// prohibitions, likely isn't good enough.
const PROHIBITION_MARKERS = ["do not", "don't", "must not", "never "];

// Softer imperative/constraint markers (lowercased substring match) — these
// get a score boost rather than a guarantee.
const CONSTRAINT_MARKERS = [
    "must ",
    "always",
    "only ",
    "except",
    "required",
    "important",
    "warning",
    "note:",
    "make sure",
    "be careful",
];

// Anaphoric/connective sentence openers: the sentence leans on its
// predecessor for meaning, so selection pulls the predecessor in.
const ANAPHORIC_OPENERS = new Set([
    "this", "that", "these", "those", "it", "they",
    "however", "therefore", "thus", "so", "consequently",
    "instead", "otherwise", "also", "additionally", "hence",
]);

// A compact English stopword list. Deliberately small and closed: these terms
// carry near-zero retrieval information; everything else counts.
const STOPWORDS = new Set([
    "a", "an", "the", "and", "or", "but", "if", "then", "else", "when",
    "at", "by", "for", "with", "about", "against", "between", "into",
    "through", "during", "before", "after", "above", "below", "to", "from",
    "up", "down", "in", "out", "on", "off", "over", "under", "again",
    "further", "once", "here", "there", "all", "any", "both", "each",
    "few", "more", "most", "other", "some", "such", "only", "own", "same",
    "so", "than", "too", "very", "can", "will", "just", "should", "now",
    "is", "are", "was", "were", "be", "been", "being", "have", "has",
    "had", "having", "do", "does", "did", "doing", "would", "could",
    "ought", "i", "you", "he", "she", "it", "we", "they", "them", "his",
    "her", "its", "our", "their", "this", "that", "these", "those", "am",
    "of", "as", "not", "no", "nor", "what", "which", "who", "whom",
]);

// ------------------------------------------------------------------------ //
// Public compressor
// ------------------------------------------------------------------------ //

export interface ExtractOptions {
    /** Fraction of tokens to keep (0..1]. Lower = more aggressive. */
    ratio?: number;
}

/** Block-aware, weights-free extractive compressor. */
export class Extract implements Compressor {
    readonly name = "extract";
    readonly ratio: number;
    /** ratio in integer thousandths — the value the spec operates on. */
    readonly ratioMillis: number;

    constructor(options: ExtractOptions = {}) {
        const r = options.ratio ?? DEFAULT_RATIO;
        if (!(r > 0 && r <= 1)) {
            throw new RangeError(`Extract ratio must be in (0, 1], got ${r}`);
        }
        this.ratio = r;
        this.ratioMillis = Math.round(r * 1000);
    }

    compress(messages: ChatMessage[]): CompressResult {
        if (messages.length === 0) {
            return [messages, makeStats({ method: "extract" })];
        }
        // Short-circuit when there's nothing to compress anywhere in the span.
        if (!messages.some((m) => getTextContent(m).trim())) {
            return [messages, makeStats({ method: "extract" })];
        }

        const out: ChatMessage[] = [];
        let totalIn = 0;
        let totalOut = 0;
        for (const msg of messages) {
            const [newMsg, inTok, outTok] = this.compressMessage(msg);
            out.push(newMsg);
            totalIn += inTok;
            totalOut += outTok;
        }
        return [
            out,
            makeStats({
                inputTokens: totalIn,
                outputTokens: totalOut,
                ratio: totalIn ? totalOut / totalIn : 1.0,
                method: "extract",
            }),
        ];
    }

    async compressAsync(messages: ChatMessage[]): Promise<CompressResult> {
        return this.compress(messages);
    }

    // ------------------------------------------------------------------ //
    // Per-message / per-block handling (structural safety)
    // ------------------------------------------------------------------ //

    private compressMessage(msg: ChatMessage): [ChatMessage, number, number] {
        const content = msg.content;

        if (typeof content === "string") {
            if (!content.trim()) {
                return [msg, 0, 0];
            }
            const [compressed, inTok, outTok] = this.compressText(content);
            return [{ ...msg, content: compressed }, inTok, outTok];
        }

        if (Array.isArray(content)) {
            const newBlocks: unknown[] = [];
            let totalIn = 0;
            let totalOut = 0;
            for (const block of content) {
                const [nb, inTok, outTok] = this.compressBlock(block);
                newBlocks.push(nb);
                totalIn += inTok;
                totalOut += outTok;
            }
            return [{ ...msg, content: newBlocks }, totalIn, totalOut];
        }

        // Unknown shape (null, object, etc.) — pass through.
        return [msg, 0, 0];
    }

    private compressBlock(block: unknown): [unknown, number, number] {
        if (block === null || typeof block !== "object") {
            return [block, 0, 0];
        }
        const b = block as Record<string, unknown>;
        const btype = typeof b.type === "string" ? b.type : "";

        if (btype === "text") {
            const text = b.text;
            if (typeof text === "string" && text.trim()) {
                const [compressed, inTok, outTok] = this.compressText(text);
                return [{ ...b, text: compressed }, inTok, outTok];
            }
            return [block, 0, 0];
        }

        if (btype === "tool_result") {
            const inner = b.content;
            if (typeof inner === "string") {
                if (!inner.trim()) {
                    return [block, 0, 0];
                }
                // Structural content (code fences, tracebacks) must survive
                // verbatim — a debugger or coding agent needs exact tokens.
                if (looksStructural(inner)) {
                    const tokens = countTokens(inner);
                    return [block, tokens, tokens];
                }
                const [compressed, inTok, outTok] = this.compressText(inner);
                return [{ ...b, content: compressed }, inTok, outTok];
            }
            if (Array.isArray(inner)) {
                const newInner: unknown[] = [];
                let totalIn = 0;
                let totalOut = 0;
                for (const innerBlock of inner) {
                    const [nb, inTok, outTok] = this.compressBlock(innerBlock);
                    newInner.push(nb);
                    totalIn += inTok;
                    totalOut += outTok;
                }
                return [{ ...b, content: newInner }, totalIn, totalOut];
            }
            return [block, 0, 0];
        }

        // Pass-through block types (tool_use, image, thinking, document,
        // unknown). Count tokens so the reported ratio stays honest.
        const text = getTextContent({ role: "", content: [block] });
        const tokens = text ? countTokens(text) : 0;
        return [block, tokens, tokens];
    }

    // ------------------------------------------------------------------ //
    // The extractive algorithm on raw text
    // ------------------------------------------------------------------ //

    /** Returns [compressedText, inputTokens, outputTokens]. */
    private compressText(text: string): [string, number, number] {
        const inTok = countTokens(text);

        // Never touch structural text even if a caller routes it here.
        if (looksStructural(text)) {
            return [text, inTok, inTok];
        }
        if (inTok < MIN_SPAN_TOKENS) {
            return [text, inTok, inTok];
        }
        // Latin-script guard: sentence segmentation and stopword statistics
        // assume space-delimited text; low-ASCII spans pass through.
        if (!mostlyAscii(text)) {
            return [text, inTok, inTok];
        }

        const sentences = segmentSentences(text);
        if (sentences.length < MIN_SENTENCES_TO_COMPRESS) {
            return [text, inTok, inTok];
        }

        const compressed = selectSentences(sentences, this.ratioMillis);
        const outTok = countTokens(compressed);

        // Guard: if selection failed to save anything meaningful, return the
        // original (never emit a mangled equal-size result).
        if (outTok >= inTok) {
            return [text, inTok, inTok];
        }
        return [compressed, inTok, outTok];
    }
}

// ------------------------------------------------------------------------ //
// Pure helpers (exported for tests and for the parity vector generator)
// ------------------------------------------------------------------------ //

export function looksStructural(text: string): boolean {
    return STRUCTURAL_MARKERS.some((m) => text.includes(m));
}

/** ASCII-lowercase only; non-ASCII code points unchanged (parity rule). */
export function asciiLower(text: string): string {
    let out = "";
    for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        out += cp >= 0x41 && cp <= 0x5a ? String.fromCodePoint(cp + 32) : ch;
    }
    return out;
}

/** True when ≥ MIN_ASCII_PCT of code points are ASCII. */
export function mostlyAscii(text: string): boolean {
    let ascii = 0;
    let total = 0;
    for (const ch of text) {
        total += 1;
        if (ch.codePointAt(0)! < 0x80) {
            ascii += 1;
        }
    }
    return total === 0 || ascii * 100 >= total * MIN_ASCII_PCT;
}

export interface Sentence {
    text: string;
    /** Line came from a markdown list / table row — exempt from redundancy. */
    listItem: boolean;
}

/**
 * Split text into sentence-ish units. Newline-separated lines are hard
 * boundaries; within a line we split after .!? followed by whitespace,
 * protecting decimals ("3.14" has no space after the dot), single-letter
 * initials ("J. Smith") and common abbreviations ("e.g.", "Dr.").
 * List/table lines are kept whole and marked.
 */
export function segmentSentences(text: string): Sentence[] {
    const out: Sentence[] = [];
    for (const rawLine of text.split("\n")) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }
        if (isListLine(line)) {
            out.push({ text: line, listItem: true });
            continue;
        }
        if ([...line].length <= MIN_SENTENCE_CHARS) {
            out.push({ text: line, listItem: false });
            continue;
        }
        let start = 0;
        for (let i = 0; i < line.length - 1; i++) {
            const ch = line[i]!;
            if (ch !== "." && ch !== "!" && ch !== "?") {
                continue;
            }
            const next = line[i + 1]!;
            if (next !== " " && next !== "\t") {
                continue; // no space after — decimal, URL, file.ext
            }
            if (ch === ".") {
                const prev = lastWordBefore(line, i);
                if (ABBREVIATIONS.has(asciiLower(prev))) {
                    continue;
                }
                // Single capital letter → initials ("J. Smith").
                if (prev.length === 1 && prev >= "A" && prev <= "Z") {
                    continue;
                }
            }
            const piece = line.slice(start, i + 1).trim();
            if (piece) {
                out.push({ text: piece, listItem: false });
            }
            start = i + 1;
        }
        const rest = line.slice(start).trim();
        if (rest) {
            out.push({ text: rest, listItem: false });
        }
    }
    return out;
}

/** Markdown list item ("- x", "* x", "+ x", "1. x", "2) x") or table row. */
function isListLine(line: string): boolean {
    if (line.startsWith("|")) {
        return true;
    }
    if (
        (line.startsWith("- ") || line.startsWith("* ") || line.startsWith("+ ")) &&
        line.length > 2
    ) {
        return true;
    }
    // Digits then "." or ")" then space.
    let i = 0;
    while (i < line.length && line[i]! >= "0" && line[i]! <= "9") {
        i += 1;
    }
    if (i > 0 && i < line.length - 1) {
        const mark = line[i]!;
        if ((mark === "." || mark === ")") && line[i + 1] === " ") {
            return true;
        }
    }
    return false;
}

function lastWordBefore(line: string, dotIndex: number): string {
    let start = dotIndex;
    while (start > 0) {
        const cp = line.codePointAt(start - 1)!;
        if (isWordChar(cp) || line[start - 1] === ".") {
            start -= 1;
        } else {
            break;
        }
    }
    // "e.g" / "i.e" keep their inner dot; strip only leading dots.
    let word = line.slice(start, dotIndex);
    while (word.startsWith(".")) {
        word = word.slice(1);
    }
    return word;
}

/** ASCII-lowercased word tokens (isWordChar runs) of a text. */
export function wordTokens(text: string): string[] {
    const out: string[] = [];
    let run = "";
    for (const ch of asciiLower(text)) {
        if (isWordChar(ch.codePointAt(0)!)) {
            run += ch;
        } else if (run) {
            out.push(run);
            run = "";
        }
    }
    if (run) {
        out.push(run);
    }
    return out;
}

/** Bit length of a non-negative integer (0 → 0). Integer log2 surrogate. */
export function bitLength(n: number): number {
    let bits = 0;
    while (n > 0) {
        bits += 1;
        n = Math.floor(n / 2);
    }
    return bits;
}

interface ScoredSentence {
    index: number;
    text: string;
    listItem: boolean;
    tokens: number;
    score: number;
    anaphoric: boolean;
    /** Lowercased tokens that contain an ASCII digit (redundancy guard). */
    digitTokens: string[];
}

/**
 * Score all sentences, greedily select the best until the kept token budget
 * (ratioMillis/1000 × total) is reached, apply the redundancy filter and the
 * anaphora keep-with-previous rule, and reassemble survivors in original
 * order.
 */
export function selectSentences(sentences: Sentence[], ratioMillis: number): string {
    // --- term statistics over the whole span --- //
    const termCounts = new Map<string, number>();
    let totalTerms = 0;
    const tokenized: string[][] = [];
    for (const s of sentences) {
        const words = wordTokens(s.text);
        tokenized.push(words);
        for (const w of words) {
            if (STOPWORDS.has(w)) {
                continue;
            }
            termCounts.set(w, (termCounts.get(w) ?? 0) + 1);
            totalTerms += 1;
        }
    }

    const scored: ScoredSentence[] = sentences.map((s, index) => {
        const words = tokenized[index]!;
        return {
            index,
            text: s.text,
            listItem: s.listItem,
            tokens: countTokens(s.text),
            score: scoreSentence(
                s.text,
                words,
                index,
                sentences.length,
                termCounts,
                totalTerms,
            ),
            anaphoric: words.length > 0 && ANAPHORIC_OPENERS.has(words[0]!),
            digitTokens: words.filter((w) => hasAsciiDigit(w)),
        };
    });

    const totalTokens = scored.reduce((acc, s) => acc + s.tokens, 0);

    // Rank by score descending; ties break toward the earlier sentence.
    const ranked = [...scored].sort(
        (a, b) => b.score - a.score || a.index - b.index,
    );

    const keptByIndex = new Map<number, ScoredSentence>();
    let keptTokens = 0;
    const underBudget = () => keptTokens * 1000 < ratioMillis * totalTokens;

    // Prohibitions are kept unconditionally, charged to the budget up front.
    for (const s of scored) {
        const lower = asciiLower(s.text);
        if (PROHIBITION_MARKERS.some((m) => lower.includes(m))) {
            keptByIndex.set(s.index, s);
            keptTokens += s.tokens;
        }
    }

    for (const cand of ranked) {
        if (!underBudget()) {
            break;
        }
        if (keptByIndex.has(cand.index)) {
            continue; // already pulled in by an anaphoric successor
        }
        if (isRedundant(cand, [...keptByIndex.values()])) {
            continue;
        }
        keptByIndex.set(cand.index, cand);
        keptTokens += cand.tokens;

        // Anaphora rule: a kept sentence that opens with a connective marker
        // leans on its predecessor — pull the predecessor in (charged to the
        // budget) so the survivor still has its antecedent.
        if (cand.anaphoric && cand.index > 0 && !keptByIndex.has(cand.index - 1)) {
            const prev = scored[cand.index - 1]!;
            keptByIndex.set(prev.index, prev);
            keptTokens += prev.tokens;
        }
    }

    // Always keep at least one sentence.
    if (keptByIndex.size === 0 && ranked.length > 0) {
        const first = ranked[0]!;
        keptByIndex.set(first.index, first);
    }

    const kept = [...keptByIndex.values()].sort((a, b) => a.index - b.index);
    return kept.map((s) => s.text).join(" ");
}

function hasAsciiDigit(word: string): boolean {
    for (let i = 0; i < word.length; i++) {
        const c = word[i]!;
        if (c >= "0" && c <= "9") {
            return true;
        }
    }
    return false;
}

function scoreSentence(
    text: string,
    words: string[],
    index: number,
    sentenceCount: number,
    termCounts: Map<string, number>,
    totalTerms: number,
): number {
    if (words.length === 0) {
        return 0;
    }

    // Information score: length-normalized sum of integer term weights.
    // weight(term) = bitLength(totalTerms // count) — an integer -log2
    // surrogate: rare terms (count=1) get the highest weight.
    let info = 0;
    for (const w of words) {
        if (STOPWORDS.has(w)) {
            continue;
        }
        const count = termCounts.get(w) ?? 1;
        info += bitLength(Math.floor(Math.max(1, totalTerms) / count));
    }
    let score = Math.floor((info * SCALE) / words.length);

    const lower = asciiLower(text);

    // Boosts for information-dense surface signals.
    if (containsAsciiDigit(text)) {
        score += BOOST_DIGITS;
    }
    if (hasNonInitialCapitalizedWord(text)) {
        score += BOOST_ENTITY;
    }
    if (hasQuotedSpan(text)) {
        score += BOOST_QUOTED;
    }
    if (hasIdentifierToken(text)) {
        score += BOOST_IDENTIFIER;
    }
    if (index === 0 || index === sentenceCount - 1) {
        score += BOOST_POSITION;
    }
    // Constraints/imperatives ("Do not touch prod.") are short and score
    // worst under rarity statistics, yet are the costliest to lose.
    if (CONSTRAINT_MARKERS.some((m) => lower.includes(m))) {
        score += BOOST_IMPERATIVE;
    }
    if (FILLER_OPENERS.some((f) => lower.startsWith(f))) {
        score -= PENALTY_FILLER;
    }

    return score;
}

function containsAsciiDigit(text: string): boolean {
    for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        if (c >= "0" && c <= "9") {
            return true;
        }
    }
    return false;
}

/** A capitalized (Xxx…) word that is not the first word → likely an entity. */
function hasNonInitialCapitalizedWord(text: string): boolean {
    let wordStart = true;
    let firstWord = true;
    let inWord = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        const isAlpha = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
        if (isAlpha && !inWord) {
            // start of a word
            if (!firstWord && wordStart && c >= "A" && c <= "Z") {
                // needs a following lowercase letter to look like a name
                const n1 = text[i + 1];
                if (n1 !== undefined && n1 >= "a" && n1 <= "z") {
                    return true;
                }
            }
            inWord = true;
        } else if (!isAlpha && inWord) {
            inWord = false;
            firstWord = false;
            wordStart = c === " " || c === "\t";
            continue;
        }
        if (!isAlpha) {
            wordStart = c === " " || c === "\t";
        }
    }
    return false;
}

/** A quoted span of ≥ 3 code points between matching " ' or ` quotes. */
function hasQuotedSpan(text: string): boolean {
    for (const q of ['"', "'", "`"]) {
        const first = text.indexOf(q);
        if (first === -1) {
            continue;
        }
        const second = text.indexOf(q, first + 1);
        if (second !== -1 && second - first > 3) {
            return true;
        }
    }
    return false;
}

/** Identifier/path-ish token: alnum runs joined by _ . / or - (e.g. foo_bar,
 * src/main.rs, api.example.com, retry-count). */
function hasIdentifierToken(text: string): boolean {
    const isAlnum = (c: string) =>
        (c >= "0" && c <= "9") || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
    for (let i = 1; i < text.length - 1; i++) {
        const c = text[i]!;
        if (c === "_" || c === "/" || c === "-" || c === ".") {
            if (isAlnum(text[i - 1]!) && isAlnum(text[i + 1]!)) {
                return true;
            }
        }
    }
    return false;
}

/** 3-word shingle set of a token list. */
function shingles(words: string[]): Set<string> {
    const out = new Set<string>();
    if (words.length < 3) {
        if (words.length > 0) {
            out.add(words.join(" "));
        }
        return out;
    }
    for (let i = 0; i + 3 <= words.length; i++) {
        out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    }
    return out;
}

function isRedundant(cand: ScoredSentence, kept: ScoredSentence[]): boolean {
    if (kept.length === 0 || cand.listItem) {
        // List items read as near-duplicates of their siblings (parallel
        // phrasing) but each carries distinct content — never drop as
        // redundant.
        return false;
    }
    const candShingles = shingles(wordTokens(cand.text));
    if (candShingles.size === 0) {
        return false;
    }
    for (const k of kept) {
        const ks = shingles(wordTokens(k.text));
        let intersection = 0;
        for (const s of candShingles) {
            if (ks.has(s)) {
                intersection += 1;
            }
        }
        const union = candShingles.size + ks.size - intersection;
        if (union > 0 && intersection * 100 > REDUNDANCY_PCT * union) {
            // Digit-diff guard: log-like twins that differ in a number
            // ("retry 1 failed" vs "retry 4 succeeded") are all signal.
            if (!sameDigitTokens(cand.digitTokens, k.digitTokens)) {
                continue;
            }
            return true;
        }
    }
    return false;
}

function sameDigitTokens(a: string[], b: string[]): boolean {
    if (a.length !== b.length) {
        return false;
    }
    const sa = [...a].sort();
    const sb = [...b].sort();
    for (let i = 0; i < sa.length; i++) {
        if (sa[i] !== sb[i]) {
            return false;
        }
    }
    return true;
}
