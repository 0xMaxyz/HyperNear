// Per-owner leg set: registered leg addresses (contract), one HL API wallet (agent key) per leg, and HL snapshots.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import type { HlClearinghouseState, HlClient } from '@perps-platform/core';
import { HyperNearClient, NearMasterSigner, type OwnerIntentTypedData } from '@hypernear/client';
import { agentKeySigner, hlClient, readMarket, type Market } from './market.ts';
import type { GuardLegInput } from './guard.ts';

/** Legs are scanned 0..MAX_LEGS-1 (the contract has no per-owner list). */
export const MAX_LEGS = 4;

interface StoredAgent {
  address: Hex;
  key: Hex;
  name: string;
  approvedAt?: number;
}
type Store = Record<string, Record<string, StoredAgent>>;

/** Agent keys on disk: `<dataDir>/agent-keys.json`, dir 0700, file 0600. Keys never leave this class except as signers. */
export class AgentKeyStore {
  readonly #file: string;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.#file = join(dataDir, 'agent-keys.json');
  }
  #read(): Store {
    return existsSync(this.#file) ? (JSON.parse(readFileSync(this.#file, 'utf8')) as Store) : {};
  }
  #write(s: Store) {
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.#file);
  }
  /** Owners this service holds agent keys for: only owners who signed prepareAgents (the guard and decision loops watch them). */
  owners(): Hex[] {
    return Object.keys(this.#read()) as Hex[];
  }
  /** Public part only (safe to log/serve). */
  get(owner: string, leg: number): { address: Hex; name: string; approvedAt?: number } | undefined {
    const a = this.#read()[owner.toLowerCase()]?.[String(leg)];
    return a && { address: a.address, name: a.name, approvedAt: a.approvedAt };
  }
  signer(owner: string, leg: number) {
    const a = this.#read()[owner.toLowerCase()]?.[String(leg)];
    if (!a) throw new Error(`no agent key for ${owner} leg ${leg}`);
    return agentKeySigner(a.key);
  }
  /** Returns the existing key's address, or creates and saves one first (saved before HL ever sees it).
   * rotate: always a fresh key (a revoked key is never approved again). */
  ensure(owner: string, leg: number, rotate = false): { address: Hex; name: string; approvedAt?: number } {
    const s = this.#read();
    const o = (s[owner.toLowerCase()] ??= {});
    if (!o[String(leg)] || rotate) {
      const key = generatePrivateKey();
      o[String(leg)] = { address: privateKeyToAccount(key).address.toLowerCase() as Hex, key, name: `leash-leg${leg}` };
      this.#write(s);
    }
    return this.get(owner, leg)!;
  }
  markApproved(owner: string, leg: number, at = Date.now()) {
    const s = this.#read();
    const a = s[owner.toLowerCase()]?.[String(leg)];
    if (a) {
      a.approvedAt = at;
      this.#write(s);
    }
  }
}

export interface LegState {
  leg: number;
  address: Hex;
  /** null until the owner's signed prepareAgents (POST /agents/prepare) creates the key */
  agent: { address: Hex; name: string; approvedAt?: number } | null;
  clearinghouse: HlClearinghouseState;
  spotUsdc: number;
}

export interface OwnerSnapshot {
  owner: Hex;
  at: number;
  legs: LegState[];
  market: Market;
}

export class Legs {
  readonly client: HyperNearClient;
  readonly hl: HlClient;
  readonly keys: AgentKeyStore;
  readonly network: 'testnet' | 'mainnet';
  readonly coins: string[];

  constructor(o: { client: HyperNearClient; dataDir: string; network: 'testnet' | 'mainnet'; coins: string[]; hl?: HlClient }) {
    this.client = o.client;
    this.network = o.network;
    this.keys = new AgentKeyStore(o.dataDir);
    this.hl = o.hl ?? hlClient(o.network);
    this.coins = o.coins;
  }

  /** Registered legs of the owner (index + address), from the contract. */
  async registered(owner: Hex): Promise<{ leg: number; address: Hex }[]> {
    const addrs = await Promise.all([...Array(MAX_LEGS).keys()].map((i) => this.client.getLeg(owner, i)));
    return addrs.flatMap((address, leg) => (address ? [{ leg, address }] : []));
  }

