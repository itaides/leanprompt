package leanprompt

// Content extraction (parity-spec §5) and canonical JSON (§4).

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// Message is a chat message: a JSON object with a "role" string and a
// "content" field (string or block list), as decoded by encoding/json.
type Message = map[string]any

// GetTextContent returns the concatenated compressible text of a message.
func GetTextContent(message Message) string {
	return extractText(message["content"])
}

func extractText(content any) string {
	switch v := content.(type) {
	case string:
		return v
	case []any:
		var parts []string
		for _, item := range v {
			if t := textFromBlock(item); t != "" {
				parts = append(parts, t)
			}
		}
		return strings.Join(parts, "\n")
	case map[string]any:
		// Some providers wrap a single block in an object rather than a list.
		return textFromBlock(v)
	}
	return ""
}

func strField(obj map[string]any, key string) string {
	if s, ok := obj[key].(string); ok {
		return s
	}
	return ""
}

func textFromBlock(block any) string {
	b, ok := block.(map[string]any)
	if !ok {
		return ""
	}
	switch strField(b, "type") {
	case "text":
		return strField(b, "text")
	case "tool_use":
		name := strField(b, "name")
		serialized := serializeToolInput(b["input"])
		if name != "" && serialized != "" {
			return "[tool_use " + name + "] " + serialized
		}
		return serialized
	case "tool_result":
		return extractText(b["content"])
	case "document":
		if direct := strField(b, "text"); direct != "" {
			return direct
		}
		if source, ok := b["source"].(map[string]any); ok {
			if data, ok := source["data"].(string); ok {
				return data
			}
		}
		return extractText(b["content"])
	}
	// image, thinking, unknown types contribute no compressible text.
	return ""
}

// serializeToolInput: canonical JSON for containers, pass-through for
// strings (parity-spec §4).
func serializeToolInput(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	case bool:
		if v {
			return "true"
		}
		return "false"
	default:
		return canonicalJSON(value)
	}
}

// canonicalJSON: compact, lexicographically sorted object keys, printable
// non-ASCII preserved. encoding/json already sorts map keys, compacts, and
// prints integer-valued float64s without a decimal point; an Encoder with
// SetEscapeHTML(false) stops <, >, & escaping.
func canonicalJSON(value any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		return fmt.Sprintf("%v", value)
	}
	return strings.TrimSuffix(buf.String(), "\n")
}
