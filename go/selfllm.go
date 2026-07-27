package leanprompt

// SelfLLM — compression by delegation to the user's own configured LLM,
// over stdlib net/http (zero third-party dependencies). Supported
// providers: anthropic / openai / gemini.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type Provider string

const (
	Anthropic Provider = "anthropic"
	OpenAI    Provider = "openai"
	Gemini    Provider = "gemini"
)

var openaiReasoningPrefixes = []string{"gpt-5", "o1", "o3", "o4"}
var geminiThinkingPrefixes = []string{"gemini-2.5", "gemini-3"}

const selfLLMSystemPrompt = `You are a context compression assistant.
Produce a compact, faithful summary of the provided content that
preserves everything a downstream model would need to continue the
conversation coherently.

Keep:
- specific facts, numbers, entity names, identifiers
- decisions that have already been made
- code snippets, file paths, and error messages verbatim
- the user's stated goals and constraints

Omit:
- repetitive phrasing and polite filler
- intermediate reasoning that reached the same conclusion
- commentary about what was compressed

Return only the summary. No preamble, no explanation.`

// SelfLLM delegates summarization to an LLM. HTTPClient defaults to
// http.DefaultClient; BaseURL defaults per provider (override for tests or
// proxies).
type SelfLLM struct {
	Provider Provider
	Model    string
	APIKey   string
	// RatioMillis is the suggested keep-ratio in thousandths (prompt hint).
	RatioMillis      int64
	MaxSummaryTokens int64
	BaseURL          string
	HTTPClient       *http.Client
}

func NewSelfLLM(provider Provider, apiKey string) *SelfLLM {
	s := &SelfLLM{
		Provider:         provider,
		APIKey:           apiKey,
		RatioMillis:      300,
		MaxSummaryTokens: 500,
	}
	switch provider {
	case Anthropic:
		s.Model = "claude-haiku-4-5"
		s.BaseURL = "https://api.anthropic.com"
	case OpenAI:
		s.Model = "gpt-4o-mini"
		s.BaseURL = "https://api.openai.com"
	case Gemini:
		s.Model = "gemini-2.5-flash"
		s.BaseURL = "https://generativelanguage.googleapis.com"
	default:
		panic(fmt.Sprintf("SelfLLM provider %q not supported", provider))
	}
	return s
}

func (s *SelfLLM) Name() string { return "selfllm" }

// Compress summarizes the span into a single message of the first message's
// role, with provider-reported token stats.
func (s *SelfLLM) Compress(messages []Message) ([]Message, CompressionStats, error) {
	if len(messages) == 0 {
		return messages, statsWithMethod("selfllm"), nil
	}
	var parts []string
	for _, m := range messages {
		parts = append(parts, GetTextContent(m))
	}
	text := strings.Join(parts, "\n\n")
	if strings.TrimSpace(text) == "" {
		return messages, statsWithMethod("selfllm"), nil
	}

	summary, input, output, err := s.call(s.userPrompt(text))
	if err != nil {
		return nil, CompressionStats{}, err
	}
	role := strField(messages[0], "role")
	if role == "" {
		role = "user"
	}
	out := []Message{{"role": role, "content": summary}}
	return out, statsCounted("selfllm", input, output), nil
}

func (s *SelfLLM) userPrompt(text string) string {
	pct := (s.RatioMillis + 5) / 10 // thousandths → rounded percent
	return fmt.Sprintf(
		"Compress the content below to roughly %d%% of its original length "+
			"while preserving all information a downstream model would need "+
			"to continue.\n\n<content>\n%s\n</content>", pct, text)
}

func (s *SelfLLM) call(userPrompt string) (string, int64, int64, error) {
	switch s.Provider {
	case Anthropic:
		return s.callAnthropic(userPrompt)
	case OpenAI:
		return s.callOpenAI(userPrompt)
	case Gemini:
		return s.callGemini(userPrompt)
	}
	return "", 0, 0, fmt.Errorf("SelfLLM provider %q not supported", s.Provider)
}

func (s *SelfLLM) postJSON(url string, headers map[string]string, body any) (map[string]any, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	client := s.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		detail := string(data)
		if len(detail) > 300 {
			detail = detail[:300]
		}
		return nil, fmt.Errorf("SelfLLM %s request failed: HTTP %d %s", s.Provider, resp.StatusCode, detail)
	}
	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, err
	}
	return parsed, nil
}

