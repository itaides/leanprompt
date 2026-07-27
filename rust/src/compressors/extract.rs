//! Extract — weights-free heuristic extractive compression (parity-spec §8).
//!
//! All-integer scoring, pinned character classes, explicit tiebreaks: output
//! is byte-identical to the TypeScript reference for identical inputs.

use crate::chars::{ascii_lower, is_word_char};
use crate::compressors::Compressor;
use crate::content::get_text_content;
use crate::json::Value;
use crate::stats::CompressionStats;
use crate::tokens::count_tokens;

const DEFAULT_RATIO_MILLIS: i64 = 500;
const SCALE: i64 = 1000;

const BOOST_DIGITS: i64 = 350;
const BOOST_ENTITY: i64 = 200;
const BOOST_QUOTED: i64 = 200;
const BOOST_IDENTIFIER: i64 = 300;
const BOOST_POSITION: i64 = 250;
const BOOST_IMPERATIVE: i64 = 400;
const PENALTY_FILLER: i64 = 400;

const REDUNDANCY_PCT: i64 = 60;
const MIN_SENTENCE_CHARS: usize = 12;
const MIN_SENTENCES_TO_COMPRESS: usize = 3;
const MIN_SPAN_TOKENS: i64 = 40;
const MIN_ASCII_PCT: usize = 60;

const STRUCTURAL_MARKERS: &[&str] = &["```", "Traceback (most recent call last)"];

const ABBREVIATIONS: &[&str] = &[
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st",
    "vs", "etc", "e.g", "i.e", "cf", "al", "approx",
    "no", "fig", "eq", "sec", "min", "max", "avg",
];

const FILLER_OPENERS: &[&str] = &[
    "basically",
    "essentially",
    "as mentioned",
    "as noted",
    "as discussed",
    "as you can see",
    "in other words",
    "needless to say",
    "it goes without saying",
    "to be honest",
    "in my opinion",
    "i think that",
    "it is worth noting",
    "it's worth noting",
    "obviously",
    "of course",
];

const PROHIBITION_MARKERS: &[&str] = &["do not", "don't", "must not", "never "];

const CONSTRAINT_MARKERS: &[&str] = &[
    "must ", "always", "only ", "except", "required", "important",
    "warning", "note:", "make sure", "be careful",
];

const ANAPHORIC_OPENERS: &[&str] = &[
    "this", "that", "these", "those", "it", "they",
    "however", "therefore", "thus", "so", "consequently",
    "instead", "otherwise", "also", "additionally", "hence",
];

const STOPWORDS: &[&str] = &[
    "a", "an", "the", "and", "or", "but", "if", "then", "else", "when",
    "at", "by", "for", "with", "about", "against", "between", "into",
    "through", "during", "before", "after", "above", "below", "to", "from",
    "up", "down", "in", "out", "on", "off", "over", "under", "again",
    "further", "once", "here", "there", "all", "any", "both", "each",
    "few", "more", "most", "other", "some", "such", "only", "own", "same",
    "so", "than", "too", "very", "can", "will", "just", "should", "now",
    "is", "are", "was", "were", "be", "been", "being", "have", "has",
    "had", "having", "do", "does", "did", "doing", "would", "could",
    "ought", "i", "you", "he", "she", "it", "we", "they", "them", "his",
    "her", "its", "our", "their", "this", "that", "these", "those", "am",
    "of", "as", "not", "no", "nor", "what", "which", "who", "whom",
];

fn is_stopword(w: &str) -> bool {
    STOPWORDS.contains(&w)
}

// ------------------------------------------------------------------------ //
// Compressor
// ------------------------------------------------------------------------ //

pub struct Extract {
    /// Keep-ratio in integer thousandths (500 = keep half).
    pub ratio_millis: i64,
}

impl Default for Extract {
    fn default() -> Self {
        Extract { ratio_millis: DEFAULT_RATIO_MILLIS }
    }
}

impl Extract {
    pub fn new(ratio_millis: i64) -> Self {
        assert!(
            ratio_millis > 0 && ratio_millis <= 1000,
            "Extract ratio_millis must be in (0, 1000], got {ratio_millis}"
        );
        Extract { ratio_millis }
    }

