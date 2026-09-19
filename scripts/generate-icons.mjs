/**
 * Generates the PNG app icons from the favicon's geometry.
 *
 * Phones need PNGs to install the technician app — iOS reads only a PNG
 * apple-touch-icon, and Android wants 192px and 512px icons in the manifest.
 * The mark is three strokes on a teal square, simple enough to draw directly,
 * so this renders it with no image library: each pixel's coverage is its
 * distance from the nearest stroke, which also gives smooth anti-aliased edges.
 *
 *   node scripts/generate-icons.mjs
 *
 * Writes into client/public/icons/. Re-run after changing the geometry below.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'client', 'public', 'icons');

/* The favicon, in its own 32-unit coordinate space (client/public/favicon.svg). */
const TEAL = [0x0f, 0x76, 0x6e];
const WHITE = [0xff, 0xff, 0xff];
const STROKE_WIDTH = 2.4;
const STROKES = [
  [16, 6, 16, 26],
  [7.3, 11, 24.7, 21],
  [7.3, 21, 24.7, 11],
];

/* ---- Geometry ---------------------------------------------------------- */

function distanceToSegment(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Signed distance to a rounded square filling the canvas; negative inside. */
function distanceToRoundedSquare(px, py, size, radius) {
  const half = size / 2;
  const qx = Math.abs(px - half) - (half - radius);
  const qy = Math.abs(py - half) - (half - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

const clamp01 = (value) => Math.max(0, Math.min(1, value));

/**
 * Renders the icon as RGBA.
 *
 * `maskable` icons fill the whole square: the phone cuts its own shape out of
 * them, and the mark sits well inside the 80% safe zone Android guarantees.
 * Regular icons get the favicon's rounded corners on a transparent ground.
 */
function render(size, { maskable }) {
  const pixels = Buffer.alloc(size * size * 4);
  const unit = size / 32;
  /* A maskable icon is cropped, so its mark is drawn a little smaller to keep
     clear of the crop on circular launchers. */
  const markScale = maskable ? 0.8 : 1;
  const halfStroke = (STROKE_WIDTH / 2) * unit * markScale;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;

      const shape = maskable ? 1 : clamp01(0.5 - distanceToRoundedSquare(px, py, size, 8 * unit));

      /* Back into the 32-unit space, scaled about the centre. */
      const ux = 16 + (px / unit - 16) / markScale;
      const uy = 16 + (py / unit - 16) / markScale;
      const nearest = Math.min(...STROKES.map((stroke) => distanceToSegment(ux, uy, stroke)));
      const ink = clamp01(halfStroke + 0.5 - nearest * unit * markScale);

      const offset = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[offset + channel] = Math.round(TEAL[channel] * (1 - ink) + WHITE[channel] * ink);
      }
      pixels[offset + 3] = Math.round(shape * 255);
    }
  }

  return pixels;
}

/* ---- PNG encoding ------------------------------------------------------ */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; /* bit depth */
  header[9] = 6; /* colour type: RGBA */

  /* Each scanline is prefixed with filter type 0 (none). */
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---- Output ------------------------------------------------------------ */

const ICONS = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  /* iOS rounds the corners itself and shows transparency as black. */
  { file: 'apple-touch-icon.png', size: 180, maskable: true },
];

mkdirSync(outDir, { recursive: true });

for (const icon of ICONS) {
  const png = encodePng(icon.size, render(icon.size, icon));
  writeFileSync(path.join(outDir, icon.file), png);
  console.log(`wrote client/public/icons/${icon.file} (${(png.length / 1024).toFixed(1)} KB)`);
}
