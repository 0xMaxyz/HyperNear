// C21 live run (testnet, SPIKE contract build): TEE mode end to end with a DEV-REGISTERED agent (register_tee_agent_dev, no
// TDX quote; on-chain quote verification is evidenced only by T0). Run on ci32:
//   LAB_WALLETS_PATH=~/secrets/lab-wallets.json NEAR_NETWORK=testnet node agent/scripts/tee-live.ts [--check]
// Two in-process agents run the real code in HYPERNEAR_RUN_MODE=tee, HYPERNEAR_TEE_DEV=1 (A = the owner's instance, B = a stranger:
// same image measurement, different dev seed). Owner = a throwaway key kept in ~/.hypernear-agent-data/tee-owner.key (0600; only its
// address is printed). Lab wallet #5 (index 1-10 only) funds the owner's three legs. Writes validation/results/C21.json.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { commandTypedData, exchangeBody, HyperNearClient, nearAccount, newCommand, ownerIntentTypedData, type OwnerIntent, type SignOut } from '@hypernear/client';
import { runClaim } from '../../validation/src/results.ts';
import { loadConfig } from '../src/config.ts';
import { fillOf } from '../src/hedge.ts';
import { agentKeySigner, hlClient, roundPx } from '../src/market.ts';
import { bootTeeRuntime, buildDeps, handler, type Deps } from '../src/server.ts';
import { OwnerScope } from '../src/tee.ts';

const RPC = 'https://test.rpc.fastnear.com';
const LAB_INDEX = Number(process.env.TEE_LAB_INDEX ?? 5); // lab wallets 1-10 only
const contractId = process.env.HYPERNEAR_CONTRACT ?? 'leash-spike-1107.testnet';
const serverAgentId = process.env.HYPERNEAR_AGENT_ACCOUNT_ID ?? `fcagent.${contractId}`;
const keyOf = (id: string) => JSON.parse(readFileSync(`${homedir()}/.near-credentials/testnet/${id}.json`, 'utf8')).private_key as string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, what: string, timeoutMs = 120_000, everyMs = 3000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await f();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

function labKey(): Hex {
  const row = (JSON.parse(readFileSync(process.env.LAB_WALLETS_PATH ?? '', 'utf8')) as { index: number; privateKey: string }[]).find((r) => r.index === LAB_INDEX);
  if (!row) throw new Error(`lab wallet ${LAB_INDEX} not in LAB_WALLETS_PATH`);
  return row.privateKey as Hex;
}
function ownerKey(): Hex {
  const dir = `${homedir()}/.hypernear-agent-data`;
  const file = `${dir}/tee-owner.key`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(file)) {
    writeFileSync(file, generatePrivateKey(), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return readFileSync(file, 'utf8').trim() as Hex;
}

const owner = privateKeyToAccount(ownerKey());
const ow = owner.address.toLowerCase() as Hex;
const relayerKey = keyOf(contractId);
const client = new HyperNearClient({ contractId, sender: nearAccount(contractId, relayerKey, RPC) });
const serverAgent = new HyperNearClient({ contractId, sender: nearAccount(serverAgentId, keyOf(serverAgentId), RPC) });
const dataDir = `${homedir()}/.leash-tee-live`;

const agentConfig = (seed: string) =>
  loadConfig({
    NEAR_NETWORK: 'testnet', NEAR_CONTRACT_ID: contractId, HYPERNEAR_RUN_MODE: 'tee', HYPERNEAR_TEE_DEV: '1', HYPERNEAR_TEE_DEV_SEED: seed,
    HYPERNEAR_TEE_FUND_NEAR: '0.35', HYPERNEAR_RELAYER_ACCOUNT_ID: contractId, HYPERNEAR_RELAYER_PRIVATE_KEY: relayerKey, HYPERNEAR_DATA_DIR: dataDir,
  });

const labAddr = privateKeyToAccount(labKey()).address.toLowerCase() as Hex;
const bootDeps = async (seed: string) => {
  const config = agentConfig(seed);
  const tee = await bootTeeRuntime(config);
  const deps = buildDeps(config, tee);
  const server = createServer(handler(deps));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { deps, tee, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};
type Agent = Awaited<ReturnType<typeof bootDeps>>;

const post = async (base: string, path: string, body: unknown) => {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};

const total = async (d: Deps, addr: Hex) => {
  const [c, s] = await Promise.all([d.legs.hl.clearinghouseState({ user: addr }), d.legs.hl.spotClearinghouseState({ user: addr })]);
  return { perp: Number(c.marginSummary.accountValue), spot: Number(s.balances.find((b) => b.coin === 'USDC')?.total ?? 0) };
};

/** gas actually burnt by a transaction and all its receipts, in TGas */
async function gasBurntTgas(txHash: string) {
  const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'EXPERIMENTAL_tx_status', params: { tx_hash: txHash, sender_account_id: contractId, wait_until: 'FINAL' } }) })).json() as any;
  const o = r.result;
  return (o.transaction_outcome.outcome.gas_burnt + o.receipts_outcome.reduce((a: number, x: any) => a + x.outcome.gas_burnt, 0)) / 1e12;
}

