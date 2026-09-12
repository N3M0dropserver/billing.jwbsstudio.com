import { describe, it, expect, vi } from 'vitest';
import { sendMail, toBase64, MAX_MESSAGE_BYTES, type Message } from '~/lib/mail';

const baseEnv = {
  MAIL_FROM: 'invoices@jwbsstudio.com',
  MAIL_FROM_NAME: 'JWBS Studio',
} as unknown as Env;

const message: Message = {
  to: 'accounts@kowhai.co.nz',
  toName: 'Kōwhai Coffee Roasters',
  subject: 'Invoice INV-0042',
  text: 'Invoice attached.',
  html: '<p>Invoice attached.</p>',
  replyTo: 'hello@jwbsstudio.com',
  attachments: [
    { filename: 'INV-0042.pdf', content: new Uint8Array([37, 80, 68, 70]), contentType: 'application/pdf' },
  ],
};

type SendPayload = Record<string, unknown>;

/** A stand-in for the Cloudflare send_email binding. */
function fakeBinding() {
  return vi.fn(async (_payload: SendPayload) => ({ messageId: 'msg_123' }));
}

/** The payload the binding was called with, typed for assertions. */
function payloadOf(send: ReturnType<typeof fakeBinding>): SendPayload {
  expect(send).toHaveBeenCalledTimes(1);
  return send.mock.calls[0]![0];
}

describe('provider selection', () => {
  it('refuses to send when disabled', async () => {
    const result = await sendMail({ ...baseEnv, MAIL_PROVIDER: 'none' } as Env, message);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/disabled/i);
  });

  it('rejects an unknown provider by name', async () => {
    const result = await sendMail({ ...baseEnv, MAIL_PROVIDER: 'sendgrid' } as unknown as Env, message);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/sendgrid/);
  });

  it('explains how to add the binding when it is missing', async () => {
    const result = await sendMail({ ...baseEnv, MAIL_PROVIDER: 'cloudflare' } as Env, message);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/send_email/);
    expect(result.error).toMatch(/wrangler\.jsonc/);
  });
});

describe('Cloudflare Email Service payload', () => {
  it('sends and returns the message id', async () => {
    const send = fakeBinding();
    const result = await sendMail(
      { ...baseEnv, MAIL_PROVIDER: 'cloudflare', EMAIL: { send } } as unknown as Env,
      message,
    );
    expect(result.ok).toBe(true);
    expect(result.provider).toBe('cloudflare');
    expect(result.id).toBe('msg_123');
  });

  it('builds the structured payload the API expects', async () => {
    const send = fakeBinding();
    await sendMail({ ...baseEnv, MAIL_PROVIDER: 'cloudflare', EMAIL: { send } } as unknown as Env, message);

    const payload = payloadOf(send);
    expect(payload.from).toEqual({ email: 'invoices@jwbsstudio.com', name: 'JWBS Studio' });
    expect(payload.to).toEqual({ email: 'accounts@kowhai.co.nz', name: 'Kōwhai Coffee Roasters' });
    expect(payload.subject).toBe('Invoice INV-0042');
    expect(payload.text).toBe('Invoice attached.');
    expect(payload.replyTo).toBe('hello@jwbsstudio.com');
    // Not a raw MIME string — that is the legacy EmailMessage form.
    expect(payload).not.toHaveProperty('raw');
  });

  it('sends a bare address when no recipient name is known', async () => {
    const send = fakeBinding();
    await sendMail(
      { ...baseEnv, MAIL_PROVIDER: 'cloudflare', EMAIL: { send } } as unknown as Env,
      { ...message, toName: undefined },
    );
    expect(payloadOf(send).to).toBe('accounts@kowhai.co.nz');
  });

  it('encodes attachments as base64 with the right shape', async () => {
    const send = fakeBinding();
    await sendMail({ ...baseEnv, MAIL_PROVIDER: 'cloudflare', EMAIL: { send } } as unknown as Env, message);

    const attachments = payloadOf(send).attachments as Array<Record<string, string>>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toEqual({
      filename: 'INV-0042.pdf',
      content: btoa('%PDF'),
      type: 'application/pdf',
      disposition: 'attachment',
    });
  });

  it('omits optional keys rather than sending undefined', async () => {
    const send = fakeBinding();
    await sendMail(
      { ...baseEnv, MAIL_PROVIDER: 'cloudflare', EMAIL: { send } } as unknown as Env,
      { to: 'a@b.com', subject: 's', text: 't' },
    );
    const payload = payloadOf(send);
    expect(payload).not.toHaveProperty('html');
    expect(payload).not.toHaveProperty('replyTo');
    expect(payload).not.toHaveProperty('attachments');
  });
});

