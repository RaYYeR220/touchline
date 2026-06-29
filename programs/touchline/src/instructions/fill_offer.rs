use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::constants::*;
use crate::error::ErrorCode;
use crate::state::*;

pub fn handler(
    ctx: Context<FillOffer>,
    _position_id: u64,
    fill_pot: u64,
) -> Result<()> {
    require!(fill_pot > 0, ErrorCode::ZeroAmount);
    require!(fill_pot <= MAX_POT_PER_FILL, ErrorCode::FillCapExceeded);
    require!(ctx.accounts.market.status == MarketStatus::Open, ErrorCode::MarketNotOpen);

    let offer = &ctx.accounts.offer;
    require!(fill_pot <= offer.remaining_pot, ErrorCode::InsufficientOffer);

    let new_total = ctx
        .accounts
        .market
        .total_pot
        .checked_add(fill_pot)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    require!(new_total <= MAX_POT_PER_MARKET, ErrorCode::MarketCapExceeded);

    let yes_stake = Predicate::yes_stake(fill_pot, offer.price_yes_bps)?;
    let taker_stake = match offer.maker_side {
        Side::Yes => fill_pot
            .checked_sub(yes_stake)
            .ok_or(error!(ErrorCode::MathOverflow))?,
        Side::No => yes_stake,
    };

    let maker_side = offer.maker_side;
    let price_yes_bps = offer.price_yes_bps;
    let maker = offer.maker;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.taker_ata.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.taker.to_account_info(),
            },
        ),
        taker_stake,
    )?;

    let offer = &mut ctx.accounts.offer;
    offer.remaining_pot = offer
        .remaining_pot
        .checked_sub(fill_pot)
        .ok_or(error!(ErrorCode::MathOverflow))?;

    ctx.accounts.market.total_pot = new_total;

    let pos = &mut ctx.accounts.position;
    pos.market = ctx.accounts.market.key();
    pos.maker = maker;
    pos.taker = ctx.accounts.taker.key();
    pos.price_yes_bps = price_yes_bps;
    pos.pot = fill_pot;
    pos.maker_side = maker_side;
    pos.settled = false;
    pos.bump = ctx.bumps.position;
    Ok(())
}

#[derive(Accounts)]
#[instruction(position_id: u64)]
pub struct FillOffer<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,
    #[account(mut, has_one = mint)]
    pub market: Account<'info, Market>,
    #[account(mut, has_one = market)]
    pub offer: Account<'info, Offer>,
    #[account(
        init,
        payer = taker,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, offer.key().as_ref(), &position_id.to_le_bytes()],
        bump
    )]
    pub position: Account<'info, Position>,
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = taker)]
    pub taker_ata: Account<'info, TokenAccount>,
    #[account(mut, seeds = [VAULT_SEED, market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
