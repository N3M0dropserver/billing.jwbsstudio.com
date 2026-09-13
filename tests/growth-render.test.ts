import { describe, expect, it } from 'vitest';
import { escape, renderDemoPage, renderStylesheet, type DemoContext } from '~/lib/growth/render';
import { renderAstroProject } from '~/lib/growth/project';
import { FALLBACK_BRIEF } from '~/lib/growth/brief';
import { normalisePlan, type DesignPlanDraft, type PlanInput } from '~/lib/growth/qualify';
import type { SiteAudit } from '~/lib/growth/assess';

const CONTEXT: DemoContext = {
  businessName: 'Wells Coffee',
  niche: 'coffee roasters',
  region: 'Wellington',
  contact: { email: 'hello@wells.test', phone: '04 555 0198', address: '12 Wallis St' },
  socials: [{ platform: 'instagram', url: 'https://instagram.com/wells' }],
  images: ['/images/00.jpg'],
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
    siteContent: '', contact: { email: 'hello@wells.test', phone: '', address: '' },
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
