# JWBS Studio — billing, invoicing and tax

An invoicing, billing and dual-jurisdiction tax system for a self-employed
graphic, brand and web designer working across New Zealand and Australia,
with a mix of PAYE employment and self-employed income.

Runs entirely on Cloudflare: Workers, D1, R2 and Workers AI.

---

## What it does

**Dashboard** — headline figures, a cumulative chart of invoiced against
received (the gap is what you are owed, drawn to scale), your current tax
position, and quick actions.

**Invoices** — build them from line items or from unbilled time, with GST
handled automatically based on where the client is. Generates a real PDF,
emails it with the PDF attached, and gives the client a public link to view and
pay. Bank transfer always; Stripe card payment optionally, with a webhook that
marks the invoice paid.

**Email templates** — a WYSIWYG block editor at `/templates` (built on
`@react-email/editor`) for writing the wording once and reusing it, with merge
variables like `{{invoice.number}}` and `{{client.firstName}}`. Six base
templates to start from, a palette of email blocks — buttons, sections,
columns, dividers, images — and an inspector for the spacing and colour of
whichever block is selected. Templates are
optional: choosing none falls back to the built-in wording, so sending works on
a fresh account with no templates at all. Sends are recorded, with approximate
open tracking — read the caveats in *Email* before trusting the numbers.

**Tax & accounting** — a proper tax engine for both countries. Progressive
brackets, ACC levies, student loan, Medicare levy, HELP, GST/BAS, provisional
tax and PAYG instalments. Expense tracking with business-use apportionment,
depreciation schedules, and guidance on what is actually claimable — including
the rules that differ between NZ and AU.

**Clients** — contacts, communications log, per-client revenue, proposals. Plus
scaffolding for an AI prospecting mode (see *Known limitations*).

**Time** — a timer that survives closing the tab, manual entry, and one-click
conversion of unbilled time into an invoice.

**Omni search** — ⌘K from anywhere, across invoices, clients, expenses, time
and projects, with the quick actions exposed as commands.

## The tax engine

This is the part that has to be right, so it is a pure, dependency-free module
with **185 tests** covering both jurisdictions.

- `src/lib/tax/rates.ts` — versioned rate tables. Every figure carries a source
  URL and a confidence marker. Figures marked `verify` are surfaced in the UI
  rather than quietly trusted.
- `src/lib/tax/progressive.ts` — bracket arithmetic. Cumulative base amounts are
  *derived*, not stored, which is why the tests can assert it reproduces the
  ATO's published figures exactly.
- `src/lib/tax/nz.ts` / `au.ts` — per-jurisdiction calculation.
- `src/lib/tax/engine.ts` — the combined position, foreign tax credits, and the
  three reserve bands.
- `src/lib/tax/gst.ts` — GST, export treatment, threshold monitoring.
- `src/lib/tax/deductions.ts` — depreciation, home office, vehicle, and the
  claimable-guidance rules.

**Read [`docs/TAX-RESEARCH.md`](docs/TAX-RESEARCH.md)** for the research behind
it, with sources — including a note on the three bugs in the original
spreadsheet that this replaces.

All money is integer cents. Never floats.

## Stack and why

- **Astro 7** with the Cloudflare adapter, SSR, React islands only where there
  is real interactivity. Most pages ship no JavaScript.
- **D1** via Drizzle for typed queries and migrations.
- **R2** for issued invoice PDFs and receipt attachments.
- **Workers AI** for the assistant and prospect scoring.
- **Tailwind v4** with CSS custom properties for theming.
- **No PDF library.** `src/lib/pdf/` writes PDFs directly — every JS PDF library
  is either megabytes of WASM or needs Node APIs a Worker does not have. Includes
  a custom encoding so Māori macrons render correctly rather than as `?`.
- **No Stripe SDK.** Two endpoints and an HMAC check, done with fetch and
  WebCrypto.
