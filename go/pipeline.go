package leanprompt

// Compressor protocol, Verbatim, Router, strategies and the Middleware
// orchestrator (parity-spec §7, §9).

import (
	"log"
	"strings"
)

// Compressor is a compression strategy for a span of chat messages.
type Compressor interface {
	Name() string
	Compress(messages []Message) ([]Message, CompressionStats)
}

// Verbatim is the no-op compressor: input unchanged, honest token counts.
type Verbatim struct{}

func (Verbatim) Name() string { return "verbatim" }

func (Verbatim) Compress(messages []Message) ([]Message, CompressionStats) {
	tokens := CountMessageTokens(messages)
	return messages, statsCounted("verbatim", tokens, tokens)
}

// Router maps ContentType → Compressor with a Verbatim default.
type Router struct {
	routes          map[ContentType]Compressor
	defaultstrategy Compressor
}

func NewRouter() *Router {
	return &Router{routes: make(map[ContentType]Compressor), defaultstrategy: Verbatim{}}
}

func (r *Router) Register(ct ContentType, c Compressor) {
	r.routes[ct] = c
}

func (r *Router) Route(ct ContentType) Compressor {
	if c, ok := r.routes[ct]; ok {
		return c
	}
	return r.defaultstrategy
}

// Strategy is a deterministic pre-compression filter.
type Strategy interface {
	Name() string
	Apply(messages []Message) []Message
}

// DedupStrategy drops duplicate messages within a single request (fresh
// tracker per call; tool-linkage messages are never dropped).
type DedupStrategy struct{}

func (DedupStrategy) Name() string { return "dedup" }

func (DedupStrategy) Apply(messages []Message) []Message {
	tracker := NewRepeatTracker()
	out := make([]Message, 0, len(messages))
	for _, m := range messages {
		if !tracker.IsRepeat(m) {
			out = append(out, m)
		}
	}
	return out
}

// NormalizeStrategy is the lossless cleanup pass ("level 0") that runs
// before dedup, so CRLF/ANSI variants of the same output dedup to one.
// N1/N2 apply to every non-system span; N3/N4 to prose only; N5 to
// structured only (JSONDisabled turns off just N5). role "system"
// messages are never modified. The classifier class is computed on the
// ORIGINAL message before rewriting.
type NormalizeStrategy struct {
	// JSONDisabled turns off N5 (JSON whitespace minification) only.
	JSONDisabled bool
}

func (NormalizeStrategy) Name() string { return "normalize" }

func (s NormalizeStrategy) Apply(messages []Message) []Message {
	out := make([]Message, len(messages))
	for i, msg := range messages {
		out[i] = msg
		if strField(msg, "role") == "system" {
			continue
		}
		cls := Classify(msg)
		if content, changed := normalizeContent(msg["content"], cls, !s.JSONDisabled); changed {
			out[i] = cloneWith(msg, "content", content)
		}
	}
	return out
}

func normalizeContent(content any, cls ContentType, json bool) (any, bool) {
	switch v := content.(type) {
	case string:
		return normalizeSpan(v, cls, json)
	case []any:
		out, changed := mapChanged(v, func(b any) (any, bool) {
			return normalizeBlock(b, cls, json)
		})
		if !changed {
			return content, false
		}
		return out, true
	case map[string]any:
		return normalizeBlock(v, cls, json)
	}
	return content, false
}

func normalizeBlock(block any, cls ContentType, json bool) (any, bool) {
	b, ok := block.(map[string]any)
	if !ok {
		return block, false
	}
	switch strField(b, "type") {
	case "text":
		if text, isStr := b["text"].(string); isStr {
			if out, changed := normalizeSpan(text, cls, json); changed {
				return cloneWith(b, "text", out), true
			}
		}
		return block, false
	case "tool_result":
		switch inner := b["content"].(type) {
		case string:
			if out, changed := normalizeSpan(inner, cls, json); changed {
				return cloneWith(b, "content", out), true
			}
		case []any:
			out, changed := mapChanged(inner, func(item any) (any, bool) {
				return normalizeBlock(item, cls, json)
			})
			if changed {
				return cloneWith(b, "content", out), true
			}
		}
	}
	return block, false
}

