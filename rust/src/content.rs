//! Content extraction (parity-spec §5): recursive compressible-text
//! extraction from OpenAI string content and Anthropic block lists.

use crate::json::{canonical, Value};

/// Concatenated compressible text of a chat message.
pub fn get_text_content(message: &Value) -> String {
    extract_text(message.get("content"))
}

pub fn extract_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::Str(s)) => s.clone(),
        Some(Value::Arr(items)) => {
            let parts: Vec<String> = items
                .iter()
                .map(text_from_block)
                .filter(|t| !t.is_empty())
                .collect();
            parts.join("\n")
        }
        // Some providers wrap a single block in an object rather than a list.
        Some(obj @ Value::Obj(_)) => text_from_block(obj),
        _ => String::new(),
    }
}

fn text_from_block(block: &Value) -> String {
    if !matches!(block, Value::Obj(_)) {
        return String::new();
    }
    match block.str_field("type") {
        "text" => block.str_field("text").to_string(),
        "tool_use" => {
            let name = block.str_field("name");
            let serialized = serialize(block.get("input"));
            if !name.is_empty() && !serialized.is_empty() {
                format!("[tool_use {name}] {serialized}")
            } else {
                serialized
            }
        }
        "tool_result" => extract_text(block.get("content")),
        "document" => {
            let direct = block.str_field("text");
            if !direct.is_empty() {
                return direct.to_string();
            }
            if let Some(source) = block.get("source") {
                if let Some(Value::Str(data)) = source.get("data") {
                    return data.clone();
                }
            }
            extract_text(block.get("content"))
        }
        // image, thinking, unknown types contribute no compressible text.
        _ => String::new(),
    }
}

/// Tool-input serialization: canonical JSON for containers, pass-through for
/// strings (parity-spec §4).
fn serialize(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::Str(s)) => s.clone(),
        Some(Value::Bool(b)) => if *b { "true" } else { "false" }.to_string(),
        Some(v @ (Value::Obj(_) | Value::Arr(_))) => canonical(v),
        Some(Value::Num(_)) => canonical(value.unwrap()),
    }
}
