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
    // Double-settle is rejected by the `position.settled` account constraint on
    // the Settle struct (single source of truth — no duplicate guard here).

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

    // Read the oracle's verdict from the CPI return data. Anchor sets return
    // data for bool return types via set_return_data, so the byte is 0=false,
    // 1=true. We fail closed: the origin program id MUST be the pinned oracle,
    // the payload MUST be exactly one byte, otherwise OracleRejected.
    //
    // I1 (mainnet integration / Plan 4): the real txoracle IDL has no `returns`
    // field and defines a `PredicateFailed` error, so in production a FALSE
    // predicate may REVERT instead of returning `false`. This get_return_data
    // path is correct against the mock (which returns a bool) and already fails
    // closed. Plan 4 must confirm whether txoracle.validate_stat returns `false`
    // or reverts on a false predicate; if it reverts, NO-outcome settlement will
    // need to CPI the negated predicate to obtain an affirmative `true`. Do not
    // change behavior here until that is verified on mainnet.
    let (ret_program, ret_data) =
        get_return_data().ok_or(ErrorCode::OracleRejected)?;
    require_keys_eq!(
        ret_program,
        ctx.accounts.oracle_program.key(),
        ErrorCode::OracleRejected
    );
    require!(ret_data.len() == 1, ErrorCode::OracleRejected);
    let yes: bool = ret_data[0] == 1;

    // Determine winner: maker wins if YES and maker=Yes, or NO and maker=No.
    // Copy the values out before mutating so CEI ordering holds below.
    let maker_side = ctx.accounts.position.maker_side;
    let pot = ctx.accounts.position.pot;
    let winner_is_maker =
        (yes && maker_side == Side::Yes) || (!yes && maker_side == Side::No);

    // CEI: record the state change BEFORE the external token transfer.
    ctx.accounts.position.settled = true;

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
    #[account(mut, token::mint = mint, token::authority = position.maker)]
    pub maker_ata: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = position.taker)]
    pub taker_ata: Account<'info, TokenAccount>,
    /// CHECK: passed to the oracle CPI; validated by the oracle program.
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,
    #[account(address = market.oracle_program)]
    /// CHECK: pinned to the market's recorded oracle program; only a CPI target.
    pub oracle_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}
