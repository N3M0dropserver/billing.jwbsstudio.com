/**
 * Photography for a demo.
 *
 * A concept site with no pictures is the single biggest reason a generated
 * demo reads as a template with a name dropped in. It is also the normal
 * case rather than the exception: the pipeline deliberately selects
 * businesses whose current site is poor, and a poor site is usually poor at
 * images too — lazy-loaded, hotlinked from a closed Facebook page, or simply
 * absent.
 *
 * So this module does three things, in order of preference:
 *
 *   1. Use their own photography. Nothing else says "someone looked at us".
 *   2. Where there is not enough, generate placeholder photography from the
 *      plan's own `imageHint` — which the model was already writing and the
 *      renderer was already throwing away.
 *   3. Where neither is possible, tell the renderer so it can lay the section
 *      out as type rather than leaving a grey box.
 *
 * Generated pictures are tracked as generated, end to end, and the page says
 * so. A concept sent to a stranger must not imply we photographed their
 * premises.
 */

import { MODELS } from '../ai/index';
import { trackedGenerateImage, type AiUsageContext } from '../ai/usage';
import type { Brief } from './brief';
import type { DesignPlanDraft, PlanSection } from './qualify';

export type ImageRole = 'hero' | 'feature' | 'gallery';

export interface ImageSlot {
  sectionId: string;
  sectionType: string;
  role: ImageRole;
  /** What the plan said belongs here. May be empty. */
  hint: string;
}

export interface DemoImage {
  /** Path relative to the page, e.g. `images/00.jpg`. */
  path: string;
  contentType: string;
  body: ArrayBuffer;
  /** True when we made it rather than found it. */
  generated: boolean;
  alt: string;
  /** The source URL, or the prompt we generated from. */
  provenance: string;
  sectionId: string;
  role: ImageRole;
}

/** Their photography, already downloaded. */
export interface SourceImage {
  body: ArrayBuffer;
  contentType: string;
  sourceUrl: string;
}

export interface ImagerySubject {
  businessName: string;
  niche: string;
  region: string;
}

/* ------------------------------------------------------------------ */
/* What the page needs                                                 */
/* ------------------------------------------------------------------ */

/** How many pictures each kind of section can carry. */
const SLOTS_BY_TYPE: Record<string, { role: ImageRole; count: number }> = {
  hero: { role: 'hero', count: 1 },
  gallery: { role: 'gallery', count: 4 },
  about: { role: 'feature', count: 1 },
  intro: { role: 'feature', count: 1 },
  services: { role: 'feature', count: 1 },
  process: { role: 'feature', count: 1 },
  location: { role: 'feature', count: 1 },
};

/**
 * The pictures this plan wants, in the order the page reads.
 *
 * Capped overall so a plan with three gallery sections cannot ask for
 * twenty generations. The hero is always first, because it is the one slot
 * where an empty frame is most obvious.
 */
export function planImageSlots(plan: DesignPlanDraft, max = 6): ImageSlot[] {
  const slots: ImageSlot[] = [];

  const push = (section: PlanSection, role: ImageRole, count: number): void => {
    for (let i = 0; i < count && slots.length < max; i++) {
      slots.push({
        sectionId: section.id,
        sectionType: section.type,
        role,
        hint: section.imageHint,
      });
    }
  };

  const hero = plan.sections.find((section) => section.type === 'hero');
  if (hero) push(hero, 'hero', 1);

  for (const section of plan.sections) {
    if (section === hero) continue;
    const spec = SLOTS_BY_TYPE[section.type];
    if (!spec) continue;
    push(section, spec.role, spec.count);
    if (slots.length >= max) break;
  }

  return slots;
}

/* ------------------------------------------------------------------ */
/* Prompting                                                           */
/* ------------------------------------------------------------------ */

/**
 * Flatten anything that reached us through the model or a crawl.
 *
 * `imageHint` is written by a model that has just read a stranger's website,
 * so it is treated as untrusted text: collapsed to a single line, stripped of
 * anything that could read as a second instruction, and clamped.
 */
