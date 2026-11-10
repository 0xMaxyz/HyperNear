import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface TabDef {
  id: string;
  label: string;
  /** something in this tab needs the owner's attention */
  dot?: string;
}

export interface Route {
  tab: string;
  /** path segments after the tab: #/legs/3 gives ['3'] */
  rest: string[];
  params: URLSearchParams;
}

function parse(hash: string, valid: string[]): Route {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  const [first = '', ...rest] = path.split('/');
  return { tab: valid.includes(first) ? first : valid[0]!, rest, params: new URLSearchParams(query) };
}

/** The tab lives in location.hash (#/fund?leg=3), so links and reloads land on the same view and no router is needed. */
export function useRoute(valid: string[]): [Route, (to: string) => void] {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = useCallback((to: string) => {
    location.hash = to.startsWith('#') ? to : `#/${to}`;
  }, []);
  return [parse(hash, valid), go];
}

export function Tabs({ tabs, current, onGo }: { tabs: TabDef[]; current: string; onGo: (id: string) => void }) {
  const move = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + step + tabs.length) % tabs.length;
    if (!step && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    onGo(tabs[to]!.id);
    document.getElementById(`tab-${tabs[to]!.id}`)?.focus();
  };
  return (
    <nav className="tabs" aria-label="Sections">
      <div role="tablist">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            role="tab"
            aria-selected={t.id === current}
            aria-controls={`panel-${t.id}`}
            tabIndex={t.id === current ? 0 : -1}
            className={t.id === current ? 'on' : ''}
            onClick={() => onGo(t.id)}
            onKeyDown={(e) => move(e, i)}
          >
            {t.label}
            {t.dot && <span className="dot" role="img" aria-label={t.dot} title={t.dot} />}
          </button>
        ))}
      </div>
    </nav>
  );
}

export const Panel = ({ id, children }: { id: string; children: ReactNode }) => (
  <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} className="panel" tabIndex={-1}>
    {children}
  </div>
);
