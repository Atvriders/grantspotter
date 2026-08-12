import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSpaMiddleware } from '../api/spa.js';

/**
 * THE BROWSER ICON: its geometry, its two raster forms, and the production path that serves them.
 *
 * WHY A TEST OWNS THE RASTERISER. `packages/web/public/favicon.ico` and `apple-touch-icon.png` are
 * binary files in a public repository, and a binary nobody can re-derive is a binary nobody can
 * review. Everything needed to produce them byte-for-byte is in this file: the geometry is PARSED
 * OUT OF favicon.svg (so the vector and the rasters cannot drift apart — there is one set of
 * numbers, in the SVG), rasterised by supersampling five rounded rectangles, and encoded with
 * node:zlib. No dependency, no image library, no downloaded blob.
 *
 * TO REGENERATE after editing favicon.svg:
 *
 *     GS_WRITE_ICONS=1 npx vitest run packages/server/src/deploy/appIcons.test.ts
 *
 * Without that variable the same code runs and the committed files are asserted PIXEL-BY-PIXEL
 * against a fresh render, so a hand-edited or stale icon fails. The comparison is on decoded
 * pixels, not on file bytes, because zlib's output is not guaranteed stable across Node versions
 * and a test that fails on a Node upgrade teaches people to delete tests.
 *
 * WHY THIS FILE IS IN packages/server. It asserts the production serving path — the icon has to
 * survive `vite build`, the image, and createSpaMiddleware — and `packages/web` may not import
 * from `packages/server` (the import direction is web -> core, server -> core). Its neighbour
 * `dockerfile.test.ts` reads the same repository root for the same reason.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const WEB_DIR = resolve(REPO_ROOT, 'packages', 'web');
const PUBLIC_DIR = resolve(WEB_DIR, 'public');
const SVG_PATH = resolve(PUBLIC_DIR, 'favicon.svg');
const ICO_PATH = resolve(PUBLIC_DIR, 'favicon.ico');
const APPLE_PATH = resolve(PUBLIC_DIR, 'apple-touch-icon.png');

/** The sizes carried in favicon.ico. 16 is the tab, 32 the bookmark bar, 48 the Windows shortcut. */
const ICO_SIZES = [16, 32, 48] as const;

/**
 * 180 is the size current iOS asks for; anything larger it downsamples itself. Rendered with a
 * SQUARE plate rather than the rounded one — iOS applies its own squircle mask and discards what
 * falls outside it, so shipping our own rounded corners would leave four transparent notches that
 * iOS composites against black.
 */
const APPLE_SIZE = 180;

// ---------------------------------------------------------------------------
// geometry, read out of the SVG
// ---------------------------------------------------------------------------

interface RoundRect {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  fill: string;
}

/**
 * The SVG is five `<rect>` elements and nothing else, which is what makes parsing it with a
 * regular expression honest rather than the usual mistake: there is no nesting, no transform, no
 * inherited fill and no path data. `viewBoxIs32` below fails if that ever stops being true.
 */
function parseRects(svgText: string): RoundRect[] {
  const withoutComments = svgText.replace(/<!--[\s\S]*?-->/g, '');
  const rects: RoundRect[] = [];
  for (const match of withoutComments.matchAll(/<rect\b([^>]*)\/>/g)) {
    const attrs = match[1] ?? '';
    const num = (name: string, fallback: number): number => {
      const found = new RegExp(`\\b${name}="(-?[0-9.]+)"`).exec(attrs);
      return found === null ? fallback : Number(found[1]);
    };
    const fill = /\bfill="(#[0-9a-f]{6})"/.exec(attrs);
    if (fill === null) throw new Error(`<rect> without a literal hex fill: ${attrs}`);
    rects.push({
      x: num('x', 0),
      y: num('y', 0),
      w: num('width', 0),
      h: num('height', 0),
      // SVG clamps rx to half the width and half the height. Every rect here is at or below both,
      // so the clamp never fires and the rasteriser below can use r as written.
      r: num('rx', 0),
      fill: fill[1] as string,
    });
  }
  return rects;
}

const SVG_TEXT = readFileSync(SVG_PATH, 'utf8');
const RECTS = parseRects(SVG_TEXT);

