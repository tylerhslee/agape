//! The event spine — Agape's append-only log and single source of truth (§7).
//!
//! Every meaningful action appends an immutable `Event { tick, etype, subject,
//! payload, corr, agent }`. `tick` is system-assigned and monotonic
//! (`tick = |S|`); `subject` is the source the event is about (the `when`/`catch`
//! correlation key); `corr` links a `Started`/`Sent` to its `Resolved`.

/// One immutable entry on the spine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    pub tick: u64,
    pub etype: String,
    pub subject: Option<String>,
    pub payload: String,
    pub corr: Option<u64>,
    pub agent: Option<String>,
}

/// The append-only event log. State is a projection of this.
#[derive(Debug, Default, Clone)]
pub struct Spine {
    pub log: Vec<Event>,
    next_corr: u64,
}

impl Spine {
    pub fn new() -> Self {
        Spine { log: Vec::new(), next_corr: 0 }
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

    /// Append an event, assigning it the next monotonic tick. Returns the tick.
    pub fn append(
        &mut self,
        etype: impl Into<String>,
        subject: Option<String>,
        payload: impl Into<String>,
        corr: Option<u64>,
        agent: Option<String>,
    ) -> u64 {
        let tick = self.log.len() as u64;
        self.log.push(Event { tick, etype: etype.into(), subject, payload: payload.into(), corr, agent });
        tick
    }

    /// A short event token for diagnostics: `Etype(subject)`.
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