func intField(obj map[string]any, key string) int64 {
	if f, ok := obj[key].(float64); ok {
		return int64(f)
	}
	return 0
}

func (s *SelfLLM) callAnthropic(userPrompt string) (string, int64, int64, error) {
	body := map[string]any{
		"model":      s.Model,
		"max_tokens": s.MaxSummaryTokens,
		"system":     selfLLMSystemPrompt,
		"messages":   []any{map[string]any{"role": "user", "content": userPrompt}},
	}
	parsed, err := s.postJSON(s.BaseURL+"/v1/messages", map[string]string{
		"x-api-key":         s.APIKey,
		"anthropic-version": "2023-06-01",
	}, body)
	if err != nil {
		return "", 0, 0, err
	}
	text := ""
	if content, ok := parsed["content"].([]any); ok && len(content) > 0 {
		if block, ok := content[0].(map[string]any); ok {
			text = strField(block, "text")
		}
	}
	usage, _ := parsed["usage"].(map[string]any)
	return text, intField(usage, "input_tokens"), intField(usage, "output_tokens"), nil
}

func (s *SelfLLM) callOpenAI(userPrompt string) (string, int64, int64, error) {
	body := map[string]any{
		"model":                 s.Model,
		"max_completion_tokens": s.MaxSummaryTokens,
		"messages": []any{
			map[string]any{"role": "system", "content": selfLLMSystemPrompt},
			map[string]any{"role": "user", "content": userPrompt},
		},
	}
	// Reasoning models otherwise spend the completion budget on hidden
	// reasoning; compression needs none.
	for _, p := range openaiReasoningPrefixes {
		if strings.HasPrefix(s.Model, p) {
			body["reasoning_effort"] = "minimal"
			break
		}
	}
	parsed, err := s.postJSON(s.BaseURL+"/v1/chat/completions", map[string]string{
		"authorization": "Bearer " + s.APIKey,
	}, body)
	if err != nil {
		return "", 0, 0, err
	}
	text := ""
	if choices, ok := parsed["choices"].([]any); ok && len(choices) > 0 {
		if choice, ok := choices[0].(map[string]any); ok {
			if message, ok := choice["message"].(map[string]any); ok {
				text = strField(message, "content")
			}
		}
	}
	usage, _ := parsed["usage"].(map[string]any)
	return text, intField(usage, "prompt_tokens"), intField(usage, "completion_tokens"), nil
}

func (s *SelfLLM) callGemini(userPrompt string) (string, int64, int64, error) {
	generationConfig := map[string]any{"maxOutputTokens": s.MaxSummaryTokens}
	// Gemini 2.5+ thinking burns the output budget on hidden tokens.
	for _, p := range geminiThinkingPrefixes {
		if strings.HasPrefix(s.Model, p) {
			generationConfig["thinkingConfig"] = map[string]any{"thinkingBudget": 0}
			break
		}
	}
	body := map[string]any{
		"system_instruction": map[string]any{
			"parts": []any{map[string]any{"text": selfLLMSystemPrompt}},
		},
		"contents": []any{map[string]any{
			"role":  "user",
			"parts": []any{map[string]any{"text": userPrompt}},
		}},
		"generationConfig": generationConfig,
	}
	url := fmt.Sprintf("%s/v1beta/models/%s:generateContent", s.BaseURL, s.Model)
	parsed, err := s.postJSON(url, map[string]string{"x-goog-api-key": s.APIKey}, body)
	if err != nil {
		return "", 0, 0, err
	}
	text := ""
	if candidates, ok := parsed["candidates"].([]any); ok && len(candidates) > 0 {
		if cand, ok := candidates[0].(map[string]any); ok {
			if content, ok := cand["content"].(map[string]any); ok {
				if parts, ok := content["parts"].([]any); ok {
					var sb strings.Builder
					for _, p := range parts {
						if pm, ok := p.(map[string]any); ok {
							sb.WriteString(strField(pm, "text"))
						}
					}
					text = sb.String()
				}
			}
		}
	}
	usage, _ := parsed["usageMetadata"].(map[string]any)
	return text, intField(usage, "promptTokenCount"), intField(usage, "candidatesTokenCount"), nil
}
