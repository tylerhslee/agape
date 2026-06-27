//! The `agape` CLI — the user-facing entry point.
//!
//!     agape init [name]                         scaffold a new project
//!     agape run   <file.ag> [--prompt k=v ...]  run a program to a spine
//!     agape check <file.ag>                     static checks only
//!     agape studio                              open Agape Studio for this project
//!
//! `run`/`check` are thin wrappers over `agape_rs::process`; `init` scaffolds a
//! two-agent starter; `studio` launches the project-scoped studio.

use std::path::{Path, PathBuf};
use std::process::{exit, Command};

use agape_rs::HarnessConfig;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or("");
    let rest = if args.is_empty() { &[][..] } else { &args[1..] };
    match cmd {
        "run" => cmd_run(rest),
        "check" => cmd_check(rest),
        "init" => cmd_init(rest),
        "studio" => cmd_studio(rest),
        "" | "-h" | "--help" | "help" => usage(),
        other => {
            eprintln!("agape: unknown command {other:?}\n");
            usage();
            exit(2);
        }
    }
}

fn usage() {
    eprintln!(
        "agape — a language for the cognitive layer of multi-agent systems\n\n\
         USAGE:\n  \
         agape init [name]                         scaffold a new project\n  \
         agape run   <file.ag> [--prompt k=v ...]  run a program; feed `prompt` sensors with --prompt\n  \
         agape check <file.ag>                     static checks only (no run)\n  \
         agape studio                              open Agape Studio for the current project"
    );
}

// ── run / check ─────────────────────────────────────────────────────────────

fn read_or_die(file: &str) -> String {
    std::fs::read_to_string(file).unwrap_or_else(|e| {
        eprintln!("agape: cannot read {file}: {e}");
        exit(2);
    })
}

fn cmd_check(args: &[String]) {
    let file = args.first().unwrap_or_else(|| {
        eprintln!("usage: agape check <file.ag>");
        exit(2);
    });
    match agape_rs::process(&read_or_die(file)) {
        Ok(spine) => println!("ok — checks pass ({} spine events on a dry run)", spine.len()),
        Err(e) => {
            eprintln!("{e}");
            exit(1);
        }
    }
}

fn cmd_run(args: &[String]) {
    let mut file: Option<String> = None;
    let mut config = HarnessConfig::default();
    let mut json = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--json" => json = true,
            // Route the `<-` seam to a live provider (the studio agent-server) instead
            // of the deterministic mock. `--claude` is shorthand for the local studio.
            "--claude" => config.provider_url = Some("127.0.0.1:8799".to_string()),
            "--provider" => {
                i += 1;
                config.provider_url = Some(args.get(i).cloned().unwrap_or_else(|| {
                    eprintln!("agape: --provider needs host:port");
                    exit(2);
                }));
            }
            "--samples" => {
                i += 1;
                config.samples = args.get(i).and_then(|s| s.parse().ok()).unwrap_or_else(|| {
                    eprintln!("agape: --samples needs a number");
                    exit(2);
                });
            }
            "--prompt" | "-p" => {
                i += 1;
                let kv = args.get(i).unwrap_or_else(|| {
                    eprintln!("agape: --prompt needs name=value");
                    exit(2);
                });
                match kv.split_once('=') {
                    Some((k, v)) => config.prompt_inputs.push((k.trim().to_string(), v.to_string())),
                    None => {
                        eprintln!("agape: --prompt expects name=value, got {kv:?}");
                        exit(2);
                    }
                }
            }
            f if file.is_none() => file = Some(f.to_string()),
            f => {
                eprintln!("agape: unexpected argument {f:?}");
                exit(2);
            }
        }
        i += 1;
    }
    let Some(file) = file else {
        eprintln!("usage: agape run <file.ag> [--prompt name=value ...]");
        exit(2);
    };
    match agape_rs::process_with_config(&read_or_die(&file), &config) {
        Ok(spine) if json => print!("{}", spine_json(&spine)),
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
        Err(e) if json => {
            print!("{{\"ok\":false,\"error\":{},\"class\":{}}}", json_str(&e.message), json_str(&e.class.to_string()));
            exit(1);
        }
        Err(e) => {
            eprintln!("{e}");
            exit(1);
        }
    }
}

