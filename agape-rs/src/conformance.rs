//! The conformance harness — the scoreboard that drives development.
//!
//! It reads each test's `//!` header (the authoritative per-test spec), runs the
//! body through `process`, and scores it against the declared outcome. Versioning
//! follows the suite contract (README "Versions"): a build of version V runs a
//! test iff `since <= V` and (`until` absent or `V <= until`).
//!
//! Ledger assertions (`ledger:`/`contains:`/`absent:`) are matched (M4): `ledger:`
//! is an exact ordered ledger spine, `order:` is an ordered subsequence, and
//! `contains:`/`absent:` are membership / non-membership, all subtype-aware (§9).

use std::fs;
use std::path::{Path, PathBuf};

use crate::diag::ErrorClass;
use crate::interp::{is_subtype, HarnessConfig, ProviderMode};
use crate::ledger::Ledger;

/// A semantic version as (major, minor), e.g. "1.0" -> (1, 0), "0.3" -> (0, 3).
/// Ordered lexicographically, which matches 0.3 < 0.4 < 1.0.
pub type Version = (u32, u32);

pub fn parse_version(s: &str) -> Version {
    let s = s.trim();
    let mut it = s.split('.');
    let major = it.next().and_then(|x| x.trim().parse().ok()).unwrap_or(0);
    let minor = it.next().and_then(|x| x.trim().parse().ok()).unwrap_or(0);
    (major, minor)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Expect {
    Accept,
    Reject,
    Blocked,
    Provisional,
}

/// A single conformance test, parsed from a `.ag` file's `//!` header + body.
#[derive(Debug, Clone)]
pub struct TestSpec {
    pub id: String,
    pub section: String,
    pub path: PathBuf,
    pub since: Version,
    pub until: Option<Version>,
    pub expect: Expect,
    pub error: Option<ErrorClass>,
    pub body: String,
    /// Ledger assertions, kept verbatim for the M4 matcher.
    pub ledger: Option<String>,
    pub contains: Option<String>,
    pub absent: Option<String>,
    pub order: Option<String>,
    /// Seam directives (§17.5 test-mode): a scripted/empty/violating provider, a
    /// denying identity seam, a connector manifest.
    pub provider: Option<String>,
    pub attest: Option<String>,
    pub manifest: Option<String>,
    pub replay: Option<String>,
    /// Companion module filenames (`a.ag; b.ag`) living in a sibling `<id>.d/`
    /// directory, compiled together with the body so imports resolve (§19).
    pub modules: Vec<String>,
    /// Package roots (`name=path/to/lib.ag`) living under `<id>.d/`, compiled as
    /// module `name` to exercise package dependency resolution (§19.3).
    pub packages: Vec<(String, String)>,
}

/// Parse one test file's header and body. Returns `None` if it has no usable
/// header (not a conformance test).
pub fn parse_test(path: &Path) -> Option<TestSpec> {
    let text = fs::read_to_string(path).ok()?;
    let mut header: Vec<(String, String)> = Vec::new();
    let mut body = String::new();
    let mut in_body = false;

    for line in text.lines() {
        if in_body {
            body.push_str(line);
            body.push('\n');
            continue;
        }
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("//!") {
            let rest = rest.trim();
            if rest == "---" {
                in_body = true;
                continue;
            }
            if let Some((k, v)) = rest.split_once(':') {
                header.push((k.trim().to_string(), v.trim().to_string()));
            }
        } else {
            // A non-`//!` line before the `//! ---` terminator: no header block.
            in_body = true;
            body.push_str(line);
            body.push('\n');
        }
    }

    let get = |key: &str| -> Option<String> {
        header.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
    };

    let expect = match get("expect")?.as_str() {
        "accept" => Expect::Accept,
        "reject" => Expect::Reject,
        "blocked" => Expect::Blocked,
        "provisional" => Expect::Provisional,
        other => {
            eprintln!("[warn] {}: unknown expect {:?}", path.display(), other);
            return None;
        }
    };

    Some(TestSpec {
        id: get("id").unwrap_or_else(|| path.file_stem().unwrap().to_string_lossy().into()),
        section: get("section").unwrap_or_default(),
        path: path.to_path_buf(),
        since: get("since").map(|s| parse_version(&s)).unwrap_or((0, 3)),
        until: get("until").map(|s| parse_version(&s)),
        expect,
        error: get("error").and_then(|e| ErrorClass::from_suite(&e)),
        body,
        ledger: get("ledger"),
        contains: get("contains"),
        absent: get("absent"),
        order: get("order"),
        provider: get("provider"),
        attest: get("attest"),
        manifest: get("manifest"),
        replay: get("replay"),
        modules: get("modules")
            .map(|s| s.split(';').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect())
            .unwrap_or_default(),
        packages: get("packages")
            .map(|s| {
                s.split(';')
                    .filter_map(|x| {
                        let (name, path) = x.trim().split_once('=')?;
                        Some((name.trim().to_string(), path.trim().to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default(),
    })
}

/// Recursively collect every `.ag` test under `dir`, sorted by (section, id).
pub fn collect_tests(dir: &Path) -> Vec<TestSpec> {
    let mut out = Vec::new();
    collect_into(dir, &mut out);
    out.sort_by(|a, b| a.section.cmp(&b.section).then_with(|| a.id.cmp(&b.id)));
    out
}

fn collect_into(dir: &Path, out: &mut Vec<TestSpec>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            collect_into(&p, out);
        } else if p.extension().and_then(|e| e.to_str()) == Some("ag") {
            if let Some(t) = parse_test(&p) {
                out.push(t);
            }
        }
    }
}

impl TestSpec {
    /// Does this test apply to a build of version `v`?
    pub fn applies_to(&self, v: Version) -> bool {
        if v < self.since {
            return false; // newer-spec: this build predates the feature
        }
        if let Some(until) = self.until {
            if v > until {
                return false; // superseded by a later spec version
            }
        }
        true
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    Pass,
    Fail(String),
    Blocked,
    SkippedNewer,
    SkippedSuperseded,
}

#[derive(Debug, Clone)]
pub struct Outcome {
    pub id: String,
    pub section: String,
    pub status: Status,
}

/// Translate a test's seam directives (§17.5) into a runtime [`HarnessConfig`].
fn harness_config(test: &TestSpec) -> Result<HarnessConfig, crate::diag::AgapeError> {
    let mut c = HarnessConfig::default();
    if let Some(p) = &test.provider {
        let p = p.trim();
        if p == "empty" {
            c.provider = ProviderMode::Empty;
        } else if p == "schema_violation" {
            c.provider = ProviderMode::SchemaViolation;
        } else if let Some(inner) = p.strip_prefix("credence(").and_then(|x| x.strip_suffix(')')) {
            // `credence(true=0.55, false=0.45)` — a scripted distribution.
            let dist = inner
                .split(',')
                .filter_map(|kv| {
                    let (k, val) = kv.split_once('=')?;
                    Some((k.trim().to_string(), val.trim().parse::<f64>().ok()?))
                })
                .collect::<Vec<_>>();
            if !dist.is_empty() {
                c.credence = Some(dist);
            }
        }
    }
    if test.attest.as_deref().map(str::trim) == Some("deny") {
        c.attest_deny = true;
    }
    if let Some(m) = &test.manifest {
        // A `key=value; key=value` connector manifest; only the keys the runtime
        // honors are read (the rest are connector config, inert in test-mode).
        let mut provider_exposes_logprobs: Option<bool> = None;
        let mut provider_temperature: Option<f64> = None;
        let mut provider_fallback_temperature: Option<f64> = None;
        let mut strict_bindings = false;
        let mut configured_principals = std::collections::HashSet::new();
        let mut configured_tools = std::collections::HashSet::new();
        let mut configured_prompts = std::collections::HashSet::new();
        for entry in m.split(';') {
            if let Some((k, val)) = entry.split_once('=') {
                let key = k.trim();
                let val = val.trim();
                match key {
                    "memory.internalize_on_receive" if val == "true" => c.internalize_on_receive = true,
                    "provider.exposes_logprobs" => provider_exposes_logprobs = Some(val == "true"),
                    "provider.temperature" => provider_temperature = val.parse().ok(),
                    "provider.fallback_temperature" => provider_fallback_temperature = val.parse().ok(),
                    "config.require_bindings" if val == "true" => strict_bindings = true,
                    _ if key.starts_with("identity.") => {
                        configured_principals.insert(key.trim_start_matches("identity.").to_string());
                    }
                    _ if key.starts_with("tools.") => {
                        configured_tools.insert(key.trim_start_matches("tools.").to_string());
                    }
                    _ if key.starts_with("prompts.") => {
                        configured_prompts.insert(key.trim_start_matches("prompts.").to_string());
                    }
                    _ => {}
                }
            }
        }
        if provider_exposes_logprobs == Some(false)
            && provider_temperature == Some(0.0)
            && provider_fallback_temperature.is_none()
        {
            return Err(crate::diag::AgapeError::new(
                ErrorClass::Config,
                "text-only provider at temperature 0 requires provider.fallback_temperature (§17)",
            ));
        }
        if strict_bindings {
            check_config_bindings(test, &configured_principals, &configured_tools, &configured_prompts)?;
        }
    }
    Ok(c)
}

fn check_config_bindings(
    test: &TestSpec,
    principals: &std::collections::HashSet<String>,
    tools: &std::collections::HashSet<String>,
    prompts: &std::collections::HashSet<String>,
) -> Result<(), crate::diag::AgapeError> {
    let sources = std::iter::once(test.body.as_str());
    for src in sources {
        for line in src.lines().map(str::trim) {
            if let Some(rest) = line.strip_prefix("principal ") {
                let name = rest.trim_end_matches(';').trim();
                if !principals.contains(name) {
                    return Err(crate::diag::AgapeError::new(ErrorClass::Config, format!("principal `{name}` has no identity binding (§17)")));
                }
            }
            if let Some(rest) = line.strip_prefix("prompt ") {
                let mut parts = rest.trim_end_matches(';').split_whitespace();
                let _ty = parts.next();
                if let Some(name) = parts.next() {
                    if !prompts.contains(name) {
                        return Err(crate::diag::AgapeError::new(ErrorClass::Config, format!("prompt `{name}` has no manifest binding (§17)")));
                    }
                }
            }
            if line.contains(" tool ") {
                let decl = line.trim_end_matches(';');
                if let Some(before_params) = decl.split('(').next() {
                    let name = before_params.split_whitespace().last().unwrap_or("");
                    if !tools.contains(name) {
                        return Err(crate::diag::AgapeError::new(ErrorClass::Config, format!("tool `{name}` has no manifest binding (§17)")));
                    }
                }
            }
        }
    }
    Ok(())
}

/// Run a test through the pipeline: the body is the root module; any `modules:`
/// companions in the sibling `<id>.d/` directory are compiled together (§19).
fn run_test(test: &TestSpec, config: &crate::HarnessConfig) -> Result<Ledger, crate::diag::AgapeError> {
    if test.modules.is_empty() && test.packages.is_empty() {
        return crate::process_with_config(&test.body, config);
    }
    let root = crate::parse_module(&test.body, "")?;
    let dir = test.path.with_extension("d");
    let mut modules = vec![root];
    for fname in &test.modules {
        let p = dir.join(fname);
        let src = fs::read_to_string(&p).map_err(|_| {
            crate::diag::AgapeError::new(ErrorClass::Module, format!("companion module not found: {}", p.display()))
        })?;
        let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        modules.push(crate::parse_module(&src, &stem)?);
    }
    for (name, rel) in &test.packages {
        let p = dir.join(rel);
        let src = fs::read_to_string(&p).map_err(|_| {
            crate::diag::AgapeError::new(ErrorClass::Module, format!("package root not found: {}", p.display()))
        })?;
        modules.push(crate::parse_module(&src, name)?);
    }
    crate::process_modules(&modules, config)
}

/// Score one test against the pipeline, under its declared seam configuration.
pub fn score(test: &TestSpec, v: Version) -> Status {
    if v < test.since {
        return Status::SkippedNewer;
    }
    if let Some(until) = test.until {
        if v > until {
            return Status::SkippedSuperseded;
        }
    }
    let config = match harness_config(test) {
        Ok(c) => c,
        Err(e) => {
            return match test.expect {
                Expect::Reject => match test.error {
                    Some(want) if want == e.class => Status::Pass,
                    Some(want) => Status::Fail(format!("rejected with wrong class: got {}, want {}", e.class, want)),
                    None => Status::Fail("reject test missing an `error:` class".into()),
                },
                _ => Status::Fail(format!("configuration failed ({})", e.class)),
            };
        }
    };
    match test.expect {
        Expect::Blocked | Expect::Provisional => Status::Blocked,
        Expect::Accept => match run_test(test, &config) {
            Ok(ledger) => {
                if test.replay.as_deref() == Some("chain_head_equal") {
                    match run_test(test, &config) {
                        Ok(replayed) if replayed.chain_head_hex() == ledger.chain_head_hex() => {}
                        Ok(replayed) => return Status::Fail(format!("replay chain-head mismatch: {} != {}", replayed.chain_head_hex(), ledger.chain_head_hex())),
                        Err(e) => return Status::Fail(format!("replay rejected ({})", e.class)),
                    }
                }
                match check_assertions(test, &ledger) {
                    Ok(()) => Status::Pass,
                    Err(msg) => Status::Fail(msg),
                }
            }
            Err(e) => Status::Fail(format!("expected accept, got reject ({})", e.class)),
        },
        Expect::Reject => match run_test(test, &config) {
            Ok(_) => Status::Fail("expected reject, but accepted".into()),
            Err(e) => match test.error {
                Some(want) if want == e.class => Status::Pass,
                Some(want) => Status::Fail(format!(
                    "rejected with wrong class: got {}, want {}",
                    e.class, want
                )),
                None => Status::Fail("reject test missing an `error:` class".into()),
            },
        },
    }
}

#[derive(Debug, Default, Clone)]
pub struct Report {
    pub version: Version,
    pub outcomes: Vec<Outcome>,
}

impl Report {
    pub fn count(&self, pred: impl Fn(&Status) -> bool) -> usize {
        self.outcomes.iter().filter(|o| pred(&o.status)).count()
    }

    pub fn passed(&self) -> usize {
        self.count(|s| matches!(s, Status::Pass))
    }
    pub fn failed(&self) -> usize {
        self.count(|s| matches!(s, Status::Fail(_)))
    }
    pub fn blocked(&self) -> usize {
        self.count(|s| matches!(s, Status::Blocked))
    }
    pub fn skipped(&self) -> usize {
        self.count(|s| matches!(s, Status::SkippedNewer | Status::SkippedSuperseded))
    }
    /// Applicable = scored (pass or fail), the meaningful denominator.
    pub fn applicable(&self) -> usize {
        self.passed() + self.failed()
    }
}

// ── ledger assertion matcher (§7 vocabulary; README "Ledger matcher") ──────────

/// One assertion token: a single event `Etype(subj)?`, or a `pair(op@subj)`
/// (a started + resolved pair for async op `op` on subject `subj`).
#[derive(Debug, Clone)]
enum Token {
    Single { etype: String, subj: Option<String> },
    Pair { op: String, subj: String },
}

fn parse_token(s: &str) -> Option<Token> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if let Some(inner) = s.strip_prefix("pair(").and_then(|x| x.strip_suffix(')')) {
        let (op, subj) = inner.split_once('@')?;
        return Some(Token::Pair { op: op.trim().to_string(), subj: subj.trim().to_string() });
    }
    if let Some(inner) = s.strip_prefix("single(").and_then(|x| x.strip_suffix(')')) {
        // `single(op@subj)` — one synchronous event of `op` on `subj`.
        let (op, subj) = inner.split_once('@')?;
        return Some(Token::Single { etype: op.trim().to_string(), subj: Some(subj.trim().to_string()) });
    }
    if let Some(idx) = s.find('(') {
        let etype = s[..idx].trim().to_string();
        let subj = s[idx + 1..].trim_end_matches(')').trim().to_string();
        return Some(Token::Single { etype, subj: Some(subj) });
    }
    Some(Token::Single { etype: s.to_string(), subj: None })
}

fn parse_tokens(s: &str) -> Vec<Token> {
    s.split(';').filter_map(parse_token).collect()
}

fn event_matches(ev: &crate::ledger::Event, etype: &str, subj: &Option<String>, ledger: &Ledger) -> bool {
    let subtype = is_subtype(&ev.etype, etype)
        // A user `event …: Error` leaf (§19.5) matches the `Error` root.
        || (etype == "Error" && ledger.error_subtypes.contains(&ev.etype));
    subtype && match subj {
        Some(want) => ev.subject.as_deref() == Some(want.as_str()),
        None => true,
    }
}

/// The (started, resolved) event etypes for a `pair(op@…)` op.
fn pair_etypes(op: &str) -> (String, String) {
    match op {
        "send" => ("Sent".into(), "Resolved".into()),
        "Tool" | "tool" => ("ToolStarted".into(), "ToolResolved".into()),
        other => (format!("{other}Started"), format!("{other}Resolved")),
    }
}

fn token_present(ledger: &Ledger, t: &Token) -> bool {
    match t {
        Token::Single { etype, subj } => ledger.log.iter().any(|ev| event_matches(ev, etype, subj, ledger)),
        Token::Pair { op, subj } => {
            let (started, resolved) = pair_etypes(op);
            let s = Some(subj.clone());
            ledger.log.iter().any(|ev| event_matches(ev, &started, &s, ledger))
                && ledger.log.iter().any(|ev| event_matches(ev, &resolved, &s, ledger))
        }
    }
}

/// `order:` — the tokens must appear as an ordered subsequence of the log.
fn matches_ordered(ledger: &Ledger, tokens: &[Token]) -> bool {
    let mut cursor = 0usize;
    for t in tokens {
        let Token::Single { etype, subj } = t else {
            // A `pair` in an ordered spec: require both present (order-free).
            if !token_present(ledger, t) {
                return false;
            }
            continue;
        };
        match ledger.log[cursor..].iter().position(|ev| event_matches(ev, etype, subj, ledger)) {
            Some(off) => cursor += off + 1,
            None => return false,
        }
    }
    true
}

/// `ledger:` — the tokens must match the produced log exactly.
fn matches_exact(ledger: &Ledger, tokens: &[Token]) -> bool {
    if tokens.len() != ledger.log.len() {
        return false;
    }
    tokens.iter().zip(&ledger.log).all(|(t, ev)| match t {
        Token::Single { etype, subj } => event_matches(ev, etype, subj, ledger),
        Token::Pair { .. } => false,
    })
}

fn check_assertions(test: &TestSpec, ledger: &Ledger) -> Result<(), String> {
    if let Some(s) = &test.ledger {
        let toks = parse_tokens(s);
        if !matches_exact(ledger, &toks) {
            return Err(format!("ledger assertion failed: expected exact [{s}], got [{}]", ledger.dump().replace('\n', ", ")));
        }
    }
    // `order:` — the listed events must appear in this relative order (a subsequence).
    if let Some(s) = &test.order {
        let toks = parse_tokens(s);
        if !matches_ordered(ledger, &toks) {
            return Err(format!("order assertion failed: expected [{s}], got [{}]", ledger.dump().replace('\n', ", ")));
        }
    }
    if let Some(s) = &test.contains {
        for t in parse_tokens(s) {
            if !token_present(ledger, &t) {
                return Err(format!("contains assertion failed: missing {t:?} in [{}]", ledger.dump().replace('\n', ", ")));
            }
        }
    }
    if let Some(s) = &test.absent {
        for t in parse_tokens(s) {
            if token_present(ledger, &t) {
                return Err(format!("absent assertion failed: present {t:?} in [{}]", ledger.dump().replace('\n', ", ")));
            }
        }
    }
    Ok(())
}

/// Run the whole suite under `dir` at build version `v`.
pub fn run(dir: &Path, v: Version) -> Report {
    let outcomes = collect_tests(dir)
        .into_iter()
        .map(|t| Outcome {
            status: score(&t, v),
            id: t.id,
            section: t.section,
        })
        .collect();
    Report { version: v, outcomes }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(id: &str, expect: Expect, body: &str) -> TestSpec {
        TestSpec {
            id: id.to_string(),
            section: "selfcheck".to_string(),
            path: PathBuf::from(format!("{id}.ag")),
            since: (1, 0),
            until: None,
            expect,
            error: None,
            body: body.to_string(),
            ledger: None,
            contains: None,
            absent: None,
            order: None,
            provider: None,
            attest: None,
            manifest: None,
            replay: None,
            modules: Vec::new(),
            packages: Vec::new(),
        }
    }

    #[test]
    fn accept_body_declared_reject_fails() {
        let status = score(&spec("false_reject", Expect::Reject, "say(\"ok\");"), (1, 0));
        assert!(matches!(status, Status::Fail(ref msg) if msg == "expected reject, but accepted"));
    }

    #[test]
    fn reject_body_declared_accept_fails() {
        let status = score(&spec("false_accept", Expect::Accept, "int a = 1\nint b = 2;"), (1, 0));
        assert!(matches!(status, Status::Fail(ref msg) if msg.contains("expected accept, got reject")));
    }
}
