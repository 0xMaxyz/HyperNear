# Phase 2: strategies on the HyperNear primitive (design)

Status: design only, branch `phase2`. Nothing here is built. Goal: demo 2 of the primitive, "one account per bot with capped top-ups": every strategy runs on its own leg, so its losses stay on that leg, the contract's cap and cooldown bound how much the margin guard can top it up, and `freeze` stops all of it.

## 1. Strategy spec

One JSON object, validated by one JSON Schema (`agent/src/strategy/schema.json`, checked with `ajv`) plus a few cross-field rules in code (e.g. `lower < upper`).

```json
{ "id": "grid-btc-1", "type": "grid", "leg": 3, "coin": "BTC",
  "params": { "lower": 70000, "upper": 80000, "levels": 10, "sizePerLevel": "0.0002" },
  "limits": { "maxNotional": 200, "maxLeverage": 3, "maxDailyLoss": 15, "topUpCapPerDay": 30 },
  "onStop": "cancel" }
```

- `type` is `grid`, `twap` (also DCA) or `carry`; `params` is a different shape per type.
- Limits can only tighten the existing order policy (`maxLeverage` 5, `maxNotional` $100 per order, allowed coins in `agent/src/config.ts`), never loosen it.
- `topUpCapPerDay` is an off-chain budget for the guard. The contract's daily cap is per owner and shared by all legs, so the sum of the budgets must be at most that cap (checked when a spec is accepted).
- Leg numbers: the agent scans legs 0 to 3 today (`MAX_LEGS`), the hedge pair uses 0 and 1, the reserve is 2. The contract tracks at most 8 agent names per owner (that bounds a freeze to one transaction), so 8 legs is the ceiling; raising `MAX_LEGS` to 8 costs a few more `get_leg` reads.

## 2. Runtime

- **One runner per strategy**, one tick loop (10 s, like the guard), using that leg's existing HL API key (`AgentKeyStore`). State in `<dataDir>/strategies.json`; orders carry a client order id so a restart resumes instead of duplicating.
- **Every order goes through one pure function** `checkOrder(spec, policy, state)`: order policy first, then the spec's limits (notional including resting orders, leverage, daily loss). A refusal is logged, never sent.
- **Daily loss limit:** when equity falls more than `maxDailyLoss` below the day's start, the runner pauses, cancels resting orders and (per `onStop`) flattens reduce-only. This needs no signature because it only reduces risk.
- **Kill switch:** `POST /strategy/:id/stop` and `/pause`, owner-signed `Command`s (same verifier and replay cache as `/hedge/open`). `freeze` revokes the leg keys, so every runner also stops when it sees `agents.revoked` or an HL "not an approved agent" error.
- **Known limit, same as the hedge:** orders already resting (a grid ladder) stay on the book after a freeze, because the revoked key can no longer cancel them. Mitigations: the runner cancels before a normal stop; a grid is capped at `levels` orders; the owner approves a fresh agent to cancel after a freeze; and HL's `scheduleCancel` (a dead-man switch that cancels all orders at a given time unless refreshed) looks like the right tool, but core does not wrap it yet (about 1 h; to be confirmed on testnet).
- **Margin guard:** unchanged logic, but it must (a) scan all strategy legs, (b) take a configured reserve leg as the source, and (c) never take margin from a leg that runs a strategy with an open position. Events (`strategy.started`, `strategy.order`, `strategy.refused`, `strategy.paused`, `strategy.stopped`) go to the existing `/events` stream.

## 3. Built-ins, simplest first

1. **Grid.** A ladder of post-only limit orders between `lower` and `upper`; when one fills, place the opposite order one level away. Polls `openOrders` and `userFills` each tick (no websocket needed). Stops and cancels if price leaves the range. In a trend it builds one-sided inventory, bounded by `maxNotional` and `maxDailyLoss`.
2. **TWAP and DCA.** TWAP uses Hyperliquid's native `twapOrder` (core already has `twapOrderOpen`). DCA is a timer: one marketable limit order per interval until `totalNotional` is reached.
3. **Spot-perp funding carry on one leg.** Feasibility, checked against HL testnet today: our legs are in HL's `default` account mode (`userAbstraction` of leg 0 returns `"default"`). In that mode one address holds spot balances and perp positions at the same time, with separate margin, so a leg can hold spot long plus perp short; it needs USDC on both sides. The agent can only move spot to perp (contract rule), so the owner splits the funding up front with `usdClassTransfer`. It does not need unified or portfolio margin. **Testnet problem:** spot books are thin or mispriced (BTC/USDC spot quotes 1.0, UETH/USDC 0.001); the only usable pair is PURR/USDC spot (4.58) against the PURR perp (4.41) at about $3.8k daily volume, so a live run is a small size on PURR. Logic: enter when predicted funding, net of fees, beats a threshold; keep spot size equal to perp size within a drift band; exit when funding falls below the threshold. A 1-hour spike confirms the spot order path (asset index 10000 + pair index) before any build.

