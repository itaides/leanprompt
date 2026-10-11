//! Verbatim — the no-op compressor. Returns input unchanged with accurate
//! token counts so telemetry stays meaningful (ratio always 1.0).

use crate::compressors::Compressor;
use crate::json::Value;
use crate::stats::CompressionStats;
use crate::tokens::{count_message_tokens_with, default_counter, TokenCounter};

pub struct Verbatim {
    counter: TokenCounter,
}

impl Default for Verbatim {
    fn default() -> Self {
        Verbatim {
            counter: default_counter(),
        }
    }
}

impl Verbatim {
    /// Verbatim that counts stats with `counter` instead of the estimator.
    pub fn with_counter(counter: TokenCounter) -> Self {
        Verbatim { counter }
    }
}

impl Compressor for Verbatim {
    fn name(&self) -> &'static str {
        "verbatim"
    }

    fn compress(&self, messages: &[Value]) -> (Vec<Value>, CompressionStats) {
        let tokens = count_message_tokens_with(messages, &self.counter);
        (
            messages.to_vec(),
            CompressionStats::counted("verbatim", tokens, tokens),
        )
    }
}
