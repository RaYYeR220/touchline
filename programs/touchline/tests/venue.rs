use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_associated_token_account_interface::address::get_associated_token_address;
use spl_associated_token_account_interface::instruction::create_associated_token_account;
use spl_token_interface::instruction as token_ix;
use solana_system_interface::instruction as system_ix;

const TOUCHLINE_SO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/touchline.so");

fn token_program_id() -> Pubkey {
    spl_token_interface::id()
}

fn ata_program_id() -> Pubkey {
    spl_associated_token_account_interface::program::id()
}

fn system_program_id() -> Pubkey {
    Pubkey::default()
}

fn get_token_balance_raw(acc_data: &[u8]) -> u64 {
    u64::from_le_bytes(acc_data[64..72].try_into().unwrap())
}

struct TestEnv {
    svm: LiteSVM,
    payer: Keypair,
    mint: Pubkey,
    mint_authority: Keypair,
}

impl TestEnv {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(touchline::ID, TOUCHLINE_SO).unwrap();

        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();

        let mint_authority = Keypair::new();
        svm.airdrop(&mint_authority.pubkey(), 10_000_000_000).unwrap();

        let mint_kp = Keypair::new();
        let mint = mint_kp.pubkey();

        // Create mint account (Mint::LEN = 82)
        const MINT_LEN: usize = 82;
        let mint_space = MINT_LEN as u64;
        let rent = svm.minimum_balance_for_rent_exemption(MINT_LEN);
        let create_mint_acc_ix = system_ix::create_account(
            &payer.pubkey(),
            &mint,
            rent,
            mint_space,
            &token_program_id(),
        );
        let init_mint_ix = token_ix::initialize_mint2(
            &token_program_id(),
            &mint,
            &mint_authority.pubkey(),
            None,
            6,
        ).unwrap();

        let msg = Message::new(&[create_mint_acc_ix, init_mint_ix], Some(&payer.pubkey()));
        let tx = Transaction::new(&[&payer, &mint_kp], msg, svm.latest_blockhash());
        svm.send_transaction(tx).expect("create mint failed");

        TestEnv { svm, payer, mint, mint_authority }
    }

    fn create_token_account(&mut self, owner: &Pubkey) -> Pubkey {
        let ata = get_associated_token_address(owner, &self.mint);
        let create_ix = create_associated_token_account(
            &self.payer.pubkey(),
            owner,
            &self.mint,
            &token_program_id(),
        );
        let msg = Message::new(&[create_ix], Some(&self.payer.pubkey()));
        let tx = Transaction::new(&[&self.payer], msg, self.svm.latest_blockhash());
        self.svm.send_transaction(tx).expect("create ATA failed");
        ata
    }

    fn mint_to(&mut self, dest: &Pubkey, amount: u64) {
        let ix = token_ix::mint_to(
            &token_program_id(),
            &self.mint,
            dest,
            &self.mint_authority.pubkey(),
            &[],
            amount,
        ).unwrap();
        let msg = Message::new(&[ix], Some(&self.payer.pubkey()));
        let tx = Transaction::new(&[&self.payer, &self.mint_authority], msg, self.svm.latest_blockhash());
        self.svm.send_transaction(tx).expect("mint_to failed");
    }

    fn get_token_balance(&self, account: &Pubkey) -> u64 {
        let acc = self.svm.get_account(account).unwrap();
        get_token_balance_raw(&acc.data)
    }

    fn market_pda(&self, fixture_id: u64, stat_key: u32, threshold: i32, comparison: u8) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[
                b"market",
                &fixture_id.to_le_bytes(),
                &stat_key.to_le_bytes(),
                &threshold.to_le_bytes(),
                &[comparison],
            ],
            &touchline::ID,
        )
    }

    fn vault_pda(&self, market: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[b"vault", market.as_ref()],
            &touchline::ID,
        )
    }

    fn offer_pda(&self, market: &Pubkey, maker: &Pubkey, offer_id: u64) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[b"offer", market.as_ref(), maker.as_ref(), &offer_id.to_le_bytes()],
            &touchline::ID,
        )
    }

    fn position_pda(&self, offer: &Pubkey, position_id: u64) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[b"position", offer.as_ref(), &position_id.to_le_bytes()],
            &touchline::ID,
        )
    }
}

