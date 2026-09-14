import { describe, expect, it } from 'vitest';
import {
  applyOverrides,
  briefFromKit,
  DEFAULT_SECTION_ORDER,
  DEFAULT_TOKENS,
  FALLBACK_BRIEF,
  fontLinks,
  fontStack,
  parseDesignTokens,
  renderBriefPrompt,
} from '~/lib/growth/brief';
import type { BrandKit } from '~/lib/db/schema';

function kitOf(overrides: Partial<BrandKit> = {}): BrandKit {
  return {
    id: 'kit1', userId: 'u1', name: 'Warm editorial', description: '',
    referenceUrls: '[]', typography: '[]', palette: '[]', sectionOrder: '[]',
    prompt: '', toneNotes: '', avoid: '', capabilities: '', suitableFor: '',
    isDefault: false, createdAt: '', updatedAt: '',
    ...overrides,
  } as BrandKit;
}

describe('brief resolution', () => {
  it('uses the built-in direction when there is no kit', () => {
    expect(briefFromKit(null)).toEqual(FALLBACK_BRIEF);
  });

  it('falls back field by field rather than all or nothing', () => {
    // A kit with only a palette should keep the built-in typography.
    const brief = briefFromKit(kitOf({ palette: JSON.stringify([{ name: 'bg', value: '#000', role: 'background' }]) }));
    expect(brief.palette).toHaveLength(1);
    expect(brief.typography).toEqual(FALLBACK_BRIEF.typography);
    expect(brief.sectionOrder).toEqual(DEFAULT_SECTION_ORDER);
  });

  it('ignores malformed JSON rather than failing the run', () => {
    const brief = briefFromKit(kitOf({ palette: 'not json', typography: '{"not":"an array"}' }));
    expect(brief.palette).toEqual(FALLBACK_BRIEF.palette);
    expect(brief.typography).toEqual(FALLBACK_BRIEF.typography);
  });

  it('drops array entries missing their required fields', () => {
    const brief = briefFromKit(kitOf({
      palette: JSON.stringify([{ name: 'ok', value: '#fff', role: 'text' }, { name: 'no value' }, null, 3]),
    }));
    expect(brief.palette).toHaveLength(1);
  });
});

describe('per-run overrides', () => {
  const base = briefFromKit(kitOf({ prompt: 'Kit direction.', toneNotes: 'Kit voice.' }));

  it('replaces text fields that are given', () => {
    const brief = applyOverrides(base, JSON.stringify({ direction: 'Run direction.' }));
    expect(brief.direction).toBe('Run direction.');
    expect(brief.tone).toBe('Kit voice.');
  });

  it('leaves blank overrides alone', () => {
    expect(applyOverrides(base, JSON.stringify({ direction: '   ' })).direction).toBe('Kit direction.');
  });

  it('replaces a palette wholesale rather than merging it', () => {
    // Half of one palette and half of another looks like neither choice.
    const brief = applyOverrides(base, JSON.stringify({
      palette: [{ name: 'only', value: '#123456', role: 'accent' }],
    }));
    expect(brief.palette).toHaveLength(1);
  });

  it('adds references rather than replacing them', () => {
    const withRefs = { ...base, references: [{ url: 'https://a.test', note: '' }] };
    const brief = applyOverrides(withRefs, JSON.stringify({
      references: [{ url: 'https://b.test', note: 'for the type' }],
    }));
    expect(brief.references.map((r) => r.url)).toEqual(['https://a.test', 'https://b.test']);
  });

  it('shrugs off junk', () => {
    expect(applyOverrides(base, 'not json')).toEqual(base);
    expect(applyOverrides(base, '[1,2]')).toEqual(base);
    expect(applyOverrides(base, null)).toEqual(base);
  });
});

describe('prompting', () => {
  it('fences the brief and names the constraints', () => {
    const prompt = renderBriefPrompt(FALLBACK_BRIEF);
    expect(prompt.startsWith('<brief>')).toBe(true);
    expect(prompt.trimEnd().endsWith('</brief>')).toBe(true);
    expect(prompt).toContain('Use these and no others.');
  });
});

describe('font handling', () => {
  it('falls through the roles that stand in for each other', () => {
    expect(fontStack(FALLBACK_BRIEF, 'display')).toContain('Fraunces');
    // No heading face is defined, so it should reach for display.
    expect(fontStack(FALLBACK_BRIEF, 'heading')).toContain('Fraunces');
    expect(fontStack(FALLBACK_BRIEF, 'body')).toContain('Inter');
  });

  it('only emits stylesheet links for Google Fonts', () => {
    const links = fontLinks({
      ...FALLBACK_BRIEF,
      typography: [
        ...FALLBACK_BRIEF.typography,
        { role: 'accent', family: 'Evil', fallback: '', source: 'google', url: 'https://evil.test/x.css', weights: [] },
      ],
    });
    expect(links.every((href) => href.startsWith('https://fonts.googleapis.com/'))).toBe(true);
  });

  it('deduplicates', () => {
    const face = FALLBACK_BRIEF.typography[0]!;
    expect(fontLinks({ ...FALLBACK_BRIEF, typography: [face, { ...face, role: 'accent' }] })).toHaveLength(1);
  });
});

describe('design tokens', () => {
  it('falls back to the defaults for anything missing or unrecognised', () => {
    expect(parseDesignTokens('{}')).toEqual(DEFAULT_TOKENS);
    expect(parseDesignTokens(null)).toEqual(DEFAULT_TOKENS);
    expect(parseDesignTokens('not json')).toEqual(DEFAULT_TOKENS);
    expect(parseDesignTokens({ hero: 'spinning-carousel' }).hero).toBe(DEFAULT_TOKENS.hero);
  });

  it('keeps the values it recognises', () => {
    const tokens = parseDesignTokens({ hero: 'full-bleed', density: 'airy', radius: 'square' });
    expect(tokens.hero).toBe('full-bleed');
    expect(tokens.density).toBe('airy');
    expect(tokens.radius).toBe('square');
    // Untouched fields keep their defaults rather than being blanked.
    expect(tokens.button).toBe(DEFAULT_TOKENS.button);
  });

  it('reads them from a saved kit', () => {
    const brief = briefFromKit(
      kitOf({ designTokens: JSON.stringify({ hero: 'editorial', typeScale: 'dramatic' }) }),
    );
    expect(brief.tokens.hero).toBe('editorial');
    expect(brief.tokens.typeScale).toBe('dramatic');
  });

  it('merges a per-run override field by field', () => {
    const base = { ...FALLBACK_BRIEF, tokens: parseDesignTokens({ hero: 'editorial', density: 'airy' }) };
    const next = applyOverrides(base, JSON.stringify({ tokens: { hero: 'full-bleed' } }));

    expect(next.tokens.hero).toBe('full-bleed');
    // The rest of the kit's composition survives the override.
    expect(next.tokens.density).toBe('airy');
  });

  it('tells the model what layout the copy has to suit', () => {
    const brief = { ...FALLBACK_BRIEF, tokens: parseDesignTokens({ hero: 'full-bleed' }) };
    expect(renderBriefPrompt(brief)).toContain('full-bleed hero');
  });
});