    fn compress_message(&self, msg: &Value) -> (Value, i64, i64) {
        match msg.get("content") {
            Some(Value::Str(s)) => {
                if s.trim().is_empty() {
                    return (msg.clone(), 0, 0);
                }
                let (compressed, input, output) = self.compress_text(s);
                (msg.with_field("content", Value::Str(compressed)), input, output)
            }
            Some(Value::Arr(blocks)) => {
                let mut new_blocks = Vec::with_capacity(blocks.len());
                let mut total_in = 0;
                let mut total_out = 0;
                for block in blocks {
                    let (nb, i, o) = self.compress_block(block);
                    new_blocks.push(nb);
                    total_in += i;
                    total_out += o;
                }
                (msg.with_field("content", Value::Arr(new_blocks)), total_in, total_out)
            }
            _ => (msg.clone(), 0, 0),
        }
    }

    fn compress_block(&self, block: &Value) -> (Value, i64, i64) {
        if !matches!(block, Value::Obj(_)) {
            return (block.clone(), 0, 0);
        }
        match block.str_field("type") {
            "text" => {
                let text = block.str_field("text");
                if !text.trim().is_empty() {
                    let (compressed, i, o) = self.compress_text(text);
                    return (block.with_field("text", Value::Str(compressed)), i, o);
                }
                (block.clone(), 0, 0)
            }
            "tool_result" => match block.get("content") {
                Some(Value::Str(inner)) => {
                    if inner.trim().is_empty() {
                        return (block.clone(), 0, 0);
                    }
                    // Structural output must reach the model verbatim.
                    if looks_structural(inner) {
                        let tokens = count_tokens(inner);
                        return (block.clone(), tokens, tokens);
                    }
                    let (compressed, i, o) = self.compress_text(inner);
                    (block.with_field("content", Value::Str(compressed)), i, o)
                }
                Some(Value::Arr(items)) => {
                    let mut new_items = Vec::with_capacity(items.len());
                    let mut total_in = 0;
                    let mut total_out = 0;
                    for item in items {
                        let (nb, i, o) = self.compress_block(item);
                        new_items.push(nb);
                        total_in += i;
                        total_out += o;
                    }
                    (block.with_field("content", Value::Arr(new_items)), total_in, total_out)
                }
                _ => (block.clone(), 0, 0),
            },
            // Pass-through block types: token-count so ratios stay honest.
            _ => {
                let wrapper = Value::Obj(vec![
                    ("role".to_string(), Value::Str(String::new())),
                    ("content".to_string(), Value::Arr(vec![block.clone()])),
                ]);
                let text = get_text_content(&wrapper);
                let tokens = if text.is_empty() { 0 } else { count_tokens(&text) };
                (block.clone(), tokens, tokens)
            }
        }
    }

    fn compress_text(&self, text: &str) -> (String, i64, i64) {
        let in_tok = count_tokens(text);
        if looks_structural(text)
            || in_tok < MIN_SPAN_TOKENS
            || !mostly_ascii(text)
        {
            return (text.to_string(), in_tok, in_tok);
        }
        let sentences = segment_sentences(text);
        if sentences.len() < MIN_SENTENCES_TO_COMPRESS {
            return (text.to_string(), in_tok, in_tok);
        }
        let compressed = select_sentences(&sentences, self.ratio_millis);
        let out_tok = count_tokens(&compressed);
        if out_tok >= in_tok {
            return (text.to_string(), in_tok, in_tok);
        }
        (compressed, in_tok, out_tok)
    }
}

impl Compressor for Extract {
    fn name(&self) -> &'static str {
        "extract"
    }

    fn compress(&self, messages: &[Value]) -> (Vec<Value>, CompressionStats) {
        if messages.is_empty()
            || !messages.iter().any(|m| !get_text_content(m).trim().is_empty())
        {
            return (messages.to_vec(), CompressionStats::with_method("extract"));
        }
        let mut out = Vec::with_capacity(messages.len());
        let mut total_in = 0;
        let mut total_out = 0;
        for msg in messages {
            let (new_msg, i, o) = self.compress_message(msg);
            out.push(new_msg);
            total_in += i;
            total_out += o;
        }
        (out, CompressionStats::counted("extract", total_in, total_out))
    }
}

