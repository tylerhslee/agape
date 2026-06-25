//! The conformance scoreboard.
//!
//!     cargo run --bin conformance                      # default: ../agape-conformance/tests at v1.0
//!     cargo run --bin conformance -- <tests_dir> <ver> # e.g. ... ../agape-conformance/tests 0.3
//!     cargo run --bin conformance -- --fails           # only list failing tests
//!
//! Exits with the number of failing tests (0 = conformant at this version).

use std::collections::BTreeMap;
use std::path::PathBuf;

use agape_rs::conformance::{self, Status};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let only_fails = args.iter().any(|a| a == "--fails");
    let positional: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();

    let dir = positional
        .first()
        .map(|s| PathBuf::from(s.as_str()))
        .unwrap_or_else(|| PathBuf::from("../agape-conformance/tests"));
    let version = positional
        .get(1)
        .map(|s| conformance::parse_version(s))
        .unwrap_or((1, 0));

    if !dir.exists() {
        eprintln!("conformance: tests dir not found: {}", dir.display());
        std::process::exit(2);
    }

    let report = conformance::run(&dir, version);

    // Per-section tallies.
    let mut by_section: BTreeMap<String, (usize, usize, usize, usize)> = BTreeMap::new();
    for o in &report.outcomes {
        let e = by_section.entry(o.section.clone()).or_default();
        match o.status {
            Status::Pass => e.0 += 1,
            Status::Fail(_) => e.1 += 1,
            Status::Blocked => e.2 += 1,
            Status::SkippedNewer | Status::SkippedSuperseded => e.3 += 1,
        }
    }

    println!(
        "\nAgape conformance @ v{}.{}   ({} tests total)\n",
        version.0,
        version.1,
        report.outcomes.len()
    );

    if !only_fails {
        println!("  {:<22} {:>4} {:>4} {:>4} {:>5}", "section", "pass", "fail", "blk", "skip");
        println!("  {}", "-".repeat(44));
        for (sec, (p, f, b, s)) in &by_section {
            println!("  {:<22} {:>4} {:>4} {:>4} {:>5}", sec, p, f, b, s);
        }
        println!("  {}", "-".repeat(44));
    }

    // Failures detail.
    let fails: Vec<_> = report
        .outcomes
        .iter()
        .filter_map(|o| match &o.status {
            Status::Fail(why) => Some((o.id.as_str(), o.section.as_str(), why.as_str())),
            _ => None,
        })
        .collect();
    if !fails.is_empty() {
        let show = if only_fails { fails.len() } else { fails.len().min(25) };
        println!("\n  failing ({} shown of {}):", show, fails.len());
        for (id, sec, why) in fails.iter().take(show) {
            println!("    ✗ {:<14} {:<40} {}", sec, id, why);
        }
    }

    println!(
        "\n  {} pass · {} fail · {} blocked · {} skipped   ({}/{} applicable)\n",
        report.passed(),
        report.failed(),
        report.blocked(),
        report.skipped(),
        report.passed(),
        report.applicable(),
    );

    std::process::exit(report.failed().min(125) as i32);
}
