//! SelfLLM — compression by delegation to the user's own configured LLM.
//!
//! Zero-dependency posture: std has no HTTPS, so the crate does not ship a
//! transport. Callers implement [`HttpPost`] with whatever HTTP client they
//! already have (ureq, reqwest, curl, ...); this module owns everything else
//! — request building (system prompt, user-prompt template, reasoning-model
//! handling) and response parsing for anthropic / openai / gemini.

use crate::compressors::extract::{looks_structural, MIN_SPAN_TOKENS};
use crate::content::get_text_content;
use crate::json::{self, Value};
use crate::stats::CompressionStats;
use crate::tokens::count_tokens;

/// Minimal transport the caller provides: POST `body` (JSON) to `url` with
/// `headers`, return the response body text (error string on failure).
pub trait HttpPost {
    fn post_json(
        &self,
        url: &str,
        headers: &[(String, String)],
        body: &str,
    ) -> Result<String, String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Anthropic,
    OpenAi,
    Gemini,
}

const OPENAI_REASONING_PREFIXES: &[&str] = &["gpt-5", "o1", "o3", "o4"];
const GEMINI_THINKING_PREFIXES: &[&str] = &["gemini-2.5", "gemini-3"];

const SYSTEM_PROMPT: &str = "You are a context compression assistant.\n\
Produce a compact, faithful summary of the provided content that\n\
preserves everything a downstream model would need to continue the\n\
conversation coherently.\n\n\
Keep:\n\
- specific facts, numbers, entity names, identifiers\n\
- decisions that have already been made\n\
- code snippets, file paths, and error messages verbatim\n\
- the user's stated goals and constraints\n\n\
Omit:\n\
- repetitive phrasing and polite filler\n\
- intermediate reasoning that reached the same conclusion\n\
- commentary about what was compressed\n\n\
Return only the summary. No preamble, no explanation.";

pub struct SelfLlmOptions {
    pub provider: Provider,
    pub model: Option<String>,
    pub api_key: String,
    /// Suggested keep-ratio in thousandths, passed to the LLM prompt.
    pub ratio_millis: i64,
    pub max_summary_tokens: i64,
    pub base_url: Option<String>,
}

pub struct SelfLlm<T: HttpPost> {
    provider: Provider,
    model: String,
    api_key: String,
    ratio_millis: i64,
    max_summary_tokens: i64,
    base_url: String,
    transport: T,
}

impl<T: HttpPost> SelfLlm<T> {
    pub fn new(options: SelfLlmOptions, transport: T) -> Self {
        let model = options.model.unwrap_or_else(|| {
            match options.provider {
                Provider::Anthropic => "claude-haiku-4-5",
                Provider::OpenAi => "gpt-4o-mini",
                Provider::Gemini => "gemini-2.5-flash",
            }
            .to_string()
        });
        let base_url = options
            .base_url
            .unwrap_or_else(|| {
                match options.provider {
                    Provider::Anthropic => "https://api.anthropic.com",
                    Provider::OpenAi => "https://api.openai.com",
                    Provider::Gemini => "https://generativelanguage.googleapis.com",
                }
                .to_string()
            })
            .trim_end_matches('/')
            .to_string();
        SelfLlm {
            provider: options.provider,
            model,
            api_key: options.api_key,
            ratio_millis: options.ratio_millis,
            max_summary_tokens: options.max_summary_tokens,
            base_url,
            transport,
        }
    }

    /// Summarize compressible text spans in place: the returned messages
    /// keep their original shape (block arrays, tool fields, metadata) with
    /// only `text`/`tool_result` string content replaced by summaries that
    /// are strictly shorter by estimator tokens.
    pub fn compress(&self, messages: &[Value]) -> Result<(Vec<Value>, CompressionStats), String> {
        if messages.is_empty() {
            return Ok((messages.to_vec(), CompressionStats::with_method("selfllm")));
        }
        if !messages
            .iter()
            .any(|m| !get_text_content(m).trim().is_empty())
        {
            return Ok((messages.to_vec(), CompressionStats::with_method("selfllm")));
        }

        let mut out = Vec::with_capacity(messages.len());
        let mut total_in = 0;
        let mut total_out = 0;
        for msg in messages {
            let (new_msg, in_tok, out_tok) = self.compress_message(msg)?;
            out.push(new_msg);
            total_in += in_tok;
            total_out += out_tok;
        }
        Ok((
            out,
            CompressionStats::counted("selfllm", total_in, total_out),
        ))
    }

