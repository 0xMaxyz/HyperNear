// The NEAR transport seam: HyperNearClient only talks to this interface, so tests can mock it.
import { Account, teraToGas, type KeyPairString } from 'near-api-js';
import { HyperNearContractError } from './errors';
import { ResilientProvider } from './rpc';

export const DEFAULT_RPC: Record<'testnet' | 'mainnet', string> = {
  testnet: 'https://test.rpc.fastnear.com',
  mainnet: 'https://free.rpc.fastnear.com',
};

export interface CallOptions {
  /** yoctoNEAR; default 0. A function-call key cannot attach any. */
  deposit?: bigint;
  /** default 100 TGas (a limited function-call allowance is held for the prepaid gas while the call is in flight). */
  gasTgas?: number;
}

export interface NearBackend {
  view<T>(contractId: string, method: string, args: Record<string, unknown>): Promise<T>;
  /** Sends a transaction from the configured sender; resolves with the decoded return value, throws HyperNearContractError on failure. */
  call<T>(contractId: string, method: string, args: Record<string, unknown>, opts?: CallOptions): Promise<{ txHash: string; value: T }>;
}

export function nearApiBackend(opts: { rpcUrl: string; sender?: Account }): NearBackend {
  const provider = new ResilientProvider(opts.rpcUrl);
  return {
    async view<T>(contractId: string, method: string, args: Record<string, unknown>) {
      return (await provider.callFunction({ contractId, method, args })) as T;
    },
    async call<T>(contractId: string, methodName: string, args: Record<string, unknown>, o: CallOptions = {}) {
      if (!opts.sender) throw new HyperNearContractError('no NEAR sender configured for calls');
      let res: any;
      try {
        res = await opts.sender.callFunctionRaw({
          contractId,
          methodName,
          args,
          gas: teraToGas(o.gasTgas ?? 100),
          deposit: o.deposit ?? 0n,
          waitUntil: 'EXECUTED_OPTIMISTIC',
        });
      } catch (e) {
        throw new HyperNearContractError(`${methodName} failed: ${(e as Error).message ?? e}`, { cause: e });
      }
      const ok = res?.status?.SuccessValue;
      if (ok === undefined) throw new HyperNearContractError(`${methodName} failed: ${JSON.stringify(res?.status)}`);
      const text = new TextDecoder().decode(Uint8Array.from(atob(ok), (c) => c.charCodeAt(0))); // browser-safe base64
      return { txHash: res.transaction_outcome.id as string, value: (text ? JSON.parse(text) : null) as T };
    },
  };
}

/** A near-api-js Account that signs with `secretKey` (full-access for a relayer, function-call for an agent). */
export function nearAccount(accountId: string, secretKey: string, rpcUrl: string): Account {
  return new Account(accountId, new ResilientProvider(rpcUrl), secretKey as KeyPairString);
}
