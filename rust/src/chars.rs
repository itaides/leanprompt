//! Pinned character classes (parity-spec §2).
//!
//! Host Unicode tables (`char::is_alphabetic` etc.) vary by Unicode version
//! and must not be used anywhere in the pipeline.

/// Pinned whitespace rule (code point).
pub fn is_space_char(cp: u32) -> bool {
    matches!(cp,
        0x20 | 0x09..=0x0d | 0x85 | 0xa0
        | 0x2000..=0x200b | 0x2028 | 0x2029 | 0x202f | 0x205f
        | 0x3000 | 0xfeff)
}

fn is_punct_char(cp: u32) -> bool {
    matches!(cp,
        0x2010..=0x2027 | 0x2030..=0x205e | 0x3001..=0x303f
        | 0xfe50..=0xfe6f | 0xff01..=0xff0f | 0xff1a..=0xff20
        | 0xff3b..=0xff40 | 0xff5b..=0xff65)
}

/// Pinned word-character rule (code point): ASCII alphanumerics; any
/// non-ASCII code point that is neither pinned whitespace nor pinned
/// punctuation.
pub fn is_word_char(cp: u32) -> bool {
    if cp < 0x80 {
        return (0x30..=0x39).contains(&cp)
            || (0x41..=0x5a).contains(&cp)
            || (0x61..=0x7a).contains(&cp);
    }
    !is_space_char(cp) && !is_punct_char(cp)
}

/// ASCII-only lowercasing: `A-Z` → `a-z`, everything else unchanged.
pub fn ascii_lower(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_ascii_uppercase() { c.to_ascii_lowercase() } else { c })
        .collect()
}
