#!/usr/bin/env bun
/**
 * Bench mode 3: real-workload measurement.
 *
 * Runs an actual conversation export through the real `Middleware`
 * end-to-end and reports what leanprompt would have saved on it — answers
 * "what would I save on THIS traffic", not "is the algorithm good in the
 * abstract" (that's run-quality.ts).
 *
 * Usage:
 *   bun bench/run-workload.ts --file <messages.json> [--config <config.json>] [--price-per-1k <usd>]
 *
 * <messages.json>: a JSON array of {role, content} messages (OpenAI- or
 *   Anthropic-shaped), e.g. anything under bench/corpora/.
 * <config.json>: optional leanprompt config (same shape as LeanpromptConfig);
 *   defaults to `{ mode: "on", routing: { prose: "extract" } }` if omitted.
 * --price-per-1k: optional USD price per 1000 input tokens. Deliberately
 *   NOT hardcoded to any provider's current pricing (that goes stale) — pass
 *   your own rate to see a dollar estimate, or omit it for tokens only.
 */

import { readFileSync } from "node:fs";
import { Middleware } from "../ts/src/middleware.js";
import type { ChatMessage, LeanpromptConfig } from "../ts/src/types.js";

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

const filePath = arg("--file");
if (!filePath) {
    console.error("usage: bun bench/run-workload.ts --file <messages.json> [--config <config.json>] [--price-per-1k <usd>]");
    process.exit(2);
}

const configPath = arg("--config");
const config: LeanpromptConfig = configPath
    ? JSON.parse(readFileSync(configPath, "utf8"))
    : { mode: "on", routing: { prose: "extract" } };

const pricePer1kArg = arg("--price-per-1k");
const pricePer1k = pricePer1kArg !== undefined ? Number(pricePer1kArg) : undefined;
if (pricePer1kArg !== undefined && !(Number.isFinite(pricePer1k) && pricePer1k! >= 0)) {
    console.error(`--price-per-1k must be a non-negative number, got ${pricePer1kArg}`);
    process.exit(2);
}

const messages: ChatMessage[] = JSON.parse(readFileSync(filePath, "utf8"));
if (!Array.isArray(messages)) {
    console.error(`${filePath} must contain a JSON array of messages`);
    process.exit(2);
}

const mw = new Middleware(config);
const [, stats] = mw.compressMessages(messages);

const saved = stats.inputTokens - stats.outputTokens;
const savedPct = stats.inputTokens ? (saved / stats.inputTokens) * 100 : 0;

console.log(`leanprompt bench: workload measurement`);
console.log(`  file:    ${filePath}`);
console.log(`  config:  ${configPath ?? "(default: mode=on, routing.prose=extract)"}`);
console.log(`  messages: ${messages.length}`);
console.log(`  method:   ${stats.method}`);
console.log(`  input tokens:  ${stats.inputTokens}`);
console.log(`  output tokens: ${stats.outputTokens}`);
console.log(`  tokens saved:  ${saved} (${savedPct.toFixed(1)}%)`);

if (pricePer1k !== undefined) {
    const before = (stats.inputTokens / 1000) * pricePer1k;
    const after = (stats.outputTokens / 1000) * pricePer1k;
    console.log(`  estimated cost @ $${pricePer1k}/1k tokens: $${before.toFixed(4)} -> $${after.toFixed(4)} (saved $${(before - after).toFixed(4)})`);
}

if (stats.method === "below-threshold") {
    console.log(
        "\n  Note: this workload's total tokens are below trigger.thresholdTokens " +
            "(default 2000) so nothing was compressed. Pass a smaller threshold " +
            "in --config to measure compression on short workloads.",
    );
} else if (saved === 0) {
    console.log(
        "\n  Note: compression ran (method != below-threshold) but achieved zero\n" +
            "  savings. On short conversations this is usually protect.lastTurns\n" +
            "  (default: the last 2 messages are always verbatim) shielding the\n" +
            "  only message(s) long enough for Extract to act on — try\n" +
            '  {"protect":{"lastTurns":0}} in --config to see the algorithm\'s\n' +
            "  effect in isolation. It can also mean every message classified as\n" +
            "  code/error/structured (routed verbatim by design) or every prose\n" +
            "  span fell below Extract's minimum-length guards.",
    );
}
