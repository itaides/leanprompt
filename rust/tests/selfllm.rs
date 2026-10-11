//! SelfLlm tests with a fake HTTP transport: block preservation, span
//! guards, and the shorter-than-input acceptance rule.

use leanprompt::compressors::selfllm::{HttpPost, Provider, SelfLlm, SelfLlmOptions};
use leanprompt::json::{parse, Value};
use leanprompt::tokens::count_tokens;

struct Fake {
    body: String,
}

impl HttpPost for Fake {
    fn post_json(
        &self,
        _url: &str,
        _headers: &[(String, String)],
        _body: &str,
    ) -> Result<String, String> {
        Ok(self.body.clone())
    }
}

fn selfllm(body: &str) -> SelfLlm<Fake> {
    SelfLlm::new(
        SelfLlmOptions {
            provider: Provider::Anthropic,
            model: None,
            api_key: "k".into(),
            ratio_millis: 300,
            max_summary_tokens: 500,
            base_url: None,
        },
        Fake { body: body.into() },
    )
}

/// Long prose span (> 40 estimator tokens) that clears the span guard.
fn prose() -> String {
    "The incident report describes a lengthy sequence of unfortunate events \
     in production. The scheduler fired the rotation job during an active \
     release window on the gamma cluster. Basically this was all just \
     terrible timing between two independent systems. The release step \
     retried three times with exponential backoff and gave up."
        .to_string()
}

#[test]
fn preserves_block_arrays_and_fields() {
    let body = r#"{"content":[{"text":"sum"}],"usage":{"input_tokens":90,"output_tokens":5}}"#;
    let s = selfllm(body);
    let text = prose();
    let msg = parse(&format!(
        r#"{{"role":"user","name":"agent","content":[{{"type":"tool_result","tool_use_id":"t1","content":"{}"}},{{"type":"text","text":"{}"}},{{"type":"image","source":"AAAA"}}]}}"#,
        text, text
    ))
    .unwrap();

    let (out, stats) = s.compress(&[msg]).unwrap();
    assert_eq!(out.len(), 1);
    let out_msg = &out[0];
    assert_eq!(out_msg.str_field("role"), "user");
    assert_eq!(out_msg.str_field("name"), "agent");

    let blocks = out_msg.get("content").and_then(Value::as_arr).unwrap();
    assert_eq!(blocks.len(), 3);
    assert_eq!(blocks[0].str_field("type"), "tool_result");
    assert_eq!(blocks[0].str_field("tool_use_id"), "t1");
    assert_eq!(blocks[0].str_field("content"), "sum");
    assert_eq!(blocks[1].str_field("type"), "text");
    assert_eq!(blocks[1].str_field("text"), "sum");
    assert_eq!(blocks[2].str_field("type"), "image");

    // Stats are estimator counts, not provider usage.
    let expected_in = 2 * count_tokens(&text);
    assert_eq!(stats.input_tokens, expected_in);
    assert!(stats.output_tokens < stats.input_tokens);
    assert_eq!(stats.method, "selfllm");
}

#[test]
fn empty_or_not_shorter_summary_keeps_original() {
    for body in [
        r#"{"content":[{"text":""}]}"#.to_string(),
        format!(
            r#"{{"content":[{{"text":"{} plus extra words making the summary longer"}}]}}"#,
            prose()
        ),
    ] {
        let s = selfllm(&body);
        let text = prose();
        let msg = parse(&format!(r#"{{"role":"user","content":"{}"}}"#, text)).unwrap();
        let (out, stats) = s.compress(&[msg]).unwrap();
        assert_eq!(out[0].str_field("content"), text);
        assert_eq!(stats.input_tokens, stats.output_tokens);
    }
}

#[test]
fn string_content_summarized_in_place() {
    let body = r#"{"content":[{"text":"sum"}]}"#;
    let s = selfllm(body);
    let text = prose();
    let msg = parse(&format!(
        r#"{{"role":"assistant","tool_calls":[{{"id":"c1"}}],"content":"{}"}}"#,
        text
    ))
    .unwrap();
    let (out, _stats) = s.compress(&[msg]).unwrap();
    assert_eq!(out[0].str_field("content"), "sum");
    assert_eq!(out[0].str_field("role"), "assistant");
    assert!(out[0].get("tool_calls").is_some());
}

#[test]
fn structural_and_short_spans_verbatim() {
    let body = r#"{"content":[{"text":"sum"}]}"#;
    let s = selfllm(body);
    let structural = "```json\n{}\n```";
    let structural_json = structural.replace('\n', "\\n");
    let msg = parse(&format!(
        r#"{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"t1","content":"{}"}},{{"type":"text","text":"short"}}]}}"#,
        structural_json
    ))
    .unwrap();
    let (out, _stats) = s.compress(&[msg]).unwrap();
    let blocks = out[0].get("content").and_then(Value::as_arr).unwrap();
    assert_eq!(blocks[0].str_field("content"), structural);
    assert_eq!(blocks[1].str_field("text"), "short");
}

#[test]
fn transport_error_is_returned() {
    struct Failing;
    impl HttpPost for Failing {
        fn post_json(
            &self,
            _url: &str,
            _headers: &[(String, String)],
            _body: &str,
        ) -> Result<String, String> {
            Err("connection refused".into())
        }
    }
    let s = SelfLlm::new(
        SelfLlmOptions {
            provider: Provider::OpenAi,
            model: None,
            api_key: "k".into(),
            ratio_millis: 300,
            max_summary_tokens: 500,
            base_url: None,
        },
        Failing,
    );
    let msg = parse(&format!(r#"{{"role":"user","content":"{}"}}"#, prose())).unwrap();
    let err = s.compress(&[msg]).unwrap_err();
    assert!(err.contains("connection refused"));
}
