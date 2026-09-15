import { describe, expect, it } from 'vitest';
import {
  escape,
  renderDemoPage,
  renderStylesheet,
  sectionHasSubstance,
  type DemoContext,
} from '~/lib/growth/render';
import { renderAstroProject } from '~/lib/growth/project';
import { FALLBACK_BRIEF, parseDesignTokens } from '~/lib/growth/brief';
import {
  renderFacts,
  normalisePlan,
  type DesignPlanDraft,
  type PlanInput,
  type PlanSection,
} from '~/lib/growth/qualify';
import type { SiteAudit } from '~/lib/growth/assess';

const CONTEXT: DemoContext = {
  businessName: 'Wells Coffee',
  niche: 'coffee roasters',
  region: 'Wellington',
  contact: { email: 'hello@wells.test', phone: '04 555 0198', address: '12 Wallis St' },
  socials: [{ platform: 'instagram', url: 'https://instagram.com/wells' }],
  images: [
    { src: 'images/00.jpg', alt: '', generated: false, sectionId: 'hero', role: 'hero' as const },
  ],
  openingHours: ['Mo-Fr 07:00-15:00'],
  designerName: 'JWBS Studio',
  designerUrl: 'https://jwbsstudio.com',
};

const PLAN: DesignPlanDraft = {
  summary: 'A one-page site for Wells Coffee.',
  strategy: 'Lead with the roastery.',
  objective: 'conversion',
  meta: { title: 'Wells Coffee', description: 'Small-batch roasters.' },
  sections: [
    {
      id: 'hero', type: 'hero', heading: 'Roasted on Tuesdays', subheading: 'Te Aro',
      body: 'Small batches, every week.', items: [],
      cta: { label: 'Visit us', href: '#contact' }, imageHint: '', notes: '',
    },
    {
      id: 'services', type: 'services', heading: 'What we do', subheading: '', body: '',
      items: [{ title: 'Wholesale', body: 'For cafés.' }],
      cta: null, imageHint: '', notes: '',
    },
    {
      id: 'contact', type: 'contact', heading: 'Come and see us', subheading: '', body: '',
      items: [], cta: null, imageHint: '', notes: '',
    },
  ],
};

const AUDIT: SiteAudit = {
  checks: [], presenceScore: 40, signal: 'other', summary: '', observations: [],
  context: [], platform: null, pagesSeen: 1, crawledAt: '2026-09-12T00:00:00Z',
};

describe('escaping', () => {
  it('neutralises every character that could close a tag or an attribute', () => {
    expect(escape(`<script>"'&`)).toBe('&lt;script&gt;&quot;&#39;&amp;');
  });
});

