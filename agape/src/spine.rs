//! The event spine — the append-only log that is the source of truth.
//!
//! Every meaningful action appends an immutable [`Event`]. State is a projection
//! of the log; replay re-derives state by folding it. Ticks are system-assigned
//! and monotonic — never agent-controlled (SPEC §15). Cognitive operations
//! append a Started/Resolved *pair* correlated by a `corr` id; "pending" is a
//! Started with no matching Resolved yet.
//!
//! This is the runtime foundation the interpreter/codegen will build on. The
//! subscription mechanism behind `when`/`catch` is the next milestone.

use std::fmt;

/// A correlation id linking a Started event to its later Resolved event.
pub type Corr = u64;

/// One immutable entry on the spine.
#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    /// System-assigned monotonic position.
    pub tick: u64,
    /// The event type, e.g. `ThinkStarted`, `SuccessfulVerification`.
    pub etype: String,
    /// The correlation key for subscriptions (an agent name, a var name, ...).
    pub subject: Option<String>,
    /// A human-readable rendering of the payload (typed payloads come with the
    /// interpreter; the front-end keeps this representation simple).
    pub payload: Option<String>,
    /// The owning agent, if any.
    pub agent: Option<String>,
    /// Correlation id for Started/Resolved pairs.
    pub corr: Option<Corr>,
}

impl fmt::Display for Event {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{:>3}] {}", self.tick, self.etype)?;
        if let Some(s) = &self.subject {
            write!(f, " subject={s:?}")?;
        }
        if let Some(p) = &self.payload {
            write!(f, " payload={p:?}")?;
        }
        if let Some(c) = &self.corr {
            write!(f, " corr=c{c}")?;
        }
        if let Some(a) = &self.agent {
            write!(f, " @{a}")?;
        }
        Ok(())
    }
}

/// The append-only event log.
#[derive(Debug, Default)]
pub struct Spine {
    log: Vec<Event>,
    next_corr: Corr,
}

impl Spine {
    pub fn new() -> Self {
        Spine { log: Vec::new(), next_corr: 1 }
    }

    /// Append a single, deterministic event; returns its tick.
    pub fn append(
        &mut self,
        etype: impl Into<String>,
        subject: Option<String>,
        payload: Option<String>,
        agent: Option<String>,
    ) -> u64 {
        let tick = self.log.len() as u64;
        self.log.push(Event { tick, etype: etype.into(), subject, payload, agent, corr: None });
        tick
    }

    /// Append a `<Op>Started` event and return its correlation id.
    pub fn started(
        &mut self,
        op: &str,
        subject: Option<String>,
        agent: Option<String>,
    ) -> Corr {
        let corr = self.next_corr;
        self.next_corr += 1;
        let tick = self.log.len() as u64;
        self.log.push(Event {
            tick,
            etype: format!("{op}Started"),
            subject,
            payload: None,
            agent,
            corr: Some(corr),
        });
        corr
    }

    /// Append the matching `<Op>Resolved` event for a prior `started`.
    pub fn resolved(
        &mut self,
        op: &str,
        corr: Corr,
        subject: Option<String>,
        payload: Option<String>,
        agent: Option<String>,
    ) -> u64 {
        let tick = self.log.len() as u64;
        self.log.push(Event {
            tick,
            etype: format!("{op}Resolved"),
            subject,
            payload,
            agent,
            corr: Some(corr),
        });
        tick
    }

    pub fn log(&self) -> &[Event] {
        &self.log
    }

    /// Started events with no matching Resolved — the pending set.
    pub fn pending(&self) -> Vec<&Event> {
        let resolved: std::collections::HashSet<Corr> = self
            .log
            .iter()
            .filter(|e| e.etype.ends_with("Resolved"))
            .filter_map(|e| e.corr)
            .collect();
        self.log
            .iter()
            .filter(|e| e.etype.ends_with("Started"))
            .filter(|e| e.corr.map(|c| !resolved.contains(&c)).unwrap_or(false))
            .collect()
    }

    /// Render the whole log, one event per line.
    pub fn dump(&self) -> String {
        self.log.iter().map(|e| e.to_string()).collect::<Vec<_>>().join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticks_are_monotonic() {
        let mut s = Spine::new();
        let t0 = s.append("AwakeEvent", Some("john".into()), None, None);
        let t1 = s.append("SleepEvent", Some("john".into()), None, None);
        assert_eq!(t0, 0);
        assert_eq!(t1, 1);
    }

    #[test]
    fn started_resolved_pairing_and_pending() {
        let mut s = Spine::new();
        let c = s.started("Think", Some("Name".into()), Some("john".into()));
        assert_eq!(s.pending().len(), 1, "started but not resolved => pending");
        s.resolved("Think", c, Some("Name".into()), Some("My name is John.".into()), Some("john".into()));
        assert_eq!(s.pending().len(), 0, "resolved clears pending");
        assert_eq!(s.log().len(), 2);
    }

    #[test]
    fn distinct_corr_ids() {
        let mut s = Spine::new();
        let a = s.started("Think", None, None);
        let b = s.started("Think", None, None);
        assert_ne!(a, b);
    }
}
