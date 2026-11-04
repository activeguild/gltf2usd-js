// Reads a USDZ (zip) archive via its central directory and reports the
// properties the USDZ spec cares about: stored (no compression), 64-byte
// aligned data, CRC, and the first entry being a USD layer.

export function readUsdz(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(dv);
  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries = [];

  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error(`Bad central directory header #${i}`);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const compSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (dv.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`Bad local header for ${name}`);
    const lNameLen = dv.getUint16(localOffset + 26, true);
    const lExtraLen = dv.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + lNameLen + lExtraLen;
    const data = bytes.subarray(dataOffset, dataOffset + compSize);
    entries.push({
      name, method, size, compSize, dataOffset, data,
      aligned: dataOffset % 64 === 0,
      crcOk: method === 0 && crc32(data) === crc,
    });
  }
  return entries;
}

function findEocd(dv) {
  for (let i = dv.byteLength - 22; i >= Math.max(0, dv.byteLength - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) return i;
  }
  throw new Error("Not a zip archive (end of central directory not found)");
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
