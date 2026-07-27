# leanprompt bench

Three bench/eval modes, none of which need a model download, an HF dataset,
or a live LLM judge — because `Extract` is a deterministic algorithm, not a
lossy neural compressor, the accuracy-regression machinery a project like
that would need (a paired significance test against a live-LLM-graded QA
benchmark) isn't the proportionate tool here. What's proportionate: measure
token savings honestly, measure it against a naive baseline so "beats
verbatim" isn't the bar, and prove the three SDKs actually agree.

## 1. Quality vs baselines — `bun bench/run-quality.ts [--ratio 0.5]`

Runs the real `Extract` compressor against a naive "keep first+last N%"
baseline on every prose-classified message in each corpus under
`bench/corpora/`. Reports achieved keep-ratio and two **unweighted presence
proxies** — fraction of distinct non-stopword terms and distinct numeric
tokens from the original that survive compression.

Read the caveat the script itself prints: these are raw coverage numbers,
not importance-weighted, so a positional baseline can score competitively
without understanding content. They're a sanity check, not proof of
quality — the actual behavior guarantees (prohibitions survive
unconditionally, anaphora pulls in its antecedent, structural content is
never touched) are asserted by name in `ts/test/extract.test.ts`, not here.

Writes `bench/results/quality.json`.

## 2. Cross-language consistency dashboard — `bun bench/run-cross-language.ts`

Runs the same fixed parameter set through TypeScript (in-process), Rust, and
Go (via the `bench` binaries at `rust/src/bin/bench.rs` /
`go/cmd/bench/main.go`) on every corpus, and reports whether all three agree.

**This is a reporting layer, not the actual gate.** `cargo test` and `go
test ./...` already assert byte-equality against the committed
`parity/*.json` golden vectors on every change — that's the real guarantee.
This script exists to make that guarantee visible and to catch drift on
inputs the fixed parity vectors don't happen to cover. Requires `cargo` and
`go` on `PATH`; exits non-zero on any mismatch.

Writes `bench/results/cross-language.md`.

## 3. Real-workload measurement — `bun bench/run-workload.ts --file <messages.json> [--config <config.json>] [--price-per-1k <usd>]`

Runs an actual conversation export (any JSON array of `{role, content}`
messages — OpenAI- or Anthropic-shaped) through the real `Middleware`
end-to-end and reports what leanprompt would have saved on *that specific
workload*. `--price-per-1k` is optional and always user-supplied — no
hardcoded provider pricing table to go stale.

```bash
bun bench/run-workload.ts --file bench/corpora/prose-heavy.json \
  --config <(echo '{"mode":"on","trigger":{"thresholdTokens":10},"routing":{"prose":"extract"}}') \
  --price-per-1k 0.003
```

If you get 0% savings on a short conversation, read the note the script
prints — it's very likely `protect.lastTurns` (default: the last 2 messages
are always verbatim) rather than a bug.

## Corpora

- `corpora/prose-heavy.json` — a multi-turn incident-postmortem discussion,
  almost entirely free text. Representative of the ~40–50%-savings end of
  the README's honesty note.
- `corpora/agent-heavy.json` — a tool-calling coding-agent transcript: fenced
  code, a traceback, `tool_use`/`tool_result` blocks, and short prose
  instructions. Representative of the "substantially less" end — most of its
  tokens are classifier-gated to verbatim by design, and its remaining prose
  spans are mostly too short for `Extract`'s guards to engage at all.

Both are synthetic and originally written for this repo — not derived from
any external dataset or corpus.
