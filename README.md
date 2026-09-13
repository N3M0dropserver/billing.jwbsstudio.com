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

**Clients** — contacts, communications log, per-client revenue, proposals.

**Growth** — the lead-generation and proposal pipeline. Name a trade and a
region; it finds the businesses, measures the state of their web presence,
researches the ones worth pursuing, designs each of them a page, builds and
publishes a demo site on its own subdomain, and drafts the outreach email.
Every stage is independently set to run by itself, be decided by the model, or
stop and wait for you. See *The growth pipeline* below.

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

## The growth pipeline

Seven stages. Each one is set independently to **Ask me**, **AI decides** or
**Just do it**, as saved defaults and again per run.

```
brief → discover → shortlist → enrich → plan → build → propose
```

| Stage | What it does | `AI decides` means | `Just do it` means |
|---|---|---|---|
| **brief** | Resolves the style direction this run builds against | Adds two sentences of guidance for the trade, without replacing your rules | Uses the saved direction as-is |
| **discover** | Finds businesses in the niche and region | — | Runs the chosen provider |
| **shortlist** | Audits each one's site, measures their size, and ranks them | The model picks, and records why | Takes the top of the ranking |
| **enrich** | Crawls the site, finds contacts, socials, reviews, photography | — | Researches everyone selected |
| **plan** | Writes the design and page spec | The model writes the plan | Lays out a scaffold, no model call |
| **build** | Generates the demo and publishes it | Builds for everyone planned | Builds for everyone planned |
| **propose** | Drafts the outreach email and sends it | Sends to everyone drafted, up to the cap | Sends to everyone drafted, up to the cap |

Anyone with **no honest angle** — nothing measurably wrong with their site — is
skipped at **build** and never sent at **propose**, under every mode. `Just do
it` is an instruction to stop asking, not permission to open a cold email with
something invented.

`Ask me` on any stage does the work and then stops, so you see the results
before anything moves on. The defaults leave **build** and **propose** on
`Ask me` — publishing a public page and emailing a stranger are the two things
worth opting into on purpose.

### Three numbers, kept apart

**Need** is measured. The crawler fetches the site and an audit checks it: no
mobile viewport, no HTTPS, a copyright line three years stale, markup nobody
has written this century, no way to get in touch, a parked domain, a site that
does not answer. Every check has a fixed weight, so the number is reproducible
and you can see exactly what produced it.

**Fit** is judged. The model is given the audit and asked one question: would
an unsolicited concept site from a freelancer land well here. It is allowed to
say no, and it is capped at 45% of the ranking weight, so an enthusiastic model
cannot push a well-built site to the top of the list.

**Scale** is measured, and it is a *ceiling* rather than a contribution. This
is the one that stops a prominent chain ending up in your outbox. Ability to
pay is the wrong question — a national brand can obviously pay and is a bad
prospect, because they have an agency, a brand guide and no interest in a
concept from someone they have never met.

Scale is built from evidence, not impressions:

| Source | Signal |
|---|---|
| OpenStreetMap | `brand:wikidata` — a catalogued chain. Conclusive on its own. |
| OpenStreetMap | Branches found in the searched region. Three or more is conclusive. |
| Wikidata | An entity matching the business name. Free, no key, runs on every prospect. |
| Their site | Careers, press, wholesale, franchising, investor or store-locator pages |
| Their site | Shopify Plus, Klaviyo, marketing automation, a headless CMS, A/B testing |
| Their site | "our stores", "nationwide", a named team of dozens, international shipping |
| Their site | An agency credit in the footer — somebody already has this work |
| Directory | Hundreds or thousands of public reviews |
| Web search | Optional, behind a key. Press coverage and rough reach. |

Above a campaign's **size ceiling** (default 60) a prospect is dropped
whatever else it scores, and the model is not asked about it at all — which is
also the single largest saving in the stage, since a high street full of chain
branches used to cost a model call each to be told so.

The Wikidata match requires the names to be *equal* after normalisation, not
merely overlapping. A missed chain is recoverable; silently deleting good
prospects because a café shares a word with something famous is not.

