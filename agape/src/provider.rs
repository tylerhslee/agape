//! The provider seam — the only place cognition enters the language.
//!
//! Agape source never names a provider directly. The runtime calls through this
//! trait (`think` / `embed`, plus the derived `similarity` / `entail`). Swapping
//! the implementation (a mock, the Anthropic API, a local model) changes no
//! Agape source. This module defines the seam and a deterministic mock so the
//! front-end can be exercised without a network or an API key.

/// A typed value a provider can return through the seam. Mirrors the scalar
/// types the language can constrain output to via structured decoding (SPEC §8).
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Text(String),
    Bool(bool),
    Int(i64),
    Float(f64),
    Null,
}

/// Three-valued entailment outcome (SPEC §8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Entailment,
    Contradiction,
    Neutral,
}

/// The cognition seam. Implementors must honor the requested output shape
/// (`schema`) — constrained decoding is mandatory for a real provider; there is
/// no regex fallback in the language.
pub trait Provider {
    /// Generate a reply to `prompt` for an optional agent, shaped to `schema`
    /// (one of `"text" | "bool" | "int" | "float" | "null"`).
    fn think(&mut self, prompt: &str, agent: Option<&str>, schema: &str) -> Value;

    /// Embed `text` into a vector (the substrate behind `~`).
    fn embed(&mut self, text: &str) -> Vec<f32>;

    /// Semantic closeness in [0, 1]; the caller thresholds it.
    fn similarity(&mut self, a: &str, b: &str) -> f32 {
        cosine(&self.embed(a), &self.embed(b))
    }

    /// Three-valued entailment of `claim` by `answer`.
    fn entail(&mut self, answer: &str, claim: &str) -> Verdict;
}

/// Cosine similarity of two equal-length vectors.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb: f32 = b.iter().map(|y| y * y).sum::<f32>().sqrt();
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na * nb)
    }
}

/// A deterministic, keyword-driven provider for tests and offline runs. It is
/// the Rust analog of the POC's `MockProvider`: predictable replies so both the
/// pass and fail paths of a program are reproducible.
#[derive(Debug, Default)]
pub struct MockProvider;

impl MockProvider {
    pub fn new() -> Self {
        MockProvider
    }
}

impl Provider for MockProvider {
    fn think(&mut self, prompt: &str, _agent: Option<&str>, schema: &str) -> Value {
        let p = prompt.to_lowercase();
        if p.contains("what is your name") {
            return Value::Text("My name is the agent.".into());
        }
        if p.contains("does a flush beat a straight") {
            return if schema == "bool" {
                Value::Bool(true)
            } else {
                Value::Text("Yes, a flush beats a straight.".into())
            };
        }
        match schema {
            "bool" => Value::Bool(false),
            "int" => Value::Int(0),
            "float" => Value::Float(0.0),
            "null" => Value::Null,
            _ => Value::Text("I don't know.".into()),
        }
    }

    fn embed(&mut self, text: &str) -> Vec<f32> {
        // Word-hash pseudo-embedding: deterministic and cosine-comparable. Words
        // shared between two strings push their vectors together.
        let mut vec = vec![0.0f32; 128];
        for word in text.to_lowercase().split(|c: char| !c.is_alphanumeric()) {
            if word.is_empty() {
                continue;
            }
            let h = fnv1a(word);
            for k in 0..4 {
                let idx = ((h >> (k * 5)) % 128) as usize;
                vec[idx] += 1.0;
            }
        }
        let norm = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            for x in &mut vec {
                *x /= norm;
            }
        }
        vec
    }

    fn entail(&mut self, answer: &str, _claim: &str) -> Verdict {
        let a = answer.to_lowercase();
        if a.contains("yes") || a.contains("correct") {
            Verdict::Entailment
        } else if a.contains("no") || a.contains("not") {
            Verdict::Contradiction
        } else {
            Verdict::Neutral
        }
    }
}

/// 32-bit FNV-1a hash — stable across platforms (unlike `std`'s `Hash`).
fn fnv1a(s: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in s.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_is_deterministic() {
        let mut p = MockProvider::new();
        assert_eq!(
            p.think("Does a flush beat a straight?", None, "bool"),
            Value::Bool(true)
        );
        assert_eq!(p.entail("Yes, it does.", "claim"), Verdict::Entailment);
    }

    #[test]
    fn shared_words_raise_similarity() {
        let mut p = MockProvider::new();
        let close = p.similarity("a flush beats a straight", "a flush beats a straight");
        let far = p.similarity("poker rules", "the weather today");
        assert!(close > far);
        assert!((close - 1.0).abs() < 1e-5);
    }
}
