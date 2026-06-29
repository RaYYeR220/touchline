use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Custom error message")]
    CustomError,
    #[msg("price must be within 1..=9999 bps")]
    InvalidPrice,
    #[msg("amount must be non-zero")]
    ZeroAmount,
    #[msg("arithmetic overflow")]
    MathOverflow,
    #[msg("fill exceeds per-fill cap")]
    FillCapExceeded,
    #[msg("market pot exceeds per-market cap")]
    MarketCapExceeded,
    #[msg("offer has insufficient remaining pot")]
    InsufficientOffer,
    #[msg("market is not open")]
    MarketNotOpen,
    #[msg("position already settled")]
    AlreadySettled,
    #[msg("oracle rejected: predicate not verifiable")]
    OracleRejected,
    #[msg("wrong mint")]
    WrongMint,
}
