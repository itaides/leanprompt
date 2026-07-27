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

const purgePlaceholder = "[errored output purged for context compaction]"

// PurgeErrorsStrategy replaces the content of errored messages older than
// AfterTurns with a short placeholder.
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
		if i < cutoff && Classify(msg) == ErrorType {
			out[i] = cloneWith(msg, "content", purgePlaceholder)
		} else {
			out[i] = msg
		}
	}
	return out
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
	ProtectLastTurns   int
	DedupDisabled      bool
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
		protectLastTurns: config.ProtectLastTurns,
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

	for _, strategy := range m.strategies {
		messages = strategy.Apply(messages)
	}
	if len(messages) == 0 {
		return messages, statsWithMethod("empty")
	}

	inputTokens := CountMessageTokens(messages)
	if inputTokens < m.threshold {
		return messages, statsCounted("below-threshold", inputTokens, inputTokens)
	}

	out := make([]Message, 0, len(messages))
	var totalIn, totalOut int64
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
		totalIn += stats.InputTokens
		totalOut += stats.OutputTokens
		totalCost += stats.CostUSD
		methods[stats.Method] = struct{}{}
	}

	return out, aggregate(totalIn, totalOut, totalCost, methods)
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
