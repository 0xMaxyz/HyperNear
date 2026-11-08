//! leash: Hyperliquid accounts whose keys are NEAR Chain Signatures held by this contract.
//!
//! Leg i of an owner (an EVM address) is the MPC key derived for (this contract, "{owner}/leg{i}").
//! The owner acts through EIP-712 intents (auth.rs) that anyone may relay; the owner's agent (a NEAR
//! account) may only move USDC between that owner's registered legs, under a daily cap and a cooldown.
//! The contract limits where funds can go, not whether a trade loses them.

use near_sdk::env::{self, keccak256_array};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{
    log, near, require, AccountId, BorshStorageKey, CurveType, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue, PublicKey,
};

pub mod auth;
pub mod eip712;
pub mod l1;
use auth::OwnerIntent;
use eip712::{parse_addr, parse_usd, HlAction};

/// MPC `sign` requires >= 15 TGas prepaid (v1.signer-prod.testnet config, 2026-11-07); 7 of it funds its resume callback.
const MPC_SIGN_GAS: Gas = Gas::from_tgas(50);
const ON_SIGNED_GAS: Gas = Gas::from_tgas(10);
/// Per-agent MPC sign inside a freeze batch (measured: a whole sign tx burns ~12 TGas; MPC needs >= 15 prepaid).
const REVOKE_SIGN_GAS: Gas = Gas::from_tgas(20);
const ON_REVOKED_GAS: Gas = Gas::from_tgas(15);
/// Agent names tracked per owner. Bounds a freeze to one transaction: 8 x 20 + 15 TGas < 300 TGas.
pub const MAX_TRACKED_AGENTS: usize = 8;
const MPC_VIEW_GAS: Gas = Gas::from_tgas(10);
const ON_LEG_GAS: Gas = Gas::from_tgas(10);
/// near/mpc `SIGN_DEPOSIT_YOCTONEAR`; any excess is refunded. Paid from this contract's balance.
const MPC_SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);
/// Domain 0 = secp256k1 (legacy ECDSA domain).
const MPC_ECDSA_DOMAIN: u64 = 0;
const DAY_NS: u64 = 86_400 * 1_000_000_000;
/// Covers the two leg records (~270 bytes, 0.0027 NEAR); the callback refunds the rest.
/// shortcut: the callback cannot fail cleanly once the MPC answered, so this must stay above the real cost.
pub const REGISTER_LEG_DEPOSIT: NearToken = NearToken::from_millinear(5);

/// Requires `attached` to cover the storage added since `before`; refunds the excess to `payer`.
fn charge_storage(before: u64, attached: NearToken, payer: &AccountId) {
    let added = env::storage_usage().saturating_sub(before);
    let cost = env::storage_byte_cost().saturating_mul(added as u128);
    require!(attached >= cost, format!("attach at least {} yoctoNEAR for storage", cost.as_yoctonear()));
    let refund = attached.saturating_sub(cost);
    if !refund.is_zero() {
        Promise::new(payer.clone()).transfer(refund).detach();
    }
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Owners,
    Legs,
    LegOwner,
    AgentNames,
}

/// An HL agent name approved through the contract on one of the owner's legs (freeze re-points it to a burn address).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentSlot {
    pub leg: u32,
    pub name: String,
}

/// One revocation of a freeze: the approveAgent(burn) the relayer posts to HL, or null if the MPC sign failed.
#[near(serializers = [json])]
pub struct Revoked {
    pub leg: u32,
    pub name: String,
    pub burn_address: String,
    pub signature: Option<SignOut>,
}

/// A keyless address per leg path: keccak256("leash-burn:" + path)[12..]. Per leg, because HL refuses an agent
/// address that another master already uses ("Extra agent already used", C4).
pub fn burn_address(path: &str) -> String {
    format!("0x{}", hex::encode(&keccak256_array(format!("leash-burn:{path}").as_bytes())[12..]))
}

