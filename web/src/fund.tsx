import { useEffect, useRef, useState } from 'react';
import { ApiError, getJson, post, type LegSnap, type OwnerView } from './api';
import { short, usd } from './panels';

interface FundToken {
  assetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
  price: number;
  label: string;
}
interface FundInfo {
  network: 'testnet' | 'mainnet';
  realDeposits: boolean;
  minUsd: number;
  maxUsd: number;
  tokens: FundToken[];
  tokenList: 'live' | 'fallback';
}
interface FundQuote {
  dry: boolean;
  token: string;
  amountIn: number;
  amountInUsd: number | null;
  amountOut: number;
  expectedCredit: number;
  activationFeeUsd: number;
  firstTransferOutFeeUsd: number;
  withdrawFeeUsd: number;
  etaSec: number | null;
  depositAddress: string | null;
  deadline: string | null;
}

/** 1Click statuses, in words. Anything unknown is shown as it came. */
const STATUS: Record<string, string> = {
  PENDING_DEPOSIT: 'Waiting for your deposit to arrive at the address.',
  KNOWN_DEPOSIT_TX: 'Your deposit was seen. Waiting for it to confirm.',
  PROCESSING: 'Swapping and sending to your leg…',
  SUCCESS: 'Done. The USDC is on your leg\'s spot balance.',
  INCOMPLETE_DEPOSIT: 'The amount received is less than the quote. Send the rest before the deadline, or it is refunded.',
  REFUNDED: 'The swap did not happen and your money was sent back to your refund address.',
  FAILED: 'The swap failed. Check your refund address for the money.',
};
const DONE = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);
const EVM_CHAINS = new Set(['eth', 'arb', 'base', 'op', 'pol', 'bsc', 'avax']);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Props {
  view?: OwnerView;
  owner?: string;
  /** from a leg card: #/fund?leg=2 */
  leg?: number;
  canSign: boolean;
  dry: boolean;
  locked: boolean;
  busy: string | null;
  why?: string;
  onGo: (to: string) => void;
  /** sign and send a usdClassTransfer (spot to trading balance) */
  onMove: (leg: number, amount: string) => void;
  /** sign and send a withdraw to the owner's own wallet */
  onWithdraw: (leg: number, amount: string) => void;
  /** a refresh of the owner view (after a simulated credit) */
  onChanged: () => void;
}


/** Hyperliquid's withdrawal fee, taken from the amount: the owner receives amount - 1. A withdrawal must exceed it. */
const WITHDRAW_FEE = 1;

