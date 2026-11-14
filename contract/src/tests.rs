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
    Leash::new("admin.testnet".parse().unwrap(), "v1.signer-prod.testnet".parse().unwrap(), false, None, None)
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
    assert!(c.on_signed("00".repeat(32), None, None, None, None, Err(PromiseError::Failed)).is_none());
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
fn rebalance_spot_signs_a_spot_usdc_send_asset_under_the_same_limits() {
    let mut c = contract();
    let (o, other) = (owner(1), owner(2));
    set_policy(&mut c, &o, "10", 600);
    register(&mut c, &o, 0, 20);
    let leg1 = register(&mut c, &o, 1, 21);
    let foreign = register(&mut c, &other, 0, 22);
    let day0 = (T0 / 86_400 + 1) * 86_400;

    ctx(AGENT, day0);
    expect_panic("not a registered leg of this owner", || {
        let _ = c.rebalance_spot(o.addr.clone(), 0, foreign.clone(), "1".into(), 1);
    });
    ctx("mallory.testnet", day0);
    expect_panic("not this owner's agent", || {
        let _ = c.rebalance_spot(o.addr.clone(), 0, leg1.clone(), "1".into(), 1);
    });
    ctx(AGENT, day0);
    let _ = c.rebalance_spot(o.addr.clone(), 0, leg1.clone(), "4".into(), 11);
    let want = hl(HlAction::SendAsset {
        destination: leg1.clone(),
        source_dex: "spot".into(),
        destination_dex: "spot".into(),
        token: "USDC:0xeb62eee3685fc4c43992febcd9e75443".into(),
        amount: "4".into(),
        from_sub_account: String::new(),
        nonce: 11,
    });
    assert_eq!(signed(), vec![(format!("{}/leg0", o.addr), want)]);
    assert_eq!(c.get_owner(o.addr.clone()).unwrap().spent_today, 4_000_000);

    // one cooldown clock and one daily cap, shared with `rebalance`
    ctx(AGENT, day0 + 599);
    expect_panic("cooldown", || {
        let _ = c.rebalance(o.addr.clone(), 0, leg1.clone(), "1".into(), 12);
    });
    ctx(AGENT, day0 + 600);
    expect_panic("daily cap exceeded", || {
        let _ = c.rebalance_spot(o.addr.clone(), 0, leg1.clone(), "7".into(), 13);
    });
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
    assert!(c.on_signed(ok["payload"].as_str().unwrap().into(), None, None, Some(refund), None, Ok(fake_mpc_sig())).is_some());
    let st = c.get_owner(o.addr.clone()).unwrap();
    assert_eq!((st.spent_today, st.last_rebalance_ns), (4_000_000, day0 * 1_000_000_000), "success keeps the spend");

    let t1 = day0 + 600;
    ctx(AGENT, t1);
    let _ = c.rebalance(o.addr.clone(), 0, leg1.clone(), "6".into(), 2);
    let failed = on_signed_args();
    ctx(CONTRACT, t1 + 5);
    let refund: CapRefund = serde_json::from_value(failed["refund"].clone()).unwrap();
    assert!(c.on_signed(failed["payload"].as_str().unwrap().into(), None, None, Some(refund), None, Err(PromiseError::Failed)).is_none());
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
        Leash::new("admin.testnet".parse().unwrap(), "v1.signer-prod.testnet".parse().unwrap(), true, None, None);
    });
    let mut b = VMContextBuilder::new();
    b.current_account_id("leash.near".parse().unwrap()).predecessor_account_id("leash.near".parse().unwrap());
    testing_env!(b.build());
    expect_panic("spike build: testnet only", || {
        Leash::new("admin.near".parse().unwrap(), "v1.signer".parse().unwrap(), false, None, None);
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

// ---- C20: L1 cancel signed with the leg's master key ----

const KEEPER: &str = "keeper.testnet";

fn cancels(n: usize) -> Vec<l1::HlCancel> {
    (0..n).map(|i| l1::HlCancel { a: 3, o: 64_820_881_296 + i as u64 }).collect()
}

/// owner(seed) with leg 0 registered and, if `frozen`, frozen (nonce 0 = the freeze).
fn cancel_setup(seed: u8, frozen: bool) -> (Leash, Owner) {
    let mut c = contract();
    let o = owner(seed);
    register(&mut c, &o, 0, seed.wrapping_add(100));
    if frozen {
        ctx(RELAYER, T0);
        o.exec(&mut c, 0, OwnerIntent::Freeze { frozen: true });
    }
    (c, o)
}

#[test]
fn cancel_orders_refused_when_not_frozen_and_not_owner_signed() {
    let (mut c, o) = cancel_setup(61, false);
    ctx(KEEPER, T0);
    expect_panic("owner is not frozen", || {
        let _ = c.cancel_orders(o.addr.clone(), 0, cancels(1));
    });
    // an owner the contract never saw is not frozen either
    expect_panic("owner is not frozen", || {
        let _ = c.cancel_orders(owner(62).addr, 0, cancels(1));
    });
    assert!(signed().is_empty());
}

#[test]
fn cancel_orders_while_frozen_anyone_gets_the_l1_digest_signed_with_block_time_nonce() {
    let (mut c, o) = cancel_setup(63, true);
    ctx(KEEPER, T0 + 5); // a function-call key, 0 deposit: the contract pays the 1 yocto MPC deposit
    let cs = cancels(2);
    let _ = c.cancel_orders(o.addr.clone(), 0, cs.clone());
    let nonce = (T0 + 5) * 1000;
    assert_eq!(signed(), vec![(leg_path(&o.addr, 0), hex::encode(l1::cancel_digest(&cs, nonce, false)))]);
    assert_eq!(c.l1_cancel_digest(cs.clone(), nonce), hex::encode(l1::cancel_digest(&cs, nonce, false)));
    let cb = on_signed_args();
    assert_eq!(cb["nonce"], nonce);
    assert_eq!(cb["action"], serde_json::json!({ "type": "cancel", "cancels": [{ "a": 3, "o": 64_820_881_296u64 }, { "a": 3, "o": 64_820_881_297u64 }] }));
}

#[test]
fn cancel_orders_refuses_unregistered_leg_and_the_cap() {
    let (mut c, o) = cancel_setup(64, true);
    ctx(KEEPER, T0);
    expect_panic("leg not registered", || {
        let _ = c.cancel_orders(o.addr.clone(), 1, cancels(1));
    });
    expect_panic("cancels: 1 to 16 per call", || {
        let _ = c.cancel_orders(o.addr.clone(), 0, cancels(l1::MAX_CANCELS + 1));
    });
    expect_panic("cancels: 1 to 16 per call", || {
        let _ = c.cancel_orders(o.addr.clone(), 0, vec![]);
    });
    let _ = c.cancel_orders(o.addr.clone(), 0, cancels(l1::MAX_CANCELS)); // the cap itself is fine
    assert_eq!(signed().len(), 1);
}

#[test]
fn cancel_orders_intent_works_any_time_and_while_frozen() {
    let (mut c, o) = cancel_setup(65, false);
    ctx(RELAYER, T0 + 1);
    o.exec(&mut c, 0, OwnerIntent::CancelOrders { leg: 0, cancels: cancels(1) });
    assert_eq!(signed(), vec![(leg_path(&o.addr, 0), hex::encode(l1::cancel_digest(&cancels(1), (T0 + 1) * 1000, false)))]);
    ctx(RELAYER, T0 + 2);
    o.exec(&mut c, 1, OwnerIntent::Freeze { frozen: true });
    ctx(RELAYER, T0 + 3);
    o.exec(&mut c, 2, OwnerIntent::CancelOrders { leg: 0, cancels: cancels(3) });
    assert_eq!(signed().len(), 1);
    assert_eq!(c.get_owner(o.addr.clone()).unwrap().nonce, 3);
    expect_panic("cancels: 1 to 16 per call", || o.exec(&mut c, 3, OwnerIntent::CancelOrders { leg: 0, cancels: cancels(17) }));
}

#[test]
fn user_signed_sign_out_has_no_nonce_field() {
    let out = SignOut { payload: "00".into(), big_r: "02".into(), s: "11".into(), recovery_id: 0, action: None, nonce: None };
    assert!(serde_json::to_value(&out).unwrap().get("nonce").is_none());
}

#[test]
#[should_panic(expected = "cancel is an L1 action")]
fn cancel_is_never_signed_as_a_user_signed_action() {
    let _ = HlAction::Cancel { cancels: cancels(1) }.digest("Testnet");
}

// ---- TEE mode ----

const TEE_ACC: &str = "abababababababababababababababababababababababababababababababab"; // implicit account
const OTHER_TEE: &str = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
const FEE: &str = "0x00000000000000000000000000000000000000fe";
const PRICE: u64 = 5_000_000;

fn tee_contract() -> Leash {
    ctx(RELAYER, T0);
    Leash::new("admin.testnet".parse().unwrap(), "v1.signer-prod.testnet".parse().unwrap(), false, Some("5".into()), Some(FEE.into()))
}

/// Registers `acc` with the recorded fixture (verified at the fixture's time, its report_data); returns its hash.
fn register_tee(c: &mut Leash, acc: &str, ts_sec: u64) -> String {
    tee::TEST_VERIFY_OVERRIDE.with(|o| o.set(Some((tee::fixture::TS, tee::fixture::report_data()))));
    ctx(acc, ts_sec);
    let r = catch_unwind(AssertUnwindSafe(|| c.register_tee_agent(tee::fixture::attestation_json(), tee::fixture::measurements_json())));
    tee::TEST_VERIFY_OVERRIDE.with(|o| o.set(None));
    r.unwrap_or_else(|e| std::panic::resume_unwind(e)).measurement_hash
}

/// The fixture's hash with one RTMR byte flipped: a measurement no registered agent has.
fn other_hash() -> String {
    let mut m = tee::fixture::measurements();
    m.rtmrs.rtmr2[0] ^= 1;
    tee::measurement_hash(&m)
}

/// owner with policy (agent AGENT, cap 10), legs 0 and 1; returns (owner, leg1 address).
fn tee_owner(c: &mut Leash, seed: u8) -> (Owner, String) {
    let o = owner(seed);
    set_policy(c, &o, "10", 0); // nonce 0
    register(c, &o, 0, seed.wrapping_add(100));
    let leg1 = register(c, &o, 1, seed.wrapping_add(150));
    (o, leg1)
}

fn set_tee(c: &mut Leash, o: &Owner, hash: &str, account: &str) {
    let nonce = c.get_owner(o.addr.clone()).unwrap().nonce;
    ctx(RELAYER, T0);
    o.exec(c, nonce, OwnerIntent::SetTee { measurement_hash: hash.into(), agent_account: account.into() });
}

fn pay(months: u32) -> OwnerIntent {
    OwnerIntent::PayTee { leg: 1, months, price_micro: PRICE, fee_address: FEE.into() }
}

#[test]
fn register_tee_agent_with_a_recorded_tdx_quote_once() {
    let mut c = tee_contract();
    let h = register_tee(&mut c, TEE_ACC, T0);
    assert_eq!(h, c.measurement_hash(tee::fixture::measurements_json()));
    let a = c.get_tee_agent(TEE_ACC.parse().unwrap()).unwrap();
    assert_eq!(a, tee::TeeAgent { measurement_hash: h, expires_ns: T0 * 1_000_000_000 + tee::TEE_AGENT_TTL_NS });
    // the same quote cannot extend the expiry (nor register another account)
    expect_panic("quote already used", || {
        register_tee(&mut c, TEE_ACC, T0 + 6 * 86_400);
    });
    expect_panic("quote already used", || {
        register_tee(&mut c, OTHER_TEE, T0);
    });
    assert_eq!(c.get_tee_agent(TEE_ACC.parse().unwrap()).unwrap().expires_ns, T0 * 1_000_000_000 + tee::TEE_AGENT_TTL_NS);
}

#[test]
fn register_tee_agent_refuses_bad_attestations() {
    let mut c = tee_contract();
    // the report_data must bind the caller: without the test override it is TEE_ACC's key, not what the quote holds
    tee::TEST_VERIFY_OVERRIDE.with(|o| o.set(Some((tee::fixture::TS, tee::implicit_report_data(&TEE_ACC.parse().unwrap())))));
    ctx(TEE_ACC, T0);
    expect_panic("attestation rejected", || {
        c.register_tee_agent(tee::fixture::attestation_json(), tee::fixture::measurements_json());
    });
    // measurement mismatch: the caller claims measurements the quote does not have
    tee::TEST_VERIFY_OVERRIDE.with(|o| o.set(Some((tee::fixture::TS, tee::fixture::report_data()))));
    let mut m = tee::fixture::measurements_json();
    m["rtmrs"]["rtmr2"] = serde_json::json!("00".repeat(48));
    expect_panic("attestation rejected", || {
        c.register_tee_agent(tee::fixture::attestation_json(), m.clone());
    });
    // tampered quote
    let mut a = tee::fixture::attestation_json();
    a["quote"][700] = serde_json::json!(a["quote"][700].as_u64().unwrap() ^ 1);
    expect_panic("attestation rejected", || {
        c.register_tee_agent(a.clone(), tee::fixture::measurements_json());
    });
    // expired: the block time (2026-11) is past the recorded collateral's window
    tee::TEST_VERIFY_OVERRIDE.with(|o| o.set(Some((T0, tee::fixture::report_data()))));
    expect_panic("expired", || {
        c.register_tee_agent(tee::fixture::attestation_json(), tee::fixture::measurements_json());
    });
    tee::TEST_VERIFY_OVERRIDE.with(|o| o.set(None));
    assert!(c.get_tee_agent(TEE_ACC.parse().unwrap()).is_none());
}

#[test]
fn tee_owner_refuses_the_server_agent_and_accepts_its_own_tee_agent() {
    let mut c = tee_contract();
    let h = register_tee(&mut c, TEE_ACC, T0);
    let (o, leg1) = tee_owner(&mut c, 71);
    // before setTee: the server agent works
    ctx(AGENT, T0);
    let _ = c.rebalance(o.addr.clone(), 0, leg1.clone(), "1".into(), 1);
    set_tee(&mut c, &o, &h, TEE_ACC);
    ctx(AGENT, T0 + 100);
    expect_panic("not the owner's TEE agent", || {
        let _ = c.rebalance(o.addr.clone(), 0, leg1.clone(), "1".into(), 2);
    });
    expect_panic("not the owner's TEE agent", || {
        let _ = c.agent_usd_class_transfer(o.addr.clone(), 0, "1".into(), true, 2);
    });
    // the owner's attested instance may, and cap / cooldown still apply
    ctx(TEE_ACC, T0 + 100);
    let _ = c.rebalance(o.addr.clone(), 0, leg1.clone(), "1".into(), 3);
    assert_eq!(signed().len(), 1);
    expect_panic("daily cap exceeded", || {
        let _ = c.rebalance(o.addr.clone(), 0, leg1.clone(), "9".into(), 4);
    });
    let _ = c.agent_usd_class_transfer(o.addr.clone(), 0, "1".into(), true, 5);
    // expired agent
    ctx(TEE_ACC, T0 + 8 * 86_400);
    expect_panic("expired", || {
        let _ = c.rebalance(o.addr.clone(), 0, leg1.clone(), "1".into(), 6);
    });
}

#[test]
fn a_stranger_running_the_same_image_is_refused() {
    let mut c = tee_contract();
    let h = register_tee(&mut c, TEE_ACC, T0);
    let (o, leg1) = tee_owner(&mut c, 72);
    // the owner named another instance: TEE_ACC has the right measurement but is not the owner's account
    set_tee(&mut c, &o, &h, OTHER_TEE);
    ctx(TEE_ACC, T0);
    expect_panic("not the owner's TEE agent", || {
        let _ = c.rebalance(o.addr.clone(), 0, leg1.clone(), "1".into(), 1);
    });
    expect_panic("not the owner's TEE agent", || {
        let _ = c.tee_approve_agent(o.addr.clone(), 0, owner(80).addr, 1);
    });
    // and the named account must also be attested with the owner's measurement
    set_tee(&mut c, &o, &other_hash(), TEE_ACC);
    ctx(TEE_ACC, T0);
    expect_panic("does not match the owner's", || {
        let _ = c.rebalance(o.addr.clone(), 0, leg1.clone(), "1".into(), 1);
    });
    set_tee(&mut c, &o, &h, OTHER_TEE);
    ctx(OTHER_TEE, T0);
    expect_panic("not a registered TEE agent", || {
        let _ = c.rebalance(o.addr.clone(), 0, leg1.clone(), "1".into(), 1);
    });
}

#[test]
fn set_tee_needs_an_account_with_a_hash_and_none_with_zero() {
    let mut c = tee_contract();
    let (o, _) = tee_owner(&mut c, 78);
    ctx(RELAYER, T0);
    expect_panic("agentAccount", || o.exec(&mut c, 1, OwnerIntent::SetTee { measurement_hash: other_hash(), agent_account: "".into() }));
    expect_panic("agentAccount", || o.exec(&mut c, 1, OwnerIntent::SetTee { measurement_hash: tee::ZERO_HASH.into(), agent_account: TEE_ACC.into() }));
}

#[test]
fn tee_approve_agent_signs_the_fixed_name_records_the_key() {
    let mut c = tee_contract();
    let h = register_tee(&mut c, TEE_ACC, T0);
    let (o, _) = tee_owner(&mut c, 73);
    let key = owner(81).addr;
    ctx(TEE_ACC, T0);
    expect_panic("not in TEE mode", || {
        let _ = c.tee_approve_agent(o.addr.clone(), 0, key.clone(), 1);
    });
    set_tee(&mut c, &o, &h, TEE_ACC);
    ctx(TEE_ACC, T0);
    expect_panic("leg not registered", || {
        let _ = c.tee_approve_agent(o.addr.clone(), 3, key.clone(), 1);
    });
    let _ = c.tee_approve_agent(o.addr.clone(), 0, key.clone(), 7);
    let want = hl(HlAction::ApproveAgent { agent_address: key.clone(), agent_name: tee::TEE_AGENT_NAME.into(), nonce: 7 });
    assert_eq!(signed(), vec![(leg_path(&o.addr, 0), want)]);
    let t = c.get_tee(o.addr.clone()).unwrap();
    assert_eq!((t.measurement_hash, t.agent_account.map(|a| a.to_string()), t.keys.get(&0)), (Some(h), Some(TEE_ACC.to_string()), Some(&key)));
    assert!(c.get_agent_slots(o.addr.clone()).contains(&AgentSlot { leg: 0, name: tee::TEE_AGENT_NAME.into() }));
    ctx(TEE_ACC, T0 + 8 * 86_400);
    expect_panic("expired", || {
        let _ = c.tee_approve_agent(o.addr.clone(), 0, key.clone(), 8);
    });
}

/// The (path, digest) of a burn approveAgent for each (leg, name), in slot order, as freeze signs them.
fn burns(o: &Owner, slots: &[(u32, &str)]) -> Vec<(String, String)> {
    slots
        .iter()
        .enumerate()
        .map(|(i, (leg, name))| {
            let path = leg_path(&o.addr, *leg);
            (path.clone(), hl(HlAction::ApproveAgent { agent_address: burn_address(&path), agent_name: (*name).into(), nonce: T0 * 1000 + i as u64 }))
        })
        .collect()
}

#[test]
fn entering_tee_burns_the_servers_agents_on_every_leg() {
    let mut c = tee_contract();
    let h = register_tee(&mut c, TEE_ACC, T0);
    let (o, _) = tee_owner(&mut c, 79); // nonce 0 used, legs 0 and 1
    register(&mut c, &o, 2, 229);
    for leg in 0..3u32 {
        ctx(RELAYER, T0);
        o.exec(&mut c, 1 + leg as u64, approve_named(leg, &format!("leash-leg{leg}"), 90 + leg as u8));
    }
    set_tee(&mut c, &o, &h, TEE_ACC);
    assert_eq!(signed(), burns(&o, &[(0, "leash-leg0"), (1, "leash-leg1"), (2, "leash-leg2")]));
    assert_eq!(c.get_tee(o.addr.clone()).unwrap().measurement_hash, Some(h));
}

#[test]
fn entering_tee_needs_freezes_gas_budget() {
    let mut c = tee_contract();
    let h = register_tee(&mut c, TEE_ACC, T0);
    let (o, _) = tee_owner(&mut c, 84);
    register(&mut c, &o, 2, 230);
    for leg in 0..3u32 {
        ctx(RELAYER, T0);
        o.exec(&mut c, 1 + leg as u64, approve_named(leg, &format!("leash-leg{leg}"), 100 + leg as u8));
    }
    // three revocations need 3 x 20 + 15 + 5 = 80 TGas prepaid, as a freeze of three agents does
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .predecessor_account_id(RELAYER.parse().unwrap())
        .block_timestamp(T0 * 1_000_000_000)
        .attached_deposit(RELAYER_DEPOSIT)
        .prepaid_gas(Gas::from_tgas(60));
    testing_env!(b.build());
    expect_panic("attach more gas: freezing 3 agents needs 80 TGas", || {
        o.exec(&mut c, 4, OwnerIntent::SetTee { measurement_hash: h.clone(), agent_account: TEE_ACC.into() })
    });
}

#[test]
fn exit_and_switch_burn_the_tee_keys_and_same_settings_burn_nothing() {
    let mut c = tee_contract();
    let h = register_tee(&mut c, TEE_ACC, T0);
    let (o, _) = tee_owner(&mut c, 80); // no server agents approved
    set_tee(&mut c, &o, &h, TEE_ACC);
    assert!(signed().is_empty(), "nothing approved yet, nothing to burn");
    ctx(TEE_ACC, T0);
    let _ = c.tee_approve_agent(o.addr.clone(), 0, owner(83).addr, 1);
    let _ = c.tee_approve_agent(o.addr.clone(), 1, owner(84).addr, 2);
    // same hash and account again: nothing to burn, keys kept
    set_tee(&mut c, &o, &h, TEE_ACC);
    assert!(signed().is_empty());
    assert_eq!(c.get_tee(o.addr.clone()).unwrap().keys.len(), 2);
    // switching instance burns the leash-tee keys and clears them
    set_tee(&mut c, &o, &h, OTHER_TEE);
    assert_eq!(signed(), burns(&o, &[(0, tee::TEE_AGENT_NAME), (1, tee::TEE_AGENT_NAME)]));
    assert!(c.get_tee(o.addr.clone()).unwrap().keys.is_empty());
    // exit burns every tracked slot again (re-pointing a burned name to its burn address is harmless)
    set_tee(&mut c, &o, tee::ZERO_HASH, "");
    assert_eq!(signed(), burns(&o, &[(0, tee::TEE_AGENT_NAME), (1, tee::TEE_AGENT_NAME)]));
    let t = c.get_tee(o.addr.clone()).unwrap();
    assert_eq!((t.measurement_hash, t.agent_account), (None, None));
}

#[test]
fn a_non_tee_owner_keeps_its_agents_when_another_owner_enters_tee() {
    let mut c = tee_contract();
    let h = register_tee(&mut c, TEE_ACC, T0);
    let (plain, _) = tee_owner(&mut c, 81);
    ctx(RELAYER, T0);
    plain.exec(&mut c, 1, approve_named(0, "leash-leg0", 95));
    let (o, _) = tee_owner(&mut c, 82);
    ctx(RELAYER, T0);
    o.exec(&mut c, 1, approve_named(0, "leash-leg0", 96));
    set_tee(&mut c, &o, &h, TEE_ACC);
    assert_eq!(signed(), burns(&o, &[(0, "leash-leg0")]), "only the entering owner's slots");
    assert!(c.get_tee(plain.addr.clone()).is_none());
    assert_eq!(c.get_agent_slots(plain.addr.clone()), vec![AgentSlot { leg: 0, name: "leash-leg0".into() }]);
    // the plain owner's server agent and own approvals still work
    ctx(AGENT, T0);
    let leg1 = c.get_leg(plain.addr.clone(), 1).unwrap();
    let _ = c.rebalance(plain.addr.clone(), 0, leg1, "1".into(), 1);
    ctx(RELAYER, T0);
    plain.exec(&mut c, 2, approve_named(1, "leash-leg1", 97));
    assert_eq!(signed().len(), 1);
}

#[test]
fn owner_approve_agent_is_refused_in_tee_mode_and_allowed_after_leaving() {
    let mut c = tee_contract();
    let h = register_tee(&mut c, TEE_ACC, T0);
    let (o, _) = tee_owner(&mut c, 74);
    set_tee(&mut c, &o, &h, TEE_ACC); // nonce 1
    ctx(RELAYER, T0);
    expect_panic("owner is in TEE mode", || o.exec(&mut c, 2, approve(&owner(82).addr)));
    set_tee(&mut c, &o, tee::ZERO_HASH, ""); // leave
    ctx(RELAYER, T0);
    o.exec(&mut c, 3, approve(&owner(82).addr));
    assert_eq!(signed().len(), 1);
    ctx(AGENT, T0);
    let leg1 = c.get_leg(o.addr.clone(), 1).unwrap();
    let _ = c.rebalance(o.addr.clone(), 0, leg1, "1".into(), 1);
}

#[test]
fn pay_tee_signs_the_signed_price_to_the_signed_address_and_commits_on_signature() {
    let mut c = tee_contract();
    let (o, _) = tee_owner(&mut c, 75);
    ctx(RELAYER, T0);
    expect_panic("setTee first", || o.exec(&mut c, 1, pay(1)));
    set_tee(&mut c, &o, &other_hash(), TEE_ACC); // nonce 1
    for months in [0, 13] {
        ctx(RELAYER, T0);
        expect_panic("months: 1 to 12", || o.exec(&mut c, 2, pay(months)));
    }
    ctx(RELAYER, T0);
    expect_panic("differ from the TEE config", || {
        o.exec(&mut c, 2, OwnerIntent::PayTee { leg: 1, months: 1, price_micro: 1, fee_address: FEE.into() })
    });
    expect_panic("differ from the TEE config", || {
        o.exec(&mut c, 2, OwnerIntent::PayTee { leg: 1, months: 1, price_micro: PRICE, fee_address: owner(85).addr })
    });
    ctx(RELAYER, T0);
    o.exec(&mut c, 2, pay(3));
    let want = hl(HlAction::UsdSend { destination: FEE.into(), amount: "15".into(), time: T0 * 1000 });
    assert_eq!(signed(), vec![(leg_path(&o.addr, 1), want)]);
    // nothing is committed until the MPC signature exists
    assert_eq!(c.get_tee(o.addr.clone()).unwrap().months_paid, 0);
    let cb = on_signed_args();
    let pay_rec: tee::TeePayment = serde_json::from_value(cb["tee_pay"].clone()).unwrap();
    ctx(CONTRACT, T0);
    assert!(c.on_signed(cb["payload"].as_str().unwrap().into(), None, None, None, Some(pay_rec), Ok(fake_mpc_sig())).is_some());
    let paid = T0 * 1_000_000_000 + 3 * tee::TEE_MONTH_NS;
    let t = c.get_tee(o.addr.clone()).unwrap();
    assert_eq!((t.paid_until_ns, t.months_paid), (paid, 3));
    // a failed signature commits nothing
    ctx(CONTRACT, T0);
    assert!(c.on_signed("00".repeat(32), None, None, None, Some(tee::TeePayment { owner: o.addr.clone(), months: 12 }), Err(PromiseError::Failed)).is_none());
    assert_eq!(c.get_tee(o.addr.clone()).unwrap().months_paid, 3);
    // a second payment extends from paid_until
    ctx(CONTRACT, T0 + 10);
    let _ = c.on_signed("00".repeat(32), None, None, None, Some(tee::TeePayment { owner: o.addr.clone(), months: 12 }), Ok(fake_mpc_sig()));
    let t = c.get_tee(o.addr.clone()).unwrap();
    assert_eq!((t.paid_until_ns, t.months_paid), (paid + 12 * tee::TEE_MONTH_NS, 15));
}

#[test]
fn pay_tee_needs_a_configured_price() {
    let mut c = contract(); // no TEE price at init
    let (o, _) = tee_owner(&mut c, 76);
    set_tee(&mut c, &o, &other_hash(), TEE_ACC);
    ctx(RELAYER, T0);
    expect_panic("not offered", || o.exec(&mut c, 2, pay(1)));
    let cfg = c.get_config();
    assert_eq!((cfg["tee_price_usd"].clone(), cfg["tee_fee_address"].clone()), (Value::Null, Value::Null));
    let cfg = tee_contract().get_config();
    assert_eq!((cfg["tee_price_usd"].as_str(), cfg["tee_fee_address"].as_str()), (Some("5"), Some(FEE)));
}

#[test]
fn non_tee_owner_has_no_tee_entry() {
    let mut c = tee_contract();
    let (o, _) = tee_owner(&mut c, 77);
    assert!(c.get_tee(o.addr.clone()).is_none());
    assert_eq!(fmt_usd(1), "0.000001");
    assert_eq!(fmt_usd(12_500_000), "12.5");
}

#[cfg(feature = "spike")]
#[test]
fn spike_dev_registration_and_admin_tee_config() {
    let mut c = tee_contract();
    ctx(OTHER_TEE, T0);
    let a = c.register_tee_agent_dev(tee::fixture::measurements_json());
    assert_eq!(a.measurement_hash, c.measurement_hash(tee::fixture::measurements_json()));
    ctx(RELAYER, T0);
    expect_panic("admin only", || c.set_tee_config("7.5".into(), FEE.into()));
    ctx("admin.testnet", T0);
    c.set_tee_config("7.5".into(), FEE.into());
    assert_eq!(c.get_config()["tee_price_usd"].as_str(), Some("7.5"));
}
