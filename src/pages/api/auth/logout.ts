import type { APIRoute } from 'astro';
import { db } from '~/lib/env';
import { SESSION_COOKIE, destroySession } from '~/lib/auth/session';

export const prerender = false;

export const POST: APIRoute = async ({ cookies, redirect }) => {
  const token = cookies.get(SESSION_COOKIE)?.value;
  await destroySession(db(), token);
  cookies.delete(SESSION_COOKIE, { path: '/' });
  return redirect('/login', 302);
};
