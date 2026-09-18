/**
 * What an invoice looks like, as data.
 *
 * A template is a layout name plus a palette plus a handful of switches. It is
 * deliberately not a document model — there is no block tree, nothing is
 * positioned by hand, and a template cannot say "put the total here". That is
 * the trade this file makes: you give up arbitrary composition, and in return
 * every template is guaranteed to produce a legal tax invoice that fits on the
 * page, whatever someone does in the designer.
 *
 * The things a business actually wants to change — its logo, its colours,
 * whether the bank block shows — are all here. The things that must not vary
 * (the GST wording, the amount due being unmissable) are in the layouts.
 *
 * Everything is stored as JSON in `invoice_templates.design`, so `normalise`
 * is the boundary: it takes whatever was in the database or on the wire and
 * returns something the layouts can rely on completely.
 */

export const LAYOUTS = ['classic', 'banner', 'sidebar', 'minimal'] as const;
export type LayoutId = (typeof LAYOUTS)[number];

export const LAYOUT_LABELS: Record<LayoutId, string> = {
  classic: 'Classic',
  banner: 'Banner',
  sidebar: 'Sidebar',
  minimal: 'Minimal',
};

export const LAYOUT_DESCRIPTIONS: Record<LayoutId, string> = {
  classic: 'Business name and details at the top, ruled table, totals to the right.',
  banner: 'A full-width colour band across the head of the page, logo reversed out of it.',
  sidebar: 'A colour column down the left carrying your details and how to pay.',
  minimal: 'No fills, hairline rules, and a great deal of white space.',
};

/** Where the logo sits, for the layouts that offer a choice. */
export const LOGO_POSITIONS = ['left', 'right', 'centre'] as const;
export type LogoPosition = (typeof LOGO_POSITIONS)[number];

export interface InvoiceTheme {
  /** The page itself. White unless someone has been brave. */
  background: string;
  /** Body copy, and anything that must be read. */
  text: string;
  /** Labels, addresses, the supporting matter. */
  muted: string;
  /** The brand colour: headings, the amount due, filled areas. */
  accent: string;
  /** What is legible ON the accent colour. */
  accentText: string;
  /** Hairlines and rules. */
  rule: string;
  /** The fill behind the line-items header row. */
  tableHeader: string;
}

export interface InvoiceTemplateDesign {
  layout: LayoutId;
  theme: InvoiceTheme;
  logo: {
    /** R2 key, under `invoice-assets/`. Empty means no logo. */
    key: string;
    /** Longest edge, in points. The aspect ratio is always preserved. */
    size: number;
    position: LogoPosition;
  };
  /** Multiplies every type size. Keeps relative hierarchy intact. */
  typeScale: number;
  options: {
    /** Show the business name as text beside/below the logo. */
    showBusinessName: boolean;
    /** The "How to pay" bank block. */
    showBankDetails: boolean;
    /** The card payment link, when the invoice has one. */
    showPayLink: boolean;
    /** Tint alternate line-item rows. */
    stripeRows: boolean;
    /** Put the amount due in a filled accent panel. */
    highlightTotal: boolean;
  };
}

export const DEFAULT_THEME: InvoiceTheme = {
  background: '#ffffff',
  text: '#171717',
  muted: '#737373',
  accent: '#225c4d',
  accentText: '#ffffff',
  rule: '#d9d9d9',
  tableHeader: '#f7f7f5',
};

export const DEFAULT_DESIGN: InvoiceTemplateDesign = {
  layout: 'classic',
  theme: DEFAULT_THEME,
  logo: { key: '', size: 96, position: 'left' },
  typeScale: 1,
  options: {
    showBusinessName: true,
    showBankDetails: true,
    showPayLink: true,
    stripeRows: false,
    highlightTotal: true,
  },
};

/**
 * The templates an account starts with.
 *
 * Four layouts with palettes chosen to suit them rather than four colourways
 * of the same thing — the point of the picker is that the choices look
 * different enough to be worth making.
 */
