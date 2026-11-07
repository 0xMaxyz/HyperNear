# contract-dev notes

## MPC signer (v1.signer-prod.testnet), checked 2026-11-07
- Deployed version: `3.18.0` (view `version`). Source checked at tag 3.18.0 of github.com/near/mpc.
- `sign` args: `{"request":{"path":"…","payload_v2":{"Ecdsa":"<64 hex, no 0x>"},"domain_id":0}}`
  (crates/near-mpc-crypto-types/src/sign.rs `SignRequestArgs`; legacy `payload`/`key_version` still parsed, not used).
- Deposit: `SIGN_DEPOSIT_YOCTONEAR = 1` (crates/near-mpc-contract-interface/src/deposits.rs); excess refunded.
- Gas: config `sign_call_gas_attachment_requirement_tera_gas = 15` (min prepaid on `sign`), resume callback 7 TGas.
- Response (JSON, `#[serde(tag="scheme")]`): `{"scheme":"Secp256k1","big_r":{"affine_point":"02…(33B hex)"},"s":{"scalar":"…"},"recovery_id":0|1}`.
- ECDSA payload must be < secp256k1 n (MPC panics otherwise).
- Derivation: tweak = derive_tweak(predecessor, path), prefix `near-mpc-recovery v0.1.0 epsilon derivation:`; view
  `derived_public_key({path, predecessor, domain_id})`.

## Hyperliquid ApproveAgent (hyperliquid-python-sdk signing.py `sign_agent`)
- Type: `HyperliquidTransaction:ApproveAgent(string hyperliquidChain,address agentAddress,string agentName,uint64 nonce)`
- Domain: `HyperliquidSignTransaction`, "1", chainId 0x66eee, verifyingContract 0x0 (`EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)`).
- Posted action: `{type:"approveAgent", signatureChainId:"0x66eee", hyperliquidChain, agentAddress, agentName, nonce}` + top-level `nonce` = same, `signature {r,s,v}`.

## ci32
- Rust 1.99.1, cargo-near 0.23.0, near-cli-rs 0.31.1 installed user-locally (~/.cargo/bin). gcc present.
- `ci32.sh check` once failed with `env.sh: Permission denied`: race with another agent rewriting env.sh. Retry.
- C: on ci32 had only 24 GB free (2026-11-07). Clean `target/` when done.

## Gotchas
- viem 2.57 `hashTypedData` / `signTypedData` THROW `InvalidStructTypeError` on the struct name
  `HyperliquidTransaction:ApproveAgent` (":" not allowed). Workaround used in scripts/gen-vectors.mjs:
  `keccak256(0x1901 || hashDomain(..) || hashStruct(..))`. ts-dev's HL signer will hit the same thing.
- Node 22.23 on ci32 strips TS types natively: scripts are `.ts`, run with plain `node`, no tsx.
- pnpm 12 on ci32 + `CI=true` => frozen lockfile by default; use `--no-frozen-lockfile` when deps change.

## Testnet deployment (D1 spike)
- Contract + admin: `leash-spike-1107.testnet` (faucet-created; key in ci32 `~/.near-credentials/testnet/`). admin = itself.
- Deploy/redeploy: `bash scripts/deploy-testnet.sh leash-spike-1107.testnet [--redeploy]` on ci32 (redacts keys).
- Throwaway HL agent key (testnet only): ci32 `~/.near-credentials/leash-agent-test-leg0.key` (mode 600).

## Measured 2026-11-07 (scripts/c1-sign.ts, 11 sign_raw calls, path "test/c1")
- C1 PASS 11/11: recovered signer == MPC `derived_public_key` address `0xe8e7c69788249d5bc17ddbd441cdf41f6f8a0274`; all low-s.
  e.g. tx 5ofs76x8CdXMorzZTinnSovpvRsJZmoHZhPDNtfjUogh.
- C14: one tx, 7 receipts (sign -> MPC yield/resume -> on_signed), gas burnt 11.98 TGas total (300 TGas attached,
  static 50 sign + 10 callback), tokens burnt ~0.001131 NEAR/signature; MPC deposit charged 1 yocto, no refund receipt.
