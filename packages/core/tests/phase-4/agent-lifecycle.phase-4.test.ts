/**
 * Phase 4 — Epic 4.3.3: agent lifecycle (expiry re-approval, MAX_AGENTS cap,
 * compromise rotation).
 *
 * Hyperliquid imposes three facts on approved agents, all already visible in
 * `PerpsClient`:
 *
 *  - agents **expire** — each `extraAgents` entry carries a `validUntil`, and
 *    the platform re-approves once it is <24h from lapsing;
 *  - accounts are **capped** at `PERPS_MAX_AGENTS` named agents, with
 *    delete-oldest making room — but only ever among agents WE registered
 *    ([#928]): the cap is per Hyperliquid account and shared with every other
 *    app the account's wallet uses, so "the oldest" can be a stranger's;
 *  - the passkey-derived agent address is **deterministic**, so routine expiry
 *    re-approves the *same* address (one master step-up); only a **compromise**
 *    forces a new address, by bumping the agent salt version (`v1`→`v2`).
 *
 * What is pinned here, against a recorded-response model of Hyperliquid's agent
 * registry (named-agent slots, same-name replace-on-approve, delete-by-name):
 *
 *  - the pure decision core (`isAgentExpiring`, `selectOldestAgent`,
 *    `planAgentApproval`, `nextSaltVersion`) — the same decision the client
 *    makes inline;
 *  - AC1 expiry clock control: crossing the <24h window re-approves the SAME
 *    deterministic address with exactly one step-up; a still-valid agent spends
 *    no ceremony;
 *  - AC2 cap overflow: a registry full of OTHER apps' agents refuses rather than
 *    revoking one of theirs; a named slot we already hold is replaced, not
 *    deleted, so the cap is never in the way for a returning session;
 *  - AC3 compromise rotation: a salt bump yields a NEW deterministic address,
 *    approves it, and removes the old agent; the manager then tracks `v2`.
 *
 * References: docs/roadmap/04-passkey-signing.md — Epic 4.3 (4.3.3);
 * docs/roadmap/reference-passkey-signing.md — "Agent lifecycle".
 */
