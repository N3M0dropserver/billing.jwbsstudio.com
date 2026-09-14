/**
 * Research: everything we can learn about a prospect before writing to them.
 *
 * Crawls their site, keeps the pages and the best of their photography in
 * R2, pulls contact details and social profiles out of the markup, and reads
 * whatever structured data they publish about themselves — opening hours,
 * address, and ratings, which sites built on a modern platform hand over for
 * free in JSON-LD.
 *
 * The photographs matter more than they look. A demo built with the
 * business's own images reads as "someone looked at us"; one built with
 * stock reads as a template with a name dropped in.
 */

import { crawlSite, type CrawlResult, DEFAULT_CRAWL } from './crawl';
import { fetchPlacePhoto } from './discovery/places';
import type { ReviewQuote } from './discovery/types';
import type { SocialLink } from './html';
import { normaliseDomain } from './html';
import { describeError } from '../errors';
import {
  crawlImageKey,
  crawlPageKey,
  directoryImageKey,
  extensionFor,
  putObject,
  type StoredObject,
} from './storage';

export interface EnrichedContact {
  email: string;
  phone: string;
  name: string;
  role: string;
}

export interface Enrichment {
  crawl: CrawlResult;
  contact: EnrichedContact;
  socials: SocialLink[];
  domain: string;
  /** Their own copy, joined and trimmed, for prompting. */
  siteContent: string;
  /**
   * What a directory holds about them, written as prose for a prompt.
   *
   * Kept apart from `siteContent` because the two are not the same kind of
   * thing and the prompt says so: one is their own marketing copy, the other
   * is a third party's record of them. Labelling a Google listing as "their
   * existing copy" would invite the model to write a page in the voice of a
   * directory entry.
   */
  directoryContent: string;
  rating: number | null;
  reviewCount: number;
  reviewSummary: string;
  openingHours: string[];
  /** Stored copies of their pages. */
  pageObjects: StoredObject[];
  /** Stored copies of their photography, best first. */
  imageObjects: Array<StoredObject & { sourceUrl: string }>;
  notes: string[];
}

/** Generic inboxes are fine to write to; a named one is better. */
const ROLE_MAILBOXES = /^(info|hello|contact|admin|enquiries|enquiry|office|sales|team|mail|bookings)@/i;

/** Walk JSON-LD, which is often an array or an @graph, and flatten it. */
function flattenJsonLd(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) flattenJsonLd(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    out.push(node);
    if (node['@graph']) flattenJsonLd(node['@graph'], out);
  }
  return out;
}

interface StructuredFacts {
  rating: number | null;
  reviewCount: number;
  openingHours: string[];
  email: string;
  phone: string;
  contactName: string;
  contactRole: string;
  reviewQuotes: string[];
}

export function readStructuredData(blocks: unknown[]): StructuredFacts {
  const facts: StructuredFacts = {
    rating: null,
    reviewCount: 0,
    openingHours: [],
    email: '',
    phone: '',
    contactName: '',
    contactRole: '',
    reviewQuotes: [],
  };

  for (const node of blocks.flatMap((block) => flattenJsonLd(block))) {
    const type = String(node['@type'] ?? '').toLowerCase();

    const aggregate = node.aggregateRating as Record<string, unknown> | undefined;
    if (aggregate && facts.rating === null) {
      const value = Number(aggregate.ratingValue);
      const count = Number(aggregate.reviewCount ?? aggregate.ratingCount);
      if (Number.isFinite(value)) facts.rating = Math.round(value * 10) / 10;
      if (Number.isFinite(count)) facts.reviewCount = Math.max(0, Math.round(count));
    }

    if (type.includes('review')) {
      const body = String(node.reviewBody ?? node.description ?? '').trim();
      if (body && facts.reviewQuotes.length < 5) facts.reviewQuotes.push(body.slice(0, 400));
    }

    if (Array.isArray(node.openingHours)) {
      for (const entry of node.openingHours) {
        const text = String(entry).trim();
        if (text && facts.openingHours.length < 7) facts.openingHours.push(text.slice(0, 80));
      }
    } else if (typeof node.openingHours === 'string') {
      facts.openingHours.push(node.openingHours.slice(0, 80));
    }

    if (!facts.email && typeof node.email === 'string') {
      facts.email = node.email.replace(/^mailto:/i, '').trim().toLowerCase();
    }
    if (!facts.phone && typeof node.telephone === 'string') facts.phone = node.telephone.trim();

    if (!facts.contactName && (type.includes('person') || node.jobTitle)) {
      const name = String(node.name ?? '').trim();
      if (name && name.length < 80) {
        facts.contactName = name;
        facts.contactRole = String(node.jobTitle ?? '').trim().slice(0, 80);
      }
    }
  }

  return facts;
}

