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
| `mcp-proxy` (`leanprompt-mcp-proxy` on npm) | latest release |

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

## Trust boundaries

A lossy compressor sits between your application and the model, so it
decides what the model sees. [arXiv:2510.22963](https://arxiv.org/abs/2510.22963)
("When Compression Becomes an Attack Surface") shows that when trusted and
untrusted inputs share one compression budget, perturbing the untrusted part
can make the compressor drop task-critical evidence or guardrails from the
trusted part. The guarantees leanprompt makes against that class of attack,
and that a bug report may cite as violated:

1. **`system` messages are never modified** -- not compressed, deduped,
   purged or reordered -- regardless of configuration (parity-spec
   sections 6, 7 and 9).
2. **Compression is per message.** Sentence statistics, the keep budget,
   redundancy filtering and selection operate on one message at a time.
   Content in message A cannot change which sentences survive in message B.
3. **Prohibitions survive unconditionally** within their own message
   (parity-spec section 8), and content the classifier labels code, error or
   structured, plus all tool-call blocks, passes through verbatim.
4. **Deterministic and inspectable.** `Extract` has no model and no
   randomness; identical input yields identical output in all three SDKs, so
   a suspected manipulation can be reproduced offline from the input alone.

What is explicitly *not* a guarantee: leanprompt does not detect or remove
prompt injection inside a message, does not authenticate message sources,
and `SelfLLM` (an LLM call) inherits whatever robustness the summarizing
model has. Treat the output of `SelfLLM` on untrusted content as untrusted.

A report that shows one of the four guarantees above being violated by
crafted input is in scope and welcome.

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
