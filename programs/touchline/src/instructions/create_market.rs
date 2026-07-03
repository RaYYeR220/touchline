use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::constants::*;
use crate::state::*;

pub fn handler(
    ctx: Context<CreateMarket>,
    fixture_id: u64,
    stat_key: u32,
    predicate: Predicate,
    oracle_program: Pubkey,
) -> Result<()> {
    let m = &mut ctx.accounts.market;
    m.authority = ctx.accounts.authority.key();
    m.fixture_id = fixture_id;
    m.stat_key = stat_key;
    m.predicate = predicate;
    m.mint = ctx.accounts.mint.key();
    m.oracle_program = oracle_program;
    m.status = MarketStatus::Open;
    m.total_pot = 0;
    m.vault_bump = ctx.bumps.vault;
    m.bump = ctx.bumps.market;
    Ok(())
}

#[derive(Accounts)]
#[instruction(fixture_id: u64, stat_key: u32, predicate: Predicate)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(constraint = mint.decimals == 6 @ crate::error::ErrorCode::WrongMint)]
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = authority,
        space = 8 + Market::INIT_SPACE,
        seeds = [
            MARKET_SEED,
            &fixture_id.to_le_bytes(),
            &stat_key.to_le_bytes(),
            &predicate.threshold.to_le_bytes(),
            &[predicate.comparison as u8],
        ],
        bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        init,
        payer = authority,
        token::mint = mint,
        token::authority = market,
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