The audit also produces a list of **verified observations** — the problems in
words that can go into an email unchanged. This is what the outreach is written
from. When that list is empty, there is genuinely nothing honest to lead with,
and the pipeline says so and moves on rather than inventing a flaw.

### Reachable, and actually trading

Need answers "should somebody fix this". It does not answer "is there anyone to
say yes". A business with no website scores 95 for need and is a fine prospect
when the directory carries an email — *no website* is the pitch. The same
business with no email and no site is a map pin: nothing to crawl, nowhere to
send, and before this was measured it reached a published demo subdomain and a
drafted email before anyone found out.

So the audit measures two more things alongside the score: whether the business
is **contactable** at all, and what **evidence there is that they are trading**
— published hours, a phone number, an email, public reviews, a site that
answers. An unreachable prospect is ruled out at the shortlist, before a model
call is paid for.

### What the model is never allowed to decide

Three rulings are made from measurements and cannot be argued out of, because
each is a case where an enthusiastic model used to talk its way through:

- **too large** — above the size ceiling, or decisively a chain (a Wikidata
  entry, three or more branches). Enforced even when the model call fails,
  which is what used to let a catalogued chain through on need alone.
- **unreachable** — no website and no email address.
- **no honest angle** — need so low that even a perfect fit could not clear the
  score floor. There is no problem to write to them about.

None of the three costs a model call, and none of them is undone by a score
floor of zero.

### Where the businesses come from

| Provider | Needs | Good for |
|---|---|---|
| **OpenStreetMap** (default) | Nothing | Anything with a shopfront. Free, ODbL — credit OSM if you republish. |
| **Google Places** | `GOOGLE_PLACES_API_KEY` | Broadest coverage, carries ratings. Costs per request; its terms limit caching to 30 days. |
| **Paste a list** | Nothing | A directory export, a conference list, three businesses down the road. |

The crawler identifies itself honestly, reads `robots.txt` and obeys it, takes
at most six pages per site, caps what it downloads and gives up quickly. Google
Maps is never scraped — that breaches their terms and would get the Worker's
egress range blocked.

### The demos

The model writes the *spec*; the generator writes the HTML. That split is
deliberate: every string from the model is escaped before it reaches markup,
and the layout, type scale and colour handling stay consistent across every
demo because they are written once rather than re-improvised per prospect.

Each demo is produced twice:

- **Served immediately** from R2, so the link in the outreach email works the
  moment it is generated — see *Where demos are served* below.
- **Exported as a real Astro + Cloudflare Worker project** — `package.json`,
  `astro.config.mjs`, `wrangler.jsonc`, pages, layout, stylesheet, their
  photography and a README — ready to hand over or deploy standalone. Astro
  cannot be *built* inside a Worker, so the source is generated and the build
  is left to a machine with a process to run Vite in.

Every generated demo carries a ribbon above the fold saying it is an
unsolicited concept, who made it, that it is not affiliated with or endorsed by
the business, and that it can be taken down on request. It is `noindex`, served
under a restrictive CSP, and the outreach email repeats the offer to remove it.

### Guard rails

- **A hard daily cap** on emails sent by unattended runs, counted from what has
  actually been sent rather than from a counter, so starting a new run does not
  reset it. Zero switches unattended sending off entirely — runs still draft
  every email and wait for you. Sending by hand from a proposal page is never
  capped.
- **Nothing is written to an address that was not found on the prospect's own
  published material.**
- **Every model decision is logged** with its reasoning, against the campaign
  and the prospect, so an unattended run is auditable afterwards.
- **Everything crawled is treated as data**, never as instruction. Copy from
  somebody's homepage reaches a prompt inside a fenced block that says so.

### The agent

A run takes minutes to hours and outlives any request, so it is driven by a
**Cloudflare Agent** — one Durable Object per campaign, in its own Worker under
`workers/agent`. It schedules its own ticks durably (surviving restarts,
evictions and deploys), holds the run as a single-writer state machine, and
broadcasts progress to the campaign page over a WebSocket.