// ------------------------------------------------------------------------ //
// Pure helpers
// ------------------------------------------------------------------------ //

pub fn looks_structural(text: &str) -> bool {
    STRUCTURAL_MARKERS.iter().any(|m| text.contains(m))
}

pub fn mostly_ascii(text: &str) -> bool {
    let mut ascii = 0usize;
    let mut total = 0usize;
    for c in text.chars() {
        total += 1;
        if (c as u32) < 0x80 {
            ascii += 1;
        }
    }
    total == 0 || ascii * 100 >= total * MIN_ASCII_PCT
}

#[derive(Debug, Clone, PartialEq)]
pub struct Sentence {
    pub text: String,
    pub list_item: bool,
}

/// Sentence segmentation (parity-spec §8).
pub fn segment_sentences(text: &str) -> Vec<Sentence> {
    let mut out = Vec::new();
    for raw_line in text.split('\n') {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if is_list_line(line) {
            out.push(Sentence { text: line.to_string(), list_item: true });
            continue;
        }
        let chars: Vec<char> = line.chars().collect();
        if chars.len() <= MIN_SENTENCE_CHARS {
            out.push(Sentence { text: line.to_string(), list_item: false });
            continue;
        }
        let mut start = 0usize;
        let mut i = 0usize;
        while i + 1 < chars.len() {
            let ch = chars[i];
            if ch != '.' && ch != '!' && ch != '?' {
                i += 1;
                continue;
            }
            let next = chars[i + 1];
            if next != ' ' && next != '\t' {
                i += 1;
                continue; // decimal, URL, file.ext
            }
            if ch == '.' {
                let prev = last_word_before(&chars, i);
                let lower = ascii_lower(&prev);
                if ABBREVIATIONS.contains(&lower.as_str()) {
                    i += 1;
                    continue;
                }
                // Single capital letter → initials ("J. Smith").
                let prev_chars: Vec<char> = prev.chars().collect();
                if prev_chars.len() == 1 && prev_chars[0].is_ascii_uppercase() {
                    i += 1;
                    continue;
                }
            }
            let piece: String = chars[start..=i].iter().collect();
            let piece = piece.trim().to_string();
            if !piece.is_empty() {
                out.push(Sentence { text: piece, list_item: false });
            }
            start = i + 1;
            i += 1;
        }
        let rest: String = chars[start..].iter().collect();
        let rest = rest.trim().to_string();
        if !rest.is_empty() {
            out.push(Sentence { text: rest, list_item: false });
        }
    }
    out
}

fn is_list_line(line: &str) -> bool {
    if line.starts_with('|') {
        return true;
    }
    let chars: Vec<char> = line.chars().collect();
    if (line.starts_with("- ") || line.starts_with("* ") || line.starts_with("+ "))
        && chars.len() > 2
    {
        return true;
    }
    let mut i = 0usize;
    while i < chars.len() && chars[i].is_ascii_digit() {
        i += 1;
    }
    if i > 0 && i + 1 < chars.len() {
        let mark = chars[i];
        if (mark == '.' || mark == ')') && chars[i + 1] == ' ' {
            return true;
        }
    }
    false
}

fn last_word_before(chars: &[char], dot_index: usize) -> String {
    let mut start = dot_index;
    while start > 0 {
        let c = chars[start - 1];
        if is_word_char(c as u32) || c == '.' {
            start -= 1;
        } else {
            break;
        }
    }
    let word: String = chars[start..dot_index].iter().collect();
    word.trim_start_matches('.').to_string()
}

/// ASCII-lowercased word tokens (runs of is_word_char code points).
pub fn word_tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut run = String::new();
    for c in ascii_lower(text).chars() {
        if is_word_char(c as u32) {
            run.push(c);
        } else if !run.is_empty() {
            out.push(std::mem::take(&mut run));
        }
    }
    if !run.is_empty() {
        out.push(run);
    }
    out
}

