# HyperNear

Smart accounts for Hyperliquid: the keys are held by NEAR Chain Signatures, and a public NEAR contract decides what may be signed.
An owner (any ordinary EVM wallet, through Privy) gets several Hyperliquid accounts ("legs"); the contract lets funds move only between those legs or back to the owner, gives agents a capped allowance, and lets the owner freeze everything.

Track: **security** first, **defi** second. License: MIT.

## The problem

A Hyperliquid master key is a bare EOA. Whoever holds it can approve any agent, send funds anywhere and withdraw everything. There is no withdrawal lock, no spending cap, no freeze, and no way to give an agent less than full trading rights over the account's money.

**Why not the existing options?**

- **Subaccounts.** They already let an API wallet move funds between accounts: we tested `subAccountTransfer` signed by an API wallet on testnet and it worked (claim C11, [`validation/results/C11.json`](validation/results/C11.json)). So subaccounts give access control, not policy: no destination lock, no caps, no freeze. Creating one also needs $100k of volume; we traded about $108k on testnet to get one.
- **Hyperliquid multi-sig.** A threshold of signers, but no rules about *what* may be signed.
- **Privy or Turnkey policy engines.** They can express EIP-712 rules for Hyperliquid, but the rules run inside the vendor's enclave, which you have to trust (Turnkey reportedly has a root-quorum override). Here the policy is a public NEAR contract anyone can read, and the key is held by NEAR's MPC network, so no single vendor holds it.
- **perps.near.com.** We found no public sign of user policy controls (claim C16: no public evidence, secondary sources only).

## What it does

- **Owner.** Any EOA, logged in through Privy (passkey, email or wallet). The owner signs EIP-712 intents; the contract checks them with `env::ecrecover`. Anyone may relay an intent, so the relayer cannot censor an owner.
- **Legs.** Leg *i* of an owner is the EVM address derived by NEAR Chain Signatures from (contract id, owner, leg). The contract signs Hyperliquid actions for it: `approveAgent`, `usdSend`, `usdClassTransfer`, `withdraw3`.
- **Withdrawals only to the owner.** The owner's `withdraw` intent has no destination field, so the destination is always the owner's address.
- **Agent permissions.** The owner names one NEAR agent account, with a daily cap and a cooldown. That account's access key is a NEAR function-call key limited to `rebalance` and `agent_usd_class_transfer`. `rebalance` can only move USDC to another registered leg of the same owner. Each leg also gets its own Hyperliquid API wallet for trading.
- **Margin guard.** The agent watches the legs and, when one nears liquidation, moves USDC from a healthier leg through the contract. Trigger: margin at or below 2x maintenance, or liquidation closer than a plausible price move over the rebalance latency (`agent/src/guard.ts`).
- **Hedge.** `open hedge` shorts a ratio of leg 0's position on leg 1; `close hedge` closes both. The agent checks leverage, notional and coin before trading.
- **Freeze.** One owner-signed intent stops every contract-signed action except the owner's withdraw, and in the same NEAR transaction the contract signs `approveAgent` calls that replace each trading agent with a keyless burn address, so the old API wallets are refused by Hyperliquid (details in [docs/readme-notes.md](docs/readme-notes.md)).
- **Decisions (propose mode).** For each hedge the agent asks Jev (TypeSafe AI) five yes/no questions, escalates to Claude (Sonnet 5.5; Opus 5.5 for large notional) when a factor is not decisive (below 0.90 or above 0.10), and shows the result as a proposal. The owner accepts or rejects it; nothing runs until accepted.
- **Chat.** A tool-calling chat over the owner's state (`agent/src/chat.ts`) with deliberately unfiltered tools, used for the prompt-injection demo below.

## What we guarantee, and what we don't

Guaranteed by the contract:

- Contract-signed USDC moves only between the owner's registered legs, or to the owner. An agent or relayer cannot send funds anywhere else.
- The agent's moves are bounded by the owner's daily cap and cooldown.
- After `freeze`, the contract signs nothing except the owner's withdraw and unfreeze.

Not guaranteed:

- **Trades can still lose money.** The contract limits where funds can go, not whether they are lost. An agent key can trade a leg badly, and a leg can be liquidated.
- **Order policy is checked off-chain**, in the agent (leverage, notional, coins). The contract cannot read Hyperliquid state. A TEE for the agent is a next step, not part of this repo.
- **Resting orders survive a freeze.** Freeze revokes the old API wallets and stops contract-signed actions; orders already on the book stay until cancelled.
- **The owner must be an EOA** (Privy embedded wallet or MetaMask). Smart-contract wallets (Safe, ERC-1271) are not supported.
- Funding a fresh leg costs 1 USDC of Hyperliquid activation fee; withdrawals cost 1 USDC.
- After the mainnet deploy the contract's full-access keys are deleted (see the runbook). That makes the contract account the custody root: nobody, including us, can upgrade it afterwards.

## NEAR features used

