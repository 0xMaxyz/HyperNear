# @perps-platform/core

Stripped baseline of PerpX `packages/core` (source: `maxperp/hl` commit `ef5845387a2ba88cfd854ac438e821352dc743c0`).
Kept: `hl/HlClient` and its import closure (`hl/types`, `hl/handshake`, `hl/agent-name`, `hl/pricing`,
`hl/priority`, `hl/assetIndex`, `hl/testOnlyRawKeySigner`), `client/relay-rejection`, `adapters/types`, and the
pure liquidation helpers in `liquidation.ts` (extracted from `client/market-data.ts`).
