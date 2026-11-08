//! EIP-712 digests for Hyperliquid "user-signed" actions.
//! Type strings copied from hyperliquid-python-sdk `hyperliquid/utils/signing.py`
//! (`user_signed_payload`, `sign_agent`, USD_SEND / WITHDRAW / USD_CLASS_TRANSFER_SIGN_TYPES).

use near_sdk::env::{self, keccak256_array};
use near_sdk::near;

/// HL accepts any signatureChainId; its SDK uses 0x66eee (421614) for both networks.
pub const HL_SIGNATURE_CHAIN_ID: u64 = 0x66eee;

const DOMAIN_TYPE: &[u8] =
    b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const APPROVE_AGENT_TYPE: &[u8] = b"HyperliquidTransaction:ApproveAgent(string hyperliquidChain,address agentAddress,string agentName,uint64 nonce)";
const USD_SEND_TYPE: &[u8] =
    b"HyperliquidTransaction:UsdSend(string hyperliquidChain,string destination,string amount,uint64 time)";
const WITHDRAW_TYPE: &[u8] =
    b"HyperliquidTransaction:Withdraw(string hyperliquidChain,string destination,string amount,uint64 time)";
const USD_CLASS_TRANSFER_TYPE: &[u8] =
    b"HyperliquidTransaction:UsdClassTransfer(string hyperliquidChain,string amount,bool toPerp,uint64 nonce)";

/// A Hyperliquid user-signed action, in HL's own `/exchange` JSON shape minus
/// `signatureChainId` / `hyperliquidChain` (the contract adds those).
#[near(serializers = [json])]
#[serde(tag = "type")]
#[derive(Clone, Debug, PartialEq)]
pub enum HlAction {
    #[serde(rename = "approveAgent", rename_all = "camelCase")]
    ApproveAgent {
        agent_address: String,
        #[serde(default)]
        agent_name: String,
        nonce: u64,
    },
    #[serde(rename = "usdSend")]
    UsdSend { destination: String, amount: String, time: u64 },
    #[serde(rename = "withdraw3")]
    Withdraw { destination: String, amount: String, time: u64 },
    #[serde(rename = "usdClassTransfer", rename_all = "camelCase")]
    UsdClassTransfer { amount: String, to_perp: bool, nonce: u64 },
    /// L1 action (l1.rs): its digest is the phantom-agent one and its nonce travels beside the action.
    #[serde(rename = "cancel")]
    Cancel { cancels: Vec<crate::l1::HlCancel> },
}

pub fn word_u64(v: u64) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&v.to_be_bytes());
    w
}

pub fn word_bool(b: bool) -> [u8; 32] {
    word_u64(b as u64)
}

pub fn word_addr(a: &[u8; 20]) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a);
    w
}

pub fn word_str(s: &str) -> [u8; 32] {
    keccak256_array(s.as_bytes())
}

/// keccak256(typeHash || encoded words)
pub fn hash_struct(type_string: &[u8], fields: &[[u8; 32]]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(32 * (fields.len() + 1));
    buf.extend_from_slice(&keccak256_array(type_string));
    for f in fields {
        buf.extend_from_slice(f);
    }
    keccak256_array(&buf)
}

pub fn typed_digest(domain: [u8; 32], struct_hash: [u8; 32]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(66);
    buf.extend_from_slice(b"\x19\x01");
    buf.extend_from_slice(&domain);
    buf.extend_from_slice(&struct_hash);
    keccak256_array(&buf)
}

/// Domain `HyperliquidSignTransaction` / "1" / chainId / verifyingContract 0x0.
pub fn hl_domain_separator(chain_id: u64) -> [u8; 32] {
    hash_struct(
        DOMAIN_TYPE,
        &[word_str("HyperliquidSignTransaction"), word_str("1"), word_u64(chain_id), [0u8; 32]],
    )
}

/// `0x` + 40 lowercase hex. Lowercase only, because HL hashes `destination` as a *string*:
/// the posted string must be byte-identical to the signed one, and policy compares addresses.
pub fn parse_addr(s: &str) -> [u8; 20] {
    let ok = s.len() == 42
        && s.starts_with("0x")
        && s[2..].bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c));
    if !ok {
        env::panic_str(&format!("address must be 0x + 40 lowercase hex: {s}"));
    }
    hex::decode(&s[2..]).unwrap().try_into().unwrap()
}

