import { defineMiddleware } from 'astro:middleware';
import { bindings, db as getDbFromEnv } from '~/lib/env';
import {
  readSessionToken,
  resolveSession,
  sessionCookieName,
  setSessionCookie,
} from '~/lib/auth/session';
import { logAuth } from '~/lib/auth/log';

/** Routes reachable without a session. Everything else requires one. */
const PUBLIC_PREFIXES = [
  '/login', // also covers /login/link/<token>, the emailed sign-in link
  '/api/auth/login',
  '/api/auth/magic-link',
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

/**
 * Paths worth a log line when they turn someone away. Static assets and
 * favicons bounce constantly and drown out the signal, so only real page and
 * API requests are recorded.
 */
function worthLogging(pathname: string): boolean {
  return !pathname.startsWith('/_astro/') && !pathname.startsWith('/favicon');
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { locals, cookies, url, request, redirect } = context;

  locals.user = null;
  locals.session = null;

  let env: Env | null = null;
  try {
    env = bindings();
  } catch (error) {
    logAuth({
      action: 'auth.env.bindings-unavailable',
      outcome: 'error',
      detail: String(error),
      path: url.pathname,
    });
    env = null;
  }

  if (!env?.DB) {
    // No binding means the app is misconfigured rather than the user being
    // logged out; fail loudly instead of bouncing them to a login page that
    // will not work either.
    logAuth({
      action: 'auth.env.no-db',
      outcome: 'error',
      reason: 'no-db-binding',
      path: url.pathname,
      detail: 'No D1 binding named DB. `astro dev` has no bindings — run `bun run preview` or deploy.',
    });
    if (!isPublic(url.pathname)) {
      return new Response(
        'Database binding not available. Check that wrangler.jsonc has a D1 binding named DB and that you are running through `wrangler dev` or a deployed Worker.',
        { status: 503, headers: { 'content-type': 'text/plain' } },
      );
    }
    return next();
  }

  const db = getDbFromEnv();
  const token = readSessionToken(cookies, url);
  const lookup = await resolveSession(db, token);

  if (lookup.session) {
    locals.user = lookup.session.user;
    locals.session = lookup.session.session;
    if (lookup.session.refreshedExpiry && token) {
      setSessionCookie(cookies, url, token, lookup.session.refreshedExpiry);
    }
  } else if (lookup.reason !== 'no-cookie' && worthLogging(url.pathname)) {
    /**
     * A cookie arrived and we would not honour it. Worth knowing about on
     * every route, public or not — this is the line that distinguishes an
     * expired session from a token the database has never seen (which means
     * the sessions table was reset, or the request reached a different D1
     * than the one the session was written to).
     */
    logAuth({
      action: 'auth.session.rejected',
      outcome: 'denied',
      reason: lookup.reason,
      path: url.pathname,
      ip: context.clientAddress ?? null,
      extra: { cookieName: sessionCookieName(url) },
    });
  }

  if (!isPublic(url.pathname) && !locals.user) {
    /**
     * The diagnostic that matters most. `no-cookie` here, immediately after
     * a sign-in that logged `auth.login ok`, means the browser threw the
     * cookie away rather than the password being wrong — which is what the
     * __Host- prefix does over plain http in Safari. `secureCookie: false`
     * on the login line plus `no-cookie` here narrows it further.
     */
    if (worthLogging(url.pathname)) {
      logAuth({
        action: 'auth.session.required',
        outcome: 'denied',
        reason: lookup.reason ?? 'no-cookie',
        path: url.pathname,
        ip: context.clientAddress ?? null,
        extra: {
          cookieName: sessionCookieName(url),
          cookiePresent: Boolean(token),
          // Names only — never the values.
          cookiesSeen: request.headers
            .get('cookie')
            ?.split(';')
            .map((c) => c.split('=')[0]?.trim())
            .filter(Boolean) ?? [],
        },
      });
    }

    if (url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    const nextPath = url.pathname + url.search;
    return redirect(`/login?next=${encodeURIComponent(nextPath)}`, 302);
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
      logAuth({
        action: 'auth.csrf.rejected',
        outcome: 'denied',
        path: url.pathname,
        ip: context.clientAddress ?? null,
        detail: `Origin ${origin} does not match ${url.origin}`,
      });
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
