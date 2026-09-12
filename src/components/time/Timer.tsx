import { useState, useEffect, useRef } from 'react';

/**
 * Running timer plus manual entry.
 *
 * The elapsed time is derived from a start TIMESTAMP held in localStorage,
 * not from an incrementing counter — so closing the tab, sleeping the laptop
 * or switching device does not lose or distort the count.
 */

interface Props {
  clients: Array<{ id: string; name: string }>;
}

const STORAGE_KEY = 'jwbs-timer';

interface Running {
  startedAt: number;
  description: string;
  clientId: string;
}

function formatElapsed(ms: number): string {
  const total = Math.max(Math.floor(ms / 1000), 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export default function Timer({ clients }: Props) {
  const [running, setRunning] = useState<Running | null>(null);
  const [now, setNow] = useState(Date.now());
  const [description, setDescription] = useState('');
  const [clientId, setClientId] = useState('');
  const formRef = useRef<HTMLFormElement>(null);

  // Restore a timer that was running when the page was last closed.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as Running;
        if (typeof parsed.startedAt === 'number') {
          setRunning(parsed);
          setDescription(parsed.description);
          setClientId(parsed.clientId);
        }
      }
    } catch {
      // Private browsing or blocked storage — the timer just will not persist.
    }
  }, []);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  const start = () => {
    const next: Running = { startedAt: Date.now(), description, clientId };
    setRunning(next);
    setNow(Date.now());
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Non-fatal.
    }
  };

  const stop = () => {
    if (!running) return;
    const minutes = Math.max(Math.round((Date.now() - running.startedAt) / 60000), 1);
    const form = formRef.current;
    if (!form) return;

    (form.elements.namedItem('minutes') as HTMLInputElement).value = String(minutes);
    (form.elements.namedItem('startedAt') as HTMLInputElement).value =
      new Date(running.startedAt).toISOString();

    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Non-fatal.
    }
    setRunning(null);
    form.submit();
  };

  const discard = () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Non-fatal.
    }
    setRunning(null);
  };

  const elapsed = running ? now - running.startedAt : 0;

  return (
    <div className="card p-5">
      <form ref={formRef} method="post" action="/api/time" className="space-y-3.5">
        <input type="hidden" name="minutes" defaultValue="" />
        <input type="hidden" name="startedAt" defaultValue="" />

        {running ? (
          <div className="text-center">
            <p className="tabular text-4xl font-semibold" style={{ color: 'var(--color-brand-600)' }}>
              {formatElapsed(elapsed)}
            </p>
            <p className="muted mt-1 text-sm">
              {running.description || 'Untitled'}
              {running.clientId && ` · ${clients.find((c) => c.id === running.clientId)?.name ?? ''}`}
            </p>
            <div className="mt-4 flex justify-center gap-2">
              <button
                type="button" onClick={stop}
                className="rounded-lg px-5 py-2.5 text-sm font-medium text-white"
                style={{ background: 'var(--color-brand-600)' }}
              >Stop and save</button>
              <button
                type="button" onClick={discard}
                className="muted rounded-lg border px-4 py-2.5 text-sm font-medium"
                style={{ borderColor: 'var(--border)' }}
              >Discard</button>
            </div>
          </div>
        ) : (
          <>
            <div className="grid gap-3.5 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label htmlFor="description" className="mb-1.5 block text-sm font-medium">
                  What are you working on
                </label>
                <input
                  id="description" name="description" value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Homepage wireframes" className="field"
                />
              </div>
              <div>
                <label htmlFor="clientId" className="mb-1.5 block text-sm font-medium">Client</label>
                <select
                  id="clientId" name="clientId" value={clientId}
                  onChange={(e) => setClientId(e.target.value)} className="field"
                >
                  <option value="">No client</option>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="manualMinutes" className="mb-1.5 block text-sm font-medium">
                  Or log minutes directly
                </label>
                <input
                  id="manualMinutes" name="manualMinutes" type="number" min="1"
                  placeholder="90" className="field"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button" onClick={start}
                className="rounded-lg px-5 py-2.5 text-sm font-medium text-white"
                style={{ background: 'var(--color-brand-600)' }}
              >Start timer</button>
              <button
                type="submit"
                className="muted rounded-lg border px-4 py-2.5 text-sm font-medium"
                style={{ borderColor: 'var(--border)' }}
              >Save manual entry</button>
              <label className="muted ml-auto flex items-center gap-2 text-sm">
                <input type="checkbox" name="billable" value="yes" defaultChecked />
                Billable
              </label>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
