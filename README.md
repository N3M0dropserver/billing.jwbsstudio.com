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
marks the invoice paid. Correctable until money is recorded against them, after
which the remedy is a credit note rather than a quiet amendment; voidable and
write-off-able after that, both reversible, neither deleting the number.

**Quotes** — agree the work and the price before it starts. Priced through the
same GST engine as the invoice it becomes, sent as a PDF, read and accepted by
the client on a public link. Accepting records who agreed and when; turning it
into an invoice stays your decision, and copies the lines exactly as they were
quoted. Quotes number separately from invoices, so one that comes to nothing
leaves no gap in the invoice sequence.

**Chasing** — payment reminders on a schedule you set: a courtesy note before
the due date, then a ladder of chases after it. Off until you switch it on, and
switchable off again for one client or one invoice. Runs on a Cloudflare Cron
Trigger.

**Bank reconciliation** — import a CSV from any NZ or AU bank and credits are
matched against outstanding invoices, with a stated confidence and a stated
reason for each. Re-importing an overlapping period is safe. An exact amount on
its own is never treated as certain, because two invoices for the same round
figure are exactly where a silent mis-match happens.

**Email templates** — a drag-and-drop email builder at `/templates` for writing
the wording once and reusing it, with merge variables like
`{{invoice.number}}` and `{{client.firstName}}`. Blocks on the left, the email
in the middle, settings for the selected block on the right; six base templates
to start from. Templates are
optional: choosing none falls back to the built-in wording, so sending works on
a fresh account with no templates at all. Sends are recorded, with approximate
open tracking — read the caveats in *Email* before trusting the numbers.

**Tax & accounting** — a proper tax engine for both countries. Progressive
brackets, ACC levies, student loan, Medicare levy, HELP, GST/BAS, provisional
tax and PAYG instalments. Expense tracking with business-use apportionment,
depreciation schedules, and guidance on what is actually claimable — including
the rules that differ between NZ and AU. Photograph a receipt and a vision
model fills the expense form in; the image is kept with the record, which is
what both revenue authorities expect you to retain.

**Other income** — a part-time job, interest, dividends or rent, recorded per
pay period in either currency. Employment income changes the bracket your
self-employed income is taxed in, so it changes what you should be setting
aside. Work done across the Tasman is taxed by your country of residence with a
credit for the tax withheld at source, and because the two tax years are three
months out of step, a period crossing the boundary is split across both by
days. See *Working across both countries* in the research doc.

**Clients** — contacts, communications log, per-client revenue, proposals.

**Growth** — the lead-generation and proposal pipeline. Name a trade and a
region; it finds the businesses, measures the state of their web presence,
researches the ones worth pursuing, designs each of them a page, builds and
publishes a demo site on its own subdomain, and drafts the outreach email.
Every stage is independently set to run by itself, be decided by the model, or
stop and wait for you. See *The growth pipeline* below.

**Activity log** — what you sent and what the client did with it: invoice sent,
reminder sent, email opened, web invoice viewed, PDF downloaded, card payment
started, payment recorded. It lives where the question gets asked: the full
history on the invoice page, and the client's own history — invoice events
interleaved with the calls and notes you logged — on the client page. See
*The activity log* for what each signal is actually worth.

**Time** — a timer that survives closing the tab, manual entry, and one-click
conversion of unbilled time into an invoice.

**Omni search** — ⌘K from anywhere, across invoices, clients, expenses, time
and projects, with the quick actions exposed as commands.

**Money is one currency.** Invoices, expenses and payments each carry the rate
that applied on their own date, and every total, chart and tax figure is
converted into the currency of your tax residence before anything is added up.
Anything left without a rate is reported on the dashboard rather than counted
at face value.

## The tax engine

This is the part that has to be right, so it is a pure, dependency-free module
with **381 tests** across the suite, most of them here.

- `src/lib/tax/rates.ts` — versioned rate tables. Every figure carries a source
  URL and a confidence marker. Figures marked `verify` are surfaced in the UI
  rather than quietly trusted.
- `src/lib/tax/progressive.ts` — bracket arithmetic. Cumulative base amounts are
  *derived*, not stored, which is why the tests can assert it reproduces the
  ATO's published figures exactly.