- **PBKDF2-SHA256 via WebCrypto** for passwords — argon2/bcrypt would mean
  shipping WASM and burning CPU against the Workers limit.

---

## Setup

### 1. Install and create resources

```bash
npm install

npx wrangler d1 create jwbs-billing
npx wrangler r2 bucket create jwbs-billing-files
npx wrangler kv namespace create SESSION
```

Put the returned `database_id` and KV `id` into `wrangler.jsonc`, replacing the
`REPLACE_WITH_...` placeholders.

### 2. Secrets

```bash
cp .dev.vars.example .dev.vars
# generate a session secret
openssl rand -base64 48
```

Put that in `.dev.vars` as `SESSION_SECRET`. For production:

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put RESEND_API_KEY        # if sending email via Resend
npx wrangler secret put STRIPE_SECRET_KEY     # optional
npx wrangler secret put STRIPE_WEBHOOK_SECRET # optional
```

### 3. Migrate and create your user

```bash
npm run db:migrate:local
npm run user:add -- --email you@example.com --name "Your Name" --local
```

**There is no sign-up.** This script is the only way an account comes into
existence. It prints a generated password once and flags the account so the
password must be changed at first sign-in.

The generated password is 24 characters of mixed case, digits and `!@#$%^&*`.
Copy it in one go — a character lost to a line wrap or a shell that ate the
`$` presents later as "that email and password combination was not
recognised", with no hint that the password is nearly right. If that happens,
sign in with an emailed link instead (below) and set a password you chose.

### 4. Run it

```bash
npm run preview   # astro build && wrangler dev
```

`astro dev` alone has no Cloudflare bindings, so it will not work — you need
`wrangler dev`.

Two bindings have no local emulation and are marked to run against the real
service: **Workers AI** and **Email**. `wrangler dev` will therefore start a
remote proxy session and needs a `CLOUDFLARE_API_TOKEN`. To work fully offline,
run `npx wrangler dev --local` and set `MAIL_PROVIDER` to `none` — everything
except AI and email sending works locally, against a local D1.

### 5. Deploy

```bash
npm run db:migrate:remote
npm run deploy
npm run user:add -- --email you@example.com --name "Your Name" --remote
```

Then set your business details, tax residence, GST registration and bank details
in **Settings** — the invoices depend on them.

---

## Signing in

Two ways in, both against the same account:

**Password.** What `user:add` sets up. Eight wrong attempts locks the account
for fifteen minutes.

**A link by email.** On the sign-in page, enter your address under *Email me a
sign-in link*. The link is single-use, expires in fifteen minutes, and is
invalidated the moment a newer one is requested. Redeeming it also clears a
lockout, so it is the way back in when the password is lost or the account has
locked itself.

The page answers identically whether or not the address has an account. What
actually happened is in the log — see below.

### Auth logging

Every decision the auth code makes is written to the Worker log as a single
JSON line behind an `[auth]` prefix, and mirrored into the `activity_log`
table where it belongs to a real user. Passwords and raw tokens are never
logged; a token appears as the first eight characters of its hash, which is
enough to follow one link across the "issued" and "redeemed" lines.

```bash
npx wrangler tail --format pretty | grep '\[auth\]'
```

Or query the audit trail directly:

```bash
npx wrangler d1 execute jwbs-billing --remote --command \
  "SELECT created_at, action, detail FROM activity_log WHERE action LIKE 'auth.%' ORDER BY created_at DESC LIMIT 20;"
```

The reasons worth recognising:

