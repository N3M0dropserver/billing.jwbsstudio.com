import { describe, expect, it } from 'vitest';
import {
  allocateSubdomain,
  cleanDemoHost,
  demoDnsRecord,
  demoHostFor,
  demoHostPattern,
  demoObjectKey,
  demoRoute,
  isReservedLabel,
  parseDemoPath,
  slugifyBusiness,
} from '~/lib/growth/publish';

describe('subdomain slugs', () => {
  it('drops legal suffixes nobody wants in a URL', () => {
    expect(slugifyBusiness('Wells Coffee Roasters Limited')).toBe('wells-coffee-roasters');
    expect(slugifyBusiness('Smith & Sons Pty Ltd')).toBe('smith-and-sons');
  });

  it('produces a valid DNS label', () => {
    for (const name of ['  ---  ', '!!!', 'Ätelier Ö', 'A'.repeat(200), '2 Guys & A Truck']) {
      const label = slugifyBusiness(name);
      expect(label).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
      expect(label.length).toBeLessThanOrEqual(63);
    }
  });

  it('never returns an empty label', () => {
    expect(slugifyBusiness('')).toBe('demo');
    expect(slugifyBusiness('...')).toBe('demo');
  });

  it('keeps it short enough to read out loud', () => {
    expect(slugifyBusiness('The Very Long Name Of A Business In Wellington New Zealand'))
      .toBe('the-very-long-name');
  });

  it('knows the labels it must not take', () => {
    expect(isReservedLabel('www')).toBe(true);
    expect(isReservedLabel('billing')).toBe(true);
    expect(isReservedLabel('wells-coffee')).toBe(false);
  });
});

describe('allocation', () => {
  it('takes the plain label when it is free', async () => {
    const result = await allocateSubdomain('Wells Coffee', 'demo.example', async () => false);
    expect(result).toEqual({ label: 'wells-coffee', host: 'wells-coffee.demo.example' });
  });

  it('suffixes past collisions', async () => {
    const taken = new Set(['wells-coffee.demo.example', 'wells-coffee-2.demo.example']);
    const result = await allocateSubdomain('Wells Coffee', 'demo.example', async (host) =>
      taken.has(host),
    );
    expect(result.label).toBe('wells-coffee-3');
  });

  it('refuses to hand out a reserved label', async () => {
    const result = await allocateSubdomain('Admin', 'demo.example', async () => false);
    expect(result.label).not.toBe('admin');
  });

  it('gives up on collisions with something random rather than looping', async () => {
    const result = await allocateSubdomain('Wells Coffee', 'demo.example', async () => true);
    expect(result.label).toMatch(/^wells-coffee-[a-z0-9]{5}$/);
  });
});

describe('object keys', () => {
  it('maps directory-style paths onto index.html', () => {
    expect(demoObjectKey('x.demo.example', '/')).toBe('demos/x.demo.example/index.html');
    expect(demoObjectKey('x.demo.example', '/about')).toBe('demos/x.demo.example/about/index.html');
    expect(demoObjectKey('x.demo.example', '/about/')).toBe('demos/x.demo.example/about/index.html');
  });

  it('leaves real files alone', () => {
    expect(demoObjectKey('x.demo.example', '/styles.css')).toBe('demos/x.demo.example/styles.css');
    expect(demoObjectKey('x.demo.example', '/images/00.jpg')).toBe('demos/x.demo.example/images/00.jpg');
  });

  it('cannot be walked out of its own prefix', () => {
    // A traversal attempt must not reach another host's files, or the
    // crawled pages stored elsewhere in the same bucket.
    expect(demoObjectKey('x.demo.example', '/../../growth/secret')).toBe(
      'demos/x.demo.example/index.html',
    );
    expect(demoObjectKey('x.demo.example', '/%2e%2e/%2e%2e/growth/secret')).toBe(
      'demos/x.demo.example/index.html',
    );
  });
});

