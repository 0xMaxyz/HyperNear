// Verification of owner-signed commands (POST /hedge/open|close and anything later that moves positions).
import type { Hex } from 'viem';
import { recoverCommandSigner, ZERO_SPEC_HASH, type ChainTag, type Command, type CommandAction } from '@hypernear/client';
import { HttpError } from './relayer.ts';

export const MAX_COMMAND_TTL_SEC = 60;
const ADDR = /^0x[0-9a-f]{40}$/;
const SIG = /^0x[0-9a-fA-F]{130}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;

/** Seen (owner, nonce) pairs until their command expires; bounded. */
export class ReplayCache {
  readonly #seen = new Map<string, number>(); // key -> expiry (unix s)
  readonly max: number;
  constructor(max = 10_000) {
    this.max = max;
  }
  /** Records the key; false if it was already there (a replay). */
  claim(key: string, expiry: number, nowSec: number): boolean {
    for (const [k, exp] of this.#seen) if (exp < nowSec) this.#seen.delete(k);
    if (this.#seen.has(key)) return false;
    if (this.#seen.size >= this.max) throw new HttpError(503, 'replay cache full, retry shortly');
    this.#seen.set(key, expiry);
    return true;
  }
}

export interface CommandVerifier {
  chainTag: () => Promise<ChainTag>;
  contractId: string;
  cache: ReplayCache;
  now?: () => number;
}

/** Returns the command after checking shape, route action, expiry window, signature and replay; throws HttpError otherwise. */
export async function verifyCommand(v: CommandVerifier, body: unknown, expected: CommandAction): Promise<Command> {
  const b = body as { command?: Record<string, unknown>; sig?: unknown };
  const c = b?.command;
  if (!c || typeof c !== 'object') throw new HttpError(401, 'signed command required: {command, sig}');
  if (typeof b.sig !== 'string' || !SIG.test(b.sig)) throw new HttpError(401, 'sig must be 65 bytes hex');
  if (typeof c.owner !== 'string' || !ADDR.test(c.owner)) throw new HttpError(400, 'command.owner must be 0x + 40 lowercase hex');
  if (c.action !== expected) throw new HttpError(400, `command.action must be ${expected}`);
  if (typeof c.coin !== 'string' || typeof c.ratio !== 'string' || !/^\d+(\.\d+)?$/.test(c.ratio)) throw new HttpError(400, 'command.coin and command.ratio (decimal string) required');
  if (!Number.isSafeInteger(c.expiry) || !Number.isSafeInteger(c.nonce) || (c.nonce as number) < 0) throw new HttpError(400, 'command.expiry and command.nonce must be integers');
  const nowSec = Math.floor((v.now ?? Date.now)() / 1000);
  const expiry = c.expiry as number;
  if (expiry < nowSec) throw new HttpError(401, 'command expired');
  if (expiry - nowSec > MAX_COMMAND_TTL_SEC) throw new HttpError(401, `command expiry more than ${MAX_COMMAND_TTL_SEC} s ahead`);
  if (typeof c.specHash !== 'string' || !BYTES32.test(c.specHash)) throw new HttpError(400, 'command.specHash must be bytes32 (0x + 64 lowercase hex)');
  // only startStrategy binds a spec; everything else signs zero (the route compares a nonzero hash with the spec it got)
  if ((expected === 'startStrategy') === (c.specHash === ZERO_SPEC_HASH)) {
    throw new HttpError(400, expected === 'startStrategy' ? 'command.specHash must be the spec hash' : 'command.specHash must be zero for this action');
  }
  const cmd: Command = { owner: c.owner as Hex, action: expected, coin: c.coin, ratio: c.ratio, expiry, nonce: c.nonce as number, specHash: c.specHash as Hex };
  let signer: Hex;
  try {
    signer = await recoverCommandSigner(await v.chainTag(), v.contractId, cmd, b.sig as Hex);
  } catch {
    throw new HttpError(401, 'bad signature');
  }
  if (signer !== cmd.owner) throw new HttpError(401, 'signature does not match command.owner');
  if (!v.cache.claim(`${cmd.owner}:${cmd.nonce}`, expiry, nowSec)) throw new HttpError(401, 'command replayed');
  return cmd;
}
