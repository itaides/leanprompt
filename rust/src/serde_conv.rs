//! Optional `serde_json` interop (feature `serde`, off by default).
//!
//! Structural conversions between [`serde_json::Value`] and the in-crate
//! [`Value`], so callers that already depend on serde_json can feed
//! messages into the pipeline without a serialize/parse round-trip. Chat
//! messages are plain [`Value`] objects (`role` + `content`), so the
//! `From` impls cover them directly; [`messages_from_json`] and
//! [`messages_to_json`] convert whole lists for
//! [`crate::Middleware::compress_messages`].
//!
//! Numbers: [`Value::Num`] is `f64`, matching JS `JSON.parse` semantics —
//! a serde_json integer beyond 2^53 converts to the same `f64` the
//! in-crate parser produces for the same JSON text, so nothing is lost
//! relative to what `json::parse` would give. serde_json's
//! `arbitrary_precision` feature is neither required nor enabled; if a
//! caller has it on, out-of-range literals degrade to `f64::INFINITY`
//! exactly as they do through `json::parse`. In the other direction a
//! non-finite `f64` (reachable via inputs like `1e400`) becomes
//! `serde_json::Value::Null`, matching `serde_json`'s own `From<f64>`.
//!
//! Object key order follows whatever order the `serde_json::Map` yields
//! (sorted under the default `BTreeMap`, insertion order under
//! `preserve_order`); [`Value`] equality is order-insensitive and
//! `json::canonical` re-sorts, so parity output is unaffected.

use crate::json::Value;

impl From<serde_json::Value> for Value {
    fn from(v: serde_json::Value) -> Value {
        match v {
            serde_json::Value::Null => Value::Null,
            serde_json::Value::Bool(b) => Value::Bool(b),
            serde_json::Value::Number(n) => Value::Num(n.as_f64().unwrap_or(f64::NAN)),
            serde_json::Value::String(s) => Value::Str(s),
            serde_json::Value::Array(items) => {
                Value::Arr(items.into_iter().map(Value::from).collect())
            }
            serde_json::Value::Object(map) => {
                Value::Obj(map.into_iter().map(|(k, v)| (k, Value::from(v))).collect())
            }
        }
    }
}

impl From<Value> for serde_json::Value {
    fn from(v: Value) -> serde_json::Value {
        match v {
            Value::Null => serde_json::Value::Null,
            Value::Bool(b) => serde_json::Value::Bool(b),
            Value::Num(n) => serde_json::Value::from(n),
            Value::Str(s) => serde_json::Value::String(s),
            Value::Arr(items) => {
                serde_json::Value::Array(items.into_iter().map(serde_json::Value::from).collect())
            }
            Value::Obj(entries) => serde_json::Value::Object(
                entries
                    .into_iter()
                    .map(|(k, v)| (k, serde_json::Value::from(v)))
                    .collect(),
            ),
        }
    }
}

impl From<&Value> for serde_json::Value {
    fn from(v: &Value) -> serde_json::Value {
        v.clone().into()
    }
}

/// Convert a `serde_json` message list into `Value`s for
/// [`crate::Middleware::compress_messages`].
pub fn messages_from_json(messages: &[serde_json::Value]) -> Vec<Value> {
    messages.iter().cloned().map(Value::from).collect()
}

/// Convert a `Value` message list back into `serde_json` values.
pub fn messages_to_json(messages: &[Value]) -> Vec<serde_json::Value> {
    messages.iter().map(serde_json::Value::from).collect()
}
