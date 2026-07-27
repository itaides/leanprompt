//! Compressor strategies.

pub mod extract;
pub mod selfllm;
pub mod verbatim;

use crate::json::Value;
use crate::stats::CompressionStats;

/// A compression strategy for a span of chat messages.
///
/// Implementations must return messages in the same shape they received and
/// never fail on empty inputs (return them unchanged with zero-valued stats).
pub trait Compressor {
    fn name(&self) -> &'static str;
    fn compress(&self, messages: &[Value]) -> (Vec<Value>, CompressionStats);
}