describe('the demo host pattern', () => {
  it('reads a plain parent domain as a leading wildcard', () => {
    expect(demoHostPattern('demo.jwbsstudio.com')).toBe('*.demo.jwbsstudio.com');
    expect(demoHostFor('wells-coffee', 'demo.jwbsstudio.com')).toBe(
      'wells-coffee.demo.jwbsstudio.com',
    );
  });

  it('substitutes the label into a suffix pattern', () => {
    expect(demoHostFor('wells-coffee', '*-demo.jwbsstudio.com')).toBe(
      'wells-coffee-demo.jwbsstudio.com',
    );
  });

  it('tolerates a scheme, a path and stray case in the setting', () => {
    expect(demoHostFor('wells', 'https://*-Demo.JWBSStudio.com/anything')).toBe(
      'wells-demo.jwbsstudio.com',
    );
  });

  it('writes the route exactly as Cloudflare wants it', () => {
    expect(demoRoute('*-demo.jwbsstudio.com')).toBe('*-demo.jwbsstudio.com/*');
    expect(demoRoute('demo.jwbsstudio.com')).toBe('*.demo.jwbsstudio.com/*');
  });

  /**
   * The constraint that makes a suffix pattern a trade rather than a free win:
   * a DNS wildcard is a whole label, so the record has to be broader than the
   * route, or created per demo.
   */
  it('names a DNS record that can actually exist', () => {
    expect(demoDnsRecord('demo.jwbsstudio.com')).toEqual({
      name: '*.demo.jwbsstudio.com',
      exact: true,
    });

    expect(demoDnsRecord('*-demo.jwbsstudio.com')).toEqual({
      name: '*.jwbsstudio.com',
      exact: false,
    });
  });

  it('keeps a demo one label deep under a suffix pattern', () => {
    // The whole point: Universal SSL covers one label, and this is one label.
    expect(demoHostFor('wells', '*-demo.jwbsstudio.com').split('.')).toHaveLength(3);
    expect(demoHostFor('wells', 'demo.jwbsstudio.com').split('.')).toHaveLength(4);
  });

  it('allocates against the pattern, not a hardcoded dot', async () => {
    const { host } = await allocateSubdomain('Wells Coffee', '*-demo.jwbsstudio.com', async () => false);
    expect(host).toBe('wells-coffee-demo.jwbsstudio.com');
  });

  it('still steps around a collision under a suffix pattern', async () => {
    const taken = new Set(['wells-coffee-demo.jwbsstudio.com']);
    const { host } = await allocateSubdomain('Wells Coffee', '*-demo.jwbsstudio.com', async (h) =>
      taken.has(h),
    );
    expect(host).toBe('wells-coffee-2-demo.jwbsstudio.com');
  });

  it('does not steer around a reserved word when it cannot collide', async () => {
    // `www-demo` is not `www`, so there is nothing to avoid.
    const { host } = await allocateSubdomain('WWW', '*-demo.jwbsstudio.com', async () => false);
    expect(host).toBe('www-demo.jwbsstudio.com');
  });
});

describe('cleanDemoHost', () => {
  it('accepts a parent domain and a suffix pattern', () => {
    expect(cleanDemoHost('demo.jwbsstudio.com')).toBe('demo.jwbsstudio.com');
    expect(cleanDemoHost('*-demo.jwbsstudio.com')).toBe('*-demo.jwbsstudio.com');
    expect(cleanDemoHost('*.demo.jwbsstudio.com')).toBe('*.demo.jwbsstudio.com');
  });

  it('strips a scheme and a path rather than rejecting them', () => {
    expect(cleanDemoHost(' HTTPS://*-demo.JWBSStudio.com/x ')).toBe('*-demo.jwbsstudio.com');
  });

  it('refuses a wildcard anywhere but the first label', () => {
    expect(cleanDemoHost('demo.*.jwbsstudio.com')).toBe('');
    expect(cleanDemoHost('demo.jwbsstudio.*')).toBe('');
  });

  it('refuses more than one wildcard', () => {
    expect(cleanDemoHost('*-*-demo.jwbsstudio.com')).toBe('');
  });

  it('refuses a bare label, which would make a demo somebody apex', () => {
    expect(cleanDemoHost('demo')).toBe('');
    expect(cleanDemoHost('*')).toBe('');
  });

  it('refuses the malformed', () => {
    expect(cleanDemoHost('')).toBe('');
    expect(cleanDemoHost('-demo.jwbsstudio.com')).toBe('');
    expect(cleanDemoHost('demo..jwbsstudio.com')).toBe('');
    // A path is stripped rather than rejected, so pasting a URL works.
    expect(cleanDemoHost('demo.jwbsstudio.com/../etc')).toBe('demo.jwbsstudio.com');
  });
});

describe('a suffix pattern keeps the app safe from its own demos', () => {
  it('cannot produce a host that collides with the app or www', async () => {
    const pattern = '*-demo.jwbsstudio.com';
    for (const name of ['www', 'WWW', 'Billing', 'API', 'Admin', 'Mail']) {
      const { host } = await allocateSubdomain(name, pattern, async () => false);
      expect(host).not.toBe(`${name.toLowerCase()}.jwbsstudio.com`);
      expect(host.endsWith('-demo.jwbsstudio.com')).toBe(true);
    }
  });

  it('produces hosts the demo path mount still parses', async () => {
    const { host } = await allocateSubdomain('Wells Coffee', '*-demo.jwbsstudio.com', async () => false);
    expect(parseDemoPath(`/d/${host}/`)).toEqual({ host, rest: '/' });
  });

  it('keys R2 under the full host either way', async () => {
    const suffixed = await allocateSubdomain('Wells', '*-demo.jwbsstudio.com', async () => false);
    const nested = await allocateSubdomain('Wells', 'demo.jwbsstudio.com', async () => false);
    expect(demoObjectKey(suffixed.host, '/')).not.toBe(demoObjectKey(nested.host, '/'));
  });
});
