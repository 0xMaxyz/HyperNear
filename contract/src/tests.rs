//! Policy tests. MPC calls are checked through the receipts the contract creates.

use super::*;
use k256::ecdsa::SigningKey;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::testing_env;
use std::panic::{catch_unwind, AssertUnwindSafe};

const CONTRACT: &str = "leash.testnet";
const RELAYER: &str = "anyone.testnet";
const AGENT: &str = "agent.testnet";
const T0: u64 = 1_794_050_000; // seconds

const RELAYER_DEPOSIT: NearToken = NearToken::from_millinear(100);

fn ctx_dep(pred: &str, ts_sec: u64, deposit: NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .predecessor_account_id(pred.parse().unwrap())
        .block_timestamp(ts_sec * 1_000_000_000)
        .attached_deposit(deposit);
    testing_env!(b.build());
}

/// The relayer attaches a storage deposit (full-access key); everyone else attaches nothing (function-call key).
fn ctx(pred: &str, ts_sec: u64) {
    ctx_dep(pred, ts_sec, if pred == RELAYER { RELAYER_DEPOSIT } else { NearToken::from_yoctonear(0) });
}

fn contract() -> Leash {
    ctx(RELAYER, T0);
    Leash::new("admin.testnet".parse().unwrap(), "v1.signer-prod.testnet".parse().unwrap(), false)
}

struct Owner {
    key: SigningKey,
    addr: String,
}

fn owner(seed: u8) -> Owner {
    let key = SigningKey::from_bytes(&[seed; 32].into()).unwrap();
    let pt = key.verifying_key().to_encoded_point(false);
    let addr = format!("0x{}", hex::encode(&keccak256_array(&pt.as_bytes()[1..])[12..]));
    Owner { key, addr }
}

impl Owner {
    fn sign_for(&self, chain_tag: &str, contract_id: &str, nonce: u64, intent: &OwnerIntent) -> String {
        let d = auth::intent_digest(auth::domain_separator(chain_tag, contract_id), &parse_addr(&self.addr), nonce, intent);
        let (sig, rid) = self.key.sign_prehash_recoverable(&d).unwrap();
        let mut b = sig.to_bytes().to_vec();
        b.push(27 + rid.to_byte());
        hex::encode(b)
    }
    fn sign(&self, nonce: u64, intent: &OwnerIntent) -> String {
        self.sign_for("near-testnet", CONTRACT, nonce, intent)
    }
    /// Signs and executes as a random relayer.
    fn exec(&self, c: &mut Leash, nonce: u64, intent: OwnerIntent) {
        let sig = self.sign(nonce, &intent);
        let _ = c.owner_execute(self.addr.clone(), nonce, intent, sig);
    }
}

/// (receiver, yocto) of every transfer (refund) created since the last context reset.
fn transfers() -> Vec<(String, u128)> {
    get_created_receipts()
        .iter()
        .flat_map(|r| r.actions.iter().map(move |a| (r.receiver_id.to_string(), a)))
        .filter_map(|(to, a)| match a {
            MockAction::Transfer { deposit, .. } => Some((to, deposit.as_yoctonear())),
            _ => None,
        })
        .collect()
}

/// Args of the `on_signed` callback the last call scheduled.
fn on_signed_args() -> Value {
    get_created_receipts()
        .iter()
        .flat_map(|r| r.actions.iter())
        .find_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, args, .. } if method_name == b"on_signed" => {
                Some(serde_json::from_slice(args).unwrap())
            }
            _ => None,
        })
        .expect("no on_signed callback")
}

fn fake_mpc_sig() -> MpcSignature {
    MpcSignature {
        big_r: MpcAffinePoint { affine_point: format!("02{}", "11".repeat(32)) },
        s: MpcScalar { scalar: "22".repeat(32) },
        recovery_id: 0,
    }
}

/// (path, payload hex) of every MPC `sign` call created since the last context reset.
fn signed() -> Vec<(String, String)> {
    get_created_receipts()
        .iter()
        .flat_map(|r| r.actions.iter())
        .filter_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, args, .. } if method_name == b"sign" => {
                let v: Value = serde_json::from_slice(args).unwrap();
                Some((
                    v["request"]["path"].as_str().unwrap().to_string(),
                    v["request"]["payload_v2"]["Ecdsa"].as_str().unwrap().to_string(),
                ))
            }
            _ => None,
        })
        .collect()
}

