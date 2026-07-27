#!/usr/bin/env bun
/**
 * Bench mode 1: compression quality vs baselines.
 *
 * Runs the real `Extract` compressor against a naive "keep first+last N%"
 * baseline and plain `verbatim` on every prose-classified message in each
 * corpus under bench/corpora/, at a fixed keep-ratio. Reports, per corpus:
 *
 *   - achieved keep-ratio (Extract vs baseline vs target)
 *   - a retention proxy: fraction of distinct non-stopword terms and
 *     distinct numeric tokens from the original that survive compression
 *     (corpus-agnostic — no hand-picked "probe facts", unlike the narrower
 *     single-string quality gate in ts/test/extract.test.ts, which this
 *     script's baseline function is promoted from)
 *
 * This is a reporting tool, not a pass/fail gate — read the numbers, don't
 * assume the algorithm is "good" just because it beats the naive baseline.
 *
 * Usage: bun bench/run-quality.ts [--ratio 0.5]
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classify } from "../ts/src/classifier.js";
import { getTextContent } from "../ts/src/content.js";
import { Extract, segmentSentences, wordTokens } from "../ts/src/compressors/extract.js";
import { countTokens } from "../ts/src/tokens.js";
import { ContentType } from "../ts/src/types.js";

const CORPORA_DIR = join(import.meta.dir, "corpora");
const RESULTS_PATH = join(import.meta.dir, "results", "quality.json");

const ratioArgIndex = process.argv.indexOf("--ratio");
const ratio = ratioArgIndex >= 0 ? Number(process.argv[ratioArgIndex + 1]) : 0.5;
if (!(ratio > 0 && ratio <= 1)) {
    console.error(`--ratio must be in (0, 1], got ${ratio}`);
    process.exit(2);
}

// ------------------------------------------------------------------------ //
// Naive baseline: keep sentences from the front and back until budget runs
// out. Promoted from the quality-gate test in ts/test/extract.test.ts so the
// same comparison is runnable standalone, on arbitrary corpora.
// ------------------------------------------------------------------------ //
function firstLastBaseline(text: string, keepRatio: number): string {
    const sentences = segmentSentences(text).map((s) => s.text);
    const total = sentences.reduce((a, s) => a + countTokens(s), 0);
    const budget = keepRatio * total;
    const kept = new Set<number>();
    let used = 0;
    let front = 0;
    let back = sentences.length - 1;
    let turn = 0;
    while (front <= back && used < budget) {
        const i = turn % 2 === 0 ? front++ : back--;
        kept.add(i);
        used += countTokens(sentences[i]!);
        turn += 1;
    }
    return sentences.filter((_, i) => kept.has(i)).join(" ");
}

function distinctTerms(text: string): Set<string> {
    return new Set(wordTokens(text));
}

function distinctDigitTerms(text: string): Set<string> {
    const out = new Set<string>();
    for (const w of wordTokens(text)) {
        if (/[0-9]/.test(w)) {
            out.add(w);
        }
    }
    return out;
}

function coverage(original: Set<string>, compressed: Set<string>): number {
    if (original.size === 0) {
        return 1;
    }
    let hit = 0;
    for (const t of original) {
        if (compressed.has(t)) {
            hit += 1;
        }
    }
    return hit / original.size;
}

interface CorpusReport {
    corpus: string;
    proseMessages: number;
    totalMessages: number;
    inputTokens: number;
    extract: { outputTokens: number; ratio: number; termCoverage: number; digitCoverage: number };
    baseline: { outputTokens: number; ratio: number; termCoverage: number; digitCoverage: number };
}

const extractor = new Extract({ ratio });

function evaluateCorpus(name: string, messages: Array<{ role: string; content: unknown }>): CorpusReport {
    let proseMessages = 0;
    let inputTokens = 0;
    let extractOutTokens = 0;
    let baselineOutTokens = 0;
    let termHit = 0;
    let termTotal = 0;
    let digitHit = 0;
    let digitTotal = 0;
    let baselineTermHit = 0;
    let baselineDigitHit = 0;

    for (const msg of messages) {
        if (classify(msg) !== ContentType.PROSE) {
            continue;
        }
        const text = getTextContent(msg);
        const inTok = countTokens(text);
        if (inTok === 0) {
            continue;
        }
        proseMessages += 1;
        inputTokens += inTok;

        const [extracted] = extractor.compress([msg]);
        const extractedText = getTextContent(extracted[0]!);
        extractOutTokens += countTokens(extractedText);

        const baselineText = firstLastBaseline(text, ratio);
        baselineOutTokens += countTokens(baselineText);

        const originalTerms = distinctTerms(text);
        const originalDigits = distinctDigitTerms(text);
        const extractedTerms = distinctTerms(extractedText);
        const extractedDigits = distinctDigitTerms(extractedText);
        const baselineTerms = distinctTerms(baselineText);
        const baselineDigits = distinctDigitTerms(baselineText);

        termTotal += originalTerms.size;
        digitTotal += originalDigits.size;
        for (const t of originalTerms) {
            if (extractedTerms.has(t)) termHit += 1;
            if (baselineTerms.has(t)) baselineTermHit += 1;
        }
        for (const d of originalDigits) {
            if (extractedDigits.has(d)) digitHit += 1;
            if (baselineDigits.has(d)) baselineDigitHit += 1;
        }
    }

    return {
        corpus: name,
        proseMessages,
        totalMessages: messages.length,
        inputTokens,
        extract: {
            outputTokens: extractOutTokens,
            ratio: inputTokens ? extractOutTokens / inputTokens : 1,
            termCoverage: termTotal ? termHit / termTotal : 1,
            digitCoverage: digitTotal ? digitHit / digitTotal : 1,
        },
        baseline: {
            outputTokens: baselineOutTokens,
            ratio: inputTokens ? baselineOutTokens / inputTokens : 1,
            termCoverage: termTotal ? baselineTermHit / termTotal : 1,
            digitCoverage: digitTotal ? baselineDigitHit / digitTotal : 1,
        },
    };
}

const files = readdirSync(CORPORA_DIR).filter((f) => f.endsWith(".json"));
if (files.length === 0) {
    console.error(`No corpora found in ${CORPORA_DIR}`);
    process.exit(1);
}

const reports: CorpusReport[] = [];
console.log(`leanprompt bench: quality vs baseline (target ratio ${ratio})`);
console.log(
    "Note: term/digit coverage are RAW presence proxies (unweighted by\n" +
        "importance) — a baseline can score competitively on them without\n" +
        "understanding content, since first/last sentences are often\n" +
        "term-dense by position alone. They complement, not replace, the\n" +
        "targeted behavior tests in ts/test/extract.test.ts (prohibitions\n" +
        "kept unconditionally, anaphora, structural safety).\n",
);
for (const file of files) {
    const messages = JSON.parse(readFileSync(join(CORPORA_DIR, file), "utf8"));
    const report = evaluateCorpus(file, messages);
    reports.push(report);

    console.log(`${file}`);
    console.log(`  prose messages: ${report.proseMessages}/${report.totalMessages}  input tokens: ${report.inputTokens}`);
    console.log(
        `  extract : ratio ${report.extract.ratio.toFixed(3)}  term-coverage ${(report.extract.termCoverage * 100).toFixed(1)}%  digit-coverage ${(report.extract.digitCoverage * 100).toFixed(1)}%`,
    );
    console.log(
        `  baseline: ratio ${report.baseline.ratio.toFixed(3)}  term-coverage ${(report.baseline.termCoverage * 100).toFixed(1)}%  digit-coverage ${(report.baseline.digitCoverage * 100).toFixed(1)}%`,
    );
    console.log();
}

writeFileSync(RESULTS_PATH, JSON.stringify({ ratio, reports }, null, 2) + "\n");
console.log(`Wrote ${RESULTS_PATH}`);
