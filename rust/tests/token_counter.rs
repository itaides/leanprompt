//! Config::token_counter — an injected counter replaces the built-in
//! estimator for gating and stats; unset keeps the default path.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use leanprompt::json::{parse, Value};
use leanprompt::tokens::count_tokens;
use leanprompt::{Config, Middleware};

/// Long prose span (same fixture as the selfllm tests).
fn prose() -> String {
    "The incident report describes a lengthy sequence of unfortunate events \
     in production. The scheduler fired the rotation job during an active \
     release window on the gamma cluster. Basically this was all just \
     terrible timing between two independent systems. The release step \
     retried three times with exponential backoff and gave up."
        .to_string()
}

fn messages(text: &str) -> Vec<Value> {
    parse(&format!(r#"[{{"role":"user","content":"{text}"}}]"#))
        .unwrap()
        .as_arr()
        .unwrap()
        .to_vec()
}

#[test]
fn token_counter_drives_gating_and_stats() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter_calls = calls.clone();
    let mw = Middleware::new(Config {
        mode: "on".into(),
        threshold_tokens: 10,
        routing: vec![("prose".into(), "verbatim".into())],
        protect_last_turns: 0,
        token_counter: Some(Arc::new(move |s: &str| {
            counter_calls.fetch_add(1, Ordering::SeqCst);
            s.len() as i64
        })),
        ..Config::default()
    });

    let text = prose();
    let input = messages(&text);
    let (out, stats) = mw.compress_messages(&input);

    // One call per text span: once for the threshold gate, once inside the
    // verbatim compressor for stats.
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(stats.method, "verbatim");
    assert_eq!(stats.input_tokens, text.len() as i64);
    assert_eq!(stats.output_tokens, text.len() as i64);
    assert_eq!(out, input);
}

#[test]
fn counter_shifts_below_threshold_boundary() {
    let text = prose();
    let input = messages(&text);
    // Estimator counts ~len/4 (< len); the stub counts len exactly, so the
    // same threshold lands on opposite sides of the gate.
    let threshold = text.len() as i64;

    let baseline = Middleware::new(Config {
        mode: "on".into(),
        threshold_tokens: threshold,
        routing: vec![("prose".into(), "verbatim".into())],
        protect_last_turns: 0,
        ..Config::default()
    });
    let (_, stats) = baseline.compress_messages(&input);
    assert_eq!(stats.method, "below-threshold");

    let hooked = Middleware::new(Config {
        mode: "on".into(),
        threshold_tokens: threshold,
        routing: vec![("prose".into(), "verbatim".into())],
        protect_last_turns: 0,
        token_counter: Some(Arc::new(|s: &str| s.len() as i64)),
        ..Config::default()
    });
    let (_, stats) = hooked.compress_messages(&input);
    assert_eq!(stats.method, "verbatim");
    assert_eq!(stats.input_tokens, text.len() as i64);
}

#[test]
fn unset_counter_keeps_estimator() {
    let mw = Middleware::new(Config {
        mode: "on".into(),
        threshold_tokens: 10,
        routing: vec![("prose".into(), "verbatim".into())],
        protect_last_turns: 0,
        ..Config::default()
    });
    let input = messages("hello world");
    let (_, stats) = mw.compress_messages(&input);
    assert_eq!(stats.input_tokens, count_tokens("hello world"));
}
