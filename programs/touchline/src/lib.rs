pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("21zXPvXZYPnPu8sCSQ5b8Ly76DXNjWUS2MX8jQwgesLJ");

declare_program!(mock_oracle);
use mock_oracle::{cpi as mock_cpi, program::MockOracle};

#[program]
pub mod touchline {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        initialize::handler(ctx)
    }

    pub fn spike_read_bool(ctx: Context<SpikeReadBool>, value: bool) -> Result<()> {
        let cpi_ctx = CpiContext::new(
            ctx.accounts.mock_oracle_program.key(),
            mock_cpi::accounts::ReturnsBool {},
        );
        let returned: bool = mock_cpi::returns_bool(cpi_ctx, value)?.get();
        msg!("spike CPI returned: {}", returned);
        require!(returned == value, error::ErrorCode::CustomError);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct SpikeReadBool<'info> {
    pub mock_oracle_program: Program<'info, MockOracle>,
}
