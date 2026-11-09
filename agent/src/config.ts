// Agent service configuration, all from env. Secrets are read here and never logged.

export interface OrderPolicy {
  /** Highest leverage the agent will set or trade at. */
  maxLeverage: number;
  /** Largest notional (USD) of one hedge order. */
  maxNotionalUsd: number;
  allowedCoins: string[];
  /** IOC limit price = mid * (1 +- slippage). */
  slippage: number;
}

export interface AgentConfig {
  network: 'testnet' | 'mainnet';
  contractId: string;
  nearRpcUrl?: string;
  /** Leg agent keys (HL API wallets) live here, in agent-keys.json, mode 0600. */
  dataDir: string;
  /** NEAR relayer (full-access key: pays storage deposits for owner intents). */
  relayer?: { accountId: string; secretKey: string };
  /** NEAR agent account (function-call key limited to rebalance / agent_usd_class_transfer). */
  nearAgent?: { accountId: string; secretKey: string };
  policy: OrderPolicy;
  /** server (default): owners who did not opt in to TEE. tee: only TEE-mode owners; keys in memory, account from shade-agent-js. */
  runMode: 'server' | 'tee';
  tee: {
    /** the published measurement hash of this image; boot refuses to serve if the registered one differs */
    measurement?: string;
    /** testnet spike: register_tee_agent_dev (no quote) */
    dev: boolean;
    /** dev only: the NEAR account is derived from this (in a real CVM it comes from dstack getKey) */
    devSeed?: string;
    /** NEAR sent to the agent's fresh account from the relayer when it is empty */
    fundNear: number;
  };
  /** POST /relay requests per IP per minute. */
  relayPerMinute: number;
  port: number;
  /** decision layer: live when both model keys are set (the SDKs read them from env) */
  decide: { live: boolean; intervalSec: number };
  guard: {
    intervalSec: number;
    /** trigger at accountValue / maintenance <= this (plan: 2) */
    marginFloor: number;
    latencyP95Sec: number;
    /** USD of the contract's daily cap kept for the hedge guard; strategies cannot budget it (at most half the cap applies) */
    hedgeReserveUsd: number;
    annualVol: number;
    /** extra owners to watch besides those we hold agent keys for */
    watchOwners: string[];
  };
}

const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));

function keyPair(idVar: string, keyVar: string, env: NodeJS.ProcessEnv) {
  const accountId = env[idVar];
  const secretKey = env[keyVar];
  return accountId && secretKey ? { accountId, secretKey } : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  // register_tee_agent_dev and the dev seed exist only for testnet; fail loudly rather than at boot.
  if (env.HYPERNEAR_TEE_DEV === '1' && env.NEAR_NETWORK === 'mainnet') throw new Error('HYPERNEAR_TEE_DEV=1 is testnet-only; unset it for mainnet');
  return {
    network: env.NEAR_NETWORK === 'mainnet' ? 'mainnet' : 'testnet',
    contractId: env.NEAR_CONTRACT_ID ?? 'leash-spike-1107.testnet',
    nearRpcUrl: env.NEAR_RPC_URL || undefined,
    dataDir: env.HYPERNEAR_DATA_DIR ?? './.hypernear-data',
    // two separate keys on purpose: the relayer can pay deposits, the agent key can only call the agent methods
    relayer: keyPair('HYPERNEAR_RELAYER_ACCOUNT_ID', 'HYPERNEAR_RELAYER_PRIVATE_KEY', env),
    nearAgent: keyPair('HYPERNEAR_AGENT_ACCOUNT_ID', 'HYPERNEAR_AGENT_PRIVATE_KEY', env),
    policy: {
      maxLeverage: num(env.HYPERNEAR_MAX_LEVERAGE, 5),
      maxNotionalUsd: num(env.HYPERNEAR_MAX_NOTIONAL_USD, 100),
      allowedCoins: (env.HYPERNEAR_ALLOWED_COINS ?? 'BTC,ETH').split(',').map((s) => s.trim()).filter(Boolean),
      slippage: num(env.HYPERNEAR_SLIPPAGE, 0.03),
    },
    runMode: env.HYPERNEAR_RUN_MODE === 'tee' ? 'tee' : 'server',
    tee: { measurement: env.HYPERNEAR_TEE_MEASUREMENT || undefined, dev: env.HYPERNEAR_TEE_DEV === '1', devSeed: env.HYPERNEAR_TEE_DEV_SEED || undefined, fundNear: num(env.HYPERNEAR_TEE_FUND_NEAR, 1) },
    relayPerMinute: num(env.HYPERNEAR_RELAY_PER_MINUTE, 20),
    port: num(env.PORT, 8787),
    decide: { live: Boolean(env.TYPESAFE_API_KEY && env.ANTHROPIC_API_KEY), intervalSec: num(env.HYPERNEAR_DECIDE_INTERVAL_SEC, 300) },
    guard: {
      intervalSec: num(env.HYPERNEAR_GUARD_INTERVAL_SEC, 10),
      marginFloor: num(env.HYPERNEAR_GUARD_MARGIN_FLOOR, 2),
      latencyP95Sec: num(env.HYPERNEAR_GUARD_LATENCY_SEC, 9),
      hedgeReserveUsd: num(env.HYPERNEAR_HEDGE_RESERVE_USD, 20),
      annualVol: num(env.HYPERNEAR_GUARD_ANNUAL_VOL, 0.6),
      watchOwners: (env.HYPERNEAR_WATCH_OWNERS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    },
  };
}

