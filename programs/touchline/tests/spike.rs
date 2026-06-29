//! Spike (GO/NO-GO): prove an Anchor 1.x program can CPI another program and
//! read the returned `bool` via the declare_program!-generated `.get()`.
//! Removed once the real `settle` lands.

use anchor_lang::{InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const TOUCHLINE_SO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/touchline.so");
const MOCK_SO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/mock_oracle.so");

#[test]
fn cpi_reads_returned_bool() {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(touchline::ID, TOUCHLINE_SO).unwrap();
    svm.add_program_from_file(mock_oracle::ID, MOCK_SO).unwrap();

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();

    let data = touchline::instruction::SpikeReadBool { value: true }.data();
    let metas = touchline::accounts::SpikeReadBool {
        mock_oracle_program: mock_oracle::ID,
    }
    .to_account_metas(None);
    let ix = Instruction {
        program_id: touchline::ID,
        accounts: metas,
        data,
    };

    let msg = Message::new(&[ix], Some(&payer.pubkey()));
    let tx = Transaction::new(&[&payer], msg, svm.latest_blockhash());
    let res = svm.send_transaction(tx).unwrap();

    assert!(
        res.logs.iter().any(|l| l.contains("spike CPI returned: true")),
        "expected spike log, got: {:?}",
        res.logs
    );
}