## 4. Strategy builder (plain language to spec)

1. The owner writes rules. Claude (Sonnet 5.5, structured output with the spec JSON Schema as the format, same pattern as `validation/src/claude.ts`) returns `{spec, assumptions[]}`.
2. `validateSpec(spec, ownerState)` checks the schema, the order policy, that the leg is registered and free, and that the budgets fit the contract cap. Errors go back to Claude for one repair attempt; otherwise the user sees the error.
3. The UI shows the spec as a diff against the previous spec (or empty), a plain-language summary and the worst case (`maxNotional`, `maxDailyLoss`).
4. The owner signs a `Command` `strategy.start` that binds the spec by hash (a new `specHash` field in the existing command type, so `packages/hypernear-client` and the web signer change by a few lines). **No auto-start.** Free text only ever produces a proposal; the contract and the signature are the backstop, as in the injection demo.

## 5. Decision layer for running strategies

Reuse the Jev to Claude pipeline (`decideByFactors`, `proposeAction`) with a new action set, `continue | pause | adjust | stop`, and factors such as "is price outside the assumed range", "is the loss near the daily limit", "has funding flipped". Propose mode only: the proposal appears on `/events` as `decision.proposed` and the owner accepts with a signed command. Measured on the existing layer, Jev is rarely decisive at the 0.90 gate, so in practice Claude decides, at 2 to 9 s per proposal. To keep cost flat the check runs only when a trigger fires (price moved by a set amount, or a limit is over half used), not on a fixed timer.

## 6. Cost, tests and cut lines

| Piece | New code | Reused | Hours | Test | Cut line |
|---|---|---|---|---|---|
| Spec, schema, `validateSpec`, `checkOrder` | all | `OrderPolicy`, config | 5 | JSON fixtures: valid, invalid, each limit | never cut |
| Runner, state, endpoints, kill switch, events | runner, `/strategy/*` | `Legs`, key store, `commands.ts`, `EventBus`, `market.ts` | 10 | fake HL transport; dry-run replay | never cut |
| Guard for strategy legs | scan 8 legs, reserve leg | `guardLoop.ts`, `guard.ts` | 3 | existing guard fixtures plus one new | never cut |
| Grid | planner, fill handling | order helpers in `hedge.ts` | 6 + 2 live | fill-sequence fixtures; 1 testnet run | keep |
| TWAP and DCA | slicer | `twapOrderOpen` | 4 + 1 live | slice-plan fixtures; 1 testnet run | keep (drop the live run first) |
| Carry | spike, entry/exit logic, spot orders | funding reads in `market.ts` | 1 + 8 + 3 live | funding-series fixtures; 1 PURR testnet run | **cut first** |
| Builder | prompt, repair loop, diff, `specHash` command | `claudeEscalator` pattern, `commands.ts` | 9 | recorded Claude outputs as fixtures; 1 live call | keep |
| Strategy decisions | action set, triggers | `decide.ts` | 6 | fakes as in `propose.test.ts` | cut second |
| Web: strategies panel, builder box, diff, sign, stop | panel | current page, signer | 12 | existing Playwright checks | thin version first |
| README and docs | addendum | | 3 | judge-path run on a fresh clone | |

Total about 73 h with everything. **Thin slice (about 44 h):** spec, runner, guard, grid, TWAP/DCA, builder, a minimal strategies list in the web page. Drop carry, then the strategy decision layer, then the live TWAP run, in that order. Each built-in gets one live testnet run recorded in `validation/results/` like the Phase 1 claims.

## 7. Open question for the user: a full terminal UI

PerpX's UI is large: `packages/ui` is 545 files (6.4 MB) and `apps/web` 794 files (19 MB). Its data hooks call PerpX's `apps/api` (346 files) and use `PerpsClient`, `SdkManager` and stores from core, which we deleted in the baseline strip.

| | Reuse PerpX UI | Extend our page |
|---|---|---|
| What is needed | restore the deleted core parts and `api-client`; either an agent shim that speaks PerpX's API or new data hooks; Privy and agent-key wiring; build fixes | add a candlestick chart (`lightweight-charts`, one dependency), positions and orders per leg from HL info, strategies panel |
| Estimate | 35 to 50 h, high risk | 10 to 16 h |
| Disclosure | several MB more baseline code outside the NEAR integration, which is not judged | all new code, built in the window |
| Result | a full terminal: order book, charts, trading panels | a lighter view without order-book depth |

Recommendation: extend our page, and pick up a self-contained PerpX component (for example its chart) only if it turns out to be standalone (about 1 h to check). The terminal does not change the security story, and the strategies panel is what the demo needs.
