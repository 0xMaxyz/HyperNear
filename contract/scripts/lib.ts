// Shared helpers for the ci32 validation scripts (testnet only).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { Account, JsonRpcProvider, PublicKey, teraToGas } from "near-api-js";
import { keccak256, recoverAddress, type Hex } from "viem";

// ci32 reaches the internet only through http(s)_proxy; Node's fetch ignores it by default.
setGlobalDispatcher(new EnvHttpProxyAgent());

export const MPC = "v1.signer-prod.testnet";
// rpc.testnet.near.org is deprecated: rate-limited (-429) and ~2x slower end to end (measured 2026-11-07)
export const RPC = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
export const provider = new JsonRpcProvider({ url: RPC });

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Storage deposits the relayer attaches (contract refunds the excess). */
export const OWNER_DEPOSIT = 10n ** 22n; // 0.01 NEAR
export const REGISTER_LEG_DEPOSIT = 5n * 10n ** 21n; // 0.005 NEAR

export function accountFromKeychain(accountId: string): Account {
  const cred = JSON.parse(readFileSync(`${homedir()}/.near-credentials/testnet/${accountId}.json`, "utf8"));
  return new Account(accountId, provider, cred.private_key);
}

/** EVM address of the MPC key derived for (predecessor, path), via the MPC contract's own view. */
export async function derivedEvmAddress(predecessor: string, path: string): Promise<Hex> {
  const pk = await provider.callFunction<string>({
    contractId: MPC,
    method: "derived_public_key",
    args: { path, predecessor, domain_id: 0 },
  });
  const raw = PublicKey.fromString(pk!).data; // 64 bytes x||y
  if (raw.length !== 64) throw new Error(`unexpected derived key length ${raw.length}`);
  return `0x${keccak256(raw).slice(-40)}` as Hex;
}

export type SignOut = { payload: string; big_r: string; s: string; recovery_id: number };

export function toRsv(sig: SignOut) {
  const r = `0x${sig.big_r.slice(2)}` as Hex; // drop the 02/03 prefix of the compressed point
  const s = `0x${sig.s}` as Hex;
  const lowS = BigInt(s) <= SECP256K1_N / 2n;
  return { r, s, v: 27 + sig.recovery_id, yParity: sig.recovery_id, lowS };
}

export async function recover(hash: Hex, sig: SignOut): Promise<Hex> {
  const { r, s, yParity } = toRsv(sig);
  return recoverAddress({ hash, signature: { r, s, yParity } });
}

/** Calls a hypernear method, returns the parsed SignOut, tx hash, wall time and gas/cost totals. */
export async function callSign(account: Account, contractId: string, methodName: string, args: object, deposit = 0n, tgasLimit = "300") {
  const t0 = performance.now();
  const res: any = await account.callFunctionRaw({
    contractId,
    methodName,
    args,
    gas: teraToGas(tgasLimit),
    deposit,
    waitUntil: "EXECUTED_OPTIMISTIC",
  });
  const ms = performance.now() - t0;
  const txHash: string = res.transaction_outcome.id;
  const outcomes = [res.transaction_outcome, ...res.receipts_outcome];
  const gasBurnt = outcomes.reduce((a: bigint, o: any) => a + BigInt(o.outcome.gas_burnt), 0n);
  const tokensBurnt = outcomes.reduce((a: bigint, o: any) => a + BigInt(o.outcome.tokens_burnt), 0n);
  const ok = res.status?.SuccessValue;
  if (ok === undefined) throw new Error(`tx ${txHash} failed: ${JSON.stringify(res.status)}`);
  const out = JSON.parse(Buffer.from(ok, "base64").toString()) as SignOut;
  return { out, txHash, ms, gasBurnt, tokensBurnt, receipts: res.receipts_outcome.length, res };
}

/** Deposits on every FunctionCall receipt of the tx, and refunds (transfers from "system" or MPC). */
export async function depositFlow(txHash: string, sender: string) {
  const st: any = await provider.viewTransactionStatusWithReceipts({ txHash, accountId: sender, waitUntil: "FINAL" });
  const rows: string[] = [];
  for (const r of st.receipts ?? []) {
    for (const a of r.receipt?.Action?.actions ?? []) {
      if (a.FunctionCall) rows.push(`${r.predecessor_id} -> ${r.receiver_id} ${a.FunctionCall.method_name} deposit=${a.FunctionCall.deposit} yocto`);
      if (a.Transfer) rows.push(`${r.predecessor_id} -> ${r.receiver_id} transfer=${a.Transfer.deposit} yocto`);
    }
  }
  return rows;
}

export const tgas = (g: bigint) => (Number(g) / 1e12).toFixed(2);
export const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

/** Block height and block time (ms) of every outcome of a tx result. */
export async function outcomeHeights(res: any): Promise<{ executor: string; height: number; ms: number }[]> {
  const out = [];
  for (const o of [res.transaction_outcome, ...res.receipts_outcome]) {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "block", params: { block_id: o.block_hash } }) });
    const h = (await r.json()).result.header;
    out.push({ executor: o.outcome.executor_id, height: h.height, ms: Number(BigInt(h.timestamp_nanosec) / 1_000_000n) });
  }
  return out;
}