fn send_ix(svm: &mut LiteSVM, signers: &[&Keypair], data: Vec<u8>, metas: Vec<solana_instruction::AccountMeta>) {
    let ix = Instruction { program_id: touchline::ID, accounts: metas, data };
    let msg = Message::new(&[ix], Some(&signers[0].pubkey()));
    let tx = Transaction::new(signers, msg, svm.latest_blockhash());
    svm.send_transaction(tx).unwrap();
}

fn send_ix_expect_err(svm: &mut LiteSVM, signers: &[&Keypair], data: Vec<u8>, metas: Vec<solana_instruction::AccountMeta>) {
    let ix = Instruction { program_id: touchline::ID, accounts: metas, data };
    let msg = Message::new(&[ix], Some(&signers[0].pubkey()));
    let tx = Transaction::new(signers, msg, svm.latest_blockhash());
    assert!(svm.send_transaction(tx).is_err(), "expected transaction to fail");
}

#[test]
fn test_create_market() {
    let mut env = TestEnv::new();

    let fixture_id: u64 = 18172280;
    let stat_key: u32 = 1;
    let threshold: i32 = 1;
    let comparison: u8 = 0; // GreaterThan

    let (market_pda, _) = env.market_pda(fixture_id, stat_key, threshold, comparison);
    let (vault_pda, _) = env.vault_pda(&market_pda);

    let predicate = touchline::state::Predicate {
        threshold,
        comparison: touchline::state::Comparison::GreaterThan,
    };

    let data = touchline::instruction::CreateMarket { fixture_id, stat_key, predicate }.data();
    let metas = touchline::accounts::CreateMarket {
        authority: env.payer.pubkey(),
        mint: env.mint,
        market: market_pda,
        vault: vault_pda,
        token_program: token_program_id(),
        system_program: system_program_id(),
    }.to_account_metas(None);

    send_ix(&mut env.svm, &[&env.payer], data, metas);

    // Verify market account
    let acc = env.svm.get_account(&market_pda).unwrap();
    let market = touchline::state::Market::try_deserialize(&mut &acc.data[..]).unwrap();
    assert_eq!(market.fixture_id, fixture_id);
    assert_eq!(market.stat_key, stat_key);
    assert_eq!(market.predicate.threshold, threshold);
    assert_eq!(market.status, touchline::state::MarketStatus::Open);
    assert_eq!(market.total_pot, 0);
    assert_eq!(market.mint, env.mint);

    // Verify vault account exists
    assert!(env.svm.get_account(&vault_pda).is_some());
}

#[test]
fn test_post_offer_locks_maker_stake() {
    let mut env = TestEnv::new();
    let maker = Keypair::new();
    env.svm.airdrop(&maker.pubkey(), 10_000_000_000).unwrap();

    // Create market first
    let fixture_id: u64 = 1;
    let stat_key: u32 = 1;
    let threshold: i32 = 2;
    let comparison: u8 = 0;
    let (market_pda, _) = env.market_pda(fixture_id, stat_key, threshold, comparison);
    let (vault_pda, _) = env.vault_pda(&market_pda);

    let predicate = touchline::state::Predicate {
        threshold,
        comparison: touchline::state::Comparison::GreaterThan,
    };

    let data = touchline::instruction::CreateMarket { fixture_id, stat_key, predicate }.data();
    let metas = touchline::accounts::CreateMarket {
        authority: env.payer.pubkey(),
        mint: env.mint,
        market: market_pda,
        vault: vault_pda,
        token_program: token_program_id(),
        system_program: system_program_id(),
    }.to_account_metas(None);
    send_ix(&mut env.svm, &[&env.payer], data, metas);

    // Create maker ATA and fund it
    let maker_ata = env.create_token_account(&maker.pubkey());
    env.mint_to(&maker_ata, 20_000_000); // 20 USDC

    // Post offer: maker=YES, pot=10 USDC, price_yes=6000 bps (60%)
    // maker_stake = 10 * 6000 / 10000 = 6 USDC
    let offer_id: u64 = 1;
    let pot: u64 = 10_000_000;
    let price_yes_bps: u16 = 6000;
    let (offer_pda, _) = env.offer_pda(&market_pda, &maker.pubkey(), offer_id);

    let data = touchline::instruction::PostOffer {
        offer_id,
        maker_side: touchline::state::Side::Yes,
        price_yes_bps,
        pot,
    }.data();
    let metas = touchline::accounts::PostOffer {
        maker: maker.pubkey(),
        market: market_pda,
        offer: offer_pda,
        mint: env.mint,
        maker_ata,
        vault: vault_pda,
        token_program: token_program_id(),
        system_program: system_program_id(),
    }.to_account_metas(None);
    send_ix(&mut env.svm, &[&maker], data, metas);

    // Verify offer
    let acc = env.svm.get_account(&offer_pda).unwrap();
    let offer = touchline::state::Offer::try_deserialize(&mut &acc.data[..]).unwrap();
    assert_eq!(offer.remaining_pot, pot);
    assert_eq!(offer.maker_side, touchline::state::Side::Yes);
    assert_eq!(offer.price_yes_bps, price_yes_bps);

    // Vault holds 6 USDC
    assert_eq!(env.get_token_balance(&vault_pda), 6_000_000);
    // Maker has 14 USDC remaining
    assert_eq!(env.get_token_balance(&maker_ata), 14_000_000);
}

