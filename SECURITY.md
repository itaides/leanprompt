# Security Policy

## Supported versions

leanprompt is pre-1.0 across all three SDKs. Security fixes land on the
latest release of each package (`ts` on npm, `rust` on crates.io, `go` via
its module proxy) — there is no long-term-support branch yet.

| SDK | Supported |
|---|---|
| TypeScript (`leanprompt` on npm) | latest release |
| Rust (`leanprompt` on crates.io) | latest release |
| Go (`github.com/itaides/leanprompt/go`) | latest release |

## Scope

leanprompt is a **library**, not a hosted service: it runs in your process,
makes no network calls unless you explicitly configure `SelfLLM` /
`leanpromptFetch` with a provider, and stores nothing. Its attack surface is
narrow but real:

- **Untrusted input to the compression pipeline** (`Middleware.compressMessages`,
  the `Extract` compressor, the classifier, content extraction): the library
  is designed to run over arbitrary/untrusted chat message content. A bug that
  causes a panic/crash/hang/OOM on adversarial input, or that silently
  corrupts message content in an unsafe way (e.g. defeats the code/error/JSON
  classifier gate and mangles structured data), is a security-relevant bug
  here even without memory unsafety.
- **The `SelfLLM` and `leanpromptFetch` HTTP paths**: request construction,
  API key handling (never logged, never included in compressed output), and
  response parsing for the Anthropic/OpenAI/Gemini integrations.
- **Supply chain**: the `ts/`, `rust/`, and `go/` packages ship with **zero
  third-party runtime dependencies** by design (see `docs/parity-spec.md`);
  a PR that introduces a new runtime dependency to any of the three SDKs
  should be treated as security-relevant and scrutinized accordingly.

Out of scope: vulnerabilities in the LLM provider APIs themselves, in your
own application code, or in a provider SDK you use alongside `leanpromptFetch`
/ `wrap()`.

## Reporting a vulnerability

Please **do not open a public GitHub issue** for security reports.

Email **itaios052@gmail.com** with:
- a description of the issue and its impact
- steps to reproduce (a minimal input/config that triggers it is ideal)
- which SDK(s) are affected (ts / rust / go) and version

You should receive an acknowledgment within **5 business days**. We'll work
with you on a fix and coordinate a disclosure timeline before any public
write-up; credit is given in the release notes unless you prefer otherwise.

## Preferred report contents (not required, but speeds things up)

- Minimal reproduction: exact `messages` input + config that triggers the
  issue, or a link to a failing case against `parity/`.
- Whether the issue reproduces in all three SDKs or is language-specific.
- For classifier/Extract-gating bypasses: the specific input that should have
  been routed to `verbatim` but wasn't.
