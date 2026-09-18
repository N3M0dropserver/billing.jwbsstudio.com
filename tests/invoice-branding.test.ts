import { describe, it, expect, vi } from 'vitest';
import { loadLogo, LOGO_PREFIX, MAX_LOGO_BYTES } from '~/lib/invoices/branding';
import { deflate } from '~/lib/pdf/image';
import { normalise } from '~/lib/pdf/template';

/**
 * `loadLogo` is the only thing that reads the FILES bucket on a render path,
 * and that bucket also holds every invoice PDF this system has ever issued
 * under `invoices/<user>/`. So the interesting cases here are not "does it
 * load an image" — they are the ones where it must refuse to look.
 */

/** A tiny valid PNG, built rather than checked in. */
async function tinyPng(): Promise<Uint8Array> {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc = (bytes: Uint8Array) => {
    let value = 0xffffffff;
    for (const byte of bytes) value = table[(value ^ byte) & 0xff]! ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    view.setUint32(8 + body.length, crc(out.subarray(4, 8 + body.length)));
    return out;
  };

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 2);
  view.setUint32(4, 2);
  ihdr[8] = 8;
  ihdr[9] = 2;

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', await deflate(new Uint8Array((2 * 3 + 1) * 2))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** An R2 stub that records what it was asked for. */
function bucket(contents: Record<string, Uint8Array>, options: { size?: number } = {}) {
  const asked: string[] = [];
  const get = vi.fn(async (key: string) => {
    asked.push(key);
    const body = contents[key];
    if (!body) return null;
    return {
      size: options.size ?? body.length,
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  });
  return { bucket: { get } as unknown as R2Bucket, asked };
}

const designWith = (key: string) => normalise({ logo: { key, size: 90, position: 'left' } });

describe('loadLogo', () => {
  it('loads and decodes a logo under the right prefix', async () => {
    const key = `${LOGO_PREFIX}user-1/logo.png`;
    const { bucket: files } = bucket({ [key]: await tinyPng() });

    const image = await loadLogo(files, designWith(key));
    expect(image).not.toBeNull();
    expect(image!.width).toBe(2);
  });

  it('returns nothing when the design has no logo, without touching the bucket', async () => {
    const { bucket: files, asked } = bucket({});
    expect(await loadLogo(files, designWith(''))).toBeNull();
    expect(asked).toEqual([]);
  });

  /**
   * The design is user-supplied JSON. `normalise` already strips a key that
   * points outside `invoice-assets/`, but this is the function that actually
   * reads the bucket, so it checks again — and this asserts it never asks.
   */
  it('never reads a key outside the logo prefix', async () => {
    const stolen = 'invoices/someone-else/INV-0001.pdf';
    const { bucket: files, asked } = bucket({ [stolen]: await tinyPng() });

    // Bypassing `normalise`, which is the only way such a key gets this far.
    const design = { ...designWith(''), logo: { key: stolen, size: 90, position: 'left' as const } };

    expect(await loadLogo(files, design)).toBeNull();
    expect(asked).toEqual([]);
  });

  it('refuses a key containing a traversal segment', async () => {
    const { bucket: files, asked } = bucket({});
    const design = {
      ...designWith(''),
      logo: { key: `${LOGO_PREFIX}../invoices/x.pdf`, size: 90, position: 'left' as const },
    };

    expect(await loadLogo(files, design)).toBeNull();
    expect(asked).toEqual([]);
  });

  it('returns nothing when the object is gone', async () => {
    const { bucket: files } = bucket({});
    expect(await loadLogo(files, designWith(`${LOGO_PREFIX}user-1/missing.png`))).toBeNull();
  });

  it('refuses an object larger than the cap rather than decoding it', async () => {
    const key = `${LOGO_PREFIX}user-1/huge.png`;
    const { bucket: files } = bucket({ [key]: await tinyPng() }, { size: MAX_LOGO_BYTES + 1 });
    expect(await loadLogo(files, designWith(key))).toBeNull();
  });

  /**
   * The whole reason this returns null instead of throwing: an unreadable
   * logo must produce an invoice without one, never a send that fails.
   */
  it('swallows a corrupt image', async () => {
    const key = `${LOGO_PREFIX}user-1/broken.png`;
    const { bucket: files } = bucket({ [key]: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) });

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadLogo(files, designWith(key))).toBeNull();
    // ...but says so, because a logo that silently stopped appearing is the
    // kind of thing nobody notices for months.
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('swallows the bucket being unavailable', async () => {
    const files = { get: async () => { throw new Error('R2 is down'); } } as unknown as R2Bucket;

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadLogo(files, designWith(`${LOGO_PREFIX}user-1/logo.png`))).toBeNull();
    error.mockRestore();
  });
});