fn hl(action: HlAction) -> String {
    hex::encode(action.digest("Testnet"))
}

fn approve(agent: &str) -> OwnerIntent {
    OwnerIntent::ApproveAgent { leg: 0, agent: agent.into(), agent_name: "bot".into(), hl_nonce: 7 }
}

fn withdraw(amount: &str) -> OwnerIntent {
    OwnerIntent::Withdraw { leg: 1, amount: amount.into(), hl_time: 9 }
}

fn expect_panic(msg: &str, f: impl FnOnce()) {
    let err = catch_unwind(AssertUnwindSafe(f)).expect_err("expected a panic");
    let text = err
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    assert!(text.contains(msg), "panic {text:?} does not contain {msg:?}");
}

/// Registers `owner`'s leg `leg` as if the MPC returned `key`'s public key; returns its address.
fn register(c: &mut Leash, owner: &Owner, leg: u32, key_seed: u8) -> String {
    ctx(RELAYER, T0);
    let _ = c.register_leg(owner.addr.clone(), leg);
    let derived = self::owner(key_seed);
    let pt = derived.key.verifying_key().to_encoded_point(false);
    let pk = PublicKey::from_parts(CurveType::SECP256K1, pt.as_bytes()[1..].to_vec()).unwrap();
    ctx(CONTRACT, T0);
    let pk_str: String = serde_json::from_value(serde_json::to_value(&pk).unwrap()).unwrap();
    let addr = c
        .on_leg_derived(owner.addr.clone(), leg_path(&owner.addr, leg), RELAYER.parse().unwrap(), REGISTER_LEG_DEPOSIT, Ok(pk_str))
        .unwrap();
    assert_eq!(addr, derived.addr);
    addr
}

fn set_policy(c: &mut Leash, o: &Owner, cap: &str, cooldown_sec: u64) {
    let nonce = c.get_owner(o.addr.clone()).map_or(0, |s| s.nonce);
    ctx(RELAYER, T0);
    o.exec(c, nonce, OwnerIntent::SetPolicy { agent: AGENT.into(), daily_cap: cap.into(), cooldown_sec });
}

// ---- owner intents ----

#[test]
fn approve_agent_by_owner_signs_hl_digest_and_burns_nonce() {
    let mut c = contract();
    let o = owner(1);
    let agent = owner(50).addr;
    o.exec(&mut c, 0, approve(&agent));
    let want = hl(HlAction::ApproveAgent { agent_address: agent, agent_name: "bot".into(), nonce: 7 });
    assert_eq!(signed(), vec![(format!("{}/leg0", o.addr), want)]);
    assert_eq!(c.get_owner(o.addr.clone()).unwrap().nonce, 1);
}

#[test]
fn wrong_signer_rejected() {
    let mut c = contract();
    let (o, mallory) = (owner(1), owner(2));
    let sig = mallory.sign(0, &withdraw("1"));
    expect_panic("signature does not match owner", || {
        let _ = c.owner_execute(o.addr.clone(), 0, withdraw("1"), sig);
    });
}

#[test]
fn tampered_intent_rejected() {
    let mut c = contract();
    let o = owner(1);
    let sig = o.sign(0, &withdraw("1"));
    expect_panic("signature does not match owner", || {
        let _ = c.owner_execute(o.addr.clone(), 0, withdraw("100"), sig);
    });
}

#[test]
fn replay_rejected() {
    let mut c = contract();
    let o = owner(1);
    let sig = o.sign(0, &withdraw("1"));
    let _ = c.owner_execute(o.addr.clone(), 0, withdraw("1"), sig.clone());
    expect_panic("bad nonce", || {
        let _ = c.owner_execute(o.addr.clone(), 0, withdraw("1"), sig);
    });
}

#[test]
fn future_nonce_rejected() {
    let mut c = contract();
    let o = owner(1);
    expect_panic("bad nonce", || o.exec(&mut c, 1, withdraw("1")));
}