The pipeline logic itself is not in the agent. It lives in
`src/lib/growth/engine.ts` as ordinary functions over a database handle, which
is why it can be tested in plain Node. The agent is only the part that knows
about durability: when to tick, what to do when one throws, and a watchdog for
a run that goes quiet without finishing.

It is a separate Worker because the Astro Cloudflare adapter generates this
app's Worker entry and there is no supported way to add a Durable Object export
to it. The app binds it by `script_name`, and `bun run deploy` deploys both in
the right order.

The browser connects to the agent through an authenticated route on this app,
not to the agent Worker directly — the agent has no authentication of its own
and is deliberately not publicly routed. If that socket cannot be established
the page falls back to polling, so the run view is correct either way.

### Where demos are served

Every demo is reachable at **two** addresses, from the same files in R2:

```
https://billing.jwbsstudio.com/d/wells-coffee.demo.jwbsstudio.com/   always works
https://wells-coffee.demo.jwbsstudio.com/                            once DNS is set up
```

The path mount needs no DNS and no route, so a run always produces something
openable. Which one goes in the outreach email is decided at build time and
recorded on the demo, so a proposal can never contain a link that has never
resolved.

To move demos onto their own subdomains, add both of these once:

```
*.demo.jwbsstudio.com   CNAME   billing.jwbsstudio.com   (proxied)
route: *.demo.jwbsstudio.com/*  →  this Worker
```

`DEMO_HOST` in `wrangler.jsonc` must match. Then build a demo and press **Check
hosting now** in Growth settings — it fetches a real demo and looks for the
ribbon that only a generated page carries, so a route that is missing and a
host that is empty are told apart rather than both reading as a 404. Once it
passes, existing demos are re-pointed at their subdomains automatically.

If you would rather create a record per demo instead, set
`CLOUDFLARE_API_TOKEN` (Zone:DNS:Edit on that zone, nothing else) and
`CLOUDFLARE_ZONE_ID` and it is done at build time.

### What the AI is costing

Every model call is recorded: stage, operation, model, tokens in and out,
duration, whether it was served from cache, and an estimated cost. **Growth →
AI usage** breaks it down by operation, stage, model and run.

Two things that page is careful about, because a number that looks
authoritative and is not is worse than no number:

- Workers AI bills in *neurons*, not tokens, and the per-model ratio is not
  published as a token rate. Every entry in `src/lib/ai/pricing.ts` is marked
  `verify` and `confident: false`, and the dashboard labels any total that
  includes one. Comparing stages against each other is sound; reconciling the
  total against an invoice is not.
- Calls whose model did not report token counts are estimated at about four
  characters per token, and counted separately so you can see how much of the
  total is estimated.

Identical requests are served from a **prompt cache** in D1, keyed on the
model, system prompt, prompt and parameters — so a re-run after a change costs
nothing for the stages that did not change, and a changed brief is a fresh
call rather than a stale answer. The TTL is a setting; zero turns it off.

Prompts and responses are deliberately not stored. They contain crawled
third-party content, and every question the page answers is about shape and
cost.

---

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

### A note on what not to use

Cloudflare Email **Routing** is a different product: inbound only, it cannot
send. The MailChannels integration Workers relied on for years was withdrawn in
August 2024 — do not reintroduce it.

## Commands

```bash
npm run dev              # astro dev (no bindings — limited use)
npm run preview          # build + wrangler dev
npm run deploy           # deploy the agent worker, then build + deploy the app
npm run deploy:agent     # deploy only the campaign agent worker
npm run dev:agent        # run the campaign agent worker locally
npm test                 # run the test suite
npm run typecheck        # tsc --noEmit
npm run typecheck:agent  # tsc --noEmit for the agent worker
npm run db:generate      # generate a migration from schema changes
npm run db:migrate:local # apply migrations locally
npm run db:migrate:remote # apply migrations to the deployed database
npm run user:add         # create or reset a user
```

---

## Known limitations

**Read these before relying on it.**

