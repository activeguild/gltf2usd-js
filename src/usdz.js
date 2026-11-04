// USDZ packager.
// USDZ = zip archive with constraints (see OpenUSD "Usdz File Format Specification"):
//   - no compression (method 0 / "stored")
//   - every file's data must start at a 64-byte aligned offset (padding via extra field)
//   - the first file is the root USD layer (.usda / .usdc / .usd)
//   - no encryption
// Zero dependencies; produces a Uint8Array.
//
// Only classic (32-bit) zip is written. Inputs that do not fit its fields (files or
// archive ≥ 4 GiB, > 65535 entries, names > 65535 bytes) throw UsdzLimitError before
// anything is written, instead of producing a corrupt archive. ZIP64 is not implemented.

const ALIGN = 64;
const EXTRA_HEADER_ID = 0x1986; // arbitrary; Pixar's usdzip uses the same idea
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;

/** Thrown when the entries cannot be stored in a valid (non-ZIP64) USDZ. */
export class UsdzLimitError extends Error {
  constructor(message) {
    super(`USDZ exceeds supported ZIP size limits: ${message}`);
    this.name = "UsdzLimitError";
  }
}

/**
 * @param {{name: string, bytes: Uint8Array}[]} entries  First entry must be the root layer.
 * @returns {Uint8Array}
 */
export function packUsdz(entries) {
  const layout = planLayout(entries);
  const chunks = [];
  const central = [];

  layout.forEach(({ nameBytes, pad, offset }, i) => {
    const data = entries[i].bytes;
    const crc = crc32(data);
    const extra = new Uint8Array(pad);
    if (pad) {
      const dv = new DataView(extra.buffer);
      dv.setUint16(0, EXTRA_HEADER_ID, true);
      dv.setUint16(2, pad - 4, true);
    }

    // Local file header
    const lfh = new Uint8Array(LOCAL_HEADER);
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
    if ((offset + LOCAL_HEADER + nameBytes.length + pad) % ALIGN !== 0) throw new Error("internal: alignment failed");
  });

  const centralStart = layout.centralStart;
  for (const c of central) {
    const cdh = new Uint8Array(CENTRAL_HEADER);
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
  }

  const eocd = new Uint8Array(END_RECORD);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, central.length, true);
  edv.setUint16(10, central.length, true);
  edv.setUint32(12, layout.centralSize, true);
  edv.setUint32(16, centralStart, true);
  edv.setUint16(20, 0, true);
  chunks.push(eocd);

  return concat(chunks, layout.total);
}

/**
 * Validate the entries and compute every offset before any bytes are written.
 * Only `name` and `bytes.length` are read, so limits can be checked without data.
 * @returns {Array<{nameBytes, pad, offset}> & {centralStart, centralSize, total}}
 */
export function planLayout(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error("USDZ needs at least the root layer");
  if (entries.length > MAX_U16) throw new UsdzLimitError(`${entries.length} entries (at most ${MAX_U16})`);
  const enc = new TextEncoder();
  const seen = new Set();
  const layout = [];
  let offset = 0;
  entries.forEach((entry, i) => {
    checkEntryName(entry?.name, i);
    const key = entry.name.toLowerCase();
    if (seen.has(key)) throw new Error(`USDZ entry "${entry.name}" appears more than once`);
    seen.add(key);
    const size = entry.bytes?.length;
    if (!Number.isInteger(size) || size < 0) throw new Error(`USDZ entry "${entry.name}" has no bytes`);
    if (size > MAX_U32) throw new UsdzLimitError(`entry "${entry.name}" is ${size} bytes (at most ${MAX_U32})`);
    const nameBytes = enc.encode(entry.name);
    if (nameBytes.length > MAX_U16) throw new UsdzLimitError(`entry name is ${nameBytes.length} bytes (at most ${MAX_U16})`);
    if (offset > MAX_U32) throw new UsdzLimitError(`entry "${entry.name}" would start at byte ${offset} (at most ${MAX_U32})`);
    // Padding so that the data begins on a 64-byte boundary (extra field ≥ 4 bytes).
    const headerEnd = offset + LOCAL_HEADER + nameBytes.length;
    let pad = (ALIGN - (headerEnd % ALIGN)) % ALIGN;
    if (pad > 0 && pad < 4) pad += ALIGN;
    layout.push({ nameBytes, pad, offset });
    offset = headerEnd + pad + size;
  });
  const centralStart = offset;
  const centralSize = layout.reduce((n, l) => n + CENTRAL_HEADER + l.nameBytes.length + l.pad, 0);
  if (centralStart > MAX_U32) throw new UsdzLimitError(`central directory would start at byte ${centralStart} (at most ${MAX_U32})`);
  if (centralSize > MAX_U32) throw new UsdzLimitError(`central directory is ${centralSize} bytes (at most ${MAX_U32})`);
  layout.centralStart = centralStart;
  layout.centralSize = centralSize;
  layout.total = centralStart + centralSize + END_RECORD;
  return layout;
}

/**
 * Entry names are relative forward-slash paths inside the package: no absolute paths,
 * drive letters, backslashes, "." / ".." / empty segments or control characters. The
 * first entry is the root layer.
 */
function checkEntryName(name, index) {
  const bad = (why) => { throw new Error(`USDZ entry name ${JSON.stringify(name)}: ${why}`); };
  if (typeof name !== "string" || !name) bad("must be a non-empty string");
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) bad("must be a relative path");
  if (name.includes("\\")) bad("must use forward slashes");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) bad("contains control characters");
  if (name.split("/").some((s) => s === "" || s === "." || s === "..")) bad("has an empty, '.' or '..' path segment");
  if (index === 0 && !/\.usd[ac]?$/i.test(name)) bad("the first entry must be the root USD layer (.usda / .usdc / .usd)");
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  if (o !== total) throw new Error("internal: USDZ size mismatch");
  return out;
}

let CRC_TABLE = null;
export function crc32(bytes) {
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
