// Number and time formatting shared by the terminal, the positions table and Portfolio.
import { usd } from './panels';

export const signedUsd = (v: number, dp = 2) => `${v < 0 ? '−' : '+'}${usd(Math.abs(v), dp)}`;
export const pct = (v: number, dp = 2) => `${v < 0 ? '−' : '+'}${Math.abs(v * 100).toFixed(dp)}%`;
export const pxFmt = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: v >= 1000 ? 1 : 2, maximumFractionDigits: v >= 1000 ? 1 : v >= 1 ? 4 : 6 });
export const clock = (t: number) => new Date(t).toLocaleTimeString('en-GB');
export const when = (t: number) => new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
export const tone = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
