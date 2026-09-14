/**
 * What the agent knows how to do, as separate pieces.
 *
 * The system prompts in `prompts.ts` are what the agent is *for* — they hold
 * for every prospect in every run, and there is one of each. A skill is the
 * other half: know-how that applies to *some* prospects, that you want to add
 * without rewriting the prompt that already works.
 *
 * "Design a page for a place people physically walk into" is a skill. So is
 * "photograph a food business". Neither belongs in the planner's system
 * prompt, because two thirds of the prospects in a run are not that — and a
 * prompt that lists every case is a prompt that follows none of them.
 *
 * So each skill names the stage it lands in and the prospects it applies to,
 * and only the matching ones are appended to that stage's prompt. A run over
 * a street of cafes gets the hospitality skills; the plumber two doors down
 * does not.
 *
 * The built-ins below live in source, like the prompt defaults, for the same
 * reason: they are the thing under version control, they are what "reset"
 * means, and an improvement to one reaches everybody who has not deliberately
 * changed it. A row in `agent_skills` either overrides a built-in by slug or
 * adds a new skill of the user's own.
 *
 * Everything a skill says is instructions to a model and nothing else. It is
 * interpolated into a system message, never executed, and it cannot reach the
 * contract that decides whether the answer parses.
 */

/**
 * Where a skill lands.
 *
 * Only stages that actually ask a model something are here. A skill for the
 * publish stage would have nowhere to go, and offering one would be a promise
 * the pipeline cannot keep.
 */
export type SkillStage = 'qualify' | 'plan' | 'imagery' | 'outreach';

export const SKILL_STAGES: Array<{ stage: SkillStage; label: string; blurb: string }> = [
  {
    stage: 'qualify',
    label: 'Judging',
    blurb: 'Read when deciding whether a business is worth approaching at all.',
  },
  {
    stage: 'plan',
    label: 'Design',
    blurb: 'Read when writing the page — its sections, its structure and every word on it.',
  },
  {
    stage: 'imagery',
    label: 'Build',
    blurb: 'Read when describing the photography a page needs, and generating what is missing.',
  },
  {
    stage: 'outreach',
    label: 'Outreach',
    blurb: 'Read when writing the cold email that carries the link.',
  },
];

/** Whether a business has a site of its own, as a condition. */
export type WebsiteCondition = 'any' | 'with' | 'without';

export interface SkillMatch {
  /**
   * Words that must appear in the trade or the directory's category.
   * Empty means every trade. Matched case-insensitively as substrings, so
   * "cafe" catches "cafes" and "Cafe / Coffee Shop".
   */
  niches: string[];
  /** Objectives this applies to. Empty means all three. */
  objectives: Array<'conversion' | 'awareness' | 'credibility'>;
  /** Whether they already have a site. */
  website: WebsiteCondition;
}

export interface AgentSkill {
  /** Stable across edits and renames; how a built-in is overridden. */
  slug: string;
  name: string;
  stage: SkillStage;
  /** One line, for the list. Not sent to the model. */
  summary: string;
  /** The know-how itself. This is what reaches the prompt. */
  instructions: string;
  match: SkillMatch;
  enabled: boolean;
  /** True for the ones shipped in source. */
  builtIn: boolean;
}

export const ANY_MATCH: SkillMatch = { niches: [], objectives: [], website: 'any' };

/** The most skills one stage will send. Beyond this a prompt stops being read. */
export const MAX_SKILLS_PER_STAGE = 4;

/** The ceiling on one skill's instructions. */
export const MAX_SKILL_LENGTH = 4000;

/* ------------------------------------------------------------------ */
/* The built-ins                                                       */
/* ------------------------------------------------------------------ */

const HOSPITALITY = [
  'cafe',
  'coffee',
  'restaurant',
  'bar',
  'bakery',
  'bistro',
  'deli',
  'eatery',
  'pub',
  'brunch',
  'patisserie',
  'roaster',
];

const TRADES = [
  'plumb',
  'electric',
  'builder',
  'building',
  'carpent',
  'roofing',
  'landscap',
  'paint',
  'tiler',
  'concrete',
  'fencing',
  'arborist',
];

/**
 * Shipped skills.
 *
 * Deliberately few, and each one earns its place by covering something the
 * planner gets wrong without it. A library of thirty would be a library
 * nobody reads and a prompt nobody follows.
 */
