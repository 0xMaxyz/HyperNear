import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type ClaimStatus = '✅' | '❌' | '⚠️';

export interface ClaimResult {
  claim: string;
  title: string;
  status: ClaimStatus;
  at: string;
  network: 'testnet';
  /** Free-form measured values (balances, fees, latencies). */
  numbers: Record<string, string | number | boolean | null>;
  /** tx hashes, HL responses, explorer links. */
  refs: Record<string, unknown>;
  notes: string[];
  error?: string;
}

const RESULTS_DIR = fileURLToPath(new URL('../results/', import.meta.url));

export function writeResult(file: string, r: ClaimResult): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(`${RESULTS_DIR}${file}.json`, JSON.stringify(r, null, 2) + '\n');
}

export class Recorder {
  status: ClaimStatus = '✅';
  readonly numbers: ClaimResult['numbers'] = {};
  readonly refs: ClaimResult['refs'] = {};
  readonly notes: string[] = [];
  warn(note: string): void {
    if (this.status === '✅') this.status = '⚠️';
    this.notes.push(note);
  }
  fail(note: string): void {
    this.status = '❌';
    this.notes.push(note);
  }
}

/**
 * Runs a claim test body, then writes validation/results/<file>.json: ✅ unless the body
 * called warn()/fail(), ❌ with the error message if it threw (and rethrows so vitest fails).
 */
export async function runClaim(
  file: string,
  claim: string,
  title: string,
  body: (r: Recorder) => Promise<void>,
): Promise<void> {
  const r = new Recorder();
  let thrown: unknown;
  try {
    await body(r);
  } catch (e) {
    thrown = e;
    r.status = '❌';
  }
  writeResult(file, {
    claim,
    title,
    status: r.status,
    at: new Date().toISOString(),
    network: 'testnet',
    numbers: r.numbers,
    refs: r.refs,
    notes: r.notes,
    ...(thrown ? { error: thrown instanceof Error ? thrown.message : String(thrown) } : {}),
  });
  if (thrown) throw thrown;
  if (r.status === '❌') throw new Error(`${claim}: ${r.notes.join('; ')}`);
}

/** Records a claim as not run (blocked on an input), without failing the suite. */
export function writeBlocked(file: string, claim: string, title: string, reason: string): void {
  writeResult(file, {
    claim,
    title,
    status: '⚠️',
    at: new Date().toISOString(),
    network: 'testnet',
    numbers: {},
    refs: {},
    notes: [`not run: ${reason}`],
  });
}
