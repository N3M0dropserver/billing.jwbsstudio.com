/**
 * Turning an uploaded logo into something a PDF can draw.
 *
 * A PDF image is an XObject: a blob of samples plus a description of how to
 * read them. The trick that keeps this small is that two of the formats a
 * PDF understands are formats people already upload — a JPEG's entropy-coded
 * data *is* `/DCTDecode`, and a PNG's IDAT stream *is* `/FlateDecode` with a
 * PNG predictor. So for most images nothing is decoded at all: the bytes are
 * copied across and labelled.
 *
 * The exception is transparency, and it is not an edge case — a logo dropped
 * onto a coloured header is almost always a PNG with an alpha channel. PDF
 * keeps alpha in a separate `/SMask` image, so those have to be taken apart:
 * inflate, undo the per-scanline filters, split colour from alpha, deflate
 * each again. `DecompressionStream`/`CompressionStream` are in both workerd
 * and Node, so that costs no dependency — it only costs being async, which is
 * why `decodeImage` returns a promise and `renderInvoicePdf` does not.
 */

export interface PdfImageMask {
  width: number;
  height: number;
  /** 8-bit grayscale alpha, deflate-compressed. */
  data: Uint8Array;
}

export interface PdfImage {
  width: number;
  height: number;
  /** The PDF filter that describes `data`. */
  filter: 'FlateDecode' | 'DCTDecode';
  /** A PDF colour space object, e.g. `/DeviceRGB`. */
  colorSpace: string;
  bitsPerComponent: number;
  data: Uint8Array;
  /** `/DecodeParms`, when the samples need a predictor to be read back. */
  decodeParms?: string;
  /** `/Decode`, for the one case that needs inverting (Adobe CMYK JPEG). */
  decode?: string;
  /** Alpha, as a separate image. */
  smask?: PdfImageMask;
}

/** An image that could not be used, with a reason worth showing someone. */
export class ImageError extends Error {}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function looksLikePng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, i) => bytes[i] === byte);
}

export function looksLikeJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * Read an uploaded image into the parts a PDF XObject needs.
 *
 * Throws `ImageError` with something a person can act on — "this PNG is
 * interlaced" is a fixable problem, "undefined is not a function" is not.
 */
export async function decodeImage(bytes: Uint8Array): Promise<PdfImage> {
  if (looksLikeJpeg(bytes)) return decodeJpeg(bytes);
  if (looksLikePng(bytes)) return decodePng(bytes);
  throw new ImageError('Only PNG and JPEG images can be placed on a PDF.');
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

/** Start-of-frame markers. Every one of them carries the dimensions. */
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/**
 * A JPEG needs no decoding — `/DCTDecode` hands the bytes to the reader's own
 * decoder. All that is wanted is the frame header, for the dimensions and the
 * number of colour components.
 */
function decodeJpeg(bytes: Uint8Array): PdfImage {
  let offset = 2; // Past SOI.
  let adobeTransform = -1;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      throw new ImageError('That JPEG is damaged — no marker where one was expected.');
    }

    const marker = bytes[offset + 1]!;
    offset += 2;

    // Standalone markers carry no payload.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2) throw new ImageError('That JPEG is damaged — a segment has no length.');

    // APP14/Adobe says how the components should be interpreted. It is the
    // difference between a correct CMYK JPEG and an inverted one.
    if (marker === 0xee && length >= 13) {
      const tag = String.fromCharCode(...bytes.subarray(offset + 2, offset + 7));
      if (tag === 'Adobe') adobeTransform = bytes[offset + 13] ?? -1;
    }

    if (SOF_MARKERS.has(marker)) {
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const components = bytes[offset + 7]!;

      const colorSpace =
        components === 1 ? '/DeviceGray' : components === 4 ? '/DeviceCMYK' : '/DeviceRGB';

      if (!width || !height) throw new ImageError('That JPEG reports a zero size.');

      return {
        width,
        height,
        filter: 'DCTDecode',
        colorSpace,
        bitsPerComponent: bytes[offset + 2]!,
        data: bytes,
        // Photoshop writes CMYK JPEGs inverted. `adobeTransform >= 0` means an
        // Adobe marker was present, which is the signal to invert them back.
        decode:
          components === 4 && adobeTransform >= 0 ? '[1 0 1 0 1 0 1 0]' : undefined,
      };
    }

    offset += length;
  }

  throw new ImageError('That JPEG has no frame header — it may be truncated.');
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

interface PngChunks {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
  idat: Uint8Array;
  palette?: Uint8Array;
  /** Palette alpha, one byte per palette entry, from tRNS. */
  paletteAlpha?: Uint8Array;
}