#[test]
fn test_cancel_offer_refunds_maker() {
    let mut env = TestEnv::new();
    let maker = Keypair::new();
    env.svm.airdrop(&maker.pubkey(), 10_000_000_000).unwrap();

    let fixture_id: u64 = 2;
    let stat_key: u32 = 1;
    let threshold: i32 = 1;
    let comparison: u8 = 0;
    let (market_pda, _) = env.market_pda(fixture_id, stat_key, threshold, comparison);
    let (vault_pda, _) = env.vault_pda(&market_pda);
    let predicate = touchline::state::Predicate { threshold, comparison: touchline::state::Comparison::GreaterThan };

    // Create market
    let data = touchline::instruction::CreateMarket { fixture_id, stat_key, predicate }.data();
    let metas = touchline::accounts::CreateMarket {
        authority: env.payer.pubkey(), mint: env.mint, market: market_pda, vault: vault_pda,
        token_program: token_program_id(), system_program: system_program_id(),
    }.to_account_metas(None);
    send_ix(&mut env.svm, &[&env.payer], data, metas);

    // Fund maker and post offer
    let maker_ata = env.create_token_account(&maker.pubkey());
    env.mint_to(&maker_ata, 20_000_000);
    let offer_id: u64 = 1;
    let pot: u64 = 10_000_000;
    let price_yes_bps: u16 = 6000;
    let (offer_pda, _) = env.offer_pda(&market_pda, &maker.pubkey(), offer_id);

    let data = touchline::instruction::PostOffer {
        offer_id, maker_side: touchline::state::Side::Yes, price_yes_bps, pot,
    }.data();
    let metas = touchline::accounts::PostOffer {
        maker: maker.pubkey(), market: market_pda, offer: offer_pda, mint: env.mint,
        maker_ata, vault: vault_pda, token_program: token_program_id(), system_program: system_program_id(),
    }.to_account_metas(None);
    send_ix(&mut env.svm, &[&maker], data, metas);

    let balance_before = env.get_token_balance(&maker_ata);

    // Cancel offer
    let data = touchline::instruction::CancelOffer {}.data();
    let metas = touchline::accounts::CancelOffer {
        maker: maker.pubkey(), market: market_pda, offer: offer_pda, mint: env.mint,
        maker_ata, vault: vault_pda, token_program: token_program_id(),
    }.to_account_metas(None);
    send_ix(&mut env.svm, &[&maker], data, metas);

    let balance_after = env.get_token_balance(&maker_ata);
    // Maker should get back 6 USDC (the YES stake)
    assert_eq!(balance_after - balance_before, 6_000_000);

    // Offer account should be closed
    assert!(env.svm.get_account(&offer_pda).is_none());
}