/** Prefer a named mailbox over a role one; prefer the site's own domain. */
export function pickEmail(candidates: string[], domain: string): string {
  if (candidates.length === 0) return '';
  const onDomain = candidates.filter((email) => domain && email.endsWith(`@${domain}`));
  const pool = onDomain.length ? onDomain : candidates;
  const named = pool.find((email) => !ROLE_MAILBOXES.test(email));
  return named ?? pool[0]!;
}

export interface EnrichOptions {
  userAgent: string;
  maxPages?: number;
  /** How many of their photographs to keep. Zero skips downloading any. */
  maxImages?: number;
  /** Per-image ceiling. Anything larger is skipped rather than truncated. */
  maxImageBytes?: number;
  /**
   * Photographs the directory holds, redeemed here rather than at discovery.
   *
   * Discovery sees dozens of businesses and most are discarded; downloading
   * every one's photography there would be paying for pictures nobody sees.
   * Research runs only on the shortlist, so this is where the handful that
   * matter get fetched.
   */
  photoRefs?: string[];
  /** Needed to redeem `photoRefs`. Without it they are left alone. */
  placesApiKey?: string;
}

export async function enrichProspect(
  bucket: R2Bucket,
  prefix: string,
  business: {
    name: string;
    website?: string;
    email?: string;
    phone?: string;
    rating?: number;
    reviewCount?: number;
    /** What the directory already knew. Used when there is no site to read. */
    reviews?: ReviewQuote[];
    openingHours?: string[];
    summary?: string;
  },
  options: EnrichOptions,
): Promise<Enrichment> {
  const maxImages = options.maxImages ?? 6;
  const maxImageBytes = options.maxImageBytes ?? 4_000_000;
  const notes: string[] = [];

  const empty: Enrichment = {
    crawl: {
      root: business.website ?? '',
      pagesRequested: 0,
      reachable: false,
      httpsWorks: false,
      robotsFound: false,
      disallowed: [],
      pages: [],
      socials: [],
      emails: [],
      phones: [],
      images: [],
    },
    contact: {
      email: (business.email ?? '').toLowerCase(),
      phone: business.phone ?? '',
      name: '',
      role: '',
    },
    socials: [],
    domain: normaliseDomain(business.website ?? ''),
    siteContent: '',
    directoryContent: '',
    rating: business.rating ?? null,
    reviewCount: business.reviewCount ?? 0,
    reviewSummary: '',
    openingHours: [],
    pageObjects: [],
    imageObjects: [],
    notes,
  };

  /**
   * What the directory holds about them.
   *
   * This runs before the crawl and regardless of whether there is one,
   * because for most of what this pipeline selects there is no site: a
   * business found on a maps listing used to return from here having learnt
   * nothing at all, which is how ten demos got built for businesses we knew
   * a name and a suburb about. Their photographs, their reviews and their
   * hours are real, specific and theirs, and they are the whole difference
   * between a page about this business and a page about any business in
   * this trade.
   */
  const directory = await gatherDirectory(bucket, prefix, business, options, notes);

  if (!business.website) {
    notes.push(
      directory.imageObjects.length
        ? `No website. Researched from the directory instead: ${directory.imageObjects.length} photograph(s).`
        : 'No website, and the directory holds no photographs of them either.',
    );
    return { ...empty, ...directory };
  }

  const crawl = await crawlSite(business.website, {
    userAgent: options.userAgent,
    maxPages: options.maxPages ?? DEFAULT_CRAWL.maxPages,
  });

  if (crawl.disallowed.length) {
    notes.push(`robots.txt asked us not to fetch ${crawl.disallowed.length} path(s); we did not.`);
  }
  if (!crawl.reachable) {
    notes.push(crawl.error ? `The site did not answer: ${crawl.error}` : 'The site did not answer.');
    return { ...empty, ...directory, crawl };
  }

  /* -- Keep their pages ------------------------------------------- */

  const pageObjects: StoredObject[] = [];
  for (const [index, page] of crawl.pages.entries()) {
    try {
      pageObjects.push(
        await putObject(bucket, crawlPageKey(prefix, index), page.html, 'text/html; charset=utf-8', {
          sourceUrl: page.finalUrl,
          title: page.extracted.title,
        }),
      );
    } catch (error) {
      notes.push(`Could not store ${page.finalUrl}: ${describeError(error)}`);
    }
  }

  /* -- Keep their photography ------------------------------------- */

  const imageObjects: Array<StoredObject & { sourceUrl: string }> = [];
  for (const [index, source] of crawl.images.slice(0, maxImages).entries()) {
    try {
      const response = await fetch(source, {
        headers: { 'user-agent': options.userAgent, accept: 'image/*' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) continue;

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.startsWith('image/')) continue;

      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > maxImageBytes) continue;

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength === 0 || buffer.byteLength > maxImageBytes) continue;

      const stored = await putObject(
        bucket,
        crawlImageKey(prefix, index, extensionFor(contentType)),
        buffer,
        contentType,
        { sourceUrl: source },
      );
      imageObjects.push({ ...stored, sourceUrl: source });
    } catch {
      // One image that will not download is not worth failing the stage over.
    }
  }

  if (crawl.images.length > 0 && imageObjects.length === 0) {
    notes.push('Their images were all unreachable or too large to keep.');
  }

  // Their own site first, always — it is the one that says "someone looked at
  // us". The directory's fill the frames left over.
  imageObjects.push(...directory.imageObjects.slice(0, Math.max(0, maxImages - imageObjects.length)));

  /* -- Read what they publish about themselves --------------------- */

  const facts = readStructuredData(crawl.pages.flatMap((page) => page.extracted.jsonLd));
  const domain = normaliseDomain(crawl.pages[0]?.finalUrl ?? business.website);

  const emails = [...new Set([business.email, facts.email, ...crawl.emails].filter(Boolean))] as string[];
  const email = pickEmail(emails, domain);

  const reviewCount = business.reviewCount ?? facts.reviewCount;
  const rating = business.rating ?? facts.rating;
  const reviewSummary =
    summariseReviews(facts.reviewQuotes.map(asQuote).concat(business.reviews ?? []), rating, reviewCount);

  const siteContent = crawl.pages
    .map((page) => {
      const heading = page.extracted.title || page.finalUrl;
      return `## ${heading}\n${page.extracted.text.slice(0, 4000)}`;
    })
    .join('\n\n')
    .slice(0, 20_000);

  if (!email) notes.push('No email address anywhere on the site.');

  return {
    crawl,
    contact: {
      email,
      phone: business.phone || facts.phone || crawl.phones[0] || '',
      name: facts.contactName,
      role: facts.contactRole,
    },
    socials: crawl.socials,
    domain,
    siteContent,
    directoryContent: directory.directoryContent,
    rating: rating ?? null,
    reviewCount,
    reviewSummary,
    openingHours: facts.openingHours.length ? facts.openingHours : (business.openingHours ?? []),
    pageObjects,
    imageObjects,
    notes,
  };
}

