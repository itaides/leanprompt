package leanprompt

// Extract — weights-free heuristic extractive compression (parity-spec §8).
// All-integer scoring, pinned character classes, explicit tiebreaks.

import (
	"sort"
	"strings"
)

const (
	defaultRatioMillis = 500
	scoreScale         = 1000

	boostDigits     = 350
	boostEntity     = 200
	boostQuoted     = 200
	boostIdentifier = 300
	boostPosition   = 250
	boostImperative = 400
	penaltyFiller   = 400

	redundancyPct          = 60
	minSentenceChars       = 12
	minSentencesToCompress = 3
	minSpanTokens          = 40
	minASCIIPct            = 60
)

var structuralMarkers = []string{"```", "Traceback (most recent call last)"}

var abbreviations = map[string]struct{}{
	"mr": {}, "mrs": {}, "ms": {}, "dr": {}, "prof": {}, "sr": {}, "jr": {}, "st": {},
	"vs": {}, "etc": {}, "e.g": {}, "i.e": {}, "cf": {}, "al": {}, "approx": {},
	"no": {}, "fig": {}, "eq": {}, "sec": {}, "min": {}, "max": {}, "avg": {},
}

var fillerOpeners = []string{
	"basically", "essentially", "as mentioned", "as noted", "as discussed",
	"as you can see", "in other words", "needless to say",
	"it goes without saying", "to be honest", "in my opinion", "i think that",
	"it is worth noting", "it's worth noting", "obviously", "of course",
}

var prohibitionMarkers = []string{"do not", "don't", "must not", "never "}

var constraintMarkers = []string{
	"must ", "always", "only ", "except", "required", "important",
	"warning", "note:", "make sure", "be careful",
}

var anaphoricOpeners = map[string]struct{}{
	"this": {}, "that": {}, "these": {}, "those": {}, "it": {}, "they": {},
	"however": {}, "therefore": {}, "thus": {}, "so": {}, "consequently": {},
	"instead": {}, "otherwise": {}, "also": {}, "additionally": {}, "hence": {},
}

var stopwords = map[string]struct{}{
	"a": {}, "an": {}, "the": {}, "and": {}, "or": {}, "but": {}, "if": {}, "then": {},
	"else": {}, "when": {}, "at": {}, "by": {}, "for": {}, "with": {}, "about": {},
	"against": {}, "between": {}, "into": {}, "through": {}, "during": {}, "before": {},
	"after": {}, "above": {}, "below": {}, "to": {}, "from": {}, "up": {}, "down": {},
	"in": {}, "out": {}, "on": {}, "off": {}, "over": {}, "under": {}, "again": {},
	"further": {}, "once": {}, "here": {}, "there": {}, "all": {}, "any": {}, "both": {},
	"each": {}, "few": {}, "more": {}, "most": {}, "other": {}, "some": {}, "such": {},
	"only": {}, "own": {}, "same": {}, "so": {}, "than": {}, "too": {}, "very": {},
	"can": {}, "will": {}, "just": {}, "should": {}, "now": {}, "is": {}, "are": {},
	"was": {}, "were": {}, "be": {}, "been": {}, "being": {}, "have": {}, "has": {},
	"had": {}, "having": {}, "do": {}, "does": {}, "did": {}, "doing": {}, "would": {},
	"could": {}, "ought": {}, "i": {}, "you": {}, "he": {}, "she": {}, "it": {},
	"we": {}, "they": {}, "them": {}, "his": {}, "her": {}, "its": {}, "our": {},
	"their": {}, "this": {}, "that": {}, "these": {}, "those": {}, "am": {},
	"of": {}, "as": {}, "not": {}, "no": {}, "nor": {}, "what": {}, "which": {},
	"who": {}, "whom": {},
}

// Extract is the block-aware, weights-free extractive compressor.
type Extract struct {
	// RatioMillis is the keep-ratio in integer thousandths (500 = keep half).
	RatioMillis int64
}

func NewExtract(ratioMillis int64) *Extract {
	if ratioMillis <= 0 || ratioMillis > 1000 {
		panic("Extract ratioMillis must be in (0, 1000]")
	}
	return &Extract{RatioMillis: ratioMillis}
}

func (e *Extract) Name() string { return "extract" }

func (e *Extract) Compress(messages []Message) ([]Message, CompressionStats) {
	anyText := false
	for _, m := range messages {
		if strings.TrimSpace(GetTextContent(m)) != "" {
			anyText = true
			break
		}
	}
	if len(messages) == 0 || !anyText {
		return messages, statsWithMethod("extract")
	}

	out := make([]Message, 0, len(messages))
	var totalIn, totalOut int64
	for _, msg := range messages {
		newMsg, in, o := e.compressMessage(msg)
		out = append(out, newMsg)
		totalIn += in
		totalOut += o
	}
	return out, statsCounted("extract", totalIn, totalOut)
}