#[test]
fn test_fill_offer_escrows_both_sides() {
    let mut env = TestEnv::new();
    let maker = Keypair::new();
    let taker = Keypair::new();
    env.svm.airdrop(&maker.pubkey(), 10_000_000_000).unwrap();
    env.svm.airdrop(&taker.pubkey(), 10_000_000_000).unwrap();

    let fixture_id: u64 = 3;
    let stat_key: u32 = 1;
    let threshold: i32 = 1;
    let comparison: u8 = 0;
    let (market_pda, _) = env.market_pda(fixture_id, stat_key, threshold, comparison);
    let (vault_pda, _) = env.vault_pda(&market_pda);
    let predicate = touchline::state::Predicate { threshold, comparison: touchline::state::Comparison::GreaterThan };

    // Create market
    let data = touchline::instruction::CreateMarket { fixture_id, stat_key, predicate }.data();
    let metas = touchline::accounts::CreateMarket {
        authority: env.payer.pubkey(), mint: env.mint, market: market_pda, vault: vault_pda,
        token_program: token_program_id(), system_program: system_program_id(),
    }.to_account_metas(None);
    send_ix(&mut env.svm, &[&env.payer], data, metas);

    // Fund maker, post offer
    let maker_ata = env.create_token_account(&maker.pubkey());
    env.mint_to(&maker_ata, 20_000_000);
    let offer_id: u64 = 1;
    let pot: u64 = 10_000_000;
    let price_yes_bps: u16 = 6000;
    let (offer_pda, _) = env.offer_pda(&market_pda, &maker.pubkey(), offer_id);

    let data = touchline::instruction::PostOffer {
        offer_id, maker_side: touchline::state::Side::Yes, price_yes_bps, pot,
    }.data();
    let metas = touchline::accounts::PostOffer {
        maker: maker.pubkey(), market: market_pda, offer: offer_pda, mint: env.mint,
        maker_ata, vault: vault_pda, token_program: token_program_id(), system_program: system_program_id(),
    }.to_account_metas(None);
    send_ix(&mut env.svm, &[&maker], data, metas);

    // Fund taker and fill offer
    let taker_ata = env.create_token_account(&taker.pubkey());
    env.mint_to(&taker_ata, 20_000_000);

    let fill_pot: u64 = 10_000_000; // Fill the whole pot
    let position_id: u64 = 1;
    let (position_pda, _) = env.position_pda(&offer_pda, position_id);

    let data = touchline::instruction::FillOffer { position_id, fill_pot }.data();
    let metas = touchline::accounts::FillOffer {
        taker: taker.pubkey(), market: market_pda, offer: offer_pda, position: position_pda,
        mint: env.mint, taker_ata, vault: vault_pda, token_program: token_program_id(),
        system_program: system_program_id(),
    }.to_account_metas(None);
    send_ix(&mut env.svm, &[&taker], data, metas);

    // Verify position
    let acc = env.svm.get_account(&position_pda).unwrap();
    let pos = touchline::state::Position::try_deserialize(&mut &acc.data[..]).unwrap();
    assert_eq!(pos.pot, fill_pot);
    assert_eq!(pos.price_yes_bps, price_yes_bps);
    assert_eq!(pos.maker_side, touchline::state::Side::Yes);
    assert!(!pos.settled);

    // Vault holds full pot (6 YES + 4 NO = 10 USDC)
    assert_eq!(env.get_token_balance(&vault_pda), 10_000_000);

    // Market total_pot updated
    let acc = env.svm.get_account(&market_pda).unwrap();
    let market = touchline::state::Market::try_deserialize(&mut &acc.data[..]).unwrap();
    assert_eq!(market.total_pot, fill_pot);

    // Taker has 16 USDC remaining (paid 4 USDC NO stake)
    assert_eq!(env.get_token_balance(&taker_ata), 16_000_000);
}