/// The run result as JSON (for the studio): `{ ok, head, events: [{tick,etype,subject,payload}] }`.
fn spine_json(spine: &agape_rs::spine::Spine) -> String {
    let events: Vec<String> = spine
        .log
        .iter()
        .map(|e| {
            format!(
                "{{\"tick\":{},\"etype\":{},\"subject\":{},\"payload\":{},\"corr\":{}}}",
                e.tick,
                json_str(&e.etype),
                e.subject.as_deref().map(json_str).unwrap_or_else(|| "null".into()),
                json_str(&e.payload),
                e.corr.map(|c| c.to_string()).unwrap_or_else(|| "null".into())
            )
        })
        .collect();
    format!("{{\"ok\":true,\"head\":{},\"events\":[{}]}}", json_str(&spine.chain_head_hex()), events.join(","))
}

/// Minimal JSON string escaping (no serde — agape-rs has zero deps).
fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

// ── init ─────────────────────────────────────────────────────────────────────

fn cmd_init(args: &[String]) {
    let name = args.first().map(String::as_str).unwrap_or("");
    let (root, label) = if name.is_empty() || name == "." {
        (std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")), "current directory".to_string())
    } else {
        (PathBuf::from(name), format!("./{name}"))
    };
    let proj = if name.is_empty() || name == "." {
        root.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "agape-project".into())
    } else {
        name.to_string()
    };

    if let Err(e) = std::fs::create_dir_all(&root) {
        eprintln!("agape: cannot create {}: {e}", root.display());
        exit(1);
    }
    write_new(&root.join("main.ag"), &MAIN_AG);
    write_new(&root.join("agape.toml"), &agape_toml(&proj));
    write_new(&root.join("README.md"), &readme(&proj));

    println!("✓ scaffolded an Agape project in {label}\n");
    println!("  next:");
    if !(name.is_empty() || name == ".") {
        println!("    cd {name}");
    }
    println!("    agape run main.ag --prompt question=\"is the earth round?\"");
    println!("    agape studio");
}

/// Write a file only if it does not exist, so `init` never clobbers user work.
fn write_new(path: &Path, contents: &str) {
    if path.exists() {
        println!("  · kept existing {}", path.display());
        return;
    }
    match std::fs::write(path, contents) {
        Ok(()) => println!("  + {}", path.display()),
        Err(e) => eprintln!("  ! could not write {}: {e}", path.display()),
    }
}

// ── studio ────────────────────────────────────────────────────────────────────

fn cmd_studio(_args: &[String]) {
    let project = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if !project.join("agape.toml").exists() {
        eprintln!("agape: no agape.toml here — run `agape init` first (cwd: {})", project.display());
        exit(1);
    }
    let Some(home) = studio_home() else {
        eprintln!(
            "agape: could not locate Agape Studio.\n\
             Set AGAPE_STUDIO_HOME to the `studio/` directory (the React app + agent-server)."
        );
        exit(1);
    };

    println!("Agape Studio — project {}", project.display());
    println!("  studio home: {}", home.display());

    // Launch the agent-server and the web dev server, scoped to this project via
    // AGAPE_PROJECT. (A packaged build would embed these; here we drive the source.)
    let agent = Command::new("npx")
        .args(["tsx", "server.ts"])
        .current_dir(home.join("agent-server"))
        .env("AGAPE_PROJECT", &project)
        .spawn();
    let web = Command::new("npm")
        .args(["run", "dev"])
        .current_dir(home.join("web"))
        .env("AGAPE_PROJECT", &project)
        .spawn();

    match (agent, web) {
        (Ok(_), Ok(_)) => {
            println!("  serving at http://localhost:5173  (Ctrl-C to stop)");
            open_browser("http://localhost:5173");
            // Keep the launcher alive so the child servers stay up.
            let _ = std::io::Read::read(&mut std::io::stdin(), &mut [0u8; 1]);
        }
        _ => eprintln!(
            "agape: could not start the studio servers — is Node installed and `studio/` built?\n\
             Start them manually:\n  \
             (cd {h}/agent-server && AGAPE_PROJECT={p} npx tsx server.ts)\n  \
             (cd {h}/web && AGAPE_PROJECT={p} npm run dev)",
            h = home.display(),
            p = project.display()
        ),
    }
}

