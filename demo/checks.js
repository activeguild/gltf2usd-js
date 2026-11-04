// Lightweight structural checks on a converted USDZ, run in the browser.
// Not a replacement for OpenUSD's validators (test/validate.py), but catches
// the mistakes that are easy to make in a hand-written USDA writer.

import { traverse, indexPrims, primReferences } from "./usda-parser.js";

/**
 * @param {ReturnType<import("./usdz-reader.js").readUsdz>} entries
 * @param {ReturnType<import("./usda-parser.js").parseUsda>} layer
 * @returns {{level: "ok"|"warn"|"error", msg: string}[]}
 */
export function runChecks(entries, layer) {
  const out = [];
  const ok = (msg) => out.push({ level: "ok", msg });
  const warn = (msg) => out.push({ level: "warn", msg });
  const error = (msg) => out.push({ level: "error", msg });

  // ---- Package ----
  const first = entries[0];
  if (first && /\.usd[ac]?$/.test(first.name)) ok(`最初のエントリが USD レイヤ (${first.name})`);
  else error(`最初のエントリが USD レイヤではない (${first?.name ?? "なし"})`);
  const compressed = entries.filter((e) => e.method !== 0);
  if (compressed.length) error(`圧縮されたエントリがある: ${compressed.map((e) => e.name).join(", ")}`);
  else ok(`全 ${entries.length} エントリが無圧縮 (stored)`);
  const unaligned = entries.filter((e) => !e.aligned);
  if (unaligned.length) error(`64 バイト境界にないエントリ: ${unaligned.map((e) => `${e.name}@${e.dataOffset}`).join(", ")}`);
  else ok("全エントリのデータ先頭が 64 バイト境界");
  const badCrc = entries.filter((e) => e.method === 0 && !e.crcOk);
  if (badCrc.length) error(`CRC 不一致: ${badCrc.map((e) => e.name).join(", ")}`);
  else ok("CRC32 一致");

  // ---- Layer metadata ----
  const prims = indexPrims(layer);
  const md = layer.metadata;
  if (md.defaultPrim && prims.has(`/${md.defaultPrim}`)) ok(`defaultPrim = ${md.defaultPrim}`);
  else error(`defaultPrim が未設定か存在しない (${md.defaultPrim ?? "なし"})`);
  if (md.upAxis === "Y" || md.upAxis === "Z") ok(`upAxis = ${md.upAxis}`);
  else warn("upAxis が未設定");
  if (typeof md.metersPerUnit === "number") ok(`metersPerUnit = ${md.metersPerUnit}`);
  else warn("metersPerUnit が未設定");

  // ---- Meshes ----
  const fileNames = new Set(entries.map((e) => e.name));
  let meshCount = 0;
  let meshProblems = 0;
  for (const prim of traverse(layer.prims)) {
    if (prim.type !== "Mesh") continue;
    meshCount++;
    const problems = checkMesh(prim, prims);
    meshProblems += problems.length;
    for (const p of problems) out.push({ level: p.level, msg: `${prim.path}: ${p.msg}` });
  }
  if (meshCount && !meshProblems) ok(`Mesh ${meshCount} 個: トポロジ / primvar / extent / binding に問題なし`);
  if (!meshCount) warn("Mesh がひとつもない");

  // ---- References / instancing ----
  let instances = 0;
  let refProblems = 0;
  for (const prim of traverse(layer.prims)) {
    const refs = primReferences(prim);
    if (prim.metadata.instanceable === true || prim.metadata.instanceable === 1) {
      instances++;
      if (!refs.length) { warn(`${prim.path}: instanceable なのに reference がない`); refProblems++; }
    }
    for (const ref of refs) {
      if (ref.asset) {
        if (!fileNames.has(ref.asset.replace(/^\.\//, ""))) { error(`${prim.path}: 参照ファイル ${ref.asset} がパッケージにない`); refProblems++; }
      } else if (!prims.has(ref.path)) {
        error(`${prim.path}: reference 先 ${ref.path} が存在しない`);
        refProblems++;
      }
    }
  }
  if (instances && !refProblems) ok(`instance ${instances} 個: reference 先はすべて存在する`);

  // ---- UsdSkel ----
  let skeletons = 0;
  let skelProblems = 0;
  for (const prim of traverse(layer.prims)) {
    if (prim.type !== "Skeleton") continue;
    skeletons++;
    for (const p of checkSkeleton(prim)) { skelProblems++; out.push({ level: p.level, msg: `${prim.path}: ${p.msg}` }); }
  }
  if (skeletons && !skelProblems) ok(`Skeleton ${skeletons} 個: ジョイント順（親が先）と bind / rest の数に問題なし`);

  // ---- Materials & shaders ----
  let shaderProblems = 0;
  for (const prim of traverse(layer.prims)) {
    if (prim.type === "Material") {
      const surf = prim.props.get("outputs:surface");
      const target = surf?.connect?.[0];
      if (!target || !prims.has(target.split(".")[0])) {
        error(`${prim.path}: outputs:surface の接続先が存在しない (${target ?? "なし"})`);
        shaderProblems++;
      }
    }
    if (prim.type !== "Shader") continue;
    for (const prop of prim.props.values()) {
      for (const c of prop.connect || []) {
        const [targetPath, attr] = splitPropPath(c);
        const target = prims.get(targetPath);
        if (!target) {
          error(`${prim.path}.${prop.name}: 接続先 prim がない (${c})`);
          shaderProblems++;
        } else if (!target.props.has(attr)) {
          error(`${prim.path}.${prop.name}: 接続先の属性が宣言されていない (${c})`);
          shaderProblems++;
        }
      }
    }
    const id = prim.props.get("info:id")?.value;
    if (id === "UsdUVTexture") {
      const file = prim.props.get("inputs:file")?.value?.asset;
      if (!file) { error(`${prim.path}: inputs:file がない`); shaderProblems++; }
      else if (!fileNames.has(file.replace(/^\.\//, ""))) {
        error(`${prim.path}: テクスチャ ${file} がパッケージ内にない`);
        shaderProblems++;
      }
    }
    if (id === "UsdPrimvarReader_float2") {
      const v = prim.props.get("inputs:varname");
      if (v && v.type !== "string") {
        error(`${prim.path}: inputs:varname の型が ${v.type}（string であるべき）`);
        shaderProblems++;
      }
    }
  }
  if (!shaderProblems) ok("マテリアル / シェーダの接続とテクスチャ参照はすべて解決できる");

  return out;
}

function checkMesh(prim, prims) {
  const problems = [];
  const err = (msg) => problems.push({ level: "error", msg });
  const warn = (msg) => problems.push({ level: "warn", msg });
  const points = prim.props.get("points")?.value;
  const counts = prim.props.get("faceVertexCounts")?.value;
  const indices = prim.props.get("faceVertexIndices")?.value;
  if (!points || !counts || !indices) {
    err("points / faceVertexCounts / faceVertexIndices のいずれかがない");
    return problems;
  }
  const total = counts.reduce((a, b) => a + b, 0);
  if (total !== indices.length) err(`faceVertexCounts の合計 ${total} ≠ faceVertexIndices の数 ${indices.length}`);
  const bad = indices.find((i) => !Number.isInteger(i) || i < 0 || i >= points.length);
  if (bad !== undefined) err(`範囲外のインデックス ${bad}（points は ${points.length} 個）`);
  if (!prim.props.get("extent")?.value) warn("extent がない");

  for (const [name, prop] of prim.props) {
    if (!(name.startsWith("primvars:") || name === "normals") || name.endsWith(":indices")) continue;
    if (!prop.isArray || !Array.isArray(prop.value)) continue; // e.g. a constant matrix4d primvar
    const interp = prop.metadata.interpolation ?? (name === "normals" ? "vertex" : "constant");
    const elementSize = prop.metadata.elementSize ?? 1;
    const idx = prim.props.get(`${name}:indices`)?.value;
    const n = idx ? idx.length : prop.value.length;
    const base = { constant: 1, uniform: counts.length, vertex: points.length, varying: points.length, faceVarying: indices.length }[interp];
    const expected = base === undefined ? undefined : base * elementSize;
    if (expected !== undefined && n !== expected) {
      err(`${name} の要素数 ${n} が interpolation "${interp}"${elementSize > 1 ? ` × elementSize ${elementSize}` : ""} の期待値 ${expected} と一致しない`);
    }
  }

  problems.push(...checkSkelBinding(prim, prims, points.length));

  const binding = prim.props.get("material:binding");
  if (binding) {
    const target = prims.get(binding.value?.[0]);
    if (!target || target.type !== "Material") err(`material:binding の参照先が Material ではない (${binding.value?.[0]})`);
    // Every UV set the material reads must exist on the mesh.
    for (const shader of target?.children ?? []) {
      if (shader.props.get("info:id")?.value !== "UsdPrimvarReader_float2") continue;
      const varname = shader.props.get("inputs:varname")?.value;
      if (varname && !prim.props.has(`primvars:${varname}`)) {
        warn(`マテリアルが読む primvars:${varname} がこの Mesh にない (${shader.path})`);
      }
    }
    const api = prim.metadata["prepend apiSchemas"] ?? prim.metadata.apiSchemas ?? [];
    if (!api.includes("MaterialBindingAPI")) err("material:binding があるのに MaterialBindingAPI が適用されていない");
  }
  return problems;
}

/** UsdSkel: skeleton binding, joint influences and blend shapes of one Mesh. */
function checkSkelBinding(prim, prims, pointCount) {
  const problems = [];
  const err = (msg) => problems.push({ level: "error", msg });
  const skelPath = prim.props.get("skel:skeleton")?.value?.[0];
  const jointIdx = prim.props.get("primvars:skel:jointIndices");
  const shapes = prim.props.get("skel:blendShapes")?.value;
  if (!skelPath && !jointIdx && !shapes) return problems;

  const api = prim.metadata["prepend apiSchemas"] ?? prim.metadata.apiSchemas ?? [];
  if (!api.includes("SkelBindingAPI")) err("skel:* を使うのに SkelBindingAPI が適用されていない");
  let anc = prim.parent;
  while (anc && anc.type !== "SkelRoot") anc = anc.parent;
  if (!anc) err("SkelRoot の下にない（UsdSkel の変形が効かない）");
  const skel = skelPath && prims.get(skelPath);
  if (!skel || skel.type !== "Skeleton") {
    err(`skel:skeleton の参照先が Skeleton ではない (${skelPath ?? "なし"})`);
    return problems;
  }
  const jointCount = skel.props.get("joints")?.value?.length ?? 0;

  if (jointIdx) {
    const weights = prim.props.get("primvars:skel:jointWeights");
    const es = jointIdx.metadata.elementSize ?? 1;
    if (!weights) err("jointIndices があるのに jointWeights がない");
    else if ((weights.metadata.elementSize ?? 1) !== es) err("jointIndices と jointWeights の elementSize が違う");
    const bad = jointIdx.value.find((j) => j < 0 || j >= jointCount);
    if (bad !== undefined) err(`jointIndices に範囲外のジョイント ${bad}（joints は ${jointCount} 個）`);
  }

  if (shapes) {
    const targets = prim.props.get("skel:blendShapeTargets")?.value ?? [];
    if (targets.length !== shapes.length) err(`skel:blendShapes ${shapes.length} 個と skel:blendShapeTargets ${targets.length} 個が一致しない`);
    for (const t of targets) {
      const shape = prims.get(t);
      if (!shape || shape.type !== "BlendShape") { err(`blendShapeTarget ${t} が BlendShape ではない`); continue; }
      const offsets = shape.props.get("offsets")?.value ?? [];
      const pi = shape.props.get("pointIndices")?.value;
      const expected = pi ? pi.length : pointCount;
      if (offsets.length !== expected) err(`${t}: offsets ${offsets.length} 個（期待値 ${expected}）`);
      if (pi?.some((i) => i < 0 || i >= pointCount)) err(`${t}: pointIndices が範囲外`);
    }
  }
  return problems;
}

/** Skeleton: parents before children, one bind / rest transform per joint. */
function checkSkeleton(prim) {
  const problems = [];
  const joints = prim.props.get("joints")?.value ?? [];
  const seen = new Set();
  for (const j of joints) {
    const parent = j.includes("/") ? j.slice(0, j.lastIndexOf("/")) : null;
    if (parent && !seen.has(parent)) problems.push({ level: "error", msg: `ジョイント ${j} が親 ${parent} より前にある（または親がない）` });
    seen.add(j);
  }
  for (const attr of ["bindTransforms", "restTransforms"]) {
    const v = prim.props.get(attr)?.value;
    if (joints.length && (!v || v.length !== joints.length)) {
      problems.push({ level: "error", msg: `${attr} が ${v?.length ?? 0} 個（joints は ${joints.length} 個）` });
    }
  }
  return problems;
}

function splitPropPath(p) {
  const dot = p.lastIndexOf(".");
  return [p.slice(0, dot), p.slice(dot + 1)];
}
