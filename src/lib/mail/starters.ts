/**
 * Base templates — the clean starting points offered when a template is made.
 *
 * A blank editor is the worst first screen: it asks someone to be a designer
 * before they can be a sender. These give a finished-looking email to edit
 * down instead, which is both faster and safer — the layout is already one
 * that survives Outlook, Gmail and a phone.
 *
 * ## Why HTML and not editor JSON
 *
 * The editor stores documents as Tiptap JSON, but a starter is authored here
 * as HTML. Two reasons. Hand-writing Tiptap JSON is unreadable and unreviewable
 * — a diff on a block of nested `{ type, attrs, content }` tells you nothing
 * about whether the email still looks right. And producing that JSON from HTML
 * needs the editor schema, which lives in Tiptap, which must never reach the
 * Worker bundle. Starting from HTML keeps this file plain data: the Worker can
 * read a starter's subject without parsing anything, and the browser hands the
 * HTML to the editor, which parses it into blocks on open.
 *
 * ## The tags are a contract
 *
 * The editor only recognises a block from the exact markup its parser matches.
 * Get these wrong and the block silently degrades to a paragraph:
 *
 *   - section   `<section data-type="section">`
 *   - button    `<a data-id="react-email-button" href="…">`
 *   - columns   `<div data-type="two-columns">` wrapping `<div data-type="column">`
 *   - divider   `<hr>`
 *
 * Headings, paragraphs, lists and blockquotes are ordinary HTML. Inline
 * `style` survives the round trip on every block used here, which is how these
 * carry their own look without depending on the editor theme.
 *
 * Variables are checked against the catalogue in `variables.ts` by the test
 * suite: a starter offered for a kind may only use tokens that kind resolves,
 * because a token with no value sends as blank space.
 */

import type { TemplateKind } from '~/lib/mail/variables';

export interface Starter {
  id: string;
  name: string;
  /** One line, shown under the name in the picker. */
  description: string;
  /** The kinds whose variables and tone this suits. */
  kinds: TemplateKind[];
  subject: string;
  /** The body, as HTML the editor parses back into blocks. */
  html: string;
}

/*
 * One restrained palette across every starter, so a client who gets an invoice
 * and then a reminder gets two emails that look like the same business wrote
 * them. Hex, not oklch: email clients are a decade behind browsers and a colour
 * they cannot parse is a colour they drop.
 */
const INK = '#18181b';
const MUTED = '#71717a';
const RULE = '#e4e4e7';
const PANEL = '#f6f6f5';
const ACCENT = '#c2410c';

const LEAD = `font-size:16px;line-height:26px;color:${INK}`;
const BODY = `font-size:15px;line-height:25px;color:${INK}`;
const SMALL = `font-size:13px;line-height:21px;color:${MUTED}`;
const LABEL = `font-size:11px;line-height:16px;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED}`;
const FIGURE = `font-size:30px;line-height:38px;font-weight:600;color:${INK}`;
const TITLE = `font-size:22px;line-height:30px;font-weight:600;color:${INK}`;

const PANEL_BOX = `background-color:${PANEL};border-radius:6px;padding:20px 24px`;
const PANEL_FLAGGED = `background-color:${PANEL};border-left:3px solid ${ACCENT};border-radius:0 6px 6px 0;padding:20px 24px`;
const BUTTON = `background-color:${INK};color:#ffffff;border-radius:5px;padding:13px 22px;font-size:15px;font-weight:600`;
const DIVIDER = `border-color:${RULE};margin:28px 0`;