| `reason` | What it means |
| --- | --- |
| `unknown-email` | No account with that address in *this* database. |
| `bad-password` | The account exists and the password did not match. `failedAttempts` climbing on every try means the password is simply wrong, not that something is misconfigured. |
| `unverifiable-hash` | The stored hash could not be evaluated at all — see below. Never counted as a failed attempt, because it is not the user's fault. |
| `account-locked` | Eight failures. Wait it out or use a link. |
| `no-cookie` | No session cookie arrived. If this follows an `auth.login` that logged `ok`, the credentials were right and the **browser threw the cookie away** — see below. |
| `unknown-token` | A cookie arrived naming a session this database has never seen. Usually means the request reached a different D1 than the one that issued it (local vs remote). |
| `session-expired` | Past its fourteen days. |
| `no-db-binding` | Running under `astro dev`, which has no bindings. Use `npm run preview`. |
| `mail-failed` / `mail-disabled` | The link was minted but the email did not go. The line carries the provider's own error. |

### Signed in successfully but bounced back to the login page

That is `auth.login` → `ok` followed immediately by `auth.session.required` →
`no-cookie`, and it means the cookie was rejected rather than the password.

In production the cookie is named `__Host-jwbs_session`. The `__Host-` prefix
requires the `Secure` attribute, which browsers only accept over https —
Chrome and Firefox make an exception for `localhost`, **Safari does not** and
drops the cookie silently. So over plain http the app issues an unprefixed,
non-Secure `jwbs_session_dev` cookie instead, and keeps the hardened name for
https. Nothing to configure; the log line records which name was issued
(`cookieName`) and which cookies the browser actually sent back
(`cookiesSeen`, names only).

### Password hashing, and the 100,000 iteration ceiling

Passwords are PBKDF2-SHA256 through WebCrypto. **Cloudflare's production
runtime refuses a single PBKDF2 call above 100,000 iterations**, throwing:

```
NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
supported (requested 600000).
```

Node has no such cap, and neither does `wrangler dev --local` — so a hash
written by `npm run user:add` at 600,000 iterations is accepted everywhere
except the deployed Worker, where it can never be verified. This bit: it
surfaced as "that email and password combination was not recognised" on every
attempt, because the error came back through a `catch` that returned `false`.

Two things prevent a repeat:

- The work factor is reached by **chaining six rounds of 100,000**, each round
  seeding the next over the same salt, so no single call approaches the
  ceiling while the attacker still pays the full 600,000 iterations. The
  stored format names the shape: `pbkdf2$6x100000$<salt>$<hash>`.
- `verifyPassword` returns a **reason**, not a boolean. Only `mismatch` means
  a wrong password; `unsupported` and `error` mean the hash could not be
  evaluated, and those are logged as `unverifiable-hash`, shown as a distinct
  message, and **never counted as a failed attempt** — otherwise a
  misconfiguration locks the account after eight tries and buries its own
  cause.

`scripts/add-user.mjs` and the app share the algorithm through
`scripts/pbkdf2.mjs`, and `tests/password.test.ts` pins them together by
hashing with the script and verifying with the app. Change one, change both,
or that test fails.

A hash in the older single-pass layout still verifies if it is under the
ceiling, and is reported as `unsupported` — with an explanation — if it is
over it. There is no way to recover such an account's password; sign in with
an emailed link and set a new one.

### Signing in locally with no working mail path

Cloudflare Email Service will not deliver to an arbitrary address until the
sending domain is onboarded, which makes emailed links useless on a fresh
setup. Set `AUTH_DEBUG="1"` in `.dev.vars` and the link is printed to the
Worker log instead of only being mailed:

```
[auth] {"action":"auth.magic-link.debug", ... "detail":"... https://.../login/link/xxxx"}
```

A printed link is a live credential for fifteen minutes. Keep `AUTH_DEBUG` out
of production.

---

## Email

Sending uses **Cloudflare Email Service** by default, via the `send_email`
binding already declared in `wrangler.jsonc`. No API key, nothing to leak.

### Setting it up

1. **The sending domain must use Cloudflare DNS.** This is a hard prerequisite.
2. **Onboard the domain to Email Service** in the dashboard, which adds the
   SPF/DKIM/DMARC records that let your mail actually arrive.
3. Set `MAIL_FROM` in `wrangler.jsonc` to an address on that domain.
4. Deploy.