func cloneWith(obj map[string]any, key string, value any) map[string]any {
	out := make(map[string]any, len(obj)+1)
	for k, v := range obj {
		out[k] = v
	}
	out[key] = value
	return out
}

func (e *Extract) compressMessage(msg Message) (Message, int64, int64) {
	switch content := msg["content"].(type) {
	case string:
		if strings.TrimSpace(content) == "" {
			return msg, 0, 0
		}
		compressed, in, out := e.compressText(content)
		return cloneWith(msg, "content", compressed), in, out
	case []any:
		newBlocks := make([]any, 0, len(content))
		var totalIn, totalOut int64
		for _, block := range content {
			nb, in, out := e.compressBlock(block)
			newBlocks = append(newBlocks, nb)
			totalIn += in
			totalOut += out
		}
		return cloneWith(msg, "content", newBlocks), totalIn, totalOut
	}
	return msg, 0, 0
}

func (e *Extract) compressBlock(block any) (any, int64, int64) {
	b, ok := block.(map[string]any)
	if !ok {
		return block, 0, 0
	}
	switch strField(b, "type") {
	case "text":
		text := strField(b, "text")
		if strings.TrimSpace(text) != "" {
			compressed, in, out := e.compressText(text)
			return cloneWith(b, "text", compressed), in, out
		}
		return block, 0, 0
	case "tool_result":
		switch inner := b["content"].(type) {
		case string:
			if strings.TrimSpace(inner) == "" {
				return block, 0, 0
			}
			// Structural output must reach the model verbatim.
			if looksStructural(inner) {
				tokens := CountTokens(inner)
				return block, tokens, tokens
			}
			compressed, in, out := e.compressText(inner)
			return cloneWith(b, "content", compressed), in, out
		case []any:
			newInner := make([]any, 0, len(inner))
			var totalIn, totalOut int64
			for _, item := range inner {
				nb, in, out := e.compressBlock(item)
				newInner = append(newInner, nb)
				totalIn += in
				totalOut += out
			}
			return cloneWith(b, "content", newInner), totalIn, totalOut
		}
		return block, 0, 0
	}
	// Pass-through block types: token-count so ratios stay honest.
	text := extractText([]any{block})
	var tokens int64
	if text != "" {
		tokens = CountTokens(text)
	}
	return block, tokens, tokens
}

func (e *Extract) compressText(text string) (string, int64, int64) {
	inTok := CountTokens(text)
	if looksStructural(text) || inTok < minSpanTokens || !mostlyASCII(text) {
		return text, inTok, inTok
	}
	sentences := segmentSentences(text)
	if len(sentences) < minSentencesToCompress {
		return text, inTok, inTok
	}
	compressed := selectSentences(sentences, e.RatioMillis)
	outTok := CountTokens(compressed)
	if outTok >= inTok {
		return text, inTok, inTok
	}
	return compressed, inTok, outTok
}

// ------------------------------------------------------------------------ //
// Pure helpers
// ------------------------------------------------------------------------ //

func looksStructural(text string) bool {
	for _, m := range structuralMarkers {
		if strings.Contains(text, m) {
			return true
		}
	}
	return false
}

func mostlyASCII(text string) bool {
	ascii, total := 0, 0
	for _, c := range text {
		total++
		if c < 0x80 {
			ascii++
		}
	}
	return total == 0 || ascii*100 >= total*minASCIIPct
}

type sentence struct {
	text     string
	listItem bool
}

func segmentSentences(text string) []sentence {
	var out []sentence
	for _, rawLine := range strings.Split(text, "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" {
			continue
		}
		if isListLine(line) {
			out = append(out, sentence{text: line, listItem: true})
			continue
		}
		chars := []rune(line)
		if len(chars) <= minSentenceChars {
			out = append(out, sentence{text: line})
			continue
		}
		start := 0
		for i := 0; i+1 < len(chars); i++ {
			ch := chars[i]
			if ch != '.' && ch != '!' && ch != '?' {
				continue
			}
			next := chars[i+1]
			if next != ' ' && next != '\t' {
				continue // decimal, URL, file.ext
			}
			if ch == '.' {
				prev := lastWordBefore(chars, i)
				if _, abbr := abbreviations[asciiLower(prev)]; abbr {
					continue
				}
				pc := []rune(prev)
				if len(pc) == 1 && pc[0] >= 'A' && pc[0] <= 'Z' {
					continue // initials ("J. Smith")
				}
			}
			piece := strings.TrimSpace(string(chars[start : i+1]))
			if piece != "" {
				out = append(out, sentence{text: piece})
			}
			start = i + 1
		}
		rest := strings.TrimSpace(string(chars[start:]))
		if rest != "" {
			out = append(out, sentence{text: rest})
		}
	}
	return out
}