// mapChanged maps items; the bool result reports whether anything changed.
func mapChanged(items []any, f func(any) (any, bool)) ([]any, bool) {
	changed := false
	out := make([]any, len(items))
	for i, item := range items {
		if next, ok := f(item); ok {
			out[i] = next
			changed = true
		} else {
			out[i] = item
		}
	}
	return out, changed
}

func normalizeSpan(text string, cls ContentType, json bool) (string, bool) {
	out := stripCRLF(text)
	out = stripANSI(out)
	switch {
	case cls == Prose:
		out = collapseBlankRuns(stripInvisible(out))
	case cls == Structured && json:
		out = minifyJSONWhitespace(out)
	}
	return out, out != text
}

// N1: "\r\n" → "\n", then remaining lone "\r" → "\n".
func stripCRLF(text string) string {
	if !strings.ContainsRune(text, '\r') {
		return text
	}
	cps := []rune(text)
	out := make([]rune, 0, len(cps))
	for i := 0; i < len(cps); i++ {
		if cps[i] == '\r' {
			out = append(out, '\n')
			if i+1 < len(cps) && cps[i+1] == '\n' {
				i++
			}
		} else {
			out = append(out, cps[i])
		}
	}
	return string(out)
}

// N2: remove ANSI escapes — CSI (params 0x30-0x3F, intermediates
// 0x20-0x2F, final 0x40-0x7E; no valid final byte → left as-is), OSC
// (payload ends at BEL or ST; unterminated runs to end of span), Fe
// (ESC + 0x40-0x5F). Other ESC uses stay.
func stripANSI(text string) string {
	cps := []rune(text)
	found := false
	for _, c := range cps {
		if c == 0x1b {
			found = true
			break
		}
	}
	if !found {
		return text
	}
	out := make([]rune, 0, len(cps))
	i := 0
	for i < len(cps) {
		cp := cps[i]
		if cp != 0x1b {
			out = append(out, cp)
			i++
			continue
		}
		var next rune = -1
		if i+1 < len(cps) {
			next = cps[i+1]
		}
		switch {
		case next == '[':
			j := i + 2
			for j < len(cps) && cps[j] >= 0x30 && cps[j] <= 0x3f {
				j++
			}
			for j < len(cps) && cps[j] >= 0x20 && cps[j] <= 0x2f {
				j++
			}
			if j < len(cps) && cps[j] >= 0x40 && cps[j] <= 0x7e {
				i = j + 1
			} else {
				out = append(out, cp)
				i++
			}
		case next == ']':
			// An ESC inside the payload not followed by \ is payload.
			j := i + 2
			end := len(cps)
			for j < len(cps) {
				if cps[j] == 0x07 {
					end = j + 1
					break
				}
				if cps[j] == 0x1b && j+1 < len(cps) && cps[j+1] == '\\' {
					end = j + 2
					break
				}
				j++
			}
			i = end
		case next >= 0x40 && next <= 0x5f:
			i += 2
		default:
			out = append(out, cp)
			i++
		}
	}
	return string(out)
}

// N3: remove ZWSP, WJ, ZWNBSP — never ZWNJ/ZWJ.
func stripInvisible(text string) string {
	cps := []rune(text)
	out := make([]rune, 0, len(cps))
	for _, c := range cps {
		if c != 0x200b && c != 0x2060 && c != 0xfeff {
			out = append(out, c)
		}
	}
	return string(out)
}

// N4: collapse runs of 3+ newlines into exactly 2; whitespace-only lines
// between newlines count as empty and are stripped. Trailing whitespace on
// non-empty lines (markdown hard breaks) is preserved.
func collapseBlankRuns(text string) string {
	cps := []rune(text)
	out := make([]rune, 0, len(cps))
	i := 0
	for i < len(cps) {
		if cps[i] != '\n' {
			out = append(out, cps[i])
			i++
			continue
		}
		count := 0
		j := i
		for {
			count++
			j++
			k := j
			for k < len(cps) && (cps[k] == ' ' || cps[k] == '\t') {
				k++
			}
			if k < len(cps) && cps[k] == '\n' {
				j = k
			} else {
				break
			}
		}
		out = append(out, '\n')
		if count > 1 {
			out = append(out, '\n')
		}
		i = j
	}
	return string(out)
}

