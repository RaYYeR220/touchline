use anchor_lang::prelude::*;

#[constant]
pub const MARKET_SEED: &[u8] = b"market";
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";
#[constant]
pub const OFFER_SEED: &[u8] = b"offer";
#[constant]
pub const POSITION_SEED: &[u8] = b"position";

pub const BPS_DENOM: u64 = 10_000;
pub const MAX_POT_PER_FILL: u64 = 100_000_000;    // 100 USDC (6 decimals)
pub const MAX_POT_PER_MARKET: u64 = 5_000_000_000; // 5,000 USDC (6 decimals)