#[test]
fn cross_chain_and_cross_contract_replay_rejected() {
    let mut c = contract();
    let o = owner(1);
    for (tag, id) in [("near-mainnet", CONTRACT), ("near-testnet", "other.testnet"), ("near-mainnet", "leash.near")] {
        let sig = o.sign_for(tag, id, 0, &withdraw("1"));
        expect_panic("signature does not match owner", || {
            let _ = c.owner_execute(o.addr.clone(), 0, withdraw("1"), sig);
        });
    }
}

#[test]
fn bad_signature_encoding_rejected() {
    let mut c = contract();
    let o = owner(1);
    let mut sig = o.sign(0, &withdraw("1"));
    sig.replace_range(128..130, "05");
    expect_panic("bad v", || {
        let _ = c.owner_execute(o.addr.clone(), 0, withdraw("1"), sig);
    });
    expect_panic("65 hex bytes", || {
        let _ = c.owner_execute(o.addr.clone(), 0, withdraw("1"), "00".repeat(64));
    });
}

#[test]
fn nonce_stays_burned_when_mpc_callback_fails() {
    let mut c = contract();
    let o = owner(1);
    let sig0 = o.sign(0, &withdraw("1"));
    let _ = c.owner_execute(o.addr.clone(), 0, withdraw("1"), sig0.clone());
    ctx(CONTRACT, T0);
    assert!(c.on_signed("00".repeat(32), None, None, Err(PromiseError::Failed)).is_none());
    ctx(RELAYER, T0);
    assert_eq!(c.get_owner(o.addr.clone()).unwrap().nonce, 1);
    expect_panic("bad nonce", || {
        let _ = c.owner_execute(o.addr.clone(), 0, withdraw("1"), sig0);
    });
    o.exec(&mut c, 1, withdraw("1")); // the owner signs again with the next nonce
    assert_eq!(c.get_owner(o.addr.clone()).unwrap().nonce, 2);
}

#[test]
fn withdraw_destination_is_always_the_owner() {
    let mut c = contract();
    let o = owner(1);
    o.exec(&mut c, 0, withdraw("2.5"));
    let want = hl(HlAction::Withdraw { destination: o.addr.clone(), amount: "2.5".into(), time: 9 });
    assert_eq!(signed(), vec![(format!("{}/leg1", o.addr), want)]);
}

#[test]
fn owner_usd_class_transfer_signs() {
    let mut c = contract();
    let o = owner(1);
    o.exec(&mut c, 0, OwnerIntent::UsdClassTransfer { leg: 2, amount: "1".into(), to_perp: false, hl_nonce: 5 });
    let want = hl(HlAction::UsdClassTransfer { amount: "1".into(), to_perp: false, nonce: 5 });
    assert_eq!(signed(), vec![(format!("{}/leg2", o.addr), want)]);
}

#[test]
fn checksummed_owner_rejected() {
    let mut c = contract();
    expect_panic("lowercase hex", || {
        let _ = c.owner_execute("0x8ba1f109551bD432803012645Ac136ddd64DBA72".into(), 0, withdraw("1"), "00".repeat(65));
    });
}

// ---- freeze ----

#[test]
fn freeze_refuses_everything_but_withdraw_and_unfreeze() {
    let mut c = contract();
    let o = owner(1);
    set_policy(&mut c, &o, "10", 0); // nonce 0
    let leg1 = register(&mut c, &o, 1, 21);
    ctx(RELAYER, T0);
    o.exec(&mut c, 1, OwnerIntent::Freeze { frozen: true });
    assert!(c.get_owner(o.addr.clone()).unwrap().frozen);

    let agent = owner(50).addr;
    expect_panic("frozen", || o.exec(&mut c, 2, approve(&agent)));
    expect_panic("frozen", || {
        o.exec(&mut c, 2, OwnerIntent::UsdClassTransfer { leg: 0, amount: "1".into(), to_perp: true, hl_nonce: 1 })
    });
    expect_panic("frozen", || {
        o.exec(&mut c, 2, OwnerIntent::SetPolicy { agent: "".into(), daily_cap: "1".into(), cooldown_sec: 0 })
    });
    ctx(AGENT, T0);
    expect_panic("frozen", || {
        let _ = c.rebalance(o.addr.clone(), 0, leg1.clone(), "1".into(), 1);
    });
    expect_panic("frozen", || {
        let _ = c.agent_usd_class_transfer(o.addr.clone(), 0, "1".into(), true, 1);
    });

    ctx(RELAYER, T0);
    o.exec(&mut c, 2, withdraw("1"));
    assert_eq!(signed().len(), 1, "withdraw still allowed while frozen");
    o.exec(&mut c, 3, OwnerIntent::Freeze { frozen: false });
    o.exec(&mut c, 4, approve(&agent));
    assert_eq!(signed().len(), 2);
}