- C6 (NEAR side, submit -> EXECUTED_OPTIMISTIC, sequential): p50 12.1 s, p95 12.8 s, min 11.3 s.
- Derived EVM: test/leg0 = 0xff689f4bf14686c751df87304178eacb3c2194e3, test/leg1 = 0x6c116aef0a090893af5d80b39602666a9a450328.
- C2 payload: out/c2-approve-agent.json (regenerated, sign tx ExaffTNTrJr7gaPjuEyc589xCJ7r8kB9scvb4Z2Tpg4V; also copied to D:/code/near_hck/contract/out, gitignored there). Contract digest == viem digest, recovered == leg0.

## C3 (2026-11-07)
- `admin_sign_hl(path, action)` (spike, admin-only) signs any HlAction: approveAgent | usdSend | withdraw3 | usdClassTransfer,
  action JSON = HL's own /exchange shape minus hyperliquidChain/signatureChainId. Replaced `sign_approve_agent`.
- Type strings (signing.py): UsdSend/Withdraw `(string hyperliquidChain,string destination,string amount,uint64 time)`,
  UsdClassTransfer `(string hyperliquidChain,string amount,bool toPerp,uint64 nonce)`. destination is a STRING in the hash,
  so the contract only accepts lowercase 0x addresses (posted string == signed string; policy compares addresses).
- Amounts: plain decimal, <= 6 decimals, <= 12 integer digits, > 0; parsed to micro-USD u64.
- `scripts/sign-action.mjs <type> <path> '<json>' [out.json]` -> {derivedAddress, action, nonce, signature{r,s,v}, ...}.
  Signed payloads: out/c3-*.json (txs 6oPSods…, BnvunraX…, 5WWaXHvQ…). Vectors: tests/vectors/hl_actions.json (9 cases).

## Policy contract (auth.rs + lib.rs), deployed by `migrate` on 2026-11-07
- Decision: owner domain = `EIP712Domain(string name,string version,bytes32 salt)`, name "Leash", version "1",
  salt = keccak256("{chain_tag}:{contract_id}"), chain_tag "near-testnet"/"near-mainnet" (from hl_mainnet).
  No chainId: NEAR has none and MetaMask refuses a chainId that is not the active chain. C13 should confirm wallets accept it.
- Intents (all start `address owner,uint64 nonce`): ApproveAgent(+uint32 leg,address agent,string agentName,uint64 hlNonce),
  Withdraw(+uint32 leg,string amount,uint64 hlTime) [destination = owner, no field], UsdClassTransfer(+uint32 leg,string amount,
  bool toPerp,uint64 hlNonce), SetPolicy(+string agent,string dailyCap,uint64 cooldownSec) [agent "" revokes], Freeze(+bool frozen).
  TS helper: scripts/owner-intents.mjs `ownerIntentTypedData(chainTag, contractId, owner, nonce, intent)` (viem hashTypedData is
  fine here: no ":" in these type names). Vectors with real viem signatures: tests/vectors/owner_intents.json.
- `owner_execute(owner, nonce, intent, signature)`: any caller; sequential per-owner nonce burned before the MPC promise.
- `register_leg(owner, leg)`: any caller; the address comes from MPC `derived_public_key` via a cross-contract call (not trusted
  from the caller). ~10 TGas.
- Agent = a NEAR account set by SetPolicy: `agent_usd_class_transfer`, `rebalance(owner, from_leg, to_address, amount, hl_time)`
  (to_address must be a registered leg of the same owner, != source, daily cap per UTC day, cooldown). Cap/cooldown are spent
  before the promise, so a failed sign still counts.
- Freeze: refuses everything except owner Withdraw and Freeze (unfreeze).
- near-sdk `env::ecrecover` needs the `unstable` feature. Malleability flag on (high-s rejected).
- Live smoke (scripts/owner-smoke.ts, owner = public test key): legs registered == MPC derived, setPolicy, replay rejected,
  owner usdClassTransfer + agent rebalance signed by leg0, cap and foreign-destination rejected. owner_execute w/o MPC ~2.5 TGas.

