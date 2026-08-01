package leanprompt

// Token estimator (parity-spec §3): a state machine over code points.
//
// Dense scripts (CJK ideographs, Hangul, Hiragana/Katakana, Thai, Lao,
// Khmer, Myanmar) have no space-delimited word boundaries and real BPE
// tokenizers run far denser than 4 chars/token on them (commonly
// ~1.5-2.5 chars/token) — charged with a separate divisor below.
// isWordChar/isSpaceChar themselves are unchanged and still used unmodified
// by the Extract compressor's word-tokenization.

const charsPerToken = 4

// ceil(N * denseNum / denseDen) approximates ~1.5 chars/token.
const denseNum = 2
const denseDen = 3

func isDenseScriptChar(cp rune) bool {
	switch {
	case cp >= 0x0e00 && cp <= 0x0e7f: // Thai
		return true
	case cp >= 0x0e80 && cp <= 0x0eff: // Lao
		return true
	case cp >= 0x1000 && cp <= 0x109f: // Myanmar
		return true
	case cp >= 0x1100 && cp <= 0x11ff: // Hangul Jamo
		return true
	case cp >= 0x1780 && cp <= 0x17ff: // Khmer
		return true
	case cp >= 0x3040 && cp <= 0x309f: // Hiragana
		return true
	case cp >= 0x30a0 && cp <= 0x30ff: // Katakana
		return true
	case cp >= 0x3400 && cp <= 0x4dbf: // CJK Unified Ideographs Extension A
		return true
	case cp >= 0x4e00 && cp <= 0x9fff: // CJK Unified Ideographs
		return true
	case cp >= 0xac00 && cp <= 0xd7a3: // Hangul Syllables
		return true
	case cp >= 0xf900 && cp <= 0xfaff: // CJK Compatibility Ideographs
		return true
	}
	return false
}

// CountTokens estimates the number of tokens in text.
func CountTokens(text string) int64 {
	if text == "" {
		return 0
	}
	var tokens int64
	wordRunLen := 0
	denseRunLen := 0
	for _, c := range text {
		if isWordChar(c) {
			if isDenseScriptChar(c) {
				if wordRunLen > 0 {
					tokens += runTokens(wordRunLen)
					wordRunLen = 0
				}
				denseRunLen++
			} else {
				if denseRunLen > 0 {
					tokens += denseTokens(denseRunLen)
					denseRunLen = 0
				}
				wordRunLen++
			}
			continue
		}
		if wordRunLen > 0 {
			tokens += runTokens(wordRunLen)
			wordRunLen = 0
		}
		if denseRunLen > 0 {
			tokens += denseTokens(denseRunLen)
			denseRunLen = 0
		}
		if !isSpaceChar(c) {
			tokens++
		}
	}
	if wordRunLen > 0 {
		tokens += runTokens(wordRunLen)
	}
	if denseRunLen > 0 {
		tokens += denseTokens(denseRunLen)
	}
	if tokens < 1 {
		return 1
	}
	return tokens
}

func runTokens(length int) int64 {
	t := int64((length + charsPerToken - 1) / charsPerToken)
	if t < 1 {
		return 1
	}
	return t
}

func denseTokens(length int) int64 {
	t := int64((length*denseNum + denseDen - 1) / denseDen)
	if t < 1 {
		return 1
	}
	return t
}

// CountMessageTokens sums token counts over the compressible text of each
// message.
func CountMessageTokens(messages []Message) int64 {
	var total int64
	for _, m := range messages {
		total += CountTokens(GetTextContent(m))
	}
	return total
}