/**
 * The geometry as it is meant to be, so that an edit to the SVG is a deliberate act and not a
 * silently regenerated icon. Sizes are in the 32-unit viewBox.
 *
 *   plate    the accent token, full bleed, r=7 (21.9%, the platform squircle proportion)
 *   noise    three blips on a floor at y=26.5, heights 7 / 5.5 / 6 — ragged on purpose, because a
 *            monotone ramp reads as a signal-strength meter and equal heights read as a bar chart
 *   carrier  one bin 21 units tall, third of four, in the palette's amber
 *
 * Bins are 4 wide on a 6.5 pitch: at 16px that is a 2px bar with a 1.25px gutter, which is the
 * narrowest pair that stays two shapes instead of one grey smear.
 */
const EXPECTED_RECTS: RoundRect[] = [
  { x: 0, y: 0, w: 32, h: 32, r: 7, fill: '#0f6f7a' },
  { x: 4.25, y: 19.5, w: 4, h: 7, r: 2, fill: '#f7f8fa' },
  { x: 10.75, y: 21, w: 4, h: 5.5, r: 2, fill: '#f7f8fa' },
  { x: 17.25, y: 5.5, w: 4, h: 21, r: 2, fill: '#e5b567' },
  { x: 23.75, y: 20.5, w: 4, h: 6, r: 2, fill: '#f7f8fa' },
];

// ---------------------------------------------------------------------------
// rasteriser: five rounded rectangles, box-filtered
// ---------------------------------------------------------------------------

/** Sub-samples per axis. 64 samples a pixel gives 65 coverage levels — more than 8-bit alpha needs. */
const SUPERSAMPLE = 8;

function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * Signed distance to a rounded rectangle, negative inside. This is the same shape SVG draws for
 * `<rect rx>`, which is why one set of numbers can serve both renderers.
 */
function insideRoundRect(px: number, py: number, box: RoundRect): boolean {
  const halfW = box.w / 2;
  const halfH = box.h / 2;
  const dx = Math.abs(px - (box.x + halfW)) - (halfW - box.r);
  const dy = Math.abs(py - (box.y + halfH)) - (halfH - box.r);
  const outX = Math.max(dx, 0);
  const outY = Math.max(dy, 0);
  const distance = Math.min(Math.max(dx, dy), 0) + Math.sqrt(outX * outX + outY * outY) - box.r;
  return distance <= 0;
}

/**
 * Render to straight-alpha RGBA. Each sub-sample takes the colour of the topmost rect it falls in;
 * a pixel is the mean of its 64 sub-samples. Averaging the covered sub-samples' colours and
 * carrying coverage as alpha is exactly area sampling of an opaque stack, so no premultiplied
 * round trip is needed.
 */
function rasterize(size: number, rects: RoundRect[]): Uint8Array {
  const colors = rects.map((rect) => hexToRgb(rect.fill));
  const out = new Uint8Array(size * size * 4);
  const scale = 32 / size;
  const step = 1 / SUPERSAMPLE;
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let covered = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        const v = (py + (sy + 0.5) * step) * scale;
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const u = (px + (sx + 0.5) * step) * scale;
          for (let i = rects.length - 1; i >= 0; i -= 1) {
            const rect = rects[i] as RoundRect;
            if (!insideRoundRect(u, v, rect)) continue;
            const color = colors[i] as [number, number, number];
            sumR += color[0];
            sumG += color[1];
            sumB += color[2];
            covered += 1;
            break;
          }
        }
      }
      const at = (py * size + px) * 4;
      if (covered === 0) continue;
      out[at] = Math.round(sumR / covered);
      out[at + 1] = Math.round(sumG / covered);
      out[at + 2] = Math.round(sumB / covered);
      out[at + 3] = Math.round((covered / samples) * 255);
    }
  }
  return out;
}

