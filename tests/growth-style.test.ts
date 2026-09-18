import { describe, expect, it } from 'vitest';

import { FALLBACK_BRIEF, parseDesignTokens, type Brief } from '~/lib/growth/brief';
import { contrastRatio, failedProfile, parseColour, type ReferenceProfile } from '~/lib/growth/reference';
import {
  clampPalette,
  clampScale,
  clampTypography,
  COMPOSITION_OPTIONS,
  describeStyle,
  deriveFromProfiles,
  deserialiseStyle,
  flowFromProfiles,
  paletteFromProfiles,
  parseStyleSpec,
  renderStyleContract,
  serialiseStyle,
  styleFromBrief,
  typographyFromProfiles,
  type StyleSpec,
} from '~/lib/growth/style';
import { renderStylesheet } from '~/lib/growth/render';

/** A reference that measured out to something deliberate and un-default. */
const BRUTAL: ReferenceProfile = {
  ...failedProfile('https://brutal.example', 'the type and the flatness', ''),
  ok: true,
  faces: [
    { family: 'Archivo', hits: 8, headingHits: 5, googleUrl: '' },
    { family: 'Inter', hits: 24, headingHits: 0, googleUrl: '' },
  ],
  colours: [
    { value: '#0f0f0f', hits: 18, role: 'background', luminance: 0.06, saturation: 0 },
    { value: '#f2f0e9', hits: 22, role: 'text', luminance: 0.94, saturation: 0.1 },
    { value: '#d6ff3f', hits: 7, role: 'background', luminance: 0.9, saturation: 0.99 },
    { value: '#2a2a2a', hits: 9, role: 'border', luminance: 0.16, saturation: 0 },
  ],
  radiiPx: [0],
  fontSizesPx: [96, 18],
  flow: ['hero', 'stats', 'services', 'gallery', 'contact'],
  traits: {
    uppercaseHeadings: true,
    headingTrackingEm: -0.04,
    containerPx: 1500,
    sectionPaddingPx: 160,
    serifDisplay: false,
    gradients: false,
    cssBytes: 80_000,
  },
};

/** A reference that measured out to the quiet opposite. */
const QUIET: ReferenceProfile = {
  ...failedProfile('https://quiet.example', '', ''),
  ok: true,
  faces: [{ family: 'Lora', hits: 5, headingHits: 4, googleUrl: '' }],
  colours: [
    { value: '#ffffff', hits: 30, role: 'background', luminance: 1, saturation: 0 },
    { value: '#333333', hits: 20, role: 'text', luminance: 0.2, saturation: 0 },
    { value: '#8a6d3b', hits: 5, role: 'border', luminance: 0.45, saturation: 0.4 },
  ],
  radiiPx: [20],
  fontSizesPx: [30, 19],
  flow: ['hero', 'intro', 'about'],
  traits: {
    uppercaseHeadings: false,
    headingTrackingEm: 0.01,
    containerPx: 700,
    sectionPaddingPx: 40,
    serifDisplay: true,
    gradients: false,
    cssBytes: 20_000,
  },
};

const briefWith = (profiles: ReferenceProfile[]): Brief => ({
  ...FALLBACK_BRIEF,
  referenceProfiles: profiles,
});

describe('the kit pass', () => {
  it('turns the eight enums into the numbers they always stood for', () => {
    const airy = styleFromBrief({ ...FALLBACK_BRIEF, tokens: parseDesignTokens({ density: 'airy' }) });
    const tight = styleFromBrief({ ...FALLBACK_BRIEF, tokens: parseDesignTokens({ density: 'tight' }) });

    expect(airy.scale.sectionGapRem).toBeGreaterThan(tight.scale.sectionGapRem);
    expect(airy.source).toBe('kit');
  });

  it('carries the kit\'s own palette and typefaces through unchanged', () => {
    const spec = styleFromBrief(FALLBACK_BRIEF);
    expect(spec.palette).toEqual(FALLBACK_BRIEF.palette);
    expect(spec.typography).toEqual(FALLBACK_BRIEF.typography);
  });
});

