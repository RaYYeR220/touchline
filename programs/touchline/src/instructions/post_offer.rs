use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::constants::*;
use crate::error::ErrorCode;
use crate::state::*;

pub fn handler(
    ctx: Context<PostOffer>,
    _offer_id: u64,
    maker_side: Side,
    price_yes_bps: u16,
    pot: u64,
) -> Result<()> {
    require!(price_yes_bps >= 1 && price_yes_bps <= 9999, ErrorCode::InvalidPrice);
    require!(pot > 0, ErrorCode::ZeroAmount);
    require!(ctx.accounts.market.status == MarketStatus::Open, ErrorCode::MarketNotOpen);

    let yes_stake = Predicate::yes_stake(pot, price_yes_bps)?;
    let maker_stake = match maker_side {
        Side::Yes => yes_stake,
        Side::No => pot.checked_sub(yes_stake).ok_or(error!(ErrorCode::MathOverflow))?,
    };

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.maker_ata.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.maker.to_account_info(),
            },
        ),
        maker_stake,
    )?;

    let offer = &mut ctx.accounts.offer;
    offer.market = ctx.accounts.market.key();
    offer.maker = ctx.accounts.maker.key();
    offer.maker_side = maker_side;
    offer.price_yes_bps = price_yes_bps;
    offer.remaining_pot = pot;
    offer.bump = ctx.bumps.offer;
    Ok(())
}

#[derive(Accounts)]
#[instruction(offer_id: u64)]
pub struct PostOffer<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(mut, has_one = mint)]
    pub market: Account<'info, Market>,
    #[account(
        init,
        payer = maker,
        space = 8 + Offer::INIT_SPACE,
        seeds = [OFFER_SEED, market.key().as_ref(), maker.key().as_ref(), &offer_id.to_le_bytes()],
        bump
    )]
    pub offer: Account<'info, Offer>,
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = maker)]
    pub maker_ata: Account<'info, TokenAccount>,
    #[account(mut, seeds = [VAULT_SEED, market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
