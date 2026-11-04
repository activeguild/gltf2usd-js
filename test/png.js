// Tiny PNG encoder for test images (RGBA8, uncompressed deflate blocks).
// Pure ESM so both Node tests and the browser demo can use it.

/**
 * @param {number} w
 * @param {number} h
 * @param {(x: number, y: number) => [number, number, number, number]} pixel  y = 0 is the top row
 * @returns {Uint8Array}
 */
export function encodePng(w, h, pixel) {
  const raw = new Uint8Array(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 4);
    raw[row] = 0; // filter: none
    for (let x = 0; x < w; x++) raw.set(pixel(x, y), row + 1 + x * 4);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibStored(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

function zlibStored(data) {
  const blocks = [new Uint8Array([0x78, 0x01])];
  for (let i = 0; i < data.length || i === 0; i += 65535) {
    const part = data.subarray(i, i + 65535);
    const header = new Uint8Array(5);
    header[0] = i + 65535 >= data.length ? 1 : 0;
    header[1] = part.length & 0xff;
    header[2] = part.length >> 8;
    header[3] = ~part.length & 0xff;
    header[4] = (~part.length >> 8) & 0xff;
    blocks.push(header, part);
  }
  let a = 1, b = 0;
  for (const v of data) { a = (a + v) % 65521; b = (b + a) % 65521; }
  const adler = new Uint8Array(4);
  new DataView(adler.buffer).setUint32(0, ((b << 16) | a) >>> 0);
  blocks.push(adler);
  return concat(blocks);
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

let TABLE = null;
function crc32(bytes) {
  if (!TABLE) {
    TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
