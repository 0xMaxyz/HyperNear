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
