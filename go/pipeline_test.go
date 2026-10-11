package leanprompt

import (
	"reflect"
	"strings"
	"testing"
)

func proseMsg(seed string) Message {
	return Message{
		"role": "user",
		"content": "The " + seed + " incident report describes a lengthy sequence of unfortunate " +
			"events in production. The scheduler fired the rotation job during an active " +
			"release window on the gamma cluster. Basically this was all just terrible " +
			"timing between two independent systems. The release step retried three times " +
			"with exponential backoff and gave up.",
	}
}

func TestProtectLastTurnsDefault(t *testing.T) {
	input := []Message{proseMsg("one"), proseMsg("two"), proseMsg("three")}

	mw := NewMiddleware(Config{
		Mode:               "on",
		Routing:            map[string]string{"prose": "extract"},
		ThresholdTokens:    1,
		ExtractRatioMillis: 500,
	})
	out, stats := mw.CompressMessages(input)
	if stats.Method != "hybrid" && stats.Method != "extract" {
		t.Fatalf("unexpected method %s", stats.Method)
	}
	// Default protect is last 2: messages 1 and 2 pass through verbatim.
	if out[1]["content"] != input[1]["content"] || out[2]["content"] != input[2]["content"] {
		t.Fatalf("last 2 messages should be protected by default: %v", out)
	}
	if len(out[0]["content"].(string)) >= len(input[0]["content"].(string)) {
		t.Fatal("first message should have been compressed")
	}

	mwOff := NewMiddleware(Config{
		Mode:                     "on",
		Routing:                  map[string]string{"prose": "extract"},
		ThresholdTokens:          1,
		ExtractRatioMillis:       500,
		ProtectLastTurnsDisabled: true,
	})
	outOff, _ := mwOff.CompressMessages(input)
	for i := range input {
		if outOff[i]["content"].(string) == input[i]["content"].(string) {
			t.Fatalf("message %d should have been compressed with protection disabled", i)
		}
	}
}

func TestNormalizeSpanRules(t *testing.T) {
	norm := func(s string) string {
		out := NormalizeStrategy{}.Apply([]Message{{"role": "user", "content": s}})
		return out[0]["content"].(string)
	}
	cases := []struct{ in, want string }{
		{"a\r\nb\rc", "a\nb\nc"},
		{"a\x1b[31mred\x1b[0m", "ared"},
		{"a\x1b[1;2Hb", "ab"},
		{"a\x1b[?25lb", "ab"},
		{"a\x1b[!pb", "ab"},
		{"a\x1b]0;title\x07b", "ab"},
		{"a\x1b]0;title\x1b\\b", "ab"},
		{"a\x1b]0;payload", "a"},
		{"a\x1b]8;;x\x1by\x07b", "ab"},
		{"a\x1bPb", "ab"},
		{"a\x1b[31", "a\x1b[31"},
		{"a\x1b(B", "a\x1b(B"},
		{"a\x1b", "a\x1b"},
		{"a\u200bb\u2060c\ufeffd", "abcd"},
		{"a\u200cb\u200dc", "a\u200cb\u200dc"},
		{"a\n\n\n\nb", "a\n\nb"},
		{"a\n  \n \t\nb", "a\n\nb"},
		{"a  \n\n\nb", "a  \n\nb"},
		{"a\n\nb", "a\n\nb"},
		{"  \n\nb\n   ", "  \n\nb\n   "},
	}
	for _, c := range cases {
		if got := norm(c.in); got != c.want {
			t.Errorf("normalize %q: got %q want %q", c.in, got, c.want)
		}
	}
}

func TestNormalizeJSONRules(t *testing.T) {
	keys := make([]string, 20)
	for i := range keys {
		keys[i] = `"k` + string(rune('a'+i)) + `": 1`
	}
	pretty := "{ " + strings.Join(keys, ", ") + `, "n": 12345678901234567890 }`
	want := "{" + strings.Join(keys, ", ") + `,"n":12345678901234567890}`
	want = strings.ReplaceAll(want, ": ", ":")
	want = strings.ReplaceAll(want, ", ", ",")

	norm := func(s string, s2 NormalizeStrategy) string {
		out := s2.Apply([]Message{{"role": "user", "content": s}})
		return out[0]["content"].(string)
	}
	if got := norm(pretty, NormalizeStrategy{}); got != want {
		t.Fatalf("minify: got %q want %q", got, want)
	}
	if got := norm(pretty, NormalizeStrategy{JSONDisabled: true}); got != pretty {
		t.Fatalf("json disabled should leave span unchanged: %q", got)
	}
	for _, bad := range []string{
		"{ " + strings.Join(keys, ", ") + ",",            // unbalanced
		"{ " + strings.Join(keys, ", ") + `, "t": "open`, // unterminated string
		"{ " + strings.Join(keys, ", ") + " } oops",      // trailing garbage
		"note: { " + strings.Join(keys, ", ") + " }",     // non-{ start
	} {
		if got := norm(bad, NormalizeStrategy{}); got != bad {
			t.Errorf("malformed input should pass through: got %q want %q", got, bad)
		}
	}
}

