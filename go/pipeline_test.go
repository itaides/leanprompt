package leanprompt

import "testing"

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
