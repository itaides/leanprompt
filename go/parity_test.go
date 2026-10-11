package leanprompt

// Golden-vector parity tests: the Go implementation must reproduce the
// parity/*.json vectors emitted by the TypeScript reference (text and
// integer fields; floats are never compared).

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func load(t *testing.T, name string, into any) {
	t.Helper()
	path := filepath.Join("..", "parity", name)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read %s: %v", path, err)
	}
	if err := json.Unmarshal(data, into); err != nil {
		t.Fatalf("cannot parse %s: %v", path, err)
	}
}

func TestContentVectors(t *testing.T) {
	var cases []struct {
		Name    string  `json:"name"`
		Message Message `json:"message"`
		Text    string  `json:"text"`
	}
	load(t, "content.json", &cases)
	for _, c := range cases {
		if got := GetTextContent(c.Message); got != c.Text {
			t.Errorf("content %s:\n got %q\nwant %q", c.Name, got, c.Text)
		}
	}
}

func TestClassifierVectors(t *testing.T) {
	var cases []struct {
		Name    string  `json:"name"`
		Message Message `json:"message"`
		Label   string  `json:"label"`
	}
	load(t, "classifier.json", &cases)
	for _, c := range cases {
		if got := Classify(c.Message); string(got) != c.Label {
			t.Errorf("classifier %s: got %s want %s", c.Name, got, c.Label)
		}
	}
}

func TestRepeatTrackerVectors(t *testing.T) {
	var cases []struct {
		Index    int     `json:"index"`
		Message  Message `json:"message"`
		IsRepeat bool    `json:"isRepeat"`
	}
	load(t, "repeat-tracker.json", &cases)
	tracker := NewRepeatTracker()
	for _, c := range cases {
		if got := tracker.IsRepeat(c.Message); got != c.IsRepeat {
			t.Errorf("repeat-tracker index %d: got %v want %v", c.Index, got, c.IsRepeat)
		}
	}
}

func TestTokenVectors(t *testing.T) {
	var cases []struct {
		Text   string `json:"text"`
		Tokens int64  `json:"tokens"`
	}
	load(t, "tokens.json", &cases)
	for _, c := range cases {
		if got := CountTokens(c.Text); got != c.Tokens {
			t.Errorf("tokens for %.40q: got %d want %d", c.Text, got, c.Tokens)
		}
	}
}

func TestWordTokenVectors(t *testing.T) {
	var cases []struct {
		Text   string   `json:"text"`
		Tokens []string `json:"tokens"`
	}
	load(t, "word-tokens.json", &cases)
	for _, c := range cases {
		if got := wordTokens(c.Text); !reflect.DeepEqual(got, c.Tokens) {
			t.Errorf("word tokens for %q: got %v want %v", c.Text, got, c.Tokens)
		}
	}
}

func TestStrategyVectors(t *testing.T) {
	var data struct {
		Input       []Message `json:"input"`
		Dedup       []Message `json:"dedup"`
		PurgeAfter2 []Message `json:"purgeAfter2"`
	}
	load(t, "strategies.json", &data)

	dedup := DedupStrategy{}.Apply(data.Input)
	if !reflect.DeepEqual(dedup, data.Dedup) {
		t.Errorf("dedup output:\n got %v\nwant %v", dedup, data.Dedup)
	}
	purge := PurgeErrorsStrategy{AfterTurns: 2}.Apply(data.Input)
	if !reflect.DeepEqual(purge, data.PurgeAfter2) {
		t.Errorf("purge output:\n got %v\nwant %v", purge, data.PurgeAfter2)
	}
}

func TestExtractVectors(t *testing.T) {
	var cases []struct {
		Name        string `json:"name"`
		Text        string `json:"text"`
		RatioMillis int64  `json:"ratioMillis"`
		Sentences   []struct {
			Text     string `json:"text"`
			ListItem bool   `json:"listItem"`
		} `json:"sentences"`
		Selected string `json:"selected"`
	}
	load(t, "extract.json", &cases)
	for _, c := range cases {
		sentences := segmentSentences(c.Text)
		if len(sentences) != len(c.Sentences) {
			t.Fatalf("segmentation %s: got %d sentences want %d", c.Name, len(sentences), len(c.Sentences))
		}
		for i, s := range sentences {
			if s.text != c.Sentences[i].Text || s.listItem != c.Sentences[i].ListItem {
				t.Errorf("segmentation %s[%d]: got (%q, %v) want (%q, %v)",
					c.Name, i, s.text, s.listItem, c.Sentences[i].Text, c.Sentences[i].ListItem)
			}
		}
		if got := selectSentences(sentences, c.RatioMillis); got != c.Selected {
			t.Errorf("selection %s:\n got %q\nwant %q", c.Name, got, c.Selected)
		}
	}
}

func TestMiddlewareVectors(t *testing.T) {
	var cases []struct {
		Name   string `json:"name"`
		Config struct {
			Mode    string `json:"mode"`
			Trigger struct {
				ThresholdTokens int64 `json:"thresholdTokens"`
			} `json:"trigger"`
			Routing map[string]string `json:"routing"`
			Extract struct {
				Ratio float64 `json:"ratio"`
			} `json:"extract"`
			Protect struct {
				LastTurns int `json:"lastTurns"`
			} `json:"protect"`
		} `json:"config"`
		Input        []Message `json:"input"`
		Output       []Message `json:"output"`
		InputTokens  int64     `json:"inputTokens"`
		OutputTokens int64     `json:"outputTokens"`
		Method       string    `json:"method"`
	}
	load(t, "middleware.json", &cases)

	for _, c := range cases {
		mw := NewMiddleware(Config{
			Mode:               c.Config.Mode,
			ThresholdTokens:    c.Config.Trigger.ThresholdTokens,
			Routing:            c.Config.Routing,
			ExtractRatioMillis: int64(c.Config.Extract.Ratio*1000 + 0.5),
			ProtectLastTurns:   c.Config.Protect.LastTurns,
		})
		out, stats := mw.CompressMessages(c.Input)

		if !reflect.DeepEqual(out, c.Output) {
			t.Errorf("%s output mismatch:\n got %v\nwant %v", c.Name, out, c.Output)
		}
		if stats.InputTokens != c.InputTokens {
			t.Errorf("%s input tokens: got %d want %d", c.Name, stats.InputTokens, c.InputTokens)
		}
		if stats.OutputTokens != c.OutputTokens {
			t.Errorf("%s output tokens: got %d want %d", c.Name, stats.OutputTokens, c.OutputTokens)
		}
		if stats.Method != c.Method {
			t.Errorf("%s method: got %s want %s", c.Name, stats.Method, c.Method)
		}
	}
}