func isListLine(line string) bool {
	if strings.HasPrefix(line, "|") {
		return true
	}
	chars := []rune(line)
	if (strings.HasPrefix(line, "- ") || strings.HasPrefix(line, "* ") ||
		strings.HasPrefix(line, "+ ")) && len(chars) > 2 {
		return true
	}
	i := 0
	for i < len(chars) && chars[i] >= '0' && chars[i] <= '9' {
		i++
	}
	if i > 0 && i+1 < len(chars) {
		mark := chars[i]
		if (mark == '.' || mark == ')') && chars[i+1] == ' ' {
			return true
		}
	}
	return false
}

func lastWordBefore(chars []rune, dotIndex int) string {
	start := dotIndex
	for start > 0 {
		c := chars[start-1]
		if isWordChar(c) || c == '.' {
			start--
		} else {
			break
		}
	}
	word := string(chars[start:dotIndex])
	return strings.TrimLeft(word, ".")
}

// wordTokens: ASCII-lowercased runs of isWordChar code points.
func wordTokens(text string) []string {
	var out []string
	var run []rune
	for _, c := range asciiLower(text) {
		if isWordChar(c) {
			run = append(run, c)
		} else if len(run) > 0 {
			out = append(out, string(run))
			run = nil
		}
	}
	if len(run) > 0 {
		out = append(out, string(run))
	}
	return out
}

// bitLength of a non-negative integer (0 → 0).
func bitLength(n int64) int64 {
	var bits int64
	for n > 0 {
		bits++
		n /= 2
	}
	return bits
}

type scoredSentence struct {
	index       int
	text        string
	listItem    bool
	tokens      int64
	score       int64
	anaphoric   bool
	digitTokens []string
}

func selectSentences(sentences []sentence, ratioMillis int64) string {
	termCounts := make(map[string]int64)
	var totalTerms int64
	tokenized := make([][]string, len(sentences))
	for i, s := range sentences {
		words := wordTokens(s.text)
		tokenized[i] = words
		for _, w := range words {
			if _, stop := stopwords[w]; stop {
				continue
			}
			termCounts[w]++
			totalTerms++
		}
	}

	scored := make([]scoredSentence, len(sentences))
	for i, s := range sentences {
		words := tokenized[i]
		anaphoric := false
		if len(words) > 0 {
			_, anaphoric = anaphoricOpeners[words[0]]
		}
		var digitTokens []string
		for _, w := range words {
			if strings.ContainsAny(w, "0123456789") {
				digitTokens = append(digitTokens, w)
			}
		}
		scored[i] = scoredSentence{
			index:       i,
			text:        s.text,
			listItem:    s.listItem,
			tokens:      CountTokens(s.text),
			score:       scoreSentence(s.text, words, i, len(sentences), termCounts, totalTerms),
			anaphoric:   anaphoric,
			digitTokens: digitTokens,
		}
	}

	var totalTokens int64
	for _, s := range scored {
		totalTokens += s.tokens
	}

	// Rank by (score desc, index asc) — stable sort, explicit tiebreak.
	ranked := make([]int, len(scored))
	for i := range ranked {
		ranked[i] = i
	}
	sort.SliceStable(ranked, func(a, b int) bool {
		sa, sb := scored[ranked[a]], scored[ranked[b]]
		if sa.score != sb.score {
			return sa.score > sb.score
		}
		return sa.index < sb.index
	})

	kept := make([]bool, len(scored))
	var keptTokens int64

	// Prohibitions are kept unconditionally, charged to the budget up front.
	for _, s := range scored {
		lower := asciiLower(s.text)
		for _, m := range prohibitionMarkers {
			if strings.Contains(lower, m) {
				kept[s.index] = true
				keptTokens += s.tokens
				break
			}
		}
	}

	for _, ri := range ranked {
		if keptTokens*1000 >= ratioMillis*totalTokens {
			break
		}
		cand := &scored[ri]
		if kept[cand.index] {
			continue
		}
		if isRedundant(cand, scored, kept) {
			continue
		}
		kept[cand.index] = true
		keptTokens += cand.tokens

		// Anaphora rule: pull the predecessor in with its dependent.
		if cand.anaphoric && cand.index > 0 && !kept[cand.index-1] {
			kept[cand.index-1] = true
			keptTokens += scored[cand.index-1].tokens
		}
	}

	anyKept := false
	for _, k := range kept {
		if k {
			anyKept = true
			break
		}
	}
	if !anyKept && len(ranked) > 0 {
		kept[scored[ranked[0]].index] = true
	}

	var parts []string
	for _, s := range scored {
		if kept[s.index] {
			parts = append(parts, s.text)
		}
	}
	return strings.Join(parts, " ")
}

