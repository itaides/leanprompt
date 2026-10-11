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

/// Lossless cleanup ("level 0"), runs before dedup so CRLF/ANSI variants
/// of the same output dedup to one. N1/N2 on every non-system span; N3/N4
/// on prose only; N5 on structured only (`json: false` disables just N5).
/// `role == "system"` messages are never modified. The classifier class is
/// computed on the ORIGINAL message before rewriting.
pub struct NormalizeStrategy {
    pub json: bool,
}

impl Default for NormalizeStrategy {
    fn default() -> Self {
        NormalizeStrategy { json: true }
    }
}

impl Strategy for NormalizeStrategy {
    fn name(&self) -> &'static str {
        "normalize"
    }

    fn apply(&self, messages: Vec<Value>) -> Vec<Value> {
        messages
            .into_iter()
            .map(|msg| {
                if msg.str_field("role") == "system" {
                    return msg;
                }
                let cls = classify(&msg);
                match msg.get("content") {
                    Some(content) => match normalize_content(content, cls, self.json) {
                        Some(next) => msg.with_field("content", next),
                        None => msg,
                    },
                    None => msg,
                }
            })
            .collect()
    }
}

fn normalize_content(content: &Value, cls: ContentType, json: bool) -> Option<Value> {
    match content {
        Value::Str(s) => normalize_span(s, cls, json).map(Value::Str),
        Value::Arr(items) => map_changed(items, |b| normalize_block(b, cls, json)).map(Value::Arr),
        Value::Obj(_) => normalize_block(content, cls, json),
        _ => None,
    }
}

fn normalize_block(block: &Value, cls: ContentType, json: bool) -> Option<Value> {
    let Value::Obj(_) = block else {
        return None;
    };
    match block.str_field("type") {
        "text" => match block.get("text") {
            Some(Value::Str(s)) => {
                normalize_span(s, cls, json).map(|t| block.with_field("text", Value::Str(t)))
            }
            _ => None,
        },
        "tool_result" => match block.get("content") {
            Some(Value::Str(s)) => {
                normalize_span(s, cls, json).map(|t| block.with_field("content", Value::Str(t)))
            }
            Some(Value::Arr(inner)) => map_changed(inner, |b| normalize_block(b, cls, json))
                .map(|out| block.with_field("content", Value::Arr(out))),
            _ => None,
        },
        _ => None,
    }
}

/// Map items; None when nothing changed.
fn map_changed(items: &[Value], f: impl Fn(&Value) -> Option<Value>) -> Option<Vec<Value>> {
    let mut changed = false;
    let out: Vec<Value> = items
        .iter()
        .map(|item| match f(item) {
            Some(next) => {
                changed = true;
                next
            }
            None => item.clone(),
        })
        .collect();
    changed.then_some(out)
}

fn normalize_span(text: &str, cls: ContentType, json: bool) -> Option<String> {
    let mut out = strip_crlf(text);
    out = strip_ansi(&out);
    out = match cls {
        ContentType::Prose => collapse_blank_runs(&strip_invisible(&out)),
        ContentType::Structured if json => minify_json_whitespace(&out),
        _ => out,
    };
    (out != text).then_some(out)
}

/// N1: `\r\n` → `\n`, then remaining lone `\r` → `\n`.
fn strip_crlf(text: &str) -> String {
    if !text.contains('\r') {
        return text.to_string();
    }
    let cps: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < cps.len() {
        if cps[i] == '\r' {
            out.push('\n');
            if cps.get(i + 1) == Some(&'\n') {
                i += 1;
            }
        } else {
            out.push(cps[i]);
        }
        i += 1;
    }
    out
}

