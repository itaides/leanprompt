package leanprompt

// Content-type classifier + RepeatTracker (parity-spec §6).

import (
	"strings"
)

// ContentType labels emitted by the classifier; string values are
// config-visible and frozen.
type ContentType string

const (
	Unknown       ContentType = "unknown"
	Prose         ContentType = "prose"
	Code          ContentType = "code"
	ErrorType     ContentType = "error"
	Structured    ContentType = "structured"
	Repeat        ContentType = "repeat"
	LongImportant ContentType = "long_important"
)

func contentTypeFrom(s string) (ContentType, bool) {
	switch ContentType(s) {
	case Unknown, Prose, Code, ErrorType, Structured, Repeat, LongImportant:
		return ContentType(s), true
	}
	return "", false
}

var errorMarkers = []string{
	"Traceback (most recent call last):",
	"Uncaught exception",
	"UnhandledPromiseRejection",
	"thread 'main' panicked at",
	"panic: ",
	"Exception in thread",
	"FATAL: ",
	"ERROR: ",
	"Error: ",
	"Exception: ",
	"java.lang.",
}

var codeLinePrefixes = []string{
	"def ", "class ", "function ", "async function ", "import ", "from ",
	"export ", "package ", "#include", "fn ", "pub fn ", "func ", "var ",
	"const ", "let ",
}

const (
	minCodeLines       = 2
	structuredMinChars = 200
)

// Classify a message: ERROR > CODE > STRUCTURED > PROSE; UNKNOWN when the
// extracted text is empty.
func Classify(message Message) ContentType {
	text := GetTextContent(message)
	if strings.TrimSpace(text) == "" {
		return Unknown
	}
	if looksLikeError(text) {
		return ErrorType
	}
	if looksLikeCode(text) {
		return Code
	}
	if looksLikeStructured(text) {
		return Structured
	}
	return Prose
}

func looksLikeError(text string) bool {
	for _, m := range errorMarkers {
		if strings.Contains(text, m) {
			return true
		}
	}
	return false
}

func looksLikeCode(text string) bool {
	if strings.Contains(text, "```") {
		return true
	}
	codeLines := 0
	for _, line := range strings.Split(text, "\n") {
		stripped := strings.TrimLeft(line, " \t\n\r\f\v")
		for _, p := range codeLinePrefixes {
			if strings.HasPrefix(stripped, p) {
				codeLines++
				break
			}
		}
	}
	return codeLines >= minCodeLines
}

// looksLikeStructured: JSON-key density over code points — procedural scan
// for `"key":` shapes (1-64 code points between quotes, optional spaces or
// tabs before the colon).
func looksLikeStructured(text string) bool {
	chars := []rune(text)
	n := len(chars)
	if n < structuredMinChars {
		return false
	}
	keys := countJSONKeys(chars)
	// keys / (n/1000) >= 1.0  ⇔  keys * 1000 >= n
	return keys*1000 >= n
}

func countJSONKeys(chars []rune) int {
	count := 0
	i := 0
	for i < len(chars) {
		if chars[i] != '"' {
			i++
			continue
		}
		start := i + 1
		j := start
		ok := false
		for j < len(chars) && j-start <= 64 {
			if chars[j] == '"' {
				ok = j > start
				break
			}
			if chars[j] == '\n' {
				break
			}
			j++
		}
		if !ok {
			i++
			continue
		}
		k := j + 1
		for k < len(chars) && (chars[k] == ' ' || chars[k] == '\t') {
			k++
		}
		if k < len(chars) && chars[k] == ':' {
			count++
			i = k + 1
		} else {
			i = j + 1
		}
	}
	return count
}

// RepeatTracker flags duplicate message content across a session. Not safe
// for concurrent use — one per session.
type RepeatTracker struct {
	seen map[string]struct{}
}

func NewRepeatTracker() *RepeatTracker {
	return &RepeatTracker{seen: make(map[string]struct{})}
}

// IsRepeat reports whether this message's content was seen before, and
// records it as seen.
func (t *RepeatTracker) IsRepeat(message Message) bool {
	h, ok := repeatKey(message)
	if !ok {
		return false
	}
	if _, dup := t.seen[h]; dup {
		return true
	}
	t.seen[h] = struct{}{}
	return false
}

func (t *RepeatTracker) Reset() {
	t.seen = make(map[string]struct{})
}

func repeatKey(message Message) (string, bool) {
	// tool_use/tool_result blocks pair by id; dropping a "duplicate"
	// tool_result would orphan its tool_use. Never record those messages.
	if hasToolLinkage(message) {
		return "", false
	}
	if strField(message, "role") == "system" {
		return "", false
	}
	text := GetTextContent(message)
	if text == "" {
		return "", false
	}
	role := strField(message, "role")
	return role + "|" + text, true
}

// hasToolLinkage reports whether a message participates in a tool-call
// chain: tool_use/tool_result blocks (list or single object), tool/function
// roles, or provider tool-call fields. Such messages pair by id; dropping
// or reordering them can orphan their counterpart.
func hasToolLinkage(message Message) bool {
	isToolBlock := func(item any) bool {
		b, ok := item.(map[string]any)
		if !ok {
			return false
		}
		t := strField(b, "type")
		return t == "tool_use" || t == "tool_result"
	}
	switch content := message["content"].(type) {
	case []any:
		for _, item := range content {
			if isToolBlock(item) {
				return true
			}
		}
	case map[string]any:
		if isToolBlock(content) {
			return true
		}
	}
	if role := strField(message, "role"); role == "tool" || role == "function" {
		return true
	}
	if calls, ok := message["tool_calls"].([]any); ok && len(calls) > 0 {
		return true
	}
	if _, ok := message["function_call"].(map[string]any); ok {
		return true
	}
	return false
}
