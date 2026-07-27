package leanprompt

// Token estimator (parity-spec §3): a state machine over code points.

const charsPerToken = 4

// CountTokens estimates the number of tokens in text.
func CountTokens(text string) int64 {
	if text == "" {
		return 0
	}
	var tokens int64
	runLen := 0
	for _, c := range text {
		if isWordChar(c) {
			runLen++
			continue
		}
		if runLen > 0 {
			tokens += runTokens(runLen)
			runLen = 0
		}
		if !isSpaceChar(c) {
			tokens++
		}
	}
	if runLen > 0 {
		tokens += runTokens(runLen)
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

// CountMessageTokens sums token counts over the compressible text of each
// message.
func CountMessageTokens(messages []Message) int64 {
	var total int64
	for _, m := range messages {
		total += CountTokens(GetTextContent(m))
	}
	return total
}
