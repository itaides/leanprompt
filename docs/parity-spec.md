# leanprompt cross-language parity spec

This document is **normative** for the TypeScript (`ts/`), Rust (`rust/`) and
Go (`go/`) implementations. The TS implementation is the *first*
implementation of this spec, not its definition: where a host language quirk
(V8 Unicode tables, UTF-16 lengths, map ordering) disagrees with this
document, the document wins.

Golden vectors live in `parity/*.json`, regenerated with
`bun scripts/gen-parity.ts` (from `ts/`). Vectors contain **text and integers
only** — floats (e.g. `CompressionStats.ratio`) are recomputed per language
and never byte-compared.

## 1. Code points, not code units

All text iteration, counting and slicing is over **Unicode code points**
(scalar values). Never UTF-16 code units (JS `string.length`), never bytes,
never grapheme clusters.

## 2. Pinned character classes

Host Unicode tables (`\p{L}`, `unicode.IsLetter`, `char::is_alphabetic`) vary
by Unicode version across runtimes and MUST NOT be used. The pinned classes:

**isSpaceChar(cp)** — true for: U+0020, U+0009–U+000D, U+0085, U+00A0,
U+2000–U+200B, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF.

**isWordChar(cp)** —
- cp < 0x80: true iff ASCII alphanumeric (`0-9A-Za-z`).
- cp ≥ 0x80: true iff NOT isSpaceChar and NOT in the pinned punctuation
  blocks: U+2010–U+2027, U+2030–U+205E, U+3001–U+303F, U+FE50–U+FE6F,
  U+FF01–U+FF0F, U+FF1A–U+FF20, U+FF3B–U+FF40, U+FF5B–U+FF65.

**asciiLower(text)** — maps `A-Z` to `a-z` only; every other code point is
unchanged. No host `toLowerCase`.

## 3. Token estimator (`tokens`)

State machine over code points:
- A maximal run of isWordChar code points of length N contributes
  `max(1, ceil(N / 4))` tokens.
- Every other code point that is not isSpaceChar contributes 1 token.
- Empty text → 0. Otherwise the total is `max(1, sum)`.

## 4. Canonical JSON (`content`)

`tool_use.input` values are serialized for text extraction as canonical JSON:
- Object keys sorted lexicographically by Unicode code point.
- Compact separators (`,` and `:`), no whitespace.
- Strings escaped per JSON with non-ASCII characters preserved (no `\uXXXX`
  escaping of printable non-ASCII).
- `null`/`undefined` top-level → empty string; bare strings pass through
  unserialized; booleans → `true`/`false`.

## 5. Content extraction (`content`)

`getTextContent(message)` recursively extracts compressible text:
- string content → itself
- block list → per-block text, non-empty parts joined with `\n`
- block types: `text` → its `text`; `tool_use` → `[tool_use {name}] {canonical
  json of input}` (or just the serialized input when there is no name);
  `tool_result` → recurse into `content`; `document` → `text` field, else
  `source.data`, else recurse into `content`; everything else → empty.

## 6. Classifier (`classifier`)

Check order: **ERROR > CODE > STRUCTURED > PROSE**; UNKNOWN when the
extracted text is empty/whitespace. Constants are frozen:
- ERROR: text contains any marker from the reference list (`Traceback (most
  recent call last):`, `Uncaught exception`, `UnhandledPromiseRejection`,
  `thread 'main' panicked at`, `panic: `, `Exception in thread`, `FATAL: `,
  `ERROR: `, `Error: `, `Exception: `, `java.lang.`).
- CODE: contains ``` , or ≥ 2 lines whose left-trimmed form starts with a
  reference code prefix (`def `, `class `, `function `, `async function `,
  `import `, `from `, `export `, `package `, `#include`, `fn `, `pub fn `,
  `func `, `var `, `const `, `let `).
- STRUCTURED: length ≥ 200 code points AND JSON-key density ≥ 1.0 keys per
  1000 code points. A JSON key is `"` + 1–64 non-`"`/non-newline code points +
  `"` + optional spaces/tabs + `:` (procedural scan; no regex required).

