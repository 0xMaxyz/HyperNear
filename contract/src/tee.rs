//! TEE mode (opt-in per owner): an owner names the measurement of an agent image running in Intel TDX (dstack/Phala);
//! only an agent that proved that measurement on-chain may then act for the owner, and only it may approve HL trading
//! keys on the owner's legs. Attestations are verified with NearDeFi's shade-attestation (dcap-qvl), vendored.
//! State lives in ad hoc maps (like agent slots), so the root `Leash` layout and `OwnerState` are untouched.

use std::collections::BTreeMap;

use near_sdk::env;
use near_sdk::serde_json::{self, Value};
use near_sdk::store::LookupMap;
use near_sdk::{near, AccountId};
use shade_attestation::attestation::{AcceptedDstackAttestation, DstackAttestation, VerificationError};
use shade_attestation::measurements::{FullMeasurements, FullMeasurementsHex};
use shade_attestation::report_data::ReportData;

/// How long one attestation authorizes an agent account (one registration per boot).
pub const TEE_AGENT_TTL_NS: u64 = 7 * 86_400 * 1_000_000_000;
/// HL agent name of the TEE's trading key on every leg: approving a new key under it replaces the previous one.
pub const TEE_AGENT_NAME: &str = "leash-tee";
pub const MAX_TEE_MONTHS: u32 = 12;
pub const TEE_MONTH_NS: u64 = 30 * 86_400 * 1_000_000_000;

/// An owner's TEE mode. `measurement_hash` None = left TEE mode (the paid time is kept).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OwnerTee {
    pub measurement_hash: Option<String>,
    pub paid_until_ns: u64,
    /// cumulative months paid through payTee (the TEE agent checks the HL ledger holds at least months_paid x price)
    pub months_paid: u32,
    /// leg -> HL address of the TEE's current trading key there (approved through `tee_approve_agent`)
    pub keys: BTreeMap<u32, String>,
}

/// A NEAR account that proved, by a verified TDX attestation, that it runs the image with this measurement.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TeeAgent {
    pub measurement_hash: String,
    pub expires_ns: u64,
}

/// Price and fee address of TEE mode (set at init, or by the admin before the lock).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TeeConfig {
    /// micro-USD per month; 0 = not offered
    pub price_micro: u64,
    pub fee_address: Option<String>,
}

const TEE_CONFIG_KEY: &[u8] = b"tee_cfg";

pub fn config() -> TeeConfig {
    env::storage_read(TEE_CONFIG_KEY).map(|b| near_sdk::borsh::from_slice(&b).unwrap()).unwrap_or_default()
}

pub fn set_config(c: &TeeConfig) {
    env::storage_write(TEE_CONFIG_KEY, &near_sdk::borsh::to_vec(c).unwrap());
}

/// "0x" + hex of sha256(borsh(FullMeasurements)). Borsh writes the fixed arrays raw, in field order, so this is
/// sha256(mrtd || rtmr0 || rtmr1 || rtmr2 || key_provider_event_digest || app_compose_hash_payload), 272 bytes.
pub fn measurement_hash(m: &FullMeasurements) -> String {
    let b = near_sdk::borsh::to_vec(m).unwrap();
    debug_assert_eq!(b.len(), 48 * 5 + 32);
    format!("0x{}", hex::encode(env::sha256(&b)))
}

/// `0x` + 64 lowercase hex.
pub fn parse_hash(s: &str) -> String {
    let ok = s.len() == 66 && s.starts_with("0x") && s[2..].bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c));
    if !ok {
        env::panic_str(&format!("measurement hash must be 0x + 64 lowercase hex: {s}"));
    }
    s.to_string()
}

pub const ZERO_HASH: &str = "0x0000000000000000000000000000000000000000000000000000000000000000";

/// report_data a registering agent's quote must carry: its implicit account's ed25519 public key, zero-padded to 64.
pub fn implicit_report_data(account: &AccountId) -> [u8; 64] {
    let s = account.as_str();
    let pk: [u8; 32] = (s.len() == 64)
        .then(|| hex::decode(s).ok())
        .flatten()
        .and_then(|v| v.try_into().ok())
        .unwrap_or_else(|| env::panic_str("a TEE agent registers from its implicit account (64 hex chars = its ed25519 key)"));
    let mut rd = [0u8; 64];
    rd[..32].copy_from_slice(&pk);
    rd
}

pub fn parse_attestation(v: Value) -> DstackAttestation {
    serde_json::from_value(v).unwrap_or_else(|e| env::panic_str(&format!("attestation: {e}")))
}

pub fn parse_measurements(v: Value) -> FullMeasurements {
    serde_json::from_value::<FullMeasurementsHex>(v)
        .unwrap_or_else(|e| env::panic_str(&format!("measurements: {e}")))
        .into()
}

#[cfg(test)]
thread_local! {
    /// Tests only: (verify time in seconds, expected report_data). A recorded quote verifies only inside its
    /// collateral's validity window, and its report_data is whatever the recording node bound.
    pub static TEST_VERIFY_OVERRIDE: std::cell::Cell<Option<(u64, [u8; 64])>> = const { std::cell::Cell::new(None) };
}

