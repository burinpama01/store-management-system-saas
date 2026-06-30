#!/usr/bin/env node
// Packages the StoreOS Print Hub install kit into a downloadable zip served
// from the app at /downloads/storeos-print-hub.zip. Zero dependencies (writes a
// STORED zip) so it runs on any platform. Re-run after changing any kit file:
//   npm run build:print-hub-zip

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const outDir = join(root, "public", "downloads");
const outFile = join(outDir, "storeos-print-hub.zip");

// Archive path (inside zip) -> source path on disk.
const kit = join(here, "print-hub");
const entries = [
  // Top-level double-click helpers (what a non-technical operator runs first).
  ["storeos-print-hub/install.cmd", join(kit, "install.cmd")],
  ["storeos-print-hub/find-bluetooth-ports.cmd", join(kit, "find-bluetooth-ports.cmd")],
  ["storeos-print-hub/print-hub.mjs", join(here, "print-hub.mjs")],
  ["storeos-print-hub/print-hub/install-windows.ps1", join(kit, "install-windows.ps1")],
  ["storeos-print-hub/print-hub/uninstall-windows.ps1", join(kit, "uninstall-windows.ps1")],
  ["storeos-print-hub/print-hub/print-hub.cmd", join(kit, "print-hub.cmd")],
  ["storeos-print-hub/print-hub/print-hub.config.example.json", join(kit, "print-hub.config.example.json")],
  ["storeos-print-hub/print-hub/README-TH.txt", join(kit, "README-TH.txt")],
];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (~crc) >>> 0;
}

// Fixed DOS timestamp for deterministic output (2026-01-01 00:00:00).
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const localChunks = [];
const centralChunks = [];
let offset = 0;

for (const [name, srcPath] of entries) {
  const data = readFileSync(srcPath);
  const nameBuf = Buffer.from(name, "utf8");
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // method: stored
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); // compressed
  local.writeUInt32LE(data.length, 22); // uncompressed
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28); // extra len
  localChunks.push(local, nameBuf, data);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0, 8); // flags
  central.writeUInt16LE(0, 10); // method
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30); // extra
  central.writeUInt16LE(0, 32); // comment
  central.writeUInt16LE(0, 34); // disk
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE(0, 38); // external attrs
  central.writeUInt32LE(offset, 42); // local header offset
  centralChunks.push(central, nameBuf);

  offset += local.length + nameBuf.length + data.length;
}

const centralBuf = Buffer.concat(centralChunks);
const localBuf = Buffer.concat(localChunks);

const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(entries.length, 8);
eocd.writeUInt16LE(entries.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(localBuf.length, 16); // central dir offset
eocd.writeUInt16LE(0, 20);

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, Buffer.concat([localBuf, centralBuf, eocd]));
console.log(`Wrote ${outFile} (${entries.length} files, ${Buffer.concat([localBuf, centralBuf, eocd]).length} bytes)`);
