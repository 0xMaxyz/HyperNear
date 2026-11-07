# Mainnet runbook (D6)

Every step marked **MAINNET** is run by the user, by hand, after reading what it does. Nothing here runs unattended.
Scripts print their plan first (`--plan`, dry quotes) and ask for typed confirmation before a mainnet transaction.

Costs below are measured on testnet (same gas schedule; mainnet gas price 0.0001 NEAR/TGas) and 1Click mainnet dry
quotes from 2026-11-07. HL fees are Hyperliquid mainnet base rates.

## Budget

| | Amount | Comes back? |
|---|---|---|
| Contract account `hypernear.<you>.near` | **3.0 NEAR** (2.51 NEAR code storage for the 250.7 kB wasm, state, MPC deposits of 1 yocto each) | storage stays locked with the contract |
| Relayer account (full-access key, pays gas + storage deposits) | **0.5 NEAR** (uses < 0.03) | yes, unused |
| NEAR agent account `agent.leash.<you>.near` (function-call key only) | **0.2 NEAR** | yes, unused |
| **NEAR total** | **3.7 NEAR** (spent: < 0.05 NEAR gas; 2.52 NEAR locked as storage) | |
| USDC to fund 2 legs via 1Click | **2 x 15 = 30 USDC** (NEAR USDC or Arbitrum USDC) | ~26 back to the owner |
| USDC cost of the run | ~**3.7 USDC**: 1Click 2 x ~0.32 (0.3153 withdraw fee + 1 bp), HL activation 2 x 1, trading ~0.03, HL withdraw 1 | |

## Sequence

0. **Prerequisites (no chain action).** Owner EVM wallet (Privy or MetaMask). NEAR accounts: contract + relayer, funded as
   above, keys in `~/.near-credentials/mainnet/`. `cargo near`, `near` CLI. HL mainnet reachable.
   *Abort point: nothing exists yet.*

1. **Plan the deploy.** `contract/scripts/deploy-mainnet.sh hypernear.<you>.near --plan`: prints the 6 steps and the exact
   commands, runs none.

2. **MAINNET: deploy + init.** `contract/scripts/deploy-mainnet.sh hypernear.<you>.near`
   - default build (no `spike`); stops if the ABI has `sign_raw`, `admin_sign_hl` or `migrate`; prints the wasm sha256
     (2026-11-07 build: `d1eef202…bcd53`, 250 735 bytes);
   - asks for the account id typed back, then `deploy` + `new(admin, mpc_contract = v1.signer, hl_mainnet = true)`;
   - verifies `get_config` = `{hl_mainnet: true, chain_tag: "near-mainnet", mpc_contract: "v1.signer"}`.
   - Cost: ~0.03 NEAR gas; 2.51 NEAR storage. *Abort point: the full-access key still exists; redeploy or delete the account freely.*

3. **MAINNET: NEAR agent account, BEFORE the lock** (creating a sub-account needs the contract's full-access key).
   `agent.leash.<you>.near` with 0.2 NEAR and ONE key: function-call, receiver = the contract, methods
   `rebalance, agent_usd_class_transfer`, allowance unlimited (testnet: `contract/scripts/c7-agent-fc-key.ts` does exactly this).
   Cost: 0.2 NEAR moved + ~0.001 gas.

4. **MAINNET: register legs 0 and 1** (relayer; anyone may, the address comes from the MPC key):
   `POST /relay {owner, intent: {type: "registerLeg", leg}}` or `HyperNearClient.registerLeg`. Cost per leg: ~0.001 NEAR gas +
   0.005 deposit (0.0027 kept as storage, rest refunded).

5. **Fund both legs through 1Click** (the user sends the USDC; the script never does):
   `node agent/scripts/fund-leg-1click.ts --to <leg> --amount 15 --from near|arb` (dry quote), then
   `... --execute --refund-to <your origin address>`: prints the deposit address and polls `/v0/status` to SUCCESS.
   Dry quotes for 10 USDC (2026-11-07): from NEAR USDC -> 9.6836 USDC out (min 9.5837), from Arbitrum USDC -> 9.6847
   (min 9.5848); fee 0.3153 + 1 bp, ETA 30-35 s. USDC lands on the leg's HyperCore **spot** balance; HL takes a
   1 USDC activation fee from the first credit of a new address (C10).
   *Abort point: a failed 1Click swap refunds to `--refund-to`.*

6. **MAINNET: owner intents** (owner signs in the wallet, relayer sends `owner_execute`; ~0.0014 NEAR each, MPC 1 yocto):
   - `usdClassTransfer` spot -> perp on each leg (~$14);
   - `setPolicy {agent: "agent.leash.<you>.near", dailyCap: "20", cooldownSec: 60}`;
   - `approveAgent` for each leg (the agent service generates one HL API wallet per leg: `Legs.approveAgents`).

7. **MAINNET: hedge open/close ($10+).** Start the agent with the relayer + NEAR agent keys in env.
   - leg0 opens BTC long ~$24 at 3x (its agent key, HL only);
   - `POST /hedge/open` with an owner-signed Command, ratio 0.5 -> leg1 short ~$12 at 3x (HL minimum $10 per order);
   - `POST /hedge/close` -> reduce-only on both legs; both positions 0. Fees ~$0.03.
   *Abort point: close positions any time with `/hedge/close`, or the owner freezes (`freeze` intent: contract-signed actions
   except withdraw stop; HL API wallets already approved can still trade until closed or replaced).*

8. **MAINNET: withdraw to the owner.** Owner `withdraw` intent per leg (`withdraw3`, destination = owner, enforced by the
   contract): HL fee 1 USDC each, arrives on Arbitrum. Optional for the video: a withdraw to another address is refused by
   `NearMasterSigner` before any NEAR call, and the contract has no way to express it (no destination field).

9. **Record** every tx hash and HL order id for the README (NearBlocks / HL explorer links).

10. **MAINNET, irreversible: lock.** `contract/scripts/lock-contract.sh hypernear.<you>.near --plan`, then without `--plan`:
    lists the keys, checks `get_config`, asks for `DELETE ALL FULL ACCESS KEYS OF <account>` typed, deletes them.
    After this nobody (us included) can upgrade or drain the contract account; the derived HL addresses stay controlled
    only by the contract's rules. Do it only after steps 2-9 worked. *No rollback after this point:* a bug found later
    means a new contract account = new leg addresses (move funds out first with owner withdraws, which keep working).

## If something goes wrong

| Where | What to do |
|---|---|
| deploy refused / wrong ABI | fix, rebuild; nothing was sent |
| init wrong | key still there: redeploy (state: delete and recreate the account) |
| 1Click stuck | `/v0/status` shows REFUNDED -> funds back at `--refund-to` |
| HL rejects an action | contract signature is still valid for that nonce only; retry with a fresh nonce (owner re-signs) |
| guard or agent misbehaves | owner `freeze` (one intent): rebalances and other contract-signed actions stop, withdraw still works; stop the agent process to stop its HL orders |
| after lock | only owner withdraws and the agent's capped moves remain; plan a new deployment if needed |