// ---- agent ----

#[test]
fn agent_usd_class_transfer_only_by_the_owners_agent() {
    let mut c = contract();
    let o = owner(1);
    ctx(AGENT, T0);
    expect_panic("unknown owner", || {
        let _ = c.agent_usd_class_transfer(o.addr.clone(), 0, "1".into(), true, 1);
    });
    set_policy(&mut c, &o, "10", 0);
    ctx("mallory.testnet", T0);
    expect_panic("not this owner's agent", || {
        let _ = c.agent_usd_class_transfer(o.addr.clone(), 0, "1".into(), true, 1);
    });
    ctx(AGENT, T0);
    let _ = c.agent_usd_class_transfer(o.addr.clone(), 0, "1".into(), true, 3);
    let want = hl(HlAction::UsdClassTransfer { amount: "1".into(), to_perp: true, nonce: 3 });
    assert_eq!(signed(), vec![(format!("{}/leg0", o.addr), want)]);
}

#[test]
fn agent_cannot_move_perp_to_spot() {
    let mut c = contract();
    let o = owner(1);
    set_policy(&mut c, &o, "10", 0);
    ctx(AGENT, T0);
    expect_panic("agent may only move spot to perp", || {
        let _ = c.agent_usd_class_transfer(o.addr.clone(), 0, "1".into(), false, 1);
    });
    assert!(signed().is_empty());
}

#[test]
fn revoked_agent_rejected() {
    let mut c = contract();
    let o = owner(1);
    set_policy(&mut c, &o, "10", 0);
    o.exec(&mut c, 1, OwnerIntent::SetPolicy { agent: "".into(), daily_cap: "".into(), cooldown_sec: 0 });
    ctx(AGENT, T0);
    expect_panic("not this owner's agent", || {
        let _ = c.agent_usd_class_transfer(o.addr.clone(), 0, "1".into(), true, 1);
    });
}

#[test]
fn agent_cannot_use_owner_intents() {
    let mut c = contract();
    let o = owner(1);
    set_policy(&mut c, &o, "10", 0);
    // the agent's NEAR identity gives it nothing on owner_execute: only the owner's signature counts
    ctx(AGENT, T0);
    let agent_key = owner(3);
    let sig = agent_key.sign(1, &withdraw("1"));
    expect_panic("signature does not match owner", || {
        let _ = c.owner_execute(o.addr.clone(), 1, withdraw("1"), sig);
    });
}

#[test]
fn rebalance_moves_only_between_own_registered_legs() {
    let mut c = contract();
    let (o, other) = (owner(1), owner(2));
    set_policy(&mut c, &o, "10", 0);
    let _leg0 = register(&mut c, &o, 0, 20);
    let leg1 = register(&mut c, &o, 1, 21);
    let foreign = register(&mut c, &other, 0, 22);

    ctx(AGENT, T0);
    expect_panic("not a registered leg of this owner", || {
        let _ = c.rebalance(o.addr.clone(), 0, owner(99).addr, "1".into(), 1);
    });
    expect_panic("not a registered leg of this owner", || {
        let _ = c.rebalance(o.addr.clone(), 0, foreign.clone(), "1".into(), 1);
    });
    expect_panic("source equals destination", || {
        let _ = c.rebalance(o.addr.clone(), 1, leg1.clone(), "1".into(), 1);
    });
    ctx("mallory.testnet", T0);
    expect_panic("not this owner's agent", || {
        let _ = c.rebalance(o.addr.clone(), 0, leg1.clone(), "1".into(), 1);
    });

    ctx(AGENT, T0);
    let _ = c.rebalance(o.addr.clone(), 0, leg1.clone(), "4".into(), 11);
    let want = hl(HlAction::UsdSend { destination: leg1.clone(), amount: "4".into(), time: 11 });
    assert_eq!(signed(), vec![(format!("{}/leg0", o.addr), want)]);
    assert_eq!(c.get_owner(o.addr.clone()).unwrap().spent_today, 4_000_000);
}

