//! The `agape` CLI — check or run a single `.ag` file.
//!
//!     cargo run --bin agape -- check <file.ag>
//!     cargo run --bin agape -- run   <file.ag>
//!
//! Thin wrapper over `agape_rs::process`; grows as the pipeline does.

use std::process::exit;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (cmd, file) = match (args.first(), args.get(1)) {
        (Some(c), Some(f)) => (c.as_str(), f.as_str()),
        _ => {
            eprintln!("usage: agape <check|run> <file.ag>");
            exit(2);
        }
    };

    let source = match std::fs::read_to_string(file) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("agape: cannot read {}: {}", file, e);
            exit(2);
        }
    };

    match cmd {
        "check" => match agape_rs::process(&source) {
            Ok(spine) => println!("ok — checks pass ({} spine events on a dry run)", spine.len()),
            Err(e) => {
                eprintln!("{e}");
                exit(1);
            }
        },
        "run" => match agape_rs::process(&source) {
            Ok(spine) => {
                for ev in &spine.log {
                    let subj = ev.subject.as_deref().map(|s| format!(" {s}")).unwrap_or_default();
                    let payload = if ev.payload.is_empty() || ev.payload == "sent" || ev.payload == "delivered" {
                        String::new()
                    } else {
                        format!("  {}", ev.payload)
                    };
                    println!("  [{:>3}] {:<20}{subj}{payload}", ev.tick, ev.etype);
                }
                println!("\n{} events · chain-head {}", spine.len(), &spine.chain_head_hex()[..16]);
            }
            Err(e) => {
                eprintln!("{e}");
                exit(1);
            }
        },
        other => {
            eprintln!("agape: unknown command {other:?} (expected `check` or `run`)");
            exit(2);
        }
    }
}