/** The apple-touch variant: same mark, square plate. See APPLE_SIZE. */
function appleRects(rects: RoundRect[]): RoundRect[] {
  return rects.map((rect, index) => (index === 0 ? { ...rect, r: 0 } : rect));
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** 8-bit RGBA, no interlace, filter 0 on every scanline. */
function encodePng(rgba: Uint8Array, size: number): Buffer {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

interface DecodedPng {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/**
 * A real decoder, not a mirror of the encoder above: it verifies every chunk CRC and implements
 * all five PNG filters. That matters because the point of decoding is to check what is COMMITTED,
 * and a decoder that only understands its own output could not tell a foreign file from a good one.
 */
function decodePng(buffer: Buffer): DecodedPng {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const declared = buffer.readUInt32BE(offset + 8 + length);
    const actual = crc32(buffer.subarray(offset + 4, offset + 8 + length));
    if (declared !== actual) throw new Error(`CRC mismatch in ${type}`);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6) throw new Error('expected 8-bit RGBA');
      if (data[12] !== 0) throw new Error('interlaced PNGs are not supported here');
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] as number;
    for (let i = 0; i < stride; i += 1) {
      const value = raw[y * (stride + 1) + 1 + i] as number;
      const left = i >= 4 ? (rgba[y * stride + i - 4] as number) : 0;
      const up = y > 0 ? (rgba[(y - 1) * stride + i] as number) : 0;
      const upLeft = y > 0 && i >= 4 ? (rgba[(y - 1) * stride + i - 4] as number) : 0;
      let restored: number;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + Math.floor((left + up) / 2);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          restored = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default:
          throw new Error(`unknown PNG filter ${String(filter)}`);
      }
      rgba[y * stride + i] = restored & 0xff;
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// ICO
// ---------------------------------------------------------------------------

/**
 * PNG-compressed entries rather than the older BMP/DIB ones. Every browser released this century
 * reads PNG-in-ICO, the file is 3 KB instead of 58 KB, and — the reason that decided it — a DIB
 * entry carries a separate 1-bit AND mask, so the anti-aliased corners of the plate would have to
 * be quantised to a hard edge. The claim was not taken on trust: the committed file was loaded as
 * a tab icon in Chromium and photographed for this change.
 */
function encodeIco(pngs: readonly Buffer[], sizes: readonly number[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(pngs.length, 4);
  const directory = Buffer.alloc(16 * pngs.length);
  let offset = header.length + directory.length;
  pngs.forEach((png, index) => {
    const at = index * 16;
    const size = sizes[index] as number;
    directory[at] = size === 256 ? 0 : size;
    directory[at + 1] = size === 256 ? 0 : size;
    directory[at + 2] = 0; // palette size: none
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...pngs]);
}

interface IcoEntry {
  width: number;
  height: number;
  payload: Buffer;
}

function parseIco(buffer: Buffer): IcoEntry[] {
  if (buffer.readUInt16LE(0) !== 0) throw new Error('ICO reserved field is not zero');
  if (buffer.readUInt16LE(2) !== 1) throw new Error('not an icon resource');
  const count = buffer.readUInt16LE(4);
  const entries: IcoEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 16;
    const size = buffer.readUInt32LE(at + 8);
    const offset = buffer.readUInt32LE(at + 12);
    entries.push({
      width: buffer[at] === 0 ? 256 : (buffer[at] as number),
      height: buffer[at + 1] === 0 ? 256 : (buffer[at + 1] as number),
      payload: buffer.subarray(offset, offset + size),
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// contrast
// ---------------------------------------------------------------------------

function relativeLuminance(hex: string): number {
  const channels = hexToRgb(hex).map((value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * (channels[0] as number) +
    0.7152 * (channels[1] as number) +
    0.0722 * (channels[2] as number)
  );
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ---------------------------------------------------------------------------
// generate / verify
// ---------------------------------------------------------------------------

const icoPngs = ICO_SIZES.map((size) => encodePng(rasterize(size, RECTS), size));
const applePng = encodePng(rasterize(APPLE_SIZE, appleRects(RECTS)), APPLE_SIZE);

if (process.env['GS_WRITE_ICONS'] === '1') {
  writeFileSync(ICO_PATH, encodeIco(icoPngs, ICO_SIZES));
  writeFileSync(APPLE_PATH, applePng);
}

describe('favicon.svg is the geometry of record', () => {
  it('is five rounded rectangles in a 32-unit viewBox and nothing else', () => {
    expect(SVG_TEXT).toContain('viewBox="0 0 32 32"');
    // Anything the parser cannot see — a <path>, a <g fill>, a transform, a <style> — would make
    // the vector and the rasters two different pictures.
    const drawn = SVG_TEXT.replace(/<!--[\s\S]*?-->/g, '').match(/<(?!\/|\?|!)([a-z]+)/g) ?? [];
    expect(drawn.sort()).toEqual(['<rect', '<rect', '<rect', '<rect', '<rect', '<svg', '<title']);
  });

  it('draws the mark this project decided on', () => {
    expect(RECTS).toEqual(EXPECTED_RECTS);
  });

  it('references nothing off-origin, so no CSP or offline load can break it', () => {
    expect(SVG_TEXT).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
    expect(SVG_TEXT).not.toMatch(/<script|<image|url\(/i);
  });

  it('keeps every bin inside the plate, corners included', () => {
    const plate = RECTS[0] as RoundRect;
    for (const bin of RECTS.slice(1)) {
      for (const [x, y] of [
        [bin.x, bin.y],
        [bin.x + bin.w, bin.y],
        [bin.x, bin.y + bin.h],
        [bin.x + bin.w, bin.y + bin.h],
      ] as const) {
        expect(insideRoundRect(x, y, plate)).toBe(true);
      }
    }
  });
});

/**
 * THE COLOUR ARGUMENT, WITH THE NUMBERS, because the brief for this icon asked for a mark that
 * works on a light AND a dark tab strip and these are the figures that decide whether it does.
 *
 * Chromium paints its tab strip #dee1e6 in the light theme and #202124 in the dark one (the active
 * tab is #ffffff and roughly #35363a). Four constraints pull against each other:
 *
 *      plate vs light strip   4.48:1      ink vs plate       5.53:1
 *      plate vs dark strip    2.74:1      carrier vs plate   3.12:1
 *      plate vs dark tab      2.05:1      carrier vs ink     1.77:1
 *
 * A plate can clear 3:1 against BOTH strips only if its relative luminance lands in [0.146,
 * 0.217]; #0f6f7a is 0.129, just under. #127d8a is in that band and was tried — it takes the dark
 * strip to 3.32:1 and drops the carrier to 2.57:1, i.e. it buys "you can find the tab" with "you
 * cannot read the mark once you have". The dark theme's own accent #3fb6c0 is better still against
 * dark chrome (6.64:1) but cannot host the amber at all (1.29:1), so it would need the mark drawn
 * in a second palette.
 *
 * AND A MEDIA QUERY WOULD NOT RESCUE THAT, WHICH WAS MEASURED RATHER THAN ASSUMED. The received
 * wisdom is that `prefers-color-scheme` inside an SVG favicon is unreliable, so it was tested:
 * an otherwise identical favicon whose plate turns magenta under the query was loaded in
 * Chrome for Testing 151.0.7922.34 with --force-dark-mode, and the tab went magenta. It works.
 * The reason this icon does not use one is therefore not support, it is that favicon.ico and
 * apple-touch-icon.png are rasters and cannot follow: a dark-adapted SVG would leave the same
 * machine showing two different icons — the SVG in the tab, the ICO on the Windows shortcut and
 * in the browsers that ignore SVG icons.
 *
 * So: one plate, the product's real accent token, weakest at 2.05:1 on an active dark tab, and
 * plainly legible there in the screenshots taken for this change. 3:1 is SC 1.4.11's floor for UI
 * components a user must operate; a favicon is not one, and the mark inside the plate — the part
 * that carries the identity — clears it. The trade is written down because the next person to
 * "fix" the dark-mode contrast will reach for #3fb6c0 and should see what it costs first.
 */
describe('icon colours', () => {
  const [plate, ink, carrier] = ['#0f6f7a', '#f7f8fa', '#e5b567'];

  it('uses the product palette, not invented colours', () => {
    const tokens = readFileSync(resolve(WEB_DIR, 'src', 'styles', 'tokens.css'), 'utf8');
    // --accent (light), --bg (light) and --warn (dark) respectively.
    for (const color of [plate, ink, carrier]) expect(tokens).toContain(color);
  });

  it('keeps the mark legible on the plate', () => {
    expect(contrastRatio(ink, plate)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(carrier, plate)).toBeGreaterThanOrEqual(3);
  });

  it('stays visible on both tab strips Chromium paints', () => {
    expect(contrastRatio(plate, '#dee1e6')).toBeGreaterThanOrEqual(3);
    // Deliberately below 3 — see the block comment above for what buying that back would cost.
    expect(contrastRatio(plate, '#202124')).toBeGreaterThanOrEqual(2.5);
    expect(contrastRatio(plate, '#35363a')).toBeGreaterThanOrEqual(2);
  });
});

describe('favicon.ico', () => {
  it('exists and is a well-formed icon directory of 16, 32 and 48', () => {
    expect(existsSync(ICO_PATH)).toBe(true);
    const entries = parseIco(readFileSync(ICO_PATH));
    expect(entries.map((entry) => entry.width)).toEqual([...ICO_SIZES]);
    expect(entries.map((entry) => entry.height)).toEqual([...ICO_SIZES]);
  });

  it('shows exactly what favicon.svg draws, at every size it carries', () => {
    const entries = parseIco(readFileSync(ICO_PATH));
    entries.forEach((entry, index) => {
      const size = ICO_SIZES[index] as number;
      const decoded = decodePng(entry.payload);
      expect(decoded.width).toBe(size);
      expect(decoded.height).toBe(size);
      expect(Buffer.from(decoded.rgba)).toEqual(Buffer.from(rasterize(size, RECTS)));
    });
  });

  it('is small enough to be a favicon', () => {
    expect(readFileSync(ICO_PATH).length).toBeLessThan(10_000);
  });
});

describe('apple-touch-icon.png', () => {
  it('is 180x180 and fully opaque, because iOS masks it and composites on black', () => {
    const decoded = decodePng(readFileSync(APPLE_PATH));
    expect(decoded.width).toBe(APPLE_SIZE);
    expect(decoded.height).toBe(APPLE_SIZE);
    let transparent = 0;
    for (let at = 3; at < decoded.rgba.length; at += 4) {
      if (decoded.rgba[at] !== 255) transparent += 1;
    }
    expect(transparent).toBe(0);
  });

  it('shows exactly what favicon.svg draws, with the plate squared off', () => {
    const decoded = decodePng(readFileSync(APPLE_PATH));
    expect(Buffer.from(decoded.rgba)).toEqual(
      Buffer.from(rasterize(APPLE_SIZE, appleRects(RECTS))),
    );
  });
});

describe('index.html', () => {
  const html = readFileSync(resolve(WEB_DIR, 'index.html'), 'utf8');

  it('links all three forms', () => {
    expect(html).toMatch(/<link rel="icon" href="\/favicon\.ico" sizes="32x32"/);
    expect(html).toMatch(/<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml"/);
    expect(html).toMatch(/<link rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
  });

  it('uses root-absolute hrefs, because every client-side route serves this same shell', () => {
    // A relative `href="favicon.svg"` resolves against the current URL, so it would 404 on
    // /o/<slug> and on /browse — every page except the root — and the browser would fall back to
    // whatever /favicon.ico happens to be.
    for (const href of [...(html.matchAll(/rel="(?:icon|apple-touch-icon)" href="([^"]+)"/g))]) {
      expect(href[1]).toMatch(/^\//);
    }
  });
});

describe('the production path', () => {
  it('leaves Vite copying packages/web/public into the bundle', () => {
    // `publicDir: false` — or a publicDir pointed anywhere else — silently stops shipping every
    // file in this directory, and the only symptom is a 404 in production.
    const viteConfig = readFileSync(resolve(WEB_DIR, 'vite.config.ts'), 'utf8');
    expect(viteConfig).not.toMatch(/publicDir\s*:/);
    expect(existsSync(resolve(PUBLIC_DIR, 'favicon.svg'))).toBe(true);
  });

  it('carries the icons into the image', () => {
    // The build stage is `COPY . .`, so packages/web/public rides along unless .dockerignore
    // excludes it; `vite build` then writes it into packages/web/dist, which the runtime stage
    // copies. Nothing in the Dockerfile names the icons, and nothing should.
    const excluded = readFileSync(resolve(REPO_ROOT, '.dockerignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    expect(excluded.filter((pattern) => pattern.includes('public'))).toEqual([]);
    expect(readFileSync(resolve(REPO_ROOT, 'Dockerfile'), 'utf8')).toMatch(/^COPY \. \.$/m);
  });
});

describe('createSpaMiddleware serves the icons, and never the shell in their place', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    // A stand-in for `vite build`'s output: the shell at the root with the public directory's
    // files beside it, which is exactly the layout Vite produces and the image ships.
    const dist = mkdtempSync(join(tmpdir(), 'gs-icons-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>', 'utf8');
    for (const name of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png']) {
      copyFileSync(resolve(PUBLIC_DIR, name), join(dist, name));
    }
    const app = express();
    app.use(createSpaMiddleware(dist));
    await new Promise<void>((done) => {
      server = app.listen(0, '127.0.0.1', done);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  // `image/x-icon` is what this express's mime table returns for .ico — the older of the two
  // registered spellings, and the one every browser has always accepted. Asserted as measured
  // rather than as the IANA name `image/vnd.microsoft.icon`, which is what a guess would have
  // written and which this stack does not send.
  it.each([
    ['/favicon.ico', 'image/x-icon'],
    ['/favicon.svg', 'image/svg+xml'],
    ['/apple-touch-icon.png', 'image/png'],
  ])('serves %s as %s', async (path, type) => {
    const res = await fetch(`${base}${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain(type);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body).toEqual(readFileSync(resolve(PUBLIC_DIR, path.slice(1))));
    // The failure this whole file exists to prevent: the SPA fallback answers ANY unclaimed GET
    // with index.html and a 200, so a missing icon does not 404 — it arrives as HTML, and the
    // browser shows the default page glyph while every check for "did it 404" says no.
    expect(body.includes('<div id="root">')).toBe(false);
  });
});