**Until the domain is onboarded, Email Service will only deliver to destination
addresses you have verified in your account.** That is fine for testing against
your own inbox, but it will not reach clients — so finish step 2 before sending
a real invoice. Sending to arbitrary recipients also requires the Workers Paid
plan; mail to verified destination addresses is free on any plan and does not
count towards the sending quota.

The binding is declared unrestricted so it can invoice any client. To lock it
down, `send_email` also accepts `destination_address`,
`allowed_destination_addresses` and `allowed_sender_addresses`.

Limits worth knowing: **5 MiB per message** including attachments (the app
checks before sending and fails with a clear message), and 50 recipients across
to/cc/bcc. A generated invoice PDF is around 6 KB, so neither will bite.

### Local development

There is no local emulation of email delivery. The binding is marked
`remote: true`, so `wrangler dev` runs the Worker locally but sends through the
real service — which means real email and a real API token
(`CLOUDFLARE_API_TOKEN`). If you would rather not, run `wrangler dev --local`
and set `MAIL_PROVIDER` to `none`; everything except sending still works.

### Switching to Resend

Set `MAIL_PROVIDER` to `resend` in `wrangler.jsonc` and
`wrangler secret put RESEND_API_KEY`. Nothing else changes — both providers sit
behind one interface in `src/lib/mail/`. Set it to `none` to disable sending
entirely.

### Templates

`/templates` is a block editor for the outbound wording. It saves three things
per template: the Tiptap JSON it reloads from, the rendered HTML that gets
mailed, and a plain-text alternative. Rendering happens **in the browser** —
the Worker never runs React Email, which keeps Tiptap out of the Worker bundle
entirely (it is a ~2.5 MB client chunk, loaded only on the editor page).

Three ways into the same document, because they suit different moments. **Base
templates** (`src/lib/mail/starters.ts`) give a finished layout to edit down
rather than a blank page; one can be chosen when the template is created or
applied later from *Start from a base*. The **block palette** above the editor
inserts buttons, sections, columns, dividers, lists and images — the same
commands as typing `/`, on a surface you can see without being told it exists.
The **inspector** in the right-hand rail edits the padding, colour, size and
alignment of the selected block, and the whole email's background and width.

Starters are authored as HTML rather than editor JSON, for two reasons:
hand-written Tiptap JSON is unreviewable, and converting HTML into it needs the
editor schema, which must stay out of the Worker. So a starter's id rides along
on the redirect into the editor and the browser applies the body.
`tests/starters.test.ts` parses every starter through the real schema and
asserts each block arrives as itself — a button missing one attribute is still
valid HTML, it just silently turns into a paragraph.

Bodies use `{{variable}}` tokens, substituted at send time. The catalogue lives
in `src/lib/mail/variables.ts` and is shared by the editor palette and the send
path, so a variable cannot exist in one and not the other. Substituted values
are HTML-escaped; an unrecognised token renders as nothing rather than leaking
`{{like.this}}` into a client's inbox.

Four things are deliberately true:

- **Templates are optional.** No template, or a template with an empty body,
  falls back to the built-in wording in `src/lib/mail/templates.ts`. Sending
  cannot be broken by the template system.
- **The sign-in email is not templatable.** A malformed template there would
  lock you out of the app.
- **Deleting a template archives it** rather than removing the row, so past
  sends keep resolving.
- **A base template is only offered for kinds it can fill.** A proposal starter
  on an invoice template would carry `{{proposal.amount}}`, which an invoice
  send has no value for — it would reach a client as a gap mid-sentence. The
  test suite enforces the same rule the picker does.

### Open tracking, and why the numbers lie

Every send embeds a 1×1 pixel at `/e/<token>.gif` and gets a row in
`email_sends`. When a mail client loads that image, the open is recorded.

Treat the counts as a hint, never as fact:

