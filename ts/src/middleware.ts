/**
 * Middleware — provider-agnostic compression orchestrator.
 *
 * The Middleware is what the SDK wrappers call. It reads config, decides
 * whether to compress, and runs the pipeline:
 *
 *   1. Check mode (off → passthrough)
 *   2. Apply strategies (dedup, purge-errors)
 *   3. Check token budget (below threshold → passthrough)
 *   4. For each message: classify() → Router picks a Compressor → compress
 *   5. Aggregate stats and return.
 */

import { classify } from "./classifier.js";
import type { Compressor } from "./compressors/base.js";
import { Extract } from "./compressors/extract.js";
import { Verbatim } from "./compressors/verbatim.js";
import { Router } from "./router.js";
import type { CompressionStats } from "./stats.js";
import { makeStats } from "./stats.js";
import { DedupStrategy, PurgeErrorsStrategy } from "./strategies.js";
import type { Strategy } from "./strategies.js";
import { countMessageTokens } from "./tokens.js";
import { CONTENT_TYPE_VALUES, ContentType } from "./types.js";
import type { ChatMessage, LeanpromptConfig } from "./types.js";

export type { ChatMessage, LeanpromptConfig } from "./types.js";

const DEFAULT_THRESHOLD_TOKENS = 2000;

// Messages this recent are never handed to a lossy compressor: the tail of
// the conversation carries the live question/instructions, where dropping a
// sentence is costliest. Override via config.protect.lastTurns.
const DEFAULT_PROTECT_LAST_TURNS = 2;

type CompressorFactory = (config: LeanpromptConfig) => Compressor;

/**
 * Factories for Compressor names that appear in routing config. SelfLLM is
 * registered by the provider-client module (Phase C) via registerCompressor —
 * keeping the core middleware import-clean of any network code.
 */
const COMPRESSOR_FACTORIES = new Map<string, CompressorFactory>([
    ["verbatim", () => new Verbatim()],
    ["extract", (cfg) => new Extract({ ratio: cfg.extract?.ratio })],
]);

/** Register (or override) a compressor factory by routing name. */
export function registerCompressor(name: string, factory: CompressorFactory): void {
    COMPRESSOR_FACTORIES.set(name, factory);
}

/** Orchestrates compression across a single SDK call. */
export class Middleware {
    readonly config: LeanpromptConfig;
    private readonly active: boolean;
    private readonly threshold: number;
    private readonly protectLastTurns: number;
    private readonly router: Router;
    private readonly strategies: Strategy[];
    private readonly protector = new Verbatim();

    constructor(config: LeanpromptConfig = {}) {
        this.config = config;

        const mode = String(config.mode ?? "off").toLowerCase();
        this.active = !["off", "passthrough", "disabled"].includes(mode);

        this.threshold =
            config.trigger?.thresholdTokens ?? DEFAULT_THRESHOLD_TOKENS;
        this.protectLastTurns =
            config.protect?.lastTurns ?? DEFAULT_PROTECT_LAST_TURNS;

        this.router = this.buildRouter(config);
        this.strategies = this.active ? buildStrategies(config) : [];
    }

    /**
     * Protection rule: system messages and the last K turns are never handed
     * to a lossy compressor — they carry the live instructions/questions
     * where dropping a sentence is costliest.
     */
    private isProtected(index: number, total: number, msg: ChatMessage): boolean {
        if (msg.role === "system") {
            return true;
        }
        return index >= total - this.protectLastTurns;
    }

