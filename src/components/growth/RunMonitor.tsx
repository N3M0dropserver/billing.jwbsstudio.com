/**
 * The live run view.
 *
 * A campaign takes minutes to hours and the interesting part is watching it
 * decide. This subscribes to the agent's Durable Object over a WebSocket via
 * `useAgent`, so progress arrives as it happens rather than on a poll.
 *
 * The socket is the fast path, not the source of truth. Everything shown here
 * is also written to D1, and the component falls back to polling
 * `/api/campaigns/<id>/state` when the socket is not connected — a campaign
 * page that renders the run correctly with the socket closed is worth more
 * than one that only works when everything is up.
 *
 * The connection goes through an authenticated route on this app rather than
 * to the agent Worker directly; the agent has no auth of its own and is not
 * publicly routed.
 */

import { useAgent } from 'agents/react';
import { useCallback, useEffect, useRef, useState } from 'react';

interface CampaignRow {
  id: string;
  stage: string;
  status: string;
  waitingOn: string | null;
  discoveredCount: number;
  shortlistedCount: number;
  enrichedCount: number;
  plannedCount: number;
  builtCount: number;
  proposedCount: number;
  error: string;
}

interface EventRow {
  id: string;
  stage: string;
  level: 'info' | 'decision' | 'warn' | 'error';
  message: string;
  detail: string;
  createdAt: string;
}

interface StateResponse {
  campaign: CampaignRow;
  events: EventRow[];
  agent: { ticks?: number; status?: string } | null;
}

const STAGES = ['brief', 'discover', 'shortlist', 'enrich', 'plan', 'build', 'propose'] as const;

const STAGE_LABELS: Record<string, string> = {
  brief: 'Brief',
  discover: 'Discover',
  shortlist: 'Shortlist',
  enrich: 'Research',
  plan: 'Plan',
  build: 'Build',
  propose: 'Propose',
};

const LEVEL_COLOURS: Record<EventRow['level'], string> = {
  info: 'var(--text-muted)',
  decision: 'var(--color-reserved)',
  warn: 'var(--color-owing)',
  error: 'var(--color-overdue)',
};

function timeOf(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

export default function RunMonitor({ campaignId }: { campaignId: string }) {
  const [data, setData] = useState<StateResponse | null>(null);
  const [connected, setConnected] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    // A burst of agent updates must not become a burst of fetches.
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/state`, {
        headers: { accept: 'application/json' },
      });
      if (response.ok) setData((await response.json()) as StateResponse);
    } catch {
      // Offline, or the page is going away. The next tick will try again.
    } finally {
      inFlight.current = false;
    }
  }, [campaignId]);

  // The agent pushes its state on every tick; each push is a cue to re-read
  // the authoritative rows rather than to trust the pushed state itself.
  useAgent({
    agent: 'campaign-agent',
    name: campaignId,
    // Same-origin and authenticated — see the route for why the agent Worker
    // is not reachable directly.
    basePath: `api/campaigns/${campaignId}/socket`,
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

  // Without a socket, fall back to a slow poll while the run is live.
  useEffect(() => {
    const status = data?.campaign.status;
    const live = status === 'running' || status === 'waiting';
    if (connected || !live) return;

    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [connected, data?.campaign.status, refresh]);

  if (!data) {
    return (
      <p className="muted text-sm" role="status">
        Loading the run…
      </p>
    );
  }

  const { campaign, events } = data;
  const currentIndex = STAGES.indexOf(campaign.stage as (typeof STAGES)[number]);

  const counts: Record<string, number> = {
    discover: campaign.discoveredCount,
    shortlist: campaign.shortlistedCount,
    enrich: campaign.enrichedCount,
    plan: campaign.plannedCount,
    build: campaign.builtCount,
    propose: campaign.proposedCount,
  };

  return (
    <div className="space-y-5">
      <ol className="flex flex-wrap gap-1.5" aria-label="Progress">
        {STAGES.map((stage, index) => {
          const done = index < currentIndex || campaign.status === 'complete';
          const active = index === currentIndex && campaign.status !== 'complete';
          const waiting = active && campaign.status === 'waiting';

          return (
            <li
              key={stage}
              className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium"
              style={{
                background: waiting
                  ? 'color-mix(in oklch, var(--color-owing) 18%, transparent)'
                  : active
                    ? 'var(--color-brand-600)'
                    : done
                      ? 'color-mix(in oklch, var(--color-paid) 16%, transparent)'
                      : 'var(--surface-sunken)',
                color: waiting
                  ? 'var(--color-owing)'
                  : active
                    ? 'white'
                    : done
                      ? 'var(--color-paid)'
                      : 'var(--text-muted)',
              }}
              aria-current={active ? 'step' : undefined}
            >
              {STAGE_LABELS[stage]}
              {counts[stage] !== undefined && counts[stage]! > 0 && (
                <span className="tabular opacity-75">{counts[stage]}</span>
              )}
              {active && campaign.status === 'running' && (
                <span className="inline-block size-1.5 animate-pulse rounded-full bg-current" aria-hidden />
              )}
            </li>
          );
        })}
      </ol>

      <div className="flex items-center gap-2 text-xs">
        <span
          className="inline-block size-1.5 rounded-full"
          style={{ background: connected ? 'var(--color-paid)' : 'var(--text-muted)' }}
          aria-hidden
        />
        <span className="muted">
          {connected
            ? 'Live'
            : campaign.status === 'running' || campaign.status === 'waiting'
              ? 'Polling — the agent socket is not connected'
              : 'Not running'}
        </span>
        {data.agent?.ticks ? <span className="muted tabular">· {data.agent.ticks} ticks</span> : null}
      </div>

      {campaign.error && (
        <p
          className="rounded-lg px-3 py-2 text-sm"
          style={{ background: 'color-mix(in oklch, var(--color-overdue) 12%, transparent)', color: 'var(--color-overdue)' }}
          role="alert"
        >
          {campaign.error}
        </p>
      )}

      <div>
        <h3 className="mb-2 text-sm font-semibold">Run log</h3>
        {events.length === 0 ? (
          <p className="muted text-sm">Nothing yet.</p>
        ) : (
          <ol className="space-y-1.5 text-sm">
            {events.map((event) => (
              <li key={event.id} className="flex gap-2.5">
                <time className="muted tabular shrink-0 text-xs leading-6" dateTime={event.createdAt}>
                  {timeOf(event.createdAt)}
                </time>
                <span
                  className="shrink-0 rounded px-1.5 text-[10px] font-medium uppercase leading-6 tracking-wide"
                  style={{ color: LEVEL_COLOURS[event.level] }}
                >
                  {event.stage || event.level}
                </span>
                <span className="leading-6">{event.message}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
