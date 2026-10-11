//! Edge-case tests for NormalizeStrategy beyond the golden vectors.

use leanprompt::json::{parse, Value};
use leanprompt::strategies::{NormalizeStrategy, Strategy};

fn norm(content: &str) -> String {
    norm_with(content, true)
}

fn norm_with(content: &str, json: bool) -> String {
    let msg = parse(&format!(
        "{{\"role\":\"user\",\"content\":{}}}",
        quoted(content)
    ))
    .unwrap();
    let out = NormalizeStrategy { json }.apply(vec![msg]);
    out[0].str_field("content").to_string()
}

/// JSON-string quoting for embedding a span in a parsed message.
fn quoted(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn norm_msg(msg: Value) -> Value {
    NormalizeStrategy::default().apply(vec![msg]).remove(0)
}

#[test]
fn osc_forms() {
    assert_eq!(norm("a\u{1b}]0;title\u{7}b"), "ab");
    assert_eq!(norm("a\u{1b}]0;title\u{1b}\\b"), "ab");
    // Unterminated OSC is removed through the end of the span.
    assert_eq!(norm("a\u{1b}]0;payload"), "a");
    // ESC inside the payload not followed by \ is payload.
    assert_eq!(norm("a\u{1b}]8;;x\u{1b}y\u{7}b"), "ab");
}

#[test]
fn csi_and_fe_forms() {
    assert_eq!(norm("a\u{1b}[1;2Hb"), "ab");
    assert_eq!(norm("a\u{1b}[?25lb"), "ab");
    assert_eq!(norm("a\u{1b}[!pb"), "ab");
    assert_eq!(norm("a\u{1b}Pb"), "ab");
    assert_eq!(norm("\u{1b}\\"), "");
    // Malformed CSI and other ESC uses stay.
    assert_eq!(norm("a\u{1b}[31"), "a\u{1b}[31");
    assert_eq!(norm("a\u{1b}(B"), "a\u{1b}(B");
    assert_eq!(norm("a\u{1b}"), "a\u{1b}");
}

#[test]
fn blank_run_edges() {
    assert_eq!(norm("a\n  \n \t\nb"), "a\n\nb");
    assert_eq!(norm("a  \n\n\nb"), "a  \n\nb");
    assert_eq!(norm("  \n\nb\n   "), "  \n\nb\n   ");
}

#[test]
fn json_failure_modes() {
    let keys: Vec<String> = (0..20).map(|i| format!("\"k{i}\": 1")).collect();
    let unbalanced = format!("{{{},", keys.join(","));
    assert_eq!(norm(&unbalanced), unbalanced);

    let unterminated = format!("{{{}, \"tail\": \"open", keys.join(","));
    assert_eq!(norm(&unterminated), unterminated);

    let trailing = format!("{{{}}} oops", keys.join(","));
    assert_eq!(norm(&trailing), trailing);
}

#[test]
fn system_never_modified() {
    let msg = parse("{\"role\":\"system\",\"content\":\"a\\r\\nb\\u001b[31m\"}").unwrap();
    let out = norm_msg(msg.clone());
    assert_eq!(out, msg);
}

#[test]
fn tool_result_recursion_and_ids() {
    let msg = parse(
        r#"{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"one\u200b\n\n\n\n\ntwo"},{"type":"image","source":{"data":"x"}}]}]}"#,
    )
    .unwrap();
    let out = norm_msg(msg);
    let inner = &out.get("content").unwrap().as_arr().unwrap()[0];
    assert_eq!(inner.str_field("tool_use_id"), "t1");
    let blocks = inner.get("content").unwrap().as_arr().unwrap();
    assert_eq!(blocks[0].str_field("text"), "one\n\ntwo");
    assert_eq!(blocks[1].str_field("type"), "image");
}
