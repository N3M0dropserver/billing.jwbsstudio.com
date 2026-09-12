/**
 * Outbound email.
 *
 * Two providers behind one interface:
 *
 *   cloudflare — Cloudflare Email Service via the `send_email` binding. No API
 *                key to leak, co-located with the Worker. Public beta.
 *   resend     — a plain HTTPS API, as a fallback or if you would rather not
 *                run on a beta product.
 *
 * Nothing else in the app knows which is in use. Switch with MAIL_PROVIDER in
 * wrangler.jsonc.
 *
 * Note: Cloudflare Email ROUTING is inbound only and cannot send — it is a
 * different product from Email Service. The MailChannels integration Workers
 * used for years was withdrawn in August 2024 and must not be reintroduced.
 */

export interface Attachment {
  filename: string;
  content: Uint8Array;
  contentType: string;
}

export interface Message {
  to: string;
  toName?: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  attachments?: Attachment[];
}

export interface SendResult {
  ok: boolean;
  provider: string;
  id?: string;
  error?: string;
}

/**
 * Cloudflare Email Service caps a message at 5 MiB including attachments.
 * Checked before sending so the failure names the cause rather than surfacing
 * a generic API error.
 */
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000; // Chunked to stay under the argument-count limit.
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function attachmentBytes(message: Message): number {
  return (message.attachments ?? []).reduce((sum, a) => sum + a.content.byteLength, 0);
}

function tooLarge(message: Message): string | null {
  // Base64 inflates by ~4/3; compare against the encoded size that is
  // actually transmitted.
  const encoded = Math.ceil(attachmentBytes(message) * 1.37) + message.text.length + (message.html?.length ?? 0);
  if (encoded > MAX_MESSAGE_BYTES) {
    return `Message is about ${(encoded / 1024 / 1024).toFixed(1)} MiB, over the 5 MiB limit. Attach fewer or smaller files.`;
  }
  return null;
}

export async function sendMail(env: Env, message: Message): Promise<SendResult> {
  const provider = env.MAIL_PROVIDER ?? 'none';

  if (provider === 'none') {
    return {
      ok: false,
      provider: 'none',
      error: 'Email sending is disabled. Set MAIL_PROVIDER to "cloudflare" or "resend".',
    };
  }

  const oversize = tooLarge(message);
  if (oversize) return { ok: false, provider, error: oversize };

  if (provider === 'cloudflare') return sendViaCloudflare(env, message);
  if (provider === 'resend') return sendViaResend(env, message);

  return { ok: false, provider, error: `Unknown mail provider "${provider}".` };
}

/**
 * Cloudflare Email Service.
 *
 * Uses the structured send() API rather than the older raw-MIME EmailMessage
 * form — Cloudflare assembles the MIME itself, including attachment parts, so
 * there is no hand-rolled message to get subtly wrong.
 *
 * Attachment content goes as base64 rather than an ArrayBuffer: both are
 * accepted, but binary content cannot be serialised across the local dev
 * boundary unless the binding is marked `remote`, and base64 works either way.
 */
async function sendViaCloudflare(env: Env, message: Message): Promise<SendResult> {
  if (!env.EMAIL) {
    return {
      ok: false,
      provider: 'cloudflare',
      error:
        'The EMAIL binding is missing. Add `"send_email": [{ "name": "EMAIL", "remote": true }]` to wrangler.jsonc and redeploy.',
    };
  }

  try {
    const result = await env.EMAIL.send({
      from: { email: env.MAIL_FROM, name: env.MAIL_FROM_NAME },
      to: message.toName ? { email: message.to, name: message.toName } : message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      ...(message.attachments?.length
        ? {
            attachments: message.attachments.map((a) => ({
              filename: a.filename,
              content: toBase64(a.content),
              type: a.contentType,
              disposition: 'attachment' as const,
            })),
          }
        : {}),
    });

    return { ok: true, provider: 'cloudflare', id: result?.messageId };
  } catch (error) {
    return { ok: false, provider: 'cloudflare', error: describeCloudflareError(error) };
  }
}

/**
 * Turn the common Email Service failures into something that says what to do.
 * The raw errors are terse and the causes are nearly always configuration.
 */
function describeCloudflareError(error: unknown): string {
  const text = String(error);

  if (/not verified|unverified|verify/i.test(text)) {
    return `${text} — until the sending domain is fully onboarded, Email Service will only deliver to destination addresses verified in your account. Verify the recipient, or finish onboarding the domain so you can send to clients.`;
  }
  if (/domain/i.test(text) && /not|invalid|unknown/i.test(text)) {
    return `${text} — the MAIL_FROM address must be on a domain you have onboarded to Email Service, and that domain must use Cloudflare DNS.`;
  }
  if (/quota|limit|rate/i.test(text)) {
    return `${text} — you may have hit the sending quota. Messages to verified destination addresses do not count towards it.`;
  }
  return text;
}

async function sendViaResend(env: Env, message: Message): Promise<SendResult> {
  if (!env.RESEND_API_KEY) {
    return {
      ok: false,
      provider: 'resend',
      error: 'RESEND_API_KEY is not set. Run `wrangler secret put RESEND_API_KEY`.',
    };
  }

  const body: Record<string, unknown> = {
    from: `${env.MAIL_FROM_NAME} <${env.MAIL_FROM}>`,
    to: [message.toName ? `${message.toName} <${message.to}>` : message.to],
    subject: message.subject,
    text: message.text,
  };
  if (message.html) body.html = message.html;
  if (message.replyTo) body.reply_to = message.replyTo;
  if (message.attachments?.length) {
    body.attachments = message.attachments.map((a) => ({
      filename: a.filename,
      content: toBase64(a.content),
      content_type: a.contentType,
    }));
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await response.text();
      return { ok: false, provider: 'resend', error: `${response.status}: ${detail.slice(0, 300)}` };
    }

    const data = (await response.json()) as { id?: string };
    return { ok: true, provider: 'resend', id: data.id };
  } catch (error) {
    return { ok: false, provider: 'resend', error: String(error) };
  }
}

export { toBase64, MAX_MESSAGE_BYTES };