- `src/lib/tax/nz.ts` / `au.ts` — per-jurisdiction calculation.
- `src/lib/tax/engine.ts` — the combined position, foreign tax credits, and the
  three reserve bands.
- `src/lib/tax/period.ts` — attributing income earned over a period to a tax
  year, and converting between the two currencies.
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
| **enrich** | Crawls the site, finds contacts, socials, reviews, photography | Also goes and researches each one beyond their own site | Crawls everyone selected |
| **plan** | Writes the design and page spec | The model writes the plan | Lays out a scaffold, no model call |
| **build** | Generates the demo and publishes it | Skips anyone with no honest angle | Builds for everyone planned |
| **propose** | Drafts the outreach email and sends it | Holds back anyone with nothing verifiable to say | Sends to everyone, up to the cap |

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
and under `AI decides` the pipeline says so and moves on rather than inventing
a flaw.

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
and the layout, type scale and colour handling are written once rather than
re-improvised per prospect.

**Consistent is not the same as identical.** A brand kit carries composition
tokens alongside its palette and typefaces — the hero treatment (split,
stacked, editorial, full-bleed), spacing density, type scale, section rhythm,
corner and button shape, and how photographs are framed. The stylesheet is a
function of those tokens, so two kits produce pages that do not look like each
other, and changing a kit changes every future demo built from it. They are a
closed set of values rather than free CSS, because the renderer has to be able
to guarantee the result still lays out properly at every width.

#### Photography

A concept with no pictures reads as a template with a name dropped in, and an
empty demo was the normal case rather than the exception: the pipeline selects
businesses whose current site is poor, and a poor site is usually poor at
images too. So:

- The crawler finds photography the way real sites actually publish it —
  `srcset`, `<picture>` sources, lazy-loading `data-` attributes and CSS
  background images, not just `<img src>`. Reading only `src` found nothing on
  most Squarespace, Wix and WordPress themes.
- Candidates are scored before anything is downloaded: how the image was
  prepared, whether it has a written alt, its declared size, and what its path
  suggests. Logos, badges, payment marks and icon-sized files are discarded.
- **Their photography is always used first.** Generation only fills the frames
  left over, is off by default, is capped per demo, and is billed per picture
  against the campaign like any other model call.
- Every generated picture is labelled *indicative* on the page, in its alt
  text, in the ribbon at the top and in the exported project's README. A
  concept sent to a stranger must never imply we photographed their premises.

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
- **A daily cap on unattended research**, for the same reason as the outreach
  cap: a loop that can start work is a loop that can start it a thousand times.
- **The agent may not rewrite its own guardrails.** A skill that tries to talk
  the pipeline past the outreach cap, robots.txt or the honest-observation rule
  is rejected in code, whoever wrote it and whatever the settings say.
- **Anything the agent chooses to fetch is checked first** — robots.txt, and a
  guard that refuses anything but a public http(s) address.

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

### What the agent can do for itself

The pipeline used to be a sequence of prompts. It is now an agent with tools, a
memory and a set of instructions you can edit — managed entirely from **Growth
→ Research / Skills / Memory**.

**Tools.** The agent has a small, deliberately unglamorous toolbox
(`src/lib/agent/tools.ts`): search the web, open and read a page, list a page's
links, pull elements out by CSS selector, photograph a page, recall what it
knows, write something down, and write a skill for itself. Each tool answers in
the smallest form that still carries the answer — a page comes back as text
with its headings and links, a screenshot as a note saying where the image was
filed — because a tool that returns 200kB of HTML has not given the model
information, it has given it a context window problem.

**A real browser.** A plain `fetch` sees the HTML the server sent, which on a
site that draws itself with JavaScript is nothing at all. Everything downstream
was then wrong about a business with a perfectly good site: the audit said
"thin content", the angle was written about a problem they do not have, and the
email that landed was wrong in a way they would notice immediately. With
Browser Rendering configured the agent renders the page properly — by default
only when a fetch comes back suspiciously thin, which is the case that matters
and a fraction of the cost of rendering everything. It also keeps a screenshot
of each prospect's site as it is today, which is the one artefact that cannot
be recovered later, since we are about to ask them to change it.

Set `CLOUDFLARE_ACCOUNT_ID` and a token with the Browser Rendering permission
(`BROWSER_RENDERING_TOKEN`, or `CLOUDFLARE_API_TOKEN` when it carries that
permission too). Without them everything still runs over `fetch`.