## Latency (design note for the margin guard)
- On-chain, one sign tx is ~7-8 blocks: tx block -> sign receipt +1 -> MPC resume +5 -> on_signed +1; ~4.2 s p50 (3.9-4.8 s).
- Wall time submit -> EXECUTED_OPTIMISTIC: 12.1 s p50 via rpc.testnet.near.org, 5.7 s p50 / 6.8 s p95 via test.rpc.fastnear.com.
  The gap is the RPC, not finality: we already wait only for EXECUTED_OPTIMISTIC (lowest status that carries the result).
  rpc.testnet.near.org is deprecated and now returns -429; scripts default to FastNEAR. Guard budget: ~7 s NEAR + HL.
- Not tried: submitting with waitUntil NONE and polling tx status (could shave part of the ~1.5 s RPC overhead).

## Merge-prep fixes (2026-11-07, deployed from 2bb9a30)
- Agent `agent_usd_class_transfer` requires `to_perp == true` (spot -> perp adds margin); perp -> spot is owner-only.
- Storage is paid by the caller: `owner_execute` and `register_leg` are #[payable]. owner_execute measures storage growth
  (after `flush()` of the store::LookupMap, which otherwise writes only at the end of the call) and refunds the excess;
  same-size updates need no deposit. register_leg requires REGISTER_LEG_DEPOSIT = 0.005 NEAR up front (2 records cost
  0.00271 NEAR, measured in the unit test), the callback refunds the rest, or all of it if the MPC view failed.
  Scripts attach 0.01 NEAR (owner_execute) / 0.005 NEAR (register_leg). Agent methods never grow storage: FC key works.
- `sign_raw` / `admin_sign_hl` only exist with `--features spike` (in a separate `#[near] impl` block). Default build
  checked: its ABI has 0 of them. scripts/deploy-testnet.sh builds with `--features spike`; a mainnet build must not.
- Tests: 33 (default) / 35 (`--features spike`).
- near CLI on ci32: config.toml `testnet` already points at FastNEAR (`archival-rpc.testnet.fastnear.com`); no change needed.

## C7 (2026-11-07): PASS
- Agent account `agent.leash-spike-1107.testnet`, created by the leash account; its ONLY key is
  `ed25519:DQNvADgASgcrUDR7L6i5nb44zjKp4NkLNWWEwZWELXmc` with permission
  FunctionCall{receiver_id: leash-spike-1107.testnet, method_names: [rebalance, agent_usd_class_transfer], allowance 0.2 NEAR}.
  Secret on ci32 in ~/.near-credentials/testnet/agent.leash-spike-1107.testnet.json (mode 600).
- rebalance tx BaoLesRAhannL1tQJjXyP3MCUTQEb2NSY4axXXRXu1eY signed by that key, deposit 0; receipt
  leash -> v1.signer-prod.testnet `sign` deposit=1 yocto (contract balance, delta -1 yocto); recovered signer = leg0.
- The earlier smoke rebalance 7FwZr3fb… was NOT C7: it used the leash account's full-access key (agent = contract itself).
- Gotcha: an FC key's allowance must cover prepaid gas at the pessimistic price (300 TGas ~ 0.30 NEAR): agent calls use 100 TGas.
- Script: scripts/c7-agent-fc-key.ts (run after owner-smoke.ts).

## Open / next
- sign_raw and admin_sign_hl must be removed before mainnet (they sign for any path, owners' included).
- Min outer gas not measured; scripts attach 300 TGas (needs >= ~65 TGas given the static allocations).
- Windows python writes CRLF unless open(..., newline="
"); git normalises, but literal "
" inside python-edited JS broke once.
- Re-sign on demand (fresh nonce): on ci32 `node contract/scripts/sign-approve.mjs <path> <agentAddr> <nonceMs> [agentName]`
  (env LEASH_CONTRACT, default leash-spike-1107.testnet). Empty agentName => omitted from action, signed as "" (python SDK behaviour).
- All ci32 network traffic (rustup, crates, pnpm, faucet, NEAR RPC) goes via the Surfshark proxy env.sh sets.
