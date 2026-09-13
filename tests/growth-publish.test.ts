import { describe, expect, it } from 'vitest';
import {
  allocateSubdomain,
  demoObjectKey,
  isReservedLabel,
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
