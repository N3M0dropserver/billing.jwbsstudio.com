import type { APIRoute } from 'astro';
import { db, bindings, appUrl } from '~/lib/env';
import { runReminderSweep, usersWithRemindersEnabled } from '~/lib/invoices/sweep';
import { purgeExpiredSessions } from '~/lib/auth/session';
import { purgeStaleLoginTokens } from '~/lib/auth/magic-link';
import { logAuth } from '~/lib/auth/log';

export const prerender = false;

/**
 * Scheduled work, reachable over HTTP.
 *
 * Cloudflare Cron Triggers invoke a Worker's `scheduled()` handler, and the
 * Astro adapter only emits `fetch`. `scripts/wrap-worker.mjs` adds a
 * `scheduled()` at build time which calls straight back into this route, so
 * the job runs inside the ordinary app with every binding and helper already
 * in place rather than as a second, half-wired copy of it.
 *
 * That makes this an internet-reachable URL, so it is authenticated by a
 * shared secret rather than a session. With no CRON_SECRET set it refuses
 * everything, which is the right failure: an endpoint that mails clients
 * must not be open because a secret was forgotten.
 */

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorise(request: Request, env: Env): string | null {
  const secret = env.CRON_SECRET;
  if (!secret) {
    return 'CRON_SECRET is not set, so scheduled work is disabled. Run `wrangler secret put CRON_SECRET`.';
  }
  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!presented || !timingSafeEqual(presented, secret)) return 'Not authorised.';
  return null;
}

const TASKS = new Set(['reminders', 'housekeeping']);

export const POST: APIRoute = async ({ params, request, url }) => {
  const env = bindings();
  const refusal = authorise(request, env);
  if (refusal) {
    logAuth({
      action: 'cron.denied',
      outcome: 'denied',
      path: url.pathname,
      detail: refusal,
    });
    return new Response(JSON.stringify({ error: refusal }), {
      status: env.CRON_SECRET ? 401 : 503,
      headers: { 'content-type': 'application/json' },
    });
  }

  const task = params.task ?? '';
  if (!TASKS.has(task)) {
    return Response.json({ error: `Unknown task "${task}".` }, { status: 404 });
  }

  const database = db();
  // A dry run decides and reports without sending, which is how you check a
  // reminder ladder before letting it loose on real clients.
  const dryRun = url.searchParams.get('dryRun') === '1';
  const today = url.searchParams.get('today') ?? undefined;

  if (task === 'housekeeping') {
    await purgeExpiredSessions(database);
    await purgeStaleLoginTokens(database);
    return Response.json({ ok: true, task, ran: ['sessions', 'login-tokens'] });
  }

  const everyone = await usersWithRemindersEnabled(database);
  const runs = [];
  for (const userSettings of everyone) {
    runs.push(
      await runReminderSweep(database, env, appUrl(), userSettings, { dryRun, today }),
    );
  }

  // One JSON line per run in the Worker log, so `wrangler tail` shows what
  // the scheduled job actually decided rather than only that it ran.
  console.log(
    `[cron] ${JSON.stringify({ task, dryRun, users: everyone.length, runs: runs.map((r) => ({ sent: r.sent, failed: r.failed, considered: r.considered, skipped: r.skipped })) })}`,
  );

  return Response.json({ ok: true, task, dryRun, users: everyone.length, runs });
};
