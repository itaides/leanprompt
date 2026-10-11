## What does this PR do?

<!-- Describe the change and why it is needed. Link related issues. -->

Closes #

## Type of change

<!-- Check one. -->

- [ ] Bug fix
- [ ] Algorithm or behavior change (links the acknowledged issue: #)
- [ ] Refactor (no behavior change)
- [ ] Performance improvement (measurements below)
- [ ] Documentation
- [ ] Tests
- [ ] Chore (CI, tooling)

## Parity checklist

<!-- Required for any change touching the classifier, token counting, content extraction, strategies, the Extract compressor, or the middleware pipeline. See CONTRIBUTING.md -> "The parity invariant". -->

- [ ] `docs/parity-spec.md` updated
- [ ] Parity vectors regenerated with `bun scripts/gen-parity.ts` (from `ts/`) and committed
- [ ] Rust port included
- [ ] Go port included
- [ ] Not applicable -- no change to classifier, tokens, content, strategies, Extract, or middleware

## Checks

<!-- Check only the languages this PR touches. All must pass. -->

- [ ] `cd ts && bun test && bun x tsc --noEmit && bun run build`
- [ ] `cd rust && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`
- [ ] `cd go && go test ./... && go vet ./... && gofmt -l .`
- [ ] `cd mcp-proxy && npm run typecheck && npm test && npm run build`

## Changelog

<!-- User-visible changes get an entry under `## [Unreleased]` in CHANGELOG.md. Write the entry here, or "Not applicable". -->

## AI assistance disclosure

<!-- If AI materially generated code or PR text, check the box and name every model/tool used. The human submitter must have reviewed the complete output. -->

- [ ] This PR includes AI-generated code or text -- model/tool:

## Test output / measurements

<!-- Paste relevant test output, parity diffs, or bench numbers. -->
