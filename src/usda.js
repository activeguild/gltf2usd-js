// USD IR (src/ir.js) → USDA text.

const TUPLE_SIZE = {
  float2: 2, double2: 2, half2: 2, int2: 2, texCoord2f: 2, texCoord2d: 2,
  float3: 3, double3: 3, half3: 3, int3: 3, point3f: 3, point3d: 3, normal3f: 3, vector3f: 3,
  color3f: 3, texCoord3f: 3,
  float4: 4, double4: 4, half4: 4, int4: 4, color4f: 4, quatf: 4, quatd: 4, quath: 4,
  matrix2d: 4, matrix3d: 9, matrix4d: 16,
};
const INT_TYPES = new Set(["int", "uint", "int64", "uint64", "uchar"]);
const STRING_TYPES = new Set(["token", "string"]);

/** @param {import("./ir.js").Layer} layer */
export function writeUsda(layer) {
  const lines = ["#usda 1.0", "("];
  for (const [key, value] of Object.entries(layer.metadata)) lines.push(`    ${key} = ${fmtMeta(value)}`);
  lines.push(")");
  layer.prims.forEach((prim) => {
    lines.push("");
    writePrim(lines, prim, 0);
  });
  lines.push("");
  return lines.join("\n");
}

function writePrim(lines, prim, depth) {
  const ind = "    ".repeat(depth);
  const header = `${ind}${prim.specifier} ${prim.type ? `${prim.type} ` : ""}"${prim.name}"`;
  const meta = Object.entries(prim.metadata);
  if (meta.length) {
    lines.push(`${header} (`);
    for (const [key, value] of meta) {
      if (key === "variants") {
        // Variant selections: variants = { string <set> = "<variant>" }
        lines.push(`${ind}    variants = {`);
        for (const [set, sel] of Object.entries(value)) lines.push(`${ind}        string ${set} = ${quote(sel)}`);
        lines.push(`${ind}    }`);
      } else {
        lines.push(`${ind}    ${key} = ${fmtMeta(value)}`);
      }
    }
    lines.push(`${ind})`);
  } else {
    lines.push(header);
  }
  lines.push(`${ind}{`);
  for (const prop of prim.props) writeProp(lines, prop, depth + 1);
  prim.children.forEach((child, i) => {
    if (prim.spaced && (i > 0 || prim.props.length)) lines.push("");
    writePrim(lines, child, depth + 1);
  });
  for (const [setName, variants] of prim.variantSets ?? []) {
    lines.push("");
    lines.push(`${ind}    variantSet ${quote(setName)} = {`);
    for (const [name, body] of variants) {
      lines.push(`${ind}        ${quote(name)} {`);
      for (const prop of body.props) writeProp(lines, prop, depth + 3);
      for (const child of body.children) writePrim(lines, child, depth + 3);
      lines.push(`${ind}        }`);
    }
    lines.push(`${ind}    }`);
  }
  lines.push(`${ind}}`);
}

function writeProp(lines, prop, depth) {
  const ind = "    ".repeat(depth);
  if (prop.kind === "rel") {
    const t = prop.targets;
    if (!t.length) lines.push(`${ind}rel ${prop.name}`);
    else if (t.length === 1) lines.push(`${ind}rel ${prop.name} = <${t[0]}>`);
    else lines.push(`${ind}rel ${prop.name} = [${t.map((p) => `<${p}>`).join(", ")}]`);
    return;
  }

  const decl = `${ind}${prop.uniform ? "uniform " : ""}${prop.typeName} ${prop.name}`;
  const meta = Object.entries(prop.metadata);

  // Declaration / default value / connection line; property metadata attaches here.
  let head = null;
  if (prop.connect !== undefined) head = `${decl}.connect = <${prop.connect}>`;
  else if (prop.value !== undefined) head = `${decl} = ${fmtValue(prop.typeName, prop.value)}`;
  else if (!prop.timeSamples || meta.length) head = decl;
  if (head !== null) {
    if (meta.length) {
      lines.push(`${head} (`);
      for (const [k, v] of meta) lines.push(`${ind}    ${k} = ${fmtMeta(v)}`);
      lines.push(`${ind})`);
    } else {
      lines.push(head);
    }
  }

  if (prop.timeSamples) {
    lines.push(`${decl}.timeSamples = {`);
    for (const [time, value] of prop.timeSamples) lines.push(`${ind}    ${fmtTime(time)}: ${fmtValue(prop.typeName, value)},`);
    lines.push(`${ind}}`);
  }
}

// ---------- Values ----------

