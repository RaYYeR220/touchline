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

// Touchline types
use touchline::txoracle::types::{
    BinaryExpression, ScoresBatchSummary, ScoresUpdateStats, ScoreStat, StatTerm,
};

const TOUCHLINE_SO: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/touchline.so");
const MOCK_SO: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/mock_oracle.so");

fn token_program_id() -> Pubkey {
    spl_token_interface::id()
}

fn system_program_id() -> Pubkey {
    Pubkey::default()
}

fn get_token_balance_raw(acc_data: &[u8]) -> u64 {
    u64::from_le_bytes(acc_data[64..72].try_into().unwrap())
}

// ---------------------------------------------------------------------------
// Minimal arg builders for the oracle CPI (mock ignores proofs).
// ---------------------------------------------------------------------------

fn empty_fixture_summary() -> ScoresBatchSummary {
    ScoresBatchSummary {
        fixture_id: 0,
        update_stats: ScoresUpdateStats {
            update_count: 0,
            min_timestamp: 0,
            max_timestamp: 0,
        },
        events_sub_tree_root: [0u8; 32],
    }
}

fn stat_term(value: i32) -> StatTerm {
    StatTerm {
        stat_to_prove: ScoreStat { key: 0, value, period: 0 },
        event_stat_root: [0u8; 32],
        stat_proof: vec![],
    }
}

// ---------------------------------------------------------------------------
// Test environment
// ---------------------------------------------------------------------------

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
        svm.add_program_from_file(mock_oracle::ID, MOCK_SO).unwrap();

        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();

        let mint_authority = Keypair::new();
        svm.airdrop(&mint_authority.pubkey(), 10_000_000_000).unwrap();

        let mint_kp = Keypair::new();
        let mint = mint_kp.pubkey();

        const MINT_LEN: usize = 82;
        let rent = svm.minimum_balance_for_rent_exemption(MINT_LEN);
        let create_mint_acc_ix = system_ix::create_account(
            &payer.pubkey(),
            &mint,
            rent,
            MINT_LEN as u64,
            &token_program_id(),
        );
        let init_mint_ix = token_ix::initialize_mint2(
            &token_program_id(),
            &mint,
            &mint_authority.pubkey(),
            None,
            6,
        )
        .unwrap();

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
        )
        .unwrap();
        let msg = Message::new(&[ix], Some(&self.payer.pubkey()));
        let tx = Transaction::new(
            &[&self.payer, &self.mint_authority],
            msg,
            self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx).expect("mint_to failed");
    }

    fn get_token_balance(&self, account: &Pubkey) -> u64 {
        let acc = self.svm.get_account(account).unwrap();
        get_token_balance_raw(&acc.data)
    }

    fn market_pda(&self, fixture_id: u64, stat_key: u32, threshold: i32, comparison: u8) -> Pubkey {
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
        .0
    }

    fn vault_pda(&self, market: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[b"vault", market.as_ref()], &touchline::ID).0
    }

    fn offer_pda(&self, market: &Pubkey, maker: &Pubkey, offer_id: u64) -> Pubkey {
        Pubkey::find_program_address(
            &[b"offer", market.as_ref(), maker.as_ref(), &offer_id.to_le_bytes()],
            &touchline::ID,
        )
        .0
    }

    fn position_pda(&self, offer: &Pubkey, position_id: u64) -> Pubkey {
        Pubkey::find_program_address(
            &[b"position", offer.as_ref(), &position_id.to_le_bytes()],
            &touchline::ID,
        )
        .0
    }
}

fn send_ix(
    svm: &mut LiteSVM,
    signers: &[&Keypair],
    data: Vec<u8>,
    metas: Vec<solana_instruction::AccountMeta>,
) {
    let ix = Instruction { program_id: touchline::ID, accounts: metas, data };
    let msg = Message::new(&[ix], Some(&signers[0].pubkey()));
    let tx = Transaction::new(signers, msg, svm.latest_blockhash());
    svm.send_transaction(tx).unwrap();
}

fn send_ix_result(
    svm: &mut LiteSVM,
    signers: &[&Keypair],
    data: Vec<u8>,
    metas: Vec<solana_instruction::AccountMeta>,
) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata> {
    let ix = Instruction { program_id: touchline::ID, accounts: metas, data };
    let msg = Message::new(&[ix], Some(&signers[0].pubkey()));
    let tx = Transaction::new(signers, msg, svm.latest_blockhash());
    svm.send_transaction(tx)
}

// ---------------------------------------------------------------------------
// Setup: create market, post offer (maker=YES), fill offer -> returns (market, vault, offer, position, maker_ata, taker_ata, maker, taker)
// ---------------------------------------------------------------------------

