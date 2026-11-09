# HyperNear

Demo video and X post: `<X_POST_URL>` (TODO: replace before submitting; built at NEAR HACKATHON, @NEARProtocol #NEARHackathon)

Smart accounts for Hyperliquid: the keys are held by NEAR Chain Signatures, and a public NEAR contract decides what may be signed.
An owner (any ordinary EVM wallet) gets several Hyperliquid accounts ("legs"); the contract lets funds move only between those legs or back to the owner, gives agents a capped allowance, and lets the owner freeze everything.

**For:** anyone who lets a bot, a desk or an AI agent trade a Hyperliquid account and wants a withdraw lock, spending caps and a kill switch the operator cannot bypass. Trading stays at native Hyperliquid speed with per-leg API wallets; only owner-level moves (transfers, approvals, withdrawals, freeze) go through the NEAR contract, ~8 s each (C6).

Track: **security** first, **defi** second. License: MIT.

## The problem

A Hyperliquid master key is a bare EOA. Whoever holds it can approve any agent, send funds anywhere and withdraw everything. There is no withdrawal lock, no spending cap, no freeze, and no way to give an agent less than full trading rights over the account's money.

**Why not the existing options?**

- **Subaccounts.** They already let an API wallet move funds between accounts: we tested `subAccountTransfer` signed by an API wallet on testnet and it worked (claim C11, [`validation/results/C11.json`](validation/results/C11.json)). So subaccounts give access control, not policy: no destination lock, no caps, no freeze. Creating one also needs $100k of volume; we traded about $108k on testnet to get one.
- **Hyperliquid multi-sig.** A threshold of signers, but no rules about *what* may be signed.
- **Privy or Turnkey policy engines.** They can express EIP-712 rules for Hyperliquid, but the rules run inside the vendor's enclave, which you have to trust. Here the policy is a public NEAR contract anyone can read, and the key is held by NEAR's MPC network, so no single vendor holds it.
- **perps.near.com.** We found no public sign of user policy controls (claim C16: no public evidence, secondary sources only; we may be wrong, corrections welcome).
- **A HyperEVM contract through CoreWriter.** The closest alternative: a HyperEVM contract can own a HyperCore account, place orders, add API wallets and move funds through CoreWriter, with its policy in Solidity (Trading Strategy's guard contract does this for its vaults). The differences: the owner and contract need a HyperEVM wallet and HYPE gas, there is no direct `withdraw3` (funds leave through HyperEVM and a bridge), and orders sent this way execute a few seconds late. HyperNear keeps the policy on NEAR, the owner needs no gas or NEAR wallet, and one contract serves many owners and legs.

**Why NEAR.** Hyperliquid's L1 has no account abstraction; Chain Signatures lets a public contract hold an EOA key with no custodian and no HyperEVM gas, and the owner needs no NEAR wallet (any relayer may submit; the signature is the auth).

## What it does

- **Owner.** Any EOA. Owner intents are EIP-712 typed data verified on-chain with `env::ecrecover` (tested with viem signatures and an injected-wallet login through the real Privy modal; the Privy embedded/passkey wallet's signature path is not yet verified, C13). Anyone may relay an intent, so the relayer cannot censor an owner.
- **Legs.** Leg *i* of an owner is the EVM address derived by NEAR Chain Signatures from (contract id, owner, leg). The contract signs Hyperliquid actions for it: `approveAgent`, `usdSend`, `usdClassTransfer`, `withdraw3`.
- **Withdrawals only to the owner.** The owner's `withdraw` intent has no destination field, so the destination is always the owner's address.
- **Agent permissions.** The owner names one NEAR agent account, with a daily cap and a cooldown. That account's access key is a NEAR function-call key limited to `rebalance` and `agent_usd_class_transfer`. `rebalance` can only move USDC to another registered leg of the same owner. Each leg also gets its own Hyperliquid API wallet for trading.
- **Margin guard.** The agent watches the legs and, when one nears liquidation, moves USDC from a healthier leg through the contract. Trigger: margin at or below 2x maintenance, or liquidation closer than a plausible price move over the rebalance latency (`agent/src/guard.ts`).
- **Hedge.** `open hedge` shorts a ratio of leg 0's position on leg 1; `close hedge` closes both. The agent checks leverage, notional and coin before trading.
- **Freeze.** One owner-signed intent stops every contract-signed action except the owner's withdraw, and in the same NEAR transaction the contract signs `approveAgent` calls that replace each trading agent with a keyless burn address, so the old API wallets are refused by Hyperliquid (details in [docs/readme-notes.md](docs/readme-notes.md)).
- **Decisions (propose mode).** For each hedge the agent asks Jev (TypeSafe AI) five yes/no questions, escalates to Claude when a factor is not decisive (below 0.90 or above 0.10), and shows the result as a proposal. The first call goes to Sonnet 5.5, or to Opus 5.5 when the hedge's combined notional is above $1,000; if Sonnet's answer differs from the factor table's, Opus is asked as well and wins (`agent/src/decide.ts`). The owner accepts or rejects it; nothing runs until accepted.
- **Strategies (Phase 2).** Grid and TWAP/DCA bots, each on its own leg with its own top-up budget, drafted from plain language and started only by an owner signature; see [Phase 2](#phase-2-strategies-each-on-its-own-leg).
- **Chat.** A tool-calling chat over the owner's state (`agent/src/chat.ts`) with deliberately unfiltered tools, used for the prompt-injection demo below.

## What we guarantee, and what we don't

Guaranteed by the contract:

- Contract-signed USDC moves only between the owner's registered legs, or to the owner, or, on the owner's own `payTee` signature naming the amount and address, the published TEE fee to the published fee address (fixed when the contract is created). An agent or relayer cannot send funds anywhere else.
- The agent's moves are bounded by the owner's daily cap and cooldown.
- After `freeze`, the contract signs nothing except the owner's withdraw and unfreeze, and Hyperliquid cancels of the frozen legs' resting orders (`cancel_orders`, which anyone may call while the owner is frozen: a cancel cannot move funds).

Not guaranteed:

- **Trades can still lose money.** The contract limits where funds can go, not whether they are lost. An agent key can trade a leg badly, and a leg can be liquidated.
- **Order policy is checked off-chain**, in the agent (leverage, notional, coins). The contract cannot read Hyperliquid state. The optional [TEE mode](#optional-tee-mode-not-yet-run-on-real-hardware) moves this check into code the owner picks by its measurement, but it has not yet run on real TEE hardware.
- **Resting orders need a second step after a freeze.** Freeze revokes the old API wallets, but orders already on the book stay until someone calls `cancel_orders`. Our agent does it right after a freeze it relays (claim C20); if our server is gone, anyone with a NEAR account can run `node agent/scripts/clear-frozen.ts 0x<owner>`. Between the freeze and that sweep (18.5 s on testnet), a resting order can still fill.
- **The owner must be an EOA** (for example MetaMask; a Privy embedded wallet is untested, C13). Smart-contract wallets (Safe, ERC-1271) are not supported.
- Funding a fresh leg costs 1 USDC of Hyperliquid activation fee; withdrawals cost 1 USDC.
- After a mainnet deploy the runbook deletes the contract's full-access keys (step 10; the mainnet run has not happened yet). That makes the contract account the custody root: nobody, including us, can upgrade it afterwards.

## Optional TEE mode (not yet run on real hardware)

By default our server runs the agent, so the owner trusts us with the order policy, the trading keys and the kill switch. An owner can instead choose **TEE mode** (paid, USDC per month) in the web UI:

- `setTee {measurementHash, agentAccount}` (owner-signed) names one agent instance and the code measurement the owner accepts. While it is set, only that NEAR account, registered with a matching unexpired attestation, may `rebalance` or `agent_usd_class_transfer` for the owner, and the owner's own `approveAgent` is refused.
- `register_tee_agent` verifies an Intel TDX quote **inside the contract** (the `shade-attestation` / `dcap-qvl` verifier, vendored) and binds it to the caller's implicit-account key; a reused quote is refused and registrations expire after 7 days. Verifying one real recorded quote on testnet burned 187 TGas (T0, tx [4QTqwXfG…](https://testnet.nearblocks.io/txns/4QTqwXfGn9hfVohdyJZHPcaaoaSNju5FBwDA4HW4sC6f), [`validation/results/T0.json`](validation/results/T0.json)).
- The TEE agent makes fresh Hyperliquid trading keys per boot, in memory only, and gets them approved through `tee_approve_agent`. Leaving or switching (`setTee` to another hash or to zero) revokes those keys in the same transaction.
- `payTee {leg, months, priceMicro, feeAddress}` signs a `usdSend` of exactly what the owner saw; the agent serves only owners whose payments actually landed in the Hyperliquid ledger.
- Run it: the agent with `HYPERNEAR_RUN_MODE=tee` (`Dockerfile`, `docker-compose.tee.yml`); the server agent (`HYPERNEAR_RUN_MODE=server`, the default) skips owners in TEE mode.

**Status, plainly:** the owner-binding, payment and revocation logic passed 14 of 14 live checks on NEAR and Hyperliquid testnet (claim C21), but with a **dev registration** (`register_tee_agent_dev`, testnet builds only) instead of a TDX quote. On-chain quote verification is shown only by T0's recorded quote. The agent has **not yet run on a real Phala TDX machine**, so the full chain (real quote → registration → trading) is unproven. Even when it runs: the TEE gives no liveness (freeze and the `cancel_orders` sweep stay the fallback), the agent's AI API keys are passed as unmeasured environment variables, and TDX itself has known side-channel limits.

## NEAR features used

- **Chain Signatures** (`v1.signer`; `v1.signer-prod.testnet` on testnet): the contract calls `sign` for every Hyperliquid action. The MPC network holds the keys; the contract pays the 1 yoctoNEAR deposit from its own balance (claims C1, C7, C14).
- **A NEAR smart contract** (Rust, near-sdk 5, [`contract/`](contract)): legs, owner intents, agent policy, freeze, and Hyperliquid order cancels signed with a leg's master key (the L1 "phantom agent" scheme, msgpack encoded in the contract; claim C20).
- **Function-call access keys:** the agent's NEAR account can only call `rebalance` and `agent_usd_class_transfer` on the contract. On testnet the agent key tries `owner_execute` and NEAR refuses it.
- **NEAR Intents 1Click (dry quotes only; mainnet funding run pending):** funding script `agent/scripts/fund-leg-1click.ts`. So far we have only run dry quotes (documented in [docs/mainnet-runbook.md](docs/mainnet-runbook.md)); the mainnet funding run is part of the runbook.
- **FastNEAR RPC** (`test.rpc.fastnear.com`): a full master action (NEAR sign, Hyperliquid post, balance change) takes 7.75 s p50 / 8.78 s p95 end to end; the NEAR side alone is about 5.7 s p50 through FastNEAR, against about 12 s through `rpc.testnet.near.org` (claim C6).

Also used: **Jev** by TypeSafe AI (decision layer), **Claude** (escalation and chat), **Privy** (owner login).

## Run it (no keys needed)

Needs Node 22.18 or newer (the agent runs TypeScript directly), pnpm 11.15.1 (the version the fresh clone used), and Rust with `cargo` for the contract tests. Expected results were recorded on a fresh clone on Ubuntu 24.04 (Node 22.23, pnpm 11.15.1, Rust 1.99) at the commit this README was written for; counts change as tests are added.

**1. Install.**

```bash
pnpm install --frozen-lockfile
```

Expected: ends with `Done in <n>s`, no errors.

**2. TypeScript tests (offline).**

```bash
pnpm test
```

Expected: exit code 0 and these summary lines (live tests are skipped without credentials):

```
packages/core test:       Tests  289 passed (289)
packages/hypernear-client test:       Tests  44 passed | 1 skipped (45)
validation test:       Tests  4 passed | 21 skipped (25)
agent test:       Tests  347 passed | 9 skipped (356)
```

**3. Contract tests.**

```bash
cd contract && cargo test && cd ..
```

Expected: `test result: ok. 71 passed; 0 failed` (75 with `--features spike`). They cover the owner-intent digests against viem signatures, replay and burned nonces, the cap and cooldown, rebalance to a foreign address, freeze, the Hyperliquid digests, the L1 cancel digests against the SDK vectors, and TEE mode (a recorded real TDX quote verifies, a tampered or reused one is refused, a stranger instance and the server agent are refused, keys are burned on a switch, the fee terms the owner signed).

**4. Agent dry run (recorded testnet data, no keys, no network).**

```bash
pnpm build
pnpm --filter @hypernear/agent dry-run
```

Expected: `pnpm build` ends with `DTS Build success`; the dry run prints three recorded scenarios and exits with code 0. The key lines:

```
== flat ...: two funded legs, no position
  openHedge(BTC, 0.5): refused: leg0 has no BTC position to hedge
== hedged ...: leg0 long BTC at 3x, leg1 short 0.5x of it at 3x (after openHedge)
  closeHedge(BTC):     leg0 SELL 0.00040 BTC IOC @ 73428 reduce-only (~$30.28); leg1 BUY 0.00020 BTC IOC @ 77969 reduce-only (~$15.14)
  guard leg0:BTC: ok; liq distance 48.09%, plausible move 0.136%
== near-liquidation ...: leg2: ~$3.96 account long BTC at 40x cross (initial margin ~= account value)
  guard leg2:BTC: TRIGGER (margin_floor) -> rebalance from the other leg; liq distance 1.23%, plausible move 0.136%
```

**5. Web UI on the recorded data.** In one terminal:

```bash
node agent/src/server.ts --dry-run --serve
```

Expected: `hypernear agent DRY RUN on :8787: fixtures, no keys, no network`.

In a second terminal:

```bash
pnpm --filter @hypernear/web dev
```

Expected: Vite prints `Local: http://localhost:5173/`. Open that URL and click **Explore recorded data**. Expected: a `dry-run data` badge and a Legs table with leg 0 `BTC long 0.0004` (3x cross), leg 1 `BTC short 0.0002`, leg 2 flat, a Break-even card, a Decision panel and the guard and decision log. Login is disabled without `VITE_PRIVY_APP_ID`; the recorded data still works.

Optional automated check of that click-through (needs a Chromium download, with the agent and Vite still running):

```bash
pnpm --filter @hypernear/web exec playwright install chromium
cd web && node e2e/explore-check.mjs
```

Expected: five `PASS page shows "..."` lines and exit code 0.

## Demo video

The video is a scripted screen recording (`web/e2e/demo-video.mjs`) of the real web page against the agent in `--dry-run --serve`. Every click and every signature in it is real and verified by the agent; the on-chain events it shows are replayed from the live testnet runs in `agent/results/` (NEAR and Hyperliquid tx links in [docs/claims.md](docs/claims.md)). No model and no network is called while recording. It is a replay, not a live session.

## Live evidence (NEAR testnet and Hyperliquid testnet, 2026-11-07)

Every claim has a committed test or script and a result file; the full ledger with all numbers is [docs/claims.md](docs/claims.md). Contract: `leash-spike-1107.testnet`.

| Claim | Result | Evidence |
|---|---|---|
| C1 MPC signature recovers to the derived address | 11/11 | NEAR tx [5ofs76x8…](https://testnet.nearblocks.io/txns/5ofs76x8CdXMorzZTinnSovpvRsJZmoHZhPDNtfjUogh); address [0xe8e7c697…](https://app.hyperliquid-testnet.xyz/explorer/address/0xe8e7c69788249d5bc17ddbd441cdf41f6f8a0274) |
| C2 Hyperliquid accepts `approveAgent` signed by MPC | ok | NEAR tx [6hEDswnz…](https://testnet.nearblocks.io/txns/6hEDswnziqMfxYxR85TN9vuXb66xY3KkMMSoXEsJQErT); leg [0xff689f4b…](https://app.hyperliquid-testnet.xyz/explorer/address/0xff689f4bf14686c751df87304178eacb3c2194e3) |
| C3 `usdSend`, `usdClassTransfer`, `withdraw3` signed by MPC | all ok | NEAR txs [usdSend](https://testnet.nearblocks.io/txns/5YETHthJtWddKgsAkjKbD9rV9d2UxmiF2NUVJRvdoNHr), [usdClassTransfer](https://testnet.nearblocks.io/txns/AxYVw9UM5475w7gf1d9bSNfTz5aTHkeJVjTv5kPqvpQE), [withdraw3](https://testnet.nearblocks.io/txns/79D12deyDXkabqRzBTisYL89bvE9myAH2LovE8wcHoU5) |
| C7 Agent function-call key calls `rebalance`; contract pays the MPC deposit | ok | NEAR tx [BaoLesRA…](https://testnet.nearblocks.io/txns/BaoLesRAhannL1tQJjXyP3MCUTQEb2NSY4axXXRXu1eY) |
| C11 An API wallet can do `subAccountTransfer` | ok | subaccount [0x4c163613…](https://app.hyperliquid-testnet.xyz/explorer/address/0x4c163613b406241f43a5492a917f4c0759670ac5) |
| C20 The leg's master key (MPC) signs a Hyperliquid order cancel; Hyperliquid accepts it after the agent is revoked | ok | NEAR tx [8ro3gSB7…](https://testnet.nearblocks.io/txns/8ro3gSB7YdH4LMMyPpPW2M2SEEGoMBgemeyAUQFVLoHs) (`cancel_orders` while frozen, non-owner caller); [C20.json](validation/results/C20.json), [C20-method.json](validation/results/C20-method.json) |
| C13 Privy `signTypedData` with a custom domain | not run | pending |
| C9/C15 1Click funding of a fresh address | not run | mainnet, in the runbook |
| Decision layer: Jev p50 0.69 s; top answer flips under shuffling on 16% of states; 5% of calls reach 0.90 | measured | [C17](validation/results/C17.json), [C17b](validation/results/C17b.json), [C18](validation/results/C18.json), [C18b](validation/results/C18b.json) |

**Margin guard demo** (`agent/scripts/guard-demo.ts`, results in [`agent/results/`](agent/results)). The stress leg was pushed to 40x; the guard detected `margin_floor` and moved 1.54 USDC from leg 2 to leg 1 through the contract. Run 2 timeline: detected +0.7 s, NEAR signed +7.0 s, Hyperliquid posted +8.4 s, recovered +11.1 s. NEAR tx [8WRUpM9E…](https://testnet.nearblocks.io/txns/8WRUpM9EfmouBejeYDoH3w3ELjwaRTPpx2ugcGURSYoo) (run 1: [4ej8UZ8C…](https://testnet.nearblocks.io/txns/4ej8UZ8CDcHUZHGZhS4m1GTuMgZdaPaRL1fBvvKWtDes), recovered +13.6 s).

**Hedge** ([`agent/results/D3-live.json`](agent/results/D3-live.json)): leg 1 shorted 0.0002 BTC at 3x (oid 64758082577); closing filled both legs reduce-only; both positions ended at size 0.

**Freeze** ([`agent/results/freeze-live.json`](agent/results/freeze-live.json)). One NEAR transaction [24aTEXc2…](https://testnet.nearblocks.io/txns/24aTEXc2H2KpADmML9HtXBeckd2NysVcwPBjt1vFv9HK) revoked the agents on all 3 legs on Hyperliquid (`ok`). Eight seconds later an order from an old agent was refused by Hyperliquid. An order resting before the freeze stayed on the book, which is why the sweep exists.

**Freeze sweep** ([`validation/results/C20-sweep.json`](validation/results/C20-sweep.json), claim C20). Two resting BTC orders, one on each of legs 0 and 1, survived a freeze ([Fy4WwBfQ…](https://testnet.nearblocks.io/txns/Fy4WwBfQRjgiCmWbxfUigmJfuDmZgeYoRLkkuJXyWQDb)). `cancel_orders`, called by an account that is not the owner, had the contract sign a Hyperliquid cancel with each leg's own MPC key; Hyperliquid answered `ok` and both books were empty 18.5 s after the sweep started (leg 0 tx [GS8LrZbw…](https://testnet.nearblocks.io/txns/GS8LrZbwwQ7X2d3htFLnm9cnmDDhzA9g2UNuaKH6DX6Y)). No agent key and no exchange-side dead-man were involved.

**Prompt-injection demo** ([`validation/results/injection-demo.json`](validation/results/injection-demo.json), `agent/scripts/injection-demo.ts`). A chat with unfiltered tools read a "market news" paste containing a hidden instruction to move all funds to an attacker address. Honest outcome: **no model followed it** (Sonnet 5.5 in three prompt variants, Haiku 5.5 in one); Sonnet named the injected line and ignored it. So we then called the tools directly with the injected arguments, as a model that did follow it would:

- `rebalance` to the attacker address reverted on chain: "destination is not a registered leg of this owner", NEAR tx [J6P8cPND…](https://testnet.nearblocks.io/txns/J6P8cPNDBpZWpEDR9AbTTEE3c1Q98jQPM1Lj8Lmxxo3B).
- `withdraw` without an owner signature was refused: `HTTP 400: sig must be 65 bytes hex`.
- `withdraw` with a forged signature was refused by the contract: `owner_execute failed: Smart contract panicked: signature: bad v`.
- The agent's NEAR key cannot call `owner_execute`: `Access key does not allow method owner_execute`.

Mainnet: not run yet. The plan, costs and abort points are in [docs/mainnet-runbook.md](docs/mainnet-runbook.md); explorer links will be added here after the run.

## Phase 2: strategies, each on its own leg

Phase 1 protects an account; Phase 2 shows the same primitive running bots. A strategy (a grid or a TWAP/DCA) runs on its own leg, so its losses stay on that leg, the margin guard can top it up only from the reserve leg and only within the strategy's own daily budget (and the contract's cap and cooldown on top), and `freeze` stops all of it. Design, what was cut (funding carry) and the details: [docs/phase2-strategies.md](docs/phase2-strategies.md).

- **Spec.** One JSON object per strategy (`agent/src/strategy/spec.ts`). The owner signs a `startStrategy` Command whose `specHash` is the hash of the spec; a spec changed after signing is refused.
- **Builder.** `POST /strategy/draft {owner, text}`: Claude (Sonnet 5.5, structured output) drafts a spec from plain language, `validateSpec` checks it against the order policy and the contract policy, and the response is `{spec, specHash, diff, warnings}` or a refusal with the reasons. It starts nothing.
- **Kill switch and restart.** Owner-signed pause and stop; a pause that cannot clear the book keeps retrying. After a service restart every saved strategy comes back paused, its orphaned orders are cancelled, and the owner resumes it with a signed start over the stored spec.
- **Strategy decisions (propose mode).** Same Jev-then-Claude pipeline as the hedge, with the strategy's own facts (PnL against its loss limit, top-up budget used, fill rate, slices left, distance to liquidation): `pause`, `continue` or `adjust`, accepted through the existing signed accept.

**Policy, and where each limit is enforced**

| Limit | Value | Enforced by |
|---|---|---|
| Daily cap and cooldown on moves between legs | $50/day, 30 s (testnet setup) | contract |
| Where funds may go | the owner's registered legs, or the owner | contract |
| Order policy: leverage, notional per order, coins, slippage | 5x, $100, BTC and ETH, 3% | agent (`checkOrder` on every strategy order) |
| Strategy limits: `maxNotional`, `maxLeverage` (only tighter than the order policy), `maxDailyLoss` (strategy PnL), `topUpCapPerDay` | per spec | agent (spec validation, runner) |
| Hedge reserve: share of the contract's daily cap strategies cannot budget | min(half the cap, $20), `HYPERNEAR_HEDGE_RESERVE_USD` | agent (spec validation) |
| Strategy leg | leg 3 (the agent scans legs 0 to 3); legs 0 to 2 are the hedge pair and the reserve | agent |
| Top-up source | reserve leg 2 only, within the strategy's remaining daily budget | agent (guard) |
| Draft route | 600 characters, rate-limited per IP | agent |

**Run the strategy path with no keys.** With the dry-run server from step 5 running (`node agent/src/server.ts --dry-run --serve`; the web page's Strategies panel shows the same data):

```bash
curl -s localhost:8787/strategies/0x2c7536e3605d9c16a7a3d7b1898e529396a65c23
curl -s -X POST localhost:8787/strategy/draft -H 'content-type: application/json' \
  -d '{"owner":"0x2c7536e3605d9c16a7a3d7b1898e529396a65c23","text":"Run a grid on BTC about 2% either side of the current price with 5 levels, about 11 dollars per level."}'
```

Expected: the first returns the recorded running grid `grid-live-1` on leg 3 (marked `simulated`); the second returns a recorded draft from the live Claude run (`"ok":true`, a `grid` spec, a `specHash`; the text "Grid on BTC with 20x leverage and 500 dollars." returns the recorded refusal, HTTP 422 with the reason). `/events` replays the recorded `strategy.*` events of the live grid and TWAP runs. Nothing here calls a model or the network.

**Demo 2 on testnet: one account per bot with capped top-ups** ([`agent/results/demo2-live.json`](agent/results/demo2-live.json)). A TWAP bot ran at 20x on leg 3 with a $5 daily top-up budget. The owner moved the leg's spare margin to spot; the guard moved $5 from the reserve leg 2 to leg 3 through the contract's `rebalance` (NEAR tx [Gi2X657R…](https://testnet.nearblocks.io/txns/Gi2X657Rgv25ALJzxgzkHYfp3MiDGNR1BQZuC7zk1Hv9)). A second stress was refused by the guard ("strategy top-up budget used"), and a direct `rebalance` above the contract's remaining daily cap was refused by the contract ("daily cap exceeded"). Other live runs: a grid ([`grid-live.json`](agent/results/grid-live.json)), a TWAP with a service restart in the middle ([`twap-live.json`](agent/results/twap-live.json)), the builder through a real server process ([`builder-e2e-live.json`](agent/results/builder-e2e-live.json)), strategy proposals ([`strategy-decision-live.json`](agent/results/strategy-decision-live.json); the losing-bot case uses synthetic input with real Jev and Claude calls, [`strategy-decision-losing-live.json`](agent/results/strategy-decision-losing-live.json)).

**Known limits**

- **No exchange-side dead-man below $1M of traded volume** (claim C19: Hyperliquid refuses `scheduleCancel`, testnet too). A crashed agent leaves at most `levels` resting grid buys until it restarts; the restore then cancels them. A freeze posted by someone other than our relayer leaves resting orders until someone runs `agent/scripts/clear-frozen.ts` (any NEAR account; no agent key needed).
- **`/strategy/draft` and strategy proposals are unauthenticated and spend model credits**; they are rate-limited per IP, nothing more.
- **Demo 2 used demo thresholds.** The operator's max leverage was raised from 5x to 20x for the run, and the guard floor from 2x to 10x maintenance: Hyperliquid keeps about 10% of the notional non-withdrawable, so a 20x leg stripped of its spare margin sits near 8x maintenance and never near 2x. The service defaults are unchanged.
- The loss limit counts the strategy's PnL since it started (not per day), and assumes the leg started flat. The strategy decision facts are bucketed from the same PnL.

## Run it live (needs credentials)

Copy `.env.example` to `.env` (git-ignored) and fill in what you use. Never commit it.

| Variable | Used for |
|---|---|
| `NEAR_NETWORK`, `NEAR_CONTRACT_ID`, `NEAR_RPC_URL` | which contract and network |
| `HYPERNEAR_RELAYER_ACCOUNT_ID`, `HYPERNEAR_RELAYER_PRIVATE_KEY` | relayer (pays gas and storage deposits) |
| `HYPERNEAR_AGENT_ACCOUNT_ID`, `HYPERNEAR_AGENT_PRIVATE_KEY` | the agent's function-call key |
| `LAB_WALLETS_PATH`, `LAB_WALLET_INDICES` | funded Hyperliquid testnet wallets for `validation/` |
| `HYPERNEAR_HEDGE_RESERVE_USD` | share of the contract daily cap strategies cannot budget (default 20, at most half the cap) |
| `TYPESAFE_API_KEY` | Jev |
| `ANTHROPIC_API_KEY` | Claude (escalation and chat) |
| `PRIVY_APP_ID` (web: `VITE_PRIVY_APP_ID`) | owner login |
| `NEAR_AI_API_KEY` | optional; NEAR AI Cloud chat returned HTTP 402 (no credit) when tested |

Testnet flow: deploy with `contract/scripts/deploy-testnet.sh <account>`, start the agent with `pnpm --filter @hypernear/agent start`, run the web UI with `pnpm --filter @hypernear/web dev` (set `VITE_PRIVY_APP_ID`), register legs, fund them with `usdSend`, approve agents, set the policy, then open a hedge. Live claim tests: `LIVE=1 pnpm --filter @hypernear/validation test` (spends testnet USDC from the lab wallets). Direct fallback if our relayer is down: send the signed intent to the contract's `owner_execute` with `near call`; the signature is the authentication.

Mainnet: [docs/mainnet-runbook.md](docs/mainnet-runbook.md). Every mainnet step is run by the owner by hand and prints its plan first.

## Baseline and disclosure

Rules Q-002 to Q-005: earlier code on another chain is allowed if disclosed, and only the NEAR integration built in the window is judged.

- **Baseline (pre-hackathon, Q-003):** [`packages/core`](packages/core) is a stripped copy of `packages/core` from PerpX (`maxperp/hl` commit `ef584538`, authored 2026-09-05, before the 2026-10-19 announcement): the `HlClient` import closure and the pure liquidation helpers. Tag `pre-hackathon`. Nothing else was copied from it.
- **Built in the window (2026-11-07 to 2026-11-14):** everything else: the NEAR contract, `packages/hypernear-client`, `agent/`, `web/`, `validation/`, the docs.
- **Diff:** [`pre-hackathon...hackathon-submission`](https://github.com/OWNER/REPO/compare/pre-hackathon...hackathon-submission) (TODO: replace `OWNER/REPO` with the repository when it is public). The tag `hackathon-submission` will be created on the final commit.

## License

MIT, see [LICENSE](LICENSE).
