// Minimal PNG writer for textures the converter generates itself (8-bit gray + alpha,
// uncompressed deflate blocks). Zero dependencies.
import { crc32 } from "./usdz.js";

/**
 * @param {number} w
 * @param {number} h
 * @param {(x: number, y: number) => [number, number]} pixel  [gray, alpha], y = 0 is the top row
 * @returns {Uint8Array}
 */
export function encodeGrayAlphaPng(w, h, pixel) {
  const raw = new Uint8Array(h * (1 + w * 2));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 2); // filter byte 0 (none), then pixels
    for (let x = 0; x < w; x++) raw.set(pixel(x, y), row + 1 + x * 2);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 4, 0, 0, 0], 8); // bit depth 8, color type 4 (gray + alpha)
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibStored(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

function zlibStored(data) {
  const parts = [new Uint8Array([0x78, 0x01])];
  for (let i = 0; i < data.length || i === 0; i += 65535) {
    const block = data.subarray(i, i + 65535);
    const n = block.length;
    parts.push(new Uint8Array([i + 65535 >= data.length ? 1 : 0, n & 0xff, n >> 8, ~n & 0xff, (~n >> 8) & 0xff]), block);
  }
  let a = 1, b = 0; // Adler-32
  for (const v of data) { a = (a + v) % 65521; b = (b + a) % 65521; }
  const adler = new Uint8Array(4);
  new DataView(adler.buffer).setUint32(0, ((b << 16) | a) >>> 0);
  parts.push(adler);
  return concat(parts);
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