export const BUILT_IN_SKILLS: AgentSkill[] = [
  {
    slug: 'hospitality-page',
    name: 'Designing for somewhere people walk into',
    stage: 'plan',
    summary: 'Cafes, bars, restaurants, bakeries — the page has one job and it is not brand.',
    builtIn: true,
    enabled: true,
    match: { niches: HOSPITALITY, objectives: [], website: 'any' },
    instructions: [
      'This is a place people physically go to. Almost everyone reading the page is deciding',
      'ONE of three things: is it open, where is it, and is it the kind of place I want. The',
      'page answers those first and everything else after.',
      '',
      '- Put the address and the hours where they can be read without scrolling twice. A',
      '  location section is not optional for this kind of business and it is not a footer note.',
      '- The hero says what they actually serve and to whom, in their words, not "great food and',
      '  coffee". "Filipino bakery on Burton St, open from seven" is a hero. "Welcome" is not.',
      '- Name the things: the dish, the bean, the pastry, the suburb, the hours. A menu you',
      '  cannot list is still worth describing in one specific sentence.',
      '- If their reviews name a specific thing — a dish, the queue, the owner remembering an',
      '  order — that sentence is the best copy available. Use it as a quote, attributed.',
      '- Do not write a story about provenance, craft or passion unless their own material',
      '  says it. Every cafe page written from nothing says the same three things and reads as',
      '  a template.',
      '- One primary action: directions, or a booking. Not a newsletter.',
    ].join('\n'),
  },
  {
    slug: 'trades-page',
    name: 'Designing for a trade that quotes',
    stage: 'plan',
    summary: 'Plumbers, sparkies, builders — the page exists to get a phone call started.',
    builtIn: true,
    enabled: true,
    match: { niches: TRADES, objectives: [], website: 'any' },
    instructions: [
      'The reader has a problem right now and is deciding whether to call. Nothing else on the',
      'page matters as much as making that easy and making them feel safe doing it.',
      '',
      '- The phone number is the primary action, on the first screen, as a tel: link.',
      '- Say the service area in the words a customer would use — the suburbs, not "the wider',
      '  region".',
      '- A services section carries the actual jobs they do, three or more, each with a',
      '  sentence. "General plumbing" is not a job; "hot water cylinder replacement" is.',
      '- Credibility beats polish here: licence or certification numbers, years trading, and',
      '  whether they are insured — but ONLY where their own material states them. Never write',
      '  a number you were not given.',
      '- Say what happens after they call, in one sentence, if their material supports it.',
      '  Uncertainty about the process is the main reason people do not ring a stranger.',
      '- No stock enthusiasm. This trade reads it as marketing and distrusts it.',
    ].join('\n'),
  },
  {
    slug: 'no-website-page',
    name: 'Designing from a listing and nothing else',
    stage: 'plan',
    summary: 'The common case: no site to draw on, so the page is built from facts or not at all.',
    builtIn: true,
    enabled: true,
    match: { niches: [], objectives: [], website: 'without' },
    instructions: [
      'There is no site of theirs to read. Everything you have is a directory record: an',
      'address, some hours, a rating, and what their customers wrote. That is enough for a good',
      'short page and nowhere near enough for a long one.',
      '',
      '- Build the page out of those facts, in that order of confidence: what they are, where',
      '  they are, when they are open, what people say, how to reach them.',
      '- Their reviews are the only voice you have. Quote two or three as written, attributed',
      '  to the name given. Do not paraphrase a review into your own copy and do not average',
      '  them into a sentence about quality.',
      '- FOUR strong sections beat seven thin ones. Leave a section out rather than write a',
      '  heading you cannot fill.',
      '- Never invent a founding year, a menu, a speciality, a team, or a process. If you find',
      '  yourself writing a sentence that would be true of any business in this trade, delete',
      '  it — that sentence is what makes a concept look generated.',
      '- Write every imageHint as though briefing a photographer who is standing outside their',
      '  door, because a picture of the street they are on is the only picture anyone has.',
    ].join('\n'),
  },
  {
    slug: 'credibility-rebuild',
    name: 'Designing when the problem is trust',
    stage: 'plan',
    summary: 'They are found but not believed — the page has to look like a real operation.',
    builtIn: true,
    enabled: true,
    match: { niches: [], objectives: ['credibility'], website: 'any' },
    instructions: [
      'People are finding them and then hesitating. The page is not there to explain what they',
      'do — that is already understood — it is there to make them look like a going concern.',
      '',
      '- Lead with proof, not with a proposition: how long they have traded, how many they have',
      '  served, what people say. Only what their own material or their reviews state.',
      '- Real quotes with real names do more here than any amount of copy. If you have them,',
      '  a testimonials section goes high on the page rather than near the bottom.',
      '- Specificity IS the credibility. An address, a phone number that is a landline, named',
      '  hours, a person\'s name — each one is evidence. Vagueness reads as a front.',
      '- Keep the design quiet. A business that looks like it is trying to impress reads as',
      '  less established, not more.',
    ].join('\n'),
  },
  {
    slug: 'place-photography',
    name: 'Photographing somewhere with a door',
    stage: 'imagery',
    summary: 'The frames a physical business always has, described so the hint is not vague.',
    builtIn: true,
    enabled: true,
    match: { niches: [], objectives: [], website: 'any' },
    instructions: [
      'Every business with a premises has the same handful of pictures available, and a hint',
      'that names one of them beats a hint that describes a mood.',
      '',
      '- The shopfront from across the street, in daylight, with the street visible.',
      '- The room from the doorway, at eye level, empty or nearly so.',
      '- The counter or the bench where the work happens, close, from slightly above.',
      '- The thing itself — the plate, the cup, the finished job — filling the frame.',
      '',
      'Write the hint as one of those, made specific to this business. Never ask for a person',
      'as the subject, never ask for signage or a name on a window, and never describe a mood',
      '("warm and inviting") in place of a subject.',
    ].join('\n'),
  },
  {
    slug: 'food-photography',
    name: 'Photographing food and drink',
    stage: 'imagery',
    summary: 'What a hospitality page needs in frame, and the two ways generated food goes wrong.',
    builtIn: true,
    enabled: true,
    match: { niches: HOSPITALITY, objectives: [], website: 'any' },
    instructions: [
      'Food photographs badly when it is asked for in general and well when it is asked for by',
      'name. Prefer a single named item, close, in natural side light, on the surface it is',
      'actually served on.',
      '',
      '- One plate, one cup, one pastry. A table covered in dishes reads as a stock library.',
      '- Daylight from the side or behind. Overhead artificial light is what makes generated',
      '  food look plastic.',
      '- Shallow depth of field, the front edge of the food sharp.',
      '- Do not ask for hands, faces, or someone eating.',
      '- Do not ask for a dish their material does not mention. A concept showing a business',
      '  food they do not serve is worse than a concept showing no food.',
    ].join('\n'),
  },
  {
    slug: 'owner-operated-signals',
    name: 'Spotting who actually reads the email',
    stage: 'qualify',
    summary: 'The signals that separate an owner-operator from a branch with no authority.',
    builtIn: true,
    enabled: true,
    match: ANY_MATCH,
    instructions: [
      'The question underneath fit_score is always: will the person who reads this email be the',
      'person who can say yes? Weigh these, where the audit or the listing shows them.',
      '',
      'Towards owner-operated:',
      '- One location, a landline or mobile rather than an 0800 number, an address that is a',
      '  street rather than a level in a tower.',
      '- A personal mailbox, or a first name anywhere in their material.',
      '- Reviews that mention the owner or a named staff member.',
      '- A site that is visibly self-built or long untouched: a free platform badge, a copyright',
      '  year several years old, a template still carrying its demo text.',
      '',
      'Away from it:',
      '- A careers or press page, a franchise or licensing page, multiple locations listed.',
      '- An agency credit in the footer, a marketing stack, a cookie consent banner from a',
      '  managed service.',
      '- A brand name that appears in more than one suburb.',
      '',
      'Weigh what is shown. Absence of a signal is not evidence of the opposite.',
    ].join('\n'),
  },
  {
    slug: 'first-line-that-lands',
    name: 'Opening a cold email to a stranger',
    stage: 'outreach',
    summary: 'The first sentence decides whether the rest is read. What works and what does not.',
    builtIn: true,
    enabled: true,
    match: ANY_MATCH,
    instructions: [
      'The opening line is the whole email. It has to prove, in one sentence, that a person',
      'looked at their business rather than a list.',
      '',
      'Works: a specific, checkable, non-insulting observation. Where they are. What their',
      'reviews keep saying. That their site does not work on a phone. That there is no site at',
      'all and their listing is doing the work instead.',
      '',
      'Does not work, ever:',
      '- "I hope this email finds you well", "I came across your business", "I was browsing".',
      '- Any compliment that could be pasted into the next email unchanged.',
      '- Anything implying they have done something wrong. They built that site at midnight',
      '  after a shift, or paid someone who disappeared.',
      '- A question you do not want answered ("do you have a website?" — you know they do not).',
      '',
      'Then say plainly that you built something they did not ask for, and that it is there to',
      'look at. The unasked-for part is the interesting part; hiding it makes it presumptuous.',
    ].join('\n'),
  },
];

