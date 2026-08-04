// Generates icons/icon{16,48,128}.png.
//
// Chrome will not take an SVG for an extension icon, and committing opaque
// binaries you cannot diff is worse than committing the 90 lines that produce
// them. Run with: node tools/make-icons.js
//
// The mark is a two-way arrow — the conversion, not the currency, because a ₪
// rendered without a font rasteriser at 16px is a smudge.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BG = [0x10, 0x20, 0x2c];
const FG = [0x00, 0xe7, 0x01];
const SAMPLES = 4; // per axis; 16 sub-samples per pixel is plenty of antialiasing

// ------------------------------------------------------------------ geometry

const inRoundedRect = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  if (x >= r && x <= 1 - r) return y >= 0 && y <= 1;
  if (y >= r && y <= 1 - r) return x >= 0 && x <= 1;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

const inRect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

/** Isosceles triangle with its base at `baseX` (half-height `half`) and apex at `tipX`. */
const inArrowHead = (x, y, baseX, tipX, cy, half) => {
  const span = tipX - baseX;
  const t = (x - baseX) / span;
  if (t < 0 || t > 1) return false;
  return Math.abs(y - cy) <= half * (1 - t);
};

function arrow(x, y, { cy, shaft, head, dir }) {
  const [sx0, sx1] = dir > 0 ? [shaft[0], shaft[1]] : [shaft[1], shaft[0]];
  const lo = Math.min(sx0, sx1);
  const hi = Math.max(sx0, sx1);
  if (inRect(x, y, lo, cy - 0.038, hi, cy + 0.038)) return true;
  return inArrowHead(x, y, head[0], head[1], cy, 0.125);
}

const TOP = { cy: 0.355, shaft: [0.19, 0.66], head: [0.60, 0.83], dir: 1 };
const BOTTOM = { cy: 0.645, shaft: [0.34, 0.81], head: [0.40, 0.17], dir: -1 };

// -------------------------------------------------------------------- render

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = 0.22;
  const step = 1 / (size * SAMPLES);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHits = 0;
      let fgHits = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px * SAMPLES + sx + 0.5) * step;
          const y = (py * SAMPLES + sy + 0.5) * step;
          if (!inRoundedRect(x, y, radius)) continue;
          bgHits++;
          if (arrow(x, y, TOP) || arrow(x, y, BOTTOM)) fgHits++;
        }
      }

      const total = SAMPLES * SAMPLES;
      const alpha = bgHits / total;
      const mix = bgHits ? fgHits / bgHits : 0;

      const offset = (py * size + px) * 4;
      for (let channel = 0; channel < 3; channel++) {
        pixels[offset + channel] = Math.round(BG[channel] * (1 - mix) + FG[channel] * mix);
      }
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }

  return pixels;
}

// ----------------------------------------------------------------- PNG output

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  // One filter byte (0 = None) per scanline, ahead of the row's pixels.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [16, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, encodePng(size, render(size)));
  console.log(`wrote ${file}`);
}
