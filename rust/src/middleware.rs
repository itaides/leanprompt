//! Middleware — the compression orchestrator (parity-spec §9).

use std::collections::HashSet;

use crate::classifier::{classify, ContentType};
use crate::compressors::extract::Extract;
use crate::compressors::verbatim::Verbatim;
use crate::compressors::Compressor;
use crate::json::Value;
use crate::router::Router;
use crate::stats::CompressionStats;
use crate::strategies::{DedupStrategy, PurgeErrorsStrategy, Strategy};
use crate::tokens::count_message_tokens;

const DEFAULT_THRESHOLD_TOKENS: i64 = 2000;
const DEFAULT_PROTECT_LAST_TURNS: usize = 2;

/// Middleware configuration. Mirrors the reference config surface with
/// integer ratios (thousandths) instead of floats.
pub struct Config {
    /// "on"/"hybrid" activate; "off"/"passthrough"/"disabled" bypass.
    pub mode: String,
    pub threshold_tokens: i64,
    /// content-type name → compressor name ("verbatim" | "extract").
    pub routing: Vec<(String, String)>,
    pub extract_ratio_millis: i64,
    pub protect_last_turns: usize,
    pub dedup: bool,
    /// None disables purge; Some(n) purges errors older than n turns.
    pub purge_errors_after_turns: Option<usize>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            mode: "off".to_string(),
            threshold_tokens: DEFAULT_THRESHOLD_TOKENS,
            routing: Vec::new(),
            extract_ratio_millis: 500,
            protect_last_turns: DEFAULT_PROTECT_LAST_TURNS,
            dedup: true,
            purge_errors_after_turns: Some(4),
        }
    }
}

pub struct Middleware {
    active: bool,
    threshold: i64,
    protect_last_turns: usize,
    router: Router,
    protector: Verbatim,
    strategies: Vec<Box<dyn Strategy>>,
}

impl Middleware {
    pub fn new(config: Config) -> Self {
        let mode = config.mode.to_lowercase();
        let active = !matches!(mode.as_str(), "off" | "passthrough" | "disabled");

        let mut router = Router::new();
        for (ctype_str, compressor_name) in &config.routing {
            let Some(ctype) = ContentType::parse(ctype_str) else {
                eprintln!("leanprompt: unknown content type {ctype_str:?} in routing config; ignored");
                continue;
            };
            let compressor: Box<dyn Compressor> = match compressor_name.as_str() {
                "verbatim" => Box::new(Verbatim),
                "extract" => Box::new(Extract::new(config.extract_ratio_millis)),
                other => {
                    eprintln!(
                        "leanprompt: compressor {other:?} not available; falling back to default (verbatim) for {ctype_str}"
                    );
                    continue;
                }
            };
            router.register(ctype, compressor);
        }
        // STRUCTURED stays on the Verbatim default unless explicitly routed —
        // sentence-segmenting JSON is meaningless.

        let mut strategies: Vec<Box<dyn Strategy>> = Vec::new();
        if active {
            if config.dedup {
                strategies.push(Box::new(DedupStrategy));
            }
            if let Some(after_turns) = config.purge_errors_after_turns {
                strategies.push(Box::new(PurgeErrorsStrategy { after_turns }));
            }
        }

        Middleware {
            active,
            threshold: config.threshold_tokens,
            protect_last_turns: config.protect_last_turns,
            router,
            protector: Verbatim,
            strategies,
        }
    }

    pub fn compress_messages(&self, messages: &[Value]) -> (Vec<Value>, CompressionStats) {
        if !self.active || messages.is_empty() {
            let method = if messages.is_empty() { "empty" } else { "passthrough" };
            return (messages.to_vec(), CompressionStats::with_method(method));
        }

        let mut messages: Vec<Value> = messages.to_vec();
        for strategy in &self.strategies {
            messages = strategy.apply(messages);
        }
        if messages.is_empty() {
            return (messages, CompressionStats::with_method("empty"));
        }

        let input_tokens = count_message_tokens(&messages);
        if input_tokens < self.threshold {
            return (
                messages,
                CompressionStats::counted("below-threshold", input_tokens, input_tokens),
            );
        }

        let total = messages.len();
        let mut out = Vec::with_capacity(total);
        let mut total_in = 0;
        let mut total_out = 0;
        let mut total_cost = 0.0;
        let mut methods: HashSet<String> = HashSet::new();

        for (i, msg) in messages.iter().enumerate() {
            let compressor: &dyn Compressor = if self.is_protected(i, total, msg) {
                &self.protector
            } else {
                self.router.route(classify(msg))
            };
            let (compressed, stats) = compressor.compress(std::slice::from_ref(msg));
            out.extend(compressed);
            total_in += stats.input_tokens;
            total_out += stats.output_tokens;
            total_cost += stats.cost_usd;
            methods.insert(stats.method);
        }

        (out, aggregate(total_in, total_out, total_cost, &methods))
    }

    /// System messages and the last K turns are never handed to a lossy
    /// compressor — they carry the live instructions/questions.
    fn is_protected(&self, index: usize, total: usize, msg: &Value) -> bool {
        if msg.str_field("role") == "system" {
            return true;
        }
        index + self.protect_last_turns >= total
    }
}

fn aggregate(
    total_in: i64,
    total_out: i64,
    total_cost: f64,
    methods: &HashSet<String>,
) -> CompressionStats {
    let method = if methods.is_empty() {
        "empty".to_string()
    } else if methods.len() == 1 {
        methods.iter().next().unwrap().clone()
    } else {
        "hybrid".to_string()
    };
    let mut stats = CompressionStats::counted(&method, total_in, total_out);
    stats.cost_usd = total_cost;
    stats
}