export const PRESETS: Array<{
  id: string;
  name: string;
  description: string;
  design: InvoiceTemplateDesign;
}> = [
  {
    id: 'studio',
    name: 'Studio',
    description: 'The house style. Deep green on white, ruled and conventional.',
    design: DEFAULT_DESIGN,
  },
  {
    id: 'banner',
    name: 'Banner',
    description: 'A dark band across the top with the logo reversed out of it.',
    design: {
      ...DEFAULT_DESIGN,
      layout: 'banner',
      theme: {
        background: '#ffffff',
        text: '#14201c',
        muted: '#6b7280',
        accent: '#14302a',
        accentText: '#f4f1ea',
        rule: '#e2e0da',
        tableHeader: '#f4f2ed',
      },
      options: { ...DEFAULT_DESIGN.options, stripeRows: true },
    },
  },
  {
    id: 'sidebar',
    name: 'Sidebar',
    description: 'Details and payment down a colour column on the left.',
    design: {
      ...DEFAULT_DESIGN,
      layout: 'sidebar',
      theme: {
        background: '#ffffff',
        text: '#1c1917',
        muted: '#78716c',
        accent: '#7c2d12',
        accentText: '#fff7ed',
        rule: '#e7e5e4',
        tableHeader: '#faf8f6',
      },
      logo: { key: '', size: 110, position: 'left' },
    },
  },
  {
    id: 'minimal',
    name: 'Minimal',
    description: 'Hairlines, wide margins, nothing filled in.',
    design: {
      ...DEFAULT_DESIGN,
      layout: 'minimal',
      theme: {
        background: '#ffffff',
        text: '#0a0a0a',
        muted: '#8a8a8a',
        accent: '#0a0a0a',
        accentText: '#ffffff',
        rule: '#e5e5e5',
        tableHeader: '#ffffff',
      },
      typeScale: 0.95,
      options: { ...DEFAULT_DESIGN.options, highlightTotal: false },
    },
  },
];

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

export type Rgb = [number, number, number];

/**
 * Parse a CSS hex colour into the 0..1 triple the writer draws with.
 *
 * Anything unparseable falls back rather than throwing. A template with one
 * bad colour in it should render in a slightly wrong shade, not fail to
 * produce the invoice someone is waiting to be paid for.
 */
export function rgb(hex: string, fallback: Rgb = [0, 0, 0]): Rgb {
  const value = hex.trim().replace(/^#/, '');

  const expanded =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value;

  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) return fallback;

  return [
    Number.parseInt(expanded.slice(0, 2), 16) / 255,
    Number.parseInt(expanded.slice(2, 4), 16) / 255,
    Number.parseInt(expanded.slice(4, 6), 16) / 255,
  ];
}

/** Perceived brightness, 0..1. Rec. 601 weights — good enough to pick ink by. */
export function luminance(colour: Rgb): number {
  return colour[0] * 0.299 + colour[1] * 0.587 + colour[2] * 0.114;
}

/**
 * Black or white, whichever can be read on `background`.
 *
 * Used where a layout fills an area with a colour the user chose and then has
 * to put text on it. Trusting `accentText` alone would let someone set white
 * on yellow and not find out until a client complained.
 */
export function readableInk(background: Rgb, preferred?: Rgb): Rgb {
  if (preferred) {
    // Keep the chosen colour when it has enough contrast to survive print.
    const difference = Math.abs(luminance(preferred) - luminance(background));
    if (difference >= 0.45) return preferred;
  }
  return luminance(background) > 0.55 ? [0.08, 0.08, 0.08] : [1, 1, 1];
}

/** Mix two colours. `amount` is how much of `b` ends up in the result. */
export function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  const t = Math.min(1, Math.max(0, amount));
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** The resolved palette a layout draws with. */
export interface Palette {
  background: Rgb;
  text: Rgb;
  muted: Rgb;
  accent: Rgb;
  accentText: Rgb;
  rule: Rgb;
  tableHeader: Rgb;
  /** A faint tint of the accent, for zebra striping and soft panels. */
  stripe: Rgb;
}

