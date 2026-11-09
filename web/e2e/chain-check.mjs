// The page's own TEE chain reads (src/tee.ts: get_config, get_tee, get_tee_agent) against the real testnet contract.
// Usage, from web/:  node e2e/chain-check.mjs [contractId] [owner]   (defaults: leash-spike-1107.testnet, the C21 owner)
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const contractId = process.argv[2] ?? 'leash-spike-1107.testnet';
const owner = process.argv[3] ?? '0x46d40d33867af6d04c33888e943b1d569a3f5050'; // validation/results/C21.json refs.owner
const out = join(tmpdir(), `leash-tee-${process.pid}.mjs`);
await build({ entryPoints: [fileURLToPath(new URL('../src/tee.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error', define: { 'import.meta.env': '{}' } });
const tee = await import(out);

const ctx = { dryRun: false, chainTag: 'near-testnet', contractId };
let bad = 0;
const check = (name, ok, detail = '') => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

const s = await tee.loadTee(owner, ctx);
console.log(JSON.stringify(s));
check('get_config: TEE price and fee address are set', Boolean(s.priceUsd) && /^0x[0-9a-fA-F]{40}$/.test(s.feeAddress ?? ''), `${s.priceUsd} -> ${s.feeAddress}`);
check('priceMicro parses to a whole number of micro-USD', Number.isInteger(tee.priceMicro(s.priceUsd)) && tee.priceMicro(s.priceUsd) > 0, String(tee.priceMicro(s.priceUsd)));
check('get_tee: the C21 owner has an entry', s.tee !== null);
check('get_tee: left TEE mode, measurement_hash is null (entry kept)', s.tee?.measurement_hash === null && tee.inTeeMode(s) === false, JSON.stringify(s.tee?.measurement_hash));
check('get_tee: months_paid and paid_until_ns read as numbers', Number(s.tee?.months_paid) >= 1 && BigInt(s.tee?.paid_until_ns ?? 0) > 0n, `${s.tee?.months_paid} months, paid until ${tee.nsToDate(s.tee.paid_until_ns).toISOString()}`);
check('no agent account after leaving', s.tee?.agent_account === null && s.agent === null);

// the two TEE agents C21 registered (validation/results/C21.json refs.agentA, agentB): the record may have expired, null is a fine answer, a parse error is not
for (const a of ['dc1f7b662daca02dbac0e71a4ff123f1e5b4725d4b9f5e4b19da04cdeb7d5ce3', '92dd6c5e008f1a41e816ad9027d6f03dcd7f555e279c1bd9e0cc78d5e855d9b6']) {
  const r = await tee.lookupTeeAgent(a, ctx).then((v) => ({ v }), (e) => ({ e }));
  check(`get_tee_agent(${a.slice(0, 8)}…) parses`, !r.e && (r.v === null || /^0x[0-9a-f]{64}$/.test(r.v.measurement_hash)), r.e ? r.e.message : JSON.stringify(r.v));
  if (r.v) check('  expiry reads as a date', !Number.isNaN(tee.nsToDate(r.v.expires_ns).getTime()), tee.nsToDate(r.v.expires_ns).toISOString());
}
const none = await tee.lookupTeeAgent('nobody-here.testnet', ctx).then((v) => v, (e) => `ERR ${e.message}`);
check('get_tee_agent of an unknown account is null', none === null, JSON.stringify(none));
const nobody = await tee.loadTee('0x0000000000000000000000000000000000000001', ctx);
check('an owner with no TEE entry reads as not in TEE mode', nobody.tee === null && !tee.inTeeMode(nobody));

// a browser asks with an Origin header: the RPC must answer with CORS headers
const rpc = 'https://test.rpc.fastnear.com';
const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'status', params: [] }) });
const acao = r.headers.get('access-control-allow-origin');
check('testnet RPC answers an Origin request with access-control-allow-origin', Boolean(acao), String(acao));
const pre = await fetch(rpc, { method: 'OPTIONS', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
check('testnet RPC answers the CORS preflight (content-type allowed)', pre.status < 300 && /content-type/i.test(pre.headers.get('access-control-allow-headers') ?? ''), `${pre.status} ${pre.headers.get('access-control-allow-headers')}`);

console.log(bad ? 'SOME FAILED' : 'ALL PASS');
process.exit(bad ? 1 : 0);
