#![cfg(feature = "serde")]

use leanprompt::json::{parse, Value};
use leanprompt::serde_conv::{messages_from_json, messages_to_json};

#[test]
fn value_roundtrip() {
    let sj = serde_json::json!({
        "role": "user",
        "content": [
            { "type": "text", "text": "hello" },
            { "type": "tool_use", "id": "u1", "name": "run", "input": { "cmd": "ls -la" } },
            { "type": "tool_result", "tool_use_id": "u1", "content": [
                { "type": "text", "text": "done" }
            ] }
        ],
        "n": null,
        "ok": true,
        "count": 3
    });
    let v = Value::from(sj.clone());
    let back = serde_json::Value::from(&v);
    // Numbers normalize to f64 through Value::Num: serde_json still
    // distinguishes Number(3) from Number(3.0), so compare numerically.
    assert_eq!(back["count"].as_f64(), sj["count"].as_f64());
    assert_eq!(back["n"], sj["n"]);
    assert_eq!(back["ok"], sj["ok"]);
    assert_eq!(back["role"], sj["role"]);
    assert_eq!(back["content"], sj["content"]);
}

#[test]
fn message_list_helpers() {
    let list = vec![
        serde_json::json!({"role": "system", "content": "be brief"}),
        serde_json::json!({"role": "user", "content": "hi"}),
    ];
    let values = messages_from_json(&list);
    assert_eq!(values.len(), 2);
    assert_eq!(values[0].str_field("role"), "system");
    assert_eq!(messages_to_json(&values), list);
}

#[test]
fn unicode_and_escapes() {
    let sj = serde_json::json!({"text": "héllo 世界 emoji \u{1f600} \"quoted\" \\ back"});
    let v = Value::from(sj.clone());
    assert_eq!(serde_json::Value::from(v), sj);
}

#[test]
fn conversion_matches_incparse_for_numbers() {
    // Beyond 2^53 the serde_json number becomes the same f64 the in-crate
    // parser produces for the identical JSON text — no extra precision loss.
    let text = r#"{"big": 12345678901234567890, "frac": 0.1, "neg": -42}"#;
    let via_serde = Value::from(serde_json::from_str::<serde_json::Value>(text).unwrap());
    let via_parse = parse(text).unwrap();
    assert_eq!(via_serde, via_parse);
}

#[test]
fn non_finite_becomes_null_like_serde_from_f64() {
    let v = Value::Obj(vec![("x".into(), Value::Num(f64::INFINITY))]);
    let back = serde_json::Value::from(v);
    assert_eq!(back, serde_json::json!({"x": null}));
}
