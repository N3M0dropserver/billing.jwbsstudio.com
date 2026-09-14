import { describe, expect, it } from 'vitest';
import {
  demoObjectKey,
  demoPathUrl,
  demoPublicUrl,
  demoSubdomainUrl,
  parseDemoPath,
} from '~/lib/growth/publish';
import { renderDemoPage, type DemoContext } from '~/lib/growth/render';
import { FALLBACK_BRIEF } from '~/lib/growth/brief';
import type { DesignPlanDraft } from '~/lib/growth/qualify';

describe('where a demo can be reached', () => {
  it('always has a path on the app itself', () => {
    expect(demoPathUrl('https://billing.example', 'wells.demo.example')).toBe(
      'https://billing.example/d/wells.demo.example/',
    );
  });

  it('does not double the slash when the app URL has a trailing one', () => {
    expect(demoPathUrl('https://billing.example/', 'x.demo.example')).toBe(
      'https://billing.example/d/x.demo.example/',
    );
  });

  it('uses the subdomain only once it is known to resolve', () => {
    // The whole of the "demos are not hosting" problem: a subdomain link
    // before DNS exists is a dead link in a stranger's inbox.
    expect(demoPublicUrl('https://billing.example', 'x.demo.example', false)).toContain('/d/');
    expect(demoPublicUrl('https://billing.example', 'x.demo.example', true)).toBe(
      'https://x.demo.example/',
    );
  });

  it('lower-cases the host either way', () => {
    expect(demoSubdomainUrl('X.Demo.Example')).toBe('https://x.demo.example/');
    expect(demoPathUrl('https://b.example', 'X.Demo.Example')).toContain('x.demo.example');
  });
});

describe('parsing the path mount', () => {
  it('splits the host from the rest', () => {
    expect(parseDemoPath('/d/wells.demo.example/')).toEqual({ host: 'wells.demo.example', rest: '/' });
    expect(parseDemoPath('/d/wells.demo.example/styles.css')).toEqual({
      host: 'wells.demo.example',
      rest: '/styles.css',
    });
  });

  it('treats a bare host as the root', () => {
    expect(parseDemoPath('/d/wells.demo.example')).toEqual({ host: 'wells.demo.example', rest: '/' });
  });

  it('ignores anything that is not a demo path', () => {
    expect(parseDemoPath('/growth')).toBeNull();
    expect(parseDemoPath('/d/')).toBeNull();
    expect(parseDemoPath('/')).toBeNull();
  });

  it('refuses a host that is not a host', () => {
    // The host becomes an R2 prefix, so it has to be exactly a hostname.
    expect(parseDemoPath('/d/..%2F..%2Fgrowth/x')).toBeNull();
    expect(parseDemoPath('/d/has space/x')).toBeNull();
    expect(parseDemoPath('/d/a..b/x')).toBeNull();
  });

  it('cannot be walked out of the demo prefix even with a valid host', () => {
    const parsed = parseDemoPath('/d/x.demo.example/../../growth/secret')!;
    expect(demoObjectKey(parsed.host, parsed.rest)).toBe('demos/x.demo.example/index.html');
  });
});

describe('generated pages work at either address', () => {
  const context: DemoContext = {
    businessName: 'Wells Coffee',
    niche: 'coffee roasters',
    region: 'Wellington',
    contact: { email: 'hello@wells.test', phone: '', address: '' },
    socials: [],
    images: [
      { src: 'images/00.jpg', alt: '', generated: false, sectionId: 'hero', role: 'hero' as const },
    ],
    openingHours: [],
    designerName: 'JWBS Studio',
    designerUrl: 'https://jwbsstudio.com',
  };

  const plan: DesignPlanDraft = {
    summary: '', strategy: '', objective: 'conversion',
    meta: { title: 'Wells Coffee', description: '' },
    sections: [
      {
        id: 'hero', type: 'hero', heading: 'Roasted on Tuesdays', subheading: '', body: '',
        items: [], cta: null, imageHint: '', notes: '',
      },
    ],
  };

  const html = renderDemoPage(plan, FALLBACK_BRIEF, context);

  it('references its assets relatively', () => {
    // Root-absolute paths resolve against the app when the demo is mounted at
    // /d/<host>/, which is how a demo ends up unstyled.
    expect(html).toContain('href="styles.css"');
    expect(html).not.toContain('href="/styles.css"');
    expect(html).toContain('src="images/00.jpg"');
    expect(html).not.toContain('src="/images/00.jpg"');
  });

  it('still carries the ribbon the hosting check looks for', () => {
    expect(html).toContain('unsolicited concept');
  });
});
