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
        "build" => cmd_build(rest),
        "init" => cmd_init(rest),
        "studio" => cmd_studio(rest),
        "configure" | "config" => cmd_configure(rest),
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
         agape build                               check every .ag in the project; emit .agape/build.json\n  \
         agape configure [key value]               show or set project config (provider/model/samples/temperature)\n  \
         agape studio                              open Agape Studio for the current project\n\n\
         run flags:  --claude  --samples N  --temperature T  --provider host:port  --json\n\
         project defaults come from agape.toml ([provider] backend/model, [runtime] samples/temperature); flags override."
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
    // Project defaults (agape.toml) seed the config; explicit flags below override.
    let mut config = HarnessConfig::default();
    if let Ok(cwd) = std::env::current_dir() {
        apply_project_config(&mut config, &load_project_config(&cwd));
    }
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
            "--temperature" => {
                i += 1;
                config.temperature = args.get(i).and_then(|s| s.parse().ok()).unwrap_or_else(|| {
                    eprintln!("agape: --temperature needs a number (0.0–1.0)");
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

// ── project config (agape.toml) ──────────────────────────────────────────────

#[derive(Default)]
struct ProjectConfig {
    provider: Option<String>, // "mock" | "claude"/"anthropic" | "host:port"
    model: Option<String>,
    samples: Option<u32>,
    temperature: Option<f64>,
}

/// Walk up from `start` to find the nearest `agape.toml`.
fn find_manifest(start: &Path) -> Option<PathBuf> {
    let mut dir = start.to_path_buf();
    for _ in 0..16 {
        let p = dir.join("agape.toml");
        if p.is_file() {
            return Some(p);
        }
        dir = dir.parent()?.to_path_buf();
    }
    None
}

/// Read the run-relevant keys from `agape.toml` ([provider] backend/model,
/// [runtime] samples/temperature). A deliberately minimal reader, not a TOML lib.
fn load_project_config(start: &Path) -> ProjectConfig {
    let mut c = ProjectConfig::default();
    let Some(path) = find_manifest(start) else { return c };
    let Ok(text) = std::fs::read_to_string(&path) else { return c };
    let mut section = String::new();
    for line in text.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with('#') {
            continue;
        }
        if let Some(s) = l.strip_prefix('[').and_then(|x| x.strip_suffix(']')) {
            section = s.trim().to_string();
            continue;
        }
        let Some((k, v)) = l.split_once('=') else { continue };
        let (k, v) = (k.trim(), v.trim().trim_matches('"').trim());
        match (section.as_str(), k) {
            ("provider", "backend") => c.provider = Some(v.to_string()),
            ("provider", "model") => c.model = Some(v.to_string()),
            ("runtime", "samples") => c.samples = v.parse().ok(),
            ("runtime", "temperature") => c.temperature = v.parse().ok(),
            _ => {}
        }
    }
    c
}

/// Seed a `HarnessConfig` from project config (CLI flags override afterward).
fn apply_project_config(cfg: &mut HarnessConfig, pc: &ProjectConfig) {
    if let Some(p) = &pc.provider {
        if p == "claude" || p == "anthropic" {
            cfg.provider_url = Some("127.0.0.1:8799".to_string());
        } else if p.contains(':') {
            cfg.provider_url = Some(p.clone());
        }
        // "mock" (or anything else) → leave the deterministic mock.
    }
    if let Some(s) = pc.samples {
        cfg.samples = s;
    }
    if let Some(t) = pc.temperature {
        cfg.temperature = t;
    }
}

// ── build ─────────────────────────────────────────────────────────────────────

fn cmd_build(_args: &[String]) {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let root = find_manifest(&cwd).and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or(cwd);
    let mut files = Vec::new();
    collect_ag(&root, &mut files);
    files.sort();
    if files.is_empty() {
        eprintln!("agape build: no .ag files under {}", root.display());
        exit(1);
    }
    println!("building {} ({} file{})", root.display(), files.len(), if files.len() == 1 { "" } else { "s" });
    let mut entries = Vec::new();
    let mut ok = 0;
    for f in &files {
        let rel = f.strip_prefix(&root).unwrap_or(f).to_string_lossy().replace('\\', "/");
        match agape_rs::process(&read_or_die(&f.to_string_lossy())) {
            Ok(_) => {
                ok += 1;
                println!("  ✓ {rel}");
                entries.push(format!("{{\"file\":{},\"ok\":true}}", json_str(&rel)));
            }
            Err(e) => {
                println!("  ✗ {rel} — {e}");
                entries.push(format!("{{\"file\":{},\"ok\":false,\"error\":{},\"class\":{}}}", json_str(&rel), json_str(&e.message), json_str(&e.class.to_string())));
            }
        }
    }
    let all_ok = ok == files.len();
    let out_dir = root.join(".agape");
    let _ = std::fs::create_dir_all(&out_dir);
    let manifest = format!("{{\"ok\":{all_ok},\"passed\":{ok},\"total\":{},\"files\":[{}]}}", files.len(), entries.join(","));
    let _ = std::fs::write(out_dir.join("build.json"), &manifest);
    println!("\n{}/{} ok · wrote {}", ok, files.len(), out_dir.join("build.json").display());
    if !all_ok {
        exit(1);
    }
}

/// Collect `.ag` files under `dir`, skipping build/dep output directories.
fn collect_ag(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if matches!(name, ".agape" | "target" | "node_modules" | ".git" | "dist") {
                continue;
            }
            collect_ag(&p, out);
        } else if p.extension().and_then(|s| s.to_str()) == Some("ag") {
            out.push(p);
        }
    }
}