/** the agent account's own transactions (shade-agent-js hides the hashes): best effort from the NEAR indexer */
async function accountTxns(account: string) {
  try {
    const r = (await (await fetch(`https://api-testnet.nearblocks.io/v1/account/${account}/txns?per_page=25`)).json()) as any;
    return (r.txns ?? []).map((t: any) => ({ hash: t.transaction_hash, method: t.actions?.[0]?.method, ok: t.outcomes?.status }));
  } catch (e) {
    return `nearblocks unavailable: ${(e as Error).message}`;
  }
}

const cfg = await client.getConfig();
const lab = hlClient('testnet', { master: agentKeySigner(labKey()), agent: agentKeySigner(labKey()) });
console.log(`owner ${ow}; lab wallet #${LAB_INDEX} ${labAddr}; contract ${contractId}`);
if (process.argv.includes('--check')) {
  const hlq = hlClient('testnet');
  const [c, s] = await Promise.all([hlq.clearinghouseState({ user: labAddr }), hlq.spotClearinghouseState({ user: labAddr })]);
  console.log(`lab perp $${c.marginSummary.accountValue}, spot $${s.balances.find((b) => b.coin === 'USDC')?.total ?? 0}`);
  process.exit(0);
}

await runClaim('C21', 'C21', 'TEE mode, dev-registered agent (register_tee_agent_dev, no TDX quote): measurement and instance bound, paid in HL, keys burned on exit', async (rec) => {
  rec.notes.push('Testnet results are DEV-REGISTERED (register_tee_agent_dev): no TDX quote. On-chain quote verification is evidenced only by T0 (tx 4QTqwX..., 187 TGas).');
  const checks: Record<string, { pass: boolean; detail?: unknown }> = {};
  const step = async (name: string, f: () => Promise<unknown>) => {
    try {
      const detail = await f();
      checks[name] = { pass: true, detail };
      console.log(`PASS ${name}`);
    } catch (e) {
      checks[name] = { pass: false, detail: (e as Error).message };
      console.log(`FAIL ${name}: ${(e as Error).message}`);
    }
  };
  const must = (c: unknown, msg: string) => {
    if (!c) throw new Error(msg);
  };
  const intent = async (a: Agent, i: OwnerIntent) => {
    const nonce = await client.getOwnerNonce(ow);
    const sig = await owner.signTypedData(ownerIntentTypedData({ chainTag: cfg.chain_tag, contractId, owner: ow, nonce, intent: i }) as never);
    return post(a.base, '/relay', { owner: ow, nonce, intent: i, sig });
  };
  const prepare = async (a: Agent) => {
    const command = newCommand(ow, 'prepareAgents', '');
    return post(a.base, '/agents/prepare', { command, sig: await owner.signTypedData(commandTypedData(cfg.chain_tag, contractId, command) as never) });
  };

  // ---- agents: A (the owner's instance) and B (a stranger: same image, other dev seed)
  const A = await bootDeps('c21-a');
  const B = await bootDeps('c21-b');
  rec.refs.agentA = A.tee.account;
  rec.refs.agentB = B.tee.account;
  rec.refs.measurementHash = A.tee.measurementHash;
  await step('B has the same measurement as A (stranger instance of the same image)', async () => {
    must(A.tee.measurementHash === B.tee.measurementHash && A.tee.account !== B.tee.account, 'expected one measurement, two accounts');
    return { hash: A.tee.measurementHash };
  });

  // ---- owner, three legs, funded
  const legAddr: Hex[] = [];
  for (const leg of [0, 1, 2]) legAddr.push(await client.registerLeg(ow, leg));
  rec.refs.owner = ow;
  rec.refs.legs = legAddr;
  for (const [leg, usd] of [[0, 6], [1, 2], [2, 2]] as const) {
    const t = await total(A.deps, legAddr[leg]!);
    if (t.perp + t.spot < (leg === 0 ? 4 : 0.9)) {
      const r = await lab.usdSend({ destination: legAddr[leg]!, amount: String(usd) });
      console.log(`lab #${LAB_INDEX} -> leg ${leg}: $${usd} ${JSON.stringify(r)}`);
      await until(() => total(A.deps, legAddr[leg]!), (b) => b.perp + b.spot >= (leg === 0 ? 4 : 0.9), `leg ${leg} funding`);
    }
  }

  // a TEE run left over from an earlier attempt: leave it first, and set the policy the server agent is named in
  const before = await client.getTee(ow);
  if (before?.measurement_hash) await intent(A, { type: 'setTee', measurementHash: `0x${'00'.repeat(32)}`, agentAccount: '' });
  await intent(A, { type: 'setPolicy', agent: serverAgentId, dailyCap: '5', cooldownSec: 1 });

  // ---- setTee names A's stable account; not paid yet -> A refuses
  await step('owner signs setTee (measurement + the TEE account)', async () => {
    const r = await intent(A, { type: 'setTee', measurementHash: A.tee.measurementHash as Hex, agentAccount: A.tee.account });
    must(r.status === 200, JSON.stringify(r.body));
    rec.refs.setTeeTx = r.body.txHash;
    const t = await client.getTee(ow);
    must(t?.measurement_hash === A.tee.measurementHash && t.agent_account === A.tee.account, `get_tee ${JSON.stringify(t)}`);
    return { tx: r.body.txHash, kind: r.body.kind };
  });
  await step('before payTee the TEE agent refuses to serve the owner', async () => {
    const r = await prepare(A);
    must(r.status === 403, `status ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.error;
  });

  // ---- payTee 1 month: the contract signs the usdSend, the relayer posts it to HL
  await step('payTee 1 month: usdSend to the fee address lands in the HL ledger', async () => {
    const r = await intent(A, await client.payTeeIntent(0, 1));
    must(r.status === 200 && r.body.kind === 'payTee' && r.body.ok === true, JSON.stringify(r.body));
    rec.refs.payTeeTx = r.body.txHash;
    rec.refs.payTeeHl = r.body.hl;
    const fee = cfg.tee_fee_address!.toLowerCase();
    const rows = await until(
      async () => (await A.deps.legs.hl.userNonFundingLedgerUpdates({ user: legAddr[0]!, startTime: 0 })).filter((u) => String((u.delta as any).destination).toLowerCase() === fee),
      (x) => x.length > 0, 'the usdSend in the HL ledger', 90_000,
    );
    rec.refs.ledgerRows = rows.slice(-3);
    return { tx: r.body.txHash, ledger: rows.at(-1) };
  });

  // ---- the stranger B is refused (the owner named A); A enrols the legs
  await step('stranger instance B (same measurement, other account) is refused: HTTP and contract', async () => {
    const r = await prepare(B);
    must(r.status === 403, `B prepare ${r.status}`);
    let contractErr = '';
    await B.tee.client.teeApproveAgent({ owner: ow, leg: 0, hlAddress: `0x${'12'.repeat(20)}`, hlNonce: Date.now() }).catch((e) => (contractErr = (e as Error).message));
    must(/not the owner's TEE agent/.test(contractErr), `contract said: ${contractErr}`);
    return { http: r.body.error, contract: contractErr.slice(0, 160) };
  });
  let enrolled: any;
  await step('A enrols: fresh in-memory key per leg, tee_approve_agent, approveAgent posted to HL (3 legs)', async () => {
    const r = await until(() => prepare(A), (x) => !(x.status === 403 && /not a paid TEE owner/.test(x.body.error)), 'A serving the owner (fee in ledger, 5 s negative cache)', 90_000, 6000);
    must(r.status === 200 && r.body.legs.length === 3 && r.body.legs.every((l: any) => l.ok), JSON.stringify(r.body));
    enrolled = r.body.legs;
    for (const l of enrolled) {
      const agents = await A.deps.legs.hl.extraAgents({ user: legAddr[l.leg]! });
      must(agents.some((a) => a.address.toLowerCase() === l.agent && a.name === 'leash-tee'), `leg ${l.leg}: HL does not list the leash-tee key`);
    }
    return enrolled.map((l: any) => ({ leg: l.leg, agent: l.agent }));
  });
  await step('no key was written to disk by the TEE agent', async () => {
    must(!existsSync(`${dataDir}/agent-keys.json`), 'agent-keys.json exists');
    return true;
  });

  // ---- a TEE rebalance (the legs hold their USDC in the perp account: a usdSend moves perp balance)
  await step('TEE rebalance accepted (leg0 -> leg1) and posted to HL', async () => {
    const out = (await A.tee.client.rebalance({ owner: ow, fromLeg: 0, toAddress: legAddr[1]!, amount: '1', hlTime: Date.now() })).value as SignOut;
    const hl = (await A.deps.relayer.post!(exchangeBody(out, 'Testnet'))) as { status?: string };
    must(hl.status === 'ok', JSON.stringify(hl));
    return hl;
  });
  await step('server-mode agent rebalance for the TEE owner is refused by the contract', async () => {
    let err = '';
    await serverAgent.rebalance({ owner: ow, fromLeg: 0, toAddress: legAddr[1]!, amount: '1', hlTime: Date.now() }).catch((e) => (err = (e as Error).message));
    must(/TEE/.test(err), `expected a TEE refusal, got: ${err || 'accepted'}`);
    return err.slice(0, 200);
  });
  await step("the owner's own approveAgent is refused while in TEE mode", async () => {
    const r = await intent(A, { type: 'approveAgent', leg: 0, agent: `0x${'34'.repeat(20)}`, agentName: 'hypernear-own', hlNonce: Date.now() });
    must(r.status >= 400 && /TEE mode/.test(JSON.stringify(r.body)), `${r.status} ${JSON.stringify(r.body)}`);
    return r.body.error;
  });

  // ---- the leash-tee key trades now; setTee to zero burns it (3 keys in one tx) and the key's order is then rejected
  rec.numbers.leg0PerpBeforeOrder = (await total(A.deps, legAddr[0]!)).perp;
  const universe = await A.deps.legs.snapshot(ow);
  const btc = universe.market.assets.find((a) => a.name === 'BTC')!;
  const px = roundPx(Number(universe.market.mids.BTC) * 0.5, btc.szDecimals);
  const size = (Math.ceil((11 / Number(px)) * 10 ** btc.szDecimals) / 10 ** btc.szDecimals).toFixed(btc.szDecimals);
  const order = () => A.deps.legs.tradingClient(ow, 0).limitOrderOpen({ asset: btc.asset, isBuy: true, price: px, size, tif: 'Gtc' });
  await step('the leash-tee key trades leg0 (resting order, then cancelled)', async () => {
    const oid = fillOf(await order()).oid;
    await A.deps.legs.tradingClient(ow, 0).batchCancel({ cancels: [{ a: btc.asset, o: Number(oid) }] });
    return { oid };
  });
  await step('setTee to zero: Revoked[] burns the 3 leash-tee keys, posted to HL; gas recorded', async () => {
    const r = await intent(A, { type: 'setTee', measurementHash: `0x${'00'.repeat(32)}`, agentAccount: '' });
    must(r.status === 200 && r.body.kind === 'teeSwitch' && r.body.revoked.length === 3 && r.body.revoked.every((x: any) => x.ok), JSON.stringify(r.body));
    rec.refs.leaveTx = r.body.txHash;
    rec.numbers.leaveGasBurntTgas = await gasBurntTgas(r.body.txHash);
    rec.numbers.leaveKeysBurned = r.body.revoked.length;
    return { tx: r.body.txHash, revoked: r.body.revoked.map((x: any) => ({ leg: x.leg, ok: x.ok })), gasTgas: rec.numbers.leaveGasBurntTgas };
  });
  await step("the burned leash-tee key's order is rejected by HL", async () => {
    await sleep(2000);
    let res: unknown;
    try {
      res = await order();
    } catch (e) {
      return { rejected: (e as Error).message.slice(0, 200) };
    }
    const s = JSON.stringify(res);
    if (/"status":"ok"/.test(s) && !/error/i.test(s)) throw new Error(`HL accepted the order of a burned key: ${s.slice(0, 200)}`);
    return { rejected: s.slice(0, 200) };
  });
  await step('after leaving, a server-mode scope serves the owner again (get_tee entry kept, hash null)', async () => {
    const t = await client.getTee(ow);
    const server = new OwnerScope({ mode: 'server', client });
    must(t !== null && t.measurement_hash === null, `get_tee ${JSON.stringify(t)}`);
    must(await server.serves(ow), 'server scope still refuses');
    return { months_paid: t!.months_paid, paid_until_ns: t!.paid_until_ns };
  });

  rec.refs.agentATxns = await accountTxns(A.tee.account);
  rec.refs.agentBTxns = await accountTxns(B.tee.account);
  rec.refs.checks = checks;
  const failed = Object.entries(checks).filter(([, c]) => !c.pass).map(([n]) => n);
  rec.numbers.checksPassed = Object.keys(checks).length - failed.length;
  rec.numbers.checksTotal = Object.keys(checks).length;
  if (failed.length) rec.fail(`failed: ${failed.join('; ')}`);
  for (const s of [A.server, B.server] as Server[]) s.close();
});
process.exit(0);