/// Verifies `a` at the block time, for the predecessor's implicit-account key, accepting only `m`, any PPID.
pub fn verify_for_predecessor(a: &DstackAttestation, m: FullMeasurements) -> Result<AcceptedDstackAttestation, VerificationError> {
    #[allow(unused_mut)]
    let mut ts = env::block_timestamp() / 1_000_000_000;
    let mut rd = implicit_report_data(&env::predecessor_account_id());
    #[cfg(test)]
    if let Some((t, r)) = TEST_VERIFY_OVERRIDE.with(|c| c.get()) {
        ts = t;
        rd = r;
    }
    a.verify_any_ppid(ReportData::from(rd), ts, &[m])
}

/// owner -> TEE mode. Ad hoc maps (prefixes outside `Key`), flushed explicitly after writes.
pub fn owners() -> LookupMap<String, OwnerTee> {
    LookupMap::new(crate::Key::TeeOwners)
}

pub fn agents() -> LookupMap<AccountId, TeeAgent> {
    LookupMap::new(crate::Key::TeeAgents)
}

#[cfg(test)]
pub mod fixture {
    use super::*;

    // A real TDX quote + collateral + tcb_info captured from a dstack (Phala) CVM: near/mpc
    // crates/test-utils/assets/public_data.json @ 50328c65 (2026-08-14), collateral byte arrays as hex.
    pub const JSON: &str = include_str!("../tests/tee/attestation.json");
    /// near/mpc `VALID_ATTESTATION_TIMESTAMP`: the collateral (TCB info, QE identity, CRLs) has validity windows.
    pub const TS: u64 = 1_786_622_400;
    pub const PPID: &str = "d208dfb1002346ae1bb4ef2a3c055292";

    pub fn attestation_json() -> Value {
        serde_json::from_str(JSON).unwrap()
    }
    pub fn attestation() -> DstackAttestation {
        parse_attestation(attestation_json())
    }
    /// The 64 report_data bytes inside the quote (TD10 report body at 48, report_data at +520).
    pub fn report_data() -> [u8; 64] {
        attestation().quote[568..632].try_into().unwrap()
    }
    /// The measurements the fixture reports for itself, as the JSON an agent submits.
    pub fn measurements_json() -> Value {
        let t = attestation().tcb_info;
        let kp = t.event_log.iter().find(|e| e.event == "key-provider").unwrap().digest.clone();
        serde_json::json!({
            "rtmrs": { "mrtd": t.mrtd, "rtmr0": t.rtmr0, "rtmr1": t.rtmr1, "rtmr2": t.rtmr2 },
            "key_provider_event_digest": kp,
            "app_compose_hash_payload": t.compose_hash,
        })
    }
    pub fn measurements() -> FullMeasurements {
        parse_measurements(measurements_json())
    }
}

#[cfg(test)]
mod tests {
    use super::fixture::*;
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn at(ts: u64, report_data: [u8; 64]) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(format!("{}", "ab".repeat(32)).parse().unwrap()).build());
        TEST_VERIFY_OVERRIDE.with(|c| c.set(Some((ts, report_data))));
    }

    #[test]
    fn recorded_quote_passes_with_its_own_measurements_any_ppid() {
        at(TS, report_data());
        let ok = verify_for_predecessor(&attestation(), measurements()).expect("recorded quote verifies");
        assert_eq!(hex::encode(ok.ppid.as_ref()), PPID);
        assert_eq!(measurement_hash(&ok.measurements), measurement_hash(&measurements()));
    }

    #[test]
    fn tampered_quote_fails() {
        at(TS, report_data());
        let mut a = attestation();
        let mut q: Vec<u8> = a.quote.clone().into();
        q[700] ^= 1; // inside the signed TD report body (an RTMR)
        a.quote = q.into();
        assert!(verify_for_predecessor(&a, measurements()).is_err());
    }

    #[test]
    fn wrong_measurements_fail() {
        at(TS, report_data());
        let mut m = measurements();
        m.rtmrs.rtmr2[0] ^= 1;
        assert!(matches!(verify_for_predecessor(&attestation(), m), Err(VerificationError::WrongHash { .. })));
        let mut m = measurements();
        m.app_compose_hash_payload[0] ^= 1;
        assert!(verify_for_predecessor(&attestation(), m).is_err());
    }

    #[test]
    fn wrong_report_data_fails() {
        let mut rd = report_data();
        rd[0] ^= 1;
        at(TS, rd);
        assert!(matches!(verify_for_predecessor(&attestation(), measurements()), Err(VerificationError::WrongHash { .. })));
    }

    #[test]
    fn expired_collateral_fails() {
        at(1_794_150_000, report_data()); // 2026-11-08: past the recorded collateral's window
        let r = verify_for_predecessor(&attestation(), measurements());
        assert!(matches!(&r, Err(VerificationError::DcapVerification(m)) if m.contains("expired")), "{:?}", r.as_ref().err());
    }

    #[test]
    fn report_data_is_the_implicit_account_key_zero_padded() {
        let acc: AccountId = "ab".repeat(32).parse().unwrap();
        let rd = implicit_report_data(&acc);
        assert_eq!(&rd[..32], &[0xab; 32]);
        assert_eq!(&rd[32..], &[0u8; 32]);
    }

    #[test]
    #[should_panic(expected = "implicit account")]
    fn named_accounts_cannot_register() {
        implicit_report_data(&"agent.testnet".parse().unwrap());
    }
}