- **Chain Signatures** (`v1.signer`; `v1.signer-prod.testnet` on testnet): the contract calls `sign` for every Hyperliquid action. The MPC network holds the keys; the contract pays the 1 yoctoNEAR deposit from its own balance (claims C1, C7, C14).
- **A NEAR smart contract** (Rust, near-sdk 5, [`contract/`](contract)): legs, owner intents, agent policy, freeze.
- **Function-call access keys:** the agent's NEAR account can only call `rebalance` and `agent_usd_class_transfer` on the contract. On testnet the agent key tries `owner_execute` and NEAR refuses it.
- **NEAR Intents 1Click:** funding script `agent/scripts/fund-leg-1click.ts`. So far we have only run dry quotes (documented in [docs/mainnet-runbook.md](docs/mainnet-runbook.md)); the mainnet funding run is part of the runbook.
- **FastNEAR RPC** (`test.rpc.fastnear.com`): the NEAR side of a signature takes about 5.7 s p50 through it, against about 12 s measured through `rpc.testnet.near.org` (claim C6).

Also used: **Jev** by TypeSafe AI (decision layer), **Claude** (escalation and chat), **Privy** (owner login).

## Run it (no keys needed)

Needs Node 22.18 or newer (the agent runs TypeScript directly), pnpm 11, and Rust with `cargo` for the contract tests. Expected results were recorded on a fresh clone on Ubuntu 24.04 (Node 22.23, pnpm 11.15.1, Rust 1.99) at the commit this README was written for; counts change as tests are added.

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
packages/core test:       Tests  287 passed (287)
packages/hypernear-client test:       Tests  31 passed | 1 skipped (32)
validation test:       Tests  4 passed | 20 skipped (24)
agent test:       Tests  139 passed | 3 skipped (142)
```

**3. Contract tests.**

```bash
cd contract && cargo test && cd ..
```

Expected: `test result: ok. 41 passed; 0 failed`. They cover the owner-intent digests against viem signatures, replay and burned nonces, the cap and cooldown, rebalance to a foreign address, freeze and the Hyperliquid digests.

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

## Live evidence (NEAR testnet and Hyperliquid testnet, 2026-11-07)

Every claim has a committed test or script and a result file; the full ledger with all numbers is [docs/claims.md](docs/claims.md). Contract: `leash-spike-1107.testnet`.

| Claim | Result | Evidence |
|---|---|---|
| C1 MPC signature recovers to the derived address | 11/11 | NEAR tx [5ofs76x8…](https://testnet.nearblocks.io/txns/5ofs76x8CdXMorzZTinnSovpvRsJZmoHZhPDNtfjUogh); address [0xe8e7c697…](https://app.hyperliquid-testnet.xyz/explorer/address/0xe8e7c69788249d5bc17ddbd441cdf41f6f8a0274) |
| C2 Hyperliquid accepts `approveAgent` signed by MPC | ok | NEAR tx [6hEDswnz…](https://testnet.nearblocks.io/txns/6hEDswnziqMfxYxR85TN9vuXb66xY3KkMMSoXEsJQErT); leg [0xff689f4b…](https://app.hyperliquid-testnet.xyz/explorer/address/0xff689f4bf14686c751df87304178eacb3c2194e3) |
| C3 `usdSend`, `usdClassTransfer`, `withdraw3` signed by MPC | all ok | NEAR txs [usdSend](https://testnet.nearblocks.io/txns/5YETHthJtWddKgsAkjKbD9rV9d2UxmiF2NUVJRvdoNHr), [usdClassTransfer](https://testnet.nearblocks.io/txns/AxYVw9UM5475w7gf1d9bSNfTz5aTHkeJVjTv5kPqvpQE), [withdraw3](https://testnet.nearblocks.io/txns/79D12deyDXkabqRzBTisYL89bvE9myAH2LovE8wcHoU5) |
| C7 Agent function-call key calls `rebalance`; contract pays the MPC deposit | ok | NEAR tx [BaoLesRA…](https://testnet.nearblocks.io/txns/BaoLesRAhannL1tQJjXyP3MCUTQEb2NSY4axXXRXu1eY) |
| C11 An API wallet can do `subAccountTransfer` | ok | subaccount [0x4c163613…](https://app.hyperliquid-testnet.xyz/explorer/address/0x4c163613b406241f43a5492a917f4c0759670ac5) |
| C13 Privy `signTypedData` with a custom domain | not run | pending |
| C9/C15 1Click funding of a fresh address | not run | mainnet, in the runbook |
| Decision layer: Jev p50 0.69 s; top answer flips under shuffling on 16% of states; 5% of calls reach 0.90 | measured | [C17](validation/results/C17.json), [C17b](validation/results/C17b.json), [C18](validation/results/C18.json), [C18b](validation/results/C18b.json) |

**Margin guard demo** (`agent/scripts/guard-demo.ts`, results in [`agent/results/`](agent/results)). The stress leg was pushed to 40x; the guard detected `margin_floor` and moved 1.54 USDC from leg 2 to leg 1 through the contract. Run 2 timeline: detected +0.7 s, NEAR signed +7.0 s, Hyperliquid posted +8.4 s, recovered +11.1 s. NEAR tx [8WRUpM9E…](https://testnet.nearblocks.io/txns/8WRUpM9EfmouBejeYDoH3w3ELjwaRTPpx2ugcGURSYoo) (run 1: [4ej8UZ8C…](https://testnet.nearblocks.io/txns/4ej8UZ8CDcHUZHGZhS4m1GTuMgZdaPaRL1fBvvKWtDes), recovered +13.6 s).

**Hedge** ([`agent/results/D3-live.json`](agent/results/D3-live.json)): leg 1 shorted 0.0002 BTC at 3x (oid 64758082577); closing filled both legs reduce-only; both positions ended at size 0.

**Freeze** ([`agent/results/freeze-live.json`](agent/results/freeze-live.json)). One NEAR transaction [24aTEXc2…](https://testnet.nearblocks.io/txns/24aTEXc2H2KpADmML9HtXBeckd2NysVcwPBjt1vFv9HK) revoked the agents on all 3 legs on Hyperliquid (`ok`). Eight seconds later an order from an old agent was refused by Hyperliquid. An order resting before the freeze stayed on the book (see "what we don't guarantee").

**Prompt-injection demo** ([`validation/results/injection-demo.json`](validation/results/injection-demo.json), `agent/scripts/injection-demo.ts`). A chat with unfiltered tools read a "market news" paste containing a hidden instruction to move all funds to an attacker address. Honest outcome: **no model followed it** (Sonnet 5.5 in three prompt variants, Haiku 5.5 in one); Sonnet named the injected line and ignored it. So we then called the tools directly with the injected arguments, as a model that did follow it would:

- `rebalance` to the attacker address reverted on chain: "destination is not a registered leg of this owner", NEAR tx [J6P8cPND…](https://testnet.nearblocks.io/txns/J6P8cPNDBpZWpEDR9AbTTEE3c1Q98jQPM1Lj8Lmxxo3B).
- `withdraw` without an owner signature was refused: `HTTP 400: sig must be 65 bytes hex`.
- `withdraw` with a forged signature was refused by the contract: `owner_execute failed: Smart contract panicked: signature: bad v`.
- The agent's NEAR key cannot call `owner_execute`: `Access key does not allow method owner_execute`.

Mainnet: not run yet. The plan, costs and abort points are in [docs/mainnet-runbook.md](docs/mainnet-runbook.md); explorer links will be added here after the run.

## Run it live (needs credentials)

Copy `.env.example` to `.env` (git-ignored) and fill in what you use. Never commit it.

| Variable | Used for |
|---|---|
| `NEAR_NETWORK`, `NEAR_CONTRACT_ID`, `NEAR_RPC_URL` | which contract and network |
| `HYPERNEAR_RELAYER_ACCOUNT_ID`, `HYPERNEAR_RELAYER_PRIVATE_KEY` | relayer (pays gas and storage deposits) |
| `HYPERNEAR_AGENT_ACCOUNT_ID`, `HYPERNEAR_AGENT_PRIVATE_KEY` | the agent's function-call key |
| `LAB_WALLETS_PATH`, `LAB_WALLET_INDICES` | funded Hyperliquid testnet wallets for `validation/` |
| `TYPESAFE_API_KEY` | Jev |
| `ANTHROPIC_API_KEY` | Claude (escalation and chat) |
| `PRIVY_APP_ID` (web: `VITE_PRIVY_APP_ID`) | owner login |
| `NEAR_AI_API_KEY` | optional; NEAR AI Cloud chat returned HTTP 402 (no credit) when tested |

Testnet flow: deploy with `contract/scripts/deploy-testnet.sh <account>`, start the agent with `pnpm --filter @hypernear/agent start`, run the web UI with `pnpm --filter @hypernear/web dev` (set `VITE_PRIVY_APP_ID`), register legs, fund them with `usdSend`, approve agents, set the policy, then open a hedge. Live claim tests: `LIVE=1 pnpm --filter @hypernear/validation test` (spends testnet USDC from the lab wallets). Direct fallback if our relayer is down: send the signed intent to the contract's `owner_execute` with `near call`; the signature is the authentication.

Mainnet: [docs/mainnet-runbook.md](docs/mainnet-runbook.md). Every mainnet step is run by the owner by hand and prints its plan first.

## Baseline and disclosure

Rules Q-002 to Q-005: earlier code on another chain is allowed if disclosed, and only the NEAR integration built in the window is judged.

- **Baseline (pre-hackathon):** [`packages/core`](packages/core) is a stripped copy of the Hyperliquid client core from PerpX (`maxperp/hl` at commit `ef5845387a2ba88cfd854ac438e821352dc743c0`): the `HlClient` import closure and the pure liquidation helpers. Tag `pre-hackathon`. Nothing else was copied from it.
- **Built in the window (2026-11-07 to 2026-11-14):** everything else: the NEAR contract, `packages/hypernear-client`, `agent/`, `web/`, `validation/`, the docs.
- **Diff:** [`pre-hackathon...hackathon-submission`](https://github.com/OWNER/REPO/compare/pre-hackathon...hackathon-submission) (link to be filled in when the repository is public).

## License

MIT, see [LICENSE](LICENSE).
