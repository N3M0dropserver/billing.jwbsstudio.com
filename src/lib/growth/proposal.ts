/**
 * The outreach email.
 *
 * This is the only part of the pipeline that reaches a person who never
 * asked to hear from you, which makes it the part with the most rules:
 *
 *   - Every observation in the email must come from the measured audit.
 *     The model is given the findings and told to pick from them. An email
 *     that opens with a flattering invention is worse than no email.
 *   - The demo is offered, never implied to be commissioned. The generated
 *     site carries a ribbon saying as much, and the email says it too.
 *   - There is a hard daily cap on unattended sends, checked against what
 *     has actually been sent rather than what the run intended to send.
 *   - Every send records where it went and what came back, so an unattended
 *     run can be audited afterwards.
 *
 * Nothing here sends to an address that was not found on the prospect's own
 * published material.
 */

import { generateJson, MODELS, type AiResult } from '../ai/index';
import { sendMail, type SendResult } from '../mail/index';
import type { SiteAudit } from './assess';
import type { DesignPlanDraft } from './qualify';

export interface ProposalDraft {
  subject: string;
  body: string;
  /** The longer version for the proposal page, where there is room. */
  pageBody: string;
}

export interface ProposalInput {
  businessName: string;
  niche: string;
  region: string;
  audit: SiteAudit;
  plan: DesignPlanDraft;
  demoUrl: string;
  proposalUrl: string;
  senderName: string;
  senderBio: string;
  signature: string;
  /** What the designer can actually deliver, from the brief. */
  capabilities: string;
}

const SYSTEM = `You write a short cold email from a freelance designer to a business they have never spoken to, about a concept site they have already built for them.

You are given VERIFIED observations about the business's current site. Use one or two of them. Do not invent any others, and do not exaggerate the ones you are given.

Structure:
- One opening line that is specific to this business and true. Not a compliment sandwich, not "I hope this finds you well".
- One or two sentences naming what you noticed, plainly, without insulting them. They may have built that site themselves.
- One sentence saying you built a concept and where it is. Make clear it is speculative and unasked-for — that is the honest framing and it is also what makes it interesting rather than presumptuous.
- One low-friction ask. A look, a reply, fifteen minutes. Never a hard sell, never a deadline, never false scarcity.

Rules:
- Under 150 words for the email body. Nobody reads more from a stranger.
- No superlatives, no "passionate", no "leverage", no "in today's digital landscape", no "just following up", no "circling back".
- Do not claim to be a customer of theirs, or to have been referred.
- Do not promise results, traffic, rankings or revenue.
- Plain text. No markdown, no headings, no bullet points.
- Write like one person emailing another.

Also write "page_body": the same pitch with room to breathe, 150-250 words, for a page they land on after clicking. Same rules.

Return ONLY JSON: {"subject":"...","body":"...","page_body":"..."}`;

export async function draftProposal(
  ai: Ai,
  input: ProposalInput,
): Promise<AiResult<ProposalDraft>> {
  const observations = input.audit.observations.slice(0, 5);

  const prompt = [
    `Business: ${input.businessName}`,
    `Trade: ${input.niche}`,
    `Where: ${input.region}`,
    '',
    'Verified problems with their current site — use one or two, invent none:',
    observations.length
      ? observations.map((line) => `  - ${line}`).join('\n')
      : '  - (nothing measurable is wrong with their site)',
    '',
    input.audit.context.length
      ? `Background, true but not a problem — do not lead with these:\n${input.audit.context
          .map((line) => `  - ${line}`)
          .join('\n')}\n`
      : '',
    `What the concept is for: ${input.plan.summary}`,
    `Why that layout: ${input.plan.strategy}`,
    `The concept is live at: ${input.demoUrl}`,
    '',
    `From: ${input.senderName}`,
    input.senderBio ? `Who does: ${input.senderBio}` : '',
    input.capabilities ? `Can deliver: ${input.capabilities}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const result = await generateJson<{ subject?: unknown; body?: unknown; page_body?: unknown }>(ai, {
    system: SYSTEM,
    prompt,
    model: MODELS.text,
    maxTokens: 1200,
    temperature: 0.75,
  });

  if (!result.ok) return result;

  const body = String(result.data.body ?? '').trim().slice(0, 4000);
  if (!body) return { ok: false, error: 'The model returned an empty email body.' };

  return {
    ok: true,
    data: {
      subject:
        String(result.data.subject ?? '').trim().slice(0, 160) ||
        `A concept site for ${input.businessName}`,
      body,
      pageBody: String(result.data.page_body ?? '').trim().slice(0, 6000) || body,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Sending                                                             */
/* ------------------------------------------------------------------ */

export interface OutreachMessage {
  to: string;
  toName: string;
  subject: string;
  body: string;
  demoUrl: string;
  proposalUrl: string;
  senderName: string;
  signature: string;
  replyTo: string;
}

/**
 * The plain-text email.
 *
 * Text, not HTML. A first email from a stranger that arrives as a designed
 * template reads as a campaign; one that arrives as text reads as a person.
 * The links are on their own lines so they survive any client.
 */
export function renderOutreachText(message: OutreachMessage): string {
  return [
    message.body,
    '',
    `The concept: ${message.demoUrl}`,
    `A bit more on the thinking: ${message.proposalUrl}`,
    '',
    message.signature || `— ${message.senderName}`,
    '',
    '---',
    'I built this without being asked and without your involvement, so if you would',
    'rather it did not exist, reply and I will take it down the same day.',
  ].join('\n');
}

export interface SendOutreachOptions {
  /** Blocks the send when the cap for the day is already spent. */
  sentToday: number;
  dailyCap: number;
  /** True when a person pressed the button; caps do not apply to them. */
  initiatedByUser: boolean;
}

export type OutreachOutcome =
  | { ok: true; result: SendResult }
  | { ok: false; error: string; capped?: boolean };

export async function sendOutreach(
  env: Env,
  message: OutreachMessage,
  options: SendOutreachOptions,
): Promise<OutreachOutcome> {
  if (!message.to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.to)) {
    return { ok: false, error: 'No usable email address for this prospect.' };
  }

  if (!options.initiatedByUser) {
    if (options.dailyCap <= 0) {
      return {
        ok: false,
        capped: true,
        error:
          'Unattended outreach is switched off — the daily cap is zero. Send this one by hand, ' +
          'or raise the cap in settings.',
      };
    }
    if (options.sentToday >= options.dailyCap) {
      return {
        ok: false,
        capped: true,
        error: `The daily outreach cap of ${options.dailyCap} is already spent. This will wait.`,
      };
    }
  }

  const result = await sendMail(env, {
    to: message.to,
    toName: message.toName,
    subject: message.subject,
    text: renderOutreachText(message),
    replyTo: message.replyTo || undefined,
  });

  return result.ok ? { ok: true, result } : { ok: false, error: result.error ?? 'Send failed.' };
}
