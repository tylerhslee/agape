//! The event ledger — Agape's append-only log and single source of truth (§7, §16.2).
//!
//! Every meaningful action appends an immutable `Event { tick, etype, subject,
//! payload, corr, agent }`. `tick` is system-assigned and monotonic (`tick = |S|`);
//! `subject` is the source the event is about (the `when` correlation key); `corr`
//! links a `Started`/`Sent` to its `Resolved`.
//!
//! The ledger is hash-chained (§16.2): each append folds the event's canonical
//! serialization into a running SHA-256 chain seeded at `SHA-256("agape/v1")`. The
//! **chain-head** is therefore a function of the whole journal's content, so two runs
//! are replay-equivalent iff their heads are equal (T4, §15.4.2 / §16.5).

use crate::hash::{hex, sha256};

/// One immutable entry on the ledger.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    pub tick: u64,
    pub etype: String,
    pub subject: Option<String>,
    pub payload: String,
    pub corr: Option<u64>,
    pub agent: Option<String>,
}

/// JSON-escape a string into a quoted canonical form.
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

impl Event {
    /// Canonical serialization (§16.2): the six fields in fixed order, no
    /// insignificant whitespace, JSON-escaped strings, `null` for absent options.
    /// Byte-identical for equal events — the basis of the chain-head.
    pub fn canonical(&self) -> String {
        let subject = self
            .subject
            .as_deref()
            .map(json_str)
            .unwrap_or_else(|| "null".into());
        let corr = self
            .corr
            .map(|c| c.to_string())
            .unwrap_or_else(|| "null".into());
        let agent = self
            .agent
            .as_deref()
            .map(json_str)
            .unwrap_or_else(|| "null".into());
        format!(
            "{{\"tick\":{},\"etype\":{},\"subject\":{},\"payload\":{},\"corr\":{},\"agent\":{}}}",
            self.tick,
            json_str(&self.etype),
            subject,
            json_str(&self.payload),
            corr,
            agent
        )
    }
}

/// The append-only event log. State is a projection of this.
#[derive(Debug, Clone)]
pub struct Ledger {
    pub log: Vec<Event>,
    next_corr: u64,
    /// The running hash-chain head (§16.2).
    head: [u8; 32],
    /// User `event …: Error` leaf types (§19.5) — so a `when (Error e)` and the
    /// conformance matcher recognize them as `Error` subtypes.
    pub error_subtypes: std::collections::HashSet<String>,
}

impl Default for Ledger {
    fn default() -> Self {
        Self::new()
    }
}

impl Ledger {
    pub fn new() -> Self {
        Ledger {
            log: Vec::new(),
            next_corr: 0,
            head: sha256(b"agape/v1"),
            error_subtypes: std::collections::HashSet::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.log.len()
    }
    pub fn is_empty(&self) -> bool {
        self.log.is_empty()
    }

    /// A fresh correlation id (for pairing Started/Sent with Resolved).
    pub fn fresh_corr(&mut self) -> u64 {
        let c = self.next_corr;
        self.next_corr += 1;
        c
    }

    /// Append an event, assigning it the next monotonic tick and folding it into
    /// the hash-chain (`hᵢ = SHA-256(hᵢ₋₁ ‖ canonical(eventᵢ))`). Returns the tick.
    pub fn append(
        &mut self,
        etype: impl Into<String>,
        subject: Option<String>,
        payload: impl Into<String>,
        corr: Option<u64>,
        agent: Option<String>,
    ) -> u64 {
        let tick = self.log.len() as u64;
        let ev = Event {
            tick,
            etype: etype.into(),
            subject,
            payload: payload.into(),
            corr,
            agent,
        };
        let mut buf = self.head.to_vec();
        buf.extend_from_slice(ev.canonical().as_bytes());
        self.head = sha256(&buf);
        self.log.push(ev);
        tick
    }

    /// The chain-head: SHA-256 over the whole journal's content (§16.2). Equality
    /// of two heads is the proof of replay-equivalence (T4).
    pub fn chain_head(&self) -> [u8; 32] {
        self.head
    }
    /// The chain-head as lowercase hex (the canonical serialization the conformance
    /// harness compares for `replay: chain_head_equal`, §17.5).
    pub fn chain_head_hex(&self) -> String {
        hex(&self.head)
    }

    /// A short event token for diagnostics: `[tick] Etype(subject)`.
    pub fn dump(&self) -> String {
        self.log
            .iter()
            .map(|e| match &e.subject {
                Some(s) => format!("[{}] {}({})", e.tick, e.etype, s),
                None => format!("[{}] {}", e.tick, e.etype),
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(events: &[(&str, Option<&str>)]) -> Ledger {
        let mut s = Ledger::new();
        for (etype, subj) in events {
            s.append(*etype, subj.map(|x| x.to_string()), "", None, None);
        }
        s
    }

    #[test]
    fn genesis_is_deterministic_and_nonzero() {
        let a = Ledger::new();
        let b = Ledger::new();
        assert_eq!(a.chain_head(), b.chain_head());
        assert_ne!(a.chain_head(), [0u8; 32]); // seeded, not the all-zero default
    }

    #[test]
    fn identical_sequences_share_a_chain_head() {
        // T4: identical journals ⇒ identical head.
        let s1 = build(&[
            ("Spawned", Some("a")),
            ("AgentAwake", Some("a")),
            ("Decided", Some("c")),
        ]);
        let s2 = build(&[
            ("Spawned", Some("a")),
            ("AgentAwake", Some("a")),
            ("Decided", Some("c")),
        ]);
        assert_eq!(s1.chain_head_hex(), s2.chain_head_hex());
    }

    #[test]
    fn divergent_sequences_diverge() {
        let s1 = build(&[("Spawned", Some("a")), ("Decided", Some("c"))]);
        let s2 = build(&[("Spawned", Some("a")), ("Abstained", Some("c"))]); // one event differs
        assert_ne!(s1.chain_head(), s2.chain_head());
        // order matters too
        let s3 = build(&[("Decided", Some("c")), ("Spawned", Some("a"))]);
        assert_ne!(s1.chain_head(), s3.chain_head());
    }

    #[test]
    fn canonical_is_stable_and_escaped() {
        let e = Event {
            tick: 7,
            etype: "Event".into(),
            subject: Some("a".into()),
            payload: "he\"llo\n".into(),
            corr: Some(3),
            agent: None,
        };
        assert_eq!(
            e.canonical(),
            "{\"tick\":7,\"etype\":\"Event\",\"subject\":\"a\",\"payload\":\"he\\\"llo\\n\",\"corr\":3,\"agent\":null}"
        );
    }
}
