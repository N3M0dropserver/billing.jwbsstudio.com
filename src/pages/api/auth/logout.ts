import type { APIRoute } from 'astro';
import { db } from '~/lib/env';
import { destroySession, readSessionToken, clearSessionCookie } from '~/lib/auth/session';
import { recordAuth } from '~/lib/auth/log';

export const prerender = false;

export const POST: APIRoute = async ({ request, url, locals, cookies, redirect, clientAddress }) => {
  const token = readSessionToken(cookies, url);
  const database = db();

  await destroySession(database, token);
  clearSessionCookie(cookies, url);

  await recordAuth(database, {
    action: 'auth.logout',
    outcome: 'ok',
    userId: locals.user?.id ?? null,
    email: locals.user?.email ?? null,
    ip: clientAddress ?? null,
    userAgent: request.headers.get('user-agent'),
  });

  return redirect('/login', 302);
};
