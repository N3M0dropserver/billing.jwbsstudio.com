# Eight skills, written for the agent brain's table

## Why this is a document and not code

These were written for a second, parallel skills system on the
`claude/demo-quality-research-720d1y` branch, before anyone noticed that
`claude/confident-mayer-l34n1i` had already built one — `agent_skills`,
`agent_skill_revisions`, `agent_memories`, `agent_research` and the loop that
uses them. That branch's `0013_agent_brain.sql` is applied to the production
D1; the branch itself is not merged.

The parallel system was removed rather than merged, because two tables called
`agent_skills` cannot coexist and because the existing one is better: it
versions edits, records use and success counts, lets the agent propose its own
skills under `agent_self_improve`, and picks skills by progressive disclosure
rather than by a hard-coded niche list.

What was worth keeping is the writing. Each skill below is already in the
shape `agent_skills` expects, so it can be inserted as a row — by hand, by a
seed script, or through the skills UI on that branch.

## Columns

`stages` uses `CAMPAIGN_STAGES`, so the four in use here are `shortlist`
(judging a prospect), `plan` (designing the page), `build` (photography) and
`propose` (the outreach email). `origin` should be `builtin` or `user`;
`status` `active`.

The "matched in my version on" line records the niche stems the removed system
used to decide whether a skill applied. The existing system decides from
`when_to_use` instead, so that line is background, not a field.

## Designing for somewhere people walk into
- **slug** `hospitality-page`
- **stages** `["plan"]`
- **tags** `["hospitality","design"]`
- **description** Cafes, bars, restaurants, bakeries — the page has one job and it is not brand.
- **when_to_use** The business is a cafe, bar, restaurant, bakery or similar — somewhere people physically go to eat or drink.
- matched in my version on: cafe, coffee, restaurant, bar, bakery, bistro, deli, eatery, pub, brunch, patisserie, roaster
**instructions**
```text
This is a place people physically go to. Almost everyone reading the page is deciding
ONE of three things: is it open, where is it, and is it the kind of place I want. The
page answers those first and everything else after.

- Put the address and the hours where they can be read without scrolling twice. A
  location section is not optional for this kind of business and it is not a footer note.
- The hero says what they actually serve and to whom, in their words, not "great food and
  coffee". "Filipino bakery on Burton St, open from seven" is a hero. "Welcome" is not.
- Name the things: the dish, the bean, the pastry, the suburb, the hours. A menu you
  cannot list is still worth describing in one specific sentence.
- If their reviews name a specific thing — a dish, the queue, the owner remembering an
  order — that sentence is the best copy available. Use it as a quote, attributed.
- Do not write a story about provenance, craft or passion unless their own material
  says it. Every cafe page written from nothing says the same three things and reads as
  a template.
- One primary action: directions, or a booking. Not a newsletter.
```
---

## Designing for a trade that quotes
- **slug** `trades-page`
- **stages** `["plan"]`
- **tags** `["trades","design"]`
- **description** Plumbers, sparkies, builders — the page exists to get a phone call started.
- **when_to_use** The business is a trade that quotes for work: plumber, electrician, builder, roofer, landscaper, painter.
- matched in my version on: plumb, electric, builder, building, carpent, roofing, landscap, paint, tiler, concrete, fencing, arborist
**instructions**
```text
The reader has a problem right now and is deciding whether to call. Nothing else on the
page matters as much as making that easy and making them feel safe doing it.

- The phone number is the primary action, on the first screen, as a tel: link.
- Say the service area in the words a customer would use — the suburbs, not "the wider
  region".
- A services section carries the actual jobs they do, three or more, each with a
  sentence. "General plumbing" is not a job; "hot water cylinder replacement" is.
- Credibility beats polish here: licence or certification numbers, years trading, and
  whether they are insured — but ONLY where their own material states them. Never write
  a number you were not given.
- Say what happens after they call, in one sentence, if their material supports it.
  Uncertainty about the process is the main reason people do not ring a stranger.
- No stock enthusiasm. This trade reads it as marketing and distrusts it.
```
---

## Designing from a listing and nothing else
- **slug** `no-website-page`
- **stages** `["plan"]`
- **tags** `["no-website","design"]`
- **description** The common case: no site to draw on, so the page is built from facts or not at all.
- **when_to_use** The business has no website of its own, so the page must be built from a directory listing alone.
**instructions**
```text
There is no site of theirs to read. Everything you have is a directory record: an
address, some hours, a rating, and what their customers wrote. That is enough for a good
short page and nowhere near enough for a long one.

- Build the page out of those facts, in that order of confidence: what they are, where
  they are, when they are open, what people say, how to reach them.
- Their reviews are the only voice you have. Quote two or three as written, attributed
  to the name given. Do not paraphrase a review into your own copy and do not average
  them into a sentence about quality.
- FOUR strong sections beat seven thin ones. Leave a section out rather than write a
  heading you cannot fill.
- Never invent a founding year, a menu, a speciality, a team, or a process. If you find
  yourself writing a sentence that would be true of any business in this trade, delete
  it — that sentence is what makes a concept look generated.
- Write every imageHint as though briefing a photographer who is standing outside their
  door, because a picture of the street they are on is the only picture anyone has.
```
---

