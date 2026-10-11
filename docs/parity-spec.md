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

State machine over code points. Word runs and dense-script runs are tracked
and charged separately — isWordChar/isSpaceChar (§2) are unchanged and used
as-is elsewhere (e.g. Extract's word-tokenization, §8); the dense-script
split below is local to the token estimator only:

- **isDenseScriptChar(cp)** — true for code points in: U+0E00–U+0E7F (Thai),
  U+0E80–U+0EFF (Lao), U+1000–U+109F (Myanmar), U+1100–U+11FF (Hangul Jamo),
  U+1780–U+17FF (Khmer), U+3040–U+309F (Hiragana), U+30A0–U+30FF (Katakana),
  U+3400–U+4DBF (CJK Ext A), U+4E00–U+9FFF (CJK Unified Ideographs),
  U+AC00–U+D7A3 (Hangul Syllables), U+F900–U+FAFF (CJK Compatibility
  Ideographs). These scripts have no space-delimited word boundaries; real
  BPE tokenizers run far denser than 4 chars/token on them (commonly
  ~1.5–2.5 chars/token), so bucketing them through the space-delimited-word
  divisor undercounts by roughly 2-3x.
- A maximal run of isWordChar code points of length N that are NOT
  isDenseScriptChar contributes `max(1, ceil(N / 4))` tokens.
- A maximal run of isDenseScriptChar code points of length N contributes
  `max(1, ceil(N * 2 / 3))` tokens (integer arithmetic: `ceil(N*2/3)`, never
  floating-point division, to stay bit-identical across languages).
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

**Tool linkage** -- `hasToolLinkage(message)` is true when ANY of:

- `content` is a block list containing an object whose `type` is `tool_use`
  or `tool_result`, or `content` is a single object block of such a type;
- `role` is `"tool"` or `"function"`;
- `tool_calls` is an array of length > 0;
- `function_call` is a non-null object.

**RepeatTracker**: key is the exact string `role + "|" + text`. `isRepeat`
is true iff the key was already recorded. Never recorded (always "not a
repeat"): messages with tool linkage, messages with `role == "system"`,
and messages with empty extracted text.

## 7. Strategies (`strategies`)

- **normalize**: lossless cleanup ("level 0"), runs FIRST — before dedup,
  so CRLF/ANSI variants of the same output dedup to one. Default ON.
  Rewrites every compressible text span of every message EXCEPT messages
  with `role == "system"` (system is never modified). Spans are the same
  walk `purge_errors` uses: string `content`, `text` block `text` fields,
  string `tool_result` content, recursively into `tool_result` arrays, and
  a single-object `content` treated as one block. `tool_use.input`, image,
  thinking, document and unknown blocks are untouched. Spans are rewritten
  in place; block/message shape and all other fields are preserved. The
  message's classifier class (§6, unchanged) is computed on the ORIGINAL
  message before any rewriting and gates which transforms apply.

  Applied to every non-system span regardless of class:
  - **N1** `\r\n` → `\n`, then remaining lone `\r` → `\n`.
  - **N2** ANSI escape removal. CSI: `ESC [` + params (`0x30–0x3F`)\* +
    intermediates (`0x20–0x2F`)\* + final (`0x40–0x7E`); a sequence without
    a valid final byte is not an escape — the `ESC` and everything after
    it are left as-is. OSC: `ESC ]` + payload terminated by `BEL` (`0x07`)
    or ST (`ESC \`); an unterminated OSC is removed through the end of the
    span, and an `ESC` inside the payload not followed by `\` is payload.
    Fe: bare `ESC` followed by a single char in `0x40–0x5F` removes both
    bytes. Other uses of `0x1B` are left as-is.
  Applied only when the message classifies as PROSE:
  - **N3** remove U+200B (ZWSP), U+2060 (WJ), U+FEFF (ZWNBSP). U+200C and
    U+200D (ZWNJ/ZWJ) are kept — real Persian/Indic text and emoji
    sequences need them.
  - **N4** collapse runs of 3+ consecutive `\n` into exactly 2, where lines
    containing only spaces/tabs between newlines count as empty (their
    whitespace is stripped as part of the run). A run of exactly 2
    newlines becomes `\n\n` with any interleaved whitespace-only content
    stripped. Trailing whitespace on non-empty lines is never stripped
    (markdown hard breaks), and whitespace at the very start/end of the
    span is left alone — only whitespace bounded by newlines on both
    sides is touched.
  Applied only when the message classifies as STRUCTURED:
  - **N5** JSON whitespace minification, lossless by construction. If the
    span's first non-{space, `\t`, `\n`, `\r`} code point is `{` or `[`,
    scan it tracking string state (`"` toggles; `\` escapes the next code
    point); remove every code point in {space, `\t`, `\n`, `\r`} outside
    strings. The result must be a complete balanced value: depth (from
    `{`/`[` +1 and `}`/`]` −1, counting outside strings only) returns to 0
    at the final non-whitespace code point. On any failure — negative or
    unclosed depth, unterminated string, or non-whitespace after depth
    reached 0 (trailing garbage) — the span is left unchanged. Numbers are
    never parsed; key order is never touched. Disabled by the
    `json: false` / `normalize_json` config toggle; N1/N2 still apply.

- **dedup**: fresh tracker per call; keep first occurrence.
- **purge_errors(afterTurns=4)**: if `len(messages) <= afterTurns` return
  unchanged. Otherwise, for each message with index `< len - afterTurns`:
  skip when `role == "system"`; skip unless `classify(message) == ERROR`;
  then purge by content shape:
  - string content → replaced by the placeholder `[errored output purged
    for context compaction]`;
  - block list → each element mapped by `purgeBlock`; non-object elements
    unchanged;
  - single object block → `purgeBlock`;
  - anything else → unchanged.

  `purgeBlock(block)`: let `t = extractText(block)` (the same extraction
  the classifier uses). If `t` contains no ERROR marker (the classifier's
  marker list, §6), return the block unchanged. Otherwise by `type`:
  `text` → `{...block, text: placeholder}`; `tool_result` → string
  `content` → `{...block, content: placeholder}`, list `content` →
  `{...block, content: elements mapped by purgeBlock}`, anything else →
  unchanged; any other type (`tool_use`, `image`, `thinking`, `document`,
  unknown) → unchanged. All other fields of the message and block
  (`tool_call_id`, `tool_use_id`, `is_error`, `name`, `tool_calls`,
  `cache_control`, ...) are preserved.

## 8. Extract compressor (`extract`, `word-tokens`)

All scoring is **integer arithmetic**. No `log`/libm anywhere.

Segmentation (per input, after splitting on `\n` and trimming each line):
- Empty lines are skipped. Each sentence records `line` (0-based index
  among the non-empty trimmed lines of the span) and `paragraphBreak`
  (true iff at least one empty/whitespace-only line immediately preceded
  its source line; the first non-empty line's value is false).
- List/table lines are single sentences flagged `listItem`: lines starting
  with `|`, or `- ` / `* ` / `+ ` (with content
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
  `"`/`'`/`` ` `` twice with gap > 3, the opener at index 0 or preceded by
  a non-word code point, the closer at end-of-text or followed by a
  non-word code point — apostrophes inside words never count); +300
  identifier token (alnum on both sides of `_`, `/`, `-` or `.`); +250
  first or last sentence; +400 constraint marker; −400 filler opener
  prefix. Marker lists are frozen in the reference implementation.
- **Marker matching** (prohibition and constraint lists): a marker `m`
  matches lowercased text `t` iff some index `p` satisfies
  `t.startsWith(m, p)` AND (`p == 0` OR the code point ending at `p - 1`
  is not a word char, §2 `isWordChar`). No trailing boundary check —
  several markers already end with a space. All markers are ASCII, so a
  match position always lands on a code-point boundary.
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
- If nothing was kept, keep the top-ranked sentence. Output = kept
  sentences in original order; the separator between consecutive kept
  sentences A then B is `" "` when `A.line == B.line`, `"\n\n"` when
  `B.paragraphBreak` is true, `"\n"` otherwise.

Span guards (pass through unchanged): structural markers (``` or
`Traceback (most recent call last)`), span < 40 tokens, < 3 sentences, or
ASCII share of code points < 60%.

Block-aware application: `text` blocks and string `tool_result` contents are
compressed in place (structural tool_results verbatim); `tool_use`, `image`,
`thinking`, `document` and unknown blocks pass through with their extracted
text token-counted into both sides of the stats.

## 9. Middleware (`middleware`)

Pipeline: mode gate (`off`/`passthrough`/`disabled` → passthrough) → empty
list → `empty` → `inputTokens = countMessageTokens(original messages)` →
token threshold (default 2000; `inputTokens < threshold` → return the
ORIGINAL list untouched, method `below-threshold`, inputTokens =
outputTokens, ratio 1.0) → strategies, applied in order normalize → dedup
→ purge (each default ON; purge with afterTurns=4) → now-empty list → `empty` (inputTokens as counted,
outputTokens 0, ratio 0) → per-message classify/route/compress →
aggregate.

Protection: `role == "system"` messages and the last `protect.lastTurns`
(default 2) messages always route to Verbatim, regardless of routing config.

STRUCTURED routes to the Verbatim default unless explicitly configured — no
automatic extractive pass for structured data.

Aggregate: `totalIn = inputTokens` (the PRE-strategy count -- counting
before strategies run is what lets `tokensSaved` include dedup/purge wins)
and `totalOut = sum of per-message outputTokens`. Method string: `empty`
(no messages), the single method if all per-message methods agree, else
`hybrid`; strategies add no method. Ratio = totalOut/totalIn as a float --
recomputed, never compared across languages.

## 10. Telemetry

Response usage annotations use each language's idiomatic casing (JS:
`leanpromptTokensSaved`, `leanpromptRatio`, `leanpromptMethod`); the integer
`tokensSaved = inputTokens - outputTokens` must match across languages.