/* ------------------------------------------------------------------ */
/* What the directory knows                                            */
/* ------------------------------------------------------------------ */

/** A structured-data review quote, in the shape a directory review has. */
function asQuote(quote: string): ReviewQuote {
  return { quote, rating: null, author: '' };
}

/**
 * Their reviews, as one block for a prompt.
 *
 * Quotes beat a rating: "the coffee is the best in Darlinghurst and the
 * owner remembers your order" is something a page can be built out of, and
 * "rated 4.6" is not.
 */
export function summariseReviews(
  reviews: ReviewQuote[],
  rating: number | null,
  reviewCount: number,
): string {
  const quotes = reviews
    .map((review) => review.quote.trim())
    .filter(Boolean)
    .filter((quote, index, all) => all.indexOf(quote) === index);

  if (quotes.length === 0) {
    return rating ? `Rated ${rating}${reviewCount ? ` across ${reviewCount} reviews` : ''}.` : '';
  }

  const header = rating ? `Rated ${rating}${reviewCount ? ` across ${reviewCount} reviews` : ''}. ` : '';
  return `${header}${quotes.join(' · ')}`.slice(0, 1500);
}

interface DirectoryResearch {
  imageObjects: Array<StoredObject & { sourceUrl: string }>;
  reviewSummary: string;
  openingHours: string[];
  directoryContent: string;
}

