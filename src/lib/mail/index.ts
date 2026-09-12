/**
 * Outbound email.
 *
 * Cloudflare's own Email Service is the obvious fit for a Worker (a native
 * binding, no API key to leak), but it is in public beta — so this sits
 * behind an interface with a Resend fallback, and either can be switched by
 * changing MAIL_PROVIDER. Nothing else in the app knows which is in use.
 *
 * Note: Cloudflare Email ROUTING is inbound only and cannot send. The
 * MailChannels integration that Workers used for years was withdrawn in
 * August 2024 and must not be reintroduced.
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

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
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

  if (provider === 'resend') return sendViaResend(env, message);
  if (provider === 'cloudflare') return sendViaCloudflare(env, message);

  return { ok: false, provider, error: `Unknown mail provider "${provider}".` };
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

/**
 * Cloudflare Email Service, via the `send_email` binding.
 *
 * The binding takes a raw RFC 5322 message, so a MIME document has to be
 * assembled by hand — which is also what lets the invoice PDF ride along as
 * an attachment.
 */
async function sendViaCloudflare(env: Env, message: Message): Promise<SendResult> {
  if (!env.EMAIL) {
    return {
      ok: false,
      provider: 'cloudflare',
      error:
        'The EMAIL binding is not configured. Uncomment the send_email binding in wrangler.jsonc and redeploy.',
    };
  }

  try {
    const raw = buildMimeMessage(env, message);
    await env.EMAIL.send({ from: env.MAIL_FROM, to: message.to, raw });
    return { ok: true, provider: 'cloudflare' };
  } catch (error) {
    return { ok: false, provider: 'cloudflare', error: String(error) };
  }
}

/** Build a multipart/mixed MIME message. */
export function buildMimeMessage(env: Env, message: Message): string {
  const boundary = `----jwbs${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const date = new Date().toUTCString();
  const messageId = `<${crypto.randomUUID()}@${env.MAIL_FROM.split('@')[1] ?? 'localhost'}>`;

  // Anything beyond ASCII in a header must be encoded-word wrapped.
  const header = (value: string) =>
    /^[\x20-\x7E]*$/.test(value)
      ? value
      : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(value)))}?=`;

  const lines: string[] = [
    `From: ${header(env.MAIL_FROM_NAME)} <${env.MAIL_FROM}>`,
    `To: ${message.toName ? `${header(message.toName)} <${message.to}>` : message.to},`.replace(/,$/, ''),
    `Subject: ${header(message.subject)}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
  ];
  if (message.replyTo) lines.push(`Reply-To: ${message.replyTo}`);
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, '');

  const encodeBody = (value: string) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(value))).replace(/(.{76})/g, '$1\r\n');

  lines.push(
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodeBody(message.text),
    '',
  );

  if (message.html) {
    lines.push(
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      encodeBody(message.html),
      '',
    );
  }

  for (const attachment of message.attachments ?? []) {
    lines.push(
      `--${boundary}`,
      `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      '',
      toBase64(attachment.content).replace(/(.{76})/g, '$1\r\n'),
      '',
    );
  }

  lines.push(`--${boundary}--`, '');
  return lines.join('\r\n');
}
