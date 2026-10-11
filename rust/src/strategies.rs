//! Strategies — deterministic pre-compression filters (parity-spec §7).

use crate::classifier::{classify, looks_like_error, ContentType, RepeatTracker};
use crate::content::extract_text;
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
        messages
            .into_iter()
            .filter(|m| !tracker.is_repeat(m))
            .collect()
    }
}

const PURGE_PLACEHOLDER: &str = "[errored output purged for context compaction]";

/// Replace the content of errored messages older than `after_turns` with a
/// short placeholder — the fact of the error survives, the bulk doesn't.
/// System messages are never purged, and structured content is trimmed per
/// block so a `tool_result` keeps its shape and linkage ids.
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
                if i >= cutoff
                    || msg.str_field("role") == "system"
                    || classify(&msg) != ContentType::Error
                {
                    return msg;
                }
                match msg.get("content") {
                    Some(content) => msg.with_field("content", purge_content(content)),
                    None => msg,
                }
            })
            .collect()
    }
}

fn purge_content(content: &Value) -> Value {
    match content {
        Value::Str(_) => Value::Str(PURGE_PLACEHOLDER.to_string()),
        Value::Arr(items) => Value::Arr(items.iter().map(purge_block).collect()),
        Value::Obj(_) => purge_block(content),
        _ => content.clone(),
    }
}

fn purge_block(block: &Value) -> Value {
    let Value::Obj(_) = block else {
        return block.clone();
    };
    if !looks_like_error(&extract_text(Some(block))) {
        return block.clone();
    }
    match block.str_field("type") {
        "text" => block.with_field("text", Value::Str(PURGE_PLACEHOLDER.to_string())),
        "tool_result" => match block.get("content") {
            Some(Value::Str(_)) => {
                block.with_field("content", Value::Str(PURGE_PLACEHOLDER.to_string()))
            }
            Some(Value::Arr(inner)) => block.with_field(
                "content",
                Value::Arr(inner.iter().map(purge_block).collect()),
            ),
            _ => block.clone(),
        },
        _ => block.clone(),
    }
}
