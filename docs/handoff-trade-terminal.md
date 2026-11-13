# Handoff: pro trading UI (branch `feat/trade-terminal`)

State on 2026-11-11, so the work can continue in a local session. Everything below is committed and pushed.

## Branches

```
main
 └─ feat/session-keys-dark-theme   0dfcca3  1-click session keys + dark default theme
     └─ feat/trade-terminal        070a044  everything below (contains the commit above)
```

`feat/trade-terminal` already contains `feat/session-keys-dark-theme`, so one PR from `feat/trade-terminal` into `main` covers both. No PR is open yet. The design reference (desktop terminal, ticket states, two phone screens) is the private Design canvas "HyperNear Trade Terminal" on claude.ai.

```
git fetch origin feat/trade-terminal
git switch feat/trade-terminal
pnpm install
```

## What was built (commits, oldest first)

| Commit | What |
|---|---|
| `0dfcca3` | **1-click trading sessions.** The owner signs one `startSession` command naming a browser-made key (15 min to 24 h, optional caps). The agent then also accepts order commands signed by that key, for that owner only, inside the order policy narrowed by the caps. The key can never start a session or sign anything else. Sessions are in agent memory only and end on expiry, `endSession`, freeze, TEE switch or restart. **Dark theme becomes the default**; the paper palette is `data-theme="light"`. |
| `5db4149` | **Trade terminal layout** with live Hyperliquid data over WebSocket (book, trades, candles, asset context). Market bar, chart with each leg's lines, order book (click a price to fill the ticket), blotter, leg account with margin health. |
| `5dc6291` | **Ticket rewrite** (`web/src/ticket.tsx`): leverage/margin chips, Single / Hedge modes, Market / Limit / Pro tabs, size in coin or USD with a slider, attached TP/SL, policy errors with fixes. **Agent:** market/limit specs may carry `tpPx`/`slPx`, placed as one `normalTpsl` group. |
| `757fe94` | **Navigation:** 9 tabs became 5 (Trade, Portfolio, Strategies, Fund, Protect). Setup, Activity and Learn are reached from the top bar. Old links (`#/home`, `#/overview`, `#/legs`, `#/hedge`) redirect. The top bar has guard status, the activity bell and Freeze all. |
| `9da0284` | **Phones:** bottom nav, Chart / Book / Trades switch, Buy/Sell bar opening the ticket as a sheet, position and order cards. |
| `60868bd` | **Power features:** `modifyOrder` (agent + client): drag a resting limit order's line on the chart, confirm the new price, and the agent uses Hyperliquid's in-place modify (same oid, size, cloid). Keyboard shortcuts (B/S, M/L, F, Ctrl/⌘+Enter, Esc, ?). Layout presets (Standard, Chart focus, Book left). |
| `070a044` | README: attached TP/SL and order modify. |

## Where things live

**Agent**
- `agent/src/sessions.ts`: session store, spec checks, policy narrowing.
- `agent/src/commands.ts`: `verifySessionCommand`. `verifyCommand` stays owner-only.
- `agent/src/order.ts`: attached TP/SL validation, `validateModifySpec`.
- `agent/src/orders.ts`: `normalTpsl` placement, `modify`.
- `agent/src/server.ts`: routes `/session/start`, `/session/end`, `GET /sessions/:owner`, `/order/modify`. `/owner` now lists live sessions.
- `agent/src/dryBook.ts`, `agent/src/dryrun.ts`: dry-run support for all of the above.
- Tests: `agent/tests/sessions.test.ts` (new) and additions to `agent/tests/order.test.ts`.

**Client:** `packages/hypernear-client/src/session.ts` (new). `commands.ts` gained the actions `startSession`, `endSession` and `modifyOrder`.

**Web**
- `web/src/market.ts`: Hyperliquid WebSocket feed.
- `web/src/terminal.tsx`: market bar, chart (drag), book, blotter, leg account, layouts.
- `web/src/ticket.tsx`: the ticket.
- `web/src/trade.tsx`: the terminal grid, phone sheet, shortcuts, the move-order confirm.
- `web/src/session.tsx`: `useSession` and the 1-click control.
- `web/src/App.tsx`: navigation, top bar, bottom nav, Protect / Setup / Portfolio pages.
- `web/src/styles.css`: tokens at the top, terminal / ticket / phone / power sections at the end.

## Run and check

