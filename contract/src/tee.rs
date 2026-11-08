//! T0 SPIKE (cargo feature `tee`, off by default): verify a dstack (Intel TDX, Phala) attestation on-chain with
//! NearDeFi's `shade-attestation` crate (dcap-qvl inside). Measures whether the contract can do it and at what cost;
//! it grants nothing. TEE mode itself (registration, per-owner opt-in) is T1.

use near_sdk::serde_json::{self, Value};
use shade_attestation::attestation::{AcceptedDstackAttestation, DstackAttestation, VerificationError};
use shade_attestation::measurements::{FullMeasurements, FullMeasurementsHex};
use shade_attestation::report_data::ReportData;
use shade_attestation::tcb_info::HexBytes;

/// Verifies `attestation` (dstack JSON: quote bytes, collateral with hex fields, tcb_info) at `ts_sec`, accepting only
/// `measurements` and `ppid`. `report_data` must equal the quote's 64 report_data bytes.
pub fn verify(
    attestation: &DstackAttestation,
    report_data: [u8; 64],
    ts_sec: u64,
    measurements: FullMeasurements,
    ppid: [u8; 16],
) -> Result<AcceptedDstackAttestation, VerificationError> {
    attestation.verify(ReportData::from(report_data), ts_sec, &[measurements], &[HexBytes::from(ppid)])
}

pub fn parse_attestation(v: Value) -> DstackAttestation {
    serde_json::from_value(v).unwrap_or_else(|e| near_sdk::env::panic_str(&format!("attestation: {e}")))
}

pub fn parse_hex<const N: usize>(s: &str, what: &str) -> [u8; N] {
    hex::decode(s.trim_start_matches("0x"))
        .ok()
        .and_then(|v| v.try_into().ok())
        .unwrap_or_else(|| near_sdk::env::panic_str(&format!("{what}: expected {N} hex bytes")))
}

/// The measurements a dstack attestation reports for itself (what an owner would opt in to).
pub fn own_measurements(a: &DstackAttestation) -> FullMeasurementsHex {
    let t = &a.tcb_info;
    let key_provider = t
        .event_log
        .iter()
        .find(|e| e.event == "key-provider")
        .map(|e| e.digest.clone())
        .unwrap_or_default();
    serde_json::from_value(near_sdk::serde_json::json!({
        "rtmrs": { "mrtd": t.mrtd, "rtmr0": t.rtmr0, "rtmr1": t.rtmr1, "rtmr2": t.rtmr2 },
        "key_provider_event_digest": key_provider,
        "app_compose_hash_payload": t.compose_hash,
    }))
    .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    // A real TDX quote + collateral + tcb_info captured from a dstack (Phala) CVM: near/mpc
    // crates/test-utils/assets/public_data.json @ 50328c65 (2026-08-14), collateral byte arrays as hex.
    const FIXTURE: &str = include_str!("../tests/tee/attestation.json");
    /// near/mpc `VALID_ATTESTATION_TIMESTAMP`: the collateral (TCB info, QE identity, CRLs) has validity windows.
    pub const FIXTURE_TS: u64 = 1_786_622_400;
    /// The PPID dcap-qvl reports for the fixture's platform.
    pub const FIXTURE_PPID: &str = "d208dfb1002346ae1bb4ef2a3c055292";

    fn fixture() -> (DstackAttestation, [u8; 64], FullMeasurements) {
        let a = parse_attestation(serde_json::from_str(FIXTURE).unwrap());
        let rd: [u8; 64] = a.quote[568..632].try_into().unwrap(); // TD10 report body offset 48 + 520
        let m = own_measurements(&a).into();
        (a, rd, m)
    }

    fn ppid() -> [u8; 16] {
        parse_hex(FIXTURE_PPID, "ppid")
    }

    #[test]
    fn recorded_quote_passes_with_its_own_measurements() {
        let (a, rd, m) = fixture();
        let ok = verify(&a, rd, FIXTURE_TS, m, ppid()).expect("recorded quote verifies");
        assert_eq!(FullMeasurementsHex::from(ok.measurements), FullMeasurementsHex::from(m));
    }

    #[test]
    fn tampered_quote_fails() {
        let (mut a, rd, m) = fixture();
        let mut q: Vec<u8> = a.quote.clone().into();
        q[700] ^= 1; // inside the signed TD report body (an RTMR)
        a.quote = q.into();
        assert!(verify(&a, rd, FIXTURE_TS, m, ppid()).is_err());
    }

    #[test]
    fn wrong_measurements_fail() {
        let (a, rd, mut m) = fixture();
        m.rtmrs.rtmr2[0] ^= 1;
        assert!(matches!(verify(&a, rd, FIXTURE_TS, m, ppid()), Err(VerificationError::WrongHash { .. })));
        let (a, rd, mut m) = fixture();
        m.app_compose_hash_payload[0] ^= 1;
        assert!(verify(&a, rd, FIXTURE_TS, m, ppid()).is_err());
    }

    #[test]
    fn wrong_report_data_fails() {
        let (a, mut rd, m) = fixture();
        rd[0] ^= 1;
        assert!(matches!(verify(&a, rd, FIXTURE_TS, m, ppid()), Err(VerificationError::WrongHash { .. })));
    }

    #[test]
    fn wrong_ppid_fails() {
        let (a, rd, m) = fixture();
        assert!(verify(&a, rd, FIXTURE_TS, m, [7u8; 16]).is_err());
    }

    #[test]
    fn timestamp_outside_the_collateral_window_fails() {
        let (a, rd, m) = fixture();
        // today (2026-11-08) is past the recorded collateral's window: a fixture needs its fixed timestamp
        let today = 1_794_150_000;
        let r = verify(&a, rd, today, m, ppid());
        // measured: DcapVerification("TCBInfo expired"); production must pass the block time with fresh collateral
        assert!(matches!(&r, Err(VerificationError::DcapVerification(m)) if m.contains("expired")), "{:?}", r.as_ref().err());
        assert!(verify(&a, rd, 1_600_000_000, m, ppid()).is_err()); // before the certificates were issued
    }
}
