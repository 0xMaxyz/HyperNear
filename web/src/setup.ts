// The five setup steps and what "funded" means, as pure functions (the Setup page, the banner and the Account menu read the same list).
//
// A leg is funded when it holds any money. The agent already reports a unified leg's equity in `accountValue` and `spotUsdc` 0 (agent/src/funds.ts),
// and a default-mode leg's spot balance in `spotUsdc`, so the sum is the money in both modes. Only the legs the setup flow creates (0 and 1) have to
// be funded for the step: an empty reserve leg 2 or an extra leg 3 must not keep it "to do" for ever.

export interface SetupLeg {
  leg: number;
  clearinghouse: { marginSummary: { accountValue: string } };
  spotUsdc: number;
  agent: { approvedAt?: number | null } | null;
}

/** The legs the Create-legs step registers. */
export const SETUP_LEGS: readonly number[] = [0, 1];

/** accountValue + spot USDC; a value that is not a number counts as no money. */
export function legMoney(l: Pick<SetupLeg, 'clearinghouse' | 'spotUsdc'>): number {
  const v = Number(l.clearinghouse.marginSummary.accountValue) + Number(l.spotUsdc);
  return Number.isFinite(v) ? v : 0;
}

export const isFunded = (l: Pick<SetupLeg, 'clearinghouse' | 'spotUsdc'>): boolean => legMoney(l) > 0;

/** Hyperliquid refuses every action, approving a key included, on an account that never received a deposit: only a funded leg can be approved. */
export const canApprove = (leg: number, legs: SetupLeg[]): boolean => {
  const l = legs.find((x) => x.leg === leg);
  return Boolean(l && isFunded(l));
};

export interface SetupInput {
  registered: ReadonlySet<number>;
  /** legs the service knows (view.legs): `needsPrepare` or no agent means the owner still has to prepare keys */
  topLegs: { agent: unknown; needsPrepare?: boolean }[];
  legs: SetupLeg[];
  /** the contract policy names an agent */
  policyAgent: boolean;
}

/** [create legs, prepare agents, fund, approve agent, enable agent] */
export function setupSteps(i: SetupInput): [boolean, boolean, boolean, boolean, boolean] {
  const core = i.legs.filter((l) => SETUP_LEGS.includes(l.leg));
  return [
    SETUP_LEGS.every((n) => i.registered.has(n)),
    i.topLegs.length > 0 && i.topLegs.every((l) => l.agent && !l.needsPrepare),
    core.length > 0 && core.every(isFunded),
    core.length > 0 && core.every((l) => Boolean(l.agent?.approvedAt)),
    i.policyAgent,
  ];
}
