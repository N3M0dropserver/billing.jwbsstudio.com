/**
 * A minimal PDF writer.
 *
 * Why hand-rolled: every JS PDF library is either megabytes of WASM or pulls
 * in Node APIs that do not exist in a Worker. A tax invoice needs text, lines
 * and rectangles in one or two pages — that is a few hundred lines of the PDF
 * spec, and it costs nothing at runtime.
 *
 * Uses the base-14 fonts (Helvetica family), which every PDF reader has built
 * in, so nothing needs embedding. Text is WinAnsi-encoded.
 */

import type { PdfImage } from './image';

export type FontName = 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique';

export interface TextOptions {
  font?: FontName;
  size?: number;
  /** RGB 0..1 */
  color?: [number, number, number];
  align?: 'left' | 'right' | 'center';
  /** Right edge, required for right/center alignment. */
  width?: number;
}

/** Widths per 1000 units for Helvetica, indexed by character code 32..126. */
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const HELVETICA_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

export function measureText(text: string, size: number, font: FontName = 'Helvetica'): number {
  const widths = font === 'Helvetica-Bold' ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let total = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    total += code >= 32 && code <= 126 ? (widths[code - 32] ?? 556) : 556;
  }
  return (total * size) / 1000;
}

/** Break text to fit a column, respecting existing newlines. */
export function wrapText(
  text: string,
  maxWidth: number,
  size: number,
  font: FontName = 'Helvetica',
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.trim() === '') {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = current ? `${current} ${word}` : word;
      if (measureText(candidate, size, font) <= maxWidth) {
        current = candidate;
      } else {
        if (current) lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

/**
 * Macron support.
 *
 * WinAnsi has no macron vowels, so "Kōwhai" would otherwise render as
 * "K?whai" — unacceptable for invoices addressed to New Zealand clients.
 *
 * The fix is a /Differences encoding array that remaps a handful of codes
 * we will never need (Scaron, OE, Zcaron and friends) onto the Adobe glyph
 * names for macron vowels. Every Helvetica substitute a PDF reader ships
 * with — Arial, Liberation Sans, Nimbus Sans — carries these glyphs, so
 * nothing has to be embedded.
 */
const MACRON_CODES: Record<string, number> = {
  '\u0101': 129, // amacron
  '\u0113': 141, // emacron
  '\u012b': 143, // imacron
  '\u014d': 144, // omacron
  '\u016b': 157, // umacron
  '\u0100': 138, // Amacron
  '\u0112': 140, // Emacron
  '\u012a': 142, // Imacron
  '\u014c': 154, // Omacron
  '\u016a': 158, // Umacron
};

/** The /Differences array that gives the codes above their meaning. */
export const ENCODING_DIFFERENCES =
  '[129 /amacron 138 /Amacron 140 /Emacron 141 /emacron 142 /Imacron ' +
  '143 /imacron 144 /omacron 154 /Omacron 157 /umacron 158 /Umacron]';

/** Typography that has a sensible ASCII equivalent. */
const FALLBACKS: Record<string, string> = {
  '\u2018': "'", '\u2019': "'", '\u201a': ',',
  '\u201c': '"', '\u201d': '"',
  '\u2013': '-', '\u2014': '-', '\u2212': '-',
  '\u2026': '...', '\u00a0': ' ', '\u2009': ' ', '\u202f': ' ',
  '\u2022': '-', '\u2032': "'", '\u2033': '"',
};

/**
 * Escape a string for a PDF literal.
 *
 * Anything that cannot be represented becomes '?' rather than corrupting
 * the byte stream — a wrong character is recoverable, a broken xref is not.
 */
function escapeText(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.charCodeAt(0);

    if (char === '(' || char === ')' || char === '\\') {
      out += `\\${char}`;
      continue;
    }
    if (code >= 32 && code <= 126) {
      out += char;
      continue;
    }

    const macron = MACRON_CODES[char];
    if (macron !== undefined) {
      out += `\\${macron.toString(8).padStart(3, '0')}`;
      continue;
    }
    if (code >= 160 && code <= 255) {
      out += `\\${code.toString(8).padStart(3, '0')}`;
      continue;
    }

    const fallback = FALLBACKS[char];
    if (fallback !== undefined) {
      out += escapeText(fallback);
      continue;
    }

    // Decompose an accented character we cannot encode into its base letter
    // rather than losing it entirely.
    const decomposed = char.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    out += decomposed !== char && decomposed.length > 0 ? escapeText(decomposed) : '?';
  }
  return out;
}

interface Operation {
  content: string;
}

/**
 * An image registered on a document, ready to be placed on a page.
 *
 * Returned by `PdfDocument.addImage` rather than constructed: the name is the
 * document's to assign, and the same handle can be drawn on any number of
 * pages without the bytes being written more than once.
 */
export interface ImageHandle {
  /** The resource name, e.g. `Im0`. */
  name: string;
  width: number;
  height: number;
}

/**
 * Fit a box of `width`x`height` inside `maxWidth`x`maxHeight` without
 * distorting it.
 *
 * Logos arrive at whatever size the person had to hand — a 2000px-wide
 * export and a 64px favicon both have to end up looking deliberate — so
 * every layout places them through this rather than by hard-coded size.
 */
export function fitWithin(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(maxWidth / width, maxHeight / height);
  return { width: width * scale, height: height * scale };
}

export class PdfPage {
  private ops: Operation[] = [];

  constructor(
    public readonly width: number,
    public readonly height: number,
  ) {}

  /**
   * Draw a registered image, with the origin at the TOP-left like `text`.
   *
   * PDF draws an image by mapping the unit square through the current
   * transformation matrix, so the width and height are the matrix, and `q`/`Q`
   * keep that from leaking into whatever is drawn next.
   */
  image(handle: ImageHandle, x: number, y: number, width: number, height: number): this {
    if (width <= 0 || height <= 0) return this;
    this.ops.push({
      content: [
        'q',
        `${width.toFixed(2)} 0 0 ${height.toFixed(2)} ${x.toFixed(2)} ${(this.height - y - height).toFixed(2)} cm`,
        `/${handle.name} Do`,
        'Q',
      ].join('\n'),
    });
    return this;
  }

  /** Draw text with the origin at the TOP-left, which is how humans think. */
  text(value: string, x: number, y: number, options: TextOptions = {}): this {
    const { font = 'Helvetica', size = 10, color = [0, 0, 0], align = 'left', width } = options;

    let drawX = x;
    if (align !== 'left' && width !== undefined) {
      const measured = measureText(value, size, font);
      drawX = align === 'right' ? x + width - measured : x + (width - measured) / 2;
    }

    const pdfY = this.height - y;
    this.ops.push({
      content: [
        'BT',
        `/${font === 'Helvetica' ? 'F1' : font === 'Helvetica-Bold' ? 'F2' : 'F3'} ${size} Tf`,
        `${color[0]} ${color[1]} ${color[2]} rg`,
        `1 0 0 1 ${drawX.toFixed(2)} ${pdfY.toFixed(2)} Tm`,
        `(${escapeText(value)}) Tj`,
        'ET',
      ].join('\n'),
    });
    return this;
  }

  line(x1: number, y1: number, x2: number, y2: number, options: { width?: number; color?: [number, number, number] } = {}): this {
    const { width = 0.5, color = [0.8, 0.8, 0.8] } = options;
    this.ops.push({
      content: [
        `${color[0]} ${color[1]} ${color[2]} RG`,
        `${width} w`,
        `${x1.toFixed(2)} ${(this.height - y1).toFixed(2)} m`,
        `${x2.toFixed(2)} ${(this.height - y2).toFixed(2)} l`,
        'S',
      ].join('\n'),
    });
    return this;
  }

  rect(x: number, y: number, w: number, h: number, color: [number, number, number]): this {
    this.ops.push({
      content: [
        `${color[0]} ${color[1]} ${color[2]} rg`,
        `${x.toFixed(2)} ${(this.height - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re`,
        'f',
      ].join('\n'),
    });
    return this;
  }

  build(): string {
    return this.ops.map((op) => op.content).join('\n');
  }
}

export class PdfDocument {
  private pages: PdfPage[] = [];
  private images: Array<{ handle: ImageHandle; image: PdfImage }> = [];

  /** A4 in PDF points. */
  static readonly A4 = { width: 595.28, height: 841.89 };

  addPage(width = PdfDocument.A4.width, height = PdfDocument.A4.height): PdfPage {
    const page = new PdfPage(width, height);
    this.pages.push(page);
    return page;
  }

  /**
   * Register an image, once, and get back the handle pages draw it with.
   *
   * Decoding happens in `~/lib/pdf/image.ts` and is async; registration and
   * drawing are not, which is what keeps `renderInvoicePdf` synchronous and
   * trivial to test.
   */
  addImage(image: PdfImage): ImageHandle {
    const handle: ImageHandle = {
      name: `Im${this.images.length}`,
      width: image.width,
      height: image.height,
    };
    this.images.push({ handle, image });
    return handle;
  }

  /**
   * Serialise to a PDF byte stream.
   *
   * Object ids are handed out as objects are written rather than computed from
   * fixed positions — images made the arithmetic version untenable, since the
   * count is no longer known before the document is walked.
   */
  build(meta: { title?: string; author?: string } = {}): Uint8Array {
    /** Objects by id. Index 0 is the free head and is never written. */
    const objects: string[] = [''];
    const reserve = () => objects.push('') - 1;
    const put = (id: number, body: string) => {
      objects[id] = body;
    };

    const catalogId = reserve();
    const pagesId = reserve();
    const encodingId = reserve();
    const fontIds = { F1: reserve(), F2: reserve(), F3: reserve() };

    put(encodingId, `<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences ${ENCODING_DIFFERENCES} >>`);
    put(fontIds.F1, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding ${encodingId} 0 R >>`);
    put(fontIds.F2, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding ${encodingId} 0 R >>`);
    put(fontIds.F3, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding ${encodingId} 0 R >>`);

    // Images, and the soft masks that carry their transparency.
    const imageRefs: string[] = [];
    for (const { handle, image } of this.images) {
      let smaskRef = '';
      if (image.smask) {
        const smaskId = reserve();
        put(
          smaskId,
          stream(
            `<< /Type /XObject /Subtype /Image /Width ${image.smask.width} /Height ${image.smask.height} ` +
              `/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode ` +
              `/Length ${image.smask.data.length} >>`,
            image.smask.data,
          ),
        );
        smaskRef = ` /SMask ${smaskId} 0 R`;
      }

      const imageId = reserve();
      put(
        imageId,
        stream(
          `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
            `/ColorSpace ${image.colorSpace} /BitsPerComponent ${image.bitsPerComponent} ` +
            `/Filter /${image.filter}` +
            (image.decodeParms ? ` /DecodeParms ${image.decodeParms}` : '') +
            (image.decode ? ` /Decode ${image.decode}` : '') +
            `${smaskRef} /Length ${image.data.length} >>`,
          image.data,
        ),
      );
      imageRefs.push(`/${handle.name} ${imageId} 0 R`);
    }

    const xobjects = imageRefs.length ? ` /XObject << ${imageRefs.join(' ')} >>` : '';

    const pageIds: number[] = [];
    for (const page of this.pages) {
      const pageId = reserve();
      const contentId = reserve();
      pageIds.push(pageId);

      const content = page.build();
      put(
        pageId,
        `<< /Type /Page /Parent ${pagesId} 0 R ` +
          `/MediaBox [0 0 ${page.width.toFixed(2)} ${page.height.toFixed(2)}] ` +
          `/Resources << /Font << /F1 ${fontIds.F1} 0 R /F2 ${fontIds.F2} 0 R /F3 ${fontIds.F3} 0 R >>` +
          `${xobjects} >> /Contents ${contentId} 0 R >>`,
      );
      put(contentId, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    }

    put(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    put(
      pagesId,
      `<< /Type /Pages /Count ${this.pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`,
    );

    const infoId = reserve();
    put(
      infoId,
      `<< /Title (${escapeText(meta.title ?? 'Invoice')}) /Producer (JWBS Billing) ` +
        `/Author (${escapeText(meta.author ?? '')}) /CreationDate (D:${pdfDate(new Date())}) >>`,
    );

    // Assemble the file, recording each object's byte offset for the xref.
    let output = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    const offsets: number[] = [];

    for (let i = 1; i < objects.length; i++) {
      const body = objects[i];
      if (!body) continue;
      offsets[i] = byteLength(output);
      output += `${i} 0 obj\n${body}\nendobj\n`;
    }

    const xrefOffset = byteLength(output);
    const maxId = objects.length;

    output += `xref\n0 ${maxId}\n0000000000 65535 f \n`;
    for (let i = 1; i < maxId; i++) {
      const offset = offsets[i];
      output +=
        offset === undefined
          ? '0000000000 65535 f \n'
          : `${String(offset).padStart(10, '0')} 00000 n \n`;
    }

    output += `trailer\n<< /Size ${maxId} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

    return latin1Bytes(output);
  }
}

/**
 * A stream object whose payload is binary.
 *
 * The whole file is assembled as a latin-1 string — one char per byte — so
 * image data joins it the same way rather than needing a separate byte path.
 */
function stream(dict: string, data: Uint8Array): string {
  let payload = '';
  // Chunked: `String.fromCharCode(...bytes)` blows the argument limit on
  // anything bigger than a thumbnail.
  for (let i = 0; i < data.length; i += 8192) {
    payload += String.fromCharCode(...data.subarray(i, i + 8192));
  }
  return `${dict}\nstream\n${payload}\nendstream`;
}

function pdfDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/**
 * The PDF body is treated as latin-1: every char in the string is one byte.
 * `TextEncoder` would UTF-8 encode and break the byte offsets in the xref.
 */
function latin1Bytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i) & 0xff;
  return bytes;
}

function byteLength(value: string): number {
  return value.length;
}