#[test]
fn rebalance_cap_and_cooldown() {
    let mut c = contract();
    let o = owner(1);
    set_policy(&mut c, &o, "10", 600);
    register(&mut c, &o, 0, 20);
    let leg1 = register(&mut c, &o, 1, 21);
    let reb = |c: &mut Leash, t: u64, amt: &str| {
        ctx(AGENT, t);
        let _ = c.rebalance(o.addr.clone(), 0, leg1.clone(), amt.into(), t);
    };
    // start at a day boundary so the whole sequence stays inside one UTC day
    let day0 = (T0 / 86_400 + 1) * 86_400;
    reb(&mut c, day0, "4");
    expect_panic("cooldown", || reb(&mut c, day0 + 599, "1"));
    reb(&mut c, day0 + 600, "6"); // total 10 = cap
    expect_panic("daily cap exceeded", || reb(&mut c, day0 + 1200, "0.000001"));
    reb(&mut c, day0 + 86_400, "10"); // next UTC day: cap resets
    expect_panic("daily cap exceeded", || reb(&mut c, day0 + 86_400 + 600, "0.5"));
    expect_panic("daily cap exceeded", || reb(&mut c, day0 + 2 * 86_400, "10.000001"));
}

#[test]
fn failed_mpc_sign_gives_back_rebalance_cap_and_cooldown() {
    let mut c = contract();
    let o = owner(1);
    set_policy(&mut c, &o, "10", 600);
    register(&mut c, &o, 0, 20);
    let leg1 = register(&mut c, &o, 1, 21);
    let day0 = (T0 / 86_400 + 1) * 86_400;

    ctx(AGENT, day0);
    let _ = c.rebalance(o.addr.clone(), 0, leg1.clone(), "4".into(), 1);
    let ok = on_signed_args();
    ctx(CONTRACT, day0 + 5);
    let refund: CapRefund = serde_json::from_value(ok["refund"].clone()).unwrap();
    assert!(c.on_signed(ok["payload"].as_str().unwrap().into(), None, Some(refund), Ok(fake_mpc_sig())).is_some());
    let st = c.get_owner(o.addr.clone()).unwrap();
    assert_eq!((st.spent_today, st.last_rebalance_ns), (4_000_000, day0 * 1_000_000_000), "success keeps the spend");

    let t1 = day0 + 600;
    ctx(AGENT, t1);
    let _ = c.rebalance(o.addr.clone(), 0, leg1.clone(), "6".into(), 2);
    let failed = on_signed_args();
    ctx(CONTRACT, t1 + 5);
    let refund: CapRefund = serde_json::from_value(failed["refund"].clone()).unwrap();
    assert!(c.on_signed(failed["payload"].as_str().unwrap().into(), None, Some(refund), Err(PromiseError::Failed)).is_none());
    let st = c.get_owner(o.addr.clone()).unwrap();
    assert_eq!(st.spent_today, 4_000_000, "the failed 6 is given back");
    assert_eq!(st.last_rebalance_ns, day0 * 1_000_000_000, "cooldown restarts from the last successful rebalance");

    ctx(AGENT, t1 + 10); // would hit "cooldown" if the failed rebalance had restarted it
    let _ = c.rebalance(o.addr.clone(), 0, leg1, "6".into(), 3);
    assert_eq!(c.get_owner(o.addr.clone()).unwrap().spent_today, 10_000_000);
}

#[test]
fn rebalance_from_unregistered_source_rejected() {
    let mut c = contract();
    let o = owner(1);
    set_policy(&mut c, &o, "10", 0);
    let leg1 = register(&mut c, &o, 1, 21);
    ctx(AGENT, T0);
    expect_panic("source leg not registered", || {
        let _ = c.rebalance(o.addr.clone(), 7, leg1, "1".into(), 1);
    });
}

// ---- legs ----