/// owner -> agent names approved through the contract. Kept outside the root struct so the deployed state layout
/// does not change (no migration); hence the explicit flush() after writes.
fn agent_slots() -> LookupMap<String, Vec<AgentSlot>> {
    LookupMap::new(Key::AgentNames)
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OwnerState {
    /// Next intent nonce.
    pub nonce: u64,
    pub frozen: bool,
    pub agent: Option<AccountId>,
    /// micro-USD per UTC day, for `rebalance`.
    pub daily_cap: u64,
    pub cooldown_sec: u64,
    pub day: u64,
    pub spent_today: u64,
    pub last_rebalance_ns: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Leash {
    admin: AccountId,
    mpc_contract: AccountId,
    hl_mainnet: bool,
    /// owner (0x lowercase) -> state
    owners: LookupMap<String, OwnerState>,
    /// leg path "{owner}/leg{i}" -> leg EVM address (0x lowercase)
    legs: LookupMap<String, String>,
    /// leg EVM address -> owner
    leg_owner: LookupMap<String, String>,
}

/// State layout of the D1 spike deployment, read once by `migrate` (testnet only).
#[cfg(feature = "spike")]
#[near(serializers = [borsh])]
struct LeashV0 {
    admin: AccountId,
    mpc_contract: AccountId,
    hl_mainnet: bool,
}

/// Wire shape of near/mpc `SignatureResponse::Secp256k1` (the `scheme` tag is ignored).
#[near(serializers = [json])]
pub struct MpcAffinePoint {
    pub affine_point: String,
}
#[near(serializers = [json])]
pub struct MpcScalar {
    pub scalar: String,
}
#[near(serializers = [json])]
pub struct MpcSignature {
    pub big_r: MpcAffinePoint,
    pub s: MpcScalar,
    pub recovery_id: u8,
}

/// What `rebalance` committed before the MPC promise, so `on_signed` can give it back on failure.
#[near(serializers = [json])]
pub struct CapRefund {
    pub owner: String,
    pub amount: u64,
    /// block time of the rebalance (also identifies it in `last_rebalance_ns`)
    pub at_ns: u64,
    pub prev_last_ns: u64,
}

/// big_r is the 33-byte compressed point (r = big_r[1..]), all hex without 0x.
/// `action` is the HL action that was signed (post it with hyperliquidChain + signatureChainId 0x66eee).
#[near(serializers = [json])]
pub struct SignOut {
    pub payload: String,
    pub big_r: String,
    pub s: String,
    pub recovery_id: u8,
    pub action: Option<HlAction>,
    /// L1 actions only (cancel): the /exchange `nonce`, chosen by the contract (user-signed actions carry theirs inside `action`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nonce: Option<u64>,
}

/// A `spike` build must never run on mainnet: refuse to init there, and refuse the admin methods.
#[cfg(feature = "spike")]
fn assert_testnet(hl_mainnet: bool) {
    require!(
        !hl_mainnet && env::current_account_id().as_str().ends_with(".testnet"),
        "spike build: testnet only"
    );
}

#[cfg(feature = "spike")]
fn parse_hex<const N: usize>(s: &str, what: &str) -> [u8; N] {
    hex::decode(s.trim_start_matches("0x"))
        .ok()
        .and_then(|v| v.try_into().ok())
        .unwrap_or_else(|| env::panic_str(&format!("{what}: expected {N} hex bytes")))
}

pub fn leg_path(owner: &str, leg: u32) -> String {
    format!("{owner}/leg{leg}")
}

#[near]
impl Leash {
    #[init]
    pub fn new(admin: AccountId, mpc_contract: AccountId, hl_mainnet: bool) -> Self {
        Self::from_parts(admin, mpc_contract, hl_mainnet)
    }

    // ---- owner (anyone may relay; the EIP-712 signature is the authentication) ----

    /// Runs a signed owner intent. HL actions return the MPC signature (SignOut); the others return null.
    /// The nonce is consumed here, before any MPC promise, so a failed sign burns it.
    /// The caller pays any storage this adds (first intent of an owner, setting an agent); excess is refunded.
    #[payable]
    pub fn owner_execute(
        &mut self,
        owner: String,
        nonce: u64,
        intent: OwnerIntent,
        signature: String,
    ) -> PromiseOrValue<near_sdk::serde_json::Value> {
        let storage_before = env::storage_usage();
        let owner_b = parse_addr(&owner);
        let digest = auth::intent_digest(self.domain(), &owner_b, nonce, &intent);
        require!(auth::recover_signer(&digest, &signature) == owner_b, "signature does not match owner");
        let mut st = self.owners.get(&owner).cloned().unwrap_or_default();
        require!(nonce == st.nonce, "bad nonce");
        st.nonce += 1;
        require!(
            !st.frozen || matches!(intent, OwnerIntent::Withdraw { .. } | OwnerIntent::Freeze { .. } | OwnerIntent::CancelOrders { .. }),
            "frozen"
        );
        let mut revoke = false;
        let mut cancel = None;
        let to_sign = match intent {
            OwnerIntent::ApproveAgent { leg, agent, agent_name, hl_nonce } => {
                let mut slots = agent_slots();
                let list = slots.entry(owner.clone()).or_default();
                let slot = AgentSlot { leg, name: agent_name.clone() };
                if !list.contains(&slot) {
                    require!(list.len() < MAX_TRACKED_AGENTS, "too many agent names for one owner (freeze must fit one tx)");
                    list.push(slot);
                }
                slots.flush();
                Some((leg, HlAction::ApproveAgent { agent_address: agent, agent_name, nonce: hl_nonce }))
            }
            OwnerIntent::Withdraw { leg, amount, hl_time } => {
                Some((leg, HlAction::Withdraw { destination: owner.clone(), amount, time: hl_time }))
            }
            OwnerIntent::UsdClassTransfer { leg, amount, to_perp, hl_nonce } => {
                Some((leg, HlAction::UsdClassTransfer { amount, to_perp, nonce: hl_nonce }))
            }
            OwnerIntent::SetPolicy { agent, daily_cap, cooldown_sec } => {
                if agent.is_empty() {
                    st.agent = None;
                } else {
                    st.agent = Some(agent.parse().unwrap_or_else(|_| env::panic_str("bad agent account id")));
                    st.daily_cap = parse_usd(&daily_cap);
                }
                st.cooldown_sec = cooldown_sec;
                None
            }
            OwnerIntent::Freeze { frozen } => {
                st.frozen = frozen;
                revoke = frozen; // unfreezing approves nothing: the owner approves fresh agents
                None
            }
            OwnerIntent::CancelOrders { leg, cancels } => {
                l1::check_cancels(&cancels);
                cancel = Some((leg, cancels));
                None
            }
        };
        self.owners.insert(owner.clone(), st);
        self.owners.flush();
        charge_storage(storage_before, env::attached_deposit(), &env::predecessor_account_id());
        if revoke {
            if let Some(p) = self.revoke_agents(&owner) {
                return PromiseOrValue::Promise(p);
            }
        }
        if let Some((leg, cancels)) = cancel {
            return PromiseOrValue::Promise(self.sign_cancel(leg_path(&owner, leg), cancels));
        }
        match to_sign {
            Some((leg, action)) => PromiseOrValue::Promise(self.sign_hl(leg_path(&owner, leg), action)),
            None => PromiseOrValue::Value(near_sdk::serde_json::Value::Null),
        }
    }

    /// Anyone, but only while `owner` is frozen: signs an HL L1 `cancel` of resting orders on a registered leg with
    /// the leg's master key, so a frozen account's book can be cleared without the agent server (owner's browser,
    /// any keeper). The freeze was owner-signed and a cancel cannot move funds. At any other time the owner uses the
    /// `cancelOrders` intent. The HL nonce is the block time (ms), never caller-chosen: a keeper must not be able
    /// to fill the leg key's HL nonce window with future nonces. Returns the SignOut to POST as
    /// `{action, nonce, signature, vaultAddress: null}` to /exchange.
    pub fn cancel_orders(&mut self, owner: String, leg: u32, cancels: Vec<l1::HlCancel>) -> Promise {
        parse_addr(&owner);
        require!(
            self.owners.get(&owner).is_some_and(|s| s.frozen),
            "owner is not frozen: use the owner-signed cancelOrders intent"
        );
        let path = leg_path(&owner, leg);
        require!(self.legs.contains_key(&path), "leg not registered");
        l1::check_cancels(&cancels);
        self.sign_cancel(path, cancels)
    }

    /// Digest (hex) of an L1 cancel with this nonce on this contract's HL chain (what the leg key signs).
    pub fn l1_cancel_digest(&self, cancels: Vec<l1::HlCancel>, nonce: u64) -> String {
        hex::encode(l1::cancel_digest(&cancels, nonce, self.hl_mainnet))
    }

    /// Freeze callback: one result per agent name (joined MPC signs, in `slots` order).
    #[private]
    pub fn on_revoked(&self, slots: Vec<(AgentSlot, String, String, HlAction)>) -> Vec<Revoked> {
        slots
            .into_iter()
            .enumerate()
            .map(|(i, (slot, burn, payload, action))| {
                #[allow(deprecated)]
                let sig = match env::promise_result(i as u64) {
                    near_sdk::PromiseResult::Successful(bytes) => near_sdk::serde_json::from_slice::<MpcSignature>(&bytes).ok(),
                    _ => None,
                };
                if sig.is_none() {
                    log!("MPC sign failed for agent {} on leg {}", slot.name, slot.leg);
                }
                Revoked {
                    leg: slot.leg,
                    name: slot.name,
                    burn_address: burn,
                    signature: sig.map(|s| SignOut { payload, big_r: s.big_r.affine_point, s: s.s.scalar, recovery_id: s.recovery_id, action: Some(action), nonce: None }),
                }
            })
            .collect()
    }

    /// Agent names approved through the contract for this owner (what a freeze revokes).
    pub fn get_agent_slots(&self, owner: String) -> Vec<AgentSlot> {
        agent_slots().get(&owner).cloned().unwrap_or_default()
    }

    /// Anyone: records the EVM address of `owner`'s leg, read from the MPC contract (not trusted from the caller).
    /// Attach >= REGISTER_LEG_DEPOSIT for storage; the callback refunds what the entries did not use
    /// (all of it if the MPC view fails).
    #[payable]
    pub fn register_leg(&mut self, owner: String, leg: u32) -> Promise {
        parse_addr(&owner);
        let deposit = env::attached_deposit();
        require!(deposit >= REGISTER_LEG_DEPOSIT, format!("attach {REGISTER_LEG_DEPOSIT} for storage"));
        let path = leg_path(&owner, leg);
        require!(!self.legs.contains_key(&path), "leg already registered");
        let args = json!({ "path": path, "predecessor": env::current_account_id(), "domain_id": MPC_ECDSA_DOMAIN });
        Promise::new(self.mpc_contract.clone())
            .function_call("derived_public_key", args.to_string().into_bytes(), NearToken::from_yoctonear(0), MPC_VIEW_GAS)
            .then(Self::ext(env::current_account_id()).with_static_gas(ON_LEG_GAS).on_leg_derived(
                owner,
                path,
                env::predecessor_account_id(),
                deposit,
            ))
    }

    /// Returns the leg address, or null (deposit refunded) if the MPC view failed.
    #[private]
    pub fn on_leg_derived(
        &mut self,
        owner: String,
        path: String,
        payer: AccountId,
        deposit: NearToken,
        #[callback_result] res: Result<String, PromiseError>,
    ) -> Option<String> {
        let pk = res.ok().and_then(|s| s.parse::<PublicKey>().ok()).filter(|pk| pk.curve_type() == CurveType::SECP256K1);
        let Some(pk) = pk else {
            log!("derived_public_key failed or not secp256k1; refunding");
            Promise::new(payer).transfer(deposit).detach();
            return None;
        };
        let addr = format!("0x{}", hex::encode(&keccak256_array(&pk.as_bytes()[1..])[12..]));
        let storage_before = env::storage_usage();
        self.legs.insert(path, addr.clone());
        self.leg_owner.insert(addr.clone(), owner);
        self.legs.flush();
        self.leg_owner.flush();
        charge_storage(storage_before, deposit, &payer);
        Some(addr)
    }

    // ---- agent (authenticated by predecessor == the owner's policy agent) ----

    /// Spot -> perp only (`to_perp` must be true): it adds margin, which is the guard's job.
    /// Perp -> spot stays owner-only.
    pub fn agent_usd_class_transfer(
        &mut self,
        owner: String,
        leg: u32,
        amount: String,
        to_perp: bool,
        hl_nonce: u64,
    ) -> Promise {
        self.agent_state(&owner);
        require!(to_perp, "agent may only move spot to perp");
        self.sign_hl(leg_path(&owner, leg), HlAction::UsdClassTransfer { amount, to_perp, nonce: hl_nonce })
    }

    /// usdSend from one of `owner`'s legs to another registered leg of the same owner, within cap and cooldown.
    pub fn rebalance(&mut self, owner: String, from_leg: u32, to_address: String, amount: String, hl_time: u64) -> Promise {
        let mut st = self.agent_state(&owner);
        require!(
            self.leg_owner.get(&to_address) == Some(&owner),
            "destination is not a registered leg of this owner"
        );
        let from_path = leg_path(&owner, from_leg);
        require!(self.legs.contains_key(&from_path), "source leg not registered");
        require!(self.legs.get(&from_path) != Some(&to_address), "source equals destination");
        let amt = parse_usd(&amount);
        let now = env::block_timestamp();
        require!(
            st.last_rebalance_ns == 0 || now >= st.last_rebalance_ns.saturating_add(st.cooldown_sec.saturating_mul(1_000_000_000)),
            "cooldown"
        );
        let day = now / DAY_NS;
        if day != st.day {
            st.day = day;
            st.spent_today = 0;
        }
        require!(st.spent_today.saturating_add(amt) <= st.daily_cap, "daily cap exceeded");
        // committed before the promise; on_signed gives both back if the MPC sign fails
        let refund = CapRefund { owner: owner.clone(), amount: amt, at_ns: now, prev_last_ns: st.last_rebalance_ns };
        st.spent_today += amt;
        st.last_rebalance_ns = now;
        self.owners.insert(owner, st);
        let action = HlAction::UsdSend { destination: to_address, amount, time: hl_time };
        self.mpc_sign(from_path, action.digest(self.hl_chain()), Some(action), None, Some(refund))
    }

    // ---- callbacks and views ----

    /// Returns the signature, or null if the MPC sign failed. It does not panic on failure, so that the
    /// rebalance cap and cooldown given back here are committed. (An owner nonce stays burned.)
    #[private]
    pub fn on_signed(
        &mut self,
        payload: String,
        action: Option<HlAction>,
        nonce: Option<u64>,
        refund: Option<CapRefund>,
        #[callback_result] res: Result<MpcSignature, PromiseError>,
    ) -> Option<SignOut> {
        let Ok(sig) = res else {
            log!("MPC sign failed");
            if let Some(r) = refund {
                if let Some(st) = self.owners.get_mut(&r.owner) {
                    if st.day == r.at_ns / DAY_NS {
                        st.spent_today = st.spent_today.saturating_sub(r.amount);
                    }
                    if st.last_rebalance_ns == r.at_ns {
                        st.last_rebalance_ns = r.prev_last_ns;
                    }
                }
            }
            return None;
        };
        Some(SignOut { payload, big_r: sig.big_r.affine_point, s: sig.s.scalar, recovery_id: sig.recovery_id, action, nonce })
    }

    /// EIP-712 digest (hex) of `action` for this contract's HL chain.
    pub fn hl_digest(&self, action: HlAction) -> String {
        hex::encode(action.digest(self.hl_chain()))
    }

    /// EIP-712 digest (hex) the owner must sign for `intent`.
    pub fn owner_intent_digest(&self, owner: String, nonce: u64, intent: OwnerIntent) -> String {
        hex::encode(auth::intent_digest(self.domain(), &parse_addr(&owner), nonce, &intent))
    }

    pub fn get_owner(&self, owner: String) -> Option<OwnerState> {
        self.owners.get(&owner).cloned()
    }

    pub fn get_leg(&self, owner: String, leg: u32) -> Option<String> {
        self.legs.get(&leg_path(&owner, leg)).cloned()
    }

    pub fn get_config(&self) -> near_sdk::serde_json::Value {
        json!({ "admin": self.admin, "mpc_contract": self.mpc_contract, "hl_mainnet": self.hl_mainnet,
                "chain_tag": self.chain_tag() })
    }
}

impl Leash {
    fn from_parts(admin: AccountId, mpc_contract: AccountId, hl_mainnet: bool) -> Self {
        #[cfg(feature = "spike")]
        assert_testnet(hl_mainnet);
        Self {
            admin,
            mpc_contract,
            hl_mainnet,
            owners: LookupMap::new(Key::Owners),
            legs: LookupMap::new(Key::Legs),
            leg_owner: LookupMap::new(Key::LegOwner),
        }
    }

    fn hl_chain(&self) -> &'static str {
        if self.hl_mainnet { "Mainnet" } else { "Testnet" }
    }

    fn chain_tag(&self) -> &'static str {
        if self.hl_mainnet { "near-mainnet" } else { "near-testnet" }
    }

    fn domain(&self) -> [u8; 32] {
        auth::domain_separator(self.chain_tag(), env::current_account_id().as_str())
    }

    #[cfg(feature = "spike")]
    fn assert_admin(&self) {
        assert_testnet(self.hl_mainnet);
        let caller = env::predecessor_account_id();
        require!(caller == self.admin || caller == env::current_account_id(), "admin only");
    }

    fn agent_state(&self, owner: &str) -> OwnerState {
        let st = self.owners.get(owner).cloned().unwrap_or_else(|| env::panic_str("unknown owner"));
        require!(st.agent.as_ref() == Some(&env::predecessor_account_id()), "not this owner's agent");
        require!(!st.frozen, "frozen");
        st
    }

    /// Freeze: MPC-sign approveAgent(burn address) for every agent name approved on the owner's legs, all in this
    /// transaction (joined), so HL replaces each agent by a keyless one. The relayer posts the results to HL.
    fn revoke_agents(&self, owner: &str) -> Option<Promise> {
        let slots = agent_slots().get(owner).cloned().unwrap_or_default();
        if slots.is_empty() {
            return None;
        }
        let need = Gas::from_gas(REVOKE_SIGN_GAS.as_gas() * slots.len() as u64 + ON_REVOKED_GAS.as_gas() + Gas::from_tgas(5).as_gas());
        require!(
            env::prepaid_gas().as_gas().saturating_sub(env::used_gas().as_gas()) >= need.as_gas(),
            format!("attach more gas: freezing {} agents needs {} TGas", slots.len(), need.as_tgas())
        );
        let now_ms = env::block_timestamp_ms();
        let mut meta = Vec::with_capacity(slots.len());
        let mut joined: Option<Promise> = None;
        for (i, slot) in slots.into_iter().enumerate() {
            let path = leg_path(owner, slot.leg);
            let burn = burn_address(&path);
            let action = HlAction::ApproveAgent { agent_address: burn.clone(), agent_name: slot.name.clone(), nonce: now_ms + i as u64 };
            let payload = action.digest(self.hl_chain());
            let args = json!({ "request": { "path": path, "payload_v2": { "Ecdsa": hex::encode(payload) }, "domain_id": MPC_ECDSA_DOMAIN } });
            let p = Promise::new(self.mpc_contract.clone()).function_call(
                "sign".to_string(),
                args.to_string().into_bytes(),
                MPC_SIGN_DEPOSIT,
                REVOKE_SIGN_GAS,
            );
            joined = Some(match joined {
                None => p,
                Some(j) => j.and(p),
            });
            meta.push((slot, burn, hex::encode(payload), action));
        }
        Some(joined.unwrap().then(Self::ext(env::current_account_id()).with_static_gas(ON_REVOKED_GAS).on_revoked(meta)))
    }

    fn sign_hl(&self, path: String, action: HlAction) -> Promise {
        let digest = action.digest(self.hl_chain());
        self.mpc_sign(path, digest, Some(action), None, None)
    }

    fn sign_cancel(&self, path: String, cancels: Vec<l1::HlCancel>) -> Promise {
        let nonce = env::block_timestamp_ms();
        let digest = l1::cancel_digest(&cancels, nonce, self.hl_mainnet);
        self.mpc_sign(path, digest, Some(HlAction::Cancel { cancels }), Some(nonce), None)
    }

    fn mpc_sign(&self, path: String, payload: [u8; 32], action: Option<HlAction>, nonce: Option<u64>, refund: Option<CapRefund>) -> Promise {
        let payload_hex = hex::encode(payload);
        let args = json!({ "request": {
            "path": path,
            "payload_v2": { "Ecdsa": payload_hex },
            "domain_id": MPC_ECDSA_DOMAIN,
        }});
        Promise::new(self.mpc_contract.clone())
            .function_call("sign".to_string(), args.to_string().into_bytes(), MPC_SIGN_DEPOSIT, MPC_SIGN_GAS)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_SIGNED_GAS)
                    .on_signed(payload_hex, action, nonce, refund),
            )
    }
}

/// SPIKE ONLY (claims C1-C3), compiled only with `--features spike` (testnet). A default build (mainnet)
/// does not contain them: they sign for any path, owners' legs included.
#[cfg(feature = "spike")]
#[near]
impl Leash {
    pub fn sign_raw(&mut self, path: String, payload: String) -> Promise {
        self.assert_admin();
        self.mpc_sign(path, parse_hex::<32>(&payload, "payload"), None, None, None)
    }

    pub fn admin_sign_hl(&mut self, path: String, action: HlAction) -> Promise {
        self.assert_admin();
        self.sign_hl(path, action)
    }

    /// One-off upgrade from the D1 spike layout (testnet); keeps the account id, so derived addresses stay.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: LeashV0 = env::state_read().unwrap_or_else(|| env::panic_str("no state"));
        Self::from_parts(old.admin, old.mpc_contract, old.hl_mainnet)
    }
}

#[cfg(test)]
mod tests;