**The same robots.txt applies.** The agent picks its own URLs, so it checks
robots.txt before every read — including the ones that go through the rendering
service, because a page fetched on our behalf is still a page we fetched.
Results are cached for fifteen minutes so being polite does not double the
number of requests we make to somebody's server. URLs are also checked against
a public-address guard: no other schemes, no localhost, no private ranges, no
cloud metadata endpoint.

**Memory.** Every run used to start from nothing and work out the same things
again. A memory is one sentence with a scope — global, a trade, a region, a
campaign or one business — recalled by meaning where an embedding model is
available and by words where it is not. Writes are deduplicated, so the same
lesson learned twice raises the confidence of one row rather than adding a
second; recall is capped and scored, so a thousand memories cost the same
prompt space as ten. Memories reach a prompt labelled as *recollections, not
rules*: if what is in front of the model contradicts one, it is told to believe
what is in front of it and say so. Everything it knows is readable, pinnable
and deletable on the memory page, and marking one **wrong** retires it rather
than deleting it so the bad inference stays reviewable.

**Skills.** A skill is a named piece of instruction — "how to open an email to
a trade business", "what to check before calling a site dated" — with a
one-line trigger describing when it applies. Before a stage asks the model
anything, every skill's trigger line is considered (cheap: one line each) and
the best few have their full body loaded (not cheap, which is why it is only a
few). Writing twenty skills therefore costs about what three used to.

**Self-improvement, and its limits.** At the end of a completed run the agent
looks back over what actually happened and writes down what would change the
next one. Most of that becomes memories. Occasionally it proposes a *skill* —
and under the default setting a proposal is all it is: it loads nothing until
you approve it on the skills page. Set self-improvement to "just do it" and its
edits take effect immediately; every version is kept and revertable either way,
so that is reversible rather than reckless.

Three things it cannot do to itself, in code rather than in a prompt: edit a
skill you have locked, write a skill that tries to talk the pipeline past the
outreach cap, robots.txt or the rule that outreach only cites observations we
actually made (`FORBIDDEN_PATTERNS` in `src/lib/agent/skills.ts`), or start
unlimited research — unattended research has its own daily cap, like sending.

**Research on its own.** "Go and find out X" is the shape of work the pipeline
could never do, because every stage answers a question decided in advance. Ask
one from **Growth → Research** and the agent searches, opens pages, reads them,
checks what it already knows, and answers with its sources — showing each step
as it happens, because an agent that shows a spinner and then a paragraph is
impossible to trust and impossible to debug. It runs on the same tools, memory
and skills as the pipeline, so a lesson learned answering a question by hand
turns up in the next campaign, and a skill written during a campaign is loaded
the next time you ask something it applies to. Each task has a hard ceiling on
tool calls; when it is spent the agent answers from what it has and says what
it could not establish.

Under `AI decides` on the **enrich** stage, the pipeline uses the same
machinery per prospect: what a crawl cannot tell you — whether they have just
changed hands, whether the reviews say something the site does not — with a
smaller budget, because it is running unattended against every business on the
shortlist.

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

`DEMO_HOST` is a **pattern**, and `*` is where the business's label goes:

```
DEMO_HOST=*-demo.jwbsstudio.com   →  wells-coffee-demo.jwbsstudio.com
DEMO_HOST=demo.jwbsstudio.com     →  wells-coffee.demo.jwbsstudio.com
```

A value with no `*` is read as `*.<value>`, so both spellings describe the same
thing and an existing setting does not change meaning.

The pattern exists because of the certificate, which is the part that catches
people out. Cloudflare's free Universal SSL covers the zone apex and **one**
label below it. `wells-coffee.demo.jwbsstudio.com` is two labels deep and is
not covered, so the DNS record and the route can both be right and the browser
still refuses the connection. A hyphenated label is one label deep — covered
for nothing — while a route of `*-demo.jwbsstudio.com/*` still cannot match
`www` or anything else on the zone.

Then add both of these once, written exactly as the settings page shows them:

```
*.jwbsstudio.com        CNAME   billing.jwbsstudio.com   (proxied)
route: *-demo.jwbsstudio.com/*  →  this Worker
```