    fn compress_message(&self, msg: &Value) -> Result<(Value, i64, i64), String> {
        match msg.get("content") {
            Some(Value::Str(s)) => {
                if s.trim().is_empty() {
                    return Ok((msg.clone(), 0, 0));
                }
                let (compressed, input, output) = self.summarize_text(s)?;
                Ok((
                    msg.with_field("content", Value::Str(compressed)),
                    input,
                    output,
                ))
            }
            Some(Value::Arr(blocks)) => {
                let mut new_blocks = Vec::with_capacity(blocks.len());
                let mut total_in = 0;
                let mut total_out = 0;
                for block in blocks {
                    let (nb, i, o) = self.compress_block(block)?;
                    new_blocks.push(nb);
                    total_in += i;
                    total_out += o;
                }
                Ok((
                    msg.with_field("content", Value::Arr(new_blocks)),
                    total_in,
                    total_out,
                ))
            }
            // Single-object content is one block; other shapes pass through.
            Some(block @ Value::Obj(_)) => {
                let (nb, i, o) = self.compress_block(block)?;
                Ok((msg.with_field("content", nb), i, o))
            }
            _ => Ok((msg.clone(), 0, 0)),
        }
    }

    fn compress_block(&self, block: &Value) -> Result<(Value, i64, i64), String> {
        if !matches!(block, Value::Obj(_)) {
            return Ok((block.clone(), 0, 0));
        }
        match block.str_field("type") {
            "text" => {
                let text = block.str_field("text");
                if !text.trim().is_empty() {
                    let (compressed, i, o) = self.summarize_text(text)?;
                    return Ok((block.with_field("text", Value::Str(compressed)), i, o));
                }
                Ok((block.clone(), 0, 0))
            }
            "tool_result" => match block.get("content") {
                Some(Value::Str(inner)) => {
                    if inner.trim().is_empty() {
                        return Ok((block.clone(), 0, 0));
                    }
                    // Structural output must reach the model verbatim.
                    if looks_structural(inner) {
                        let tokens = count_tokens(inner);
                        return Ok((block.clone(), tokens, tokens));
                    }
                    let (compressed, i, o) = self.summarize_text(inner)?;
                    Ok((block.with_field("content", Value::Str(compressed)), i, o))
                }
                Some(Value::Arr(items)) => {
                    let mut new_items = Vec::with_capacity(items.len());
                    let mut total_in = 0;
                    let mut total_out = 0;
                    for item in items {
                        let (nb, i, o) = self.compress_block(item)?;
                        new_items.push(nb);
                        total_in += i;
                        total_out += o;
                    }
                    Ok((
                        block.with_field("content", Value::Arr(new_items)),
                        total_in,
                        total_out,
                    ))
                }
                _ => Ok((block.clone(), 0, 0)),
            },
            // Pass-through block types: token-count so ratios stay honest.
            _ => {
                let wrapper = Value::Obj(vec![
                    ("role".to_string(), Value::Str(String::new())),
                    ("content".to_string(), Value::Arr(vec![block.clone()])),
                ]);
                let text = get_text_content(&wrapper);
                let tokens = if text.is_empty() {
                    0
                } else {
                    count_tokens(&text)
                };
                Ok((block.clone(), tokens, tokens))
            }
        }
    }

    /// Summarize one span. Returns the original verbatim when the span is
    /// guarded (structural, under MIN_SPAN_TOKENS) or the provider summary
    /// is empty or not strictly shorter than the input.
    fn summarize_text(&self, text: &str) -> Result<(String, i64, i64), String> {
        let in_tok = count_tokens(text);
        if looks_structural(text) || in_tok < MIN_SPAN_TOKENS {
            return Ok((text.to_string(), in_tok, in_tok));
        }
        let summary = self.call(&self.user_prompt(text))?;
        let summary = summary.trim().to_string();
        let out_tok = count_tokens(&summary);
        if summary.is_empty() || out_tok >= in_tok {
            return Ok((text.to_string(), in_tok, in_tok));
        }
        Ok((summary, in_tok, out_tok))
    }

    fn user_prompt(&self, text: &str) -> String {
        let pct = (self.ratio_millis + 5) / 10; // thousandths → rounded percent
        format!(
            "Compress the content below to roughly {pct}% of its original \
             length while preserving all information a downstream model \
             would need to continue.\n\n<content>\n{text}\n</content>"
        )
    }

    fn call(&self, user_prompt: &str) -> Result<String, String> {
        match self.provider {
            Provider::Anthropic => self.call_anthropic(user_prompt),
            Provider::OpenAi => self.call_openai(user_prompt),
            Provider::Gemini => self.call_gemini(user_prompt),
        }
    }

