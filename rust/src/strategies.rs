//! Strategies — deterministic pre-compression filters (parity-spec §7).

use crate::classifier::{classify, ContentType, RepeatTracker};
use crate::json::Value;

pub trait Strategy {
    fn name(&self) -> &'static str;
    fn apply(&self, messages: Vec<Value>) -> Vec<Value>;
}

/// Drop duplicate messages within a single request (fresh tracker per call;
/// tool-linkage messages are never dropped).
#[derive(Default)]
pub struct DedupStrategy;

impl Strategy for DedupStrategy {
    fn name(&self) -> &'static str {
        "dedup"
    }

    fn apply(&self, messages: Vec<Value>) -> Vec<Value> {
        let mut tracker = RepeatTracker::new();
        messages.into_iter().filter(|m| !tracker.is_repeat(m)).collect()
    }
}

const PURGE_PLACEHOLDER: &str = "[errored output purged for context compaction]";

/// Replace the content of errored messages older than `after_turns` with a
/// short placeholder — the fact of the error survives, the bulk doesn't.
pub struct PurgeErrorsStrategy {
    pub after_turns: usize,
}

impl Default for PurgeErrorsStrategy {
    fn default() -> Self {
        PurgeErrorsStrategy { after_turns: 4 }
    }
}

impl Strategy for PurgeErrorsStrategy {
    fn name(&self) -> &'static str {
        "purge_errors"
    }

    fn apply(&self, messages: Vec<Value>) -> Vec<Value> {
        if messages.len() <= self.after_turns {
            return messages;
        }
        let cutoff = messages.len() - self.after_turns;
        messages
            .into_iter()
            .enumerate()
            .map(|(i, msg)| {
                if i < cutoff && classify(&msg) == ContentType::Error {
                    msg.with_field("content", Value::Str(PURGE_PLACEHOLDER.to_string()))
                } else {
                    msg
                }
            })
            .collect()
    }
}