**RepeatTracker**: hash is SHA-256 over the UTF-8 bytes of `role + "|" +
text`, hex-encoded. Messages containing `tool_use`/`tool_result` blocks are
never hashed (always "not a repeat"). Empty text is never hashed.

## 7. Strategies (`strategies`)

- **dedup**: fresh tracker per call; keep first occurrence.
- **purge_errors(afterTurns=4)**: if `len(messages) <= afterTurns` return
  unchanged; else replace the content of ERROR-classified messages with index
  `< len - afterTurns` by `[errored output purged for context compaction]`.

## 8. Extract compressor (`extract`, `word-tokens`)

All scoring is **integer arithmetic**. No `log`/libm anywhere.

Segmentation (per input, after splitting on `\n` and trimming each line):
- Empty lines are skipped. List/table lines are single sentences flagged
  `listItem`: lines starting with `|`, or `- ` / `* ` / `+ ` (with content
  after), or 1+ ASCII digits followed by `.` or `)` and a space.
- Lines ≤ 12 code points are single sentences.
- Otherwise split after `.`/`!`/`?` when followed by a space or tab, except:
  a `.` whose preceding word (maximal run of isWordChar/`.` code points,
  leading dots stripped) ASCII-lowercases to an entry of the frozen
  abbreviation set, or is a single ASCII capital letter.

Scoring (per sentence; `words` = asciiLower word tokens):
- `termWeight(w) = bitLength(floor(max(1, totalTerms) / count(w)))` where
  totalTerms counts non-stopword occurrences span-wide and bitLength(0)=0.
- base = `floor(sum(termWeight over non-stopword words) * 1000 / len(words))`.
- boosts: +350 any ASCII digit; +200 capitalized non-initial word (ASCII
  `[A-Z]` start + `[a-z]` second letter); +200 quoted span (same quote char
  `"`/`'`/`` ` `` twice, gap > 3); +300 identifier token (alnum on both sides
  of `_`, `/`, `-` or `.`); +250 first or last sentence; +400 constraint
  marker substring; −400 filler opener prefix. Marker lists are frozen in the
  reference implementation.
- Sentences containing a prohibition marker (`do not`, `don't`, `must not`,
  `never `) are kept **unconditionally** (before ranked selection, charged to
  the budget).

Selection:
- Rank by (score desc, index asc) — stable, explicit tiebreak.
- Keep while `keptTokens * 1000 < ratioMillis * totalTokens`.
- Redundancy: skip a candidate whose 3-word-shingle intersection with any
  kept sentence satisfies `intersection * 100 > 60 * union` — unless the
  candidate is a listItem, or its multiset of digit-bearing words differs
  from that kept sentence's.
- A kept sentence whose first word token is in the anaphoric-opener set pulls
  in its immediate predecessor (if not kept), charged to the budget.
- If nothing was kept, keep the top-ranked sentence. Output = kept sentences
  in original order joined by a single space.

Span guards (pass through unchanged): structural markers (``` or
`Traceback (most recent call last)`), span < 40 tokens, < 3 sentences, or
ASCII share of code points < 60%.

Block-aware application: `text` blocks and string `tool_result` contents are
compressed in place (structural tool_results verbatim); `tool_use`, `image`,
`thinking`, `document` and unknown blocks pass through with their extracted
text token-counted into both sides of the stats.

## 9. Middleware (`middleware`)

Pipeline: mode gate (`off`/`passthrough`/`disabled` → passthrough) →
strategies (dedup default on, purge default on with afterTurns=4) → token
threshold (default 2000; below → `below-threshold`) → per-message
classify/route/compress → aggregate.

Protection: `role == "system"` messages and the last `protect.lastTurns`
(default 2) messages always route to Verbatim, regardless of routing config.

STRUCTURED routes to the Verbatim default unless explicitly configured — no
automatic extractive pass for structured data.

Aggregate method string: `empty` (no messages), the single method if all
per-message methods agree, else `hybrid`. Ratio = totalOut/totalIn as a
float — recomputed, never compared across languages.

## 10. Telemetry

Response usage annotations use each language's idiomatic casing (JS:
`leanpromptTokensSaved`, `leanpromptRatio`, `leanpromptMethod`); the integer
`tokensSaved = inputTokens - outputTokens` must match across languages.
