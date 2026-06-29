use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Side {
    Yes,
    No,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum MarketStatus {
    Open,
    Settled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Comparison {
    GreaterThan,
    LessThan,
    EqualTo,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct Predicate {
    pub threshold: i32,
    pub comparison: Comparison,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub authority: Pubkey,
    pub fixture_id: u64,
    pub stat_key: u32,
    pub predicate: Predicate,
    pub mint: Pubkey,
    pub oracle_program: Pubkey,
    pub status: MarketStatus,
    pub total_pot: u64,
    pub vault_bump: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Offer {
    pub market: Pubkey,
    pub maker: Pubkey,
    pub maker_side: Side,
    pub price_yes_bps: u16,
    pub remaining_pot: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub market: Pubkey,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub price_yes_bps: u16,
    pub pot: u64,
    pub maker_side: Side,
    pub settled: bool,
    pub bump: u8,
}

impl Predicate {
    /// YES-side stake for a given pot at given price_yes_bps.
    pub fn yes_stake(pot: u64, price_yes_bps: u16) -> Result<u64> {
        pot.checked_mul(price_yes_bps as u64)
            .and_then(|v| v.checked_div(crate::constants::BPS_DENOM))
            .ok_or(error!(crate::error::ErrorCode::MathOverflow))
    }
}