func scoreSentence(
	text string,
	words []string,
	index, sentenceCount int,
	termCounts map[string]int64,
	totalTerms int64,
) int64 {
	if len(words) == 0 {
		return 0
	}
	var info int64
	for _, w := range words {
		if _, stop := stopwords[w]; stop {
			continue
		}
		count := termCounts[w]
		if count == 0 {
			count = 1
		}
		tt := totalTerms
		if tt < 1 {
			tt = 1
		}
		info += bitLength(tt / count)
	}
	score := info * scoreScale / int64(len(words))

	lower := asciiLower(text)

	if strings.ContainsAny(text, "0123456789") {
		score += boostDigits
	}
	if hasNonInitialCapitalizedWord(text) {
		score += boostEntity
	}
	if hasQuotedSpan(text) {
		score += boostQuoted
	}
	if hasIdentifierToken(text) {
		score += boostIdentifier
	}
	if index == 0 || index == sentenceCount-1 {
		score += boostPosition
	}
	for _, m := range constraintMarkers {
		if strings.Contains(lower, m) {
			score += boostImperative
			break
		}
	}
	for _, f := range fillerOpeners {
		if strings.HasPrefix(lower, f) {
			score -= penaltyFiller
			break
		}
	}
	return score
}

func hasNonInitialCapitalizedWord(text string) bool {
	chars := []rune(text)
	wordStart := true
	firstWord := true
	inWord := false
	for i := 0; i < len(chars); i++ {
		c := chars[i]
		isAlpha := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
		if isAlpha && !inWord {
			if !firstWord && wordStart && c >= 'A' && c <= 'Z' {
				if i+1 < len(chars) && chars[i+1] >= 'a' && chars[i+1] <= 'z' {
					return true
				}
			}
			inWord = true
		} else if !isAlpha && inWord {
			inWord = false
			firstWord = false
			wordStart = c == ' ' || c == '\t'
			continue
		}
		if !isAlpha {
			wordStart = c == ' ' || c == '\t'
		}
	}
	return false
}

func hasQuotedSpan(text string) bool {
	chars := []rune(text)
	for _, q := range []rune{'"', '\'', '`'} {
		first := -1
		for i, c := range chars {
			if c == q {
				first = i
				break
			}
		}
		if first == -1 {
			continue
		}
		for j := first + 1; j < len(chars); j++ {
			if chars[j] == q {
				if j-first > 3 {
					return true
				}
				break
			}
		}
	}
	return false
}

func hasIdentifierToken(text string) bool {
	chars := []rune(text)
	isAlnum := func(c rune) bool {
		return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
	}
	for i := 1; i+1 < len(chars); i++ {
		c := chars[i]
		if (c == '_' || c == '/' || c == '-' || c == '.') &&
			isAlnum(chars[i-1]) && isAlnum(chars[i+1]) {
			return true
		}
	}
	return false
}

func shingleSet(words []string) map[string]struct{} {
	out := make(map[string]struct{})
	if len(words) < 3 {
		if len(words) > 0 {
			out[strings.Join(words, " ")] = struct{}{}
		}
		return out
	}
	for i := 0; i+3 <= len(words); i++ {
		out[words[i]+" "+words[i+1]+" "+words[i+2]] = struct{}{}
	}
	return out
}

func isRedundant(cand *scoredSentence, scored []scoredSentence, kept []bool) bool {
	// List items read as near-duplicates of siblings but carry distinct
	// content — never drop as redundant.
	if cand.listItem {
		return false
	}
	anyKept := false
	for _, k := range kept {
		if k {
			anyKept = true
			break
		}
	}
	if !anyKept {
		return false
	}
	candShingles := shingleSet(wordTokens(cand.text))
	if len(candShingles) == 0 {
		return false
	}
	for i := range scored {
		if !kept[scored[i].index] {
			continue
		}
		k := &scored[i]
		ks := shingleSet(wordTokens(k.text))
		var intersection int64
		for s := range candShingles {
			if _, hit := ks[s]; hit {
				intersection++
			}
		}
		union := int64(len(candShingles)) + int64(len(ks)) - intersection
		if union > 0 && intersection*100 > redundancyPct*union {
			// Digit-diff guard: numeric twins are all signal.
			if !sameDigitTokens(cand.digitTokens, k.digitTokens) {
				continue
			}
			return true
		}
	}
	return false
}

func sameDigitTokens(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	sa := append([]string(nil), a...)
	sb := append([]string(nil), b...)
	sort.Strings(sa)
	sort.Strings(sb)
	for i := range sa {
		if sa[i] != sb[i] {
			return false
		}
	}
	return true
}
