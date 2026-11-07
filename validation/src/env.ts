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

export const HAS_FUNDER = Boolean(process.env.HL_TESTNET_FUNDER_KEY);

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}