// N5: JSON whitespace minification — only space/\t/\n/\r outside strings
// is removed; strings, key order and number literals are verbatim. Any
// malformed input is returned unchanged.
func minifyJSONWhitespace(text string) string {
	isWS := func(c rune) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' }
	cps := []rune(text)
	start := 0
	for start < len(cps) && isWS(cps[start]) {
		start++
	}
	if start >= len(cps) || (cps[start] != '{' && cps[start] != '[') {
		return text
	}
	out := make([]rune, 0, len(cps))
	inString := false
	escaped := false
	depth := 0
	ended := false
	for i := start; i < len(cps); i++ {
		cp := cps[i]
		if inString {
			out = append(out, cp)
			if escaped {
				escaped = false
			} else if cp == '\\' {
				escaped = true
			} else if cp == '"' {
				inString = false
			}
			continue
		}
		if isWS(cp) {
			continue
		}
		if ended {
			return text // trailing garbage after a complete value
		}
		switch cp {
		case '"':
			inString = true
		case '{', '[':
			depth++
		case '}', ']':
			depth--
			if depth < 0 {
				return text // unbalanced
			}
			if depth == 0 {
				ended = true
			}
		}
		out = append(out, cp)
	}
	if inString || depth != 0 {
		return text // unterminated string / unbalanced brackets
	}
	return string(out)
}

const purgePlaceholder = "[errored output purged for context compaction]"

// PurgeErrorsStrategy replaces the content of errored messages older than
// AfterTurns with a short placeholder. System messages are never purged,
// and structured content is trimmed per block so a tool_result keeps its
// shape and linkage ids.
type PurgeErrorsStrategy struct {
	AfterTurns int
}

func (PurgeErrorsStrategy) Name() string { return "purge_errors" }

func (s PurgeErrorsStrategy) Apply(messages []Message) []Message {
	if len(messages) <= s.AfterTurns {
		return messages
	}
	cutoff := len(messages) - s.AfterTurns
	out := make([]Message, len(messages))
	for i, msg := range messages {
		if i >= cutoff || strField(msg, "role") == "system" || Classify(msg) != ErrorType {
			out[i] = msg
			continue
		}
		out[i] = cloneWith(msg, "content", purgeContent(msg["content"]))
	}
	return out
}

func purgeContent(content any) any {
	switch v := content.(type) {
	case string:
		return purgePlaceholder
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = purgeBlock(item)
		}
		return out
	case map[string]any:
		return purgeBlock(v)
	}
	return content
}

func purgeBlock(block any) any {
	b, ok := block.(map[string]any)
	if !ok {
		return block
	}
	if !looksLikeError(extractText(b)) {
		return block
	}
	switch strField(b, "type") {
	case "text":
		return cloneWith(b, "text", purgePlaceholder)
	case "tool_result":
		switch inner := b["content"].(type) {
		case string:
			return cloneWith(b, "content", purgePlaceholder)
		case []any:
			out := make([]any, len(inner))
			for i, item := range inner {
				out[i] = purgeBlock(item)
			}
			return cloneWith(b, "content", out)
		}
	}
	return block
}

// ------------------------------------------------------------------------ //
// Middleware
// ------------------------------------------------------------------------ //

const (
	defaultThresholdTokens  = 2000
	defaultProtectLastTurns = 2
)

// Config mirrors the reference config surface with integer ratios
// (thousandths) instead of floats.
type Config struct {
	// Mode "on"/"hybrid" activate; "off"/"passthrough"/"disabled" bypass.
	Mode            string
	ThresholdTokens int64
	// Routing: content-type name → compressor name ("verbatim" | "extract").
	Routing            map[string]string
	ExtractRatioMillis int64
	// ProtectLastTurns: 0 means default (2); to protect nothing set
	// ProtectLastTurnsDisabled instead.
	ProtectLastTurns         int
	ProtectLastTurnsDisabled bool
	// NormalizeDisabled turns off the lossless cleanup pass (runs first).
	NormalizeDisabled bool
	// NormalizeJSONDisabled turns off only N5 (JSON whitespace
	// minification) inside normalize.
	NormalizeJSONDisabled bool
	DedupDisabled         bool
	// PurgeErrorsAfterTurns < 0 disables purge; 0 means default (4).
	PurgeErrorsAfterTurns int
}

// Middleware orchestrates compression across a single request.
type Middleware struct {
	active           bool
	threshold        int64
	protectLastTurns int
	router           *Router
	protector        Verbatim
	strategies       []Strategy
}