/// N2: remove ANSI escapes — CSI (params 0x30-0x3F, intermediates
/// 0x20-0x2F, final 0x40-0x7E; no valid final byte → left as-is), OSC
/// (payload ends at BEL or ST; unterminated runs to end of span), Fe
/// (ESC + 0x40-0x5F). Other ESC uses stay.
fn strip_ansi(text: &str) -> String {
    let cps: Vec<char> = text.chars().collect();
    if !cps.contains(&'\u{1b}') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < cps.len() {
        let cp = cps[i];
        if cp != '\u{1b}' {
            out.push(cp);
            i += 1;
            continue;
        }
        let next = cps.get(i + 1).copied();
        if next == Some('[') {
            let mut j = i + 2;
            while j < cps.len() && ('\u{30}'..='\u{3f}').contains(&cps[j]) {
                j += 1;
            }
            while j < cps.len() && ('\u{20}'..='\u{2f}').contains(&cps[j]) {
                j += 1;
            }
            if j < cps.len() && ('\u{40}'..='\u{7e}').contains(&cps[j]) {
                i = j + 1;
            } else {
                out.push(cp);
                i += 1;
            }
            continue;
        }
        if next == Some(']') {
            // An ESC inside the payload not followed by \ is payload.
            let mut j = i + 2;
            let mut end = cps.len();
            while j < cps.len() {
                if cps[j] == '\u{7}' {
                    end = j + 1;
                    break;
                }
                if cps[j] == '\u{1b}' && cps.get(j + 1) == Some(&'\\') {
                    end = j + 2;
                    break;
                }
                j += 1;
            }
            i = end;
            continue;
        }
        if matches!(next, Some(c) if ('\u{40}'..='\u{5f}').contains(&c)) {
            i += 2;
            continue;
        }
        out.push(cp);
        i += 1;
    }
    out
}

/// N3: remove ZWSP, WJ, ZWNBSP — never ZWNJ/ZWJ.
fn strip_invisible(text: &str) -> String {
    text.chars()
        .filter(|c| !matches!(c, '\u{200b}' | '\u{2060}' | '\u{feff}'))
        .collect()
}

/// N4: collapse runs of 3+ newlines into exactly 2; whitespace-only lines
/// between newlines count as empty and are stripped. Trailing whitespace
/// on non-empty lines (markdown hard breaks) is preserved.
fn collapse_blank_runs(text: &str) -> String {
    let cps: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < cps.len() {
        if cps[i] != '\n' {
            out.push(cps[i]);
            i += 1;
            continue;
        }
        let mut count = 0;
        let mut j = i;
        loop {
            count += 1;
            j += 1;
            let mut k = j;
            while k < cps.len() && (cps[k] == ' ' || cps[k] == '\t') {
                k += 1;
            }
            if k < cps.len() && cps[k] == '\n' {
                j = k;
            } else {
                break;
            }
        }
        out.push('\n');
        if count > 1 {
            out.push('\n');
        }
        i = j;
    }
    out
}

/// N5: JSON whitespace minification — only space/\t/\n/\r outside strings
/// is removed; strings, key order and number literals are verbatim. Any
/// malformed input is returned unchanged.
fn minify_json_whitespace(text: &str) -> String {
    let is_ws = |c: char| matches!(c, ' ' | '\t' | '\n' | '\r');
    let cps: Vec<char> = text.chars().collect();
    let mut start = 0;
    while start < cps.len() && is_ws(cps[start]) {
        start += 1;
    }
    if !matches!(cps.get(start).copied(), Some('{') | Some('[')) {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut in_string = false;
    let mut escaped = false;
    let mut depth = 0i32;
    let mut ended = false;
    for &cp in &cps[start..] {
        if in_string {
            out.push(cp);
            if escaped {
                escaped = false;
            } else if cp == '\\' {
                escaped = true;
            } else if cp == '"' {
                in_string = false;
            }
            continue;
        }
        if is_ws(cp) {
            continue;
        }
        if ended {
            return text.to_string(); // trailing garbage after a complete value
        }
        match cp {
            '"' => in_string = true,
            '{' | '[' => depth += 1,
            '}' | ']' => {
                depth -= 1;
                if depth < 0 {
                    return text.to_string(); // unbalanced
                }
                if depth == 0 {
                    ended = true;
                }
            }
            _ => {}
        }
        out.push(cp);
    }
    if in_string || depth != 0 {
        return text.to_string(); // unterminated string / unbalanced brackets
    }
    out
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