> **The DNS record is broader than the route, and has to be.** A DNS wildcard
> is a whole label: `*.jwbsstudio.com` is valid, `*-demo.jwbsstudio.com` is
> not — it would be stored as a literal name matching nothing. The wildcard
> above is the nearest record that covers the pattern. Explicit records win
> over a wildcard, so `www`, `billing` and the rest of the zone are unaffected,
> and the route still serves only the demos.
>
> If you would rather not have a zone-wide wildcard at all, set
> `CLOUDFLARE_API_TOKEN` (Zone:DNS:Edit, nothing else) and `CLOUDFLARE_ZONE_ID`
> and a proxied record is created per demo at build time instead. Then build a demo and press **Check
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
npx wrangler secret put SEARCH_API_KEY        # optional — real web search
npx wrangler secret put BROWSER_RENDERING_TOKEN # optional — a real browser
```

The agent's two optional capabilities are worth setting up in this order:
`SEARCH_PROVIDER` (`brave` or `serper`) with `SEARCH_API_KEY` gives it real web
search instead of a Wikipedia fallback, and `CLOUDFLARE_ACCOUNT_ID` with a
token carrying the Browser Rendering permission lets it read client-rendered
sites and take screenshots. Both are secrets on the app Worker **and** the
agent Worker (`npx wrangler secret put … -c workers/agent/wrangler.jsonc`),
since the pipeline runs in the agent.
npx wrangler secret put CRON_SECRET           # for automatic reminders
```

`CRON_SECRET` is what the scheduled job authenticates with. Without it the
reminder and housekeeping endpoints refuse everything and nothing is sent —
which is the right failure for an endpoint that emails your clients. Generate
it the same way as the session secret.

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

### Migrations, and the one rule about them

Migrations are generated from `src/lib/db/schema.ts`, never written by hand:

```bash
npm run db:generate
```

Every `CREATE` in `migrations/` is `CREATE ... IF NOT EXISTS`, and every `DROP`
is `DROP ... IF EXISTS`. drizzle-kit does not emit them that way, so
`db:generate` runs `scripts/idempotent-migrations.mjs` afterwards to add the
guards, and `tests/migrations.test.ts` fails if any are missing. The reason is
that wrangler decides what to apply by **filename**, against the names in the
`d1_migrations` table — a name it does not recognise is run in full, and a bare
`CREATE TABLE` then aborts the whole migration on the first object that is
already there.

That makes re-application survivable, not safe: SQLite has no
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so a re-run still stops at the
first column it has already added. **So never rename or renumber a migration
that has been applied anywhere.** If a branch merge forces it, record the new
name as already applied rather than letting it re-run:

```sql
INSERT INTO d1_migrations (name, applied_at)
SELECT '0010_growth_engine.sql', CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = '0010_growth_engine.sql');
```

Locally, deleting the database and migrating from scratch is usually simpler.

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

## The activity log

Three logs exist, and they are not the same thing:

| Table | Keyed by | Holds |
| --- | --- | --- |
| `activity_log` | the acting user | the internal audit trail, including every auth decision |
| `communications` | client | calls, meetings and notes you log by hand |
| `invoice_events` | invoice | what was sent, and what the client did with it |

The third is the new one, and it exists because neither of the others can
answer "INV-0042 went out Tuesday, the reminder Friday, and they opened both
but have never opened the web invoice" — which is what you want to know before
chasing a payment.

There is no separate activity screen, deliberately: the log is only useful
next to the thing it describes. The invoice page carries that invoice's
history, with an engagement summary in the card header — "2 web views · 1 PDF
download", or "Sent, but the client has not opened it yet". The client page
carries theirs, merging `invoice_events` with `communications` so a logged
phone call sits in sequence with the reminder that prompted it.

### What each signal is worth

In descending order of how much you should trust it:

1. **Payment started** — they reached Stripe's checkout. Unambiguous, and an
   abandoned checkout is very different from silence.
2. **PDF downloaded** — deliberate, and usually means the invoice is on its way
   to whoever actually pays it.
3. **Web invoice viewed** — someone opened the public link. Strong.
4. **Email opened** — a 1×1 image in the email was fetched. **Weak.** Treat it
   as a hint, never as proof:
   - Most clients block remote images by default, so *no open does not mean
     unread*.
   - Apple Mail Privacy Protection and corporate scanners pre-fetch every image
     whether or not anyone opened the message, so *an open does not mean read*.
     Where the fetch is recognisably a proxy (Gmail, Mimecast and friends) the
     event says so.
   - A forwarded email logs against the original send.

