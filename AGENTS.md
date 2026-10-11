# AGENTS.md

leanprompt is zero-dependency prompt compression for LLM applications: a
deterministic extractive compressor, a classifier-gated middleware pipeline,
fetch middleware, and minimal provider clients. It is implemented three
times -- TypeScript, Rust, Go -- with byte-identical output on identical
input. `mcp-proxy/` is an application built on the ts SDK.

## The two invariants

**Parity.** `docs/parity-spec.md` is the normative spec; `ts/` is the
reference implementation; `parity/*.json` are golden vectors generated from
ts. Any change to classifier, tokens, content extraction, strategies,
Extract, or the middleware pipeline must, in the same change: update the
spec, regenerate vectors, and port to rust and go.

```bash
cd ts && bun scripts/gen-parity.ts   # regenerates parity/*.json
```

Never edit `parity/*.json` by hand. `rust/tests/parity.rs` and
`go/parity_test.go` assert byte-equality against it.

**Zero dependencies.** `ts/package.json` `"dependencies"`,
`rust/Cargo.toml` `[dependencies]`, and `go.mod` `require` stay empty.
Dev/optional peer deps for integrations are fine; `mcp-proxy/` is exempt.

`ts/` is the reference -- port rust and go in the same change, never as a
follow-up.

## Checks

| Package | Test | Lint / typecheck | Build |
| --- | --- | --- | --- |
| `ts/` | `bun test` | `bun x tsc --noEmit` | `bun run build` |
| `rust/` | `cargo test` | `cargo clippy --all-targets -- -D warnings` && `cargo fmt --check` | `cargo build` |
| `go/` | `go test ./...` | `go vet ./...` && `gofmt -l .` | `go build ./...` |
| `mcp-proxy/` | `npm test` | `npm run typecheck` | `npm run build` |

CI runs all of these.

## Conventions

- TypeScript: 4-space indent, double quotes, ES modules.
- Rust: `cargo fmt` style; zero-dependency JSON implemented in-crate.
- Go: `gofmt`; standard library only.
- Scoring/arithmetic in the compression path is integer-only so all three
  languages produce identical results. No floats, no platform-dependent
  behavior, no randomness, no timestamps in output.
- Comments: default to none; match the terseness of surrounding code. Do
  not reformat or reorder code unrelated to your change.

## Tests

| Package | Location |
| --- | --- |
| `ts/` | `ts/test/*.test.ts` (`bun test`) |
| `rust/` | `rust/tests/parity.rs` + unit tests in `src/` |
| `go/` | `go/parity_test.go` + `*_test.go` |
| `mcp-proxy/` | `mcp-proxy/test/*.test.ts` (`bun test`) |

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contributor policy.
