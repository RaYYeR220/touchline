use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::constants::*;
use crate::error::ErrorCode;
use crate::state::*;

pub fn handler(ctx: Context<CancelOffer>) -> Result<()> {
    let offer = &ctx.accounts.offer;
    let yes_stake = Predicate::yes_stake(offer.remaining_pot, offer.price_yes_bps)?;
    let refund = match offer.maker_side {
        Side::Yes => yes_stake,
        Side::No => offer
            .remaining_pot
            .checked_sub(yes_stake)
            .ok_or(error!(ErrorCode::MathOverflow))?,
    };

    let market = &ctx.accounts.market;
    let market_seeds: &[&[&[u8]]] = &[&[
        MARKET_SEED,
        &market.fixture_id.to_le_bytes(),
        &market.stat_key.to_le_bytes(),
        &market.predicate.threshold.to_le_bytes(),
        &[market.predicate.comparison as u8],
        &[market.bump],
    ]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.maker_ata.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            market_seeds,
        ),
        refund,
    )?;
    Ok(())
}

#[derive(Accounts)]
pub struct CancelOffer<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(has_one = mint)]
    pub market: Account<'info, Market>,
    #[account(mut, has_one = maker, has_one = market, close = maker)]
    pub offer: Account<'info, Offer>,
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = maker)]
    pub maker_ata: Account<'info, TokenAccount>,
    #[account(mut, seeds = [VAULT_SEED, market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