/** Colour components per pixel, by PNG colour type. */
const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function readPngChunks(bytes: Uint8Array): PngChunks {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8; // Past the signature.

  let header: { width: number; height: number; bitDepth: number; colorType: number; interlace: number } | null = null;
  let palette: Uint8Array | undefined;
  let paletteAlpha: Uint8Array | undefined;
  const idatParts: Uint8Array[] = [];

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const body = bytes.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      header = {
        width: view.getUint32(offset + 8),
        height: view.getUint32(offset + 12),
        bitDepth: bytes[offset + 16]!,
        colorType: bytes[offset + 17]!,
        interlace: bytes[offset + 20]!,
      };
    } else if (type === 'PLTE') {
      palette = body;
    } else if (type === 'tRNS') {
      paletteAlpha = body;
    } else if (type === 'IDAT') {
      // IDAT is allowed to be split across any number of chunks; the zlib
      // stream only makes sense once they are concatenated in order.
      idatParts.push(body);
    } else if (type === 'IEND') {
      break;
    }

    offset += 12 + length; // length + type + body + CRC
  }

  if (!header) throw new ImageError('That PNG has no header chunk.');
  if (!idatParts.length) throw new ImageError('That PNG has no image data.');

  return { ...header, palette, paletteAlpha, idat: concat(idatParts) };
}

async function decodePng(bytes: Uint8Array): Promise<PdfImage> {
  const png = readPngChunks(bytes);

  if (png.interlace !== 0) {
    throw new ImageError(
      'That PNG is interlaced. Re-save it without interlacing (sometimes called "progressive").',
    );
  }
  if (!png.width || !png.height) throw new ImageError('That PNG reports a zero size.');

  const channels = PNG_CHANNELS[png.colorType];
  if (channels === undefined) throw new ImageError('That PNG uses an unknown colour type.');

  const hasAlphaChannel = png.colorType === 4 || png.colorType === 6;
  const paletteIsTransparent = png.colorType === 3 && png.paletteAlpha !== undefined;

  // The common case: no transparency to pull out, so the compressed data goes
  // straight through and the reader undoes the PNG filtering via the predictor.
  if (!hasAlphaChannel && !paletteIsTransparent) {
    return {
      width: png.width,
      height: png.height,
      filter: 'FlateDecode',
      colorSpace: pngColorSpace(png),
      bitsPerComponent: png.bitDepth,
      data: png.idat,
      decodeParms:
        `<< /Predictor 15 /Colors ${png.colorType === 2 ? 3 : 1} ` +
        `/BitsPerComponent ${png.bitDepth} /Columns ${png.width} >>`,
    };
  }

  // Transparency. PDF has no interleaved alpha, so the channels have to be
  // separated, which means actually decoding the image.
  const raw = await inflate(png.idat);
  const pixels = unfilter(raw, png.width, png.height, channels, png.bitDepth);

  if (png.colorType === 3) {
    return paletteWithAlpha(png, pixels);
  }

  // Gray+alpha (2 channels) or RGBA (4). The colour channels are everything
  // but the last one.
  const colorChannels = channels - 1;
  const count = png.width * png.height;
  const color = new Uint8Array(count * colorChannels);
  const alpha = new Uint8Array(count);

  // 16-bit samples are reduced to 8. A logo does not need 16 bits, and
  // carrying them would double the file for no visible difference.
  const step = png.bitDepth === 16 ? 2 : 1;
  const stride = channels * step;

  for (let i = 0; i < count; i++) {
    const at = i * stride;
    for (let c = 0; c < colorChannels; c++) {
      color[i * colorChannels + c] = pixels[at + c * step]!;
    }
    alpha[i] = pixels[at + colorChannels * step]!;
  }

  return {
    width: png.width,
    height: png.height,
    filter: 'FlateDecode',
    colorSpace: colorChannels === 3 ? '/DeviceRGB' : '/DeviceGray',
    bitsPerComponent: 8,
    data: await deflate(color),
    smask: { width: png.width, height: png.height, data: await deflate(alpha) },
  };
}

/**
 * An indexed PNG with a tRNS table.
 *
 * Expanded to straight RGB plus a mask rather than kept indexed: a PDF
 * `/Indexed` space can carry the palette, but its transparency would still
 * need a separate mask built from the same table, and at logo sizes the
 * expansion costs little and removes a whole class of off-by-one.
 */
