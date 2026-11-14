# Unified accounts

Every leg is a Hyperliquid account, and Hyperliquid has an account mode called **unified account**: one USDC balance that is both the spot balance and the margin for perps. HyperNear converts its legs to it with the leg's own agent key, and the agent, the contract and the page know how a unified leg behaves.

## What Hyperliquid does (measured on testnet, 2026-11-14)

Scripts: `agent/scripts/unified-spike.ts` and `unified-spike2.ts`. Each run uses a new throwaway wallet funded from a lab wallet, so no live leg changed mode.

| | default mode | unified account |
|---|---|---|
| Where a credit lands | perp balance (`withdrawable` = all of it) | spot balance |
| `clearinghouseState` | the money | not the money: `withdrawable` 0, `accountValue` about twice the margin |
| Money is | `accountValue` + spot | spot USDC `total`; `hold` is the part reserved as margin |
| `agentSetAbstraction("u")` by the agent key | accepted, **also with a position open** | already unified |
| Switching back (`"i"`) | | **refused**: "Abstraction transition not allowed" |
| Orders, leverage, cancels | work | work (margin comes from the spot balance) |
| `usdSend` | works | **refused**: "Action disabled when unified account is active" |
| `spotSend` | works | **refused**, same message |
| `usdClassTransfer` | works | **refused**, same message |
| `sendAsset` spot to spot (USDC) | n/a | **works** |
| `sendAsset` from a perp dex | | refused: "Unified account only supports sending assets through spot" |
| `withdraw3` | works | works |

So conversion is one-way, and it breaks the contract's leg-to-leg move (`rebalance` signs a `usdSend`).

## What HyperNear does about it

- **One balance model.** `agent/src/funds.ts` rewrites a unified leg's clearinghouse view where the snapshot is built: `accountValue` = spot USDC total, `withdrawable` = total minus hold, `spotUsdc` = 0. The guard, the hedge margin check, the Fund tab and the live overlay then read the same fields as before. The margin ratio uses HL's own basis for unified accounts (spot total against maintenance margin).
- **Moves between legs.** The contract's agent method `rebalance` takes an optional `spot` flag; with it, it signs a spot USDC `sendAsset` (spot to spot, the network's USDC token, no sub-account: all fixed in `HlAction::SendAsset::digest`) instead of a `usdSend`. It is the same method, so the agent's access key (limited to `rebalance` and `agent_usd_class_transfer`) and every owner's policy keep working, and the daily cap, the cooldown and the own-legs-only destination rule are the same. `sendBetweenLegs` (`agent/src/transfer.ts`) picks the method by the leg's mode; money never moves between a unified and a default leg.
- **Conversion.** `Legs.convertToUnified` converts an approved, funded leg that is still in default mode, with its own agent key and no owner signature. The guard loop runs it for every watched owner **only when `HYPERNEAR_CONVERT_UNIFIED=1`**: it is off by default because it cannot be undone and it changes how balances show on live legs. A refusal is reported on the event bus (`legs.unified.failed`) and retried after 10 minutes.
- **Dry run.** `HYPERNEAR_DRY_UNIFIED=1` makes the dry-run legs unified: one balance, `usdClassTransfer` refused.

## Checked live on testnet (2026-11-14)

`agent/scripts/rebalance-live.ts`, through the redeployed contract (`leash-spike-1107.testnet`, state and leg addresses kept) with a throwaway owner and two new legs:

- the owner signed `setPolicy` and two `approveAgent` intents; two lab wallets funded the legs (14.00 and 4.00 USDC after Hyperliquid's activation fee);
- `Legs.convertToUnified` converted both legs with their own agent keys: `converted`, then `unifiedAccount` on the next read, balances unchanged and shown through the normalized view;
- the owner's rebalance to 50/50 ran as one move: the agent called `rebalance` with `spot: true`, the MPC key signed a `sendAsset`, Hyperliquid accepted it, and the legs ended at 9.00 and 9.00.

## Not built

- **Master-key conversion** (`userSetAbstraction`, signed by the leg through the contract). The agent-key path worked in every case tested, including with a position open, so it was not needed. If Hyperliquid refuses the agent path somewhere (mainnet has not been tried), the contract would need an owner intent and an `HlAction::UserSetAbstraction` with the type `HyperliquidTransaction:UserSetAbstraction(string hyperliquidChain,address user,string abstraction,uint64 nonce)`.
- **Mainnet.** Nothing here was run on mainnet. The mainnet USDC token id in the contract was read from `spotMeta`, but `sendAsset` from a unified mainnet account is untested, and the mainnet contract is locked, so the `spot` flag needs a new contract there.
- The activation fee on a `sendAsset` credit to a never-seen account is assumed to match `usdSend` (1 USDC, sender pays). Unmeasured.
