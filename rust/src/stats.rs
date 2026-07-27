//! CompressionStats — telemetry shape shared by every compression call.

#[derive(Debug, Clone, PartialEq)]
pub struct CompressionStats {
    pub input_tokens: i64,
    pub output_tokens: i64,
    /// Derived float — recomputed per language, never byte-compared.
    pub ratio: f64,
    pub method: String,
    pub cost_usd: f64,
}

impl CompressionStats {
    pub fn passthrough() -> Self {
        Self::with_method("passthrough")
    }

    pub fn with_method(method: &str) -> Self {
        CompressionStats {
            input_tokens: 0,
            output_tokens: 0,
            ratio: 1.0,
            method: method.to_string(),
            cost_usd: 0.0,
        }
    }

    pub fn counted(method: &str, input_tokens: i64, output_tokens: i64) -> Self {
        CompressionStats {
            input_tokens,
            output_tokens,
            ratio: if input_tokens > 0 {
                output_tokens as f64 / input_tokens as f64
            } else {
                1.0
            },
            method: method.to_string(),
            cost_usd: 0.0,
        }
    }
}
