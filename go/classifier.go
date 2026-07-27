package leanprompt

// Content-type classifier + RepeatTracker (parity-spec §6).

import (
	"crypto/sha256"
	"encoding/hex"
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
	h, ok := repeatHash(message)
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

func repeatHash(message Message) (string, bool) {
	// tool_use/tool_result blocks pair by id; dropping a "duplicate"
	// tool_result would orphan its tool_use. Never hash those messages.
	if hasToolLinkage(message) {
		return "", false
	}
	text := GetTextContent(message)
	if text == "" {
		return "", false
	}
	role := strField(message, "role")
	sum := sha256.Sum256([]byte(role + "|" + text))
	return hex.EncodeToString(sum[:]), true
}

func hasToolLinkage(message Message) bool {
	items, ok := message["content"].([]any)
	if !ok {
		return false
	}
	for _, item := range items {
		if b, ok := item.(map[string]any); ok {
			t := strField(b, "type")
			if t == "tool_use" || t == "tool_result" {
				return true
			}
		}
	}
	return false
}
