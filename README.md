<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo-dark.svg">
  <img src="docs/brand/logo-light.svg" alt="HyperNear" height="56">
</picture>

# HyperNear

Demo video and X post: `<X_POST_URL>` (TODO: replace before submitting; built at NEAR HACKATHON, @NEARProtocol #NEARHackathon)

Live (testnet): the web app at [hypernear.t09.fun](https://hypernear.t09.fun), served by the agent at `https://agent.t09.fun` (NEAR testnet and Hyperliquid testnet, one Hetzner VPS, no TEE). The submitted commit is the tag `hackathon-submission`.

Smart accounts for Hyperliquid: the keys are held by NEAR Chain Signatures, and a public NEAR contract decides what may be signed.
An owner (any ordinary EVM wallet) gets several Hyperliquid accounts ("legs"); the contract lets funds move only between those legs or back to the owner, gives agents a capped allowance, and lets the owner freeze everything.

**For:** anyone who lets a bot, a desk or an AI agent trade a Hyperliquid account and wants a withdraw lock, spending caps and a kill switch the operator cannot bypass. Trading stays at native Hyperliquid speed with per-leg API wallets; only owner-level moves (transfers, approvals, withdrawals, freeze) go through the NEAR contract, ~8 s each (C6).

Names fixed by the deployed testnet contract: the contract account `leash-spike-1107.testnet`, the EIP-712 domain name `Leash`, the burn-address seed `leash-burn` and the Hyperliquid agent names `leash-leg<N>` and `leash-tee` carry the project's first name, because changing them means deploying a new contract. Everything else is named HyperNear.

Tracks: **security** (AI Security & Defense), **defi** (Unstoppable DeFi), **agents** (Agent Economy). License: MIT.

## Live evidence (NEAR testnet and Hyperliquid testnet)

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

Mainnet: not deployed. The project runs on NEAR and Hyperliquid testnet (testnet-only projects are eligible, FAQ Q-010). A mainnet deploy locks the contract for good, so it waits for the pricing design above and a real-hardware TEE run; the plan, costs and abort points are ready in [docs/mainnet-runbook.md](docs/mainnet-runbook.md).

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

- **Owner.** Any EOA. Owner intents are EIP-712 typed data verified on-chain with `env::ecrecover` (domain name `Leash`, the project's first name, kept so signatures and the deployed contracts stay valid) (tested with viem signatures and an injected-wallet login through the real Privy modal; the Privy embedded/passkey wallet's signature path is not yet verified, C13). Anyone may relay an intent, so the relayer cannot censor an owner.
- **Legs.** Leg *i* of an owner is the EVM address derived by NEAR Chain Signatures from (contract id, owner, leg). The contract signs Hyperliquid actions for it: `approveAgent`, `usdSend`, `usdClassTransfer`, `withdraw3`, and `sendAsset` of spot USDC to another leg (only for unified legs).
- **Withdrawals only to the owner.** The owner's `withdraw` intent has no destination field, so the destination is always the owner's address.
- **Agent permissions.** The owner names one NEAR agent account, with a daily cap and a cooldown. That account's access key is a NEAR function-call key limited to `rebalance` and `agent_usd_class_transfer`. `rebalance` can only move USDC to another registered leg of the same owner (a `usdSend`, or with `spot: true` a spot `sendAsset` for a unified leg). Each leg also gets its own Hyperliquid API wallet for trading.
- **Margin guard.** The agent watches the legs and, when one nears liquidation, moves USDC from a healthier leg through the contract. Trigger: margin at or below 2x maintenance, or liquidation closer than a plausible price move over the rebalance latency (`agent/src/guard.ts`).
- **Hedge.** `open hedge` shorts a ratio of leg 0's position on leg 1; `close hedge` closes both. The agent checks leverage, notional and coin before trading.
- **Trade.** Every leg can trade on its own, so a position need not be a hedge: market, limit, stop and take-profit, a take-profit and stop-loss bracket, TWAP and trailing-stop orders, at the leverage and margin mode the owner picks per leg (a hedge's leg 1 can differ from leg 0). Each order is a signed command that carries its exact spec (`specHash`, like a strategy start), the agent re-checks it against the order policy, and Hyperliquid holds the protective orders itself (`agent/src/order.ts`, `agent/src/orders.ts`). A market or limit order can carry its own take-profit and stop-loss (one Hyperliquid `normalTpsl` group: reduce-only triggers for the same size), and a resting limit order can be moved to a new price (`modifyOrder`, Hyperliquid `modify`: same size and client id; the exchange gives it a new order id), each checked against the same policy as a new order. Every order carries a client id (`agent/src/cloid.ts`), so history can label each fill (hedge, one-sided, protective, strategy, outside) from Hyperliquid's own records with nothing stored. Setting TP/SL on an open position or on both legs of a hedge (`setProtection`, `agent/src/orders.ts`) and the limit close are covered by unit and dry-run tests (`agent/tests/protect.test.ts`, `web/e2e/round3.mjs`); they have not yet been run on live testnet.
- **Hedged open in one action.** The Trade ticket's Hedge mode can open a NEW hedge (long or short, size, ratio, leverage and margin mode per leg) instead of mirroring an existing position: one signed command (`placeHedge`, `agent/src/hedgePair.ts`) sends both market (IOC) orders at the same moment off one order-book read, so their entry prices differ by little more than the book spread (3.5 bps against a 4.6 bps book on testnet). Two accounts cannot share one exchange request, so it is not atomic on Hyperliquid: if only one leg fills, or the fills are out of ratio, the surplus is closed again with reduce-only orders; a lost reply is settled from the leg's position, and anything that cannot be settled is reported as `unbalanced` rather than hidden. A 1-click session may open hedges only if the owner ticks that box, and a session counts both legs against its notional cap.
- **Leverage follows the market.** The ticket's maximum is the market's own (BTC 40x, ETH 25x on testnet), capped by the operator policy `HYPERNEAR_MAX_LEVERAGE` (the code default is 5; the compose file and the hosted deployment set it to 100, so each market's maximum rules). Positions show their leverage beside the market maximum.
- **Live data.** The page opens one Hyperliquid WebSocket per tab (Hyperliquid allows 10 per IP) and subscribes to each leg's account state, open orders and fills; the agent view is polled every 30 s while it is live, every 10 s otherwise, and a Live / Polling chip shows which. A fill or order change refetches the fees, funding and history, which the agent computes (`web/src/hlSocket.ts`, `web/src/liveLegs.ts`).
- **Easy trading.** A chat-style tab: say what you want ("long BTC at market for $30, 5x", "short ETH at the best ask", "close my BTC position", "3% stop loss and 6% take profit"), read the draft, sign it. Claude only fills a fixed-shape intent (no tools, no memory, the text is data); deterministic code builds the same specs the ticket signs, the existing validators decide, and the page shows a summary built from the validated spec and re-hashes it before asking for a signature. Withdrawals, transfers and keys are not in the schema. It has its own rate limits and a daily cap on model calls (`HYPERNEAR_CHAT_DAILY`, default 300), and answers only for owners who opted the agent in (`agent/src/trade/intent.ts`).
- **Fee components.** A position's trading fees are split into opening/adding and reducing/closing, taker and maker (and a builder fee when there is one), each with its fills, traded amount, effective rate and amount, plus the estimated closing fee; funding and the one-off account setup fee stay separate lines (`agent/src/positions.ts`, the Fee components table in Portfolio).
- **Positions and PnL.** The Overview tab shows each position as the owner thinks of it (a hedge of two legs, a one-sided trade) with realized, unrealized, fees, funding and the one-off account setup fee as separate lines, an estimated net if closed now, the next funding payment, tools to reduce or close each leg, a PnL chart and the labelled history (`agent/src/positions.ts`). A hedge has no break-even price (the legs cancel), so that card is gone. Checked on testnet: each leg's balance change equals closedPnl minus fees plus funding to six decimals (`agent/scripts/orders-live.ts`).
- **1-click trading (optional).** By default every order is one wallet signature. The owner can instead sign one `startSession` command naming a key made in the browser tab (15 min to 24 h); the agent then also accepts `placeOrder` and `cancelOrder` signed by that key, for that owner only, inside the order policy narrowed by the session's own caps (`agent/src/sessions.ts`). The key can never start a session, open a hedge, start a strategy, change a setting or reach the contract. Sessions live in the agent's memory only: a restart, `endSession`, a freeze or a TEE switch ends them. The key sits in the tab's `sessionStorage`, so script running on the page could use it until it expires; that is the trade for no wallet popups, and it is bounded by the policy above.
- **Unified accounts.** Every leg can be converted to a Hyperliquid unified account (one USDC balance for spot and margin) by its own agent key, with no extra signature; the agent does it for every approved, funded leg (on by default; `HYPERNEAR_CONVERT_UNIFIED=0` turns it off). Conversion is one-way, and Hyperliquid then refuses `usdSend` and `usdClassTransfer`, so a unified leg moves money with `sendAsset`; measurements and what changed are in [docs/unified-accounts.md](docs/unified-accounts.md). Checked on testnet with a throwaway owner (`agent/scripts/rebalance-live.ts`).
- **Rebalance legs.** The Fund tab can split the pool of chosen legs by percentages (70/30, even split): the owner signs the shares once (`rebalanceLegs`, owner key only, never a session key), the planner computes the moves from live balances (at most legs minus one, free balance only, margin guard respected), and the agent makes them one after another through the contract, within the daily cap and cooldown (`agent/src/rebalance.ts`).
- **Withdraw.** A leg pays out to the owner's own wallet only (Hyperliquid charges 1 USDC); the relayer posts the contract-signed withdrawal.
- **Freeze.** One owner-signed intent stops every contract-signed action except the owner's withdraw, and in the same NEAR transaction the contract signs `approveAgent` calls that replace each trading agent with a keyless burn address, so the old API wallets are refused by Hyperliquid (details in [docs/readme-notes.md](docs/readme-notes.md)).
- **Decisions (propose mode).** For each hedge the agent asks Jev (TypeSafe AI) five yes/no questions, escalates to Claude when a factor is not decisive (below 0.90 or above 0.10), and shows the result as a proposal. The first call goes to Sonnet 5.5, or to Opus 5.5 when the hedge's combined notional is above $1,000; if Sonnet's answer differs from the factor table's, Opus is asked as well and wins (`agent/src/decide.ts`). The owner accepts or rejects it; nothing runs until accepted.
- **Strategies.** Grid and TWAP/DCA bots, each on its own leg with its own top-up budget, drafted from plain language and started only by an owner signature; see [Strategies](#strategies-each-on-its-own-leg).
- **Chat.** A tool-calling chat over the owner's state (`agent/src/chat.ts`) with deliberately unfiltered tools, used for the prompt-injection demo below.
- **Notifications.** The bell lists this tab's alerts and the owner's agent events, newest first and grouped by day, each with a severity, a title in plain words and its own time (`web/src/notifications.tsx`). What has been read is kept per owner in the browser as a time, so a reload does not mark everything unread; there is a Mark all read button and a Needs attention filter.
- **Setup checklist.** Five steps (create legs, prepare agents, fund, approve agents, enable the agent). The Fund step counts as done when legs 0 and 1 hold money, whatever the account mode (`web/src/setup.ts`). The Finish setup banner can be hidden per owner and comes back from the Account menu.
- **Rate-limit resilience.** Every NEAR RPC call and every Hyperliquid call of the agent goes through a shared gate (`packages/hypernear-client/src/rpc.ts`, `packages/core/src/hl/rateGate.ts`): identical reads in flight share one request, reads are cached for a few seconds (longer for market metadata), and 429 and 5xx answers are retried with jittered backoff. A signed order is re-sent only after an HTTP 429, with the same body, and never after any other answer. A write clears the cache. Added after the free FastNEAR and Hyperliquid testnet endpoints throttled the hosted agent; reads can therefore be a few seconds old (up to 20 s for fills and the ledger).

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
- Funding a fresh leg costs 1 USDC of Hyperliquid activation fee; withdrawals cost 1 USDC. The activation fee falls in one of two places: a never-seen address loses 1 USDC from its first credit (testnet, C10), and on mainnet an account that was funded without a fee pays 1 USDC extra on its first transfer to another address, the receiver getting the full amount ([example tx](https://app.hyperliquid.xyz/explorer/tx/0x7b92cb810b73780d7d0c044856007802044f0066a67696df1f5b76d3ca7751f8)). The agent reads which applies (`agent/src/activation.ts`) and sends the extra USDC.
- After a mainnet deploy the runbook deletes the contract's full-access keys (step 10; we have not deployed to mainnet, see [Live evidence](#live-evidence-near-testnet-and-hyperliquid-testnet-2026-11-07)). That makes the contract account the custody root: nobody, including us, can upgrade it afterwards.

## Optional TEE mode (not yet run on real hardware)

By default our server runs the agent, so the owner trusts us with the order policy, the trading keys and the kill switch. An owner can instead choose **TEE mode** (paid, USDC per month) in the web UI:

- `setTee {measurementHash, agentAccount}` (owner-signed) names one agent instance and the code measurement the owner accepts. While it is set, only that NEAR account, registered with a matching unexpired attestation, may `rebalance` or `agent_usd_class_transfer` for the owner, and the owner's own `approveAgent` is refused.
- `register_tee_agent` verifies an Intel TDX quote **inside the contract** (the `shade-attestation` / `dcap-qvl` verifier, vendored) and binds it to the caller's implicit-account key; a reused quote is refused and registrations expire after 7 days. Verifying one real recorded quote on testnet burned 187 TGas (T0, tx [4QTqwXfG…](https://testnet.nearblocks.io/txns/4QTqwXfGn9hfVohdyJZHPcaaoaSNju5FBwDA4HW4sC6f), [`validation/results/T0.json`](validation/results/T0.json)).
- The TEE agent makes fresh Hyperliquid trading keys per boot, in memory only, and gets them approved through `tee_approve_agent`. Entering, switching or leaving TEE mode (`setTee`) revokes every trading key on the owner's legs, the server's included, in the same transaction; going back to the server means preparing and approving its keys again.
- `payTee {leg, months, priceMicro, feeAddress}` signs a `usdSend` of exactly what the owner saw; the agent serves only owners whose payments actually landed in the Hyperliquid ledger.
- Run it: the agent with `HYPERNEAR_RUN_MODE=tee` (`Dockerfile`, `docker-compose.tee.yml`); the server agent (`HYPERNEAR_RUN_MODE=server`, the default) skips owners in TEE mode.

**Status, plainly:** the owner-binding, payment and revocation logic passed 14 of 14 live checks on NEAR and Hyperliquid testnet (claim C21), but with a **dev registration** (`register_tee_agent_dev`, testnet builds only) instead of a TDX quote. On-chain quote verification is shown only by T0's recorded quote. The agent has **not yet run on a real Phala TDX machine**, so the full chain (real quote → registration → trading) is unproven. Even when it runs: the TEE gives no liveness (freeze and the `cancel_orders` sweep stay the fallback), the agent's AI API keys are passed as unmeasured environment variables, and TDX itself has known side-channel limits.

**TEE pricing (planned, not built).** The contract today has one TEE price and fee address, fixed when it is created. That is fine on testnet but too rigid for a contract whose keys are deleted after deploy, so the mainnet design changes it:

- **Two offers, priced off-chain.** A *dedicated* TEE (one owner per instance: the full machine cost, about $42 a month for a Phala `tdx.small`, plus a margin and a setup fee) and a *shared* seat (one instance serving up to about 10 owners: the machine cost divided by expected occupancy plus a margin, about $8 to $10 a month). The contract already supports both, because each owner names their own TEE agent account and code measurement; only the price differs. Sharing changes liveness and blast radius (one crash stops every owner on that instance), not key safety: every instance runs the same measured code, and each owner's trading keys stay in their own slot of its memory.
- **The owner signs the exact amount.** `payTee {leg, amount, feeAddress}`: the contract keeps one published fee address and checks only that, so nobody can charge more than the owner signed and the guarantee line holds. Prices, tiers and how long a payment covers live with each TEE agent, which checks the Hyperliquid ledger before serving (as it does now), so prices can follow the machine cost without a new contract.
- **No escrow pool.** A pay-when-full escrow for shared instances would add refund logic to an unupgradable contract to save about $42 a month of risk; we would rather pay for the first shared instance ourselves.

## NEAR features used

- **Chain Signatures** (`v1.signer`; `v1.signer-prod.testnet` on testnet): the contract calls `sign` for every Hyperliquid action. The MPC network holds the keys; the contract pays the 1 yoctoNEAR deposit from its own balance (claims C1, C7, C14).
- **A NEAR smart contract** (Rust, near-sdk 5, [`contract/`](contract)): legs, owner intents, agent policy, freeze, and Hyperliquid order cancels signed with a leg's master key (the L1 "phantom agent" scheme, msgpack encoded in the contract; claim C20).
- **Function-call access keys:** the agent's NEAR account can only call `rebalance` and `agent_usd_class_transfer` on the contract. On testnet the agent key tries `owner_execute` and NEAR refuses it.
- **NEAR Intents 1Click (dry quotes only):** funding script `agent/scripts/fund-leg-1click.ts`. 1Click has no testnet, so we ran dry quotes (`dry: true`, as the hackathon FAQ recommends, Q-007), documented in [docs/mainnet-runbook.md](docs/mainnet-runbook.md); a live funding run is part of the mainnet runbook.
- **FastNEAR RPC** (`test.rpc.fastnear.com`): a full master action (NEAR sign, Hyperliquid post, balance change) takes 7.75 s p50 / 8.78 s p95 end to end; the NEAR side alone is about 5.7 s p50 through FastNEAR, against about 12 s through `rpc.testnet.near.org` (claim C6).

Also used: **Jev** by TypeSafe AI (decision layer), **Claude** (escalation and chat), **Privy** (owner login).

## Run it (no keys needed)

Needs Node 22.18 or newer (the agent runs TypeScript directly), pnpm 11.15.1 (the version the fresh clone used), and Rust with `cargo` for the contract tests. Expected results were recorded on a fresh clone on Ubuntu 24.04 (Node 22.23, pnpm 11.15.1, Rust 1.99) at the commit this README was written for; counts change as tests are added.

**0. Get the code.**

```bash
git clone https://github.com/0xMaxyz/HyperNear.git
cd HyperNear
```

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
packages/core test:       Tests  294 passed (294)
packages/hypernear-client test:       Tests  50 passed | 1 skipped (51)
validation test:       Tests  4 passed | 21 skipped (25)
agent test:       Tests  612 passed | 9 skipped (621)
```

**3. Contract tests.**

```bash
cd contract && cargo test && cd ..
```

Expected: `test result: ok. 79 passed; 0 failed` (83 with `--features spike`). They cover the owner-intent digests against viem signatures, replay and burned nonces, the cap and cooldown, rebalance to a foreign address, freeze, the Hyperliquid digests, the L1 cancel digests against the SDK vectors, and TEE mode (a recorded real TDX quote verifies, a tampered or reused one is refused, a stranger instance and the server agent are refused, keys are burned on a switch, the fee terms the owner signed).

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

Expected: Vite prints `Local: http://localhost:5173/`. Open that URL and click **Explore recorded data**. Expected: a `dry-run data` badge and the tabs **Easy**, **Trade**, **Portfolio**, **Fund** and **Safety**. Login is disabled without `VITE_PRIVY_APP_ID`; the recorded data still works.

Optional automated check of that click-through (needs a Chromium download, with the agent and Vite still running):

```bash
pnpm --filter @hypernear/web exec playwright install chromium
cd web && node e2e/explore-check.mjs
```

Expected: five `PASS page shows "..."` lines and exit code 0.

## Strategies, each on its own leg

A strategy (a grid or a TWAP/DCA) runs on its own leg, so its losses stay on that leg, the margin guard can top it up only from the reserve leg and only within the strategy's own daily budget (and the contract's cap and cooldown on top), and `freeze` stops all of it. Design, what was cut (funding carry) and the details: [docs/strategies.md](docs/strategies.md).

- **Spec.** One JSON object per strategy (`agent/src/strategy/spec.ts`). The owner signs a `startStrategy` Command whose `specHash` is the hash of the spec; a spec changed after signing is refused.
- **Builder.** `POST /strategy/draft {owner, text}`: Claude (Sonnet 5.5, structured output) drafts a spec from plain language, `validateSpec` checks it against the order policy and the contract policy, and the response is `{spec, specHash, diff, warnings}` or a refusal with the reasons. It starts nothing.
- **Kill switch and restart.** Owner-signed pause and stop; a pause that cannot clear the book keeps retrying. After a service restart every saved strategy comes back paused, its orphaned orders are cancelled, and the owner resumes it with a signed start over the stored spec.
- **Strategy decisions (propose mode).** Same Jev-then-Claude pipeline as the hedge, with the strategy's own facts (PnL against its loss limit, top-up budget used, fill rate, slices left, distance to liquidation): `pause`, `continue` or `adjust`, accepted through the existing signed accept.

**Policy, and where each limit is enforced**

| Limit | Value | Enforced by |
|---|---|---|
| Daily cap and cooldown on moves between legs | $50/day, 30 s or 60 s (testnet setup) | contract |
| Where funds may go | the owner's registered legs, or the owner | contract |
| Order policy: leverage, notional per order, coins, slippage | each market's own maximum (BTC 40x, ETH 25x on testnet; `HYPERNEAR_MAX_LEVERAGE=100`), $100, BTC and ETH, 3% | agent (`checkOrder` on every strategy order) |
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
| `NEAR_AI_API_KEY` | optional; NEAR AI Cloud as a chat model provider (`validation/tests/c12-near-ai.test.ts`) |

Testnet flow: deploy with `contract/scripts/deploy-testnet.sh <account>`, start the agent with `pnpm --filter @hypernear/agent start`, run the web UI with `pnpm --filter @hypernear/web dev` (set `VITE_PRIVY_APP_ID`), register legs, fund them with `usdSend`, approve agents, set the policy, then open a hedge. Live claim tests: `LIVE=1 pnpm --filter @hypernear/validation test` (spends testnet USDC from the lab wallets). Direct fallback if our relayer is down: send the signed intent to the contract's `owner_execute` with `near call`; the signature is the authentication.

Mainnet: [docs/mainnet-runbook.md](docs/mainnet-runbook.md). Every mainnet step is run by the owner by hand and prints its plan first.

## Baseline and disclosure

Rules Q-002 to Q-005: earlier code is allowed if disclosed, and only the NEAR integration built in the window is judged.

**Before the hackathon (tag `pre-hackathon`).** [`packages/core`](packages/core) is a Hyperliquid client library we wrote earlier. It adds the typed REST and exchange client for Hyperliquid, signing of exchange actions and orders, the order, position and account types, and the pure liquidation-distance helpers. It has no NEAR code. Nothing else in this repository existed before.

**Built during the hackathon (2026-11-07 to 2026-11-14).**

- `contract/`: the NEAR contract: legs derived by Chain Signatures, owner intents verified on chain, agent allowance with a daily cap and cooldown, freeze with key revocation, the cancel sweep, and TEE mode.
- `packages/hypernear-client`: the TypeScript client for that contract (intents, commands, signing of Hyperliquid actions through the contract).
- `agent/`: the relayer, margin guard, order and hedge execution, TP/SL, strategies, the decision layer, and Easy trading.
- `web/`: the trade terminal and the Easy, Portfolio, Fund and Safety screens.
- `validation/` and `agent/results/`: the live claim tests and their recorded results.
- In `packages/core` during the window: one addition, a trailing-stop order helper (`HlClient.trailingStopOpen`, with its wire-format test in `packages/core/tests/trailing-stop/`). It is Hyperliquid client code with no NEAR integration; the order is accepted on testnet and unverified on mainnet.

**Diff.** [`pre-hackathon...hackathon-submission`](https://github.com/0xMaxyz/HyperNear/compare/pre-hackathon...hackathon-submission) shows everything built in the window. `pre-hackathon` is the commit that imports `packages/core`; `hackathon-submission` is the submitted commit. A few commits dated 2026-11-07 rebuild the same `packages/core` import step by step; they add nothing beyond it.

## Libraries, services and AI use

**AI-written code.** Most of the code, tests and docs in this repo were written with Claude Code (Anthropic's coding agent) under the author's direction, and reviewed and tested by the author. Design and code reviews were also done by Claude models (Fable 5.2 and Opus 5.5). The live testnet runs and their result files are real runs, not generated text.

**Rust (contract):** `near-sdk` 5.30 (with `unstable` for `env::ecrecover`), `hex`, `shade-attestation` (vendored in `contract/vendor/shade-attestation`, which includes the `dcap-qvl` TDX quote verifier); tests: `k256`.

**TypeScript:**

| Package | Libraries |
|---|---|
| `packages/core` (baseline) | `@nktkas/hyperliquid` 0.33.1, `viem` 2.54.3, `@msgpack/msgpack` 3.1.3 (tests) |
| `packages/hypernear-client` | `near-api-js` 7.4.0, `viem` 2.54.3 |
| `agent` | `@anthropic-ai/sdk`, `@typesafe-ai/sdk` 0.7.0 (Jev), `@near-js/crypto` 2.5.1, `@neardefi/shade-agent-js` 2.2.0, `@phala/dstack-sdk` 0.5.7, `near-seed-phrase` 0.2.1, `viem` 2.54.3 |
| `web` | `react` 18.3.1, `vite` 7, `@privy-io/react-auth` 3.51.3, `@solana/kit` 8.6.0, `lightweight-charts` 5.2.1, `viem` 2.54.3; tests: `@playwright/test` 1.65.0 |
| tooling | `typescript`, `tsup`, `vitest`, `esbuild`, pnpm 11.15.1 |

**Services:** NEAR testnet and the MPC signer `v1.signer-prod.testnet`, FastNEAR RPC, Hyperliquid testnet API, Hetzner Cloud (one VPS for the hosted agent and web, Caddy in front), NEAR Intents 1Click (dry quotes only), Jev by TypeSafe AI, the Anthropic Claude API, Privy.

**Vendored or copied third-party code:** `contract/vendor/shade-attestation` is `shade-attestation` 0.2.0 from NearDeFi/shade-agent-framework at commit `3366bc9` (source unmodified, version pins relaxed, `dcap-qvl` 0.5.2). The recorded TDX quote in `contract/tests/tee/attestation.json` comes from the near/mpc repository's test assets (`crates/test-utils/assets/public_data.json` at `50328c6`). Source: `validation/results/T0.json`.

**Templates and boilerplate:** none beyond the baseline above.

## License

MIT, see [LICENSE](LICENSE).
