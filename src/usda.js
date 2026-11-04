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
    for (const [key, value] of meta) lines.push(`${ind}    ${key} = ${fmtMeta(value)}`);
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
      const out = [];
      for (let i = 0; i < v.length; i += 16) out.push(fmtMatrix(v.slice(i, i + 16)));
      return `[${out.join(", ")}]`;
    }
    const n = TUPLE_SIZE[base];
    if (n) return `[${fmtVecs(v, n)}]`;
    return `[${Array.from(v, (x) => fmtScalar(base, x)).join(", ")}]`;
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
  if (!Number.isFinite(v)) return "0";
  return Number(v.toPrecision(7)).toString();
}

/** Time codes keep more digits than values (long clips at 24 fps reach five digits). */
function fmtTime(t) {
  return Number(t.toPrecision(10)).toString();
}

function fmtTuple(arr) {
  return `(${Array.from(arr, fmt).join(", ")})`;
}

function fmtVecs(data, n) {
  const out = [];
  for (let i = 0; i < data.length; i += n) {
    const parts = [];
    for (let c = 0; c < n; c++) parts.push(fmt(data[i + c]));
    out.push(`(${parts.join(", ")})`);
  }
  return out.join(", ");
}

function fmtMatrix(m) {
  const rows = [];
  for (let r = 0; r < 4; r++) rows.push(fmtTuple(m.slice(r * 4, r * 4 + 4)));
  return `( ${rows.join(", ")} )`;
}
