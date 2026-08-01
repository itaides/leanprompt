//! Token estimator (parity-spec §3): a state machine over code points.
//!
//! Dense scripts (CJK ideographs, Hangul, Hiragana/Katakana, Thai, Lao,
//! Khmer, Myanmar) have no space-delimited word boundaries and real BPE
//! tokenizers run far denser than 4 chars/token on them (commonly
//! ~1.5-2.5 chars/token) — charged with a separate divisor below.
//! `is_word_char`/`is_space_char` themselves are unchanged and still used
//! unmodified by the Extract compressor's word-tokenization.

use crate::chars::{is_space_char, is_word_char};
use crate::content::get_text_content;
use crate::json::Value;

const CHARS_PER_TOKEN: usize = 4;
// ceil(N * DENSE_NUM / DENSE_DEN) approximates ~1.5 chars/token.
const DENSE_NUM: usize = 2;
const DENSE_DEN: usize = 3;

fn is_dense_script_char(cp: u32) -> bool {
    matches!(cp,
        0x0e00..=0x0e7f    // Thai
        | 0x0e80..=0x0eff  // Lao
        | 0x1000..=0x109f  // Myanmar
        | 0x1100..=0x11ff  // Hangul Jamo
        | 0x1780..=0x17ff  // Khmer
        | 0x3040..=0x309f  // Hiragana
        | 0x30a0..=0x30ff  // Katakana
        | 0x3400..=0x4dbf  // CJK Unified Ideographs Extension A
        | 0x4e00..=0x9fff  // CJK Unified Ideographs
        | 0xac00..=0xd7a3  // Hangul Syllables
        | 0xf900..=0xfaff) // CJK Compatibility Ideographs
}

/// Estimate the number of tokens in `text`.
pub fn count_tokens(text: &str) -> i64 {
    if text.is_empty() {
        return 0;
    }
    let mut tokens: i64 = 0;
    let mut word_run_len: usize = 0;
    let mut dense_run_len: usize = 0;
    for c in text.chars() {
        let cp = c as u32;
        if is_word_char(cp) {
            if is_dense_script_char(cp) {
                if word_run_len > 0 {
                    tokens += run_tokens(word_run_len);
                    word_run_len = 0;
                }
                dense_run_len += 1;
            } else {
                if dense_run_len > 0 {
                    tokens += dense_tokens(dense_run_len);
                    dense_run_len = 0;
                }
                word_run_len += 1;
            }
            continue;
        }
        if word_run_len > 0 {
            tokens += run_tokens(word_run_len);
            word_run_len = 0;
        }
        if dense_run_len > 0 {
            tokens += dense_tokens(dense_run_len);
            dense_run_len = 0;
        }
        if !is_space_char(cp) {
            tokens += 1;
        }
    }
    if word_run_len > 0 {
        tokens += run_tokens(word_run_len);
    }
    if dense_run_len > 0 {
        tokens += dense_tokens(dense_run_len);
    }
    tokens.max(1)
}

fn run_tokens(len: usize) -> i64 {
    (len.div_ceil(CHARS_PER_TOKEN) as i64).max(1)
}

fn dense_tokens(len: usize) -> i64 {
    ((len * DENSE_NUM).div_ceil(DENSE_DEN) as i64).max(1)
}

/// Sum token counts over the compressible text of each message.
pub fn count_message_tokens(messages: &[Value]) -> i64 {
    messages.iter().map(|m| count_tokens(&get_text_content(m))).sum()
}
