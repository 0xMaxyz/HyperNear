# Strategies on the HyperNear primitive

Status: built and run on testnet. Goal, demo 2 of the primitive, "one account per bot with capped top-ups": every strategy runs on its own leg, so its losses stay on that leg, the contract's cap and cooldown bound how much the margin guard can top it up, and `freeze` stops all of it. Everything is in `agent/src/strategy/`; evidence is in `agent/results/`.

## What was built

| Piece | Where | Evidence |
|---|---|---|
| Spec and validation against the order policy and the contract policy; `checkOrder` gate for every order | `spec.ts` | fixture tests (`strategy-spec.test.ts`, 44 cases) |
| Grid (long-only ladder of post-only buys, reduce-only sells one level up) | `grid.ts`, `runner.ts` | [`grid-live.json`](../agent/results/grid-live.json) |
| TWAP / DCA (one IOC order per interval, `limitPx` cap, skipped slices are not retried) | `runner.ts` | [`twap-live.json`](../agent/results/twap-live.json) (includes a service restart in the middle) |
| Runner per leg: kill switch, loss limit, freeze stop, dead-man attempt, restart | `runner.ts`, `manager.ts` | unit tests with a fake exchange |
| Strategy builder (plain language to spec) | `builder.ts`, `POST /strategy/draft` | [`draft-live.json`](../agent/results/draft-live.json), [`builder-e2e-live.json`](../agent/results/builder-e2e-live.json) |
| Strategy decisions (pause / continue / adjust, propose only) | `decide.ts`, `facts.ts`, `decisions.ts` | [`strategy-decision-live.json`](../agent/results/strategy-decision-live.json), [`strategy-decision-losing-live.json`](../agent/results/strategy-decision-losing-live.json) |
| Guard for strategy legs (reserve leg, per-strategy budget) | `guardLoop.ts` | [`demo2-live.json`](../agent/results/demo2-live.json) |

**Spec.** One JSON object: `{id, type: "grid" | "twap", leg, coin, params, limits {maxNotional, maxLeverage, maxDailyLoss, topUpCapPerDay}, onStop: "cancel" | "flatten"}`, validated by hand-written code in `spec.ts` (no schema library: unknown fields are errors, every error is listed). Limits can only tighten the order policy. Legs 0 to 2 are reserved (hedge pair and guard reserve). The owner signs a `startStrategy` Command whose `specHash` field is the sha256 of the canonical spec; the server compares it with the spec it received, so a changed spec does not start.

**Runtime.** One runner per strategy, ticking every 15 s (5 s in the live runs), trading with the leg's own HL API wallet.
- Every order goes through `checkOrder`: order policy first (coin, notional, minimum $10), then the spec's limits (exposure including resting orders, price range). A refusal is an event, never an order.
- Loss limit: `maxDailyLoss` is checked against the strategy's own PnL (`pnl.ts`: fills since the start, positions at mark, funding), never against equity, so a guard top-up is not a gain and an owner transfer is not a loss. It is counted since the start, not reset each day.
- Kill switch: owner-signed `pauseStrategy` / `stopStrategy`. A pause or stop that cannot clear the book enters `cancelling` and retries every tick (`strategy.cancel_failed`). `onStop: "flatten"` also closes the position.
- Freeze: the relayer calls `onBeforeRevoke`, which cancels every strategy's resting orders before the revocations are posted (8 s bound). A frozen strategy can be resumed after the owner unfreezes and approves a fresh agent key.
- Restart: specs and progress are saved to `<dataDir>/strategies.json`. On start every saved strategy comes back paused, orphaned orders on its leg are cancelled (`strategy.restored`), and the owner resumes it with a signed `startStrategy` over the stored spec (`POST /strategy/resume`).
- Events `strategy.*` (all carry `owner`, `id`, `leg`) go to the existing `/events` stream.

**Dead-man switch.** HL's `scheduleCancel` is wrapped in core (`HlClient.scheduleCancel`) and the runner arms it every tick, but the exchange refuses it until the account has traded $1,000,000 (claim C19, testnet too). The runner reports `strategy.deadman {armed:false}` once and goes on. So a crashed agent leaves at most `levels` resting grid buys until it restarts; restore then cancels them.

**Guard for strategy legs.** A leg that runs a strategy is topped up only from the reserve leg (2), only within the strategy's `topUpCapPerDay`, and only if the strategies' budgets leave the hedge guard its share of the contract's daily cap (`hedgeReserveUsd`, default $20, at most half the cap). The contract's own cap and cooldown still apply on top.

**Builder.** Claude Sonnet 5.5 with structured output drafts a spec from the owner's text and the facts it is given (mids, policy, free legs, existing strategies). It is told to copy the owner's numbers faithfully: a request over a cap is refused by `validateSpec` with the reason, not silently clamped. The response is `{spec, specHash, diff against the running strategy, warnings}`, or 422 `{errors, draft}`. Nothing starts without the owner's signed start. A grid drafted by the builder defaults to `onStop: "flatten"`; a TWAP/DCA to `"cancel"` (it keeps what it bought).

**Strategy decisions.** Same machinery and gate as the hedge decisions: Jev answers five yes/no questions (near liquidation, losing, top-up budget used up, price off plan, volatile) in one request; decisive answers (at least 0.90 or at most 0.10) go through a small table; undecided ones go to Sonnet, then Opus if Sonnet disagrees with the table; a remaining disagreement takes the safer action. The facts are the strategy's own buckets (PnL against the loss limit, share of the top-up budget used, fill rate, slices left, distance to liquidation), not the hedge's margin buckets. Propose only: `decision.proposed` with `kind: "strategy"`; accept goes through `/decision/:id/accept` (pause and adjust pause the strategy, continue closes the proposal).

## Demo 2, as run

[`demo2-live.json`](../agent/results/demo2-live.json): a TWAP bot at 20x on leg 3 with a $5 daily top-up budget. The owner moved the leg's spare margin to spot; the guard moved $5 from leg 2 to leg 3 through the contract's `rebalance` (NEAR tx in the file); a second stress was refused by the guard ("strategy top-up budget used"); a direct `rebalance` above the contract's daily cap was refused by the contract ("daily cap exceeded"). Thresholds were demo values: HL keeps about 10% of the notional non-withdrawable, so a 20x leg stripped of spare margin sits near 8x maintenance, never near the default 2x floor; the run used a guard floor of 10x and an operator max leverage of 20x (the default stays 5x).

## Cut

- **Funding carry** (spot long plus perp short on one leg): not built. Feasibility was checked (legs are in HL's `default` account mode, so one address holds spot and perp), but the agent can only move spot to perp, so entry would need an owner-signed step; it was the first item on the cut list.
- **Native `twapOrder`:** TWAP/DCA is a timer of IOC orders, which needs no extra signing path and is easier to bound with `checkOrder`.
- **A full terminal UI:** the web page was extended instead (leg chart, positions and orders, strategies panel). Reusing PerpX's UI would have added several MB of baseline code outside the NEAR integration.

## Known limits

- No exchange-side dead-man below $1M volume (above). A freeze posted by someone other than our relayer still leaves resting orders until a fresh agent cancels them.
- Runners are in memory between restarts except for the saved specs: a restart pauses everything until the owner resumes.
- The loss limit counts PnL since the start of the strategy, not per UTC day; unrealized PnL assumes the leg started flat.
- `/strategy/draft` and strategy proposals are unauthenticated and spend model credits; they are rate-limited per IP.
