# leanprompt (Go)

Zero-dependency prompt compression for LLM applications — the Go port of
[`docs/parity-spec.md`](../docs/parity-spec.md), byte-compatible with the
TypeScript reference (asserted against `../parity/*.json`). Uses only the
standard library, including `net/http` for the SelfLLM provider calls.

```go
import leanprompt "github.com/itaides/leanprompt/go"

mw := leanprompt.NewMiddleware(leanprompt.Config{
    Mode:    "on",
    Routing: map[string]string{"prose": "extract"},
})
compressed, stats := mw.CompressMessages(messages) // []map[string]any
```

`SelfLLM` (LLM-delegated summarization for anthropic/openai/gemini) runs over
stdlib `net/http` with an injectable `*http.Client`:

```go
s := leanprompt.NewSelfLLM(leanprompt.Anthropic, apiKey)
out, stats, err := s.Compress(messages)
```

```bash
go test ./...    # includes the golden-vector parity suite
```

PolyForm Noncommercial License 1.0.0, with a small-team commercial exception. See the repo root `LICENSE`.
