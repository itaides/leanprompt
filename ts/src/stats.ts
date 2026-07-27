/**
 * CompressionStats — telemetry shape shared by every compression call.
 *
 * Attached to each response as `usage.leanpromptTokensSaved`,
 * `usage.leanpromptRatio`, and `usage.leanpromptMethod` — camelCase variants
 * of the Python SDK's underscore_case for JS idiom.
 */

export interface CompressionStats {
    inputTokens: number;
    outputTokens: number;
    ratio: number;
    method: string;
    costUsd: number;
}

/** Build a CompressionStats with sensible defaults for any omitted field. */
export function makeStats(partial: Partial<CompressionStats> = {}): CompressionStats {
    return {
        inputTokens: partial.inputTokens ?? 0,
        outputTokens: partial.outputTokens ?? 0,
        ratio: partial.ratio ?? 1.0,
        method: partial.method ?? "passthrough",
        costUsd: partial.costUsd ?? 0.0,
    };
}

export function passthroughStats(): CompressionStats {
    return makeStats({ method: "passthrough" });
}