describe('the references pass', () => {
  it('measures a palette off the references rather than using the built-in one', () => {
    const palette = paletteFromProfiles([BRUTAL], FALLBACK_BRIEF.palette);

    expect(palette.find((c) => c.role === 'background')!.value).not.toBe('#fbfaf7');
    // The most saturated colour anyone used twice is the accent, not the ground.
    expect(palette.find((c) => c.role === 'accent')!.value).toMatch(/^#[0-9a-f]{6}$/);
    expect(palette.find((c) => c.role === 'accent')!.value).not.toBe('#1f6f5c');
  });

  it('keeps body text readable whatever the reference did', () => {
    for (const profile of [BRUTAL, QUIET]) {
      const palette = paletteFromProfiles([profile], FALLBACK_BRIEF.palette);
      const bg = parseColour(palette.find((c) => c.role === 'background')!.value)!;
      const text = parseColour(palette.find((c) => c.role === 'text')!.value)!;
      const accent = parseColour(palette.find((c) => c.role === 'accent')!.value)!;

      expect(contrastRatio(text, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(accent, bg)).toBeGreaterThanOrEqual(3);
    }
  });

  it('takes the page ground from what is most used, not from what is lightest', () => {
    // BRUTAL is a dark site whose acid accent appears on buttons. Choosing the
    // lightest background instead put that accent on the page as the ground
    // and pushed everything else around to stay legible against it.
    const palette = paletteFromProfiles([BRUTAL], FALLBACK_BRIEF.palette);

    expect(palette.find((c) => c.role === 'background')!.value).toBe('#0f0f0f');
    expect(palette.find((c) => c.role === 'text')!.value).toBe('#f2f0e9');
    // And the accent survives as the hue it was, because it now has contrast.
    expect(palette.find((c) => c.role === 'accent')!.value).toBe('#d6ff3f');
  });

  it('declares the colour scheme the palette actually is', () => {
    const dark = renderStylesheet(
      briefWith([BRUTAL]),
      deriveFromProfiles(styleFromBrief(briefWith([BRUTAL])), [BRUTAL]),
    );
    const light = renderStylesheet(FALLBACK_BRIEF);

    expect(dark).toContain('color-scheme: dark');
    expect(light).toContain('color-scheme: light');
  });

  it('does not declare the same custom property twice', () => {
    const css = renderStylesheet(
      briefWith([BRUTAL]),
      deriveFromProfiles(styleFromBrief(briefWith([BRUTAL])), [BRUTAL]),
    );
    const root = css.slice(css.indexOf(':root'), css.indexOf('}'));
    const names = [...root.matchAll(/^\s*(--[a-z-]+):/gm)].map((m) => m[1]!);

    expect(names.length).toBe(new Set(names).size);
  });

  it('falls back to the kit when there is not enough measured to build one', () => {
    expect(paletteFromProfiles([], FALLBACK_BRIEF.palette)).toEqual(FALLBACK_BRIEF.palette);
    expect(
      paletteFromProfiles([failedProfile('https://x.example', '', 'HTTP 500')], FALLBACK_BRIEF.palette),
    ).toEqual(FALLBACK_BRIEF.palette);
  });

  it('takes the display face from where the reference sets its headings', () => {
    const faces = typographyFromProfiles([BRUTAL], FALLBACK_BRIEF.typography);

    expect(faces.find((f) => f.role === 'display')!.family).toBe('Archivo');
    expect(faces.find((f) => f.role === 'body')!.family).toBe('Inter');
  });

  it('never invents a Google Fonts URL for a family nobody loaded', () => {
    // A made-up stylesheet link is a dead request and a fallback stack
    // pretending to be a choice.
    const faces = typographyFromProfiles([BRUTAL], FALLBACK_BRIEF.typography);
    for (const face of faces) {
      if (face.source === 'google') expect(face.url).toMatch(/^https:\/\/fonts\.googleapis\.com\//);
      else expect(face.url).toBe('');
    }
  });

  it('keeps a body face beside a display face', () => {
    // QUIET only measured a display family; body copy must not end up on it.
    const faces = typographyFromProfiles([QUIET], FALLBACK_BRIEF.typography);
    expect(faces.some((f) => f.role === 'body')).toBe(true);
  });

  it('moves the proportions to what the references measure', () => {
    const loud = deriveFromProfiles(styleFromBrief(FALLBACK_BRIEF), [BRUTAL]);
    const quiet = deriveFromProfiles(styleFromBrief(FALLBACK_BRIEF), [QUIET]);

    expect(loud.scale.h1Rem).toBeGreaterThan(quiet.scale.h1Rem);
    expect(loud.scale.sectionGapRem).toBeGreaterThan(quiet.scale.sectionGapRem);
    expect(loud.scale.maxWidthRem).toBeGreaterThan(quiet.scale.maxWidthRem);
    expect(loud.scale.radiusCardPx).toBeLessThan(quiet.scale.radiusCardPx);
    expect(loud.composition.headingCase).toBe('upper');
    expect(quiet.composition.headingCase).toBe('sentence');
    expect(loud.source).toBe('references');
  });

  it('leaves the kit alone where there was nothing to measure', () => {
    const base = styleFromBrief(FALLBACK_BRIEF);
    expect(deriveFromProfiles(base, [])).toEqual(base);
    expect(deriveFromProfiles(base, [failedProfile('https://x.example', '', 'timed out')])).toEqual(base);
  });

  it('two different references produce two different stylesheets', () => {
    // The whole point: a run against one direction should not come out as one
    // page in one set of colours.
    const loud = renderStylesheet(briefWith([BRUTAL]), deriveFromProfiles(styleFromBrief(briefWith([BRUTAL])), [BRUTAL]));
    const quiet = renderStylesheet(briefWith([QUIET]), deriveFromProfiles(styleFromBrief(briefWith([QUIET])), [QUIET]));

    expect(loud).not.toBe(quiet);
  });

  it('takes the section order from the references', () => {
    const allowed = ['hero', 'intro', 'services', 'gallery', 'testimonials', 'about', 'location', 'contact', 'stats'];
    expect(flowFromProfiles([BRUTAL], allowed)).toEqual([
      'hero',
      'stats',
      'services',
      'gallery',
      'contact',
    ]);
  });

  it('will not return a flow with no hero or no way to make contact', () => {
    const partial: ReferenceProfile = { ...QUIET, flow: ['intro', 'about'] };
    const flow = flowFromProfiles([partial], ['hero', 'intro', 'about', 'contact']);

    expect(flow[0]).toBe('hero');
    expect(flow.at(-1)).toBe('contact');
  });

  it('drops a section type the renderer has no branch for', () => {
    const odd: ReferenceProfile = { ...QUIET, flow: ['hero', 'cta', 'contact'] };
    expect(flowFromProfiles([odd], ['hero', 'contact'])).not.toContain('cta');
  });
});

describe('the model pass', () => {
  const base = deriveFromProfiles(styleFromBrief(FALLBACK_BRIEF), [BRUTAL]);
  const available = { typography: base.typography.concat(FALLBACK_BRIEF.typography) };

  it('accepts a well-formed proposal', () => {
    const spec = parseStyleSpec(
      {
        rationale: 'A large scale and plain cards: their work is physical and their copy is plain.',
        palette: [
          { role: 'background', value: '#fffdf7' },
          { role: 'surface', value: '#f4f1e8' },
          { role: 'text', value: '#14130f' },
          { role: 'muted', value: '#5f5b52' },
          { role: 'accent', value: '#8c3b1f' },
          { role: 'border', value: '#ddd8cb' },
        ],
        scale: { h1Rem: 5.5, bodyRem: 1.1, sectionGapRem: 9, radiusCardPx: 0, headingWeight: 780 },
        composition: { cardStyle: 'plain', galleryPattern: 'filmstrip', cardColumns: 4 },
      },
      base,
      available,
    );

    expect(spec.source).toBe('model');
    expect(spec.scale.h1Rem).toBe(5.5);
    expect(spec.composition.cardStyle).toBe('plain');
    expect(spec.composition.galleryPattern).toBe('filmstrip');
    expect(spec.composition.cardColumns).toBe(4);
    // Snapped to a real weight step rather than passed through.
    expect(spec.scale.headingWeight).toBe(800);
    expect(spec.palette.find((c) => c.role === 'accent')!.value).toBe('#8c3b1f');
  });

  it('clamps every number back into a range that lays out', () => {
    const spec = parseStyleSpec(
      {
        scale: {
          h1Rem: 400,
          bodyRem: -12,
          sectionGapRem: 9999,
          maxWidthRem: 1,
          measureCh: 500,
          leading: 0,
          trackingEm: 5,
          radiusCardPx: 9999,
        },
      },
      base,
      available,
    );

    expect(spec.scale.h1Rem).toBeLessThanOrEqual(6.5);
    expect(spec.scale.bodyRem).toBeGreaterThanOrEqual(0.95);
    expect(spec.scale.sectionGapRem).toBeLessThanOrEqual(11);
    expect(spec.scale.maxWidthRem).toBeGreaterThanOrEqual(56);
    expect(spec.scale.measureCh).toBeLessThanOrEqual(80);
    expect(spec.scale.leading).toBeGreaterThanOrEqual(0.88);
    expect(spec.scale.trackingEm).toBeLessThanOrEqual(0.1);
    expect(spec.scale.radiusCardPx).toBeLessThanOrEqual(36);
  });

  it('keeps the type scale a scale even when every number is in range', () => {
    // All legal values, no hierarchy: h2 over h1 and a lede over an h3.
    const spec = clampScale({ h1Rem: 2, h2Rem: 3.6, h3Rem: 1.9, bodyRem: 1.2, ledeRem: 1 });

    expect(spec.h1Rem).toBeGreaterThan(spec.h2Rem);
    expect(spec.h2Rem).toBeGreaterThan(spec.h3Rem);
    expect(spec.h3Rem).toBeGreaterThan(spec.bodyRem);
    expect(spec.ledeRem).toBeGreaterThanOrEqual(spec.bodyRem);
  });

  it('refuses a composition value it has no branch for', () => {
    const spec = parseStyleSpec(
      { composition: { cardStyle: 'neumorphic', galleryPattern: 'carousel', cardColumns: 12 } },
      base,
      available,
    );

    expect(spec.composition.cardStyle).toBe(base.composition.cardStyle);
    expect(spec.composition.galleryPattern).toBe(base.composition.galleryPattern);
    expect(spec.composition.cardColumns).toBe(base.composition.cardColumns);
  });

  it('accepts a composition value the model quoted or cased oddly', () => {
    const spec = parseStyleSpec({ composition: { cardStyle: ' FILLED ', cardColumns: '2' } }, base, available);
    expect(spec.composition.cardStyle).toBe('filled');
    expect(spec.composition.cardColumns).toBe(2);
  });

  it('re-emits every colour from parsed components, never as given text', () => {
    // The model could return anything here; nothing it writes reaches CSS.
    const spec = clampPalette(
      [
        { role: 'background', value: '#fff' },
        { role: 'text', value: 'rgb(20, 19, 15)' },
        { role: 'accent', value: 'red; } body { display: none } .x {' },
        { role: 'surface', value: '#eee' },
      ],
      base.palette,
    );

    for (const token of spec) {
      expect(token.value).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(spec.find((c) => c.role === 'text')!.value).toBe('#14130f');
  });

  it('will not let a model propose an unreadable page', () => {
    const spec = clampPalette(
      [
        { role: 'background', value: '#ffffff' },
        { role: 'text', value: '#fdfdfd' },
        { role: 'muted', value: '#fefefe' },
        { role: 'accent', value: '#ffffff' },
      ],
      base.palette,
    );

    const bg = parseColour(spec.find((c) => c.role === 'background')!.value)!;
    expect(contrastRatio(parseColour(spec.find((c) => c.role === 'text')!.value)!, bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(parseColour(spec.find((c) => c.role === 'accent')!.value)!, bg)).toBeGreaterThanOrEqual(3);
  });

  it('will not let a model name a typeface nobody loaded', () => {
    const faces = clampTypography(
      [
        { role: 'display', family: 'Helvetica Now Display Black' },
        { role: 'body', family: 'Inter' },
      ],
      base.typography,
      available.typography,
    );

    expect(faces.map((f) => f.family)).not.toContain('Helvetica Now Display Black');
  });

  it('degrades to the pass before it rather than failing the demo', () => {
    for (const rubbish of [null, undefined, 'a string', 42, [], { scale: 'nope' }]) {
      const spec = parseStyleSpec(rubbish, base, available);
      expect(spec.palette).toHaveLength(base.palette.length);
      expect(spec.scale.h1Rem).toBeGreaterThan(0);
    }
    expect(parseStyleSpec(null, base, available)).toEqual(base);
  });

  it('keeps the base palette when the proposal is too thin to be one', () => {
    expect(clampPalette([{ role: 'accent', value: '#123456' }], base.palette)).toEqual(base.palette);
    expect(clampPalette('not an array', base.palette)).toEqual(base.palette);
  });
});

describe('storing a resolved spec', () => {
  const spec = deriveFromProfiles(styleFromBrief(FALLBACK_BRIEF), [BRUTAL]);

  it('round-trips through the plan row', () => {
    const restored = deserialiseStyle(serialiseStyle(spec), styleFromBrief(FALLBACK_BRIEF));

    expect(restored.scale).toEqual(spec.scale);
    expect(restored.composition).toEqual(spec.composition);
    expect(restored.palette).toEqual(spec.palette);
    expect(restored.source).toBe('references');
  });

  it('falls back to the brief for a plan written before styling existed', () => {
    const base = styleFromBrief(FALLBACK_BRIEF);
    expect(deserialiseStyle('{}', base).scale).toEqual(base.scale);
    expect(deserialiseStyle('', base)).toEqual(base);
    expect(deserialiseStyle('not json', base)).toEqual(base);
  });

  it('clamps again on the way back in', () => {
    // A row hand-edited, or written by a version with wider ranges.
    const hostile = JSON.stringify({ ...spec, scale: { ...spec.scale, h1Rem: 900 } });
    expect(deserialiseStyle(hostile, styleFromBrief(FALLBACK_BRIEF)).scale.h1Rem).toBeLessThanOrEqual(6.5);
  });
});

describe('the contract shown to the model', () => {
  it('names every range and every option it will be validated against', () => {
    const contract = renderStyleContract();

    expect(contract).toContain('Return ONLY JSON');
    expect(contract).toContain('"h1Rem": 2–6.5');
    expect(contract).toContain('"maxWidthRem": 56–96');

    for (const [field, options] of Object.entries(COMPOSITION_OPTIONS)) {
      expect(contract).toContain(`"${field}"`);
      for (const option of options as readonly unknown[]) {
        expect(contract).toContain(JSON.stringify(option));
      }
    }
  });
});

describe('describing a spec', () => {
  it('says what was decided, in terms someone could check', () => {
    const described = describeStyle(deriveFromProfiles(styleFromBrief(FALLBACK_BRIEF), [BRUTAL]));

    expect(described).toContain('Palette:');
    expect(described).toContain('Archivo');
    expect(described).toMatch(/h1 [\d.]+rem/);
    expect(described).toContain('accent on');
  });

  it('holds up when a palette is missing a role', () => {
    const spec: StyleSpec = { ...styleFromBrief(FALLBACK_BRIEF), palette: [], typography: [] };
    expect(() => describeStyle(spec)).not.toThrow();
    expect(describeStyle(spec)).toContain('—');
  });
});