import { describe, it, expect, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import {
  AgentLifecycleManager,
  AGENT_EXPIRY_REAPPROVAL_WINDOW_MS,
  deriveAddress,
  findAgentByAddress,
  ForeignAgentCapError,
  findAgentByName,
  isAgentExpiring,
  nextSaltVersion,
  planAgentApproval,
  prfSalt,
  selectOldestAgent,
  CURRENT_SALT_VERSION,
  PERPS_AGENT_NAME,
  PERPS_MAX_AGENTS,
  type AgentLifecycleOps,
  type ExtraAgent,
  type HexAddress,
} from '@perps-platform/core';

const RP_ID = 'perps.example';
const DAY = 24 * 60 * 60 * 1000;
const AGENT_VALIDITY_MS = 180 * DAY;

/**
 * A deterministic stand-in for a WebAuthn authenticator's PRF: output is bound
 * to the credential seed AND to the tier salt, so re-deriving under the same
 * salt version reproduces the identical EOA (routine expiry) while a bumped
 * version (`v1`→`v2`) yields entirely fresh key material (compromise rotation).
 * Runs the real `prfSalt` + `deriveAddress` pipeline — not a shortcut.
 */
function fakeAuthenticator(credentialSeed: string) {
  const seedBytes = new TextEncoder().encode(credentialSeed);
  return (saltVersion: number): HexAddress => {
    const salt = prfSalt(RP_ID, 'agent', saltVersion);
    const prfOutput = sha256(new Uint8Array([...seedBytes, ...salt]));
    return deriveAddress(prfOutput);
  };
}

/**
 * Recorded-response model of Hyperliquid's agent registry: named-agent slots,
 * approve replaces the same-named slot, delete unregisters by name. Records
 * every approve/delete so the lifecycle's on-chain effects are assertable.
 */
class FakeHyperliquid {
  agents: ExtraAgent[] = [];
  readonly approveCalls: Array<{ address: HexAddress; name: string }> = [];
  readonly deleteCalls: Array<{ address: HexAddress; name: string }> = [];

  constructor(private readonly clock: () => number) {}

  seed(agents: ExtraAgent[]): void {
    this.agents = agents.map((a) => ({ ...a }));
  }

  /**
   * The name is the primary key: approving ANY address under an existing name
   * replaces that name's entry rather than consuming another of the three.
   *
   * **VERIFIED against Hyperliquid testnet on 2026-08-12** ([#933], walk record
   * on PR #978) — until then this line was the codebase's central unmeasured
   * assumption, and `planAgentApproval` would have been wrong for both auth
   * methods had it failed. Measured, from the shipped UI:
   *
   *   before  [{"name":"perps-platform","address":"0x1879…33b7", …}]
   *   approve a DIFFERENT address under the SAME name
   *   after   [{"name":"perps-platform","address":"0x2f4b…fe68", …}]
   *
   * One entry, naming the new address, the old one gone, `agentCount` unchanged
   * at 1 of 3. The same walk also measured the two things this double had to
   * guess at: the returned `name` is the **bare** `perps-platform` with no
   * `valid_until` suffix (so `findAgentByName`'s exact match is right), and a
   * fresh approval is valid for **90 days**, twice over — which is what
   * `AGENT_VALIDITY_MS` below stands in for.
   */
  approve(address: HexAddress, name: string): void {
    this.approveCalls.push({ address, name });
    this.agents = this.agents.filter((a) => a.name !== name);
    this.agents.push({
      address,
      name,
      validUntil: this.clock() + AGENT_VALIDITY_MS,
    });
  }

  delete(agent: ExtraAgent): void {
    this.deleteCalls.push({ address: agent.address, name: agent.name });
    this.agents = this.agents.filter((a) => a.name !== agent.name);
  }
}

function makeOps(
  hl: FakeHyperliquid,
  derive: (v: number) => HexAddress,
  clock: () => number
): AgentLifecycleOps {
  return {
    listAgents: vi.fn(async () => hl.agents.map((a) => ({ ...a }))),
    deriveAgentAddress: vi.fn(async (v: number) => derive(v)),
    approveAgent: vi.fn(async (address: HexAddress, name: string) =>
      hl.approve(address, name)
    ),
    deleteAgent: vi.fn(async (agent: ExtraAgent) => hl.delete(agent)),
    now: clock,
  };
}

const addr = (hex: string): HexAddress => hex as HexAddress;

describe('[4.3.3] agent lifecycle — pure decision core', () => {
  const NOW = 1_700_000_000_000;

  it('isAgentExpiring: missing / no-validity / within-window are all "expiring"', () => {
    expect(isAgentExpiring(undefined, NOW)).toBe(true);
    expect(
      isAgentExpiring({ address: addr('0x1'), name: 'a', validUntil: null }, NOW)
    ).toBe(true);
    // Comfortably in the future → not expiring.
    expect(
      isAgentExpiring(
        { address: addr('0x1'), name: 'a', validUntil: NOW + 30 * DAY },
        NOW
      )
    ).toBe(false);
    // Inside the 24h window → expiring.
    expect(
      isAgentExpiring(
        { address: addr('0x1'), name: 'a', validUntil: NOW + 12 * 60 * 60 * 1000 },
        NOW
      )
    ).toBe(true);
  });

  it('isAgentExpiring: the window boundary is exclusive', () => {
    const agent: ExtraAgent = {
      address: addr('0x1'),
      name: 'a',
      validUntil: NOW + AGENT_EXPIRY_REAPPROVAL_WINDOW_MS,
    };
    // validUntil < now + window is the trigger; exactly at the edge is safe.
    expect(isAgentExpiring(agent, NOW)).toBe(false);
    expect(isAgentExpiring({ ...agent, validUntil: agent.validUntil! - 1 }, NOW)).toBe(
      true
    );
  });

  it('selectOldestAgent: smallest validUntil wins; null sorts oldest; empty → undefined', () => {
    expect(selectOldestAgent([])).toBeUndefined();
    const agents: ExtraAgent[] = [
      { address: addr('0xaa'), name: 'a', validUntil: NOW + 10 * DAY },
      { address: addr('0xbb'), name: 'b', validUntil: NOW + 2 * DAY },
      { address: addr('0xcc'), name: 'c', validUntil: NOW + 5 * DAY },
    ];
    expect(selectOldestAgent(agents)?.address).toBe(addr('0xbb'));
    expect(
      selectOldestAgent([
        ...agents,
        { address: addr('0xdd'), name: 'd', validUntil: null },
      ])?.address
    ).toBe(addr('0xdd'));
  });

  it('nextSaltVersion: bumps by one and defaults to the current version', () => {
    expect(nextSaltVersion(1)).toBe(2);
    expect(nextSaltVersion(CURRENT_SALT_VERSION)).toBe(CURRENT_SALT_VERSION + 1);
    expect(nextSaltVersion()).toBe(CURRENT_SALT_VERSION + 1);
  });

  it('planAgentApproval: a still-valid agent needs nothing', () => {
    const agents: ExtraAgent[] = [
      { address: addr('0xAA'), name: PERPS_AGENT_NAME, validUntil: NOW + 30 * DAY },
    ];
    expect(
      planAgentApproval({ agents, agentAddress: addr('0xAA'), now: NOW })
    ).toEqual({ needsApproval: false, needsDelete: false });
  });

  it('planAgentApproval: an expiring agent re-approves without a delete', () => {
    const agents: ExtraAgent[] = [
      { address: addr('0xAA'), name: PERPS_AGENT_NAME, validUntil: NOW + 60 * 1000 },
    ];
    expect(
      planAgentApproval({ agents, agentAddress: addr('0xAA'), now: NOW })
    ).toEqual({ needsApproval: true, needsDelete: false, deleteTarget: undefined });
  });

  it('planAgentApproval: a missing address reuses an existing same-named slot (no delete even at cap)', () => {
    // The named slot is taken by a stale address (e.g. legacy rename): approving
    // the same name replaces it, so the cap is not in the way.
    const agents: ExtraAgent[] = [
      { address: addr('0x01'), name: PERPS_AGENT_NAME, validUntil: NOW + 30 * DAY },
      { address: addr('0x02'), name: 'other-1', validUntil: NOW + 30 * DAY },
      { address: addr('0x03'), name: 'other-2', validUntil: NOW + 30 * DAY },
    ];
    expect(agents.length).toBe(PERPS_MAX_AGENTS);
    const plan = planAgentApproval({
      agents,
      agentAddress: addr('0xNEW'),
      now: NOW,
    });
    expect(plan).toEqual({ needsApproval: true, needsDelete: false, deleteTarget: undefined });
  });

  // [#928] This case used to assert `deleteTarget: addr('0x02')` — the oldest
  // agent overall. But the cap check only runs when we hold no named slot, so
  // by construction every agent in the way belongs to somebody ELSE: the
  // Hyperliquid cap is per account and shared with every app the account's
  // wallet uses. Deleting "the oldest" there revokes a stranger's API wallet —
  // for an external-wallet user, quite likely app.hyperliquid.xyz's own.
  it('planAgentApproval: a new address at a cap full of OTHER apps’ agents is blocked, not resolved by deleting one', () => {
    const agents: ExtraAgent[] = [
      { address: addr('0x01'), name: 'other-1', validUntil: NOW + 30 * DAY },
      { address: addr('0x02'), name: 'other-2', validUntil: NOW + 2 * DAY },
      { address: addr('0x03'), name: 'other-3', validUntil: NOW + 30 * DAY },
    ];
    const plan = planAgentApproval({
      agents,
      agentAddress: addr('0xNEW'),
      now: NOW,
    });
    expect(plan.needsApproval).toBe(true);
    expect(plan.needsDelete).toBe(false);
    expect(plan.deleteTarget).toBeUndefined();
    expect(plan.blockedByForeignAgents).toBe(true);
  });

  it('selectOldestAgent: an owned-name filter never returns another app’s agent', () => {
    // The actual guard. Unfiltered, "oldest" is 0x02 — which belongs to another
    // app; filtered to our name it is 0x03, and when we own none it is nothing.
    const agents: ExtraAgent[] = [
      { address: addr('0x01'), name: PERPS_AGENT_NAME, validUntil: NOW + 30 * DAY },
      { address: addr('0x02'), name: 'other-1', validUntil: NOW + 1 * DAY },
      { address: addr('0x03'), name: PERPS_AGENT_NAME, validUntil: NOW + 5 * DAY },
    ];
    expect(selectOldestAgent(agents)?.address).toBe(addr('0x02'));
    expect(selectOldestAgent(agents, PERPS_AGENT_NAME)?.address).toBe(addr('0x03'));
    expect(selectOldestAgent(agents, 'a-name-we-never-used')).toBeUndefined();
  });

  it('planAgentApproval: holding the named slot means the cap is never in the way', () => {
    // The reason `needsDelete` is unreachable from here today: a returning
    // session already owns its slot, and approving replaces it in place.
    const plan = planAgentApproval({
      agents: [
        { address: addr('0x01'), name: 'mine', validUntil: NOW + 30 * DAY },
        { address: addr('0x02'), name: 'other-2', validUntil: NOW + 2 * DAY },
        { address: addr('0x03'), name: 'other-3', validUntil: NOW + 30 * DAY },
      ],
      agentAddress: addr('0xNEW'),
      agentName: 'mine',
      now: NOW,
    });
    expect(plan.needsApproval).toBe(true);
    expect(plan.needsDelete).toBe(false);
    expect(plan.blockedByForeignAgents).toBeUndefined();
  });

  it('planAgentApproval: a new address below the cap approves without a delete', () => {
    const agents: ExtraAgent[] = [
      { address: addr('0x01'), name: 'other-1', validUntil: NOW + 30 * DAY },
    ];
    const plan = planAgentApproval({
      agents,
      agentAddress: addr('0xNEW'),
      now: NOW,
    });
    expect(plan).toMatchObject({ needsApproval: true, needsDelete: false });
  });

  it('findAgentByAddress is case-insensitive; findAgentByName targets the slot', () => {
    const agents: ExtraAgent[] = [
      { address: addr('0xAbCd'), name: PERPS_AGENT_NAME, validUntil: NOW + DAY },
    ];
    expect(findAgentByAddress(agents, addr('0xabcd'))?.name).toBe(PERPS_AGENT_NAME);
    expect(findAgentByName(agents, PERPS_AGENT_NAME)?.address).toBe(addr('0xAbCd'));
    expect(findAgentByAddress(agents, addr('0xffff'))).toBeUndefined();
  });
});

describe('[4.3.3] AgentLifecycleManager.ensureApproved — expiry & cap (AC1, AC2)', () => {
  it('approves the deterministic agent on a fresh account (one step-up)', async () => {
    let now = 1_700_000_000_000;
    const derive = fakeAuthenticator('seed-a');
    const hl = new FakeHyperliquid(() => now);
    const ops = makeOps(hl, derive, () => now);
    const mgr = new AgentLifecycleManager(ops);

    const result = await mgr.ensureApproved();

    expect(result.approved).toBe(true);
    expect(result.agentAddress).toBe(derive(CURRENT_SALT_VERSION));
    expect(hl.approveCalls).toEqual([
      { address: result.agentAddress, name: PERPS_AGENT_NAME },
    ]);
    expect(findAgentByAddress(hl.agents, result.agentAddress)).toBeDefined();
    expect(ops.deleteAgent).not.toHaveBeenCalled();
  });

  it('spends no ceremony when the agent is still valid', async () => {
    let now = 1_700_000_000_000;
    const derive = fakeAuthenticator('seed-a');
    const hl = new FakeHyperliquid(() => now);
    const ops = makeOps(hl, derive, () => now);
    const mgr = new AgentLifecycleManager(ops);

    await mgr.ensureApproved();
    const approvesAfterFirst = hl.approveCalls.length;

    // Same session, well within validity → no-op.
    const second = await mgr.ensureApproved();
    expect(second.approved).toBe(false);
    expect(hl.approveCalls.length).toBe(approvesAfterFirst);
  });

  it('AC1: crossing the <24h window re-approves the SAME address with one step-up', async () => {
    let now = 1_700_000_000_000;
    const derive = fakeAuthenticator('seed-a');
    const hl = new FakeHyperliquid(() => now);
    const ops = makeOps(hl, derive, () => now);
    const mgr = new AgentLifecycleManager(ops);

    const first = await mgr.ensureApproved();
    expect(first.approved).toBe(true);

    // Advance the clock to inside the 24h window before validUntil.
    now += AGENT_VALIDITY_MS - 12 * 60 * 60 * 1000;

    const renewed = await mgr.ensureApproved();
    expect(renewed.approved).toBe(true);
    // Same deterministic address — routine expiry never mints a new one.
    expect(renewed.agentAddress).toBe(first.agentAddress);
    expect(hl.approveCalls).toEqual([
      { address: first.agentAddress, name: PERPS_AGENT_NAME },
      { address: first.agentAddress, name: PERPS_AGENT_NAME },
    ]);
    expect(ops.deleteAgent).not.toHaveBeenCalled();
  });

  it('re-approval targets the same address across independent sessions (determinism)', async () => {
    const now = 1_700_000_000_000;
    const derive = fakeAuthenticator('seed-shared');

    const hlA = new FakeHyperliquid(() => now);
    const a = await new AgentLifecycleManager(
      makeOps(hlA, derive, () => now)
    ).ensureApproved();

    const hlB = new FakeHyperliquid(() => now);
    const b = await new AgentLifecycleManager(
      makeOps(hlB, derive, () => now)
    ).ensureApproved();

    expect(a.agentAddress).toBe(b.agentAddress);
  });

  // [#928] Was: "a full registry deletes the oldest before approving". Every
  // agent in the way here belongs to another app, so the delete it used to
  // perform was a revocation of somebody else's API wallet.
  it('AC2: a registry full of OTHER apps’ agents refuses rather than revoking one of theirs', async () => {
    let now = 1_700_000_000_000;
    const derive = fakeAuthenticator('seed-a');
    const hl = new FakeHyperliquid(() => now);
    hl.seed([
      { address: addr('0x01'), name: 'legacy-1', validUntil: now + 30 * DAY },
      { address: addr('0x02'), name: 'legacy-2', validUntil: now + 2 * DAY }, // oldest
      { address: addr('0x03'), name: 'legacy-3', validUntil: now + 30 * DAY },
    ]);
    expect(hl.agents.length).toBe(PERPS_MAX_AGENTS);

    const ops = makeOps(hl, derive, () => now);
    const mgr = new AgentLifecycleManager(ops);

    await expect(mgr.ensureApproved()).rejects.toThrow(ForeignAgentCapError);

    // Nothing was touched: no revocation, no approval, registry unchanged.
    expect(ops.deleteAgent).not.toHaveBeenCalled();
    expect(ops.approveAgent).not.toHaveBeenCalled();
    expect(hl.deleteCalls).toEqual([]);
    expect(hl.agents.map((a) => a.name)).toEqual(['legacy-1', 'legacy-2', 'legacy-3']);
  });

  it('AC2: the refusal names the cap and does not leak which agents are in the way', async () => {
    const now = 1_700_000_000_000;
    const hl = new FakeHyperliquid(() => now);
    hl.seed([
      { address: addr('0x01'), name: 'legacy-1', validUntil: now + 30 * DAY },
      { address: addr('0x02'), name: 'legacy-2', validUntil: now + 2 * DAY },
      { address: addr('0x03'), name: 'legacy-3', validUntil: now + 30 * DAY },
    ]);
    const mgr = new AgentLifecycleManager(makeOps(hl, fakeAuthenticator('seed-a'), () => now));

    await expect(mgr.ensureApproved()).rejects.toMatchObject({
      code: 'AGENT_CAP_FULL_FOREIGN',
    });
    // The user's own action is what unblocks this, so the message has to say so.
    await expect(mgr.ensureApproved()).rejects.toThrow(/has to be revoked/);
    // And it must not say WHOSE. `blockedByForeignAgents` is set whenever
    // nothing holds the slot under the name asked about, which an account full
    // of this product's own agents under its OTHER name satisfies — so a
    // message attributing the cap to "other apps" sends that user to revoke
    // something in an app that does not exist. See `ForeignAgentCapError`.
    await expect(mgr.ensureApproved()).rejects.toThrow(/^(?!.*other apps)/s);
  });

  it('honors custom cap / window / agent-name config', async () => {
    let now = 1_700_000_000_000;
    const derive = fakeAuthenticator('seed-a');
    const hl = new FakeHyperliquid(() => now);
    // The single slot is OURS (same configured name), so approving replaces it.
    hl.seed([{ address: addr('0x01'), name: 'my-agent', validUntil: now + 30 * DAY }]);
    const ops = makeOps(hl, derive, () => now);
    const mgr = new AgentLifecycleManager(ops, {
      agentName: 'my-agent',
      maxAgents: 1,
    });

    const result = await mgr.ensureApproved();
    // Holding the named slot means the cap is never in the way — replace, not delete.
    expect(result.deleted).toBeUndefined();
    expect(ops.deleteAgent).not.toHaveBeenCalled();
    expect(hl.approveCalls[0]).toEqual({
      address: result.agentAddress,
      name: 'my-agent',
    });
  });
});

describe('[4.3.3] AgentLifecycleManager.rotateOnCompromise — salt bump (AC3)', () => {
  it('bumps the salt version, approves a NEW address, and removes the old agent', async () => {
    let now = 1_700_000_000_000;
    const derive = fakeAuthenticator('seed-a');
    const hl = new FakeHyperliquid(() => now);
    const ops = makeOps(hl, derive, () => now);
    const mgr = new AgentLifecycleManager(ops);

    // Start from a normally-approved v1 agent.
    const initial = await mgr.ensureApproved();
    expect(mgr.getSaltVersion()).toBe(CURRENT_SALT_VERSION);

    const rotation = await mgr.rotateOnCompromise();

    expect(rotation.oldAddress).toBe(initial.agentAddress);
    expect(rotation.newSaltVersion).toBe(CURRENT_SALT_VERSION + 1);
    // Salt bump ⇒ a genuinely different deterministic address.
    expect(rotation.newAddress).not.toBe(rotation.oldAddress);
    expect(rotation.newAddress).toBe(derive(CURRENT_SALT_VERSION + 1));
    expect(rotation.deletedOld).toBe(true);

    // Old agent revoked, new agent live.
    expect(hl.deleteCalls).toContainEqual({
      address: rotation.oldAddress,
      name: PERPS_AGENT_NAME,
    });
    expect(hl.approveCalls.at(-1)).toEqual({
      address: rotation.newAddress,
      name: PERPS_AGENT_NAME,
    });
    expect(findAgentByAddress(hl.agents, rotation.oldAddress)).toBeUndefined();
    expect(findAgentByAddress(hl.agents, rotation.newAddress)).toBeDefined();

    // The manager now tracks v2.
    expect(mgr.getSaltVersion()).toBe(CURRENT_SALT_VERSION + 1);
    expect(await mgr.getAgentAddress()).toBe(rotation.newAddress);
  });

  it('revokes the compromised key before approving the replacement (never over-cap)', async () => {
    let now = 1_700_000_000_000;
    const derive = fakeAuthenticator('seed-a');
    const hl = new FakeHyperliquid(() => now);
    const ops = makeOps(hl, derive, () => now);
    const mgr = new AgentLifecycleManager(ops);

    await mgr.ensureApproved();
    await mgr.rotateOnCompromise();

    expect(
      (ops.deleteAgent as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    ).toBeLessThan(
      (ops.approveAgent as ReturnType<typeof vi.fn>).mock.invocationCallOrder.at(-1)!
    );
    expect(hl.agents.length).toBeLessThanOrEqual(PERPS_MAX_AGENTS);
  });

  it('after rotation, a routine ensureApproved on v2 is a no-op', async () => {
    let now = 1_700_000_000_000;
    const derive = fakeAuthenticator('seed-a');
    const hl = new FakeHyperliquid(() => now);
    const ops = makeOps(hl, derive, () => now);
    const mgr = new AgentLifecycleManager(ops);

    await mgr.ensureApproved();
    await mgr.rotateOnCompromise();
    const approvesBefore = hl.approveCalls.length;

    const result = await mgr.ensureApproved();
    expect(result.approved).toBe(false);
    expect(hl.approveCalls.length).toBe(approvesBefore);
  });

  it('rotates even when the old agent is already gone on-chain (deletedOld=false)', async () => {
    let now = 1_700_000_000_000;
    const derive = fakeAuthenticator('seed-a');
    const hl = new FakeHyperliquid(() => now); // registry empty — old agent expired off-chain
    const ops = makeOps(hl, derive, () => now);
    const mgr = new AgentLifecycleManager(ops);

    const rotation = await mgr.rotateOnCompromise();

    expect(rotation.deletedOld).toBe(false);
    expect(ops.deleteAgent).not.toHaveBeenCalled();
    expect(rotation.newAddress).toBe(derive(CURRENT_SALT_VERSION + 1));
    expect(findAgentByAddress(hl.agents, rotation.newAddress)).toBeDefined();
    expect(mgr.getSaltVersion()).toBe(CURRENT_SALT_VERSION + 1);
  });

  it('a second compromise bumps v2→v3', async () => {
    let now = 1_700_000_000_000;
    const derive = fakeAuthenticator('seed-a');
    const hl = new FakeHyperliquid(() => now);
    const ops = makeOps(hl, derive, () => now);
    const mgr = new AgentLifecycleManager(ops);

    await mgr.ensureApproved();
    const first = await mgr.rotateOnCompromise();
    const second = await mgr.rotateOnCompromise();

    expect(first.newSaltVersion).toBe(CURRENT_SALT_VERSION + 1);
    expect(second.newSaltVersion).toBe(CURRENT_SALT_VERSION + 2);
    expect(second.oldAddress).toBe(first.newAddress);
    expect(second.newAddress).toBe(derive(CURRENT_SALT_VERSION + 2));
  });
});
