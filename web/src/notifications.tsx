// The bell: this tab's toasts and the owner's agent events in one list, newest first, grouped by day. What has been read is kept per owner
// in localStorage as a time (not an event id: ids restart with the agent, and the recorded replay numbers its own from 1,000,000).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentEvent } from './api';
import { describeEvent, type Severity } from './panels';
import { clearToasts, markToastsRead, useToasts, type ToastKind } from './toast';

const KEEP = 50;
const DAY_MS = 86_400_000;

export interface Notice {
  key: string;
  at: number;
  title: string;
  detail?: string;
  severity: Severity;
  unread: boolean;
}
export interface Notifications {
  items: Notice[];
  /** the bell's badge and the panel's "N new" */
  unread: number;
  hasToasts: boolean;
  markAllRead: () => void;
  clear: () => void;
}

const TOAST_SEVERITY: Record<ToastKind, Severity> = { ok: 'success', err: 'error', info: 'info' };
const SEVERITY_WORD: Record<Severity, string> = { error: 'Error', warning: 'Warning', success: 'Done', info: 'Info' };

const seenKey = (owner: string) => `hypernear.notif-seen:${owner.toLowerCase()}`;
function readSeen(owner?: string): number {
  if (!owner) return 0;
  try {
    return Number(localStorage.getItem(seenKey(owner))) || 0;
  } catch {
    return 0;
  }
}

/** The list and the unread count, shared by the bell's badge and the panel. `events` are the owner's, newest first. */
export function useNotifications(owner: string | undefined, events: AgentEvent[]): Notifications {
  const toasts = useToasts();
  const [seen, setSeen] = useState(() => readSeen(owner));
  useEffect(() => setSeen(readSeen(owner)), [owner]);

  const items = useMemo(
    () =>
      [
        ...toasts.map((t): Notice => ({ key: `t${t.id}`, at: t.at, title: t.text, severity: TOAST_SEVERITY[t.kind], unread: !t.read })),
        ...events.map((e): Notice => ({ key: `e${e.id}-${e.at}`, at: e.at, ...describeEvent(e), unread: e.at > seen })),
      ]
        .sort((a, b) => b.at - a.at)
        .slice(0, KEEP),
    [toasts, events, seen],
  );

  const markAllRead = useCallback(() => {
    // the agent's clock, not this browser's: an event stamped after the newest one shown stays unread whatever the two clocks say
    const t = events.reduce((m, e) => (Number.isFinite(e.at) ? Math.max(m, e.at) : m), seen);
    setSeen(t);
    if (owner) {
      try {
        localStorage.setItem(seenKey(owner), String(t));
      } catch {
        // storage blocked: read state lasts until the page reloads
      }
    }
    markToastsRead();
  }, [events, owner, seen]);

  return { items, unread: items.filter((i) => i.unread).length, hasToasts: toasts.length > 0, markAllRead, clear: clearToasts };
}

const dayStart = (t: number) => new Date(t).setHours(0, 0, 0, 0);
const hm = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const dm = (t: number, now: number) =>
  new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(new Date(t).getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' as const }) });
const daysAgo = (t: number, now: number) => Math.round((dayStart(now) - dayStart(t)) / DAY_MS);
const dayLabel = (t: number, now: number) => {
  const d = daysAgo(t, now);
  return d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : dm(t, now);
};
const timeLabel = (t: number, now: number) => {
  const s = (now - t) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  const d = daysAgo(t, now);
  return d <= 0 ? hm(t) : d === 1 ? `Yesterday ${hm(t)}` : dm(t, now);
};
const valid = (t: number) => Number.isFinite(t) && Math.abs(t) < 8.64e15;

const ICON: Record<Severity, ReactNode> = {
  error: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M15 9l-6 6M9 9l6 6" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3.5l9 16H3z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  success: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.5 2.5L16 9.5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
};

/** The bell's panel: a non-modal popover, so Privy and the app's own dialogs are not affected. Escape and a click outside close it. */
export function NotificationsPanel({ n, onClose }: { n: Notifications; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<'all' | 'attention'>('all');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, []);
  useEffect(() => {
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    return () => back?.focus();
  }, []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    // the phone's bottom nav sits above the backdrop: changing page closes the panel
    window.addEventListener('keydown', esc);
    window.addEventListener('hashchange', onClose);
    return () => (window.removeEventListener('keydown', esc), window.removeEventListener('hashchange', onClose));
  }, [onClose]);

  const attention = n.items.filter((i) => i.severity === 'error' || i.severity === 'warning');
  const rows = filter === 'all' ? n.items : attention;
  const groups: { label: string; items: Notice[] }[] = [];
  for (const i of rows) {
    const label = dayLabel(i.at, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(i);
    else groups.push({ label, items: [i] });
  }

  return (
    <>
      <div className="pop-backdrop" onClick={onClose} aria-hidden="true" />
      <div ref={ref} className="pop notifications" role="dialog" aria-labelledby="notif-h" tabIndex={-1}>
        <div className="notif-top">
          <div className="notif-head">
            <h2 id="notif-h">Notifications</h2>
            {n.unread > 0 && <span className="notif-new">{n.unread > 99 ? '99+' : n.unread} new</span>}
            <span className="notif-acts">
              {/* both disable themselves: keep focus in the panel so Escape still works */}
              <button onClick={() => (n.markAllRead(), ref.current?.focus())} disabled={n.unread === 0}>Mark all read</button>
              <button onClick={() => (n.clear(), ref.current?.focus())} disabled={!n.hasToasts} title="Removes this tab's alerts; agent events stay in the full log">Clear</button>
            </span>
          </div>
          <div className="notif-bar">
            <div className="notif-filter" role="group" aria-label="Show">
              <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All</button>
              <button aria-pressed={filter === 'attention'} onClick={() => setFilter('attention')}>
                Needs attention{attention.length > 0 && <span className="notif-n">{attention.length}</span>}
              </button>
            </div>
            <a className="notif-log" href="#/activity" onClick={onClose}>Full log →</a>
          </div>
        </div>
        {rows.length === 0 ? (
          <p className="notif-empty">{filter === 'all' ? 'Nothing yet.' : 'Nothing needs your attention.'}</p>
        ) : (
          groups.map((g) => (
            <section key={g.label} className="notif-group">
              <h3 className="notif-day">{g.label}</h3>
              <ul className="notif-list">
                {g.items.map((i) => (
                  <li key={i.key} className={`notif sev-${i.severity}${i.unread ? ' unread' : ''}`}>
                    <span className="notif-dot" aria-hidden="true" />
                    <svg className="notif-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                      {ICON[i.severity]}
                    </svg>
                    <div className="notif-main">
                      <p className="notif-title" title={i.title}>
                        <span className="sr-only">{i.unread ? 'Unread. ' : ''}{SEVERITY_WORD[i.severity]}: </span>
                        {i.title}
                      </p>
                      {i.detail && <p className="notif-detail" title={i.detail}>{i.detail}</p>}
                    </div>
                    {valid(i.at) && (
                      <time className="notif-time" dateTime={new Date(i.at).toISOString()} title={new Date(i.at).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'medium' })}>
                        {timeLabel(i.at, now)}
                      </time>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
        <p className="notif-foot">Toasts are cleared when you close the tab.</p>
      </div>
    </>
  );
}
