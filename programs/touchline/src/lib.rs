pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("21zXPvXZYPnPu8sCSQ5b8Ly76DXNjWUS2MX8jQwgesLJ");

declare_program!(txoracle);

#[program]
pub mod touchline {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        initialize::handler(ctx)
    }

    pub fn create_market(
        ctx: Context<CreateMarket>,
        fixture_id: u64,
        stat_key: u32,
        predicate: Predicate,
    ) -> Result<()> {
        instructions::create_market::handler(ctx, fixture_id, stat_key, predicate)
    }

    pub fn post_offer(
        ctx: Context<PostOffer>,
        offer_id: u64,
        maker_side: Side,
        price_yes_bps: u16,
        pot: u64,
    ) -> Result<()> {
        instructions::post_offer::handler(ctx, offer_id, maker_side, price_yes_bps, pot)
    }

    pub fn cancel_offer(ctx: Context<CancelOffer>) -> Result<()> {
        instructions::cancel_offer::handler(ctx)
    }

    pub fn fill_offer(
        ctx: Context<FillOffer>,
        position_id: u64,
        fill_pot: u64,
    ) -> Result<()> {
        instructions::fill_offer::handler(ctx, position_id, fill_pot)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn settle(
        ctx: Context<Settle>,
        ts: i64,
        fixture_summary: txoracle::types::ScoresBatchSummary,
        fixture_proof: Vec<txoracle::types::ProofNode>,
        main_tree_proof: Vec<txoracle::types::ProofNode>,
        stat1: txoracle::types::StatTerm,
        stat2: Option<txoracle::types::StatTerm>,
        op: Option<txoracle::types::BinaryExpression>,
    ) -> Result<()> {
        instructions::settle::handler(
            ctx,
            ts,
            fixture_summary,
            fixture_proof,
            main_tree_proof,
            stat1,
            stat2,
            op,
        )
    }
}
