// Package leanprompt is a zero-dependency prompt-compression pipeline for LLM
// applications: a deterministic extractive compressor (Extract) behind a
// classifier-gated middleware, implementing docs/parity-spec.md and
// byte-compatible with the TypeScript reference (parity/*.json).
package leanprompt

// Pinned character classes (parity-spec §2). Host Unicode tables
// (unicode.IsLetter etc.) vary by Unicode version and are never used.

func isSpaceChar(cp rune) bool {
	switch {
	case cp == 0x20, cp >= 0x09 && cp <= 0x0d, cp == 0x85, cp == 0xa0:
		return true
	case cp >= 0x2000 && cp <= 0x200b, cp == 0x2028, cp == 0x2029,
		cp == 0x202f, cp == 0x205f, cp == 0x3000, cp == 0xfeff:
		return true
	}
	return false
}

func isPunctChar(cp rune) bool {
	switch {
	case cp >= 0x2010 && cp <= 0x2027, cp >= 0x2030 && cp <= 0x205e,
		cp >= 0x3001 && cp <= 0x303f, cp >= 0xfe50 && cp <= 0xfe6f,
		cp >= 0xff01 && cp <= 0xff0f, cp >= 0xff1a && cp <= 0xff20,
		cp >= 0xff3b && cp <= 0xff40, cp >= 0xff5b && cp <= 0xff65:
		return true
	}
	return false
}

// isWordChar: ASCII alphanumerics; any non-ASCII code point that is neither
// pinned whitespace nor pinned punctuation.
func isWordChar(cp rune) bool {
	if cp < 0x80 {
		return (cp >= '0' && cp <= '9') || (cp >= 'A' && cp <= 'Z') || (cp >= 'a' && cp <= 'z')
	}
	return !isSpaceChar(cp) && !isPunctChar(cp)
}

// asciiLower maps A-Z to a-z only; every other code point is unchanged.
func asciiLower(text string) string {
	out := make([]rune, 0, len(text))
	for _, c := range text {
		if c >= 'A' && c <= 'Z' {
			c += 32
		}
		out = append(out, c)
	}
	return string(out)
}
