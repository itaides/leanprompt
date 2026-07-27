//! Minimal JSON layer: value type, parser and canonical serializer.
//!
//! std has no JSON; the pipeline needs one both to represent chat messages
//! and to serialize `tool_use.input` canonically (parity-spec §4). Objects
//! preserve insertion order internally; equality is order-insensitive so
//! parsed golden vectors compare structurally.

use std::fmt::Write as _;

#[derive(Debug, Clone)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Value>),
    Obj(Vec<(String, Value)>),
}

impl Value {
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Obj(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_arr(&self) -> Option<&[Value]> {
        match self {
            Value::Arr(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Value::Num(n) if n.fract() == 0.0 => Some(*n as i64),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }

    /// String value of a message field, or "" when absent/non-string.
    pub fn str_field(&self, key: &str) -> &str {
        self.get(key).and_then(Value::as_str).unwrap_or("")
    }

    /// Clone this object, replacing (or appending) one key in place so the
    /// original key order is preserved — mirrors JS `{ ...obj, key: v }`.
    pub fn with_field(&self, key: &str, value: Value) -> Value {
        match self {
            Value::Obj(entries) => {
                let mut out = entries.clone();
                if let Some(slot) = out.iter_mut().find(|(k, _)| k == key) {
                    slot.1 = value;
                } else {
                    out.push((key.to_string(), value));
                }
                Value::Obj(out)
            }
            other => other.clone(),
        }
    }
}

/// Order-insensitive object equality; arrays stay ordered.
impl PartialEq for Value {
    fn eq(&self, other: &Value) -> bool {
        match (self, other) {
            (Value::Null, Value::Null) => true,
            (Value::Bool(a), Value::Bool(b)) => a == b,
            (Value::Num(a), Value::Num(b)) => a == b,
            (Value::Str(a), Value::Str(b)) => a == b,
            (Value::Arr(a), Value::Arr(b)) => a == b,
            (Value::Obj(a), Value::Obj(b)) => {
                a.len() == b.len()
                    && a.iter().all(|(k, v)| {
                        b.iter().find(|(k2, _)| k2 == k).is_some_and(|(_, v2)| v == v2)
                    })
            }
            _ => false,
        }
    }
}

// ------------------------------------------------------------------------ //
// Canonical serialization (parity-spec §4)
// ------------------------------------------------------------------------ //

/// Compact JSON with lexicographically sorted object keys and unescaped
/// printable non-ASCII.
pub fn canonical(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Num(n) => write_number(*n, out),
        Value::Str(s) => write_string(s, out),
        Value::Arr(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        Value::Obj(entries) => {
            let mut keys: Vec<&(String, Value)> = entries.iter().collect();
            keys.sort_by(|a, b| a.0.cmp(&b.0));
            out.push('{');
            for (i, (k, v)) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(k, out);
                out.push(':');
                write_canonical(v, out);
            }
            out.push('}');
        }
    }
}

/// Integer-valued floats print as integers (JS JSON.stringify behavior).
fn write_number(n: f64, out: &mut String) {
    if n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 {
        let _ = write!(out, "{}", n as i64);
    } else {
        let _ = write!(out, "{n}");
    }
}

fn write_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

// ------------------------------------------------------------------------ //
// Parser
// ------------------------------------------------------------------------ //

pub fn parse(input: &str) -> Result<Value, String> {
    let chars: Vec<char> = input.chars().collect();
    let mut parser = Parser { chars, pos: 0 };
    parser.skip_ws();
    let value = parser.value()?;
    parser.skip_ws();
    if parser.pos != parser.chars.len() {
        return Err(format!("trailing data at {}", parser.pos));
    }
    Ok(value)
}

struct Parser {
    chars: Vec<char>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn bump(&mut self) -> Result<char, String> {
        let c = self.peek().ok_or("unexpected end of input")?;
        self.pos += 1;
        Ok(c)
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(' ' | '\t' | '\n' | '\r')) {
            self.pos += 1;
        }
    }

    fn expect(&mut self, c: char) -> Result<(), String> {
        let got = self.bump()?;
        if got != c {
            return Err(format!("expected {c:?}, got {got:?} at {}", self.pos));
        }
        Ok(())
    }

    fn literal(&mut self, text: &str, value: Value) -> Result<Value, String> {
        for c in text.chars() {
            self.expect(c)?;
        }
        Ok(value)
    }

    fn value(&mut self) -> Result<Value, String> {
        self.skip_ws();
        match self.peek().ok_or("unexpected end of input")? {
            'n' => self.literal("null", Value::Null),
            't' => self.literal("true", Value::Bool(true)),
            'f' => self.literal("false", Value::Bool(false)),
            '"' => Ok(Value::Str(self.string()?)),
            '[' => self.array(),
            '{' => self.object(),
            '-' | '0'..='9' => self.number(),
            c => Err(format!("unexpected {c:?} at {}", self.pos)),
        }
    }

    fn array(&mut self) -> Result<Value, String> {
        self.expect('[')?;
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(']') {
            self.pos += 1;
            return Ok(Value::Arr(items));
        }
        loop {
            items.push(self.value()?);
            self.skip_ws();
            match self.bump()? {
                ',' => continue,
                ']' => return Ok(Value::Arr(items)),
                c => return Err(format!("expected , or ] got {c:?}")),
            }
        }
    }

    fn object(&mut self) -> Result<Value, String> {
        self.expect('{')?;
        let mut entries = Vec::new();
        self.skip_ws();
        if self.peek() == Some('}') {
            self.pos += 1;
            return Ok(Value::Obj(entries));
        }
        loop {
            self.skip_ws();
            let key = self.string()?;
            self.skip_ws();
            self.expect(':')?;
            let value = self.value()?;
            entries.push((key, value));
            self.skip_ws();
            match self.bump()? {
                ',' => continue,
                '}' => return Ok(Value::Obj(entries)),
                c => return Err(format!("expected , or }} got {c:?}")),
            }
        }
    }

    fn string(&mut self) -> Result<String, String> {
        self.expect('"')?;
        let mut out = String::new();
        loop {
            match self.bump()? {
                '"' => return Ok(out),
                '\\' => match self.bump()? {
                    '"' => out.push('"'),
                    '\\' => out.push('\\'),
                    '/' => out.push('/'),
                    'n' => out.push('\n'),
                    'r' => out.push('\r'),
                    't' => out.push('\t'),
                    'b' => out.push('\u{08}'),
                    'f' => out.push('\u{0c}'),
                    'u' => {
                        let hi = self.hex4()?;
                        let cp = if (0xd800..0xdc00).contains(&hi) {
                            // surrogate pair
                            self.expect('\\')?;
                            self.expect('u')?;
                            let lo = self.hex4()?;
                            0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00)
                        } else {
                            hi
                        };
                        out.push(char::from_u32(cp).ok_or("bad codepoint")?);
                    }
                    c => return Err(format!("bad escape {c:?}")),
                },
                c => out.push(c),
            }
        }
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let mut v = 0u32;
        for _ in 0..4 {
            let c = self.bump()?;
            v = v * 16 + c.to_digit(16).ok_or(format!("bad hex {c:?}"))?;
        }
        Ok(v)
    }

    fn number(&mut self) -> Result<Value, String> {
        let start = self.pos;
        if self.peek() == Some('-') {
            self.pos += 1;
        }
        while matches!(self.peek(), Some('0'..='9')) {
            self.pos += 1;
        }
        if self.peek() == Some('.') {
            self.pos += 1;
            while matches!(self.peek(), Some('0'..='9')) {
                self.pos += 1;
            }
        }
        if matches!(self.peek(), Some('e' | 'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some('+' | '-')) {
                self.pos += 1;
            }
            while matches!(self.peek(), Some('0'..='9')) {
                self.pos += 1;
            }
        }
        let text: String = self.chars[start..self.pos].iter().collect();
        text.parse::<f64>().map(Value::Num).map_err(|e| e.to_string())
    }
}