#[allow(dead_code)]
struct MatchedPosition {
    market_pda: Pubkey,
    vault_pda: Pubkey,
    offer_pda: Pubkey,
    position_pda: Pubkey,
    maker: Keypair,
    maker_ata: Pubkey,
    taker: Keypair,
    taker_ata: Pubkey,
    pot: u64,
}

fn setup_filled_position(env: &mut TestEnv, fixture_id: u64) -> MatchedPosition {
    let stat_key: u32 = 1;
    let threshold: i32 = 1;
    let comparison: u8 = 0; // GreaterThan

    let market_pda = env.market_pda(fixture_id, stat_key, threshold, comparison);
    let vault_pda = env.vault_pda(&market_pda);

    let predicate = touchline::state::Predicate {
        threshold,
        comparison: touchline::state::Comparison::GreaterThan,
    };

    // create_market
    let data = touchline::instruction::CreateMarket { fixture_id, stat_key, predicate, oracle_program: mock_oracle::ID }.data();
    let metas = touchline::accounts::CreateMarket {
        authority: env.payer.pubkey(),
        mint: env.mint,
        market: market_pda,
        vault: vault_pda,
        token_program: token_program_id(),
        system_program: system_program_id(),
    }
    .to_account_metas(None);
    send_ix(&mut env.svm, &[&env.payer], data, metas);

    // maker
    let maker = Keypair::new();
    env.svm.airdrop(&maker.pubkey(), 10_000_000_000).unwrap();
    let maker_ata = env.create_token_account(&maker.pubkey());
    env.mint_to(&maker_ata, 20_000_000);

    let offer_id: u64 = 1;
    let pot: u64 = 10_000_000; // 10 USDC
    let price_yes_bps: u16 = 6000; // maker=YES locks 6 USDC; taker=NO locks 4 USDC
    let offer_pda = env.offer_pda(&market_pda, &maker.pubkey(), offer_id);

    // post_offer
    let data = touchline::instruction::PostOffer {
        offer_id,
        maker_side: touchline::state::Side::Yes,
        price_yes_bps,
        pot,
    }
    .data();
    let metas = touchline::accounts::PostOffer {
        maker: maker.pubkey(),
        market: market_pda,
        offer: offer_pda,
        mint: env.mint,
        maker_ata,
        vault: vault_pda,
        token_program: token_program_id(),
        system_program: system_program_id(),
    }
    .to_account_metas(None);
    send_ix(&mut env.svm, &[&maker], data, metas);

    // taker
    let taker = Keypair::new();
    env.svm.airdrop(&taker.pubkey(), 10_000_000_000).unwrap();
    let taker_ata = env.create_token_account(&taker.pubkey());
    env.mint_to(&taker_ata, 20_000_000);

    let position_id: u64 = 1;
    let position_pda = env.position_pda(&offer_pda, position_id);

    // fill_offer
    let data = touchline::instruction::FillOffer { position_id, fill_pot: pot }.data();
    let metas = touchline::accounts::FillOffer {
        taker: taker.pubkey(),
        market: market_pda,
        offer: offer_pda,
        position: position_pda,
        mint: env.mint,
        taker_ata,
        vault: vault_pda,
        token_program: token_program_id(),
        system_program: system_program_id(),
    }
    .to_account_metas(None);
    send_ix(&mut env.svm, &[&taker], data, metas);

    MatchedPosition {
        market_pda,
        vault_pda,
        offer_pda,
        position_pda,
        maker,
        maker_ata,
        taker,
        taker_ata,
        pot,
    }
}

/// Flexible settle ix builder: lets a test override the payout ATAs and the
/// oracle program account to exercise the negative security paths.
#[allow(clippy::too_many_arguments)]
fn settle_ix_with(
    env: &mut TestEnv,
    mp: &MatchedPosition,
    settler: &Keypair,
    stat1: StatTerm,
    stat2: Option<StatTerm>,
    op: Option<BinaryExpression>,
    maker_ata: Pubkey,
    taker_ata: Pubkey,
    oracle_program: Pubkey,
) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata> {
    // Placeholder pubkey for daily_scores_merkle_roots (mock ignores it).
    let merkle_roots = Keypair::new().pubkey();

    let data = touchline::instruction::Settle {
        ts: 0i64,
        fixture_summary: empty_fixture_summary(),
        fixture_proof: vec![],
        main_tree_proof: vec![],
        stat1,
        stat2,
        op,
    }
    .data();
    let metas = touchline::accounts::Settle {
        settler: settler.pubkey(),
        market: mp.market_pda,
        position: mp.position_pda,
        mint: env.mint,
        vault: mp.vault_pda,
        maker_ata,
        taker_ata,
        daily_scores_merkle_roots: merkle_roots,
        oracle_program,
        token_program: token_program_id(),
    }
    .to_account_metas(None);

    send_ix_result(&mut env.svm, &[settler], data, metas)
}

