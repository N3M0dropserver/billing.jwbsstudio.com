import { defineMiddleware } from 'astro:middleware';
import { bindings, db as getDbFromEnv } from '~/lib/env';
import {
  SESSION_COOKIE,
  resolveSession,
  sessionCookieOptions,
} from '~/lib/auth/session';

/** Routes reachable without a session. Everything else requires one. */
const PUBLIC_PREFIXES = [
  '/login',
  '/api/auth/login',
  '/api/stripe/webhook',
  '/pay/', // public invoice view + payment page
  '/proposal/', // public proposal view
  '/_astro/',
  '/favicon',
  '/robots.txt',
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { locals, cookies, url, request, redirect } = context;

  locals.user = null;
  locals.session = null;

  let env: Env | null = null;
  try {
    env = bindings();
  } catch {
    env = null;
  }

  if (!env?.DB) {
    // No binding means the app is misconfigured rather than the user being
    // logged out; fail loudly instead of bouncing them to a login page that
    // will not work either.
    if (!isPublic(url.pathname)) {
      return new Response(
        'Database binding not available. Check that wrangler.jsonc has a D1 binding named DB and that you are running through `wrangler dev` or a deployed Worker.',
        { status: 503, headers: { 'content-type': 'text/plain' } },
      );
    }
    return next();
  }

  const db = getDbFromEnv();
  const token = cookies.get(SESSION_COOKIE)?.value;
  const resolved = await resolveSession(db, token);

  if (resolved) {
    locals.user = resolved.user;
    locals.session = resolved.session;
    if (resolved.refreshedExpiry && token) {
      cookies.set(SESSION_COOKIE, token, sessionCookieOptions(resolved.refreshedExpiry));
    }
  }

  if (!isPublic(url.pathname) && !locals.user) {
    if (url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    const next = url.pathname + url.search;
    return redirect(`/login?next=${encodeURIComponent(next)}`, 302);
  }

  // Already signed in and hitting the login page — go to the dashboard.
  if (url.pathname === '/login' && locals.user) {
    return redirect('/', 302);
  }

  // Force a password change before anything else is reachable.
  if (
    locals.user?.mustChangePassword &&
    !url.pathname.startsWith('/account/password') &&
    !url.pathname.startsWith('/api/auth/')
  ) {
    return redirect('/account/password', 302);
  }

  // State-changing requests must come from our own origin.
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
    const origin = request.headers.get('origin');
    if (origin && new URL(origin).origin !== url.origin) {
      return new Response(JSON.stringify({ error: 'Cross-origin request rejected' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }
  }

  const response = await next();
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('X-Frame-Options', 'DENY');
  return response;
});