describe('the generated page', () => {
  const html = renderDemoPage(PLAN, FALLBACK_BRIEF, CONTEXT);

  it('is a complete document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain('</html>');
  });

  it('says what it is, before any of the copy', () => {
    // A speculative site must declare itself in the browser, not only in the
    // email that linked to it.
    const ribbon = html.indexOf('unsolicited concept');
    expect(ribbon).toBeGreaterThan(-1);
    expect(ribbon).toBeLessThan(html.indexOf('Roasted on Tuesdays'));
    expect(html).toContain('Not affiliated with or endorsed by');
  });

  it('keeps itself out of search', () => {
    expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
  });

  it('renders the sections it was given', () => {
    expect(html).toContain('Roasted on Tuesdays');
    expect(html).toContain('Wholesale');
    expect(html).toContain('hello@wells.test');
    expect(html).toContain('Mo-Fr 07:00-15:00');
  });

  it('carries no script of its own', () => {
    expect(html).not.toMatch(/<script/i);
  });

  it('escapes model-authored copy rather than trusting it', () => {
    const hostile = renderDemoPage(
      {
        ...PLAN,
        meta: { title: '</title><script>alert(1)</script>', description: '"><img onerror=x>' },
        sections: [
          {
            ...PLAN.sections[0]!,
            heading: '<img src=x onerror="alert(1)">',
            body: '</p><script>alert(2)</script>',
            items: [{ title: '<b>x</b>', body: '<script>3</script>' }],
          },
        ],
      },
      FALLBACK_BRIEF,
      CONTEXT,
    );

    // The test is that nothing becomes markup — not that the characters
    // vanish. `onerror=` survives as visible text, which is the point of
    // escaping rather than stripping.
    expect(hostile).not.toMatch(/<script/i);
    expect(hostile).not.toMatch(/<img[^>]*onerror/i);
    expect(hostile).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(hostile).toContain('&lt;/title&gt;');
  });

  it('escapes the business name, which came from a third party', () => {
    const hostile = renderDemoPage(PLAN, FALLBACK_BRIEF, {
      ...CONTEXT,
      businessName: '<script>alert(1)</script>',
    });
    expect(hostile).not.toMatch(/<script>alert/i);
  });

  it('loads only the fonts the brief names', () => {
    const links = [...renderDemoPage(PLAN, FALLBACK_BRIEF, CONTEXT).matchAll(/<link rel="stylesheet" href="([^"]+)"/g)];
    for (const [, href] of links) {
      // Relative, so the same files serve from the subdomain and the path
      // mount on the app's own origin.
      expect(href === 'styles.css' || href!.startsWith('https://fonts.googleapis.com/')).toBe(true);
    }
  });
});

describe('the stylesheet', () => {
  const css = renderStylesheet(FALLBACK_BRIEF);

  it('defines the brief palette as custom properties', () => {
    expect(css).toContain('--accent: #1f6f5c;');
    expect(css).toContain('--bg: #fbfaf7;');
  });

  it('is responsive and respects reduced motion', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('clamp(');
  });

  it('cannot be broken out of by a crafted colour value', () => {
    const hostile = renderStylesheet({
      ...FALLBACK_BRIEF,
      palette: [{ name: 'accent', value: 'red; } body { display: none', role: 'accent' }],
    });

    // The value is neutered rather than removed: no declaration can be
    // terminated and no new rule opened, so what is left is an invalid value
    // for one custom property and nothing more.
    const declaration = hostile.split('\n').find((line) => line.includes('--accent:'))!;
    const value = declaration.slice(declaration.indexOf(':') + 1).replace(/;\s*$/, '');
    expect(value).not.toMatch(/[{};]/);

    // The structure of the stylesheet is byte-for-byte unchanged apart from
    // that one value: no rule was opened or closed.
    const clean = renderStylesheet(FALLBACK_BRIEF);
    const braces = (css: string) => [...css].filter((c) => c === '{' || c === '}').length;
    expect(braces(hostile)).toBe(braces(clean));
  });

  it('neuters a crafted token name as well as its value', () => {
    const hostile = renderStylesheet({
      ...FALLBACK_BRIEF,
      palette: [{ name: 'x; } body { color: red', value: '#fff', role: 'accent' }],
    });
    const clean = renderStylesheet(FALLBACK_BRIEF);
    const braces = (css: string) => [...css].filter((c) => c === '{' || c === '}').length;
    expect(braces(hostile)).toBe(braces(clean));
  });
});