func TestNormalizeMiddlewareOrder(t *testing.T) {
	mw := NewMiddleware(Config{Mode: "on", ThresholdTokens: 10, ProtectLastTurns: 1})
	out, _ := mw.CompressMessages([]Message{
		{"role": "user", "content": "same output here\r\nsecond line of it"},
		{"role": "user", "content": "same output here\nsecond line of it"},
		{"role": "user", "content": "what changed?"},
	})
	if len(out) != 2 || out[0]["content"] != "same output here\nsecond line of it" {
		t.Fatalf("normalize should run before dedup: %v", out)
	}

	mwOff := NewMiddleware(Config{
		Mode: "on", ThresholdTokens: 10,
		NormalizeDisabled: true, ProtectLastTurnsDisabled: true,
	})
	outOff, _ := mwOff.CompressMessages([]Message{{"role": "user", "content": "a\r\nb"}})
	if outOff[0]["content"] != "a\r\nb" {
		t.Fatalf("NormalizeDisabled should leave content untouched: %v", outOff)
	}
}

func TestNormalizeWalk(t *testing.T) {
	sys := Message{"role": "system", "content": "a\r\nb\x1b[31m"}
	out := NormalizeStrategy{}.Apply([]Message{sys})
	if !reflect.DeepEqual(out[0], sys) {
		t.Fatalf("system message must be untouched: %v", out)
	}

	m := Message{"role": "user", "content": []any{
		map[string]any{"type": "tool_result", "tool_use_id": "t1", "content": []any{
			map[string]any{"type": "text", "text": "one\u200b\n\n\n\n\ntwo"},
			map[string]any{"type": "image", "source": map[string]any{"data": "x"}},
		}},
		map[string]any{"type": "tool_use", "id": "u", "name": "run",
			"input": map[string]any{"cmd": "x\r\ny"}},
	}}
	got := NormalizeStrategy{}.Apply([]Message{m})[0]
	inner := got["content"].([]any)[0].(map[string]any)
	if inner["tool_use_id"] != "t1" {
		t.Fatalf("tool_use_id lost: %v", inner)
	}
	blocks := inner["content"].([]any)
	if blocks[0].(map[string]any)["text"] != "one\n\ntwo" {
		t.Fatalf("nested text not normalized: %v", blocks[0])
	}
	if !reflect.DeepEqual(blocks[1], map[string]any{
		"type": "image", "source": map[string]any{"data": "x"},
	}) {
		t.Fatalf("image block modified: %v", blocks[1])
	}
	toolUse := got["content"].([]any)[1].(map[string]any)
	if !reflect.DeepEqual(toolUse["input"], map[string]any{"cmd": "x\r\ny"}) {
		t.Fatalf("tool_use.input modified: %v", toolUse["input"])
	}
}
func TestTokenCounter(t *testing.T) {
	text := "some prose message long enough to matter for the gate"
	input := []Message{{"role": "user", "content": text}}

	// Stub counter: char length. One call per text span — once for the
	// threshold gate, once inside the verbatim compressor for stats.
	calls := 0
	counter := func(s string) int64 {
		calls++
		return int64(len(s))
	}
	mw := NewMiddleware(Config{
		Mode:                     "on",
		ThresholdTokens:          10,
		Routing:                  map[string]string{"prose": "verbatim"},
		ProtectLastTurnsDisabled: true,
		TokenCounter:             counter,
	})
	out, stats := mw.CompressMessages(input)
	if calls != 2 {
		t.Fatalf("counter invoked %d times, want 2 (gate + stats)", calls)
	}
	if stats.Method != "verbatim" {
		t.Fatalf("unexpected method %s", stats.Method)
	}
	if stats.InputTokens != int64(len(text)) || stats.OutputTokens != int64(len(text)) {
		t.Fatalf("stats should report stub counts: %+v", stats)
	}
	if out[0]["content"] != text {
		t.Fatal("verbatim output should be untouched")
	}
}

func TestTokenCounterThresholdBoundary(t *testing.T) {
	// Estimator counts ~len/4 (< len); the stub counts len exactly, so the
	// same threshold lands on opposite sides of the gate.
	text := proseMsg("boundary")["content"].(string)
	input := []Message{{"role": "user", "content": text}}
	threshold := int64(len(text))

	baseline := NewMiddleware(Config{
		Mode:                     "on",
		ThresholdTokens:          threshold,
		Routing:                  map[string]string{"prose": "verbatim"},
		ProtectLastTurnsDisabled: true,
	})
	_, stats := baseline.CompressMessages(input)
	if stats.Method != "below-threshold" {
		t.Fatalf("baseline method %s, want below-threshold", stats.Method)
	}

	hooked := NewMiddleware(Config{
		Mode:                     "on",
		ThresholdTokens:          threshold,
		Routing:                  map[string]string{"prose": "verbatim"},
		ProtectLastTurnsDisabled: true,
		TokenCounter:             func(s string) int64 { return int64(len(s)) },
	})
	_, stats = hooked.CompressMessages(input)
	if stats.Method != "verbatim" || stats.InputTokens != int64(len(text)) {
		t.Fatalf("hooked run should clear the gate with stub counts: %+v", stats)
	}
}

func TestTokenCounterUnsetKeepsEstimator(t *testing.T) {
	mw := NewMiddleware(Config{
		Mode:                     "on",
		ThresholdTokens:          10,
		Routing:                  map[string]string{"prose": "verbatim"},
		ProtectLastTurnsDisabled: true,
	})
	_, stats := mw.CompressMessages([]Message{{"role": "user", "content": "hello world"}})
	if stats.InputTokens != CountTokens("hello world") {
		t.Fatalf("default path must use the estimator: %+v", stats)
	}
}
