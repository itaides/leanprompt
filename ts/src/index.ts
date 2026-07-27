/**
 * leanprompt — drop-in prompt compression for LLM applications.
 *
 * Zero-dependency native implementation: a deterministic compression
 * pipeline (classifier → router → compressors) with the weights-free
 * Extract compressor in place of neural prompt-compression models.
 */

import { registerCompressor } from "./middleware.js";
import { SelfLLM } from "./compressors/selfllm.js";

// Make `routing: { prose: "selfllm" }` work out of the box. Registered here
// (not in middleware.ts) so the core pipeline stays free of network code.
registerCompressor("selfllm", (cfg) => new SelfLLM(cfg.selfllm ?? {}));

export { Anthropic } from "./anthropic.js";
export type { LeanpromptClientOptions, AnthropicMessageParams } from "./anthropic.js";

export { OpenAI } from "./openai.js";
export type { OpenAILeanpromptClientOptions, OpenAIChatParams } from "./openai.js";

export { leanpromptFetch } from "./fetch.js";
export { wrap } from "./wrap.js";

export { SelfLLM } from "./compressors/selfllm.js";
export type { SelfLLMOptions, SelfLLMProvider } from "./compressors/selfllm.js";

export { Middleware, registerCompressor } from "./middleware.js";
export type { ChatMessage, LeanpromptConfig } from "./types.js";
export { ContentType } from "./types.js";

export type { CompressionStats } from "./stats.js";
export { makeStats, passthroughStats } from "./stats.js";

export { classify, RepeatTracker } from "./classifier.js";
export { Router } from "./router.js";
export { DedupStrategy, PurgeErrorsStrategy } from "./strategies.js";
export type { Strategy } from "./strategies.js";

export type { Compressor, CompressResult } from "./compressors/base.js";
export { Verbatim } from "./compressors/verbatim.js";
export { Extract } from "./compressors/extract.js";
export type { ExtractOptions } from "./compressors/extract.js";

export { getTextContent, extractText, canonicalJson } from "./content.js";
export { countTokens, countMessageTokens } from "./tokens.js";

export { attachTelemetry } from "./telemetry.js";

export const VERSION = "0.1.0";