/// Bit length of a non-negative integer (0 → 0).
pub fn bit_length(mut n: i64) -> i64 {
    let mut bits = 0;
    while n > 0 {
        bits += 1;
        n /= 2;
    }
    bits
}

struct Scored {
    index: usize,
    text: String,
    list_item: bool,
    tokens: i64,
    score: i64,
    anaphoric: bool,
    digit_tokens: Vec<String>,
}

/// Greedy budgeted selection with redundancy filter and anaphora rule
/// (parity-spec §8). Output joins kept sentences in original order.
pub fn select_sentences(sentences: &[Sentence], ratio_millis: i64) -> String {
    use std::collections::HashMap;

    let mut term_counts: HashMap<String, i64> = HashMap::new();
    let mut total_terms: i64 = 0;
    let tokenized: Vec<Vec<String>> = sentences
        .iter()
        .map(|s| word_tokens(&s.text))
        .collect();
    for words in &tokenized {
        for w in words {
            if is_stopword(w) {
                continue;
            }
            *term_counts.entry(w.clone()).or_insert(0) += 1;
            total_terms += 1;
        }
    }

    let scored: Vec<Scored> = sentences
        .iter()
        .enumerate()
        .map(|(index, s)| {
            let words = &tokenized[index];
            Scored {
                index,
                text: s.text.clone(),
                list_item: s.list_item,
                tokens: count_tokens(&s.text),
                score: score_sentence(
                    &s.text, words, index, sentences.len(), &term_counts, total_terms,
                ),
                anaphoric: words
                    .first()
                    .is_some_and(|w| ANAPHORIC_OPENERS.contains(&w.as_str())),
                digit_tokens: words
                    .iter()
                    .filter(|w| w.chars().any(|c| c.is_ascii_digit()))
                    .cloned()
                    .collect(),
            }
        })
        .collect();

    let total_tokens: i64 = scored.iter().map(|s| s.tokens).sum();

    // Rank by (score desc, index asc) — stable sort with explicit tiebreak.
    let mut ranked: Vec<usize> = (0..scored.len()).collect();
    ranked.sort_by(|&a, &b| {
        scored[b].score.cmp(&scored[a].score).then(scored[a].index.cmp(&scored[b].index))
    });

    let mut kept: Vec<bool> = vec![false; scored.len()];
    let mut kept_tokens: i64 = 0;

    // Prohibitions are kept unconditionally, charged to the budget up front.
    for s in &scored {
        let lower = ascii_lower(&s.text);
        if PROHIBITION_MARKERS.iter().any(|m| lower.contains(m)) {
            kept[s.index] = true;
            kept_tokens += s.tokens;
        }
    }

    for &ri in &ranked {
        if kept_tokens * 1000 >= ratio_millis * total_tokens {
            break;
        }
        let cand = &scored[ri];
        if kept[cand.index] {
            continue;
        }
        if is_redundant(cand, &scored, &kept) {
            continue;
        }
        kept[cand.index] = true;
        kept_tokens += cand.tokens;

        // Anaphora rule: pull the predecessor in with its dependent.
        if cand.anaphoric && cand.index > 0 && !kept[cand.index - 1] {
            kept[cand.index - 1] = true;
            kept_tokens += scored[cand.index - 1].tokens;
        }
    }

    if !kept.iter().any(|&k| k) {
        if let Some(&first) = ranked.first() {
            kept[scored[first].index] = true;
        }
    }

    let parts: Vec<&str> = scored
        .iter()
        .filter(|s| kept[s.index])
        .map(|s| s.text.as_str())
        .collect();
    parts.join(" ")
}

