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
  /** POST /relay requests per IP per minute. */
  relayPerMinute: number;
  port: number;
}

const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));

function keyPair(idVar: string, keyVar: string, env: NodeJS.ProcessEnv) {
  const accountId = env[idVar];
  const secretKey = env[keyVar];
  return accountId && secretKey ? { accountId, secretKey } : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
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
    relayPerMinute: num(env.HYPERNEAR_RELAY_PER_MINUTE, 20),
    port: num(env.PORT, 8787),
  };
}