/**
 * Redeem what discovery carried: their photographs, their reviews, their
 * hours and the directory's own description.
 *
 * Nothing here can fail the stage. A photograph that will not download is a
 * page with one fewer picture.
 */
async function gatherDirectory(
  bucket: R2Bucket,
  prefix: string,
  business: {
    name: string;
    rating?: number;
    reviewCount?: number;
    reviews?: ReviewQuote[];
    openingHours?: string[];
    summary?: string;
  },
  options: EnrichOptions,
  notes: string[],
): Promise<DirectoryResearch> {
  const imageObjects: Array<StoredObject & { sourceUrl: string }> = [];
  const refs = options.photoRefs ?? [];
  const maxImages = options.maxImages ?? 6;

  if (refs.length && !options.placesApiKey) {
    notes.push(
      `The directory holds ${refs.length} photograph(s) of them, but GOOGLE_PLACES_API_KEY is not ` +
        'set, so they could not be fetched.',
    );
  }

  if (refs.length && options.placesApiKey) {
    for (const [index, ref] of refs.slice(0, maxImages).entries()) {
      const photo = await fetchPlacePhoto(ref, options.placesApiKey, {
        userAgent: options.userAgent,
        maxBytes: options.maxImageBytes ?? 4_000_000,
      });
      if (!photo) continue;

      try {
        const stored = await putObject(
          bucket,
          directoryImageKey(prefix, index, extensionFor(photo.contentType)),
          photo.body,
          photo.contentType,
          { sourceUrl: photo.sourceUrl },
        );
        imageObjects.push({ ...stored, sourceUrl: photo.sourceUrl });
      } catch {
        // One picture that will not store is not worth failing the stage over.
      }
    }

    if (imageObjects.length === 0) {
      notes.push('None of the directory photographs could be downloaded.');
    }
  }

  /**
   * The directory's facts, written as prose for the planning prompt.
   *
   * The plan prompt had nothing at all to read for a business without a
   * site, so the model was asked to write a page out of a name and a suburb.
   * This is not their marketing copy and the prompt does not call it that.
   */
  const lines = [
    business.summary ? `What the directory says: ${business.summary}` : '',
    (business.openingHours ?? []).length ? `Opening hours:\n${(business.openingHours ?? []).join('\n')}` : '',
    (business.reviews ?? []).length
      ? `What their customers said:\n${(business.reviews ?? [])
          .map((review) => `- "${review.quote}"${review.author ? ` — ${review.author}` : ''}`)
          .join('\n')}`
      : '',
  ].filter(Boolean);

  return {
    imageObjects,
    reviewSummary: summariseReviews(
      business.reviews ?? [],
      business.rating ?? null,
      business.reviewCount ?? 0,
    ),
    openingHours: business.openingHours ?? [],
    directoryContent: lines.length ? lines.join('\n\n').slice(0, 6000) : '',
  };
}
