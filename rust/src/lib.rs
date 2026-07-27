//! leanprompt — zero-dependency prompt compression for LLM applications.
//!
//! Rust port of the leanprompt pipeline, implementing `docs/parity-spec.md`.
//! Deterministic and byte-compatible with the TypeScript reference
//! implementation (asserted against the `parity/*.json` golden vectors).
//!
//! Message representation: chat messages are [`json::Value`] objects with a
//! `role` string and a `content` field (string or block list) — the same
//! shapes the OpenAI and Anthropic APIs use on the wire.

pub mod chars;
pub mod classifier;
pub mod compressors;
pub mod content;
pub mod json;
pub mod middleware;
pub mod router;
pub mod sha256;
pub mod stats;
pub mod strategies;
pub mod tokens;

pub use classifier::{classify, ContentType, RepeatTracker};
pub use compressors::extract::Extract;
pub use compressors::selfllm::{HttpPost, SelfLlm, SelfLlmOptions};
pub use compressors::verbatim::Verbatim;
pub use compressors::Compressor;
pub use json::Value;
pub use middleware::{Config, Middleware};
pub use router::Router;
pub use stats::CompressionStats;
pub use strategies::{DedupStrategy, PurgeErrorsStrategy, Strategy};