/* ------------------------------------------------------------------ */
/* Choosing which apply                                                */
/* ------------------------------------------------------------------ */

export interface SkillContext {
  /** The campaign's trade. */
  niche: string;
  /** What the directory called them, where we have it. */
  category: string;
  objective: 'conversion' | 'awareness' | 'credibility';
  hasWebsite: boolean;
}

/** Does this skill apply to this prospect? */
export function skillApplies(skill: AgentSkill, context: SkillContext): boolean {
  if (!skill.enabled) return false;

  if (skill.match.website === 'with' && !context.hasWebsite) return false;
  if (skill.match.website === 'without' && context.hasWebsite) return false;

  if (skill.match.objectives.length && !skill.match.objectives.includes(context.objective)) {
    return false;
  }

  if (skill.match.niches.length) {
    const haystack = `${context.niche} ${context.category}`.toLowerCase();
    if (!skill.match.niches.some((needle) => haystack.includes(needle.toLowerCase()))) return false;
  }

  return true;
}

/**
 * The skills for one stage, most specific first.
 *
 * Specificity decides the order because it decides what survives the cap: a
 * skill about cafes says more about the cafe in front of you than one about
 * businesses in general, and if only two can be sent it should be the two
 * that were written for this case.
 */
export function selectSkills(
  skills: AgentSkill[],
  stage: SkillStage,
  context: SkillContext,
  max = MAX_SKILLS_PER_STAGE,
): AgentSkill[] {
  return skills
    .filter((skill) => skill.stage === stage && skillApplies(skill, context))
    .sort((a, b) => specificity(b) - specificity(a) || a.slug.localeCompare(b.slug))
    .slice(0, max);
}