- **Apple Mail Privacy Protection fetches every image on arrival**, read or
  not. That is an open that never happened, and it is a large share of consumer
  mail. Hits that arrive within ten seconds of sending, or from a recognised
  scanner, are flagged `likely_prefetch` so they can be discounted.
- **Gmail proxies images** through `googleusercontent.com` and caches them. The
  first load registers; re-opens usually do not, and the IP and user agent
  belong to Google.
- **Blocked images** (Outlook's default) mean a real, careful read records
  nothing.

Which is why open tracking **never drives invoice status**. The signal that
means something is the client following the link: `/pay/<token>` stamps
`invoices.viewed_at`, and that is what moves an invoice to *viewed*.

Images dropped into the editor go to R2 under `email-assets/` and are served
publicly from `/email-assets/…` — they have to be, since a mail client sends no
cookies. Keys are random and unguessable, but treat anything uploaded there as
published.

### A note on what not to use

Cloudflare Email **Routing** is a different product: inbound only, it cannot
send. The MailChannels integration Workers relied on for years was withdrawn in
August 2024 — do not reintroduce it.

## Commands

```bash
npm run dev              # astro dev (no bindings — limited use)
npm run preview          # build + wrangler dev
npm run deploy           # build + deploy
npm test                 # run the test suite
npm run typecheck        # tsc --noEmit
npm run db:generate      # generate a migration from schema changes
npm run db:migrate:local # apply migrations locally
npm run db:migrate:remote # apply migrations to the deployed database
npm run user:add         # create or reset a user
```

---

## Known limitations

**Read these before relying on it.**

1. **The AI prospecting discovery step is not connected.** Scoring,
   qualification and proposal drafting are implemented and work. What is not
   implemented is going out and *finding* the businesses — that needs a data
   source (Google Places API, an OpenStreetMap extract, or a licensed business
   register), and the choice has real cost and terms-of-service consequences,
   so it is left as a deliberate decision. The seam is `discoverProspects()` in
   `src/lib/ai/prospecting.ts`; everything downstream runs against whatever it
   returns. Do not scrape Google Maps directly — it breaches their terms and
   will get the Worker's egress range blocked.

2. **Some rate figures need confirming.** Anything marked `verify` in
   `src/lib/tax/rates.ts` came from secondary sources. The app lists them on the
   Tax page and in Settings with links to the official source. The ones most
   worth checking: the ACC work levy rate for your classification unit (the
   default is the scheme average and will not match your bill), the Medicare
   levy low-income threshold, and whether the AU$20,000 instant asset write-off
   was legislated for 2026-27.

3. **It does not decide your tax residence.** It asks you to state it. If both
   countries could claim you, the DTA tie-breaker decides, and that is a
   facts-and-circumstances question for an accountant.

4. **Multi-currency is simplistic.** Invoices carry a currency and an FX rate
   field, but there is no automatic rate lookup and no FX gain/loss tracking.

5. **Estimates, not returns.** The tax figures are for setting money aside.
   Filing is a job for your accountant.

6. **Single user in practice.** The schema is user-scoped throughout and roles
   exist, but nothing has been built around the `accountant` or `viewer` roles
   yet.

7. Four dev-only `npm audit` warnings come from drizzle-kit's bundled esbuild.
   They do not ship to the Worker.

---

## Project layout

```
src/
  lib/
    tax/          the tax engine — pure, tested, no I/O
    invoices/     invoice arithmetic and multi-table operations
    pdf/          the PDF writer and the invoice template
    mail/         providers, built-in templates, variables, open tracking
    stripe/       checkout sessions and webhook verification
    ai/           Workers AI helpers and prospecting
    auth/         password hashing and sessions
    db/           Drizzle schema and client
    queries/      aggregate queries for dashboard and tax pages
  pages/          Astro routes and API endpoints
  components/     Astro components and React islands
migrations/       D1 migrations
tests/            270 tests, mostly the tax engine
docs/             the tax research
```
