# Notes for the README

## Freeze

`freeze` is one owner-signed intent that anyone can relay. It does two things:

1. **It stops contract-signed actions.** The contract refuses everything except the owner's withdraw (to the owner's own
   address) and unfreeze. That includes agent rebalances, transfers, setPolicy and new agent approvals.
2. **It revokes Hyperliquid trading keys.** The contract remembers every agent name it ever approved on the owner's legs.
   In the same NEAR transaction, it MPC-signs one `approveAgent` per name that points the name at a keyless burn address:
   `keccak256("leash-burn:" + leg path)`, one address per leg, because HL will not accept one agent address on two
   masters. The relayer posts these signed actions to HL. HL replaces an agent when the same name is approved again,
   so the old API wallet's next order is refused. This is tested live in `agent/tests/freeze.live.test.ts`
   (`agent/results/freeze-live.json`).

Limits, stated plainly:

- Orders that are already resting stay on the book until someone cancels them.
- The revocation reaches HL only when the signed actions are posted. Anyone can post them, because they are in the
  transaction's return value.
- Unfreezing approves nothing. The owner approves fresh agents, and revoked keys are never approved again.
- The contract tracks at most 8 agent names per owner. That cap is what lets a freeze fit in a single 300 TGas
  transaction.
