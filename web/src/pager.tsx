// Paged tables that fit the space they are given. In the viewport-fit layout (wide screens) the number of rows per page comes from the
// height of the body that holds the table (ResizeObserver), so a dock never needs a scrollbar; elsewhere a fixed page size is used.
// Items can have a weight (a hedge group that is expanded is 1 + its legs rows) and a group never splits across pages.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

/** Matches a media query and follows it. */
export function useMedia(query: string): boolean {
  const sub = useCallback(
    (f: () => void) => {
      if (typeof matchMedia === 'undefined') return () => undefined;
      const m = matchMedia(query);
      m.addEventListener('change', f);
      return () => m.removeEventListener('change', f);
    },
    [query],
  );
  return useSyncExternalStore(sub, () => (typeof matchMedia === 'undefined' ? false : matchMedia(query).matches), () => false);
}

/** Splits items into pages of at most `rows` weighted rows each; an item heavier than a page gets a page to itself. Pure. */
export function paginateWeighted<T>(items: T[], weight: (t: T) => number, rows: number): T[][] {
  const pages: T[][] = [];
  let cur: T[] = [];
  let used = 0;
  for (const it of items) {
    const w = Math.max(1, weight(it));
    if (cur.length > 0 && used + w > rows) {
      pages.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(it);
    used += w;
  }
  if (cur.length > 0) pages.push(cur);
  return pages.length > 0 ? pages : [[]];
}

/** Rows that fit in an element of `heightPx` after `reservedPx` of header, at `rowPx` per row (never fewer than `min`). Pure. */
export const rowsThatFit = (heightPx: number, reservedPx: number, rowPx: number, min = 3) => Math.max(min, Math.floor((heightPx - reservedPx) / rowPx));

export function Pager({ page, pages, total, onPage }: { page: number; pages: number; total?: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  return (
    <nav className="pager" aria-label="Pages">
      <button disabled={page === 0} onClick={() => onPage(page - 1)} aria-label="Previous page">‹ Prev</button>
      <span className="muted small" aria-live="polite">Page {page + 1} of {pages}{total !== undefined ? ` · ${total} rows` : ''}</span>
      <button disabled={page >= pages - 1} onClick={() => onPage(page + 1)} aria-label="Next page">Next ›</button>
    </nav>
  );
}

export interface PagedProps<T> {
  items: T[];
  /** rows an item takes (default 1) */
  weight?: (t: T) => number;
  /** height of one row in px */
  rowPx?: number;
  /** px inside the body that are not rows (the table header, a totals line) */
  reservedPx?: number;
  /** measure the available height (viewport-fit layout) instead of using `fallbackRows` */
  fit: boolean;
  fallbackRows?: number;
  /** a value that sends the pager back to page 1 when it changes (a filter) */
  resetKey?: unknown;
  children: (page: T[]) => ReactNode;
}

export function Paged<T>({ items, weight = () => 1, rowPx = 38, reservedPx = 34, fit, fallbackRows = 8, resetKey, children }: PagedProps<T>) {
  const body = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(fallbackRows);
  useEffect(() => {
    const el = body.current;
    if (!fit || !el || typeof ResizeObserver === 'undefined') return;
    const read = () => {
      // the first real row tells the true row height (rows differ with font and padding); the estimate is the fallback
      const row = el.querySelector<HTMLElement>('tbody tr, .t-pcard, li');
      const rp = row && row.offsetHeight > 10 ? row.offsetHeight : rowPx;
      setMeasured((m) => {
        const next = rowsThatFit(el.clientHeight, reservedPx, rp);
        return next === m ? m : next;
      });
    };
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
    return () => ro.disconnect();
  }, [fit, rowPx, reservedPx]);
  const rows = fit ? measured : fallbackRows;
  const pages = useMemo(() => paginateWeighted(items, weight, rows), [items, weight, rows]);
  const [page, setPage] = useState(0);
  // new data or a new filter: back to the first page; a shrinking list never leaves an empty page
  const key = `${items.length}|${String(resetKey)}`;
  useEffect(() => setPage(0), [key]);
  const at = Math.min(page, pages.length - 1);
  return (
    <div className={`paged ${fit ? 'fit' : ''}`}>
      <div className="paged-body" ref={body}>{children(pages[at] ?? [])}</div>
      <Pager page={at} pages={pages.length} total={items.length} onPage={setPage} />
    </div>
  );
}