fn score_sentence(
    text: &str,
    words: &[String],
    index: usize,
    sentence_count: usize,
    term_counts: &std::collections::HashMap<String, i64>,
    total_terms: i64,
) -> i64 {
    if words.is_empty() {
        return 0;
    }

    let mut info: i64 = 0;
    for w in words {
        if is_stopword(w) {
            continue;
        }
        let count = term_counts.get(w).copied().unwrap_or(1);
        info += bit_length(total_terms.max(1) / count);
    }
    let mut score = info * SCALE / words.len() as i64;

    let lower = ascii_lower(text);

    if text.chars().any(|c| c.is_ascii_digit()) {
        score += BOOST_DIGITS;
    }
    if has_non_initial_capitalized_word(text) {
        score += BOOST_ENTITY;
    }
    if has_quoted_span(text) {
        score += BOOST_QUOTED;
    }
    if has_identifier_token(text) {
        score += BOOST_IDENTIFIER;
    }
    if index == 0 || index == sentence_count - 1 {
        score += BOOST_POSITION;
    }
    if CONSTRAINT_MARKERS.iter().any(|m| lower.contains(m)) {
        score += BOOST_IMPERATIVE;
    }
    if FILLER_OPENERS.iter().any(|f| lower.starts_with(f)) {
        score -= PENALTY_FILLER;
    }

    score
}

fn has_non_initial_capitalized_word(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    let mut word_start = true;
    let mut first_word = true;
    let mut in_word = false;
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        let is_alpha = c.is_ascii_alphabetic();
        if is_alpha && !in_word {
            if !first_word && word_start && c.is_ascii_uppercase() {
                if let Some(&n1) = chars.get(i + 1) {
                    if n1.is_ascii_lowercase() {
                        return true;
                    }
                }
            }
            in_word = true;
        } else if !is_alpha && in_word {
            in_word = false;
            first_word = false;
            word_start = c == ' ' || c == '\t';
            i += 1;
            continue;
        }
        if !is_alpha {
            word_start = c == ' ' || c == '\t';
        }
        i += 1;
    }
    false
}

fn has_quoted_span(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    for q in ['"', '\'', '`'] {
        let Some(first) = chars.iter().position(|&c| c == q) else { continue };
        if let Some(offset) = chars[first + 1..].iter().position(|&c| c == q) {
            // second = first + 1 + offset; gap = second - first
            if offset + 1 > 3 {
                return true;
            }
        }
    }
    false
}

fn has_identifier_token(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    for i in 1..chars.len().saturating_sub(1) {
        let c = chars[i];
        if matches!(c, '_' | '/' | '-' | '.')
            && chars[i - 1].is_ascii_alphanumeric()
            && chars[i + 1].is_ascii_alphanumeric()
        {
            return true;
        }
    }
    false
}

fn shingles(words: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    if words.len() < 3 {
        if !words.is_empty() {
            out.push(words.join(" "));
        }
        return out;
    }
    for i in 0..=(words.len() - 3) {
        let s = format!("{} {} {}", words[i], words[i + 1], words[i + 2]);
        if !out.contains(&s) {
            out.push(s);
        }
    }
    out
}

fn is_redundant(cand: &Scored, scored: &[Scored], kept: &[bool]) -> bool {
    // List items read as near-duplicates of siblings but carry distinct
    // content — never drop as redundant.
    if cand.list_item || !kept.iter().any(|&k| k) {
        return false;
    }
    let cand_shingles = shingles(&word_tokens(&cand.text));
    if cand_shingles.is_empty() {
        return false;
    }
    for k in scored.iter().filter(|s| kept[s.index]) {
        let ks = shingles(&word_tokens(&k.text));
        let intersection = cand_shingles.iter().filter(|s| ks.contains(s)).count() as i64;
        let union = cand_shingles.len() as i64 + ks.len() as i64 - intersection;
        if union > 0 && intersection * 100 > REDUNDANCY_PCT * union {
            // Digit-diff guard: numeric twins are all signal.
            if !same_digit_tokens(&cand.digit_tokens, &k.digit_tokens) {
                continue;
            }
            return true;
        }
    }
    false
}

fn same_digit_tokens(a: &[String], b: &[String]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut sa: Vec<&String> = a.iter().collect();
    let mut sb: Vec<&String> = b.iter().collect();
    sa.sort();
    sb.sort();
    sa == sb
}
