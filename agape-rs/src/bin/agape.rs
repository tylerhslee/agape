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

    match agape_rs::process(&source) {
        Ok(spine) => {
            println!("accepted ({} spine events)", spine.len());
            if cmd == "run" {
                for ev in &spine.log {
                    println!("  [{}] {}", ev.tick, ev.etype);
                }
            }
        }
        Err(e) => {
            eprintln!("{}", e);
            exit(1);
        }
    }
}
