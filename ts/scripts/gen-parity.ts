/**
 * Golden parity vector generator.
 *
 * Runs the ts/ reference implementation over a fixed corpus and emits
 * language-neutral JSON vectors to ../parity/. The Rust and Go ports assert
 * byte/structural equality against these files.
 *
 * Parity rules (see docs/parity-spec.md):
 *   - vectors contain TEXT and INTEGERS only — never floats
 *   - regenerate with: bun scripts/gen-parity.ts  (from ts/)
 *   - vectors are committed; CI fails if regeneration produces a diff
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classify, RepeatTracker } from "../src/classifier.js";
import { Extract, segmentSentences, selectSentences, wordTokens } from "../src/compressors/extract.js";
import { getTextContent } from "../src/content.js";
import { Middleware } from "../src/middleware.js";
import { DedupStrategy, PurgeErrorsStrategy } from "../src/strategies.js";
import { countTokens } from "../src/tokens.js";
import type { ChatMessage } from "../src/types.js";

const OUT_DIR = join(import.meta.dir, "..", "..", "parity");

// ------------------------------------------------------------------------ //
// Fixed corpus. Append new cases; never mutate existing ones (vector churn
// hides real regressions).
// ------------------------------------------------------------------------ //

const LONG_PROSE = [
    "The deployment pipeline failed at 14:32 UTC on cluster gamma-7 because the credential rotation job removed the token before the release step consumed it.",
    "Basically the whole thing is a matter of unfortunate timing in the scheduler.",
    "The release step retried three times with exponential backoff and then gave up permanently.",
    "The retry logic waited 2s, then 4s, then 8s between the attempts before failing.",
    "Engineering has been informed about the incident and they are looking into it now.",
    "The team decided to pin the rotation job to run only after release windows close.",
    "This decision prevents the race condition from recurring in future deployments.",
    "Do not restart the rotation job manually while a release is in progress.",
    "As mentioned earlier, the timing issue is the root cause of the whole problem.",
    "The postmortem document lives at docs/incidents/2026-07-21-gamma.md for reference.",
].join(" ");

const REPETITIVE_PROSE = [
    "The nightly build failed on runner 12 with a disk space exhaustion error.",
    "The nightly build failed on runner 14 with a disk space exhaustion error.",
    "Cleaning the docker cache on each runner freed roughly forty gigabytes of space.",
    "The team added a scheduled cache cleanup job that runs every morning at 06:00.",
    "It also alerts the on-call engineer when free space drops below ten percent.",
].join(" ");

const LISTY_TEXT = [
    "Deployment checklist for the gamma cluster rollout process.",
    "- verify the release branch is green in CI",
    "- announce the deployment window in the operations channel",
    "- pin the credential rotation job before starting",
    "- run the smoke suite against the canary environment",
    "1. take a database snapshot first",
    "2. apply the migration scripts in order",
    "The rollback procedure is documented in runbooks/gamma-rollback.md for emergencies.",
].join("\n");

const CODE_TEXT = "import os\nfrom sys import path\n\ndef main():\n    return path";
const FENCED_TEXT = "Here is the fix:\n```py\nprint('hi')\n```";
const ERROR_TEXT = "Traceback (most recent call last):\n  File \"x.py\", line 1\nValueError: nope";
const RUST_PANIC = "thread 'main' panicked at src/main.rs:12:5";
const JSON_BLOB = Array(20)
    .fill('{"id": 123, "name": "row", "status": "ok", "tags": ["a"]},')
    .join("\n");
const CJK_TEXT = "これは長い日本語の文章です。トークンの推定は難しい。".repeat(10);
const UNICODE_PROSE = "The café's naïve façade—remarkably—survived the 2019 storm über alles.";
const SHORT_ASK = "Please summarize the report.";

const TOOL_MSG: ChatMessage = {
    role: "assistant",
    content: [
        { type: "text", text: "Running the search now." },
        { type: "tool_use", id: "t1", name: "grep", input: { query: "foo", limit: 10, path: "src/" } },
    ],
};
const TOOL_RESULT_MSG: ChatMessage = {
    role: "user",
    content: [
        { type: "tool_result", tool_use_id: "t1", content: LONG_PROSE },
        { type: "tool_result", tool_use_id: "t2", content: "ok\n```\nraw output\n```" },
    ],
};
const NESTED_DOC_MSG: ChatMessage = {
    role: "user",
    content: [
        { type: "document", source: { data: "doc source data" } },
        { type: "image", source: { data: "base64" } },
        { type: "thinking", thinking: "private" },
        { type: "text", text: "visible text" },
    ],
};

const CONTENT_CASES: Array<{ name: string; message: ChatMessage }> = [
    { name: "plain-string", message: { role: "user", content: "hello world" } },
    { name: "empty", message: { role: "user", content: "" } },
    { name: "tool-use-canonical-json", message: TOOL_MSG },
    { name: "tool-result-nested", message: TOOL_RESULT_MSG },
    { name: "document-image-thinking", message: NESTED_DOC_MSG },
    { name: "unicode", message: { role: "user", content: UNICODE_PROSE } },
];

const CLASSIFIER_CASES: Array<{ name: string; message: ChatMessage }> = [
    { name: "prose", message: { role: "user", content: LONG_PROSE } },
    { name: "code-prefixes", message: { role: "user", content: CODE_TEXT } },
    { name: "fenced", message: { role: "user", content: FENCED_TEXT } },
    { name: "traceback", message: { role: "user", content: ERROR_TEXT } },
    { name: "rust-panic", message: { role: "user", content: RUST_PANIC } },
    { name: "json-blob", message: { role: "user", content: JSON_BLOB } },
    { name: "empty", message: { role: "user", content: "  " } },
    { name: "cjk", message: { role: "user", content: CJK_TEXT } },
];

const TOKEN_CASES = [
    "",
    "hi",
    "hello world",
    "a, b.",
    LONG_PROSE,
    LISTY_TEXT,
    CODE_TEXT,
    JSON_BLOB,
    CJK_TEXT,
    UNICODE_PROSE,
    "internationalization antidisestablishmentarianism",
];

const EXTRACT_CASES: Array<{ name: string; text: string; ratioMillis: number }> = [
    { name: "long-prose-500", text: LONG_PROSE, ratioMillis: 500 },
    { name: "long-prose-300", text: LONG_PROSE, ratioMillis: 300 },
    { name: "repetitive-600", text: REPETITIVE_PROSE, ratioMillis: 600 },
    { name: "listy-500", text: LISTY_TEXT, ratioMillis: 500 },
];

// ------------------------------------------------------------------------ //
// Vector emission
// ------------------------------------------------------------------------ //

mkdirSync(OUT_DIR, { recursive: true });

function emit(name: string, data: unknown): void {
    const path = join(OUT_DIR, name);
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
    console.log(`wrote ${path}`);
}

emit(
    "content.json",
    CONTENT_CASES.map((c) => ({
        name: c.name,
        message: c.message,
        text: getTextContent(c.message),
    })),
);

emit(
    "classifier.json",
    CLASSIFIER_CASES.map((c) => ({
        name: c.name,
        message: c.message,
        label: classify(c.message),
    })),
);

// Repeat-tracker sequence vector: same list processed in order.
{
    const seq: ChatMessage[] = [
        { role: "user", content: "same text" },
        { role: "assistant", content: "same text" },
        { role: "user", content: "same text" },
        { role: "user", content: "" },
        TOOL_RESULT_MSG,
        TOOL_RESULT_MSG,
        { role: "user", content: "other" },
    ];
    const tracker = new RepeatTracker();
    emit(
        "repeat-tracker.json",
        seq.map((m, i) => ({ index: i, message: m, isRepeat: tracker.isRepeat(m) })),
    );
}

emit(
    "tokens.json",
    TOKEN_CASES.map((text) => ({ text, tokens: countTokens(text) })),
);

// Strategies: dedup + purge on a fixed conversation.
{
    const conversation: ChatMessage[] = [
        { role: "user", content: "Error: catastrophic failure with a large payload attached here" },
        { role: "user", content: "repeated question" },
        { role: "assistant", content: "answer one" },
        { role: "user", content: "repeated question" },
        { role: "assistant", content: "answer two" },
        { role: "user", content: "final ask" },
    ];
    emit("strategies.json", {
        input: conversation,
        dedup: new DedupStrategy().apply(conversation),
        purgeAfter2: new PurgeErrorsStrategy(2).apply(conversation),
    });
}

// Extract: segmentation, word tokens and selection per case, plus full
// block-aware compression of a mixed message.
emit(
    "extract.json",
    EXTRACT_CASES.map((c) => {
        const sentences = segmentSentences(c.text);
        return {
            name: c.name,
            text: c.text,
            ratioMillis: c.ratioMillis,
            sentences,
            selected: selectSentences(sentences, c.ratioMillis),
        };
    }),
);

emit("word-tokens.json", [
    { text: "Hello, World! x2", tokens: wordTokens("Hello, World! x2") },
    { text: UNICODE_PROSE, tokens: wordTokens(UNICODE_PROSE) },
    { text: LONG_PROSE.slice(0, 200), tokens: wordTokens(LONG_PROSE.slice(0, 200)) },
]);

// Middleware end-to-end (integer stats only; ratio recomputed per language).
{
    const config = {
        mode: "on" as const,
        trigger: { thresholdTokens: 10 },
        routing: { prose: "extract" },
        extract: { ratio: 0.5 },
        protect: { lastTurns: 1 },
    };
    const input: ChatMessage[] = [
        { role: "system", content: LONG_PROSE },
        { role: "user", content: LONG_PROSE },
        { role: "user", content: CODE_TEXT },
        { role: "user", content: JSON_BLOB },
        { role: "user", content: REPETITIVE_PROSE },
        { role: "user", content: SHORT_ASK },
    ];
    const [out, stats] = new Middleware(config).compressMessages(input);
    emit("middleware.json", {
        config,
        input,
        output: out,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        method: stats.method,
    });
}

console.log("done");
