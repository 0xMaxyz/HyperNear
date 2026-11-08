//! Owner intents: EIP-712 messages signed by the owner's EVM key, checked with `env::ecrecover`.
//! Domain: `EIP712Domain(string name,string version,bytes32 salt)`, name "Leash", version "1",
//! salt = keccak256("{chain_tag}:{contract_id}") so an intent for one deployment fails on any other.
//! No chainId on purpose: NEAR has none, and wallets refuse a chainId that is not the active chain.

use crate::eip712::{hash_struct, parse_addr, typed_digest, word_addr, word_bool, word_str, word_u64};
use crate::l1::HlCancel;
use near_sdk::env::{self, keccak256_array};
use near_sdk::near;

const DOMAIN_TYPE: &[u8] = b"EIP712Domain(string name,string version,bytes32 salt)";
const APPROVE_AGENT: &[u8] =
    b"ApproveAgent(address owner,uint64 nonce,uint32 leg,address agent,string agentName,uint64 hlNonce)";
const WITHDRAW: &[u8] = b"Withdraw(address owner,uint64 nonce,uint32 leg,string amount,uint64 hlTime)";
const USD_CLASS_TRANSFER: &[u8] =
    b"UsdClassTransfer(address owner,uint64 nonce,uint32 leg,string amount,bool toPerp,uint64 hlNonce)";
const SET_POLICY: &[u8] =
    b"SetPolicy(address owner,uint64 nonce,string agent,string dailyCap,uint64 cooldownSec)";
const FREEZE: &[u8] = b"Freeze(address owner,uint64 nonce,bool frozen)";
const CANCEL_ORDERS: &[u8] =
    b"CancelOrders(address owner,uint64 nonce,uint32 leg,Cancel[] cancels)Cancel(uint32 a,uint64 o)";
const CANCEL: &[u8] = b"Cancel(uint32 a,uint64 o)";
const SET_TEE: &[u8] = b"SetTee(address owner,uint64 nonce,bytes32 measurementHash,string agentAccount)";
const PAY_TEE: &[u8] =
    b"PayTee(address owner,uint64 nonce,uint32 leg,uint32 months,uint64 priceMicro,address feeAddress)";

