package leanprompt

// CompressionStats — telemetry shape shared by every compression call.
type CompressionStats struct {
	InputTokens  int64
	OutputTokens int64
	// Ratio is a derived float — recomputed per language, never byte-compared.
	Ratio   float64
	Method  string
	CostUSD float64
}

func statsWithMethod(method string) CompressionStats {
	return CompressionStats{Ratio: 1.0, Method: method}
}

func statsCounted(method string, input, output int64) CompressionStats {
	ratio := 1.0
	if input > 0 {
		ratio = float64(output) / float64(input)
	}
	return CompressionStats{
		InputTokens:  input,
		OutputTokens: output,
		Ratio:        ratio,
		Method:       method,
	}
}