async function paletteWithAlpha(png: PngChunks, pixels: Uint8Array): Promise<PdfImage> {
  const palette = png.palette;
  if (!palette) throw new ImageError('That PNG is indexed but carries no palette.');
  if (png.bitDepth !== 8) {
    throw new ImageError(
      'That PNG uses a sub-8-bit indexed palette with transparency. Re-save it as a 32-bit PNG.',
    );
  }

  const count = png.width * png.height;
  const rgb = new Uint8Array(count * 3);
  const alpha = new Uint8Array(count);

  for (let i = 0; i < count; i++) {
    const index = pixels[i]!;
    rgb[i * 3] = palette[index * 3] ?? 0;
    rgb[i * 3 + 1] = palette[index * 3 + 1] ?? 0;
    rgb[i * 3 + 2] = palette[index * 3 + 2] ?? 0;
    // tRNS is allowed to be shorter than the palette; entries past its end
    // are fully opaque.
    alpha[i] = png.paletteAlpha?.[index] ?? 255;
  }

  return {
    width: png.width,
    height: png.height,
    filter: 'FlateDecode',
    colorSpace: '/DeviceRGB',
    bitsPerComponent: 8,
    data: await deflate(rgb),
    smask: { width: png.width, height: png.height, data: await deflate(alpha) },
  };
}

function pngColorSpace(png: PngChunks): string {
  if (png.colorType === 3) {
    const palette = png.palette;
    if (!palette) throw new ImageError('That PNG is indexed but carries no palette.');
    return `[/Indexed /DeviceRGB ${palette.length / 3 - 1} <${hex(palette)}>]`;
  }
  return png.colorType === 2 ? '/DeviceRGB' : '/DeviceGray';
}

// ---------------------------------------------------------------------------
// PNG filtering
// ---------------------------------------------------------------------------

/**
 * Undo the per-scanline filters.
 *
 * Every PNG scanline is prefixed with a filter byte saying how it was encoded
 * relative to the pixel to its left (`a`), the one above (`b`) and the one
 * above-left (`c`). This is the inverse, and it has to run in order because
 * each line is decoded against the line already decoded above it.
 */
function unfilter(
  raw: Uint8Array,
  width: number,
  height: number,
  channels: number,
  bitDepth: number,
): Uint8Array {
  const bytesPerPixel = Math.max(1, (channels * bitDepth) / 8);
  const bytesPerLine = Math.ceil((width * channels * bitDepth) / 8);
  const out = new Uint8Array(bytesPerLine * height);

  if (raw.length < (bytesPerLine + 1) * height) {
    throw new ImageError('That PNG is truncated — there is less data than its header promises.');
  }

  for (let row = 0; row < height; row++) {
    const filter = raw[row * (bytesPerLine + 1)]!;
    const from = row * (bytesPerLine + 1) + 1;
    const to = row * bytesPerLine;
    const above = to - bytesPerLine;

    for (let i = 0; i < bytesPerLine; i++) {
      const value = raw[from + i]!;
      const a = i >= bytesPerPixel ? out[to + i - bytesPerPixel]! : 0;
      const b = row > 0 ? out[above + i]! : 0;
      const c = row > 0 && i >= bytesPerPixel ? out[above + i - bytesPerPixel]! : 0;

      let restored: number;
      switch (filter) {
        case 0: restored = value; break;
        case 1: restored = value + a; break;
        case 2: restored = value + b; break;
        case 3: restored = value + ((a + b) >> 1); break;
        case 4: restored = value + paeth(a, b, c); break;
        default:
          throw new ImageError(`That PNG uses an unknown row filter (${filter}).`);
      }
      out[to + i] = restored & 0xff;
    }
  }

  return out;
}

/** The PNG Paeth predictor: whichever neighbour the gradient points at. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// ---------------------------------------------------------------------------
// zlib, via the platform
// ---------------------------------------------------------------------------

/** PNG's IDAT is a zlib stream, which is what `'deflate'` means here. */
export async function inflate(data: Uint8Array): Promise<Uint8Array> {
  return through(data, new DecompressionStream('deflate'));
}

export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  return through(data, new CompressionStream('deflate'));
}

async function through(
  data: Uint8Array,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  // Written and read concurrently: awaiting the write first would deadlock on
  // anything larger than the stream's internal buffer.
  // Copied into a fresh buffer: the stream wants an ArrayBuffer-backed view,
  // and a subarray of the uploaded file is not guaranteed to be one.
  const written = writer.write(new Uint8Array(data)).then(() => writer.close());
  const [buffer] = await Promise.all([
    new Response(transform.readable).arrayBuffer(),
    written,
  ]);
  return new Uint8Array(buffer);
}

// ---------------------------------------------------------------------------

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
