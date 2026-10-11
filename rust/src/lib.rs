//! leanprompt — zero-dependency prompt compression for LLM applications.
//!
//! Rust port of the leanprompt pipeline, implementing `docs/parity-spec.md`.
//! Deterministic and byte-compatible with the TypeScript reference
//! implementation (asserted against the `parity/*.json` golden vectors).
//!
//! Message representation: chat messages are [`json::Value`] objects with a
//! `role` string and a `content` field (string or block list) — the same
//! shapes the OpenAI and Anthropic APIs use on the wire.
//!
//! The opt-in `serde` cargo feature adds [`serde_conv`], bidirectional
//! conversions between [`serde_json::Value`] and the in-crate
//! [`json::Value`] for callers that already carry serde_json. The default
//! build stays dependency-free.

pub mod chars;
pub mod classifier;
pub mod compressors;
pub mod content;
pub mod json;
pub mod middleware;
pub mod router;
#[cfg(feature = "serde")]
pub mod serde_conv;
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
pub use strategies::{DedupStrategy, NormalizeStrategy, PurgeErrorsStrategy, Strategy};
