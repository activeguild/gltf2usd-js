// USDZ packager.
// USDZ = zip archive with constraints (see OpenUSD "Usdz File Format Specification"):
//   - no compression (method 0 / "stored")
//   - every file's data must start at a 64-byte aligned offset (padding via extra field)
//   - the first file should be the root USD layer
//   - no encryption
// Zero dependencies; produces a Uint8Array.

const ALIGN = 64;
const EXTRA_HEADER_ID = 0x1986; // arbitrary; Pixar's usdzip uses the same idea

/**
 * @param {{name: string, bytes: Uint8Array}[]} entries  First entry must be the .usda/.usdc.
 * @returns {Uint8Array}
 */
export function packUsdz(entries) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const data = entry.bytes;
    const crc = crc32(data);

    // Compute padding so that data begins on a 64-byte boundary.
    const headerEnd = offset + 30 + nameBytes.length;
    let pad = (ALIGN - (headerEnd % ALIGN)) % ALIGN;
    if (pad > 0 && pad < 4) pad += ALIGN; // need room for the 4-byte extra header
    const extra = new Uint8Array(pad);
    if (pad) {
      const dv = new DataView(extra.buffer);
      dv.setUint16(0, EXTRA_HEADER_ID, true);
      dv.setUint16(2, pad - 4, true);
    }

    // Local file header
    const lfh = new Uint8Array(30);
    const dv = new DataView(lfh.buffer);
    dv.setUint32(0, 0x04034b50, true); // signature
    dv.setUint16(4, 20, true);         // version needed
    dv.setUint16(6, 0x0800, true);     // flags: UTF-8 names
    dv.setUint16(8, 0, true);          // method: stored
    dv.setUint16(10, 0, true);         // mod time
    dv.setUint16(12, 0x21, true);      // mod date (1980-01-01)
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, extra.length, true);

    central.push({ nameBytes, extra, crc, size: data.length, offset });

    chunks.push(lfh, nameBytes, extra, data);
    offset += lfh.length + nameBytes.length + extra.length + data.length;
    if ((offset - data.length) % ALIGN !== 0) throw new Error("internal: alignment failed");
  }

  const centralStart = offset;
  for (const c of central) {
    const cdh = new Uint8Array(46);
    const dv = new DataView(cdh.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);  // version made by
    dv.setUint16(6, 20, true);  // version needed
    dv.setUint16(8, 0x0800, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0, true);
    dv.setUint16(14, 0x21, true);
    dv.setUint32(16, c.crc, true);
    dv.setUint32(20, c.size, true);
    dv.setUint32(24, c.size, true);
    dv.setUint16(28, c.nameBytes.length, true);
    dv.setUint16(30, c.extra.length, true);
    dv.setUint16(32, 0, true);  // comment length
    dv.setUint16(34, 0, true);  // disk number
    dv.setUint16(36, 0, true);  // internal attrs
    dv.setUint32(38, 0, true);  // external attrs
    dv.setUint32(42, c.offset, true);
    chunks.push(cdh, c.nameBytes, c.extra);
    offset += cdh.length + c.nameBytes.length + c.extra.length;
  }
  const centralSize = offset - centralStart;

  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, central.length, true);
  edv.setUint16(10, central.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, centralStart, true);
  edv.setUint16(20, 0, true);
  chunks.push(eocd);

  return concat(chunks);
}

function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

let CRC_TABLE = null;
function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
