// Transient alerts over the app. Success and info toasts close by themselves after 5 s (they pause while hovered or focused) and every toast
// has a close button; errors stay until closed. Everything is also kept in a short history (this tab only) that the bell (notifications.tsx) lists. Decisions are
// not toasts: they stay as a banner and a card until the owner acts on them.
import { useEffect, useRef, useSyncExternalStore } from 'react';

export type ToastKind = 'ok' | 'err' | 'info';
export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
  at: number;
  read: boolean;
  /** still on screen */
  shown: boolean;
}

export const TOAST_MS = 5000;
const KEEP = 50;
const MAX_SHOWN = 3;

let items: ToastItem[] = [];
let next = 1;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => (subs.add(f), () => subs.delete(f));
const snapshot = () => items;

/** Shows a toast (and records it in the history). Callable from anywhere. */
export function toast(kind: ToastKind, text: string): number {
  const id = next++;
  // at most MAX_SHOWN on screen: the oldest one makes room
  const shown = items.filter((t) => t.shown);
  const drop = new Set(shown.slice(0, Math.max(0, shown.length + 1 - MAX_SHOWN)).map((t) => t.id));
  items = [...items.map((t) => (drop.has(t.id) ? { ...t, shown: false } : t)), { id, kind, text, at: Date.now(), read: false, shown: true }].slice(-KEEP);
  emit();
  return id;
}
export function dismissToast(id: number) {
  items = items.map((t) => (t.id === id ? { ...t, shown: false, read: true } : t));
  emit();
}
export function markToastsRead() {
  if (items.every((t) => t.read)) return;
  items = items.map((t) => ({ ...t, read: true }));
  emit();
}
/** the bell's Clear: drops every toast, on screen and in the history */
export function clearToasts() {
  if (items.length === 0) return;
  items = [];
  emit();
}

export const useToasts = () => useSyncExternalStore(subscribe, snapshot, snapshot);

function ToastView({ t }: { t: ToastItem }) {
  const paused = useRef(false);
  const left = useRef(TOAST_MS);
  useEffect(() => {
    if (t.kind === 'err') return; // an error stays until it is closed: a failed order must not vanish in 5 s
    let last = Date.now();
    const tick = setInterval(() => {
      const now = Date.now();
      if (!paused.current) left.current -= now - last;
      last = now;
      if (left.current <= 0) dismissToast(t.id);
    }, 200);
    return () => clearInterval(tick);
  }, [t.id, t.kind]);
  return (
    <div
      className={`toast ${t.kind}`}
      role={t.kind === 'err' ? 'alert' : 'status'}
      onMouseEnter={() => (paused.current = true)}
      onMouseLeave={() => (paused.current = false)}
      onFocus={() => (paused.current = true)}
      onBlur={() => (paused.current = false)}
    >
      <span className="toast-text">{t.text}</span>
      <button className="toast-x" aria-label="Close" onClick={() => dismissToast(t.id)}>×</button>
    </div>
  );
}

export function ToastHost() {
  const all = useToasts();
  const shown = all.filter((t) => t.shown);
  return (
    <div className="toasts" aria-live="polite">
      {shown.map((t) => <ToastView key={t.id} t={t} />)}
    </div>
  );
}
