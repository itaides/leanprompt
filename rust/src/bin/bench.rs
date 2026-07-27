//! bench — minimal CLI used by bench/run-cross-language.ts to exercise the
//! Rust Middleware against a shared corpus and print its result as JSON on
//! stdout, so it can be diffed against the TypeScript and Go outputs.
//!
//! Usage:
//!   bench <corpus.json> --mode on --routing prose=extract \
//!         --ratio-millis 500 --threshold 10 --protect-last-turns 0
//!
//! Prints: {"inputTokens":N,"outputTokens":N,"method":"...","messages":[...]}

use std::env;
use std::fs;
use std::process::ExitCode;

use leanprompt::json::{self, Value};
use leanprompt::{Config, Middleware};

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: bench <corpus.json> [--mode on] [--routing k=v]... [--ratio-millis N] [--threshold N] [--protect-last-turns N]");
        return ExitCode::from(2);
    }

    let corpus_path = &args[1];
    let text = match fs::read_to_string(corpus_path) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("cannot read {corpus_path}: {e}");
            return ExitCode::from(2);
        }
    };
    let messages = match json::parse(&text) {
        Ok(Value::Arr(items)) => items,
        Ok(_) => {
            eprintln!("{corpus_path} must contain a JSON array of messages");
            return ExitCode::from(2);
        }
        Err(e) => {
            eprintln!("cannot parse {corpus_path}: {e}");
            return ExitCode::from(2);
        }
    };

    let mut config = Config { mode: "off".into(), ..Config::default() };
    let mut i = 2;
    while i < args.len() {
        match args[i].as_str() {
            "--mode" => {
                config.mode = args[i + 1].clone();
                i += 2;
            }
            "--routing" => {
                let (k, v) = args[i + 1].split_once('=').unwrap_or((&args[i + 1], ""));
                config.routing.push((k.to_string(), v.to_string()));
                i += 2;
            }
            "--ratio-millis" => {
                config.extract_ratio_millis = args[i + 1].parse().unwrap_or(500);
                i += 2;
            }
            "--threshold" => {
                config.threshold_tokens = args[i + 1].parse().unwrap_or(2000);
                i += 2;
            }
            "--protect-last-turns" => {
                config.protect_last_turns = args[i + 1].parse().unwrap_or(2);
                i += 2;
            }
            other => {
                eprintln!("unknown flag {other}");
                return ExitCode::from(2);
            }
        }
    }

    let mw = Middleware::new(config);
    let (compressed, stats) = mw.compress_messages(&messages);

    let output = Value::Obj(vec![
        ("inputTokens".into(), Value::Num(stats.input_tokens as f64)),
        ("outputTokens".into(), Value::Num(stats.output_tokens as f64)),
        ("method".into(), Value::Str(stats.method)),
        ("messages".into(), Value::Arr(compressed)),
    ]);
    println!("{}", json::canonical(&output));
    ExitCode::SUCCESS
}