#[test]
fn register_leg_asks_mpc_and_stores_its_answer() {
    let mut c = contract();
    let o = owner(1);
    ctx(RELAYER, T0);
    let _ = c.register_leg(o.addr.clone(), 3);
    let calls: Vec<Value> = get_created_receipts()
        .iter()
        .flat_map(|r| r.actions.iter())
        .filter_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, args, .. } if method_name == b"derived_public_key" => {
                Some(serde_json::from_slice(args).unwrap())
            }
            _ => None,
        })
        .collect();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["path"], format!("{}/leg3", o.addr));
    assert_eq!(calls[0]["predecessor"], CONTRACT);

    let addr = register(&mut c, &o, 3, 30);
    assert_eq!(c.get_leg(o.addr.clone(), 3), Some(addr));
    ctx(RELAYER, T0);
    expect_panic("leg already registered", || {
        let _ = c.register_leg(o.addr.clone(), 3);
    });
}

#[test]
fn register_leg_refunds_everything_when_mpc_view_fails() {
    let mut c = contract();
    let o = owner(1);
    ctx(CONTRACT, T0);
    let got = c.on_leg_derived(o.addr.clone(), leg_path(&o.addr, 0), RELAYER.parse().unwrap(), REGISTER_LEG_DEPOSIT, Err(PromiseError::Failed));
    assert_eq!(got, None);
    assert_eq!(c.get_leg(o.addr.clone(), 0), None);
    assert_eq!(transfers(), vec![(RELAYER.to_string(), REGISTER_LEG_DEPOSIT.as_yoctonear())]);
}

#[test]
fn register_leg_refunds_everything_on_a_non_secp256k1_key() {
    let mut c = contract();
    let o = owner(1);
    ctx(CONTRACT, T0);
    let ed = PublicKey::from_parts(CurveType::ED25519, vec![7; 32]).unwrap();
    let ed_str: String = serde_json::from_value(serde_json::to_value(&ed).unwrap()).unwrap();
    let got = c.on_leg_derived(o.addr.clone(), leg_path(&o.addr, 0), RELAYER.parse().unwrap(), REGISTER_LEG_DEPOSIT, Ok(ed_str));
    assert_eq!(got, None);
    assert_eq!(c.get_leg(o.addr.clone(), 0), None);
    assert_eq!(transfers(), vec![(RELAYER.to_string(), REGISTER_LEG_DEPOSIT.as_yoctonear())]);
}

#[test]
fn register_leg_refunds_unused_deposit() {
    let mut c = contract();
    let o = owner(1);
    register(&mut c, &o, 0, 20); // leaves the receipts of the callback in place
    let refunds = transfers();
    assert_eq!(refunds.len(), 1);
    let (to, amount) = &refunds[0];
    assert_eq!(to, RELAYER);
    let kept = REGISTER_LEG_DEPOSIT.as_yoctonear() - amount;
    eprintln!("register_leg storage cost: {kept} yocto");
    assert!(kept > 0 && kept < REGISTER_LEG_DEPOSIT.as_yoctonear() * 3 / 4, "kept {kept} yocto: deposit margin too thin");
}

// ---- storage deposits ----

#[test]
fn register_leg_without_deposit_rejected() {
    let mut c = contract();
    let o = owner(1);
    ctx_dep(RELAYER, T0, NearToken::from_yoctonear(0));
    expect_panic("for storage", || {
        let _ = c.register_leg(o.addr.clone(), 0);
    });
}

#[test]
fn new_owner_without_deposit_rejected() {
    let mut c = contract();
    let o = owner(1);
    ctx_dep(RELAYER, T0, NearToken::from_yoctonear(0));
    expect_panic("for storage", || o.exec(&mut c, 0, withdraw("1")));
    // (the runtime reverts the whole call; the unit-test cache does not, so no state assert here)
}

#[test]
fn new_owner_pays_storage_and_gets_the_rest_back() {
    let mut c = contract();
    let o = owner(1);
    o.exec(&mut c, 0, OwnerIntent::Freeze { frozen: false }); // ctx = relayer with 0.1 NEAR
    let refunds = transfers();
    assert_eq!(refunds.len(), 1);
    assert_eq!(refunds[0].0, RELAYER);
    let kept = RELAYER_DEPOSIT.as_yoctonear() - refunds[0].1;
    assert!(kept > 0 && kept < NearToken::from_millinear(5).as_yoctonear(), "kept {kept}");
    // same-size update afterwards: no deposit needed (a function-call key can relay it)
    ctx_dep(RELAYER, T0, NearToken::from_yoctonear(0));
    o.exec(&mut c, 1, OwnerIntent::Freeze { frozen: true });
    assert!(c.get_owner(o.addr.clone()).unwrap().frozen);
}

