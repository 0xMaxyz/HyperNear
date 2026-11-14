# ts-dev notes

Running log for TypeScript work (core, validation/, agent/). Newest decisions first.

## Rules of the road
- Install, typecheck and test only on ci32 (`remote-test-box` helper). `sync` sends committed HEAD of branch `wip/ts`.
- ci32 jobs: `pnpm install --frozen-lockfile` needs the committed `pnpm-lock.yaml`. When deps change, run `pnpm install --no-frozen-lockfile` on the box and scp the lock back (`ci32:C:/Users/hamid/ci32-jobs/near_hck-pnpm-lock.yaml`).
- `ci32.sh sync` fails to update an existing checkout unless you first run `ci32.sh exec 'git -C ~/work/near_hck checkout -q --detach'`.
- Do not put nested heredocs or very long compound commands in one Bash call: the hook rewrites and breaks them. Use the Write tool for files.

## Baseline (core)
- Source: `maxperp/hl` `ef5845387a2ba88cfd854ac438e821352dc743c0`, `packages/core`, stripped to the `hl/HlClient` closure.
- Kept: `hl/{HlClient,types,handshake,agent-name,pricing,priority,assetIndex,testOnlyRawKeySigner,index}`, `client/relay-rejection`, `adapters/types`, `liquidation.ts` (extracted from `client/market-data.ts`).
- NOT kept: `hl/funding-routes.ts` (not in the closure; imports bridge/CCTP/HyperEVM modules the plan deletes).
- **viem is pinned to 2.54.3** (exact, plus a workspace `overrides` entry). viem >= 2.57 rejects HL's `HyperliquidTransaction:*` EIP-712 primary types (`InvalidStructTypeError`). Anything that signs HL user-signed actions with viem must stay on 2.54.3, or hash the typed data itself.
- `HlClient` has no raw "send this pre-signed action" method. The validation harness submits pre-signed JSON with its own fetch (`submitSignedAction`). `HlClient` takes a `transport` (`{request(endpoint, payload)}`) which the harness fills with plain fetch, or a recorder for offline signing.
- User-signed action nonce: `approveAgent`/`usdClassTransfer` use field `nonce`, `usdSend`/`withdraw3` use field `time`; the request body nonce equals that field. Typed-data primary types: `HyperliquidTransaction:{ApproveAgent,UsdSend,Withdraw,UsdClassTransfer}` (withdraw3's wire type is `withdraw3`, primary type `...:Withdraw`). Domain: `HyperliquidSignTransaction` v1, chainId = `parseInt(signatureChainId)`, zero verifyingContract. The harness table is checked against the Python SDK golden vectors (approveAgent, usdSend, withdraw3) in `validation/tests/harness.test.ts`.

## validation/
- `LIVE=1` gates everything that touches the network; live tests that spend money additionally need `LAB_WALLETS_PATH` (lab wallet file, indices 1-10 only; read from env or the gitignored repo-root `.env`). Without them `pnpm test` is green offline.
- Each claim test writes `validation/results/<id>.json` (`status` ✅/❌/⚠️, `numbers`, `refs`, `notes`). Blocked-on-input claims write ⚠️ "not run: reason" and skip.
- `@perps-platform/core` is aliased to the core source (no build step).
- Files contract-dev must produce (testnet, shape below). All consumed by `loadSignedActionFile`:
  - `contract/out/c2-approve-agent.json`
  - `contract/out/c3-usd-send.json`, `c3-withdraw3.json`, `c3-usd-class-transfer.json`
  ```json
  { "derivedAddress": "0x..", "action": { "type": "approveAgent", "hyperliquidChain": "Testnet",
      "signatureChainId": "0x66eee", "agentAddress": "0x..", "agentName": "hypernear", "nonce": 1700000000000 },
    "signature": "0x<65 bytes r||s||v>" | { "r": "0x..", "s": "0x..", "v": 27 },
    "meta": { "path": "...", "txHash": "..." } }
  ```
  Offline, the tests recover the signer from `action` + `signature` and compare it with `derivedAddress` (no key, no network).
- Self-check for C2 ("harness self-check", not C2): a local viem key signs ApproveAgent through core's `HlClient`, the body is captured and then submitted through the same `submitSignedAction` path as the contract artefact.
- Funding: lab wallet #1 is the funder (usdSend to fresh keys and derived addresses). C4/C5/C10 use fresh local keys as stand-ins for derived addresses (HL behaviour only). C11 (tests/c11-subaccounts.test.ts) uses lab wallet #10: raises volume to 100k with BTC IOC round trips (skipped if a subaccount exists or volume is met), createSubAccount, approves a fresh API wallet, and has it sign subAccountTransfer.
- On ci32 the wallet file lives at ~/secrets/lab-wallets.json (0600, indices 1-10 only, copied from the laptop outside git); jobs set LAB_WALLETS_PATH to it.
- HL testnet is reachable directly from ci32 (no proxy needed for these reads).
- Unverified until run live: funding amounts (5 to 25 USDC per leg), the 30 s balance-poll windows, whether a never-seen address can `approveAgent` before it holds funds (C10/C2 fund first).

## Live results so far (testnet, lab wallets; details in validation/results/*.json on the box)
- C2 OK: MPC-signed approveAgent (leash-spike-1107.testnet, test/leg0 -> agent 0x7bfc..c2c6) accepted; extraAgents lists it. Sign-and-poll ~15.8 s, ~12.1 TGas. The contract/out file's nonce goes stale, so the test re-signs on ci32 via `C2_SIGN_DIR=~/work/near_hck-contract` (needs near credentials there); `contract/out/` is gitignored, so copy the file to the box and set `C2_FILE_PATH`.
- C10 OK (local key and derived addresses): sending 20 USDC to a never-funded address credits 19 (1 USDC activation fee, taken from the credit); the first action then costs nothing extra.
- C4 OK: approved agent places and cancels (also on leg0 with the MPC-approved agent); the same agent on a second master is rejected ("Extra agent already used."), so one agent key per leg.
- C5 OK: with a $15 BTC long open, withdrawable 22.476 of 23.99 account value; usdSend of 22.47 succeeded.
- C11 OK, agent CAN sign subAccountTransfer: lab #10 raised volume to $108k in 3 BTC IOC round trips (~$28.6 of fees), createSubAccount, a fresh API wallet moved 1 USDC in and out.

## Strategies, first slice
- `agent/src/strategy/`: `spec.ts` (validation against order policy and contract policy, `checkOrder` gate), `grid.ts` (pure planner), `runner.ts` (one per leg: kill switch, daily-loss pause, freeze stop, dead-man arming), `manager.ts` (start/pause/stop, per-owner), `port.ts` (HL via the leg's agent key). Routes in `server.ts`: `POST /strategy/start|pause|stop`, `GET /strategies/:owner`, events `strategy.*` on `/events`.
- Owner-signed Commands carry the binding: `startStrategy` with `command.coin = specHash(spec)` (interim; a `specHash` field comes from contract-dev), `pauseStrategy|stopStrategy` with `command.coin = id`. The three actions were added to `CommandAction` in `packages/hypernear-client/src/commands.ts` (type only).
- HL `scheduleCancel` is wrapped in core (`HlClient.scheduleCancel`) and the runner arms it every tick, but the exchange refuses it until the account has traded $1,000,000 (C19, testnet too: "Required: $1000000. Traded: $0."). So it is non-fatal: the runner reports `strategy.deadman {armed:false}` once and goes on. Replacement for freeze: `Relayer.onBeforeRevoke` cancels every strategy's resting orders before the revocations are posted (only for freezes relayed through our relayer; a freeze posted by someone else still leaves resting orders until a fresh agent cancels them).
- Runners live in memory: a service restart forgets them and their resting orders (persist specs under dataDir next).
- Live run `agent/results/grid-live.json`: leg 3 funded $26 from lab #3 (usdSend), owner-approved agent, 5-level BTC grid centred on the mid, 4 USD apart: buys filled, a reduce-only sell was placed one level up and filled, pause cancelled 4 resting orders (none left two ticks later), stop with onStop flatten left the leg flat. Fills came from the live market, no counterparty. Equity 24.97 -> 24.96 (fees). Not shown live: freeze path (unit-tested only), guard top-up of leg 3.

## Strategies, second slice
- TWAP/DCA built-in (`type: "twap"`): `{side, sizePerSlice, slices 2-50, intervalSec 10-86400, limitPx}`; one IOC order per interval through the same `checkOrder` gate; a slice beyond `limitPx`, refused by the gate, or without a fill is skipped (not retried); the runner ends `done`. A sell's exposure above `limitPx` is only enforced at run time (validation uses `limitPx`). Live: `agent/results/twap-live.json` (4 BTC slices of 0.00015 on leg 3).
- Persistence: `<dataDir>/strategies.json` (0600; specs and progress, no keys). On start the service reloads every saved strategy PAUSED, cancels any order left on its leg, and emits `strategy.restored`. Resume = a new owner-signed `startStrategy` with the identical spec (hash match); a changed spec for a live id is refused. The live run restarts the manager in the middle of the TWAP: slice count and next-slice time survived, the orphan order was cancelled.
- Builder: `POST /strategy/draft {owner, text}` -> Claude Sonnet 5.5 (structured output, `builder.ts`) drafts, `validateSpec` decides; response `{ok, spec, specHash, diff, warnings}` or 422 `{errors, draft}`. The model is told to copy the user's numbers faithfully, so a request over a cap is refused with the validator's reason instead of being silently clamped. `agent/results/draft-live.json`: 2 drafts accepted, 4 refused (20x leverage, DOGE, $80 top-up over the $50 cap, off-topic). Needs `ANTHROPIC_API_KEY`; 3-9 s per draft.
- `specHash` is now a real `Command` field (contract-dev, merged 0e8ed1f); the `coin` stub is gone.

## Strategies, third slice
- Guard and strategies: the guard now takes a per-leg budget (`budgetLeftUsd`, `onTopUp`): a leg that runs a strategy is topped up only from the reserve leg (2) and only up to the strategy's `topUpCapPerDay` per UTC day (tracked in the runner, saved with it); the contract's own daily cap and cooldown still apply on top. A refused top-up shows up as `guard.trigger` with `plan.kind: "blocked"` and the reason ("strategy top-up budget used", "cooldown for N s"). Legs with no strategy behave as before.
- Demo 2 (`agent/results/demo2-live.json`): TWAP bot at 20x on leg 3; the owner moves the spare margin to spot; the guard tops leg 3 up $5 from leg 2 through `rebalance` (NEAR tx in the file); the second stress is refused by the budget; a direct `rebalance` above the contract's daily cap is refused by the contract. Thresholds are demo values: HL keeps about 10% of the notional non-withdrawable, so a 20x leg stripped of spare margin sits near 8x maintenance, never near the default 2x floor; the demo uses floor 10x and target 15x and says so in the file. Operator policy allowed 20x for this run (service default stays 5x).
- Known limit: the runner's daily-loss check compares equity with the day's first reading, so an owner moving money out of the leg (or the guard topping it up) looks like a loss (or a gain). A ledger of deposits and withdrawals would fix it. The decision facts inherit it (`dayPnl`).
- Strategy decision layer (`agent/src/strategy/decide.ts`): `proposeStrategyAction` gives `continue_strategy | pause_strategy | adjust_strategy` with the same Jev gate (0.90/0.10), Sonnet then Opus on a disagreement with the factor table, the safer action on a remaining disagreement, and "continue, flagged" when both models fail. Propose only: `decision.proposed` carries `kind: "strategy"` and `strategyId`; accept goes through `/decision/:id/accept` with a signed Command whose action is the proposal's action and coin the strategy's coin; accepting pause or adjust pauses the strategy (adjust then needs a new draft and a signed start), continue just closes the proposal. `POST /decision/propose {owner, strategyId}` asks for one now; the periodic timer announces only proposals that are not "continue" or are flagged.
- Builder e2e (`agent/results/builder-e2e-live.json`, `strategy-decision-live.json`): a real `node agent/src/server.ts` process on a random port; `/strategy/draft` (Claude) -> signed `startStrategy` (a spec changed after signing is refused 401) -> 4 TWAP slices -> `/decision/propose {strategyId}` -> `decision.proposed` kind strategy (Sonnet settled the undecided factors: continue) -> signed accept -> signed stop with flatten. On ci32 `packages/hypernear-client` needs `pnpm build` after a pull (the server imports its dist), and other jobs on the box run servers, so scripts must not use a fixed port.
- Facts caveat: the strategy decision facts reuse the hedge margin buckets ("far" = over 6x maintenance), so in Demo 2 the proposal said "continue" while the demo guard (floor 10x) was already topping the leg up. Strategy-specific buckets would fix it.