/** Money leaves a leg only to the owner's own wallet (the contract signs it with no destination field). Pure rules: only the trading balance can be withdrawn. */
function WithdrawCard({ leg, owner, network, locked, busy, why, onWithdraw, onMove }: { leg: LegSnap; owner?: string; network?: string; locked: boolean; busy: string | null; why?: string; onWithdraw: (leg: number, amount: string) => void; onMove: (leg: number, amount: string) => void }) {
  const free = Number(leg.clearinghouse.withdrawable);
  const holds = leg.clearinghouse.assetPositions.some((a) => Number(a.position.szi) !== 0);
  const [amt, setAmt] = useState<string>();
  const value = amt ?? (free > WITHDRAW_FEE ? free.toFixed(2) : '');
  const num = Number(value);
  const ok = /^\d+(\.\d{1,6})?$/.test(value) && num > WITHDRAW_FEE && num <= free + 1e-9;
  const stuckOnSpot = free <= WITHDRAW_FEE && leg.spotUsdc > WITHDRAW_FEE;
  return (
    <section className="card" aria-labelledby="wd-h">
      <h2 id="wd-h">Withdraw to my wallet</h2>
      <p className="muted small">
        Pays {owner ? short(owner) : 'your owner address'} on {network === 'mainnet' ? 'Arbitrum' : 'Arbitrum Sepolia'}. There is no other destination: the contract signs the withdrawal without one. Hyperliquid charges {usd(WITHDRAW_FEE)}, so you receive the amount minus that, usually within minutes.
      </p>
      <dl className="kv">
        <dt>Can be withdrawn from leg {leg.leg}</dt>
        <dd>{usd(free)}</dd>
      </dl>
      {holds && <p className="state small">This leg has an open position; the amount above already leaves its margin in place. Withdrawing more would need the position reduced first.</p>}
      {stuckOnSpot ? (
        <>
          <p className="state small">{usd(leg.spotUsdc)} sits on the spot balance, and only the trading balance can be withdrawn. Move it first.</p>
          <div className="actions"><button disabled={locked} title={why} onClick={() => onMove(leg.leg, leg.spotUsdc.toFixed(2))}>Move {usd(leg.spotUsdc)} to the trading balance</button></div>
        </>
      ) : (
        <>
          <div className="fields inline">
            <label>
              Amount, USDC
              <input value={value} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" aria-invalid={value !== '' && !ok} />
            </label>
            <button style={{ alignSelf: 'end' }} onClick={() => setAmt(free.toFixed(2))} disabled={free <= WITHDRAW_FEE}>Max</button>
          </div>
          <p className="muted small">{ok ? `You receive ${usd(num - WITHDRAW_FEE)}.` : free <= WITHDRAW_FEE ? 'Nothing to withdraw yet: the trading balance must be above the fee.' : `Enter more than ${usd(WITHDRAW_FEE)} and at most ${usd(free)}.`}</p>
          <div className="actions">
            <button className="primary" disabled={locked || !ok} title={why} onClick={() => (onWithdraw(leg.leg, value), setAmt(undefined))}>
              {busy === 'withdraw' ? 'Waiting for signature…' : 'Withdraw'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

export function FundTab({ view, owner, leg: legParam, canSign, dry, locked, busy, why, onGo, onMove, onWithdraw, onChanged }: Props) {
  const legs = view?.snapshot.legs ?? [];
  const [legNo, setLegNo] = useState<number | undefined>(legParam);
  const active: LegSnap | undefined = legs.find((l) => l.leg === legNo) ?? legs.find((l) => l.leg === legParam) ?? legs[0];
  useEffect(() => setLegNo(legParam), [legParam]);

  const [info, setInfo] = useState<{ state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; data: FundInfo }>({ state: 'loading' });
  const [token, setToken] = useState<string>();
  const [amount, setAmount] = useState('10');
  const [refund, setRefund] = useState('');
  const [quote, setQuote] = useState<{ state: 'idle' } | { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; q: FundQuote }>({ state: 'idle' });
  const [deposit, setDeposit] = useState<FundQuote>();
  const [status, setStatus] = useState<string>();
  const [credit, setCredit] = useState('25');
  const [moveAmt, setMoveAmt] = useState<string>();
  const [copied, setCopied] = useState<string>();
  const seq = useRef(0);

  useEffect(() => {
    let live = true;
    getJson<FundInfo>('/fund/info').then(
      (data) => {
        if (!live) return;
        setInfo({ state: 'ok', data });
        // an EVM token first: the owner's own address is then a valid refund address with nothing to type
        setToken((t) => t ?? (data.tokens.find((x) => EVM_CHAINS.has(x.blockchain)) ?? data.tokens[0])?.assetId);
      },
      (e) => live && setInfo({ state: 'error', message: msg(e) }),
    );
    return () => {
      live = false;
    };
  }, []);

  const tok = info.state === 'ok' ? info.data.tokens.find((t) => t.assetId === token) : undefined;
  // EVM refund addresses default to the owner's own: it is the same key on every EVM chain
  useEffect(() => {
    if (tok && EVM_CHAINS.has(tok.blockchain) && owner) setRefund((r) => (r === '' || /^0x[0-9a-fA-F]{40}$/.test(r) ? owner : r));
    if (tok && !EVM_CHAINS.has(tok.blockchain)) setRefund((r) => (/^0x[0-9a-fA-F]{40}$/.test(r) ? '' : r));
  }, [tok?.assetId, owner]); // eslint-disable-line react-hooks/exhaustive-deps

  // the preview is a dry quote: it changes nothing, so it re-runs whenever an input changes
  useEffect(() => {
    setDeposit(undefined);
    setStatus(undefined);
    if (!owner || !active || !token || !amount || !refund) {
      setQuote({ state: 'idle' });
      return;
    }
    const n = ++seq.current;
    setQuote({ state: 'loading' });
    const t = setTimeout(async () => {
      try {
        const q = (await post('/fund/quote', { owner, leg: active.leg, token, amount, refundTo: refund, dry: true })) as unknown as FundQuote;
        if (n === seq.current) setQuote({ state: 'ok', q });
      } catch (e) {
        if (n === seq.current) setQuote({ state: 'error', message: e instanceof ApiError ? e.message : msg(e) });
      }
    }, 500);
    return () => clearTimeout(t);
  }, [owner, active?.leg, token, amount, refund]); // eslint-disable-line react-hooks/exhaustive-deps

  // a real deposit address: poll until the swap ends
  useEffect(() => {
    const addr = deposit?.depositAddress;
    if (!addr) return;
    let live = true;
    const poll = async () => {
      try {
        const s = await getJson<{ status: string }>(`/fund/status?depositAddress=${encodeURIComponent(addr)}`);
        if (!live) return;
        setStatus(s.status);
        if (DONE.has(s.status)) {
          onChanged();
          return;
        }
      } catch {
        /* keep the last status; the next tick tries again */
      }
      if (live) setTimeout(poll, 5000);
    };
    void poll();
    return () => {
      live = false;
    };
  }, [deposit?.depositAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied((c) => (c === text ? undefined : c)), 1500);
    } catch {
      setCopied(undefined);
    }
  };
  const [err, setErr] = useState<string>();
  const getAddress = async () => {
    if (!owner || !active || !token) return;
    setErr(undefined);
    try {
      setDeposit((await post('/fund/quote', { owner, leg: active.leg, token, amount, refundTo: refund, dry: false })) as unknown as FundQuote);
    } catch (e) {
      setErr(msg(e));
    }
  };
  const simulate = async () => {
    if (!owner || !active) return;
    setErr(undefined);
    try {
      await post('/fund/credit', { owner, leg: active.leg, amount: Number(credit) });
      onChanged();
    } catch (e) {
      setErr(msg(e));
    }
  };

  if (!view || legs.length === 0 || !active) {
    return (
      <section className="card" aria-labelledby="fund-h">
        <h2 id="fund-h">Fund a leg</h2>
        <p className="state">{view ? 'No legs yet. Create them on the Home tab first.' : 'Waiting for data.'}</p>
      </section>
    );
  }

  const spot = active.spotUsdc;
  const perp = Number(active.clearinghouse.marginSummary.accountValue);
  const real = info.state === 'ok' && info.data.realDeposits;
  const maxMove = Math.floor(spot * 1e6) / 1e6;
  const moveValue = moveAmt ?? String(maxMove);
  const moveOk = /^\d+(\.\d{1,6})?$/.test(moveValue) && Number(moveValue) > 0 && Number(moveValue) <= maxMove + 1e-9;

  return (
    <>
      <section className="card" aria-labelledby="fund-h">
        <h2 id="fund-h">Fund a leg</h2>
        <p className="muted small">
          A leg is a Hyperliquid account. Money goes to a leg's <strong>spot balance</strong> in USDC; to trade with it you then move it to the <strong>trading balance</strong> (one signature). Everything you send is swapped to USDC on the way,
          through the NEAR Intents network.
        </p>

        {info.state === 'ok' && !real && (
          <p className="attention" role="note">
            <strong>Testnet.</strong> The swap network works with real money on mainnet only, so here you get a <strong>price preview</strong> and a way to put <strong>test funds</strong> on a leg. Deposit addresses appear on mainnet.
          </p>
        )}
        {real && (
          <p className="attention" role="note">
            <strong>Real money.</strong> Delivery to a leg has been tested by the project owner but is not yet recorded in docs/claims.md. Start with a small amount (the limit is ${info.data.maxUsd} a deposit). A new leg loses 1 USDC to Hyperliquid's
            activation fee.
          </p>
        )}

        <fieldset className="mode legpick">
          <legend>Which leg</legend>
          {legs.map((l) => (
            <label key={l.leg} className={active.leg === l.leg ? 'on' : ''}>
              <input type="radio" name="fundleg" checked={active.leg === l.leg} onChange={() => setLegNo(l.leg)} />
              Leg {l.leg}
            </label>
          ))}
        </fieldset>
        <dl className="kv">
          <dt>Address</dt>
          <dd>
            <code title={active.address}>{short(active.address)}</code> <button className="small-btn" onClick={() => copy(active.address)}>{copied === active.address ? 'Copied' : 'Copy'}</button>
          </dd>
          <dt>On spot</dt>
          <dd>{usd(spot)}</dd>
          <dt>Trading balance</dt>
          <dd>{usd(perp)}</dd>
        </dl>
        {active.activation === 'owed-on-credit' && <p className="flag small">New leg: its first deposit loses 1 USDC to Hyperliquid's activation fee.</p>}
        {err && <p className="notice err" role="alert">{err}</p>}
      </section>

      {spot > 0.01 && (
        <section className="card" aria-labelledby="move-h">
          <h2 id="move-h">Move to the trading balance</h2>
          <p className="muted small">{usd(spot)} is waiting on leg {active.leg}'s spot balance. It cannot trade until you move it. You sign one transfer; the contract signs it for Hyperliquid.</p>
          <div className="fields inline">
            <label>
              Amount, USDC
              <input value={moveValue} onChange={(e) => setMoveAmt(e.target.value)} inputMode="decimal" aria-invalid={!moveOk} />
            </label>
          </div>
          <div className="actions">
            <button className="primary" disabled={locked || !moveOk} title={why} onClick={() => (onMove(active.leg, moveValue), setMoveAmt(undefined))}>
              {busy === 'move' ? 'Waiting for signature…' : 'Move to trading balance'}
            </button>
          </div>
        </section>
      )}

      <WithdrawCard leg={active} owner={owner} network={view?.config?.hlNetwork} locked={locked} busy={busy} why={why} onWithdraw={onWithdraw} onMove={onMove} />

      <section className="card" aria-labelledby="addr-h">
        <h2 id="addr-h">1. Send to a deposit address</h2>
        <p className="muted small">Pick what you hold, say how much, and send it from any wallet you like. It is swapped to USDC and lands on leg {active.leg}.</p>
        {info.state === 'loading' && <p className="state">Reading the supported tokens…</p>}
        {info.state === 'error' && <p className="state err" role="alert">{info.message}</p>}
        {info.state === 'ok' && (
          <>
            {info.data.tokenList === 'fallback' && <p className="muted small">The live token list could not be read, so only USDC on NEAR and on Arbitrum are offered.</p>}
            <div className="fields inline">
              <label>
                You send
                <select value={token} onChange={(e) => setToken(e.target.value)}>
                  {info.data.tokens.map((t) => <option key={t.assetId} value={t.assetId}>{t.label}</option>)}
                </select>
              </label>
              <label>
                Amount{tok ? `, ${tok.symbol}` : ''} (about ${info.data.minUsd} to ${info.data.maxUsd})
                <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
              </label>
            </div>
            <label>
              Your own address on {tok?.label.replace(/^\S+ on /, '') ?? 'that chain'}, for a refund if the swap fails
              <input value={refund} onChange={(e) => setRefund(e.target.value.trim())} spellCheck={false} placeholder={tok && !EVM_CHAINS.has(tok.blockchain) ? 'an address you control on this chain' : '0x…'} />
            </label>

            <div aria-live="polite" className="fund-quote">
              {quote.state === 'idle' && <p className="state">Enter an amount and a refund address to see the price.</p>}
              {quote.state === 'loading' && <p className="state">Getting a price…</p>}
              {quote.state === 'error' && <p className="state err" role="alert">{quote.message}</p>}
              {quote.state === 'ok' && (
                <dl className="kv">
                  <dt>You send</dt>
                  <dd>{quote.q.amountIn} {tok?.symbol}{quote.q.amountInUsd !== null && ` (about ${usd(quote.q.amountInUsd)})`}</dd>
                  <dt>Arrives as</dt>
                  <dd>about {usd(quote.q.amountOut)} USDC</dd>
                  {quote.q.activationFeeUsd > 0 && (
                    <>
                      <dt>Leg ends with</dt>
                      <dd>about {usd(quote.q.expectedCredit)} (after the 1 USDC activation fee)</dd>
                    </>
                  )}
                  <dt>Time</dt>
                  <dd>{quote.q.etaSec ? `about ${quote.q.etaSec} seconds` : 'a few minutes'}</dd>
                  <dt>Price</dt>
                  <dd>{real ? 'live quote' : 'preview at mainnet prices'}</dd>
                </dl>
              )}
            </div>

            {real ? (
              deposit?.depositAddress ? (
                <div className="draft" role="status">
                  <h4>Send exactly {deposit.amountIn} {tok?.symbol} to</h4>
                  <p><code className="addr-full">{deposit.depositAddress}</code></p>
                  <div className="actions tight">
                    <button onClick={() => copy(deposit.depositAddress!)}>{copied === deposit.depositAddress ? 'Copied' : 'Copy address'}</button>
                  </div>
                  <p className="flag small">Send only {tok?.label} to this address, before {deposit.deadline ? new Date(deposit.deadline).toLocaleTimeString('en-GB') : 'the deadline'}. Anything else may be lost.</p>
                  <p className="small">{status ? (STATUS[status] ?? status) : 'Waiting for your deposit to arrive at the address.'}</p>
                </div>
              ) : (
                <div className="actions">
                  <button className="primary" disabled={!canSign || quote.state !== 'ok'} title={why} onClick={getAddress}>Get my deposit address</button>
                </div>
              )
            ) : (
              <p className="muted small">No deposit address on testnet. Use the test funds below.</p>
            )}
          </>
        )}
      </section>

      <section className="card" aria-labelledby="wallet-h">
        <h2 id="wallet-h">2. Deposit from your wallet</h2>
        <p className="muted small">Connect a browser wallet and let the app send the deposit and the swap in one step. This is not in this build: for now, use a deposit address above and send from your wallet's own send screen.</p>
        <button disabled>Connect a wallet (coming soon)</button>
      </section>

      {info.state === 'ok' && !real && (
        <section className="card" aria-labelledby="test-h">
          <h2 id="test-h">Test funds</h2>
          {dry ? (
            <>
              <p className="muted small">You are looking at recorded data. This adds <strong>simulated</strong> USDC to the leg's spot balance, so you can try the next step. Nothing real moves.</p>
              <div className="fields inline">
                <label>
                  Amount, USDC
                  <input value={credit} onChange={(e) => setCredit(e.target.value)} inputMode="decimal" />
                </label>
              </div>
              <div className="actions">
                <button disabled={!(Number(credit) > 0)} onClick={simulate}>Add simulated test funds</button>
              </div>
            </>
          ) : (
            <>
              <p className="muted small">
                On Hyperliquid testnet, send test USDC to this leg's address from any testnet account with a Hyperliquid transfer, or ask whoever runs this agent to send some. A new leg loses 1 USDC to the activation fee, so send a few. Then come back and move it to the trading balance.
              </p>
              <p><code className="addr-full">{active.address}</code> <button className="small-btn" onClick={() => copy(active.address)}>{copied === active.address ? 'Copied' : 'Copy'}</button></p>
            </>
          )}
          <p className="muted small">After funding, <a href={`#/legs`} onClick={(e) => (e.preventDefault(), onGo('legs'))}>the Legs tab</a> shows the leg's new state.</p>
        </section>
      )}
    </>
  );
}
