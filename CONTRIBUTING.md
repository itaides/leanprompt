# Contributing to leanprompt

leanprompt is zero-dependency prompt compression for LLM applications, implemented three times -- TypeScript, Rust, and Go -- with byte-identical output across all three. This guide covers setup, policy, and the rules around opening a PR. For code patterns see [AGENTS.md](AGENTS.md); for usage see the [README](README.md), [CONFIG.md](CONFIG.md), and [docs/parity-spec.md](docs/parity-spec.md).

## Project processes

`CONTRIBUTING.md` is the directory for project processes. The detailed policies live in focused documents:

| Subject | Canonical document |
| --- | --- |
| Security reports and supported versions | [SECURITY.md](SECURITY.md) |
| Planned work and direction | [ROADMAP.md](ROADMAP.md) |
| Notable changes per release | [CHANGELOG.md](CHANGELOG.md) |
| Cross-language behavior spec (normative) | [docs/parity-spec.md](docs/parity-spec.md) |
| Review, merge, and release requirements | [Maintainer review](#maintainer-review) |
| AI-assisted contributions and communication | [AI-assisted contributions](#ai-assisted-contributions) |

## Prerequisites

- **Bun** 1.1+ (TypeScript SDK, parity generation, bench tooling)
- **Rust** stable toolchain with `clippy` and `rustfmt`
- **Go** 1.22+
- **Node.js** 18+ (consumers of the built packages; `mcp-proxy` installs with npm)
- **Git**

## Setup

```bash
git clone https://github.com/itaides/leanprompt.git && cd leanprompt
```

Per package:

| Package | Setup |
| --- | --- |
| `ts/` | `cd ts && bun install` |
| `rust/` | nothing -- zero dependencies |
| `go/` | nothing -- zero dependencies |
| `mcp-proxy/` | `cd mcp-proxy && npm install` -- it depends on `../ts` via a `file:` link, so build ts first: `cd ts && bun run build` |

## Repository layout

| Directory | What it is |
| --- | --- |
| `ts/` | TypeScript SDK -- reference implementation (`bun test`) |
| `rust/` | Rust crate (`cargo test`) |
| `go/` | Go module (`go test ./...`) |
| `mcp-proxy/` | MCP server wrapper compressing tool/task/sampling payloads (npm) |
| `parity/` | golden vectors generated from `ts/` (`bun ts/scripts/gen-parity.ts`) |
| `bench/` | quality, cross-language, and real-workload measurement tooling |
| `docs/` | `parity-spec.md` -- the normative cross-language spec |

## Checks

| Language | Test | Lint / typecheck / format | Build | Regenerate parity vectors |
| --- | --- | --- | --- | --- |
| TypeScript (`ts/`) | `bun test` | `bun x tsc --noEmit` | `bun run build` | `bun scripts/gen-parity.ts` (from `ts/`) |
| Rust (`rust/`) | `cargo test` | `cargo clippy --all-targets -- -D warnings` && `cargo fmt --check` | `cargo build` | -- (asserts against `parity/`) |
| Go (`go/`) | `go test ./...` | `go vet ./...` && `gofmt -l .` | `go build ./...` | -- (asserts against `parity/`) |
| mcp-proxy (`mcp-proxy/`) | `npm test` | `npm run typecheck` | `npm run build` | -- |

CI runs all of these; run them before pushing.

## The parity invariant

The three SDKs produce byte-identical output on identical input. This is the project's central correctness property:

- [docs/parity-spec.md](docs/parity-spec.md) is the normative specification. When the spec and an implementation disagree, the spec wins.
- `ts/` is the reference implementation. `rust/` and `go/` are ports of it.
- `parity/*.json` are golden vectors generated from the TypeScript implementation with `bun scripts/gen-parity.ts` (run from `ts/`). Never edit them by hand.
- `rust/tests/parity.rs` and `go/parity_test.go` assert byte-equality against those vectors.

Any change to the classifier, token counting, content extraction, strategies, the Extract compressor, or the middleware pipeline MUST do all of the following in the same PR:

1. Update `docs/parity-spec.md`.
2. Regenerate the vectors: `cd ts && bun scripts/gen-parity.ts`, and commit the result.
3. Port the change to `rust/` and `go/`.
4. Note it in `CHANGELOG.md` under `## [Unreleased]` as a behavior change (a minor version bump while pre-1.0).

CI fails if the regenerated vectors differ from the committed ones or if any port disagrees with them, so a partial port cannot merge quietly.

## The zero-dependency invariant

`ts/package.json` `"dependencies"`, `rust/Cargo.toml` `[dependencies]`, and `go.mod`'s `require` directives must stay empty. Zero runtime dependencies is a feature of the library, not an accident of history.

PRs adding a runtime dependency are not accepted. Dev dependencies and optional peer dependencies for integrations (e.g. `@langchain/*` in `ts/`) are fine. `mcp-proxy/` is exempt -- it is an application built on the SDK, not the SDK itself.

## Choose a contribution path

| Type | Process |
| --- | --- |
| **Bug fix** | Open an implementation PR directly. Include a regression test that would have caught the bug. |
| **Documentation or tests** | Open an implementation PR directly. |
| **Behavior-preserving refactor** | Open an implementation PR directly and show that behavior is unchanged. Unchanged parity vectors are the proof. |
| **Performance** | Open an implementation PR directly with measurements from `bench/`. |
| **Algorithm or behavior change** (anything touching the parity invariant) | Open an issue first describing the spec change and why it is needed. Wait for maintainer acknowledgment, then PR. |
| **New integration or wiring path** (e.g. another SDK's fetch hook) | Open an issue first describing the surface you want to wrap. |
| **Dependency upgrades** | Dependabot only. |

## What we don't accept

- **Drive-by changes.** Open a PR only when you use leanprompt and encountered the problem, maintain a relevant upstream integration, or received prior maintainer approval for that specific change.
- **Speculative refactors** that don't solve a concrete problem.
- **Bulk/spray PRs** ("fix all lint warnings", "reformat everything").
- **New runtime dependencies** in `ts/`, `rust/`, or `go/` (see the zero-dependency invariant).
- **Dependency upgrades** outside Dependabot.
- **Changes to one language port without the others** when the parity invariant applies.

## AI-assisted contributions

AI-assisted contributions are welcome. The human submitter remains responsible for the change: review the complete diff, run the checks yourself, and disclose the model or tool used in the PR template's disclosure section.

Agents must not autonomously open pull requests or issues, or comment on issues. An agent can help prepare a specific PR or issue only after a human has verified the content and explicitly authorized that item. Agent-written review comments on implementation PRs -- allowed only for code review and replies to code review -- must be signed `~ Agent name (model name)` naming the actual model used.

## PR rules

- Branch from `main`.
- Fill out the PR template completely. PRs with an empty template may be closed.
- The checks above pass for every language the PR touches.
- Complete the parity checklist in the template; for algorithm or behavior changes, link the acknowledged issue.
- Add a `CHANGELOG.md` entry under `## [Unreleased]` for user-visible changes.
- Commit messages describe why, not just what.
- Keep PRs to one concern.

## Maintainer review

The maintainer ([@itaides](https://github.com/itaides)) reviews and merges all pull requests. An approval applies to the reviewed revision; a later substantive change requires another look.

Releases: bump the `ts/` and `rust/` versions in lockstep (CI enforces equality), update `CHANGELOG.md`, tag `vX.Y.Z`, tag `go/vX.Y.Z` for the Go module, and publish each package per its own README's publishing section. `mcp-proxy/` is versioned independently.

## Getting help

- [Issues](https://github.com/itaides/leanprompt/issues) -- bug reports and behavior-change proposals
- [SECURITY.md](SECURITY.md) -- report vulnerabilities privately, not via issues