Repeats of the same client-side event within 30 minutes collapse into one row,
so a reload does not look like renewed interest. Anything after that window
gets its own row, because coming back to an invoice twice in a week is a real
signal.

### Open tracking is optional

**Settings → Record when a client opens an invoice email** controls it, and it
is on by default. Switched off, invoice emails contain no remote images at all
and the log simply has no `email-opened` rows — everything else still works,
including the three stronger signals above, none of which need a pixel.

The pixel URL carries the invoice's existing public token and the id of the
send event, and nothing else — no address, no name. Anyone holding that URL
could already open the invoice itself, so it discloses nothing new. The route
(`/t/<token>/<send>.gif`) answers every request with the same image and the
same 200, hit or miss, so it cannot be used to work out which tokens are real.

Every write in this subsystem is best effort: a logging failure is written to
the console and swallowed, because a client must never see an error page — and
an invoice must never fail to send — over a row in an activity table.

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

`/templates` is a visual builder for the outbound wording. It saves three
things per template: the Tiptap JSON it reloads from, the rendered HTML that gets
mailed, and a plain-text alternative. Rendering happens **in the browser** —
the Worker never runs React Email, which keeps Tiptap out of the Worker bundle
entirely (it is a ~2.5 MB client chunk, ~790 KB gzipped, loaded only on the
builder page).

A three-pane builder, in the shape anyone who has used Klaviyo or GrapesJS
expects: **blocks** and **layers** on the left, the **canvas** in the middle,
**design** and **variables** on the right. Blocks drag onto the canvas (or
click, for touch and keyboard); the selected block gets an outline and a
toolbar to move, duplicate or delete it; the design panel edits its spacing,
colour, size and alignment, and the email's own background and width. A
desktop/mobile toggle changes the canvas width the way a client would.

The thing that makes this work is that **there is no second model of the
email**. The canvas is a real rich-text editor — click in and type, paste, undo
— and every piece of builder chrome is a reading of that same document rather
than a parallel tree kept in sync with it. A block dragged in and a paragraph
typed by hand produce the same kind of node, which is why the builder and the
text editing can coexist instead of fighting. `builder/targeting.ts` is the
whole translation layer: which block is under this point, where is it on
screen, and how do you move it. `tests/builder.test.ts` drives those against a
real editor, because ProseMirror position arithmetic is where this kind of
thing quietly goes wrong — a node's position is not its index, and nothing
throws when you get it a little bit off.

**Base templates** (`src/lib/mail/starters.ts`) give a finished layout to edit
down rather than a blank page; one can be chosen when the template is created
or applied later from *Start from a base*. They are authored as HTML rather
than editor JSON, for two reasons: hand-written Tiptap JSON is unreviewable,
and converting HTML into it needs the editor schema, which must stay out of
the Worker. So a starter's id rides along on the redirect into the editor and
the browser applies the body. `tests/starters.test.ts` parses every starter and
every palette block through the real schema and asserts each one arrives as the
block it claims to be — a button missing one attribute is still valid HTML, it
just silently turns into a paragraph.

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
npm run deploy           # deploy the agent worker, then build + deploy the app
npm run deploy:agent     # deploy only the campaign agent worker
npm run dev:agent        # run the campaign agent worker locally
npm test                 # run the test suite
npm run typecheck        # tsc --noEmit
npm run typecheck:agent  # tsc --noEmit for the agent worker
npm run db:generate      # generate a migration from schema changes
npm run db:idempotent    # add the IF NOT EXISTS guards to migrations by hand
npm run db:migrate:local # apply migrations locally
npm run db:migrate:remote # apply migrations to the deployed database
npm run user:add         # create or reset a user
```

The package manager is **bun** (`packageManager` in package.json pins it, and
`bun.lock` needs bun 1.4 or newer to read). `npm` works for everything above;
use `bun run <script>` if you would rather not mix them.

### Scheduled work

Two Cron Triggers, declared in `wrangler.jsonc`:

| Schedule (UTC) | Task | What it does |
| --- | --- | --- |
| `0 8 * * *` | `reminders` | Sends payment reminders that are due |
| `0 3 * * 0` | `housekeeping` | Purges expired sessions and spent sign-in links |

Cron Triggers invoke a Worker's `scheduled()` handler, which the Astro
Cloudflare adapter does not emit. `scripts/wrap-worker.mjs` runs after
`astro build` and adds one that calls back into the app's own `fetch`, so the
job runs inside the real application rather than as a second, half-wired copy
of it. If the adapter ever changes the shape of its entrypoint, that script
fails the build rather than deploying something that silently never fires.

To see what tonight's run would do without sending anything:

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  "https://billing.jwbsstudio.com/api/cron/reminders?dryRun=1"
```