func NewMiddleware(config Config) *Middleware {
	mode := strings.ToLower(config.Mode)
	active := mode != "" && mode != "off" && mode != "passthrough" && mode != "disabled"

	threshold := config.ThresholdTokens
	if threshold == 0 {
		threshold = defaultThresholdTokens
	}
	ratio := config.ExtractRatioMillis
	if ratio == 0 {
		ratio = defaultRatioMillis
	}
	protectLastTurns := config.ProtectLastTurns
	if protectLastTurns == 0 {
		protectLastTurns = defaultProtectLastTurns
	}
	if config.ProtectLastTurnsDisabled {
		protectLastTurns = 0
	}

	router := NewRouter()
	for ctypeStr, compressorName := range config.Routing {
		ctype, ok := contentTypeFrom(ctypeStr)
		if !ok {
			log.Printf("leanprompt: unknown content type %q in routing config; ignored", ctypeStr)
			continue
		}
		switch compressorName {
		case "verbatim":
			router.Register(ctype, Verbatim{})
		case "extract":
			router.Register(ctype, NewExtract(ratio))
		default:
			log.Printf(
				"leanprompt: compressor %q not available; falling back to default (verbatim) for %s",
				compressorName, ctypeStr,
			)
		}
	}
	// STRUCTURED stays on the Verbatim default unless explicitly routed —
	// sentence-segmenting JSON is meaningless.

	var strategies []Strategy
	if active {
		// Normalize runs first: CRLF/ANSI variants of the same output
		// should dedup to one message.
		if !config.NormalizeDisabled {
			strategies = append(strategies, NormalizeStrategy{JSONDisabled: config.NormalizeJSONDisabled})
		}
		if !config.DedupDisabled {
			strategies = append(strategies, DedupStrategy{})
		}
		if config.PurgeErrorsAfterTurns >= 0 {
			after := config.PurgeErrorsAfterTurns
			if after == 0 {
				after = 4
			}
			strategies = append(strategies, PurgeErrorsStrategy{AfterTurns: after})
		}
	}

	return &Middleware{
		active:           active,
		threshold:        threshold,
		protectLastTurns: protectLastTurns,
		router:           router,
		strategies:       strategies,
	}
}

func (m *Middleware) CompressMessages(messages []Message) ([]Message, CompressionStats) {
	if !m.active || len(messages) == 0 {
		method := "passthrough"
		if len(messages) == 0 {
			method = "empty"
		}
		return messages, statsWithMethod(method)
	}

	// Token count is taken on the ORIGINAL list so dedup/purge savings count
	// toward tokensSaved (parity-spec §9).
	inputTokens := CountMessageTokens(messages)
	if inputTokens < m.threshold {
		return messages, statsCounted("below-threshold", inputTokens, inputTokens)
	}

	for _, strategy := range m.strategies {
		messages = strategy.Apply(messages)
	}
	if len(messages) == 0 {
		return messages, CompressionStats{
			InputTokens:  inputTokens,
			OutputTokens: 0,
			Ratio:        0,
			Method:       "empty",
		}
	}

	out := make([]Message, 0, len(messages))
	var totalOut int64
	var totalCost float64
	methods := make(map[string]struct{})

	for i, msg := range messages {
		var compressor Compressor
		if m.isProtected(i, len(messages), msg) {
			compressor = m.protector
		} else {
			compressor = m.router.Route(Classify(msg))
		}
		compressed, stats := compressor.Compress([]Message{msg})
		out = append(out, compressed...)
		totalOut += stats.OutputTokens
		totalCost += stats.CostUSD
		methods[stats.Method] = struct{}{}
	}

	return out, aggregate(inputTokens, totalOut, totalCost, methods)
}

// System messages and the last K turns are never handed to a lossy
// compressor — they carry the live instructions/questions.
func (m *Middleware) isProtected(index, total int, msg Message) bool {
	if strField(msg, "role") == "system" {
		return true
	}
	return index >= total-m.protectLastTurns
}

func aggregate(totalIn, totalOut int64, totalCost float64, methods map[string]struct{}) CompressionStats {
	var method string
	switch len(methods) {
	case 0:
		method = "empty"
	case 1:
		for m := range methods {
			method = m
		}
	default:
		method = "hybrid"
	}
	stats := statsCounted(method, totalIn, totalOut)
	stats.CostUSD = totalCost
	return stats
}
