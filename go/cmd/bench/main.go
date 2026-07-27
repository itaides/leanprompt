// Command bench is used by bench/run-cross-language.ts to exercise the Go
// Middleware against a shared corpus and print its result as JSON on
// stdout, so it can be diffed against the TypeScript and Rust outputs.
//
// Usage:
//
//	bench <corpus.json> --mode on --routing prose=extract \
//	      --ratio-millis 500 --threshold 10 --protect-last-turns 0
//
// Prints: {"inputTokens":N,"outputTokens":N,"method":"...","messages":[...]}
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"

	leanprompt "github.com/itaides/leanprompt/go"
)

func main() {
	os.Exit(run())
}

func run() int {
	args := os.Args[1:]
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "usage: bench <corpus.json> [--mode on] [--routing k=v]... [--ratio-millis N] [--threshold N] [--protect-last-turns N]")
		return 2
	}

	corpusPath := args[0]
	data, err := os.ReadFile(corpusPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot read %s: %v\n", corpusPath, err)
		return 2
	}
	var messages []leanprompt.Message
	if err := json.Unmarshal(data, &messages); err != nil {
		fmt.Fprintf(os.Stderr, "cannot parse %s: %v\n", corpusPath, err)
		return 2
	}

	config := leanprompt.Config{Mode: "off", Routing: map[string]string{}}
	for i := 1; i < len(args); {
		switch args[i] {
		case "--mode":
			config.Mode = args[i+1]
			i += 2
		case "--routing":
			k, v, _ := strings.Cut(args[i+1], "=")
			config.Routing[k] = v
			i += 2
		case "--ratio-millis":
			n, _ := strconv.ParseInt(args[i+1], 10, 64)
			config.ExtractRatioMillis = n
			i += 2
		case "--threshold":
			n, _ := strconv.ParseInt(args[i+1], 10, 64)
			config.ThresholdTokens = n
			i += 2
		case "--protect-last-turns":
			n, _ := strconv.Atoi(args[i+1])
			config.ProtectLastTurns = n
			i += 2
		default:
			fmt.Fprintf(os.Stderr, "unknown flag %s\n", args[i])
			return 2
		}
	}

	mw := leanprompt.NewMiddleware(config)
	compressed, stats := mw.CompressMessages(messages)

	out, err := json.Marshal(map[string]any{
		"inputTokens":  stats.InputTokens,
		"outputTokens": stats.OutputTokens,
		"method":       stats.Method,
		"messages":     compressed,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot marshal output: %v\n", err)
		return 2
	}
	fmt.Println(string(out))
	return 0
}
