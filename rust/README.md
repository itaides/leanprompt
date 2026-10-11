# leanprompt (Rust)

Zero-dependency prompt compression for LLM applications — the Rust port of
[`docs/parity-spec.md`](../docs/parity-spec.md), byte-compatible with the
TypeScript reference (asserted against `../parity/*.json`).

Truly `[dependencies]`-empty: JSON (parser + canonical serializer) and
SHA-256 are implemented in-crate; the token estimator, classifier, Extract
compressor and middleware use only std.

```rust
use leanprompt::{json, Config, Middleware};

let messages = json::parse(r#"[{"role":"user","content":"..."}]"#)?;
let mw = Middleware::new(Config {
    mode: "on".into(),
    routing: vec![("prose".into(), "extract".into())],
    ..Config::default()
});
let (compressed, stats) = mw.compress_messages(messages.as_arr().unwrap());
```

`SelfLlm` (LLM-delegated summarization for anthropic/openai/gemini) builds
requests and parses responses; you supply the transport by implementing the
one-method `HttpPost` trait with whatever HTTP client you already use
(std has no HTTPS — this keeps the crate dependency-free).

```bash
cargo test    # includes the golden-vector parity suite
```

## `serde` feature (opt-in)

If your project already depends on `serde_json`, enable the `serde`
feature for zero-cost interop with the in-crate `json::Value` — no
serialize/parse round-trip:

```toml
leanprompt = { version = "0.4", features = ["serde"] }
```

```rust
use leanprompt::serde_conv::{messages_from_json, messages_to_json};

let messages: Vec<serde_json::Value> = /* … */;
let (compressed, _stats) = mw.compress_messages(&messages_from_json(&messages));
let back: Vec<serde_json::Value> = messages_to_json(&compressed);
```

Off by default: the default build stays dependency-free, and the in-crate
JSON implementation still does all parsing inside the pipeline.

## Publishing (crates.io)

```bash
# 1. bump "version" in Cargo.toml (keep it in step with ts/package.json
#    and go's next tag — the three SDKs claim byte-identical behavior)
cargo test
cargo clippy --all-targets -- -D warnings

cargo login <token>          # one-time, if not already authenticated
cargo publish --dry-run      # verifies the package builds standalone,
                              # shows exactly what will be uploaded
cargo publish
```

`rust/LICENSE` is bundled in the published package alongside the SPDX
`license = "MIT"` field in `Cargo.toml` — recommended by crates.io and
already present. Publishing is permanent per version — `cargo publish
--dry-run` first is cheap insurance.

MIT. See the repo root `LICENSE`.
