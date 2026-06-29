use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::get_return_data;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::constants::*;
use crate::error::ErrorCode;
use crate::state::*;
use crate::txoracle::cpi as txoracle_cpi;
use crate::txoracle::types as txtypes;

#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<Settle>,
    ts: i64,
    fixture_summary: txtypes::ScoresBatchSummary,
    fixture_proof: Vec<txtypes::ProofNode>,
    main_tree_proof: Vec<txtypes::ProofNode>,
    stat1: txtypes::StatTerm,
    stat2: Option<txtypes::StatTerm>,
    op: Option<txtypes::BinaryExpression>,
) -> Result<()> {
    require!(!ctx.accounts.position.settled, ErrorCode::AlreadySettled);

    // Map the market predicate to the oracle's type.
    let p = ctx.accounts.market.predicate;
    let predicate = txtypes::TraderPredicate {
        threshold: p.threshold,
        comparison: match p.comparison {
            Comparison::GreaterThan => txtypes::Comparison::GreaterThan,
            Comparison::LessThan => txtypes::Comparison::LessThan,
            Comparison::EqualTo => txtypes::Comparison::EqualTo,
        },
    };

    // CPI to the oracle (mock in tests, real txoracle in prod).
    // declare_program!(txoracle) generates Result<()> because the txoracle IDL
    // does not include a `returns` field — so we read the bool via get_return_data().
    let cpi_ctx = CpiContext::new(
        ctx.accounts.oracle_program.key(),
        txoracle_cpi::accounts::ValidateStat {
            daily_scores_merkle_roots: ctx.accounts.daily_scores_merkle_roots.to_account_info(),
        },
    );
    txoracle_cpi::validate_stat(
        cpi_ctx,
        ts,
        fixture_summary,
        fixture_proof,
        main_tree_proof,
        predicate,
        stat1,
        stat2,
        op,
    )?;

    // Anchor sets return data for bool return types via set_return_data.
    // Read the single Borsh byte: 0=false, 1=true.
    let (_, return_data) =
        get_return_data().ok_or_else(|| error!(ErrorCode::OracleRejected))?;
    let yes: bool = return_data
        .first()
        .copied()
        .ok_or_else(|| error!(ErrorCode::OracleRejected))?
        != 0;

    // Determine winner: maker wins if YES and maker=Yes, or NO and maker=No.
    let pos = &ctx.accounts.position;
    let winner_is_maker =
        (yes && pos.maker_side == Side::Yes) || (!yes && pos.maker_side == Side::No);

    // Build the PDA signer seeds for the market (vault authority).
    let market = &ctx.accounts.market;
    let fixture_id_bytes = market.fixture_id.to_le_bytes();
    let stat_key_bytes = market.stat_key.to_le_bytes();
    let threshold_bytes = market.predicate.threshold.to_le_bytes();
    let comparison_byte = [market.predicate.comparison as u8];
    let bump_byte = [market.bump];
    let market_seeds: &[&[&[u8]]] = &[&[
        MARKET_SEED,
        &fixture_id_bytes,
        &stat_key_bytes,
        &threshold_bytes,
        &comparison_byte,
        &bump_byte,
    ]];

    let dest = if winner_is_maker {
        ctx.accounts.maker_ata.to_account_info()
    } else {
        ctx.accounts.taker_ata.to_account_info()
    };

    let pot = pos.pot;
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: dest,
                authority: ctx.accounts.market.to_account_info(),
            },
            market_seeds,
        ),
        pot,
    )?;

    ctx.accounts.position.settled = true;
    Ok(())
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub settler: Signer<'info>,
    #[account(has_one = mint)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        has_one = market,
        constraint = !position.settled @ ErrorCode::AlreadySettled,
    )]
    pub position: Account<'info, Position>,
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [VAULT_SEED, market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint)]
    pub maker_ata: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint)]
    pub taker_ata: Account<'info, TokenAccount>,
    /// CHECK: passed to the oracle CPI; validated by the oracle program.
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,
    /// CHECK: oracle program (mock in tests, real txoracle in prod).
    pub oracle_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}