    compressMessages(messages: ChatMessage[]): [ChatMessage[], CompressionStats] {
        if (!this.active || messages.length === 0) {
            return [
                messages,
                makeStats({ method: messages.length === 0 ? "empty" : "passthrough" }),
            ];
        }

        for (const strategy of this.strategies) {
            messages = strategy.apply(messages);
        }
        if (messages.length === 0) {
            return [messages, makeStats({ method: "empty" })];
        }

        const inputTokens = countMessageTokens(messages);
        if (inputTokens < this.threshold) {
            return [
                messages,
                makeStats({
                    inputTokens,
                    outputTokens: inputTokens,
                    ratio: 1.0,
                    method: "below-threshold",
                }),
            ];
        }

        const outMsgs: ChatMessage[] = [];
        let totalIn = 0;
        let totalOut = 0;
        let totalCost = 0;
        const methods = new Set<string>();

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i]!;
            const compressor = this.isProtected(i, messages.length, msg)
                ? this.protector
                : this.router.route(classify(msg));
            const [compressed, stats] = compressor.compress([msg]);
            outMsgs.push(...compressed);
            totalIn += stats.inputTokens;
            totalOut += stats.outputTokens;
            totalCost += stats.costUsd;
            methods.add(stats.method);
        }

        return [outMsgs, aggregate(totalIn, totalOut, totalCost, methods)];
    }

    async compressMessagesAsync(
        messages: ChatMessage[],
    ): Promise<[ChatMessage[], CompressionStats]> {
        if (!this.active || messages.length === 0) {
            return [
                messages,
                makeStats({ method: messages.length === 0 ? "empty" : "passthrough" }),
            ];
        }

        for (const strategy of this.strategies) {
            messages = strategy.apply(messages);
        }
        if (messages.length === 0) {
            return [messages, makeStats({ method: "empty" })];
        }

        const inputTokens = countMessageTokens(messages);
        if (inputTokens < this.threshold) {
            return [
                messages,
                makeStats({
                    inputTokens,
                    outputTokens: inputTokens,
                    ratio: 1.0,
                    method: "below-threshold",
                }),
            ];
        }

        const outMsgs: ChatMessage[] = [];
        let totalIn = 0;
        let totalOut = 0;
        let totalCost = 0;
        const methods = new Set<string>();

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i]!;
            const compressor = this.isProtected(i, messages.length, msg)
                ? this.protector
                : this.router.route(classify(msg));
            const [compressed, stats] = await compressor.compressAsync([msg]);
            outMsgs.push(...compressed);
            totalIn += stats.inputTokens;
            totalOut += stats.outputTokens;
            totalCost += stats.costUsd;
            methods.add(stats.method);
        }

        return [outMsgs, aggregate(totalIn, totalOut, totalCost, methods)];
    }

    private buildRouter(config: LeanpromptConfig): Router {
        const router = new Router(null, new Verbatim());
        const routing = config.routing ?? {};

        for (const [ctypeStr, compressorName] of Object.entries(routing)) {
            if (!CONTENT_TYPE_VALUES.has(ctypeStr)) {
                console.warn(
                    `leanprompt: unknown content type ${JSON.stringify(ctypeStr)} in routing config; ignored`,
                );
                continue;
            }
            const factory = COMPRESSOR_FACTORIES.get(compressorName);
            if (factory === undefined) {
                console.warn(
                    `leanprompt: compressor ${JSON.stringify(compressorName)} not available; ` +
                        `falling back to default (verbatim) for ${ctypeStr}`,
                );
                continue;
            }
            router.register(ctypeStr as ContentType, factory(config));
        }

        // STRUCTURED always routes verbatim unless explicitly overridden:
        // sentence-segmenting JSON is meaningless, and even a gentle
        // extractive pass shreds it. (Deliberate deletion of the Python
        // reference's structured→gentler-ratio auto-route.)
        return router;
    }
}

function buildStrategies(config: LeanpromptConfig): Strategy[] {
    const strategiesCfg = config.strategies ?? {};
    const out: Strategy[] = [];

    if (strategiesCfg.dedup ?? true) {
        out.push(new DedupStrategy());
    }

    const purgeCfg = strategiesCfg.purgeErrors ?? true;
    if (purgeCfg) {
        let afterTurns = 4;
        if (typeof purgeCfg === "object") {
            afterTurns = purgeCfg.afterTurns ?? 4;
        }
        out.push(new PurgeErrorsStrategy(afterTurns));
    }

    return out;
}

function aggregate(
    totalIn: number,
    totalOut: number,
    totalCost: number,
    methods: Set<string>,
): CompressionStats {
    let method: string;
    if (methods.size === 0) {
        method = "empty";
    } else if (methods.size === 1) {
        method = methods.values().next().value as string;
    } else {
        method = "hybrid";
    }
    return makeStats({
        inputTokens: totalIn,
        outputTokens: totalOut,
        ratio: totalIn ? totalOut / totalIn : 1.0,
        method,
        costUsd: totalCost,
    });
}
