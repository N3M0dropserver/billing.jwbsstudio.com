import type { APIRoute } from 'astro';
import { db } from '~/lib/env';
import { timeEntries } from '~/lib/db/schema';
import { newId } from '~/lib/id';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const form = await request.formData();

  // Either the timer posts `minutes` and `startedAt`, or a manual entry
  // posts `manualMinutes` and we date it now.
  const timerMinutes = Number.parseInt(String(form.get('minutes') ?? ''), 10);
  const manualMinutes = Number.parseInt(String(form.get('manualMinutes') ?? ''), 10);
  const minutes = Number.isFinite(timerMinutes) && timerMinutes > 0 ? timerMinutes : manualMinutes;

  if (!Number.isFinite(minutes) || minutes <= 0) {
    return redirect('/time?error=duration', 302);
  }

  const startedAtRaw = String(form.get('startedAt') ?? '');
  const startedAt =
    startedAtRaw && !Number.isNaN(Date.parse(startedAtRaw))
      ? new Date(startedAtRaw).toISOString()
      : new Date(Date.now() - minutes * 60_000).toISOString();

  const now = new Date().toISOString();
  // Clamp once, then derive the end from the clamped value — otherwise a
  // timer left running over a weekend stores `minutes` capped at a day and an
  // `endedAt` three days later, and the two disagree about the same entry.
  const storedMinutes = Math.min(minutes, 24 * 60);

  await db().insert(timeEntries).values({
    id: newId(),
    userId: user.id,
    clientId: String(form.get('clientId') ?? '') || null,
    description: String(form.get('description') ?? '').slice(0, 500),
    startedAt,
    endedAt: new Date(new Date(startedAt).getTime() + storedMinutes * 60_000).toISOString(),
    minutes: storedMinutes,
    billable: form.get('billable') === 'yes',
    billed: false,
    createdAt: now,
    updatedAt: now,
  });

  return redirect('/time', 302);
};