```
pnpm -C packages/core build && pnpm -C packages/hypernear-client build   # the agent imports their dist at runtime
cd agent && npx tsc --noEmit && npx vitest run                        # 427 pass, 9 skipped (live tests)
cd web && npx tsc --noEmit && npx vite build

# dry run: fixtures, no keys, no network for account data
HYPERNEAR_DRY_FIXTURE=hedged PORT=8787 node agent/src/server.ts --dry-run --serve
cd web && npx vite            # open http://localhost:5173, "Explore recorded data", #/trade
```

- **Market data in the dry run:** it shows recorded candles and says the book is live only.
- **Seeing the live feed against the dry run:** have the browser strip `dryRun` from the `/owner` response and set `config.hlNetwork` to `mainnet`. The Playwright `page.route` trick used during the session did exactly this.
- **Login:** needs `VITE_PRIVY_APP_ID` in `web/.env.local`. Without it the page is read-only.

## Not verified yet (do these before relying on them)

1. **Testnet: market order with TP/SL.** Attempted 2026-11-11: testnet was in L1 congestion ("Only post-only orders allowed"), so the group was refused; retry with `agent/scripts/terminal-live.ts`. Check that the `normalTpsl` group places, the two triggers show in Open orders, and they close the position. It's covered only by unit and dry-run tests.
2. **Testnet: drag-move a resting limit.** **Done 2026-11-11 (lab wallet):** `modifyOrder` keeps size, side, `tif` and cloid but the exchange assigns a NEW oid; `frontendOpenOrders` does return `tif`.
3. **Logged-in 1-click flow in a browser.** Login wasn't possible in the session. Check turning it on (one wallet signature), placing orders with no popup, Turn off, and that a freeze ends it.
4. ~~Live order modify needs `tif`.~~ Confirmed present (`"tif":"Alo"`), so a post-only order stays post-only after a move.

## Round 3 (13 Nov 2026): what changed and what is still open

- Built and tested (ci32 unit tests, `web/e2e/round3.mjs` dry-run e2e, live testnet for the hedge pair and Easy trading drafts): atomic-ish hedged open (`placeHedge`, `/hedge/pair`), leverage that follows the market, fee components, Easy trading (`/trade/draft`), live positions over one Hyperliquid socket.
- Reviewed twice by the Fable 5.2 advisor; every MUST item was fixed (lost replies settled by positions, no percent clamping, one pair per owner, socket Live only after data, leverage default stays 5 with `HYPERNEAR_MAX_LEVERAGE=100` set explicitly on ci32).
- Not verified: the socket on a real browser with a logged-in wallet (the dry-run e2e disables it); whether `openOrders` pushes periodically (the page only refetches when the orders differ); `builderFee` inside `fee` (our agent sets no builder code, so it is 0); 1-click with the hedge box ticked; the Easy tab with real mainnet markets; hedge pair on mainnet.
- Known limits: the chat daily budget and per-owner limit can be spent by anyone who names an opted-in owner (the `owner` field is not authenticated; fine for the testnet demo, sign the draft request with a session key before mainnet); hedges use legs 0 and 1 only (the decision layer also assumes leg 0 long, leg 1 short); two tabs use two of the ten sockets.

## Known gaps and next steps

- **Old end-to-end scripts:** `web/e2e/*.mjs` still use the old tab names (`#/home`, `#/hedge`) and the old ticket fields ("Order type" select, "Sign and send"). Update the selectors before running them.
- **Dragging covers plain limit orders only.** Stop, take-profit, TP/SL and trailing lines are not draggable. Trigger orders would need `triggerPx` in `ModifySpec`.
- **Old sessions lack the modify action.** Sessions started before `60868bd` don't include `modifyOrder`, so moving an order asks the wallet until 1-click is turned on again.
- **Phone scope:** the phone layout covers Trade fully. Portfolio, Strategies and Fund use the existing pages with the new bottom nav.
- **Leftover state in `App.tsx`:** the old hedge-tab state (`coin`, `ratio`, `lev1`, `margin1`, `hedgeSpec`) is still there. `hedge()` is used for "Close hedge"; the open path through it is now unused and could be removed.
- **Chart color tokens:** the legacy `LegPanel` and `OverviewTab` charts still use the older `--ok` / `--accent` colours. Switch them to `--buy` / `--sell`.

## Decisions made with Max (keep them)

- **Theme:** dark is the default.
- **Session keys:** yes, kept off-chain in the agent. No contract change.
- **Where the key lives:** the browser key goes in `sessionStorage`, which is per tab and gone when the tab closes. This tradeoff is documented in the README.
- **Hedges always use the wallet:** 1-click covers single orders, cancels and moves only.
