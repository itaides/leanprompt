package leanprompt

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Long prose span (> 40 estimator tokens) that clears the span guard.
const testProse = "The incident report describes a lengthy sequence of " +
	"unfortunate events in production. The scheduler fired the rotation job " +
	"during an active release window on the gamma cluster. Basically this was " +
	"all just terrible timing between two independent systems. The release " +
	"step retried three times with exponential backoff and gave up."

func newTestSelfLLM(body string) (*SelfLLM, *httptest.Server) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		fmt.Fprint(w, body)
	}))
	s := NewSelfLLM(Anthropic, "k")
	s.BaseURL = srv.URL
	s.HTTPClient = srv.Client()
	return s, srv
}

func TestSelfLLMPreservesBlockArrays(t *testing.T) {
	s, srv := newTestSelfLLM(`{"content":[{"text":"sum"}],"usage":{"input_tokens":90,"output_tokens":5}}`)
	defer srv.Close()

	msg := Message{
		"role": "user",
		"name": "agent",
		"content": []any{
			map[string]any{"type": "tool_result", "tool_use_id": "t1", "content": testProse},
			map[string]any{"type": "text", "text": testProse},
			map[string]any{"type": "image", "source": "AAAA"},
		},
	}
	out, stats, err := s.Compress([]Message{msg})
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 {
		t.Fatalf("expected 1 message, got %d", len(out))
	}
	if out[0]["name"] != "agent" {
		t.Fatalf("message metadata dropped: %v", out[0])
	}
	blocks, ok := out[0]["content"].([]any)
	if !ok || len(blocks) != 3 {
		t.Fatalf("block array not preserved: %v", out[0]["content"])
	}
	b0 := blocks[0].(map[string]any)
	if b0["type"] != "tool_result" || b0["tool_use_id"] != "t1" || b0["content"] != "sum" {
		t.Fatalf("tool_result block wrong: %v", b0)
	}
	b1 := blocks[1].(map[string]any)
	if b1["type"] != "text" || b1["text"] != "sum" {
		t.Fatalf("text block wrong: %v", b1)
	}
	b2 := blocks[2].(map[string]any)
	if b2["type"] != "image" || b2["source"] != "AAAA" {
		t.Fatalf("image block wrong: %v", b2)
	}
	// Stats are estimator counts, not provider usage.
	wantIn := 2 * CountTokens(testProse)
	if stats.InputTokens != wantIn {
		t.Fatalf("inputTokens = %d, want estimator %d", stats.InputTokens, wantIn)
	}
	if stats.OutputTokens >= stats.InputTokens {
		t.Fatalf("expected compression, got in=%d out=%d", stats.InputTokens, stats.OutputTokens)
	}
}

func TestSelfLLMKeepsOriginalWhenSummaryNotShorter(t *testing.T) {
	for _, body := range []string{
		`{"content":[{"text":""}]}`,
		`{"content":[{"text":"` + testProse + " plus extra words making the summary longer" + `"}]}`,
	} {
		s, srv := newTestSelfLLM(body)
		msg := Message{"role": "user", "content": testProse}
		out, stats, err := s.Compress([]Message{msg})
		srv.Close()
		if err != nil {
			t.Fatal(err)
		}
		if out[0]["content"] != testProse {
			t.Fatalf("expected original span kept for body %s", body)
		}
		if stats.InputTokens != stats.OutputTokens {
			t.Fatalf("expected in == out, got %d vs %d", stats.InputTokens, stats.OutputTokens)
		}
	}
}

func TestSelfLLMShortSpanNotSent(t *testing.T) {
	s, srv := newTestSelfLLM(`{"content":[{"text":"sum"}]}`)
	defer srv.Close()
	out, _, err := s.Compress([]Message{{"role": "user", "content": "short ask"}})
	if err != nil {
		t.Fatal(err)
	}
	if out[0]["content"] != "short ask" {
		t.Fatal("short span should be verbatim")
	}
}

func TestSelfLLMTransportErrorReturned(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	s := NewSelfLLM(Anthropic, "k")
	s.BaseURL = srv.URL
	s.HTTPClient = srv.Client()
	_, _, err := s.Compress([]Message{{"role": "user", "content": testProse}})
	if err == nil {
		t.Fatal("expected error to propagate")
	}
}