#[test]
fn agent_methods_need_no_deposit() {
    let mut c = contract();
    let o = owner(1);
    set_policy(&mut c, &o, "10", 0);
    register(&mut c, &o, 0, 20);
    let leg1 = register(&mut c, &o, 1, 21);
    ctx_dep(AGENT, T0, NearToken::from_yoctonear(0));
    let _ = c.rebalance(o.addr.clone(), 0, leg1, "1".into(), 1);
    let _ = c.agent_usd_class_transfer(o.addr.clone(), 0, "1".into(), true, 2);
    assert_eq!(signed().len(), 2);
}

// ---- admin spike methods (only in `--features spike` builds) ----

#[cfg(feature = "spike")]
#[test]
fn admin_methods_reject_strangers() {
    let mut c = contract();
    ctx("mallory.testnet", T0);
    expect_panic("admin only", || {
        let _ = c.sign_raw("test/leg0".into(), "11".repeat(32));
    });
    expect_panic("admin only", || {
        let _ = c.admin_sign_hl("test/leg0".into(), HlAction::UsdClassTransfer { amount: "1".into(), to_perp: true, nonce: 1 });
    });
    ctx("admin.testnet", T0);
    let _ = c.sign_raw("test/leg0".into(), "11".repeat(32));
    ctx(CONTRACT, T0);
    let _ = c.admin_sign_hl("test/leg0".into(), HlAction::UsdClassTransfer { amount: "1".into(), to_perp: true, nonce: 1 });
    assert_eq!(signed().len(), 1);
}

#[cfg(feature = "spike")]
#[test]
fn spike_build_refuses_mainnet() {
    ctx(RELAYER, T0);
    expect_panic("spike build: testnet only", || {
        Leash::new("admin.testnet".parse().unwrap(), "v1.signer-prod.testnet".parse().unwrap(), true);
    });
    let mut b = VMContextBuilder::new();
    b.current_account_id("leash.near".parse().unwrap()).predecessor_account_id("leash.near".parse().unwrap());
    testing_env!(b.build());
    expect_panic("spike build: testnet only", || {
        Leash::new("admin.near".parse().unwrap(), "v1.signer".parse().unwrap(), false);
    });
}

#[cfg(feature = "spike")]
#[test]
fn sign_raw_rejects_short_payload() {
    let mut c = contract();
    ctx("admin.testnet", T0);
    expect_panic("payload: expected 32 hex bytes", || {
        let _ = c.sign_raw("test/leg0".into(), "11".repeat(31));
    });
}

// ---- freeze revokes the HL agents approved through the contract ----

fn approve_named(leg: u32, name: &str, agent_seed: u8) -> OwnerIntent {
    OwnerIntent::ApproveAgent { leg, agent: owner(agent_seed).addr, agent_name: name.into(), hl_nonce: 7 }
}

#[test]
fn approve_agent_records_each_name_once_and_caps_the_list() {
    let mut c = contract();
    let o = owner(1);
    o.exec(&mut c, 0, approve_named(0, "leash-leg0", 50));
    o.exec(&mut c, 1, approve_named(0, "leash-leg0", 51)); // same name re-pointed: still one slot
    o.exec(&mut c, 2, approve_named(1, "leash-leg1", 52));
    assert_eq!(
        c.get_agent_slots(o.addr.clone()),
        vec![AgentSlot { leg: 0, name: "leash-leg0".into() }, AgentSlot { leg: 1, name: "leash-leg1".into() }]
    );
    for i in 2..MAX_TRACKED_AGENTS as u64 {
        o.exec(&mut c, i + 1, approve_named(1, &format!("n{i}"), 53));
    }
    expect_panic("too many agent names", || o.exec(&mut c, MAX_TRACKED_AGENTS as u64 + 1, approve_named(2, "one-more", 54)));
}