1. **The growth pipeline writes to people who did not ask to hear from you.**
   That is the point of it, and it is also the thing to be careful with. Read
   the guard rails above, set the daily cap deliberately, and leave `propose`
   on `Ask me` until you have read several of the emails it writes. The
   unsubscribe equivalent here is the offer to take the demo down, which is in
   every email and on every generated page — honour it the same day.

2. **Cost figures are estimates.** See *What the AI is costing*. They are
   good enough to find an expensive stage and not good enough to reconcile
   against a bill.

3. **Discovery coverage is uneven.** OpenStreetMap is strong for anything with
   a shopfront and thin for businesses run from home or a van; Google Places is
   better for those but costs per request and constrains how long you may keep
   the data. Neither is a business register. Expect to paste a list sometimes.

4. **The demos reuse the prospect's own photography.** That is what makes them
   read as "someone looked at us" rather than a template with a name dropped
   in — but those images are not licensed to you. They are fine in an
   unindexed concept the business is being shown; replace them before anything
   goes live for real. The generated README says so too.

5. **Astro is not built inside the Worker.** The served demo is generated HTML
   and CSS; the exported Astro project is source that still needs
   `bun install && bun run build` on a machine with a process. Both come from
   the same design plan, so they match, but only the first is live
   automatically.

6. **The live run socket may fall back to polling.** The agent is reached
   through an authenticated route on this app rather than being publicly
   exposed. If the upgrade does not survive, the run view polls every four
   seconds instead. Nothing is lost — D1 is authoritative for everything shown.

7. **Some rate figures need confirming.** Anything marked `verify` in
   `src/lib/tax/rates.ts` came from secondary sources. The app lists them on the
   Tax page and in Settings with links to the official source. The ones most
   worth checking: the ACC work levy rate for your classification unit (the
   default is the scheme average and will not match your bill), the Medicare
   levy low-income threshold, and whether the AU$20,000 instant asset write-off
   was legislated for 2026-27.

8. **It does not decide your tax residence.** It asks you to state it. If both
   countries could claim you, the DTA tie-breaker decides, and that is a
   facts-and-circumstances question for an accountant.

9. **Multi-currency is simplistic.** Invoices carry a currency and an FX rate
   field, but there is no automatic rate lookup and no FX gain/loss tracking.

10. **Estimates, not returns.** The tax figures are for setting money aside.
   Filing is a job for your accountant.

11. **Single user in practice.** The schema is user-scoped throughout and roles
   exist, but nothing has been built around the `accountant` or `viewer` roles
   yet.

12. Four dev-only `npm audit` warnings come from drizzle-kit's bundled esbuild.
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
    ai/           Workers AI helpers, usage tracking, the prompt cache and pricing
    growth/       the lead-generation pipeline
      policy.ts     per-stage autonomy: ask me / AI decides / just do it
      brief.ts      style direction, saved defaults merged with per-run overrides
      discovery/    OpenStreetMap, Google Places and paste-a-list providers
      crawl.ts      polite, robots-respecting crawler
      html.ts       extraction — portable, so it can be tested in Node
      assess.ts     the measured presence audit and its scoring
      scale.ts      how big they already are — the ceiling on fit
      search.ts     Wikidata and optional web search for prominence
      qualify.ts    the model's half: fit, shortlist and the design plan
      render.ts     the demo site generator (the model writes the spec, not the HTML)
      project.ts    the exported Astro + Cloudflare Worker project
      publish.ts    subdomain allocation, R2 serving, optional DNS
      proposal.ts   outreach drafting, the daily cap, sending
      engine.ts     the stage machine — plain functions, no Worker needed
    auth/         password hashing and sessions
    db/           Drizzle schema and client
    queries/      aggregate queries for dashboard and tax pages
  pages/          Astro routes and API endpoints
  components/     Astro components and React islands
workers/
  agent/          the campaign agent — one Durable Object per run, deployed separately
migrations/       D1 migrations
tests/            398 tests: the tax engine, and the growth pipeline's pure parts
docs/             the tax research
```