// ── configure ───────────────────────────────────────────────────────────────

fn cmd_configure(args: &[String]) {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let manifest = find_manifest(&cwd).unwrap_or_else(|| cwd.join("agape.toml"));

    if args.is_empty() {
        let pc = load_project_config(&cwd);
        println!("config ({}):", manifest.display());
        println!("  provider     = {}", pc.provider.as_deref().unwrap_or("mock"));
        println!("  model        = {}", pc.model.as_deref().unwrap_or("(provider default)"));
        println!("  samples      = {}", pc.samples.map(|s| s.to_string()).unwrap_or_else(|| "5 (default)".into()));
        println!("  temperature  = {}", pc.temperature.map(|t| t.to_string()).unwrap_or_else(|| "(provider default)".into()));
        println!("\nset with:  agape configure <provider|model|samples|temperature> <value>");
        return;
    }
    if args.len() < 2 {
        eprintln!("usage: agape configure <key> <value>   (keys: provider model samples temperature)");
        exit(2);
    }
    let (key, value) = (args[0].as_str(), args[1].as_str());
    let (section, tkey, quote) = match key {
        "provider" => ("provider", "backend", true),
        "model" => ("provider", "model", true),
        "samples" => ("runtime", "samples", false),
        "temperature" => ("runtime", "temperature", false),
        "threshold" => ("runtime", "threshold", false),
        other => {
            eprintln!("agape configure: unknown key {other:?} (provider|model|samples|temperature|threshold)");
            exit(2);
        }
    };
    set_toml_value(&manifest, section, tkey, value, quote);
    println!("set {key} = {value}   ({})", manifest.display());
}

/// Set `key = value` under `[section]` in a TOML file, creating the section/key
/// if absent. Minimal, line-based — fine for the flat manifest we own.
fn set_toml_value(path: &Path, section: &str, key: &str, value: &str, quote: bool) {
    let rendered = if quote { format!("{key} = \"{value}\"") } else { format!("{key} = {value}") };
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let mut lines: Vec<String> = text.lines().map(String::from).collect();

    // Find the section's line range [start, end).
    let header = format!("[{section}]");
    let sec_start = lines.iter().position(|l| l.trim() == header);
    match sec_start {
        Some(s) => {
            let end = lines[s + 1..]
                .iter()
                .position(|l| l.trim_start().starts_with('['))
                .map(|off| s + 1 + off)
                .unwrap_or(lines.len());
            // Replace an existing `key =` line within the section, else insert.
            let existing = lines[s + 1..end].iter().position(|l| l.trim_start().starts_with(&format!("{key} ")) || l.trim_start().starts_with(&format!("{key}=")));
            match existing {
                Some(off) => lines[s + 1 + off] = rendered,
                None => lines.insert(end, rendered),
            }
        }
        None => {
            if !lines.is_empty() && !lines.last().map(|l| l.is_empty()).unwrap_or(true) {
                lines.push(String::new());
            }
            lines.push(header);
            lines.push(rendered);
        }
    }
    let mut out = lines.join("\n");
    out.push('\n');
    if let Err(e) = std::fs::write(path, out) {
        eprintln!("agape configure: cannot write {}: {e}", path.display());
        exit(1);
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
    Credence<bool> sound = self <- f"is this answer factually correct and well-supported? answer: {d}";
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
         # `mock` (default — offline, deterministic, reproducible) or `claude`\n\
         # (a live model via the studio agent-server). Switch with:\n\
         #   agape configure provider claude\n\
         backend = \"mock\"\n\
         model = \"claude-haiku-4-5\"\n\n\
         [runtime]\n\
         # Sampling-fallback draws per graded judgment (§16.8); raise for finer\n\
         # probabilities at higher cost.\n\
         samples = 5\n\
         # temperature = 0.7\n"
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
