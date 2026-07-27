//! Content-type classifier + RepeatTracker (parity-spec §6).

use std::collections::HashSet;

use crate::content::get_text_content;
use crate::json::Value;
use crate::sha256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ContentType {
    Unknown,
    Prose,
    Code,
    Error,
    Structured,
    Repeat,
    LongImportant,
}

impl ContentType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ContentType::Unknown => "unknown",
            ContentType::Prose => "prose",
            ContentType::Code => "code",
            ContentType::Error => "error",
            ContentType::Structured => "structured",
            ContentType::Repeat => "repeat",
            ContentType::LongImportant => "long_important",
        }
    }

    pub fn parse(s: &str) -> Option<ContentType> {
        Some(match s {
            "unknown" => ContentType::Unknown,
            "prose" => ContentType::Prose,
            "code" => ContentType::Code,
            "error" => ContentType::Error,
            "structured" => ContentType::Structured,
            "repeat" => ContentType::Repeat,
            "long_important" => ContentType::LongImportant,
            _ => return None,
        })
    }
}

const ERROR_MARKERS: &[&str] = &[
    "Traceback (most recent call last):",
    "Uncaught exception",
    "UnhandledPromiseRejection",
    "thread 'main' panicked at",
    "panic: ",
    "Exception in thread",
    "FATAL: ",
    "ERROR: ",
    "Error: ",
    "Exception: ",
    "java.lang.",
];

const CODE_LINE_PREFIXES: &[&str] = &[
    "def ", "class ", "function ", "async function ", "import ", "from ",
    "export ", "package ", "#include", "fn ", "pub fn ", "func ", "var ",
    "const ", "let ",
];

const MIN_CODE_LINES: usize = 2;
const STRUCTURED_MIN_CHARS: usize = 200;

/// Classify a message: ERROR > CODE > STRUCTURED > PROSE; UNKNOWN when the
/// extracted text is empty.
pub fn classify(message: &Value) -> ContentType {
    let text = get_text_content(message);
    if text.trim().is_empty() {
        return ContentType::Unknown;
    }
    if looks_like_error(&text) {
        return ContentType::Error;
    }
    if looks_like_code(&text) {
        return ContentType::Code;
    }
    if looks_like_structured(&text) {
        return ContentType::Structured;
    }
    ContentType::Prose
}

fn looks_like_error(text: &str) -> bool {
    ERROR_MARKERS.iter().any(|m| text.contains(m))
}

fn looks_like_code(text: &str) -> bool {
    if text.contains("```") {
        return true;
    }
    let code_lines = text
        .split('\n')
        .filter(|line| {
            let stripped = line.trim_start();
            CODE_LINE_PREFIXES.iter().any(|p| stripped.starts_with(p))
        })
        .count();
    code_lines >= MIN_CODE_LINES
}

/// JSON-key density: procedural scan for `"key":` shapes (1–64 code points
/// between quotes, optional spaces/tabs before the colon).
fn looks_like_structured(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    if n < STRUCTURED_MIN_CHARS {
        return false;
    }
    let keys = count_json_keys(&chars);
    // keys / (n/1000) >= 1.0  ⇔  keys * 1000 >= n
    keys * 1000 >= n
}

fn count_json_keys(chars: &[char]) -> usize {
    let mut count = 0;
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '"' {
            i += 1;
            continue;
        }
        // Find the closing quote within 1..=64 code points, no " or \n inside.
        let start = i + 1;
        let mut j = start;
        let mut ok = false;
        while j < chars.len() && j - start <= 64 {
            match chars[j] {
                '"' => {
                    ok = j > start; // at least one code point inside
                    break;
                }
                '\n' => break,
                _ => j += 1,
            }
        }
        if !ok {
            i += 1;
            continue;
        }
        // Optional spaces/tabs, then ':'
        let mut k = j + 1;
        while k < chars.len() && (chars[k] == ' ' || chars[k] == '\t') {
            k += 1;
        }
        if k < chars.len() && chars[k] == ':' {
            count += 1;
            i = k + 1;
        } else {
            // Overlapping matches are impossible in the reference regex scan:
            // resume after the closing quote.
            i = j + 1;
        }
    }
    count
}

/// Tracks content hashes across a session to flag duplicate messages.
#[derive(Default)]
pub struct RepeatTracker {
    seen: HashSet<String>,
}

impl RepeatTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// True if this message's content was seen before; records it as seen.
    pub fn is_repeat(&mut self, message: &Value) -> bool {
        let h = Self::hash(message);
        let Some(h) = h else { return false };
        if self.seen.contains(&h) {
            return true;
        }
        self.seen.insert(h);
        false
    }

    pub fn reset(&mut self) {
        self.seen.clear();
    }

    fn hash(message: &Value) -> Option<String> {
        // tool_use/tool_result blocks pair by id; dropping a "duplicate"
        // tool_result would orphan its tool_use. Never hash those messages.
        if has_tool_linkage(message) {
            return None;
        }
        let text = get_text_content(message);
        if text.is_empty() {
            return None;
        }
        let role = message.str_field("role");
        Some(sha256::hex_digest(format!("{role}|{text}").as_bytes()))
    }
}

pub fn has_tool_linkage(message: &Value) -> bool {
    let Some(items) = message.get("content").and_then(Value::as_arr) else {
        return false;
    };
    items.iter().any(|b| {
        matches!(b.str_field("type"), "tool_use" | "tool_result")
    })
}