describe('the exported Astro project', () => {
  const files = renderAstroProject(PLAN, FALLBACK_BRIEF, CONTEXT, 'wells.demo.example');
  const byPath = new Map(files.map((file) => [file.path, file.content]));

  it('is a project someone could actually pick up', () => {
    for (const path of [
      'package.json', 'astro.config.mjs', 'wrangler.jsonc', 'tsconfig.json',
      'src/pages/index.astro', 'src/layouts/Layout.astro', 'src/styles/site.css', 'README.md',
    ]) {
      expect(byPath.has(path)).toBe(true);
    }
  });

  it('names a valid npm package', () => {
    const pkg = JSON.parse(byPath.get('package.json')!);
    expect(pkg.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(pkg.scripts.deploy).toContain('wrangler deploy');
  });

  it('keeps the export out of search too', () => {
    expect(byPath.get('src/layouts/Layout.astro')).toContain('noindex, nofollow');
    expect(byPath.get('public/robots.txt')).toContain('Disallow: /');
  });

  it('tells whoever picks it up what it is and what to check', () => {
    const readme = byPath.get('README.md')!;
    expect(readme).toContain('has **not** been commissioned');
    expect(readme).toContain('rights to use');
  });
});

describe('plan normalisation', () => {
  const input: PlanInput = {
    businessName: 'Wells Coffee', niche: 'coffee roasters', region: 'Wellington',
    brief: FALLBACK_BRIEF, audit: AUDIT, objective: 'awareness', angle: '',
    siteContent: '',
    directoryContent: '', contact: { email: 'hello@wells.test', phone: '', address: '' },
    facts: {
      category: '',
      address: '',
      openingHours: [],
      rating: null,
      reviewCount: 0,
      reviewSummary: '',
      hasWebsite: true,
    },
    // normalisePlan never calls the model, so the tracking context is unused.
    usage: { db: null as never, userId: 'u1', operation: 'plan' },
  };

  it('drops section types the renderer does not know', () => {
    const plan = normalisePlan(
      { sections: [{ type: '<script>', heading: 'x' }, { type: 'hero', heading: 'ok' }] },
      input,
    );
    expect(plan.sections.map((s) => s.type)).toEqual(['hero']);
  });

  it('rewrites an off-site call to action back to the page', () => {
    const plan = normalisePlan(
      { sections: [{ type: 'hero', cta: { label: 'Go', href: 'https://elsewhere.example' } }] },
      input,
    );
    expect(plan.sections[0]!.cta?.href).toBe('#contact');
  });

  it('allows the contact schemes it generates itself', () => {
    const plan = normalisePlan(
      { sections: [{ type: 'contact', cta: { label: 'Email', href: 'mailto:a@b.test' } }] },
      input,
    );
    expect(plan.sections[0]!.cta?.href).toBe('mailto:a@b.test');
  });

  it('falls back to the qualifier objective when the model gives nonsense', () => {
    expect(normalisePlan({ objective: 'vibes' }, input).objective).toBe('awareness');
  });

  it('always returns something renderable', () => {
    const plan = normalisePlan({}, input);
    expect(plan.sections.length).toBeGreaterThan(0);
    expect(plan.meta.title).toContain('Wells Coffee');
  });

  it('survives a model returning the wrong shape entirely', () => {
    expect(() => normalisePlan({ sections: 'not an array' }, input)).not.toThrow();
    expect(() => normalisePlan({ sections: [null, 3, 'x'] }, input)).not.toThrow();
  });
});

describe('the kit decides the composition, not just the colours', () => {
  const briefWith = (tokens: Parameters<typeof parseDesignTokens>[0]) => ({
    ...FALLBACK_BRIEF,
    tokens: parseDesignTokens(tokens),
  });

  it('two kits that differ only in tokens produce different stylesheets', () => {
    const quiet = renderStylesheet(briefWith({ density: 'tight', typeScale: 'restrained', radius: 'square' }));
    const loud = renderStylesheet(briefWith({ density: 'airy', typeScale: 'dramatic', radius: 'round' }));
    expect(quiet).not.toBe(loud);
  });

  it('puts the density and type scale into custom properties', () => {
    const css = renderStylesheet(briefWith({ density: 'airy', typeScale: 'dramatic' }));
    expect(css).toContain('--section-gap: clamp(5rem, 12vw, 10rem)');
    expect(css).toContain('--h1: clamp(3rem, 1.5rem + 6.8vw, 7.5rem)');
  });

  it('squares the corners when the kit asks for it', () => {
    const css = renderStylesheet(briefWith({ radius: 'square', button: 'square' }));
    expect(css).toContain('--radius-card: 0');
    expect(css).toContain('--radius-button: 0');
  });

  it('separates sections the way the kit asks and not two ways at once', () => {
    const rules = renderStylesheet(briefWith({ rhythm: 'rules' }));
    expect(rules).toContain('.section + .section { border-top:');
    expect(rules).not.toContain('.section--tint { background:');

    const tint = renderStylesheet(briefWith({ rhythm: 'tint' }));
    expect(tint).toContain('.section--tint { background:');
    expect(tint).not.toContain('.section + .section { border-top:');
  });

  it('renders each hero treatment differently', () => {
    const treatments = ['split', 'stacked', 'editorial', 'full-bleed'] as const;
    const pages = treatments.map((hero) => renderDemoPage(PLAN, briefWith({ hero }), CONTEXT));

    expect(new Set(pages).size).toBe(treatments.length);
    expect(pages[0]).toContain('hero--split');
    expect(pages[1]).toContain('hero--stacked');
    expect(pages[2]).toContain('hero--editorial');
    expect(pages[3]).toContain('hero--bleed');
  });

  it('falls back to a stacked hero when there is no picture to frame', () => {
    const page = renderDemoPage(PLAN, briefWith({ hero: 'full-bleed' }), { ...CONTEXT, images: [] });
    expect(page).toContain('hero--stacked');
    expect(page).not.toContain('hero--bleed');
  });
});

describe('generated photography is disclosed', () => {
  const generated = {
    ...CONTEXT,
    images: [
      {
        src: 'images/00.jpg',
        alt: 'Indicative photograph, generated for this concept — not Wells Coffee’s own.',
        generated: true,
        sectionId: 'hero',
        role: 'hero' as const,
      },
    ],
  };

  it('says so in the ribbon', () => {
    const page = renderDemoPage(PLAN, FALLBACK_BRIEF, generated);
    expect(page).toContain('generated for this concept');
  });

  it('marks the picture itself', () => {
    expect(renderDemoPage(PLAN, FALLBACK_BRIEF, generated)).toContain('Indicative image');
  });

  it('says nothing about generated images when every picture is theirs', () => {
    const page = renderDemoPage(PLAN, FALLBACK_BRIEF, CONTEXT);
    expect(page).not.toContain('Indicative image');
    expect(page).not.toContain('generated for this concept');
  });

  it('still carries the unsolicited-concept ribbon either way', () => {
    expect(renderDemoPage(PLAN, FALLBACK_BRIEF, generated)).toContain('unsolicited concept');
    expect(renderDemoPage(PLAN, FALLBACK_BRIEF, CONTEXT)).toContain('unsolicited concept');
  });
});

describe('a hero headline is never just the business name', () => {
  const input: PlanInput = {
    businessName: 'Goodco',
    niche: 'coffee roasters',
    region: 'Sydney',
    angle: 'Show the roastery and let people order a bag without ringing up.',
    objective: 'conversion',
    brief: FALLBACK_BRIEF,
    audit: AUDIT,
    siteContent: '',
    directoryContent: '',
    contact: { email: '', phone: '', address: '' },
    facts: {
      category: '',
      address: '',
      openingHours: [],
      rating: null,
      reviewCount: 0,
      reviewSummary: '',
      hasWebsite: true,
    },
    usage: { db: null as never, userId: 'u1', operation: 'plan' },
  };

  it('replaces a headline that only repeats the name', () => {
    const plan = normalisePlan(
      { sections: [{ id: 'hero', type: 'hero', heading: 'Goodco' }] },
      input,
    );
    expect(plan.sections[0]?.heading).not.toBe('Goodco');
    expect(plan.sections[0]?.heading).toContain('roastery');
  });

  it('replaces an empty headline too', () => {
    const plan = normalisePlan({ sections: [{ id: 'hero', type: 'hero', heading: '' }] }, input);
    expect(plan.sections[0]?.heading).toBeTruthy();
  });

  it('says in the notes that it stepped in', () => {
    const plan = normalisePlan(
      { sections: [{ id: 'hero', type: 'hero', heading: 'goodco' }] },
      input,
    );
    expect(plan.sections[0]?.notes).toContain('Headline replaced');
  });

  it('leaves a real headline alone', () => {
    const plan = normalisePlan(
      { sections: [{ id: 'hero', type: 'hero', heading: 'Roasted in Marrickville' }] },
      input,
    );
    expect(plan.sections[0]?.heading).toBe('Roasted in Marrickville');
    expect(plan.sections[0]?.notes).toBe('');
  });
});

describe('a section with nothing in it is not drawn', () => {
  const bare = (id: string, type: string): PlanSection => ({
    id, type, heading: 'What We Offer', subheading: '', body: '',
    items: [], cta: null, imageHint: '', notes: '',
  });

  const noImages = { ...CONTEXT, images: [] };

  it('drops a heading with no body, items or picture under it', () => {
    expect(sectionHasSubstance(bare('offer', 'services'), noImages)).toBe(false);
  });

  it('keeps it once it has items', () => {
    const withItems = { ...bare('offer', 'services'), items: [{ title: 'Wholesale', body: 'For cafés.' }] };
    expect(sectionHasSubstance(withItems, noImages)).toBe(true);
  });

  it('keeps it once it has copy', () => {
    expect(sectionHasSubstance({ ...bare('a', 'about'), body: 'Roasting since 2014.' }, noImages)).toBe(true);
  });

  it('keeps it when a picture was assigned to it', () => {
    const context = {
      ...CONTEXT,
      images: [{ src: 'images/01.jpg', alt: '', generated: false, sectionId: 'offer', role: 'feature' as const }],
    };
    expect(sectionHasSubstance(bare('offer', 'services'), context)).toBe(true);
  });

  it('always keeps the hero, which carries the name and the action', () => {
    expect(sectionHasSubstance(bare('hero', 'hero'), noImages)).toBe(true);
  });

  it('keeps contact whenever there is a detail to show, plan copy or not', () => {
    expect(sectionHasSubstance(bare('c', 'contact'), noImages)).toBe(true);
    const nothing = { ...noImages, contact: { email: '', phone: '', address: '' }, openingHours: [] };
    expect(sectionHasSubstance(bare('c', 'contact'), nothing)).toBe(false);
  });

  it('leaves the page without the empty band, and without a nav link to it', () => {
    const plan: DesignPlanDraft = {
      ...PLAN,
      sections: [PLAN.sections[0]!, bare('offer', 'services'), PLAN.sections[2]!],
    };
    const page = renderDemoPage(plan, FALLBACK_BRIEF, noImages);

    expect(page).not.toContain('What We Offer');
    expect(page).not.toContain('id="offer"');
  });
});

describe('what the planner is told when there is no website', () => {
  const facts = {
    category: 'Cafe',
    address: '25 Burton St, Darlinghurst',
    openingHours: ['Mo-Fr 07:00-16:00'],
    rating: 4.6,
    reviewCount: 312,
    reviewSummary: '',
    hasWebsite: false,
  };

  it('renders the facts we hold rather than nothing', () => {
    const block = renderFacts(facts);
    expect(block).toContain('25 Burton St');
    expect(block).toContain('Mo-Fr 07:00-16:00');
    expect(block).toContain('4.6 from 312 reviews');
  });

  it('says nothing at all when we know nothing, rather than empty labels', () => {
    expect(
      renderFacts({
        category: '', address: '', openingHours: [], rating: null,
        reviewCount: 0, reviewSummary: '', hasWebsite: false,
      }),
    ).toBe('');
  });

  it('reports a review count even without a rating', () => {
    expect(renderFacts({ ...facts, rating: null })).toContain('312 reviews');
  });
});

/* ------------------------------------------------------------------ */
/* Location and contact                                                */
/* ------------------------------------------------------------------ */

describe('a location section', () => {
  const brief = FALLBACK_BRIEF;

  const locationPlan = (extra: Partial<DesignPlanDraft> = {}): DesignPlanDraft => ({
    summary: '',
    strategy: '',
    objective: 'conversion',
    meta: { title: 'Meryenda', description: '' },
    sections: [
      {
        id: 'location',
        type: 'location',
        heading: 'Where and when',
        subheading: '2 Burton St, Darlinghurst',
        body: '',
        items: [
          { title: 'Monday: 7am – 3pm', body: '' },
          { title: 'Sunday: Closed', body: '' },
        ],
        cta: null,
        imageHint: '',
        notes: '',
      },
      {
        id: 'contact',
        type: 'contact',
        heading: 'Get in touch',
        subheading: '',
        body: '',
        items: [],
        cta: null,
        imageHint: '',
        notes: '',
      },
    ],
    ...extra,
  });

  const context = (images: DemoContext['images'] = []): DemoContext => ({
    businessName: 'Meryenda',
    niche: 'Cafe',
    region: 'Darlinghurst',
    contact: { email: '', phone: '+61 2 9331 0000', address: '2 Burton St, Darlinghurst' },
    socials: [],
    images,
    openingHours: [],
    designerName: 'JWBS Studio',
    designerUrl: 'https://jwbsstudio.com',
  });

  /**
   * The planner writes a day per item. Nothing looked at `items`, so a
   * section headed "Where and when" answered neither.
   */
  it('prints the opening hours the plan wrote', () => {
    const html = renderDemoPage(locationPlan(), brief, context());
    expect(html).toContain('Monday');
    expect(html).toContain('7am – 3pm');
    expect(html).toContain('Sunday');
    expect(html).toContain('Closed');
  });

  it('falls back to the hours research found when the plan wrote none', () => {
    const plan = locationPlan();
    plan.sections[0]!.items = [];
    const withHours = { ...context(), openingHours: ['Weekdays 7–3'] };

    expect(renderDemoPage(plan, brief, withHours)).toContain('Weekdays 7–3');
  });

  it('does not print the same hours twice when both are present', () => {
    const withHours = { ...context(), openingHours: ['Monday: 7am – 3pm'] };
    const html = renderDemoPage(locationPlan(), brief, withHours);

    expect(html.split('7am – 3pm')).toHaveLength(2);
  });

  /**
   * `location` and `contact` used to render through the same function, so a
   * plan carrying both — and the prompt encourages both — put an identical
   * address panel on the page twice.
   */
  it('leaves the address to the location section rather than repeating it', () => {
    const html = renderDemoPage(locationPlan(), brief, context());
    expect(html.split('2 Burton St, Darlinghurst').length - 1).toBe(1);
  });

  it('still gives the address when there is no location section', () => {
    const plan = locationPlan();
    plan.sections = [plan.sections[1]!];

    expect(renderDemoPage(plan, brief, context())).toContain('2 Burton St, Darlinghurst');
  });

  /** A photograph paid for, stored, and then dropped on the floor. */
  it('places the photograph the imagery stage allocated to it', () => {
    const html = renderDemoPage(
      locationPlan(),
      brief,
      context([
        {
          src: 'images/00.jpg',
          alt: 'The shopfront on Burton St',
          generated: false,
          sectionId: 'location',
          role: 'feature',
        },
      ]),
    );

    expect(html).toContain('images/00.jpg');
    expect(html).toContain('The shopfront on Burton St');
  });

  it('escapes an hours line rather than letting it become markup', () => {
    const plan = locationPlan();
    plan.sections[0]!.items = [{ title: 'Monday: <script>alert(1)</script>', body: '' }];

    const html = renderDemoPage(plan, brief, context());
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
