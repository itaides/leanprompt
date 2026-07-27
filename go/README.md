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

## Publishing (pkg.go.dev / Go modules)

Go modules have no publish step — the module is published by tagging a
release and pushing the tag; the [module proxy](https://proxy.golang.org)
and [pkg.go.dev](https://pkg.go.dev) pick it up automatically:

```bash
go vet ./...
go test ./...

# the module lives in the go/ subdirectory, so the tag MUST be prefixed
# accordingly (per Go's multi-module-repo versioning convention) — a
# plain "v0.1.0" tag would not be recognized as this module's release:
git tag go/v0.1.0
git push origin go/v0.1.0
```

Then either wait for someone to `go get github.com/itaides/leanprompt/go`
(which triggers indexing), or request indexing directly at
`https://pkg.go.dev/github.com/itaides/leanprompt/go` — the docs page
appears within a few minutes. Keep the tag's version in step with
`ts/package.json` and `rust/Cargo.toml` — the three SDKs claim
byte-identical behavior.

MIT. See the repo root `LICENSE`.
