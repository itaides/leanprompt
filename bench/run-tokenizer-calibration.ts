#!/usr/bin/env bun
/**
 * Bench mode 4: token-estimator calibration against real tokenizers.
 *
 * leanprompt's `countTokens` is a zero-dependency heuristic (see
 * ts/src/tokens.ts). The README says to "expect divergence" from the
 * provider's real BPE count; this script measures that divergence so the
 * number can be quoted instead of hand-waved.
 *
 * Compares the estimator against:
 *   - OpenAI `o200k_base` (gpt-4o / gpt-4.1 / gpt-5 families) via js-tiktoken
 *   - OpenAI `cl100k_base` (gpt-3.5 / gpt-4) via js-tiktoken
 *   - Anthropic's /v1/messages/count_tokens endpoint, only when
 *     ANTHROPIC_API_KEY is set (network call; otherwise skipped)
 *
 * over every message in bench/corpora/ plus a small fixed set of
 * per-script probes (English, code, JSON, Cyrillic, CJK, Thai, mixed).
 *
 * Reports, per corpus / probe and per tokenizer: estimated tokens, actual
 * tokens, and the ratio estimate/actual. A ratio of 1.00 is perfect; < 1
 * means the estimator undercounts (compression triggers later than the
 * configured threshold would suggest), > 1 means it overcounts.
 *
 * This is a reporting tool, not a gate. The estimator is tuned for gating
 * and ratio reporting, not for billing.
 *
 * Usage: bun bench/run-tokenizer-calibration.ts
 *        (first run: cd bench && bun install)
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getEncoding } from "js-tiktoken";
import { getTextContent } from "../ts/src/content.js";
import { countTokens } from "../ts/src/tokens.js";
import type { ChatMessage } from "../ts/src/types.js";

const CORPORA_DIR = join(import.meta.dir, "corpora");
const RESULTS_PATH = join(import.meta.dir, "results", "tokenizer-calibration.md");

// Fixed probes: one per content class the estimator makes a distinct
// decision about. Kept short and self-contained so the numbers are stable.
const PROBES: Record<string, string> = {
    "english-prose":
        "The deployment finished at 14:32 UTC after the second retry. Latency on the " +
        "checkout service dropped from 480ms to 210ms once the connection pool was " +
        "raised to 64, and error rates stayed under 0.1% for the rest of the window.",
    "code-typescript":
        "export async function fetchUser(id: string): Promise<User | null> {\n" +
        "    const res = await fetch(`${BASE_URL}/users/${encodeURIComponent(id)}`);\n" +
        "    if (!res.ok) return null;\n" +
        "    return (await res.json()) as User;\n}\n",
    json:
        '{"id":"usr_8f3a","email":"a@example.com","roles":["admin","billing"],' +
        '"created_at":"2026-03-04T09:12:44Z","limits":{"rps":250,"burst":1000}}',
    cyrillic:
        "Развёртывание завершилось после второй попытки. Задержка на сервисе оплаты " +
        "снизилась с 480 мс до 210 мс, а доля ошибок оставалась ниже 0,1%.",
    "cjk-japanese":
        "二回目の再試行の後にデプロイが完了しました。決済サービスの遅延は480ミリ秒から" +
        "210ミリ秒に低下し、エラー率は0.1%未満を維持しました。",
    "cjk-chinese":
        "第二次重试后部署完成。结账服务的延迟从480毫秒降至210毫秒，错误率在整个窗口期内保持在0.1%以下。",
    thai:
        "การปรับใช้เสร็จสิ้นหลังจากลองใหม่ครั้งที่สอง ความหน่วงของบริการชำระเงินลดลงจาก 480 มิลลิวินาที " +
        "เป็น 210 มิลลิวินาที และอัตราข้อผิดพลาดต่ำกว่า 0.1%",
    "mixed-log":
        "2026-10-11T10:18:18.754Z WARN retry=3 upstream=api.example.com/v2/orders " +
        "status=503 backoff=1600ms trace=4f9c2e1a-77b0-4d3e-9a1c-0e5b2f6d8c13",
};

interface Sample {
    name: string;
    texts: string[];
}

interface Row {
    sample: string;
    estimated: number;
    actual: Record<string, number | null>;
}

function loadCorpora(): Sample[] {
    return readdirSync(CORPORA_DIR)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => {
            const messages = JSON.parse(readFileSync(join(CORPORA_DIR, f), "utf8")) as ChatMessage[];
            return {
                name: `corpus:${f.replace(/\.json$/, "")}`,
                texts: messages.map((m) => getTextContent(m)).filter((t) => t.length > 0),
            };
        });
}

const o200k = getEncoding("o200k_base");
const cl100k = getEncoding("cl100k_base");

function tiktokenCount(enc: { encode(text: string): number[] }, texts: string[]): number {
    return texts.reduce((acc, t) => acc + enc.encode(t).length, 0);
}

async function anthropicCount(texts: string[]): Promise<number | null> {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
        return null;
    }
    let total = 0;
    for (const text of texts) {
        const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
                model: "claude-haiku-4-5",
                messages: [{ role: "user", content: text }],
            }),
        });
        if (!res.ok) {
            throw new Error(`count_tokens HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        }
        const json = (await res.json()) as { input_tokens: number };
        total += json.input_tokens;
    }
    return total;
}

// Anthropic's count includes a small fixed per-request overhead for the
// message framing. Measure it once with a trivially short message and
// subtract it per text, so the comparison is text-to-text like tiktoken's.
async function anthropicOverhead(): Promise<number> {
    const base = await anthropicCount(["a"]);
    return base === null ? 0 : Math.max(0, base - 1);
}

function ratio(est: number, actual: number | null): string {
    if (actual === null) return "n/a";
    return (est / actual).toFixed(2);
}

async function main(): Promise<void> {
    const samples: Sample[] = [
        ...loadCorpora(),
        ...Object.entries(PROBES).map(([name, text]) => ({ name: `probe:${name}`, texts: [text] })),
    ];
    const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
    const overhead = hasAnthropic ? await anthropicOverhead() : 0;

    const rows: Row[] = [];
    for (const s of samples) {
        const estimated = s.texts.reduce((acc, t) => acc + countTokens(t), 0);
        const anthropicRaw = await anthropicCount(s.texts);
        rows.push({
            sample: s.name,
            estimated,
            actual: {
                o200k_base: tiktokenCount(o200k, s.texts),
                cl100k_base: tiktokenCount(cl100k, s.texts),
                anthropic:
                    anthropicRaw === null ? null : anthropicRaw - overhead * s.texts.length,
            },
        });
    }

    const tokenizers = ["o200k_base", "cl100k_base", "anthropic"] as const;
    const lines: string[] = [];
    lines.push("# Token estimator calibration");
    lines.push("");
    lines.push(
        "`countTokens` (ts/src/tokens.ts) vs real tokenizers. Ratio = estimate / actual; " +
            "1.00 is exact, < 1 undercounts, > 1 overcounts. " +
            (hasAnthropic
                ? "Anthropic column measured via /v1/messages/count_tokens (claude-haiku-4-5), per-request framing overhead subtracted."
                : "Anthropic column skipped (set ANTHROPIC_API_KEY to include it)."),
    );
    lines.push("");
    lines.push("| sample | estimated | " + tokenizers.map((t) => `${t} actual | ratio`).join(" | ") + " |");
    lines.push("|---|---:|" + tokenizers.map(() => "---:|---:").join("|") + "|");
    for (const r of rows) {
        const cells = tokenizers.map((t) => {
            const a = r.actual[t];
            return `${a === null ? "n/a" : a} | ${ratio(r.estimated, a)}`;
        });
        lines.push(`| ${r.sample} | ${r.estimated} | ${cells.join(" | ")} |`);
    }
    lines.push("");

    // Aggregate error band over the corpora only (the probes are deliberately
    // adversarial single sentences and would dominate a mean).
    for (const t of tokenizers) {
        const corpusRows = rows.filter((r) => r.sample.startsWith("corpus:") && r.actual[t] !== null);
        if (corpusRows.length === 0) continue;
        const ratios = corpusRows.map((r) => r.estimated / (r.actual[t] as number));
        const min = Math.min(...ratios).toFixed(2);
        const max = Math.max(...ratios).toFixed(2);
        lines.push(`- ${t}: corpus ratios range ${min}-${max}`);
    }
    lines.push("");
    lines.push("Generated by `bun bench/run-tokenizer-calibration.ts`.");

    const report = lines.join("\n") + "\n";
    writeFileSync(RESULTS_PATH, report);
    console.log(report);
}

await main();
