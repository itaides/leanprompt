//! Golden-vector parity tests: the Rust implementation must reproduce the
//! `parity/*.json` vectors emitted by the TypeScript reference byte-for-byte
//! (text and integer fields; floats are never compared).

use std::fs;
use std::path::PathBuf;

use leanprompt::compressors::extract::{segment_sentences, select_sentences, word_tokens, Sentence};
use leanprompt::json::{parse, Value};
use leanprompt::middleware::{Config, Middleware};
use leanprompt::strategies::{DedupStrategy, PurgeErrorsStrategy, Strategy};
use leanprompt::tokens::count_tokens;
use leanprompt::{classify, content, RepeatTracker};

fn load(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("parity")
        .join(name);
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    parse(&text).unwrap_or_else(|e| panic!("cannot parse {}: {e}", path.display()))
}

fn cases(value: &Value) -> &[Value] {
    value.as_arr().expect("vector file must be a JSON array")
}

#[test]
fn content_vectors() {
    for case in cases(&load("content.json")) {
        let name = case.str_field("name");
        let message = case.get("message").expect("message");
        let expected = case.str_field("text");
        assert_eq!(
            content::get_text_content(message),
            expected,
            "content case {name}"
        );
    }
}

#[test]
fn classifier_vectors() {
    for case in cases(&load("classifier.json")) {
        let name = case.str_field("name");
        let message = case.get("message").expect("message");
        let expected = case.str_field("label");
        assert_eq!(
            classify(message).as_str(),
            expected,
            "classifier case {name}"
        );
    }
}

#[test]
fn repeat_tracker_vectors() {
    let mut tracker = RepeatTracker::new();
    for case in cases(&load("repeat-tracker.json")) {
        let index = case.get("index").and_then(Value::as_i64).unwrap();
        let message = case.get("message").expect("message");
        let expected = case.get("isRepeat").and_then(Value::as_bool).unwrap();
        assert_eq!(
            tracker.is_repeat(message),
            expected,
            "repeat-tracker index {index}"
        );
    }
}

#[test]
fn token_vectors() {
    for case in cases(&load("tokens.json")) {
        let text = case.str_field("text");
        let expected = case.get("tokens").and_then(Value::as_i64).unwrap();
        assert_eq!(count_tokens(text), expected, "tokens for {text:?}");
    }
}

#[test]
fn word_token_vectors() {
    for case in cases(&load("word-tokens.json")) {
        let text = case.str_field("text");
        let expected: Vec<String> = case
            .get("tokens")
            .and_then(Value::as_arr)
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert_eq!(word_tokens(text), expected, "word tokens for {text:?}");
    }
}

#[test]
fn strategy_vectors() {
    let data = load("strategies.json");
    let input = data.get("input").and_then(Value::as_arr).unwrap().to_vec();

    let dedup_expected = data.get("dedup").and_then(Value::as_arr).unwrap();
    let dedup_actual = DedupStrategy.apply(input.clone());
    assert_eq!(dedup_actual.as_slice(), dedup_expected, "dedup output");

    let purge_expected = data.get("purgeAfter2").and_then(Value::as_arr).unwrap();
    let purge_actual = PurgeErrorsStrategy { after_turns: 2 }.apply(input);
    assert_eq!(purge_actual.as_slice(), purge_expected, "purge output");
}

#[test]
fn extract_vectors() {
    for case in cases(&load("extract.json")) {
        let name = case.str_field("name");
        let text = case.str_field("text");
        let ratio_millis = case.get("ratioMillis").and_then(Value::as_i64).unwrap();

        let sentences = segment_sentences(text);
        let expected_sentences: Vec<Sentence> = case
            .get("sentences")
            .and_then(Value::as_arr)
            .unwrap()
            .iter()
            .map(|s| Sentence {
                text: s.str_field("text").to_string(),
                list_item: s.get("listItem").and_then(Value::as_bool).unwrap(),
            })
            .collect();
        assert_eq!(sentences, expected_sentences, "segmentation for {name}");

        let expected_selected = case.str_field("selected");
        assert_eq!(
            select_sentences(&sentences, ratio_millis),
            expected_selected,
            "selection for {name}"
        );
    }
}

#[test]
fn middleware_vectors() {
    let data = load("middleware.json");
    let cfg = data.get("config").expect("config");

    // Mirror the golden config (see ts/scripts/gen-parity.ts).
    let routing = cfg
        .get("routing")
        .map(|r| match r {
            Value::Obj(entries) => entries
                .iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
                .collect(),
            _ => Vec::new(),
        })
        .unwrap_or_default();
    let ratio = cfg
        .get("extract")
        .and_then(|e| e.get("ratio"))
        .map(|v| match v {
            Value::Num(n) => (n * 1000.0).round() as i64,
            _ => 500,
        })
        .unwrap_or(500);
    let config = Config {
        mode: cfg.str_field("mode").to_string(),
        threshold_tokens: cfg
            .get("trigger")
            .and_then(|t| t.get("thresholdTokens"))
            .and_then(Value::as_i64)
            .unwrap_or(2000),
        routing,
        extract_ratio_millis: ratio,
        protect_last_turns: cfg
            .get("protect")
            .and_then(|p| p.get("lastTurns"))
            .and_then(Value::as_i64)
            .unwrap_or(2) as usize,
        ..Config::default()
    };

    let input = data.get("input").and_then(Value::as_arr).unwrap();
    let (output, stats) = Middleware::new(config).compress_messages(input);

    let expected_output = data.get("output").and_then(Value::as_arr).unwrap();
    assert_eq!(output.as_slice(), expected_output, "middleware output messages");
    assert_eq!(
        stats.input_tokens,
        data.get("inputTokens").and_then(Value::as_i64).unwrap(),
        "input tokens"
    );
    assert_eq!(
        stats.output_tokens,
        data.get("outputTokens").and_then(Value::as_i64).unwrap(),
        "output tokens"
    );
    assert_eq!(stats.method, data.str_field("method"), "method");
}
