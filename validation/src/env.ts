import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Minimal .env loader (gitignored file at the repo root). Never logs values.
const envPath = `${REPO_ROOT}.env`;
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[2] && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

/** Live tests hit HL testnet and spend the funder's testnet USDC; opt in with LIVE=1. */
export const LIVE = process.env.LIVE === '1';
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}

// ---- lab wallets (dripped HL testnet accounts; file outside the repo, never copied here)

export interface LabWallet {
  index: number;
  address: `0x${string}`;
  key: `0x${string}`;
}

/** Indices 1-10 only: the rest of the lab set belongs to the load tests. */
const HARD_MAX_INDEX = 10;

function allowedIndices(): Set<number> {
  const out = new Set<number>();
  for (const part of (process.env.LAB_WALLET_INDICES ?? '1-10').split(',')) {
    const [a, b] = part.trim().split('-').map(Number);
    for (let i = a!; i <= (b ?? a!); i++) if (i >= 1 && i <= HARD_MAX_INDEX) out.add(i);
  }
  return out;
}

/** True when LAB_WALLETS_PATH points at a readable file. Live money tests need it. */
export const HAS_FUNDER = Boolean(process.env.LAB_WALLETS_PATH && existsSync(process.env.LAB_WALLETS_PATH));

export function labWallet(index: number): LabWallet {
  if (!allowedIndices().has(index)) throw new Error(`lab wallet ${index} is outside LAB_WALLET_INDICES (hard max ${HARD_MAX_INDEX})`);
  const rows = JSON.parse(readFileSync(requireEnv('LAB_WALLETS_PATH'), 'utf8')) as Array<{ index: number; address: string; privateKey: string }>;
  const row = rows.find((r) => r.index === index);
  if (!row) throw new Error(`lab wallet ${index} not found in LAB_WALLETS_PATH`);
  return { index, address: row.address as LabWallet['address'], key: row.privateKey as LabWallet['key'] };
}