export function palette(theme: InvoiceTheme): Palette {
  const background = rgb(theme.background, [1, 1, 1]);
  const accent = rgb(theme.accent, [0.13, 0.36, 0.3]);
  return {
    background,
    text: rgb(theme.text, [0.09, 0.09, 0.09]),
    muted: rgb(theme.muted, [0.45, 0.45, 0.45]),
    accent,
    accentText: readableInk(accent, rgb(theme.accentText, [1, 1, 1])),
    rule: rgb(theme.rule, [0.85, 0.85, 0.85]),
    tableHeader: rgb(theme.tableHeader, [0.97, 0.97, 0.96]),
    stripe: mix(background, accent, 0.06),
  };
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function hexOr(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed)
    ? trimmed.startsWith('#')
      ? trimmed
      : `#${trimmed}`
    : fallback;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Take anything at all and return a design the layouts can trust.
 *
 * Called on every read from the database and every write from the designer,
 * so a template saved by an older version of the app, or hand-edited, or sent
 * by a client that got a field wrong, still renders.
 */
export function normalise(input: unknown): InvoiceTemplateDesign {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const theme = (typeof raw.theme === 'object' && raw.theme !== null ? raw.theme : {}) as Record<string, unknown>;
  const logo = (typeof raw.logo === 'object' && raw.logo !== null ? raw.logo : {}) as Record<string, unknown>;
  const options = (typeof raw.options === 'object' && raw.options !== null ? raw.options : {}) as Record<string, unknown>;

  const layout = LAYOUTS.includes(raw.layout as LayoutId)
    ? (raw.layout as LayoutId)
    : DEFAULT_DESIGN.layout;

  const position = LOGO_POSITIONS.includes(logo.position as LogoPosition)
    ? (logo.position as LogoPosition)
    : DEFAULT_DESIGN.logo.position;

  return {
    layout,
    theme: {
      background: hexOr(theme.background, DEFAULT_THEME.background),
      text: hexOr(theme.text, DEFAULT_THEME.text),
      muted: hexOr(theme.muted, DEFAULT_THEME.muted),
      accent: hexOr(theme.accent, DEFAULT_THEME.accent),
      accentText: hexOr(theme.accentText, DEFAULT_THEME.accentText),
      rule: hexOr(theme.rule, DEFAULT_THEME.rule),
      tableHeader: hexOr(theme.tableHeader, DEFAULT_THEME.tableHeader),
    },
    logo: {
      // Scoped hard: a key is a pointer into our own bucket, and a template
      // carrying `invoices/<someone>/INV-1.pdf` must not cause that to be read.
      key: typeof logo.key === 'string' && logo.key.startsWith('invoice-assets/') ? logo.key : '',
      size: clamp(logo.size, 24, 220, DEFAULT_DESIGN.logo.size),
      position,
    },
    // Below 0.8 the tax numbers stop being legible in print; above 1.25 a
    // three-line description stops fitting on one page.
    typeScale: clamp(raw.typeScale, 0.8, 1.25, DEFAULT_DESIGN.typeScale),
    options: {
      showBusinessName: boolOr(options.showBusinessName, DEFAULT_DESIGN.options.showBusinessName),
      showBankDetails: boolOr(options.showBankDetails, DEFAULT_DESIGN.options.showBankDetails),
      showPayLink: boolOr(options.showPayLink, DEFAULT_DESIGN.options.showPayLink),
      stripeRows: boolOr(options.stripeRows, DEFAULT_DESIGN.options.stripeRows),
      highlightTotal: boolOr(options.highlightTotal, DEFAULT_DESIGN.options.highlightTotal),
    },
  };
}

/** Parse a stored JSON design column. */
export function parseDesign(json: string): InvoiceTemplateDesign {
  try {
    return normalise(JSON.parse(json));
  } catch {
    return normalise({});
  }
}