/// Locate the studio source: `$AGAPE_STUDIO_HOME`, else walk up from cwd looking
/// for a `studio/` directory (works inside the agape repo / a checkout).
fn studio_home() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("AGAPE_STUDIO_HOME") {
        let p = PathBuf::from(p);
        if p.join("web").is_dir() {
            return Some(p);
        }
    }
    let mut dir = std::env::current_dir().ok()?;
    for _ in 0..12 {
        let s = dir.join("studio");
        if s.join("web").is_dir() && s.join("agent-server").is_dir() {
            return Some(s);
        }
        dir = dir.parent()?.to_path_buf();
    }
    None
}

fn open_browser(url: &str) {
    // Best-effort across WSL/Linux/macOS/Windows; ignore failures.
    for (bin, args) in [("explorer.exe", vec![url]), ("xdg-open", vec![url]), ("open", vec![url])] {
        if Command::new(bin).args(&args).spawn().is_ok() {
            return;
        }
    }
}

// ── scaffold templates ─────────────────────────────────────────────────────────

const MAIN_AG: &str = r#"// main.ag — a fact-checked Q&A system: two agents, one decision gate.
//
// Flow:  a user question arrives on the `question` sensor
//          -> Responder drafts an answer (the cognition seam, `<-`)
//          -> it emits a Draft, which FactChecker is subscribed to
//          -> FactChecker judges the draft and gates it (`endorse`)
//          -> only a *verified* answer is delivered back (`perform Reply`).
//
// Run it:    agape run main.ag --prompt question="is the earth round?"
// Inspect:   agape studio

prompt text question;          // the user-input sensor (external input lands here)

event  Draft(text answer);     // a drafted answer, awaiting fact-check
action Reply(text answer);     // the consequential act: deliver an answer to the user

// Agent 1 — drafts an answer to each incoming question.
agent Responder {
  when (Prompt p about question) {
    text answer = self <- f"answer the user's question concisely: {p}";
    emit Draft(answer);
  }
}

// Agent 2 — fact-checks every draft; only verified answers are delivered.
agent FactChecker grants { perform Reply } {
  when (Draft d) {
    Credence<bool> sound = self <- "is this answer factually correct and well-supported?";
    endorse (sound by confidence 0.8) {
      true:  perform Reply(d);                  // verified -> deliver to the user
      false: emit Event("rejected: not verified");
    } abstain {
      emit Event("uncertain: needs human review");
    }
  }
}

// Bring the system up: awaken the checker first so its subscription is live
// before the responder ever drafts an answer.
spawn FactChecker checker;
awake checker;
spawn Responder responder;
awake responder;
"#;

fn agape_toml(name: &str) -> String {
    format!(
        "[project]\n\
         name = \"{name}\"\n\
         entry = \"main.ag\"\n\n\
         [provider]\n\
         # Point this at a model connector for a live run. With no connector the\n\
         # runtime uses a deterministic mock judgment, so `agape run` is reproducible.\n\
         exposes_logprobs = true\n"
    )
}

fn readme(name: &str) -> String {
    format!(
        "# {name}\n\n\
         A fact-checked Q&A system built with Agape — two agents and one decision gate.\n\n\
         - **Responder** drafts an answer to each user question.\n\
         - **FactChecker** gates every draft; only verified answers are delivered back.\n\n\
         ## Run it\n\n\
         ```\n\
         agape run main.ag --prompt question=\"is the earth round?\"\n\
         ```\n\n\
         ## Open the studio\n\n\
         ```\n\
         agape studio\n\
         ```\n\n\
         Inspect the agents, edit their code, and run them from the browser.\n"
    )
}
