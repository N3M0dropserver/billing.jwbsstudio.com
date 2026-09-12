import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * Omni search — ⌘K / Ctrl-K from anywhere.
 *
 * Searches invoices, clients, projects, time entries and expenses in one
 * pass, and also exposes the quick actions as commands so "new invoice" is
 * two keystrokes rather than two clicks.
 */

export interface SearchHit {
  type: 'invoice' | 'client' | 'expense' | 'time' | 'project' | 'action';
  id: string;
  title: string;
  subtitle: string;
  meta?: string;
  href: string;
}

const TYPE_LABELS: Record<SearchHit['type'], string> = {
  invoice: 'Invoice',
  client: 'Client',
  expense: 'Expense',
  time: 'Time',
  project: 'Project',
  action: 'Action',
};

const ACTIONS: SearchHit[] = [
  { type: 'action', id: 'new-invoice', title: 'New invoice', subtitle: 'Bill for work done', href: '/invoices/new' },
  { type: 'action', id: 'new-client', title: 'Add client', subtitle: 'Record a new customer', href: '/clients/new' },
  { type: 'action', id: 'new-expense', title: 'Log expense', subtitle: 'Capture a deduction', href: '/tax/expenses/new' },
  { type: 'action', id: 'tax', title: 'Tax position', subtitle: 'What you owe and when', href: '/tax' },
  { type: 'action', id: 'time', title: 'Track time', subtitle: 'Start or log a session', href: '/time' },
  { type: 'action', id: 'settings', title: 'Settings', subtitle: 'Business and tax details', href: '/settings' },
];

function matchActions(query: string): SearchHit[] {
  const q = query.toLowerCase().trim();
  if (!q) return ACTIONS.slice(0, 4);
  return ACTIONS.filter(
    (a) => a.title.toLowerCase().includes(q) || a.subtitle.toLowerCase().includes(q),
  );
}

export default function OmniSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>(ACTIONS.slice(0, 4));
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setSelected(0);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === 'Escape') close();
    };
    const onOpenClick = (e: MouseEvent) => {
      const target = e.target;
      if (target instanceof Element && target.closest('[data-omni-open]')) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('click', onOpenClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onOpenClick);
    };
  }, [close]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Debounced search. A stale response must never overwrite a fresh one, so
  // each request carries a sequence number.
  useEffect(() => {
    if (!open) return;

    const q = query.trim();
    if (q.length === 0) {
      setHits(ACTIONS.slice(0, 4));
      setLoading(false);
      return;
    }

    const seq = ++requestRef.current;
    setLoading(true);

    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        if (!response.ok) throw new Error(String(response.status));
        const data = (await response.json()) as { hits: SearchHit[] };
        if (seq !== requestRef.current) return;
        setHits([...matchActions(q), ...data.hits]);
        setSelected(0);
      } catch {
        if (seq !== requestRef.current) return;
        setHits(matchActions(q));
      } finally {
        if (seq === requestRef.current) setLoading(false);
      }
    }, 160);

    return () => clearTimeout(timer);
  }, [query, open]);

  if (!open) return null;

  const go = (hit: SearchHit) => {
    close();
    window.location.href = hit.href;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-3 pt-[8vh] sm:px-4 sm:pt-[12vh]"
      style={{ background: 'color-mix(in oklch, black 55%, transparent)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Search"
    >
      <div
        className="card animate-fade-up w-full max-w-lg overflow-hidden p-0 shadow-2xl"
        style={{ background: 'var(--surface-raised)' }}
      >
        {/* The input is 16px on phones: anything smaller makes iOS Safari zoom. */}
        <div className="flex items-center gap-3 border-b px-3.5 py-3" style={{ borderColor: 'var(--border)' }}>
          <svg className="size-4 shrink-0" style={{ color: 'var(--text-muted)' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelected((s) => Math.min(s + 1, hits.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelected((s) => Math.max(s - 1, 0));
              } else if (e.key === 'Enter' && hits[selected]) {
                e.preventDefault();
                go(hits[selected]);
              }
            }}
            placeholder="Search invoices, clients, expenses, time…"
            className="min-w-0 flex-1 bg-transparent text-base outline-none sm:text-sm"
            style={{ color: 'var(--text)' }}
            aria-label="Search query"
            aria-autocomplete="list"
          />
          {loading && (
            <span className="label-xs muted shrink-0" role="status">…</span>
          )}
          <button
            type="button"
            onClick={close}
            className="label-xs muted shrink-0 border px-1.5 py-1"
            style={{ borderColor: 'var(--border)', borderRadius: '2px' }}
            aria-label="Close search"
          >
            Esc
          </button>
        </div>

        <ul className="max-h-[60vh] overflow-y-auto" role="listbox">
          {hits.length === 0 && !loading && (
            <li className="muted px-4 py-8 text-center text-sm">
              Nothing matched “{query}”.
            </li>
          )}
          {hits.map((hit, i) => (
            <li key={`${hit.type}-${hit.id}`} role="option" aria-selected={i === selected}>
              <button
                type="button"
                onMouseEnter={() => setSelected(i)}
                onClick={() => go(hit)}
                className="flex w-full items-center gap-3 border-b px-3.5 py-2.5 text-left last:border-b-0"
                style={{
                  background: i === selected ? 'var(--surface-sunken)' : 'transparent',
                  borderColor: 'var(--border)',
                }}
              >
                <span className="label-xs muted hidden w-14 shrink-0 sm:block">
                  {TYPE_LABELS[hit.type]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{hit.title}</span>
                  <span className="muted block truncate text-xs">
                    <span className="sm:hidden">{TYPE_LABELS[hit.type]} · </span>
                    {hit.subtitle}
                  </span>
                </span>
                {hit.meta && (
                  <span className="tabular muted shrink-0 text-xs">{hit.meta}</span>
                )}
              </button>
            </li>
          ))}
        </ul>

        <div
          className="label-xs muted hidden items-center gap-3 border-t px-3.5 py-2 sm:flex"
          style={{ borderColor: 'var(--border)' }}
        >
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span className="ml-auto">⌘K anywhere</span>
        </div>
      </div>
    </div>
  );
}
