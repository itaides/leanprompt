//! Token estimator (parity-spec §3): a state machine over code points.

use crate::chars::{is_space_char, is_word_char};
use crate::content::get_text_content;
use crate::json::Value;

const CHARS_PER_TOKEN: usize = 4;

/// Estimate the number of tokens in `text`.
pub fn count_tokens(text: &str) -> i64 {
    if text.is_empty() {
        return 0;
    }
    let mut tokens: i64 = 0;
    let mut run_len: usize = 0;
    for c in text.chars() {
        let cp = c as u32;
        if is_word_char(cp) {
            run_len += 1;
            continue;
        }
        if run_len > 0 {
            tokens += run_tokens(run_len);
            run_len = 0;
        }
        if !is_space_char(cp) {
            tokens += 1;
        }
    }
    if run_len > 0 {
        tokens += run_tokens(run_len);
    }
    tokens.max(1)
}

fn run_tokens(len: usize) -> i64 {
    (len.div_ceil(CHARS_PER_TOKEN) as i64).max(1)
}

/// Sum token counts over the compressible text of each message.
pub fn count_message_tokens(messages: &[Value]) -> i64 {
    messages.iter().map(|m| count_tokens(&get_text_content(m))).sum()
}