/// USD amount string -> micro-USD. Plain decimal, at most 6 decimals, > 0 (no "subaccount:" suffix).
pub fn parse_usd(s: &str) -> u64 {
    let (int, frac) = s.split_once('.').unwrap_or((s, ""));
    let ok = !int.is_empty()
        && int.len() <= 12
        && frac.len() <= 6
        && (s.contains('.') == !frac.is_empty())
        && int.bytes().chain(frac.bytes()).all(|c| c.is_ascii_digit());
    if !ok {
        env::panic_str(&format!("amount must be a plain decimal with <= 6 decimals: {s}"));
    }
    let micro = int.parse::<u64>().unwrap() * 1_000_000 + format!("{frac:0<6}").parse::<u64>().unwrap();
    if micro == 0 {
        env::panic_str("amount must be > 0");
    }
    micro
}

impl HlAction {
    /// Validates the fields, then returns the EIP-712 digest. `hl_chain` is "Testnet" or "Mainnet".
    pub fn digest(&self, hl_chain: &str) -> [u8; 32] {
        let c = word_str(hl_chain);
        let struct_hash = match self {
            HlAction::ApproveAgent { agent_address, agent_name, nonce } => hash_struct(
                APPROVE_AGENT_TYPE,
                &[c, word_addr(&parse_addr(agent_address)), word_str(agent_name), word_u64(*nonce)],
            ),
            HlAction::UsdSend { destination, amount, time } => {
                parse_addr(destination);
                parse_usd(amount);
                hash_struct(USD_SEND_TYPE, &[c, word_str(destination), word_str(amount), word_u64(*time)])
            }
            HlAction::Withdraw { destination, amount, time } => {
                parse_addr(destination);
                parse_usd(amount);
                hash_struct(WITHDRAW_TYPE, &[c, word_str(destination), word_str(amount), word_u64(*time)])
            }
            HlAction::UsdClassTransfer { amount, to_perp, nonce } => {
                parse_usd(amount);
                hash_struct(USD_CLASS_TRANSFER_TYPE, &[c, word_str(amount), word_bool(*to_perp), word_u64(*nonce)])
            }
            HlAction::Cancel { .. } => env::panic_str("cancel is an L1 action: use l1::cancel_digest"),
        };
        typed_digest(hl_domain_separator(HL_SIGNATURE_CHAIN_ID), struct_hash)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::{self, Value};

    // Generated by scripts/gen-vectors.mjs with viem (hashDomain + hashStruct).
    const VECTORS: &str = include_str!("../tests/vectors/hl_actions.json");

    fn h32(s: &str) -> [u8; 32] {
        hex::decode(s.trim_start_matches("0x")).unwrap().try_into().unwrap()
    }

    #[test]
    fn hl_action_digests_match_viem() {
        let v: Value = serde_json::from_str(VECTORS).unwrap();
        assert_eq!(hl_domain_separator(HL_SIGNATURE_CHAIN_ID), h32(v["domainSeparator"].as_str().unwrap()));
        let mut kinds = std::collections::BTreeSet::new();
        for c in v["cases"].as_array().unwrap() {
            // `action` is HL's /exchange JSON shape, so this also checks our serde shape
            let action: HlAction = serde_json::from_value(c["action"].clone()).unwrap();
            kinds.insert(c["action"]["type"].as_str().unwrap().to_string());
            assert_eq!(action.digest(c["hyperliquidChain"].as_str().unwrap()), h32(c["digest"].as_str().unwrap()), "case {c}");
        }
        assert_eq!(kinds.len(), 4, "every action type has a vector");
    }

    #[test]
    fn parse_usd_cases() {
        assert_eq!(parse_usd("1"), 1_000_000);
        assert_eq!(parse_usd("1.5"), 1_500_000);
        assert_eq!(parse_usd("0.000001"), 1);
        assert_eq!(parse_usd("12.345678"), 12_345_678);
    }

    #[test]
    #[should_panic(expected = "amount must be")]
    fn parse_usd_rejects_7_decimals() {
        parse_usd("0.0000001");
    }

    #[test]
    #[should_panic(expected = "amount must be")]
    fn parse_usd_rejects_trailing_dot() {
        parse_usd("1.");
    }

    #[test]
    #[should_panic(expected = "amount must be")]
    fn parse_usd_rejects_subaccount_suffix() {
        parse_usd("1 subaccount:0xabc");
    }

    #[test]
    #[should_panic(expected = "amount must be > 0")]
    fn parse_usd_rejects_zero() {
        parse_usd("0.0");
    }

    #[test]
    #[should_panic(expected = "lowercase hex")]
    fn parse_addr_rejects_checksummed() {
        parse_addr("0x8ba1f109551bD432803012645Ac136ddd64DBA72");
    }
}
