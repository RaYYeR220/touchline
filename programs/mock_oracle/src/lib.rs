pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;

declare_id!("7uQHgENc27tcpP1svYShb6XUgxdzQTEX8xXrWDKUk57S");

// ---------------------------------------------------------------------------
// Types mirrored from txoracle IDL (same field order & Borsh layout).
// Names are irrelevant to borsh; only order and types matter.
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Comparison {
    GreaterThan,
    LessThan,
    EqualTo,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum BinaryExpression {
    Add,
    Subtract,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScoresUpdateStats {
    pub update_count: i32,
    pub min_timestamp: i64,
    pub max_timestamp: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScoresBatchSummary {
    pub fixture_id: i64,
    pub update_stats: ScoresUpdateStats,
    pub events_sub_tree_root: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub is_right_sibling: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScoreStat {
    pub key: u32,
    pub value: i32,
    pub period: i32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct StatTerm {
    pub stat_to_prove: ScoreStat,
    pub event_stat_root: [u8; 32],
    pub stat_proof: Vec<ProofNode>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct TraderPredicate {
    pub threshold: i32,
    pub comparison: Comparison,
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[program]
pub mod mock_oracle {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        initialize::handler(ctx)
    }

    /// Evaluate the predicate against the passed stat value(s).
    /// Arg layout mirrors txoracle.validate_stat exactly (same field order &
    /// types) so that Borsh bytes produced by the real CPI are accepted here.
    /// Merkle proofs are ignored; the mock just evaluates directly.
    pub fn validate_stat(
        _ctx: Context<ValidateStat>,
        _ts: i64,
        _fixture_summary: ScoresBatchSummary,
        _fixture_proof: Vec<ProofNode>,
        _main_tree_proof: Vec<ProofNode>,
        predicate: TraderPredicate,
        stat_a: StatTerm,
        stat_b: Option<StatTerm>,
        op: Option<BinaryExpression>,
    ) -> Result<bool> {
        let lhs: i64 = match (stat_b, op) {
            (Some(s2), Some(BinaryExpression::Add)) => {
                stat_a.stat_to_prove.value as i64 + s2.stat_to_prove.value as i64
            }
            (Some(s2), Some(BinaryExpression::Subtract)) => {
                stat_a.stat_to_prove.value as i64 - s2.stat_to_prove.value as i64
            }
            _ => stat_a.stat_to_prove.value as i64,
        };
        let t = predicate.threshold as i64;
        Ok(match predicate.comparison {
            Comparison::GreaterThan => lhs > t,
            Comparison::LessThan => lhs < t,
            Comparison::EqualTo => lhs == t,
        })
    }
}

#[derive(Accounts)]
pub struct ValidateStat<'info> {
    /// CHECK: accepted and ignored; mirrors the real account position.
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,
}