function sanitiseHint(hint: string): string {
  return hint
    .replace(/[\r\n]+/g, ' ')
    .replace(/[<>{}[\]|]/g, ' ')
    .replace(/\b(ignore|disregard|instead|system prompt|prompt)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

/** The look, taken from the brief rather than invented per prospect. */
function styleFromBrief(brief: Brief): string {
  const accent = brief.palette.find((colour) => colour.role === 'accent')?.value ?? '';
  const direction = sanitiseHint(brief.direction).slice(0, 160);
  return [
    'natural available light, shallow depth of field, documentary product and place photography',
    direction ? `art direction: ${direction}` : '',
    accent ? `a restrained palette that sits well beside ${accent}` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** The frame each role wants. */
const ROLE_FRAMING: Record<ImageRole, string> = {
  hero: 'wide establishing shot, generous empty space on one side for a headline',
  feature: 'medium shot, a single clear subject, uncluttered background',
  gallery: 'close detail shot, texture and craft, square crop',
};

/**
 * The prompt for one slot.
 *
 * Two constraints are non-negotiable and appear in every prompt: no text and
 * no logos — generated lettering is always subtly wrong and a generated
 * "logo" on a concept for a real business is worse than wrong — and no
 * identifiable faces, so nothing can be read as a photograph of their actual
 * staff or customers.
 */
export function buildImagePrompt(
  slot: ImageSlot,
  subject: ImagerySubject,
  brief: Brief,
): string {
  const hint = sanitiseHint(slot.hint);
  const fallbackSubject = `the work and surroundings of a ${subject.niche} business in ${subject.region}`;

  return [
    `Editorial photograph for a ${subject.niche} business.`,
    `Subject: ${hint || fallbackSubject}.`,
    ROLE_FRAMING[slot.role] + '.',
    styleFromBrief(brief) + '.',
    'No text, no lettering, no signage, no logos, no watermarks.',
    'No identifiable faces.',
    'Photographic, not an illustration or a 3D render.',
  ]
    .filter(Boolean)
    .join(' ');
}

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

function extensionFor(contentType: string): string {
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('avif')) return 'avif';
  return 'jpg';
}

export interface AssembleOptions {
  plan: DesignPlanDraft;
  brief: Brief;
  subject: ImagerySubject;
  /** Their own photography, best first. */
  theirs: SourceImage[];
  /** Hard ceiling on pictures for the whole page. */
  max?: number;
  /**
   * Whether to generate what they cannot supply. Off means the page is laid
   * out with whatever they had, including nothing.
   */
  generate: boolean;
  /** Hard ceiling on generations, which cost money per picture. */
  maxGenerated?: number;
}

export interface AssembledImagery {
  images: DemoImage[];
  generatedCount: number;
  theirCount: number;
  notes: string[];
}

/**
 * Fill the page's picture slots.
 *
 * Their photography goes in first and in order, so the best image the crawl
 * found lands in the hero. Generation only ever fills what is left over.
 */
export async function assembleImagery(
  ai: Ai,
  options: AssembleOptions,
  usage: AiUsageContext,
): Promise<AssembledImagery> {
  const max = options.max ?? 6;
  const slots = planImageSlots(options.plan, max);
  const notes: string[] = [];
  const images: DemoImage[] = [];

  const theirs = [...options.theirs];
  let generatedCount = 0;
  const maxGenerated = options.maxGenerated ?? 4;

  for (const [index, slot] of slots.entries()) {
    const own = theirs.shift();

    if (own) {
      images.push({
        path: `images/${String(index).padStart(2, '0')}.${extensionFor(own.contentType)}`,
        contentType: own.contentType,
        body: own.body,
        generated: false,
        alt: '',
        provenance: own.sourceUrl,
        sectionId: slot.sectionId,
        role: slot.role,
      });
      continue;
    }

    if (!options.generate || generatedCount >= maxGenerated) continue;

    const prompt = buildImagePrompt(slot, options.subject, options.brief);
    const result = await trackedGenerateImage(ai, { prompt, model: MODELS.image }, usage);

    if (!result.ok) {
      notes.push(`Could not generate the ${slot.role} image: ${result.error}`);
      continue;
    }

    generatedCount++;
    images.push({
      path: `images/${String(index).padStart(2, '0')}.${extensionFor(result.data.contentType)}`,
      contentType: result.data.contentType,
      body: result.data.body,
      generated: true,
      // Described as indicative in the alt text too, so the disclosure
      // survives for anyone reading the page with a screen reader.
      alt: `Indicative photograph, generated for this concept — not ${options.subject.businessName}'s own.`,
      provenance: prompt,
      sectionId: slot.sectionId,
      role: slot.role,
    });
  }

  const theirCount = images.filter((image) => !image.generated).length;

  if (generatedCount > 0) {
    notes.push(
      `${generatedCount} placeholder image(s) generated because their site had ${
        options.theirs.length === 0 ? 'no usable photography' : 'too few usable photographs'
      }.`,
    );
  }

  return { images, generatedCount, theirCount, notes };
}
