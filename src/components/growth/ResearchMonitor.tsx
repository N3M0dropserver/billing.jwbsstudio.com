/**
 * The live view of a research task.
 *
 * The transcript is the point. A research agent that shows a spinner and then
 * a paragraph is impossible to trust and impossible to debug; one that shows
 * "searched for X", "opened Y, 1,400 words", "that contradicts what I
 * remembered" is a colleague working in front of you. Every step is written
 * to D1 as it happens, so this is a view of rows rather than a stream that
 * cannot be replayed.
 *
 * Same arrangement as the campaign monitor: the socket is the fast path, the
 * polled endpoint is the correct one, and the page still works with the
 * Durable Object unreachable.
 */

import { useAgent } from 'agents/react';
import { useCallback, useEffect, useRef, useState } from 'react';

interface ResearchRow {
  id: string;
  question: string;
  subject: string;
  status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
  answer: string;
  sources: string;
  learned: string;
  skillsUsed: string;
  stepsUsed: number;
  stepBudget: number;
  error: string;
}

interface StepRow {
  id: string;
  step: number;
  kind: 'thought' | 'tool' | 'observation' | 'answer' | 'error';
  tool: string;
  input: string;
  output: string;
  ok: boolean;
  durationMs: number;
  createdAt: string;
}

interface StateResponse {
  research: ResearchRow;
  steps: StepRow[];
  agent: { status?: string; steps?: number } | null;
}

const KIND_COLOURS: Record<StepRow['kind'], string> = {
  thought: 'var(--text-muted)',
  tool: 'var(--color-brand-600)',
  observation: 'var(--color-reserved)',
  answer: 'var(--color-paid)',
  error: 'var(--color-overdue)',
};

const TOOL_LABELS: Record<string, string> = {
  web_search: 'Searched',
  open_page: 'Opened',
  page_links: 'Listed links on',
  extract_from_page: 'Extracted from',
  screenshot_page: 'Photographed',
  recall: 'Recalled',
  remember: 'Remembered',
  save_skill: 'Wrote a skill',
};

function parseList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}

function describe(step: StepRow): string {
  if (step.kind !== 'tool') return step.output;
  const input = (() => {
    try {
      return JSON.parse(step.input) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();

  const target = String(input.url ?? input.query ?? input.content ?? input.name ?? '');
  const label = TOOL_LABELS[step.tool] ?? step.tool;
  return target ? `${label} ${target.slice(0, 160)}` : label;
}

export default function ResearchMonitor({ researchId }: { researchId: string }) {
  const [data, setData] = useState<StateResponse | null>(null);
  const [connected, setConnected] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const response = await fetch(`/api/agent/research/${researchId}/state`, {
        headers: { accept: 'application/json' },
      });
      if (response.ok) setData((await response.json()) as StateResponse);
    } catch {
      // The next tick will try again.
    } finally {
      inFlight.current = false;
    }
  }, [researchId]);

  useAgent({
    agent: 'research-agent',
    name: researchId,
    basePath: `api/agent/research/${researchId}/socket`,
    onStateUpdate: () => {
      setConnected(true);
      void refresh();
    },
    onOpen: () => setConnected(true),
    onClose: () => setConnected(false),
    onError: () => setConnected(false),
  });

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const status = data?.research.status;
    const live = status === 'running' || status === 'queued';
    if (connected || !live) return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [connected, data?.research.status, refresh]);

  if (!data) return <p className="muted text-sm">Loading…</p>;

  const { research, steps } = data;
  const sources = (() => {
    try {
      return JSON.parse(research.sources) as Array<{ title: string; url: string; note: string }>;
    } catch {
      return [];
    }
  })();

  const learned = parseList(research.learned);
  const skills = parseList(research.skillsUsed);
  const live = research.status === 'running' || research.status === 'queued';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className="rounded-full px-2.5 py-0.5 font-medium"
          style={{
            color: live ? 'var(--color-brand-600)' : research.status === 'complete' ? 'var(--color-paid)' : 'var(--color-overdue)',
            background: `color-mix(in oklch, ${
              live ? 'var(--color-brand-600)' : research.status === 'complete' ? 'var(--color-paid)' : 'var(--color-overdue)'
            } 12%, transparent)`,
          }}
        >
          {research.status}
        </span>
        <span className="muted tabular">
          {research.stepsUsed} of {research.stepBudget} tool calls
        </span>
        {live && (
          <span className="muted flex items-center gap-1.5">
            <span className="inline-block size-1.5 animate-pulse rounded-full bg-current" aria-hidden />
            {connected ? 'live' : 'polling'}
          </span>
        )}
        {skills.length > 0 && <span className="muted">· skills: {skills.join(', ')}</span>}
      </div>

      {research.error && (
        <p
          className="rounded-lg px-3 py-2 text-sm"
          style={{ background: 'color-mix(in oklch, var(--color-overdue) 12%, transparent)', color: 'var(--color-overdue)' }}
          role="alert"
        >
          {research.error}
        </p>
      )}

      {research.answer && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">What it found</h3>
          <div className="whitespace-pre-wrap text-sm leading-relaxed">{research.answer}</div>
        </div>
      )}

      {sources.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">What it looked at</h3>
          <ul className="space-y-1 text-sm">
            {sources.map((source) => (
              <li key={source.url} className="truncate">
                <a href={source.url} target="_blank" rel="noreferrer noopener nofollow" style={{ color: 'var(--color-brand-600)' }}>
                  {source.title || source.url}
                </a>
                <span className="muted ml-2 text-xs">{source.note}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {learned.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">What it wrote down</h3>
          <ul className="muted space-y-1 text-sm">
            {learned.map((line) => (
              <li key={line}>· {line}</li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-sm font-semibold">Working</h3>
        {steps.length === 0 ? (
          <p className="muted text-sm">Nothing yet.</p>
        ) : (
          <ol className="space-y-2 text-sm">
            {steps.map((step) => (
              <li key={step.id} className="flex gap-2.5">
                <span
                  className="shrink-0 rounded px-1.5 text-[10px] font-medium uppercase leading-6 tracking-wide"
                  style={{ color: KIND_COLOURS[step.kind] }}
                >
                  {step.kind}
                </span>
                <div className="min-w-0">
                  <p className="leading-6">{describe(step)}</p>
                  {step.kind === 'observation' && step.output && (
                    <details className="mt-0.5">
                      <summary className="muted cursor-pointer text-xs">
                        {step.ok ? 'what came back' : 'that did not work'}
                        {step.durationMs > 0 && ` · ${Math.round(step.durationMs / 100) / 10}s`}
                      </summary>
                      <pre
                        className="muted mt-1 max-h-64 overflow-auto rounded p-2 text-[11px] whitespace-pre-wrap"
                        style={{ background: 'var(--surface-sunken)' }}
                      >
                        {step.output}
                      </pre>
                    </details>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