describe('Cloudflare error messages point at the fix', () => {
  const withError = (text: string) =>
    sendMail(
      {
        ...baseEnv,
        MAIL_PROVIDER: 'cloudflare',
        EMAIL: { send: async () => { throw new Error(text); } },
      } as unknown as Env,
      message,
    );

  it('explains the verified-destination restriction', async () => {
    const result = await withError('destination address is not verified');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/onboard/i);
  });

  it('explains a domain problem', async () => {
    const result = await withError('sender domain not onboarded');
    expect(result.error).toMatch(/Cloudflare DNS/);
  });

  it('explains a quota problem', async () => {
    const result = await withError('sending quota exceeded');
    expect(result.error).toMatch(/verified destination addresses do not count/);
  });

  it('passes an unrecognised error through unchanged', async () => {
    const result = await withError('kaboom');
    expect(result.error).toMatch(/kaboom/);
  });
});

describe('size guard', () => {
  it('rejects a message over the 5 MiB limit before calling the API', async () => {
    const send = fakeBinding();
    const result = await sendMail(
      { ...baseEnv, MAIL_PROVIDER: 'cloudflare', EMAIL: { send } } as unknown as Env,
      {
        ...message,
        attachments: [
          { filename: 'big.pdf', content: new Uint8Array(6 * 1024 * 1024), contentType: 'application/pdf' },
        ],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/5 MiB limit/);
    expect(send).not.toHaveBeenCalled();
  });

  it('allows a normal invoice through', async () => {
    const send = fakeBinding();
    const result = await sendMail(
      { ...baseEnv, MAIL_PROVIDER: 'cloudflare', EMAIL: { send } } as unknown as Env,
      {
        ...message,
        attachments: [
          { filename: 'invoice.pdf', content: new Uint8Array(8_000), contentType: 'application/pdf' },
        ],
      },
    );
    expect(result.ok).toBe(true);
  });

  it('accounts for base64 inflation, not just raw bytes', async () => {
    // 4 MiB raw is under the limit, but ~5.5 MiB once base64 encoded.
    const send = fakeBinding();
    const result = await sendMail(
      { ...baseEnv, MAIL_PROVIDER: 'cloudflare', EMAIL: { send } } as unknown as Env,
      {
        ...message,
        attachments: [
          { filename: 'big.pdf', content: new Uint8Array(4 * 1024 * 1024), contentType: 'application/pdf' },
        ],
      },
    );
    expect(4 * 1024 * 1024).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(result.ok).toBe(false);
  });
});

describe('Resend fallback still works', () => {
  it('says how to set the key when it is missing', async () => {
    const result = await sendMail({ ...baseEnv, MAIL_PROVIDER: 'resend' } as Env, message);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/wrangler secret put RESEND_API_KEY/);
  });

  it('posts the Resend payload shape', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ id: 're_1' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendMail(
      { ...baseEnv, MAIL_PROVIDER: 'resend', RESEND_API_KEY: 'test' } as Env,
      message,
    );

    expect(result.ok).toBe(true);
    expect(result.id).toBe('re_1');
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.from).toBe('JWBS Studio <invoices@jwbsstudio.com>');
    expect(body.attachments[0].content_type).toBe('application/pdf');
    vi.unstubAllGlobals();
  });

  it('surfaces a Resend API error', async () => {
    vi.stubGlobal('fetch', async () => new Response('bad domain', { status: 403 }));
    const result = await sendMail(
      { ...baseEnv, MAIL_PROVIDER: 'resend', RESEND_API_KEY: 'test' } as Env,
      message,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/403/);
    vi.unstubAllGlobals();
  });
});

describe('base64 encoding', () => {
  it('round-trips binary content', () => {
    const bytes = new Uint8Array([0, 1, 255, 128, 37, 80, 68, 70]);
    expect(Uint8Array.from(atob(toBase64(bytes)), (c) => c.charCodeAt(0))).toEqual(bytes);
  });

  it('handles content larger than one chunk without blowing the stack', () => {
    const bytes = new Uint8Array(200_000).fill(65);
    expect(atob(toBase64(bytes)).length).toBe(200_000);
  });
});