function specificity(skill: AgentSkill): number {
  return (
    (skill.match.niches.length ? 2 : 0) +
    (skill.match.objectives.length ? 1 : 0) +
    (skill.match.website === 'any' ? 0 : 1)
  );
}

/**
 * The block appended to a stage's system prompt.
 *
 * Empty when nothing matched, so a prompt does not carry an empty heading —
 * and headed as what it is, so the model can tell general instruction from
 * case-specific know-how.
 */
export function renderSkills(skills: AgentSkill[]): string {
  if (skills.length === 0) return '';

  const blocks = skills.map(
    (skill) => `### ${skill.name}\n${skill.instructions.trim()}`,
  );

  return [
    'ADDITIONAL KNOW-HOW FOR THIS ONE.',
    'These apply to this business specifically, on top of everything above. Where one of them',
    'is more specific than a general instruction above, follow the specific one.',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Merging the built-ins with what the user has                        */
/* ------------------------------------------------------------------ */

/**
 * The effective skill set: built-ins, overridden by slug, plus the user's own.
 *
 * A built-in the user has edited keeps its slug, so it stays the same skill —
 * disabling it stays disabled across a deploy, and a later improvement to a
 * built-in they have NOT edited still reaches them.
 */
export function mergeSkills(stored: AgentSkill[]): AgentSkill[] {
  const bySlug = new Map(BUILT_IN_SKILLS.map((skill) => [skill.slug, skill]));

  for (const skill of stored) {
    bySlug.set(skill.slug, skill);
  }

  return [...bySlug.values()];
}

/** Turn a name into a slug that will not collide with a built-in by accident. */
export function skillSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'skill';
}

export function isSkillStage(value: unknown): value is SkillStage {
  return SKILL_STAGES.some((entry) => entry.stage === value);
}