#[test]
fn test_fill_cap_per_fill_rejected() {
    let mut env = TestEnv::new();
    let maker = Keypair::new();
    let taker = Keypair::new();
    env.svm.airdrop(&maker.pubkey(), 10_000_000_000).unwrap();
    env.svm.airdrop(&taker.pubkey(), 10_000_000_000).unwrap();

    let fixture_id: u64 = 4;
    let stat_key: u32 = 1;
    let threshold: i32 = 1;
    let comparison: u8 = 0;
    let (market_pda, _) = env.market_pda(fixture_id, stat_key, threshold, comparison);
    let (vault_pda, _) = env.vault_pda(&market_pda);
    let predicate = touchline::state::Predicate { threshold, comparison: touchline::state::Comparison::GreaterThan };

    let data = touchline::instruction::CreateMarket { fixture_id, stat_key, predicate }.data();
    let metas = touchline::accounts::CreateMarket {
        authority: env.payer.pubkey(), mint: env.mint, market: market_pda, vault: vault_pda,
        token_program: token_program_id(), system_program: system_program_id(),
    }.to_account_metas(None);
    send_ix(&mut env.svm, &[&env.payer], data, metas);

    // Post offer with a large pot (200 USDC, well above MAX_POT_PER_FILL = 100 USDC)
    let maker_ata = env.create_token_account(&maker.pubkey());
    env.mint_to(&maker_ata, 200_000_000);
    let offer_id: u64 = 1;
    let pot: u64 = 200_000_000; // 200 USDC
    let price_yes_bps: u16 = 5000;
    let (offer_pda, _) = env.offer_pda(&market_pda, &maker.pubkey(), offer_id);

    let data = touchline::instruction::PostOffer {
        offer_id, maker_side: touchline::state::Side::Yes, price_yes_bps, pot,
    }.data();
    let metas = touchline::accounts::PostOffer {
        maker: maker.pubkey(), market: market_pda, offer: offer_pda, mint: env.mint,
        maker_ata, vault: vault_pda, token_program: token_program_id(), system_program: system_program_id(),
    }.to_account_metas(None);
    send_ix(&mut env.svm, &[&maker], data, metas);

    // Try to fill with > MAX_POT_PER_FILL (200 USDC > 100 USDC cap)
    let taker_ata = env.create_token_account(&taker.pubkey());
    env.mint_to(&taker_ata, 200_000_000);

    let fill_pot: u64 = 200_000_000; // 200 USDC - exceeds cap
    let position_id: u64 = 1;
    let (position_pda, _) = env.position_pda(&offer_pda, position_id);

    let data = touchline::instruction::FillOffer { position_id, fill_pot }.data();
    let metas = touchline::accounts::FillOffer {
        taker: taker.pubkey(), market: market_pda, offer: offer_pda, position: position_pda,
        mint: env.mint, taker_ata, vault: vault_pda, token_program: token_program_id(),
        system_program: system_program_id(),
    }.to_account_metas(None);
    send_ix_expect_err(&mut env.svm, &[&taker], data, metas);
}

#[test]
fn test_post_offer_invalid_price_rejected() {
    let mut env = TestEnv::new();

    let fixture_id: u64 = 5;
    let stat_key: u32 = 1;
    let threshold: i32 = 1;
    let comparison: u8 = 0;
    let (market_pda, _) = env.market_pda(fixture_id, stat_key, threshold, comparison);
    let (vault_pda, _) = env.vault_pda(&market_pda);
    let predicate = touchline::state::Predicate { threshold, comparison: touchline::state::Comparison::GreaterThan };

    let data = touchline::instruction::CreateMarket { fixture_id, stat_key, predicate }.data();
    let metas = touchline::accounts::CreateMarket {
        authority: env.payer.pubkey(), mint: env.mint, market: market_pda, vault: vault_pda,
        token_program: token_program_id(), system_program: system_program_id(),
    }.to_account_metas(None);
    send_ix(&mut env.svm, &[&env.payer], data, metas);

    let maker = Keypair::new();
    env.svm.airdrop(&maker.pubkey(), 10_000_000_000).unwrap();
    let maker_ata = env.create_token_account(&maker.pubkey());
    env.mint_to(&maker_ata, 10_000_000);
    let offer_id: u64 = 1;
    let (offer_pda, _) = env.offer_pda(&market_pda, &maker.pubkey(), offer_id);

    // price_yes_bps = 0 -> rejected
    let data = touchline::instruction::PostOffer {
        offer_id, maker_side: touchline::state::Side::Yes, price_yes_bps: 0, pot: 10_000_000,
    }.data();
    let metas = touchline::accounts::PostOffer {
        maker: maker.pubkey(), market: market_pda, offer: offer_pda, mint: env.mint,
        maker_ata, vault: vault_pda, token_program: token_program_id(), system_program: system_program_id(),
    }.to_account_metas(None);
    send_ix_expect_err(&mut env.svm, &[&maker], data, metas);

    // price_yes_bps = 10000 -> rejected
    let data = touchline::instruction::PostOffer {
        offer_id, maker_side: touchline::state::Side::Yes, price_yes_bps: 10000, pot: 10_000_000,
    }.data();
    let metas = touchline::accounts::PostOffer {
        maker: maker.pubkey(), market: market_pda, offer: offer_pda, mint: env.mint,
        maker_ata, vault: vault_pda, token_program: token_program_id(), system_program: system_program_id(),
    }.to_account_metas(None);
    send_ix_expect_err(&mut env.svm, &[&maker], data, metas);
}