export const STARTERS: Starter[] = [
  {
    id: 'plain',
    name: 'Plain letter',
    description: 'Just words. A greeting, what you typed on the send form, and your name.',
    kinds: ['invoice', 'reminder', 'proposal', 'general'],
    subject: 'A note from {{business.name}}',
    html: `
      <p style="${LEAD}">Kia ora {{client.firstName}},</p>
      <p style="${BODY}">{{message}}</p>
      <p style="${BODY}">Ngā mihi,<br>{{sender.name}}</p>
    `,
  },

  {
    id: 'statement',
    name: 'Invoice with amount panel',
    description: 'The figure and due date in a panel, a pay button, and the details underneath.',
    kinds: ['invoice'],
    subject: 'Invoice {{invoice.number}} from {{business.name}}',
    html: `
      <h2 style="${TITLE}">Invoice {{invoice.number}}</h2>
      <p style="${BODY}">Kia ora {{client.firstName}},</p>
      <p style="${BODY}">Thanks very much for your business. The invoice is below and attached as a PDF.</p>

      <section data-type="section" style="${PANEL_BOX}">
        <p style="${LABEL}">Amount due</p>
        <p style="${FIGURE}">{{invoice.amountDue}}</p>
        <p style="${SMALL}">Due {{invoice.dueOn}}</p>
      </section>

      <a data-id="react-email-button" href="{{links.pay}}" style="${BUTTON}">Pay this invoice</a>

      <hr style="${DIVIDER}">

      <div data-type="two-columns">
        <div data-type="column">
          <p style="${LABEL}">Invoice</p>
          <p style="${SMALL}">{{invoice.number}}</p>
        </div>
        <div data-type="column">
          <p style="${LABEL}">Issued</p>
          <p style="${SMALL}">{{invoice.issuedOn}}</p>
        </div>
      </div>

      <p style="${SMALL}">{{business.name}} · {{business.email}}</p>
    `,
  },

  {
    id: 'nudge',
    name: 'Friendly reminder',
    description: 'Short and light. Assumes it was an oversight, because it usually was.',
    kinds: ['reminder'],
    subject: 'Invoice {{invoice.number}} — a gentle reminder',
    html: `
      <p style="${LEAD}">Kia ora {{client.firstName}},</p>
      <p style="${BODY}">Just a quick reminder that invoice {{invoice.number}} for {{invoice.amountDue}} was due on {{invoice.dueOn}}. If it is already on its way, please ignore this.</p>

      <a data-id="react-email-button" href="{{links.pay}}" style="${BUTTON}">Pay now</a>

      <p style="${SMALL}">Any questions at all, just reply — this comes straight to me.</p>
      <p style="${SMALL}">{{sender.name}} · {{business.name}}</p>
    `,
  },

  {
    id: 'overdue',
    name: 'Overdue notice',
    description: 'Firmer. Leads with how long it has been outstanding.',
    kinds: ['reminder'],
    subject: 'Overdue: invoice {{invoice.number}}',
    html: `
      <h2 style="${TITLE}">Invoice {{invoice.number}} is overdue</h2>
      <p style="${BODY}">Kia ora {{client.firstName}},</p>

      <section data-type="section" style="${PANEL_FLAGGED}">
        <p style="${LABEL}">Overdue by</p>
        <p style="${FIGURE}">{{invoice.daysOverdue}} days</p>
        <p style="${SMALL}">{{invoice.amountDue}} · was due {{invoice.dueOn}}</p>
      </section>

      <p style="${BODY}">Could you let me know when it will be paid? If something is holding it up, tell me and we will sort it out.</p>

      <a data-id="react-email-button" href="{{links.pay}}" style="${BUTTON}">Pay this invoice</a>

      <hr style="${DIVIDER}">
      <p style="${SMALL}">{{sender.name}} · {{business.name}} · {{business.email}}</p>
    `,
  },

  {
    id: 'proposal',
    name: 'Proposal with a call to action',
    description: 'The quoted fee in a panel, how long it stands, and a button to read it.',
    kinds: ['proposal'],
    subject: '{{proposal.title}} — proposal from {{business.name}}',
    html: `
      <h2 style="${TITLE}">{{proposal.title}}</h2>
      <p style="${BODY}">Kia ora {{client.firstName}},</p>
      <p style="${BODY}">{{message}}</p>

      <section data-type="section" style="${PANEL_BOX}">
        <p style="${LABEL}">Proposed fee</p>
        <p style="${FIGURE}">{{proposal.amount}}</p>
        <p style="${SMALL}">Valid until {{proposal.expiresOn}}</p>
      </section>

      <a data-id="react-email-button" href="{{links.proposal}}" style="${BUTTON}">Read the proposal</a>

      <p style="${BODY}">Happy to talk any of it through — just reply.</p>
      <p style="${SMALL}">{{sender.name}} · {{business.name}}</p>
    `,
  },

  {
    id: 'branded',
    name: 'Branded header and footer',
    description: 'Your name up top, your contact details in a two-column footer, message between.',
    kinds: ['invoice', 'reminder', 'proposal', 'general'],
    subject: '{{business.name}}',
    html: `
      <section data-type="section" style="padding-bottom:18px;border-bottom:1px solid ${RULE}">
        <p style="font-size:14px;line-height:20px;letter-spacing:0.12em;text-transform:uppercase;font-weight:600;color:${INK}">{{business.name}}</p>
      </section>

      <p style="${LEAD}">Kia ora {{client.firstName}},</p>
      <p style="${BODY}">{{message}}</p>
      <p style="${BODY}">Ngā mihi,<br>{{sender.name}}</p>

      <hr style="${DIVIDER}">

      <div data-type="two-columns">
        <div data-type="column">
          <p style="${SMALL}">{{business.email}}<br>{{business.phone}}</p>
        </div>
        <div data-type="column">
          <p style="${SMALL}">{{business.website}}</p>
        </div>
      </div>
    `,
  },
];

/** The starters worth offering for a kind, in catalogue order. */
export function startersFor(kind: TemplateKind): Starter[] {
  return STARTERS.filter((starter) => starter.kinds.includes(kind));
}

export function starterById(id: string | null | undefined): Starter | null {
  if (!id) return null;
  return STARTERS.find((starter) => starter.id === id) ?? null;
}