/// What an owner can ask for. JSON: `{"type":"withdraw","leg":0,"amount":"5","hlTime":…}`.
#[near(serializers = [json])]
#[serde(tag = "type", rename_all = "camelCase")]
#[derive(Clone, Debug, PartialEq)]
pub enum OwnerIntent {
    #[serde(rename_all = "camelCase")]
    ApproveAgent { leg: u32, agent: String, #[serde(default)] agent_name: String, hl_nonce: u64 },
    /// HL withdraw3 to the owner's own address (the only destination there is).
    #[serde(rename_all = "camelCase")]
    Withdraw { leg: u32, amount: String, hl_time: u64 },
    #[serde(rename_all = "camelCase")]
    UsdClassTransfer { leg: u32, amount: String, to_perp: bool, hl_nonce: u64 },
    /// `agent` = NEAR account allowed to call `rebalance` / `agent_usd_class_transfer`; "" revokes.
    #[serde(rename_all = "camelCase")]
    SetPolicy { agent: String, daily_cap: String, cooldown_sec: u64 },
    Freeze { frozen: bool },
    /// HL L1 cancel of the leg's resting orders, signed with the leg's master key; allowed while frozen.
    CancelOrders { leg: u32, cancels: Vec<HlCancel> },
    /// TEE mode: only `agent_account` (the owner's TEE instance), attested with this measurement, may act for the
    /// owner. The zero hash with an empty `agent_account` leaves TEE mode.
    #[serde(rename_all = "camelCase")]
    SetTee { measurement_hash: String, agent_account: String },
    /// Pays `months` (1..=12) x `price_micro` to `fee_address` (a usdSend from `leg`); both must equal the contract's
    /// TEE config, so the owner signs exactly what is paid. Extends paid_until once the MPC signature exists.
    #[serde(rename_all = "camelCase")]
    PayTee { leg: u32, months: u32, price_micro: u64, fee_address: String },
}

pub fn domain_separator(chain_tag: &str, contract_id: &str) -> [u8; 32] {
    let salt = keccak256_array(format!("{chain_tag}:{contract_id}").as_bytes());
    hash_struct(DOMAIN_TYPE, &[word_str("Leash"), word_str("1"), salt])
}

pub fn intent_digest(domain: [u8; 32], owner: &[u8; 20], nonce: u64, intent: &OwnerIntent) -> [u8; 32] {
    let (o, n) = (word_addr(owner), word_u64(nonce));
    let struct_hash = match intent {
        OwnerIntent::ApproveAgent { leg, agent, agent_name, hl_nonce } => hash_struct(
            APPROVE_AGENT,
            &[o, n, word_u64(*leg as u64), word_addr(&parse_addr(agent)), word_str(agent_name), word_u64(*hl_nonce)],
        ),
        OwnerIntent::Withdraw { leg, amount, hl_time } => {
            hash_struct(WITHDRAW, &[o, n, word_u64(*leg as u64), word_str(amount), word_u64(*hl_time)])
        }
        OwnerIntent::UsdClassTransfer { leg, amount, to_perp, hl_nonce } => hash_struct(
            USD_CLASS_TRANSFER,
            &[o, n, word_u64(*leg as u64), word_str(amount), word_bool(*to_perp), word_u64(*hl_nonce)],
        ),
        OwnerIntent::SetPolicy { agent, daily_cap, cooldown_sec } => {
            hash_struct(SET_POLICY, &[o, n, word_str(agent), word_str(daily_cap), word_u64(*cooldown_sec)])
        }
        OwnerIntent::Freeze { frozen } => hash_struct(FREEZE, &[o, n, word_bool(*frozen)]),
        OwnerIntent::CancelOrders { leg, cancels } => {
            // EIP-712 array of structs: keccak256 of the concatenated struct hashes
            let items: Vec<u8> =
                cancels.iter().flat_map(|c| hash_struct(CANCEL, &[word_u64(c.a as u64), word_u64(c.o)])).collect();
            hash_struct(CANCEL_ORDERS, &[o, n, word_u64(*leg as u64), keccak256_array(&items)])
        }
        OwnerIntent::SetTee { measurement_hash, agent_account } => {
            let h: [u8; 32] = hex::decode(crate::tee::parse_hash(measurement_hash).trim_start_matches("0x")).unwrap().try_into().unwrap();
            hash_struct(SET_TEE, &[o, n, h, word_str(agent_account)])
        }
        OwnerIntent::PayTee { leg, months, price_micro, fee_address } => hash_struct(
            PAY_TEE,
            &[o, n, word_u64(*leg as u64), word_u64(*months as u64), word_u64(*price_micro), word_addr(&parse_addr(fee_address))],
        ),
    };
    typed_digest(domain, struct_hash)
}

/// EVM address that signed `digest`. `sig_hex` = 65 bytes r||s||v, v in {0,1,27,28}. High-s rejected.
pub fn recover_signer(digest: &[u8; 32], sig_hex: &str) -> [u8; 20] {
    let sig: [u8; 65] = hex::decode(sig_hex.trim_start_matches("0x"))
        .ok()
        .and_then(|v| v.try_into().ok())
        .unwrap_or_else(|| env::panic_str("signature: expected 65 hex bytes"));
    let v = match sig[64] {
        0 | 27 => 0,
        1 | 28 => 1,
        _ => env::panic_str("signature: bad v"),
    };
    let pk = env::ecrecover(digest, &sig[..64], v, true).unwrap_or_else(|| env::panic_str("signature: ecrecover failed"));
    keccak256_array(&pk)[12..].try_into().unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::{self, Value};

    // Generated by scripts/gen-vectors.mjs: viem hashTypedData + signTypedData with a fixed test key.
    const VECTORS: &str = include_str!("../tests/vectors/owner_intents.json");

    fn h32(s: &str) -> [u8; 32] {
        hex::decode(s.trim_start_matches("0x")).unwrap().try_into().unwrap()
    }

    #[test]
    fn owner_intent_digests_and_signatures_match_viem() {
        let v: Value = serde_json::from_str(VECTORS).unwrap();
        let domain = domain_separator(v["chainTag"].as_str().unwrap(), v["contractId"].as_str().unwrap());
        assert_eq!(domain, h32(v["domainSeparator"].as_str().unwrap()));
        let owner = parse_addr(v["owner"].as_str().unwrap());
        let mut kinds = std::collections::BTreeSet::new();
        for c in v["cases"].as_array().unwrap() {
            let intent: OwnerIntent = serde_json::from_value(c["intent"].clone()).unwrap();
            kinds.insert(c["intent"]["type"].as_str().unwrap().to_string());
            let d = intent_digest(domain, &owner, c["nonce"].as_u64().unwrap(), &intent);
            assert_eq!(d, h32(c["digest"].as_str().unwrap()), "case {c}");
            assert_eq!(recover_signer(&d, c["signature"].as_str().unwrap()), owner, "ecrecover case {c}");
        }
        assert_eq!(kinds.len(), 8, "every intent type has a vector");
    }
}
