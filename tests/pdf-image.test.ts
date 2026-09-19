import { describe, it, expect } from 'vitest';
import { decodeImage, deflate, inflate, ImageError, looksLikePng, looksLikeJpeg } from '~/lib/pdf/image';
import { PdfDocument, fitWithin } from '~/lib/pdf/writer';

/**
 * Fixtures are built here rather than checked in.
 *
 * A committed binary is a fixture nobody can read a diff of, and the thing
 * being tested is a decoder — so the encoder that feeds it has to be visible
 * or the test is only asserting that two opaque blobs agree.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** Channels per pixel, by PNG colour type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 6: 4 };

/**
 * Build a PNG. `filter` picks the row filter, so the unfiltering path is
 * exercised rather than assumed — filter 0 alone would never run the Paeth
 * branch that most real PNGs are encoded with.
 */
async function png(
  width: number,
  height: number,
  colorType: number,
  pixel: (x: number, y: number) => number[],
  filter = 0,
): Promise<Uint8Array> {
  const channels = CHANNELS[colorType]!;
  const stride = width * channels;

  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = colorType;

  const raw = new Uint8Array((stride + 1) * height);
  let previous = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(stride);
    for (let x = 0; x < width; x++) {
      const values = pixel(x, y);
      for (let c = 0; c < channels; c++) row[x * channels + c] = values[c]!;
    }

    const at = y * (stride + 1);
    raw[at] = filter;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels]! : 0;
      const b = previous[i]!;
      const c = i >= channels ? previous[i - channels]! : 0;

      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      raw[at + 1 + i] = (row[i]! - predictor) & 0xff;
    }
    previous = row;
  }

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const opaque = () => png(24, 16, 2, (x, y) => [x * 10, y * 15, 90]);
const transparent = (filter = 0) =>
  png(20, 20, 6, (x, y) => (x + y > 18 ? [220, 120, 60, 255] : [0, 0, 0, 0]), filter);

const decode = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join('');

describe('zlib round trip', () => {
  it('inflates what it deflated', async () => {
    const data = new Uint8Array(5000).map((_, i) => i % 251);
    expect(Array.from(await inflate(await deflate(data)))).toEqual(Array.from(data));
  });
});

describe('format sniffing', () => {
  it('recognises a PNG', async () => {
    expect(looksLikePng(await opaque())).toBe(true);
    expect(looksLikeJpeg(await opaque())).toBe(false);
  });

  it('refuses anything else with a reason worth showing someone', async () => {
    await expect(decodeImage(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))).rejects.toThrow(ImageError);
    await expect(decodeImage(new Uint8Array([0, 1, 2, 3]))).rejects.toThrow(/PNG and JPEG/);
  });
});

describe('PNG without transparency', () => {
  it('passes the compressed data straight through', async () => {
    const image = await decodeImage(await opaque());
    expect(image).toMatchObject({
      width: 24,
      height: 16,
      filter: 'FlateDecode',
      colorSpace: '/DeviceRGB',
      bitsPerComponent: 8,
    });
    // The whole point: no decode, just a predictor telling the reader how the
    // rows were filtered.
    expect(image.decodeParms).toContain('/Predictor 15');
    expect(image.decodeParms).toContain('/Columns 24');
    expect(image.smask).toBeUndefined();
  });

  it('reads greyscale as DeviceGray', async () => {
    const image = await decodeImage(await png(8, 8, 0, (x) => [x * 30]));
    expect(image.colorSpace).toBe('/DeviceGray');
  });
});