  /** clearinghouseState (incl. withdrawable) + spot USDC of every registered leg, with the market it was read against. */
  async snapshot(owner: Hex): Promise<OwnerSnapshot> {
    const o = owner.toLowerCase() as Hex;
    const [regs, market] = await Promise.all([this.registered(o), readMarket(this.hl, this.coins)]);
    const legs = await Promise.all(
      regs.map(async ({ leg, address }) => {
        const [clearinghouse, spot] = await Promise.all([
          this.hl.clearinghouseState({ user: address }),
          this.hl.spotClearinghouseState({ user: address }),
        ]);
        const spotUsdc = Number(spot.balances.find((b) => b.coin === 'USDC')?.total ?? 0);
        return { leg, address, agent: this.keys.get(o, leg) ?? null, clearinghouse, spotUsdc };
      })
    );
    return { owner: o, at: Date.now(), legs, market };
  }

  /**
   * Gives each leg its own HL API wallet (one agent cannot serve two masters, C4): creates the key if needed and
   * approves it through the contract (owner-mode NearMasterSigner; the owner signs an approveAgent intent).
   * Skips legs whose agent HL already lists.
   */
  async approveAgents(owner: Hex, legs: number[], signOwnerIntent: (td: OwnerIntentTypedData) => Promise<Hex>, opts: { rotate?: boolean } = {}) {
    const o = owner.toLowerCase() as Hex;
    const out: { leg: number; agent: Hex; approved: 'already' | 'now' }[] = [];
    for (const leg of legs) {
      const address = await this.client.getLeg(o, leg);
      if (!address) throw new Error(`leg ${leg} of ${o} is not registered`);
      const agents = await this.hl.extraAgents({ user: address });
      const prev = this.keys.get(o, leg);
      if (prev && !opts.rotate && agents.some((a) => a.address.toLowerCase() === prev.address)) {
        out.push({ leg, agent: prev.address, approved: 'already' });
        continue;
      }
      // a stored key HL no longer lists was revoked (freeze): never approve it again, rotate
      const agent = this.keys.ensure(o, leg, Boolean(opts.rotate || prev));
      const master = await NearMasterSigner.create({ client: this.client, owner: o, leg, mode: 'owner', signOwnerIntent, legAddress: address });
      await hlClient(this.network, { master }).approveAgent({ agentAddress: agent.address, agentName: agent.name });
      this.keys.markApproved(o, leg);
      out.push({ leg, agent: agent.address, approved: 'now' });
    }
    return out;
  }

  /** Owner-signed prepareAgents: one key per registered leg (existing keys kept). Returns the registered legs' agents. */
  async prepare(owner: Hex) {
    const o = owner.toLowerCase() as Hex;
    const regs = await this.registered(o);
    if (!regs.length) throw new Error(`owner ${o} has no registered leg; register_leg first`);
    return regs.map(({ leg, address }) => ({ leg, address, agent: this.keys.ensure(o, leg) }));
  }

  /** HlClient that trades the leg with its agent key (L1 actions: orders, leverage). */
  tradingClient(owner: Hex, leg: number): HlClient {
    return hlClient(this.network, { agent: this.keys.signer(owner, leg) });
  }
}

/** approveAgent intents the owner still has to sign (one per leg whose key HL has not approved), fields exactly as signed. */
export function pendingApprovals(s: OwnerSnapshot, now = Date.now()) {
  return s.legs
    .filter((l) => l.agent && !l.agent.approvedAt)
    .map((l) => ({ type: 'approveAgent' as const, leg: l.leg, agent: l.agent!.address, agentName: l.agent!.name, hlNonce: now }));
}

/** Guard inputs (ts-dev's guard.ts) for every open position of the owner's legs. */
export function guardInputs(s: OwnerSnapshot, annualVol: number): GuardLegInput[] {
  return s.legs.flatMap((l) => {
    const accountValue = Number(l.clearinghouse.marginSummary.accountValue);
    const maint = Number(l.clearinghouse.crossMaintenanceMarginUsed);
    return l.clearinghouse.assetPositions
      .filter((p) => Number(p.position.szi) !== 0)
      .map(({ position: p }) => ({
        id: `leg${l.leg}:${p.coin}`,
        markPx: Number(s.market.mids[p.coin] ?? p.entryPx),
        liquidationPx: p.liquidationPx === null ? null : Number(p.liquidationPx),
        marginRatio: maint > 0 ? accountValue / maint : Number.POSITIVE_INFINITY,
        annualVol,
      }));
  });
}
