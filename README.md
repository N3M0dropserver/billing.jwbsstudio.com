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
    mail/         provider abstraction and email templates
    stripe/       checkout sessions and webhook verification
    ai/           Workers AI helpers and prospecting
    auth/         password hashing and sessions
    db/           Drizzle schema and client
    queries/      aggregate queries for dashboard and tax pages
  pages/          Astro routes and API endpoints
  components/     Astro components and React islands
migrations/       D1 migrations
tests/            185 tests, mostly the tax engine
docs/             the tax research
```
