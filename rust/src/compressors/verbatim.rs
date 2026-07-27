//! Verbatim — the no-op compressor. Returns input unchanged with accurate
//! token counts so telemetry stays meaningful (ratio always 1.0).

use crate::compressors::Compressor;
use crate::json::Value;
use crate::stats::CompressionStats;
use crate::tokens::count_message_tokens;

#[derive(Default)]
pub struct Verbatim;

impl Compressor for Verbatim {
    fn name(&self) -> &'static str {
        "verbatim"
    }

    fn compress(&self, messages: &[Value]) -> (Vec<Value>, CompressionStats) {
        let tokens = count_message_tokens(messages);
        (
            messages.to_vec(),
            CompressionStats::counted("verbatim", tokens, tokens),
        )
    }
}