Add `&today=2026-12-24` to ask the same question about a future date.

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

6. **The agent's memory is scanned, not indexed.** Recall reads up to 400
   candidate rows and scores them in JavaScript. That is the right trade at
   this size — no binding to provision, no second store to keep in step with
   the rows it describes — and the wrong one at a hundred thousand memories,
   where it should move to Vectorize. Recall stays bounded either way; what
   degrades first is which memories are considered, oldest dropped.

7. **Without Browser Rendering, client-rendered sites read as empty.** The
   pipeline still runs and says what it saw, but a business whose site is a
   JavaScript bundle will be assessed as having no content. That is a wrong
   answer rather than a missing one, which is why the settings page says
   plainly whether a browser is configured.

8. **A skill is an instruction, and the model follows instructions.** Skills
   are ranked below the built-in rules in the prompt and checked against the
   forbidden patterns before they are saved, but a badly written skill will
   still make the output worse in ways that are hard to attribute. If results
   drift, the skills page is the first place to look, and every version is
   revertable.

9. **The live run socket may fall back to polling.** The agent is reached
   through an authenticated route on this app rather than being publicly
   exposed. If the upgrade does not survive, the run view polls every four
   seconds instead. Nothing is lost — D1 is authoritative for everything shown.

10. **Some rate figures need confirming.** Anything marked `verify` in
   `src/lib/tax/rates.ts` came from secondary sources. The app lists them on the
   Tax page and in Settings with links to the official source. The ones most
   worth checking: the ACC work levy rate for your classification unit (the
   default is the scheme average and will not match your bill), the Medicare
   levy low-income threshold, and whether the AU$20,000 instant asset write-off
   was legislated for 2026-27.

11. **It does not decide your tax residence.** It asks you to state it. If both
   countries could claim you, the DTA tie-breaker decides, and that is a
   facts-and-circumstances question for an accountant.

12. **Multi-currency is simplistic.** Invoices carry a currency and an FX rate
   field, but there is no automatic rate lookup and no FX gain/loss tracking.

13. **Estimates, not returns.** The tax figures are for setting money aside.
   Filing is a job for your accountant.

14. **Single user in practice.** The schema is user-scoped throughout and roles
   exist, but nothing has been built around the `accountant` or `viewer` roles
   yet.

15. Four dev-only `npm audit` warnings come from drizzle-kit's bundled esbuild.
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
    ai/           Workers AI helpers, usage tracking, the prompt cache and pricing
      chat.ts       multi-turn calls with tools, normalised across model shapes
      embed.ts      embeddings and cosine similarity, for recalling by meaning
    agent/        the part that can go and find things out
      browser.ts    Browser Rendering: render, screenshot, scrape; fetch fallback
      websearch.ts  Brave, Serper, and a keyless Wikipedia fallback
      memory.ts     what it has learned, scoped, deduplicated and recallable
      skills.ts     instructions it loads when they apply, versioned and revertable
      tools.ts      the toolbox, and the guards on what it may reach
      loop.ts       the bounded tool-calling loop and its three ways of stopping
      research.ts   one research task, start to finish, with its transcript
      reflect.ts    what a finished run taught, as memories and skill proposals
      context.ts    assembling all of the above from settings and bindings
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
    activity/     the invoice activity log: events, timelines, open tracking
    db/           Drizzle schema and client
    queries/      aggregate queries for dashboard and tax pages
  pages/          Astro routes and API endpoints
  components/     Astro components and React islands
workers/
  agent/          the campaign and research agents — a Durable Object each, deployed separately
migrations/       D1 migrations
tests/            459 tests: the tax engine, and the pure parts of the pipeline and the agent
docs/             the tax research
```