/// Convenience wrapper: settle the matched position honestly with a single stat.
fn settle_ix(
    env: &mut TestEnv,
    mp: &MatchedPosition,
    settler: &Keypair,
    stat_value: i32,
) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata> {
    let (maker_ata, taker_ata) = (mp.maker_ata, mp.taker_ata);
    settle_ix_with(
        env,
        mp,
        settler,
        stat_term(stat_value),
        None,
        None,
        maker_ata,
        taker_ata,
        mock_oracle::ID,
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// YES wins: predicate "goals > 1", stat.value=2 -> mock returns true.
/// Maker (YES side) receives the full pot; vault drains to 0.
#[test]
fn test_settle_yes_wins() {
    let mut env = TestEnv::new();
    let settler = Keypair::new();
    env.svm.airdrop(&settler.pubkey(), 1_000_000_000).unwrap();

    let mp = setup_filled_position(&mut env, 100);

    let maker_before = env.get_token_balance(&mp.maker_ata);
    let taker_before = env.get_token_balance(&mp.taker_ata);
    let vault_before = env.get_token_balance(&mp.vault_pda);

    // stat.value = 2, threshold = 1, GreaterThan -> true -> YES (maker) wins
    settle_ix(&mut env, &mp, &settler, 2).expect("settle YES should succeed");

    let maker_after = env.get_token_balance(&mp.maker_ata);
    let taker_after = env.get_token_balance(&mp.taker_ata);
    let vault_after = env.get_token_balance(&mp.vault_pda);

    // Maker gains the full pot
    assert_eq!(maker_after - maker_before, mp.pot, "maker should receive full pot");
    // Taker gains nothing
    assert_eq!(taker_after, taker_before, "taker should receive nothing");
    // Vault is drained
    assert_eq!(vault_after, 0, "vault should be empty after settlement");
    // Escrow conservation: winner_gain == pot
    assert_eq!(maker_after - maker_before, vault_before, "winner gain == vault before");

    // position.settled = true
    let acc = env.svm.get_account(&mp.position_pda).unwrap();
    let pos = touchline::state::Position::try_deserialize(&mut &acc.data[..]).unwrap();
    assert!(pos.settled, "position should be marked settled");
}

/// NO wins: predicate "goals > 1", stat.value=0 -> mock returns false.
/// Taker (NO side) receives the full pot; maker receives nothing.
#[test]
fn test_settle_no_wins() {
    let mut env = TestEnv::new();
    let settler = Keypair::new();
    env.svm.airdrop(&settler.pubkey(), 1_000_000_000).unwrap();

    let mp = setup_filled_position(&mut env, 101);

    let maker_before = env.get_token_balance(&mp.maker_ata);
    let taker_before = env.get_token_balance(&mp.taker_ata);

    // stat.value = 0, threshold = 1, GreaterThan -> false -> NO (taker) wins
    settle_ix(&mut env, &mp, &settler, 0).expect("settle NO should succeed");

    let maker_after = env.get_token_balance(&mp.maker_ata);
    let taker_after = env.get_token_balance(&mp.taker_ata);
    let vault_after = env.get_token_balance(&mp.vault_pda);

    // Taker gains the full pot
    assert_eq!(taker_after - taker_before, mp.pot, "taker should receive full pot");
    // Maker gains nothing
    assert_eq!(maker_after, maker_before, "maker should receive nothing");
    // Vault drained
    assert_eq!(vault_after, 0, "vault should be empty after settlement");

    let acc = env.svm.get_account(&mp.position_pda).unwrap();
    let pos = touchline::state::Position::try_deserialize(&mut &acc.data[..]).unwrap();
    assert!(pos.settled);
}

/// Double-settle: second call on an already-settled position must fail
/// with the AlreadySettled error code (6008 = offset 8 in the touchline error enum).
#[test]
fn test_settle_double_settle_rejected() {
    let mut env = TestEnv::new();
    let settler = Keypair::new();
    env.svm.airdrop(&settler.pubkey(), 1_000_000_000).unwrap();

    let mp = setup_filled_position(&mut env, 102);

    // First settle succeeds
    settle_ix(&mut env, &mp, &settler, 2).expect("first settle should succeed");

    // Second settle must fail
    let result = settle_ix(&mut env, &mp, &settler, 2);
    let err = result.expect_err("second settle should fail");

    // Verify the error is AlreadySettled.
    // Anchor encodes custom errors as 6000 + variant_index.
    // AlreadySettled is variant index 8 in ErrorCode -> error code 6008.
    let logs_str = err.meta.logs.join(" ");
    assert!(
        logs_str.contains("AlreadySettled") || logs_str.contains("0x1778"),
        "expected AlreadySettled error, got logs: {}",
        logs_str,
    );
}

/// Vault fully drained after YES settlement (escrow conservation).
#[test]
fn test_settle_vault_drained() {
    let mut env = TestEnv::new();
    let settler = Keypair::new();
    env.svm.airdrop(&settler.pubkey(), 1_000_000_000).unwrap();

    let mp = setup_filled_position(&mut env, 103);

    assert_eq!(env.get_token_balance(&mp.vault_pda), mp.pot);

    settle_ix(&mut env, &mp, &settler, 2).expect("settle should succeed");

    assert_eq!(env.get_token_balance(&mp.vault_pda), 0);
}

/// C1 (CRITICAL): settle is permissionless, so an attacker tries to redirect the
/// winner's pot to their own same-mint token account by passing it as maker_ata.
/// The `token::authority = position.maker` constraint must reject it and the
/// vault must stay untouched.
#[test]
fn test_settle_rejects_attacker_maker_ata() {
    let mut env = TestEnv::new();
    let settler = Keypair::new();
    env.svm.airdrop(&settler.pubkey(), 1_000_000_000).unwrap();

    let mp = setup_filled_position(&mut env, 104);

    // Attacker owns a valid same-mint token account, but is neither maker nor taker.
    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let attacker_ata = env.create_token_account(&attacker.pubkey());

    let vault_before = env.get_token_balance(&mp.vault_pda);

    // stat.value = 2 -> YES wins -> maker is the winner; attacker substitutes
    // their account for maker_ata to steal the payout.
    let res = settle_ix_with(
        &mut env,
        &mp,
        &settler,
        stat_term(2),
        None,
        None,
        attacker_ata,
        mp.taker_ata,
        mock_oracle::ID,
    );
    assert!(res.is_err(), "settle with attacker maker_ata must be rejected");

    // Nothing moved: vault still holds the full pot, attacker got nothing.
    assert_eq!(env.get_token_balance(&mp.vault_pda), vault_before);
    assert_eq!(env.get_token_balance(&attacker_ata), 0);

    // Position remains unsettled (CEI: state change reverts with the tx).
    let acc = env.svm.get_account(&mp.position_pda).unwrap();
    let pos = touchline::state::Position::try_deserialize(&mut &acc.data[..]).unwrap();
    assert!(!pos.settled, "position must stay unsettled after a rejected settle");
}

/// C2 (CRITICAL): the oracle program account is pinned to the market's recorded
/// oracle (`address = market.oracle_program`). Passing any other program id must
/// be rejected before the CPI, so a forged oracle cannot fake a verdict.
#[test]
fn test_settle_rejects_wrong_oracle_program() {
    let mut env = TestEnv::new();
    let settler = Keypair::new();
    env.svm.airdrop(&settler.pubkey(), 1_000_000_000).unwrap();

    let mp = setup_filled_position(&mut env, 105);

    let vault_before = env.get_token_balance(&mp.vault_pda);

    // Use a different program id than the market's recorded oracle (mock_oracle::ID).
    let wrong_oracle = touchline::ID;
    let res = settle_ix_with(
        &mut env,
        &mp,
        &settler,
        stat_term(2),
        None,
        None,
        mp.maker_ata,
        mp.taker_ata,
        wrong_oracle,
    );
    assert!(res.is_err(), "settle with a non-pinned oracle program must be rejected");

    // Vault untouched.
    assert_eq!(env.get_token_balance(&mp.vault_pda), vault_before);
}

/// Two-stat (Add) path through the mock oracle: stat1 + stat2 = 1 + 1 = 2 > 1
/// -> YES wins -> maker receives the full pot. Exercises the binary-expression
/// branch of validate_stat.
#[test]
fn test_settle_two_stat_add_yes_wins() {
    let mut env = TestEnv::new();
    let settler = Keypair::new();
    env.svm.airdrop(&settler.pubkey(), 1_000_000_000).unwrap();

    let mp = setup_filled_position(&mut env, 106);

    let maker_before = env.get_token_balance(&mp.maker_ata);

    // predicate is "value > 1" (threshold 1, GreaterThan). 1 + 1 = 2 > 1 -> true.
    let res = settle_ix_with(
        &mut env,
        &mp,
        &settler,
        stat_term(1),
        Some(stat_term(1)),
        Some(BinaryExpression::Add),
        mp.maker_ata,
        mp.taker_ata,
        mock_oracle::ID,
    );
    res.expect("two-stat add settle should succeed");

    let maker_after = env.get_token_balance(&mp.maker_ata);
    assert_eq!(maker_after - maker_before, mp.pot, "maker should receive full pot");
    assert_eq!(env.get_token_balance(&mp.vault_pda), 0, "vault drained");
}