## Designing when the problem is trust
- **slug** `credibility-rebuild`
- **stages** `["plan"]`
- **tags** `["credibility","design"]`
- **description** They are found but not believed — the page has to look like a real operation.
- **when_to_use** The page's job is credibility — people are finding them and then hesitating.
**instructions**
```text
People are finding them and then hesitating. The page is not there to explain what they
do — that is already understood — it is there to make them look like a going concern.

- Lead with proof, not with a proposition: how long they have traded, how many they have
  served, what people say. Only what their own material or their reviews state.
- Real quotes with real names do more here than any amount of copy. If you have them,
  a testimonials section goes high on the page rather than near the bottom.
- Specificity IS the credibility. An address, a phone number that is a landline, named
  hours, a person's name — each one is evidence. Vagueness reads as a front.
- Keep the design quiet. A business that looks like it is trying to impress reads as
  less established, not more.
```
---

## Photographing somewhere with a door
- **slug** `place-photography`
- **stages** `["build"]`
- **tags** `["imagery"]`
- **description** The frames a physical business always has, described so the hint is not vague.
- **when_to_use** Any business with a physical premises, when describing what photograph a section needs.
**instructions**
```text
Every business with a premises has the same handful of pictures available, and a hint
that names one of them beats a hint that describes a mood.

- The shopfront from across the street, in daylight, with the street visible.
- The room from the doorway, at eye level, empty or nearly so.
- The counter or the bench where the work happens, close, from slightly above.
- The thing itself — the plate, the cup, the finished job — filling the frame.

Write the hint as one of those, made specific to this business. Never ask for a person
as the subject, never ask for signage or a name on a window, and never describe a mood
("warm and inviting") in place of a subject.
```
---

## Photographing food and drink
- **slug** `food-photography`
- **stages** `["build"]`
- **tags** `["hospitality","imagery"]`
- **description** What a hospitality page needs in frame, and the two ways generated food goes wrong.
- **when_to_use** A cafe, bar, restaurant or bakery, when describing or generating food and drink photography.
- matched in my version on: cafe, coffee, restaurant, bar, bakery, bistro, deli, eatery, pub, brunch, patisserie, roaster
**instructions**
```text
Food photographs badly when it is asked for in general and well when it is asked for by
name. Prefer a single named item, close, in natural side light, on the surface it is
actually served on.

- One plate, one cup, one pastry. A table covered in dishes reads as a stock library.
- Daylight from the side or behind. Overhead artificial light is what makes generated
  food look plastic.
- Shallow depth of field, the front edge of the food sharp.
- Do not ask for hands, faces, or someone eating.
- Do not ask for a dish their material does not mention. A concept showing a business
  food they do not serve is worse than a concept showing no food.
```
---

## Spotting who actually reads the email
- **slug** `owner-operated-signals`
- **stages** `["shortlist"]`
- **tags** `["qualify"]`
- **description** The signals that separate an owner-operator from a branch with no authority.
- **when_to_use** Judging whether a business is owner-operated and worth approaching cold.
**instructions**
```text
The question underneath fit_score is always: will the person who reads this email be the
person who can say yes? Weigh these, where the audit or the listing shows them.

Towards owner-operated:
- One location, a landline or mobile rather than an 0800 number, an address that is a
  street rather than a level in a tower.
- A personal mailbox, or a first name anywhere in their material.
- Reviews that mention the owner or a named staff member.
- A site that is visibly self-built or long untouched: a free platform badge, a copyright
  year several years old, a template still carrying its demo text.

Away from it:
- A careers or press page, a franchise or licensing page, multiple locations listed.
- An agency credit in the footer, a marketing stack, a cookie consent banner from a
  managed service.
- A brand name that appears in more than one suburb.

Weigh what is shown. Absence of a signal is not evidence of the opposite.
```
---

## Opening a cold email to a stranger
- **slug** `first-line-that-lands`
- **stages** `["propose"]`
- **tags** `["outreach"]`
- **description** The first sentence decides whether the rest is read. What works and what does not.
- **when_to_use** Writing the opening line of a cold outreach email.
**instructions**
```text
The opening line is the whole email. It has to prove, in one sentence, that a person
looked at their business rather than a list.

Works: a specific, checkable, non-insulting observation. Where they are. What their
reviews keep saying. That their site does not work on a phone. That there is no site at
all and their listing is doing the work instead.

Does not work, ever:
- "I hope this email finds you well", "I came across your business", "I was browsing".
- Any compliment that could be pasted into the next email unchanged.
- Anything implying they have done something wrong. They built that site at midnight
  after a shift, or paid someone who disappeared.
- A question you do not want answered ("do you have a website?" — you know they do not).

Then say plainly that you built something they did not ask for, and that it is there to
look at. The unasked-for part is the interesting part; hiding it makes it presumptuous.
```
