pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("7uQHgENc27tcpP1svYShb6XUgxdzQTEX8xXrWDKUk57S");

#[program]
pub mod mock_oracle {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        initialize::handler(ctx)
    }

    pub fn returns_bool(_ctx: Context<NoAccounts>, value: bool) -> Result<bool> {
        Ok(value)
    }
}

#[derive(Accounts)]
pub struct NoAccounts {}