function fmtValue(typeName, v) {
  if (typeName.endsWith("[]")) {
    const base = typeName.slice(0, -2);
    if (base === "matrix4d") {
      let s = "[";
      for (let i = 0; i < v.length; i += 16) s += (i ? ", " : "") + fmtMatrix(v, i);
      return `${s}]`;
    }
    const n = TUPLE_SIZE[base];
    if (n) return `[${fmtVecs(v, n)}]`;
    const chunks = [];
    let s = "";
    const int = INT_TYPES.has(base);
    for (let i = 0; i < v.length; i++) {
      if (i) s += ", ";
      s += int ? String(Math.trunc(v[i])) : fmtScalar(base, v[i]);
      if (s.length > 4096) { chunks.push(s); s = ""; }
    }
    chunks.push(s);
    return `[${chunks.join("")}]`;
  }
  if (typeName === "matrix4d") return fmtMatrix(v);
  if (TUPLE_SIZE[typeName]) return fmtTuple(v);
  return fmtScalar(typeName, v);
}

function fmtScalar(type, v) {
  if (type === "bool") return v ? "1" : "0";
  if (INT_TYPES.has(type)) return String(Math.trunc(v));
  if (STRING_TYPES.has(type)) return quote(v);
  if (type === "asset") return `@${v}@`;
  return fmt(v);
}

function fmtMeta(v) {
  if (typeof v === "string") return quote(v);
  if (typeof v === "number") return fmt(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return `[${v.map(fmtMeta).join(", ")}]`;
  if (v && typeof v === "object" && "path" in v) return `<${v.path}>`;
  throw new Error(`Unsupported metadata value: ${JSON.stringify(v)}`);
}

function quote(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** float-precision formatting (7 significant digits) keeps files small. */
export function fmt(v) {
  const a = v < 0 ? -v : v;
  if (a >= 1e-4 && a < 1e7) {
    const s = fastFmt(a);
    if (s !== null) return v < 0 ? `-${s}` : s;
  } else if (a === 0) {
    return "0";
  }
  return fmtSlow(v);
}

/** The reference definition: what fmt() returns for every value. */
function fmtSlow(v) {
  if (!Number.isFinite(v)) return "0";
  return Number(v.toPrecision(7)).toString();
}

const POW10 = [1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11];

/**
 * fmtSlow() for 1e-4 <= a < 1e7 without toPrecision: scale to a 7-digit integer, round, and
 * place the decimal point. Number(<7 digits>).toString() is those digits without trailing
 * zeros (no exponent form in this range). The scaled value is within a few ulps (< 1e-8) of
 * the exact product, so only values within 1e-4 of a rounding tie, or whose digit count
 * Math.log10 got wrong, could round differently; those return null and take the slow path.
 */
function fastFmt(a) {
  const k = 6 - Math.floor(Math.log10(a)); // decimal places for 7 significant digits: 0..10
  const scaled = a * POW10[k];
  const floor = Math.floor(scaled);
  const frac = scaled - floor;
  if (frac > 0.4999 && frac < 0.5001) return null;
  const r = frac < 0.5 ? floor : floor + 1;
  if (r < 1e6 || r >= 1e7) return null;
  const digits = String(r);
  let end = 7;
  while (end > 7 - k && digits.charCodeAt(end - 1) === 48) end--;
  if (k >= 7) return `0.${"000000".slice(0, k - 7)}${digits.slice(0, end)}`;
  return end > 7 - k ? `${digits.slice(0, 7 - k)}.${digits.slice(7 - k, end)}` : digits.slice(0, 7 - k);
}

/** Time codes keep more digits than values (long clips at 24 fps reach five digits). */
function fmtTime(t) {
  return Number(t.toPrecision(10)).toString();
}

function fmtTuple(arr) {
  let s = "(";
  for (let i = 0; i < arr.length; i++) s += i ? `, ${fmt(arr[i])}` : fmt(arr[i]);
  return `${s})`;
}

// Large arrays: tuples are appended to a short string that is flushed into a list of chunks
// every few KB. Joining one array entry per tuple (the old way) or one ever-growing string
// both spent most of the time in allocation and GC.
function fmtVecs(data, n) {
  const chunks = [];
  let s = "";
  for (let i = 0; i < data.length; i += n) {
    s += i ? ", (" : "(";
    for (let c = 0; c < n; c++) s += c ? `, ${fmt(data[i + c])}` : fmt(data[i + c]);
    s += ")";
    if (s.length > 4096) { chunks.push(s); s = ""; }
  }
  chunks.push(s);
  return chunks.join("");
}

function fmtMatrix(m, o = 0) {
  let s = "( ";
  for (let r = 0; r < 4; r++) {
    const b = o + r * 4;
    s += `${r ? ", " : ""}(${fmt(m[b])}, ${fmt(m[b + 1])}, ${fmt(m[b + 2])}, ${fmt(m[b + 3])})`;
  }
  return `${s} )`;
}
