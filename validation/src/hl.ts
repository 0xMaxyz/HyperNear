import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { recoverTypedDataAddress, parseSignature, type Hex, type TypedDataDomain } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  HL_API_URLS,
  HlClient,
  testOnlyRawKeySigner,
  type HexAddress,
  type HlExtraAgentsResult,
  type HlTransport,
} from '@perps-platform/core';
import { REPO_ROOT, labWallet } from './env';

const NET = 'testnet' as const;

// ---------------------------------------------------------------- transport

/** Plain fetch transport for HlClient (Node 22 fetch; set NODE_USE_ENV_PROXY=1 to honour http(s)_proxy). */
export function fetchTransport(base: string = HL_API_URLS[NET]): HlTransport {
  return {
    async request(endpoint, payload, signal) {
      if (endpoint === 'explorer') throw new Error('explorer endpoint is not used by the harness');
      const res = await fetch(`${base}/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HL ${endpoint} HTTP ${res.status}: ${text.slice(0, 300)}`);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
  };
}

/** A transport that records /exchange bodies and answers with a canned ok (offline signing checks). */
export function recordingTransport(): HlTransport & { exchange: unknown[] } {
  const exchange: unknown[] = [];
  return {
    exchange,
    async request(endpoint, payload) {
      if (endpoint === 'exchange') exchange.push(payload);
      return { status: 'ok', response: { type: 'default' } };
    },
  };
}

// ------------------------------------------------------------------- client

export interface ClientKeys {
  /** Signs user-signed actions (usdSend, approveAgent, ...). */
  master?: Hex;
  /** Signs L1 actions (orders, cancels, subAccountTransfer). */
  agent?: Hex;
  transport?: HlTransport;
}

export function testnetClient(keys: ClientKeys = {}): HlClient {
  return new HlClient({
    network: NET,
    transport: keys.transport ?? fetchTransport(),
    ...(keys.master ? { masterSigner: testOnlyRawKeySigner(keys.master) } : {}),
    ...(keys.agent ? { agentSigner: testOnlyRawKeySigner(keys.agent) } : {}),
  });
}

export function funderKey(): Hex {
  return labWallet(1).key; // lab wallet #1 funds every live test
}

export function funderAddress(): HexAddress {
  return privateKeyToAccount(funderKey()).address;
}

export function freshKey(): { key: Hex; address: HexAddress } {
  const key = generatePrivateKey();
  return { key, address: privateKeyToAccount(key).address };
}

// -------------------------------------------------------------- info reads

export interface AccountSnapshot {
  address: HexAddress;
  /** Perp accountValue (USD). */
  perpValue: number;
  /** Perp withdrawable (USD). */
  withdrawable: number;
  /** Spot USDC total. */
  spotUsdc: number;
  positions: Array<{ coin: string; szi: string }>;
  agents: HlExtraAgentsResult;
}

export async function snapshot(client: HlClient, address: HexAddress): Promise<AccountSnapshot> {
  const [ch, spot, agents] = await Promise.all([
    client.clearinghouseState({ user: address }),
    client.spotClearinghouseState({ user: address }),
    client.extraAgents({ user: address }),
  ]);
  return {
    address,
    perpValue: Number(ch.marginSummary.accountValue),
    withdrawable: Number(ch.withdrawable),
    spotUsdc: Number(spot.balances.find((b) => b.coin === 'USDC')?.total ?? 0),
    positions: ch.assetPositions.map((p) => ({ coin: p.position.coin, szi: p.position.szi })),
    agents,
  };
}

/** Total USDC the account holds across perp + spot (unified accounts show it in spot only). */
export const totalUsdc = (s: AccountSnapshot): number => s.perpValue + s.spotUsdc;

export async function waitFor<T>(
  fn: () => Promise<T | undefined | false>,
  { timeoutMs = 30_000, everyMs = 1_500 } = {},
): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return undefined;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

// ----------------------------------------------- user-signed action typed data

type Field = readonly [name: string, type: string];

/** wire action `type` -> EIP-712 primary type, field list, and the field that doubles as the request nonce. */
const USER_SIGNED: Record<string, { primaryType: string; fields: readonly Field[]; nonce: 'nonce' | 'time' }> = {
  approveAgent: {
    primaryType: 'HyperliquidTransaction:ApproveAgent',
    fields: [['hyperliquidChain', 'string'], ['agentAddress', 'address'], ['agentName', 'string'], ['nonce', 'uint64']],
    nonce: 'nonce',
  },
  usdSend: {
    primaryType: 'HyperliquidTransaction:UsdSend',
    fields: [['hyperliquidChain', 'string'], ['destination', 'string'], ['amount', 'string'], ['time', 'uint64']],
    nonce: 'time',
  },
  withdraw3: {
    primaryType: 'HyperliquidTransaction:Withdraw',
    fields: [['hyperliquidChain', 'string'], ['destination', 'string'], ['amount', 'string'], ['time', 'uint64']],
    nonce: 'time',
  },
  usdClassTransfer: {
    primaryType: 'HyperliquidTransaction:UsdClassTransfer',
    fields: [['hyperliquidChain', 'string'], ['amount', 'string'], ['toPerp', 'bool'], ['nonce', 'uint64']],
    nonce: 'nonce',
  },
};

export interface UserSignedAction {
  type: string;
  hyperliquidChain: 'Testnet' | 'Mainnet';
  signatureChainId: Hex;
  [k: string]: unknown;
}

/** The EIP-712 payload HL verifies for a user-signed action (domain chainId = signatureChainId). */
export function userSignedTypedData(action: UserSignedAction) {
  const spec = USER_SIGNED[action.type];
  if (!spec) throw new Error(`no typed-data table for action type ${action.type}`);
  const domain: TypedDataDomain = {
    name: 'HyperliquidSignTransaction',
    version: '1',
    chainId: parseInt(action.signatureChainId, 16),
    verifyingContract: '0x0000000000000000000000000000000000000000',
  };
  const message: Record<string, unknown> = {};
  for (const [name, type] of spec.fields) {
    const v = action[name] ?? (type === 'string' ? '' : undefined);
    message[name] = type === 'uint64' ? BigInt(v as number | string) : v;
  }
  return {
    domain,
    types: { [spec.primaryType]: spec.fields.map(([name, type]) => ({ name, type })) },
    primaryType: spec.primaryType,
    message,
  } as const;
}

export function actionNonce(action: UserSignedAction): number {
  return Number(action[USER_SIGNED[action.type]!.nonce]);
}

export type RsvSignature = { r: Hex; s: Hex; v: number };

export function toRsv(sig: Hex | { r: Hex; s: Hex; v?: number | string; yParity?: number }): RsvSignature {
  if (typeof sig === 'string') {
    const p = parseSignature(sig);
    return { r: p.r, s: p.s, v: Number(p.v ?? 27n + BigInt(p.yParity)) };
  }
  const v = sig.v !== undefined ? Number(sig.v) : 27 + (sig.yParity ?? 0);
  return { r: sig.r, s: sig.s, v: v < 27 ? v + 27 : v };
}

/** Recovers the address that signed a user-signed action. */
export async function recoverUserSigned(action: UserSignedAction, signature: Hex | RsvSignature): Promise<HexAddress> {
  const rsv = toRsv(signature);
  const hex = (`0x${rsv.r.slice(2)}${rsv.s.slice(2)}${rsv.v.toString(16).padStart(2, '0')}`) as Hex;
  return recoverTypedDataAddress({ ...userSignedTypedData(action), signature: hex });
}

// ------------------------------------------------ pre-signed action submission

export interface SignedActionFile {
  /** Address the signature must recover to (the MPC-derived address). */
  address: HexAddress;
  action: UserSignedAction;
  signature: Hex | RsvSignature;
  /** Optional free-form metadata (derivation path, tx hash, ...). */
  meta?: Record<string, unknown>;
}

/**
 * Loads a contract-dev artefact. Accepted shape:
 * { "derivedAddress"|"address": "0x..", "action": {type, hyperliquidChain, signatureChainId, ...},
 *   "signature": "0x<65 bytes>" | {r,s,v}, "meta"?: {...} }
 * Returns null when the file does not exist yet.
 */
export function loadSignedActionFile(relPath: string): SignedActionFile | null {
  const p = isAbsolute(relPath) ? relPath : `${REPO_ROOT}${relPath}`;
  if (!existsSync(p)) return null;
  const j = JSON.parse(readFileSync(p, 'utf8')) as Record<string, any>;
  // contract-dev's c2 file nests the request under exchangeRequest and names the signer `master`
  const req = j.exchangeRequest ?? j;
  const address = (j.derivedAddress ?? j.address ?? j.master) as HexAddress | undefined;
  if (!address || !req.action || !req.signature) {
    throw new Error(`${relPath}: expected {derivedAddress|address, action, signature}`);
  }
  return { address, action: req.action, signature: req.signature, meta: { legs: j.legs, ...j.meta } };
}

export type ExchangeResponse = { status: 'ok'; response: unknown } | { status: 'err'; response: string };

/** POSTs an already-signed action to HL testnet /exchange and returns HL's JSON verbatim (no throw on status:err). */
export async function submitSignedAction(
  action: UserSignedAction,
  signature: Hex | RsvSignature,
  base: string = HL_API_URLS[NET],
): Promise<ExchangeResponse> {
  const res = await fetch(`${base}/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, nonce: actionNonce(action), signature: toRsv(signature) }),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as ExchangeResponse;
  } catch {
    return { status: 'err', response: `HTTP ${res.status}: ${text.slice(0, 300)}` };
  }
}

// ----------------------------------------------------------- funder transfers

/** usdSend from the funder (lab wallet #1) to `to`; returns HL's response. */
export async function fundFromFunder(to: HexAddress, amount: string) {
  const client = testnetClient({ master: funderKey() });
  return client.usdSend({ destination: to, amount });
}

/** Signs (without sending) an approveAgent with a local key via core's HlClient; returns the wire body it produced. */
export async function signApproveAgentLocally(masterKey: Hex, agentAddress: HexAddress, agentName: string) {
  const rec = recordingTransport();
  await testnetClient({ master: masterKey, transport: rec }).approveAgent({ agentAddress, agentName });
  const body = rec.exchange[0] as { action: UserSignedAction; nonce: number; signature: RsvSignature };
  return body;
}

// ------------------------------------------------------------- market helpers

export interface MarketInfo {
  coin: string;
  asset: number;
  szDecimals: number;
  mid: number;
}

export async function marketInfo(client: HlClient, coin: string): Promise<MarketInfo> {
  const [meta, mids] = await Promise.all([client.meta(), client.allMids()]);
  const asset = meta.universe.findIndex((u) => u.name === coin);
  if (asset < 0) throw new Error(`${coin} not in testnet universe`);
  return { coin, asset, szDecimals: meta.universe[asset]!.szDecimals, mid: Number(mids[coin]) };
}

/** Smallest size (rounded UP to szDecimals) whose notional at `px` is at least `usd`. */
export function sizeForNotional(usd: number, px: number, szDecimals: number): string {
  const f = 10 ** szDecimals;
  return (Math.ceil((usd / px) * f) / f).toFixed(szDecimals);
}

/** HL price rule: at most 5 significant figures. */
export const roundPx = (px: number): string => String(Number(px.toPrecision(5)));

/**
 * Asks contract-dev's script (run from its checkout, e.g. ~/work/near_hck-contract on ci32) for a FRESH
 * MPC-signed approveAgent: HL rejects stale nonces. Takes ~12 s. Never prints the script's output.
 */
export function signFreshApproveAgent(contractDir: string, path: string, agentAddress: HexAddress, agentName: string) {
  const out = execFileSync(
    'node',
    ['contract/scripts/sign-approve.mjs', path, agentAddress, String(Date.now()), agentName],
    { cwd: contractDir, encoding: 'utf8', timeout: 120_000, maxBuffer: 1 << 20 },
  );
  const j = JSON.parse(out.slice(out.indexOf('{'))) as {
    master: HexAddress;
    signTx: string;
    gasTGas: string;
    exchangeRequest: { action: UserSignedAction; nonce: number; signature: RsvSignature };
  };
  return j;
}

/** Reads a 32-byte hex private key from a file without ever returning anything but the key; throws without echoing contents. */
export function readHexKeyFile(path: string): Hex {
  const m = /(?:0x)?([0-9a-fA-F]{64})(?![0-9a-fA-F])/.exec(readFileSync(path, 'utf8'));
  if (!m) throw new Error(`no 32-byte hex key found in ${path}`);
  return `0x${m[1]}` as Hex;
}