describe('PNG with an alpha channel', () => {
  it('splits colour from alpha into a soft mask', async () => {
    const image = await decodeImage(await transparent());
    expect(image).toMatchObject({ width: 20, height: 20, colorSpace: '/DeviceRGB', bitsPerComponent: 8 });
    expect(image.smask).toBeDefined();
    expect(image.smask!.width).toBe(20);
    // Separated, so there is no predictor left to apply.
    expect(image.decodeParms).toBeUndefined();
  });

  it('recovers the same pixels whichever row filter was used', async () => {
    // The filters are lossless, so every encoding of the same image has to
    // decode back to identical bytes. This is what catches a wrong Paeth.
    const reference = await decodeImage(await transparent(0));
    const colour = Array.from(await inflate(reference.data));
    const alpha = Array.from(await inflate(reference.smask!.data));

    for (const filter of [1, 2, 3, 4]) {
      const image = await decodeImage(await transparent(filter));
      // Named in the assertion so a failure says which filter broke.
      expect({ filter, colour: Array.from(await inflate(image.data)) }).toEqual({ filter, colour });
      expect({ filter, alpha: Array.from(await inflate(image.smask!.data)) }).toEqual({ filter, alpha });
    }
  });

  it('makes the transparent corner transparent and the rest opaque', async () => {
    const image = await decodeImage(await transparent());
    const alpha = await inflate(image.smask!.data);
    // (0,0) is outside the shape, the far corner is inside it.
    expect(alpha[0]).toBe(0);
    expect(alpha[alpha.length - 1]).toBe(255);
  });
});

describe('damaged input', () => {
  it('rejects an interlaced PNG by name', async () => {
    const bytes = await opaque();
    bytes[8 + 8 + 12] = 1; // IHDR interlace byte
    // The CRC is now wrong too, which the reader ignores — the point is that
    // the interlace flag is what it complains about.
    await expect(decodeImage(bytes)).rejects.toThrow(/interlaced/i);
  });

  it('rejects a PNG with no image data', async () => {
    const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = new Uint8Array(13);
    new DataView(ihdr.buffer).setUint32(0, 4);
    new DataView(ihdr.buffer).setUint32(4, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;

    const header = chunk('IHDR', ihdr);
    const bytes = new Uint8Array(signature.length + header.length);
    bytes.set(signature);
    bytes.set(header, signature.length);

    await expect(decodeImage(bytes)).rejects.toThrow(/no image data/i);
  });
});

describe('embedding into a document', () => {
  it('writes an XObject, a soft mask and a placement', async () => {
    const doc = new PdfDocument();
    const page = doc.addPage();
    const handle = doc.addImage(await decodeImage(await transparent()));

    page.image(handle, 48, 40, 60, 60);
    const text = decode(doc.build({ title: 'probe' }));

    expect(text).toContain('/Subtype /Image');
    expect(text).toContain('/SMask');
    expect(text).toContain('/Im0 Do');
    expect(text).toContain('/XObject << /Im0');
  });

  it('keeps the xref honest once streams contain binary', async () => {
    // Image data is arbitrary bytes, including ones that look like PDF
    // syntax. If the offsets are computed in anything but bytes, this breaks.
    const doc = new PdfDocument();
    const page = doc.addPage();
    page.image(doc.addImage(await decodeImage(await opaque())), 20, 20, 100, 70);
    const text = decode(doc.build());

    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);

    const xrefStart = Number.parseInt(text.match(/startxref\n(\d+)\n%%EOF/)![1]!, 10);
    expect(text.slice(xrefStart, xrefStart + 4)).toBe('xref');

    const entries = [...text.slice(xrefStart).matchAll(/^(\d{10}) (\d{5}) n $/gm)];
    expect(entries.length).toBeGreaterThan(6);
    for (const entry of entries) {
      expect(text.slice(Number.parseInt(entry[1]!, 10))).toMatch(/^\d+ 0 obj/);
    }
  });

  it('draws nothing for a zero-sized placement', async () => {
    const doc = new PdfDocument();
    const page = doc.addPage();
    page.image(doc.addImage(await decodeImage(await opaque())), 10, 10, 0, 40);
    expect(decode(doc.build())).not.toContain('/Im0 Do');
  });
});

describe('fitWithin', () => {
  it('preserves the aspect ratio', () => {
    expect(fitWithin(200, 100, 50, 50)).toEqual({ width: 50, height: 25 });
    expect(fitWithin(100, 200, 50, 50)).toEqual({ width: 25, height: 50 });
  });

  it('constrains by whichever edge binds first', () => {
    expect(fitWithin(100, 100, 80, 40)).toEqual({ width: 40, height: 40 });
  });

  it('survives a degenerate size rather than dividing by zero', () => {
    expect(fitWithin(0, 10, 50, 50)).toEqual({ width: 0, height: 0 });
  });
});