    fn call_anthropic(&self, user_prompt: &str) -> Result<String, String> {
        let body = Value::Obj(vec![
            ("model".into(), Value::Str(self.model.clone())),
            (
                "max_tokens".into(),
                Value::Num(self.max_summary_tokens as f64),
            ),
            ("system".into(), Value::Str(SYSTEM_PROMPT.to_string())),
            (
                "messages".into(),
                Value::Arr(vec![Value::Obj(vec![
                    ("role".into(), Value::Str("user".into())),
                    ("content".into(), Value::Str(user_prompt.to_string())),
                ])]),
            ),
        ]);
        let response = self.transport.post_json(
            &format!("{}/v1/messages", self.base_url),
            &[
                ("x-api-key".into(), self.api_key.clone()),
                ("anthropic-version".into(), "2023-06-01".into()),
                ("content-type".into(), "application/json".into()),
            ],
            &json::canonical(&body),
        )?;
        let parsed = json::parse(&response)?;
        Ok(parsed
            .get("content")
            .and_then(Value::as_arr)
            .and_then(|a| a.first())
            .map(|b| b.str_field("text").to_string())
            .unwrap_or_default())
    }

    fn call_openai(&self, user_prompt: &str) -> Result<String, String> {
        let mut fields = vec![
            ("model".to_string(), Value::Str(self.model.clone())),
            (
                "max_completion_tokens".to_string(),
                Value::Num(self.max_summary_tokens as f64),
            ),
            (
                "messages".to_string(),
                Value::Arr(vec![
                    Value::Obj(vec![
                        ("role".into(), Value::Str("system".into())),
                        ("content".into(), Value::Str(SYSTEM_PROMPT.to_string())),
                    ]),
                    Value::Obj(vec![
                        ("role".into(), Value::Str("user".into())),
                        ("content".into(), Value::Str(user_prompt.to_string())),
                    ]),
                ]),
            ),
        ];
        // Reasoning models otherwise spend the completion budget on hidden
        // reasoning; compression needs none.
        if OPENAI_REASONING_PREFIXES
            .iter()
            .any(|p| self.model.starts_with(p))
        {
            fields.push(("reasoning_effort".to_string(), Value::Str("minimal".into())));
        }
        let response = self.transport.post_json(
            &format!("{}/v1/chat/completions", self.base_url),
            &[
                ("authorization".into(), format!("Bearer {}", self.api_key)),
                ("content-type".into(), "application/json".into()),
            ],
            &json::canonical(&Value::Obj(fields)),
        )?;
        let parsed = json::parse(&response)?;
        Ok(parsed
            .get("choices")
            .and_then(Value::as_arr)
            .and_then(|a| a.first())
            .and_then(|c| c.get("message"))
            .map(|m| m.str_field("content").to_string())
            .unwrap_or_default())
    }

    fn call_gemini(&self, user_prompt: &str) -> Result<String, String> {
        let mut generation_config = vec![(
            "maxOutputTokens".to_string(),
            Value::Num(self.max_summary_tokens as f64),
        )];
        // Gemini 2.5+ thinking burns the output budget on hidden tokens.
        if GEMINI_THINKING_PREFIXES
            .iter()
            .any(|p| self.model.starts_with(p))
        {
            generation_config.push((
                "thinkingConfig".to_string(),
                Value::Obj(vec![("thinkingBudget".into(), Value::Num(0.0))]),
            ));
        }
        let body = Value::Obj(vec![
            (
                "system_instruction".into(),
                Value::Obj(vec![(
                    "parts".into(),
                    Value::Arr(vec![Value::Obj(vec![(
                        "text".into(),
                        Value::Str(SYSTEM_PROMPT.to_string()),
                    )])]),
                )]),
            ),
            (
                "contents".into(),
                Value::Arr(vec![Value::Obj(vec![
                    ("role".into(), Value::Str("user".into())),
                    (
                        "parts".into(),
                        Value::Arr(vec![Value::Obj(vec![(
                            "text".into(),
                            Value::Str(user_prompt.to_string()),
                        )])]),
                    ),
                ])]),
            ),
            ("generationConfig".into(), Value::Obj(generation_config)),
        ]);
        let response = self.transport.post_json(
            &format!(
                "{}/v1beta/models/{}:generateContent",
                self.base_url, self.model
            ),
            &[
                ("x-goog-api-key".into(), self.api_key.clone()),
                ("content-type".into(), "application/json".into()),
            ],
            &json::canonical(&body),
        )?;
        let parsed = json::parse(&response)?;
        Ok(parsed
            .get("candidates")
            .and_then(Value::as_arr)
            .and_then(|a| a.first())
            .and_then(|c| c.get("content"))
            .and_then(|c| c.get("parts"))
            .and_then(Value::as_arr)
            .map(|parts| {
                parts
                    .iter()
                    .map(|p| p.str_field("text"))
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default())
    }
}
