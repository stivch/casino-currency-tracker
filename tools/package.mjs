// Build the store-ready zip. Run with: node tools/package.mjs
//
// No dependencies, which is the same property the extension itself has: the
// zip format is simple enough that writing it here beats requiring everyone
// who packages a release to have installed something first. Compression is
// zlib's raw deflate, which node ships with.
//
// Only what the extension needs at runtime goes in — manifest, source,
// locales, icons, licence. Tools, plans and the README are for the repo.

import { deflateRawSync } from 'node:zlib';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const INCLUDE = ['manifest.json', 'LICENSE', '_locales', 'icons', 'src'];

function* walk(path) {
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path).sort()) yield* walk(join(path, name));
  } else {
    yield path;
  }
}

// ------------------------------------------------------------------ zip bits

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A fixed timestamp (2026-01-01 00:00) rather than the build machine's clock,
 * so packaging the same tree twice produces byte-identical zips — the property
 * that lets a reviewer diff two releases and trust the diff.
 */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    // Deflate can lose to tiny or already-compressed files (the PNGs); store those.
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, ...centrals, end]);
}

// ---------------------------------------------------------------------- main

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

const entries = [];
for (const top of INCLUDE) {
  for (const file of walk(join(root, top))) {
    // Forward slashes regardless of platform: backslash entry names produce a
    // zip that unpacks flat on everything that is not Windows.
    entries.push({ name: relative(root, file).replaceAll('\\', '/'), data: readFileSync(file) });
  }
}

const out = join(root, 'dist', `casino-currency-tracker-${manifest.version}.zip`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, zip(entries));

const kb = (statSync(out).size / 1024).toFixed(0);
console.log(`${relative(root, out)} — ${entries.length} files, ${kb} KB`);