#[test]
fn freeze_signs_approve_agent_to_a_burn_address_for_every_tracked_name() {
    let mut c = contract();
    let o = owner(1);
    o.exec(&mut c, 0, approve_named(0, "leash-leg0", 50));
    o.exec(&mut c, 1, approve_named(1, "leash-leg1", 51));
    o.exec(&mut c, 2, approve_named(2, "leash-leg2", 52));
    ctx(RELAYER, T0);
    o.exec(&mut c, 3, OwnerIntent::Freeze { frozen: true });
    assert!(c.get_owner(o.addr.clone()).unwrap().frozen);
    let want: Vec<(String, String)> = (0..3)
        .map(|leg| {
            let path = leg_path(&o.addr, leg);
            let action = HlAction::ApproveAgent { agent_address: burn_address(&path), agent_name: format!("leash-leg{leg}"), nonce: T0 * 1000 + leg as u64 };
            (path, hl(action))
        })
        .collect();
    assert_eq!(signed(), want);
    // burn addresses differ per leg (HL refuses one agent address on two masters)
    let burns: std::collections::BTreeSet<_> = (0..3).map(|l| burn_address(&leg_path(&o.addr, l))).collect();
    assert_eq!(burns.len(), 3);
    let cb: Vec<Value> = get_created_receipts()
        .iter()
        .flat_map(|r| r.actions.iter())
        .filter_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, args, .. } if method_name == b"on_revoked" => Some(serde_json::from_slice(args).unwrap()),
            _ => None,
        })
        .collect();
    assert_eq!(cb.len(), 1, "one joined callback");
    assert_eq!(cb[0]["slots"].as_array().unwrap().len(), 3);
}

#[test]
fn freeze_without_agents_and_unfreeze_sign_nothing() {
    let mut c = contract();
    let o = owner(1);
    o.exec(&mut c, 0, OwnerIntent::Freeze { frozen: true });
    assert!(signed().is_empty());
    o.exec(&mut c, 1, OwnerIntent::Freeze { frozen: false });
    let o2 = owner(2); // (the mocked storage is shared between contract instances: use another owner)
    o2.exec(&mut c, 0, approve_named(0, "leash-leg0", 50));
    o2.exec(&mut c, 1, OwnerIntent::Freeze { frozen: true });
    ctx(RELAYER, T0);
    o2.exec(&mut c, 2, OwnerIntent::Freeze { frozen: false });
    assert!(signed().is_empty(), "unfreezing re-approves nothing");
}

#[test]
fn freeze_needs_gas_for_every_revocation() {
    let mut c = contract();
    let o = owner(1);
    for i in 0..MAX_TRACKED_AGENTS as u64 {
        o.exec(&mut c, i, approve_named((i % 3) as u32, &format!("n{i}"), 50 + i as u8));
    }
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .predecessor_account_id(RELAYER.parse().unwrap())
        .block_timestamp(T0 * 1_000_000_000)
        .attached_deposit(RELAYER_DEPOSIT)
        .prepaid_gas(Gas::from_tgas(100));
    testing_env!(b.build());
    expect_panic("attach more gas", || o.exec(&mut c, MAX_TRACKED_AGENTS as u64, OwnerIntent::Freeze { frozen: true }));
}

#[test]
fn on_revoked_returns_one_entry_per_agent_with_or_without_signature() {
    let mut c = contract();
    let o = owner(1);
    let slot = |leg: u32| AgentSlot { leg, name: format!("leash-leg{leg}") };
    let act = |leg: u32| HlAction::ApproveAgent { agent_address: burn_address(&leg_path(&o.addr, leg)), agent_name: format!("leash-leg{leg}"), nonce: 1 };
    let ok = serde_json::to_vec(&serde_json::json!({ "scheme": "Secp256k1", "big_r": { "affine_point": format!("02{}", "11".repeat(32)) }, "s": { "scalar": "22".repeat(32) }, "recovery_id": 1 })).unwrap();
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap()).predecessor_account_id(CONTRACT.parse().unwrap());
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![near_sdk::PromiseResult::Successful(ok), near_sdk::PromiseResult::Failed]
    );
    let out = c.on_revoked(vec![
        (slot(0), burn_address(&leg_path(&o.addr, 0)), "aa".into(), act(0)),
        (slot(1), burn_address(&leg_path(&o.addr, 1)), "bb".into(), act(1)),
    ]);
    assert_eq!(out.len(), 2);
    assert_eq!((out[0].leg, out[0].signature.as_ref().map(|s| s.recovery_id)), (0, Some(1)));
    assert_eq!(out[0].signature.as_ref().unwrap().action, Some(act(0)));
    assert!(out[1].signature.is_none());
    let _ = &mut c;
}
