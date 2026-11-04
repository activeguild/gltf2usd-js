// Builds a three.js scene from a parsed USDA layer (see usda-parser.js) and the
// files of its USDZ package. Covers what gltf2usd.js writes: Xform hierarchy,
// xformOps, Mesh (normals / st / displayColor with any interpolation) and
// UsdPreviewSurface with UsdUVTexture inputs. Anything else is reported in
// `warnings` so it is obvious when the preview, not the converter, is the limit.

import * as THREE from "three";
import { indexPrims, primReferences } from "./usda-parser.js";

export function buildUsdScene(layer, entries) {
  const warnings = [];
  const warnOnce = new Set();
  const warn = (msg) => { if (!warnOnce.has(msg)) { warnOnce.add(msg); warnings.push(msg); } };
  const prims = indexPrims(layer);
  const files = new Map(entries.map((e) => [e.name, e]));
  const textureCache = new Map();
  const materialCache = new Map();
  const geometryCache = new Map(); // Mesh prim path → BufferGeometry (shared by instances)
  const objectUrls = [];

  const root = new THREE.Group();
  root.name = "USD";
  if (layer.metadata.upAxis === "Z") root.rotation.x = -Math.PI / 2;
  const mpu = layer.metadata.metersPerUnit;
  if (typeof mpu === "number" && mpu !== 1) root.scale.setScalar(mpu);

  for (const prim of layer.prims) {
    const obj = buildPrim(prim);
    if (obj) root.add(obj);
  }
  return { object: root, warnings, dispose: () => objectUrls.forEach((u) => URL.revokeObjectURL(u)) };

  // ---------- Prims ----------

  function buildPrim(prim) {
    if (prim.specifier === "class") return null;
    prim = composeReferences(prim, 0);
    if (prim.type === "Material" || prim.type === "Shader") return null;

    let obj;
    if (prim.type === "Mesh") {
      obj = buildMesh(prim);
    } else {
      if (prim.type && !["Xform", "Scope", "SkelRoot"].includes(prim.type)) warn(`未対応の prim 型 ${prim.type}（Xform として扱う）`);
      obj = new THREE.Group();
    }
    obj.name = prim.name;
    obj.userData.usdPath = prim.path;
    applyXformOps(prim, obj);
    const vis = prim.props.get("visibility")?.value;
    if (vis === "invisible") obj.visible = false;
    for (const child of prim.children) {
      const c = buildPrim(child);
      if (c) obj.add(c);
    }
    return obj;
  }

  /**
   * Minimal composition for internal references: the referenced prim's
   * properties and children sit under the local opinions. External (asset)
   * references are not resolved by this preview.
   */
  function composeReferences(prim, depth) {
    const refs = primReferences(prim);
    if (!refs.length) return prim;
    if (depth > 8) { warn(`${prim.path}: references が深すぎるか循環している`); return prim; }
    let type = prim.type;
    const props = new Map();
    const children = [];
    for (const ref of refs) {
      if (ref.asset) { warn(`外部ファイルへの reference (@${ref.asset}@) はプレビューでは読み込まない`); continue; }
      const target = prims.get(ref.path);
      if (!target) { warn(`${prim.path}: reference 先 ${ref.path} がない`); continue; }
      const t = composeReferences(target, depth + 1);
      type ||= t.type;
      for (const [k, v] of t.props) if (!props.has(k)) props.set(k, v);
      children.push(...t.children);
    }
    for (const [k, v] of prim.props) props.set(k, v);
    children.push(...prim.children);
    return { ...prim, type, props, children };
  }

  function applyXformOps(prim, obj) {
    const order = prim.props.get("xformOpOrder")?.value;
    if (!order || !order.length) return;
    const m = new THREE.Matrix4();
    for (let op of order) {
      let inverse = false;
      if (op.startsWith("!invert!")) { inverse = true; op = op.slice(8); }
      if (op === "!resetXformStack!") { warn("!resetXformStack! は未対応"); continue; }
      const prop = prim.props.get(op);
      if (!prop) { warn(`${prim.path}: xformOpOrder の ${op} が定義されていない`); continue; }
      let v = prop.value;
      if (v === undefined && prop.timeSamples?.length) {
        warn("timeSamples は最初のサンプルだけを表示");
        v = prop.timeSamples[0][1];
      }
      const opM = xformOpMatrix(op, v);
      if (!opM) { warn(`未対応の xformOp: ${op}`); continue; }
      if (inverse) opM.invert();
      m.multiply(opM); // first op in the list is the outermost
    }
    m.decompose(obj.position, obj.quaternion, obj.scale);
  }

  // ---------- Mesh ----------

  /** Instances of one prototype share geometry and material, like USD instancing. */
  function buildMesh(prim) {
    const cached = geometryCache.get(prim.path);
    if (cached) return new THREE.Mesh(cached.geometry, cached.material);
    const obj = buildMeshUncached(prim);
    if (obj.isMesh) geometryCache.set(prim.path, obj);
    return obj;
  }

  function buildMeshUncached(prim) {
    const get = (n) => prim.props.get(n)?.value;
    const points = get("points");
    const counts = get("faceVertexCounts");
    const indices = get("faceVertexIndices");
    if (!points || !counts || !indices) {
      warn(`${prim.path}: points / faceVertexCounts / faceVertexIndices がそろっていない`);
      return new THREE.Group();
    }
    const leftHanded = get("orientation") === "leftHanded";

    // Triangulate as fans; remember for each output corner which face / face-vertex it came from.
    const corners = []; // [faceIndex, faceVertexIndex]
    let fv = 0;
    counts.forEach((n, face) => {
      for (let k = 1; k + 1 < n; k++) {
        const tri = [fv, fv + k, fv + k + 1];
        if (leftHanded) tri.reverse();
        for (const c of tri) corners.push([face, c]);
      }
      fv += n;
    });

    const geom = new THREE.BufferGeometry();
    const vertexOf = (corner) => indices[corner[1]];
    geom.setAttribute("position", expand(points, 3, corners, "vertex", vertexOf));

    const normals = prim.props.get("normals") ?? prim.props.get("primvars:normals");
    if (normals?.value) {
      geom.setAttribute("normal", expandPrimvar(prim, normals, 3, corners, vertexOf, "vertex"));
    } else {
      geom.computeVertexNormals();
    }

    // primvars:st / st1 / st2 / st3 → three.js uv / uv1 / uv2 / uv3 (texture.channel 0..3)
    for (const [name, prop] of prim.props) {
      const m = /^primvars:st(\d*)$/.exec(name);
      if (!m || !prop.value) continue;
      const channel = Number(m[1] || 0);
      if (channel > 3) { warn(`${name}: three.js は UV セットを 4 つまでしか扱えない`); continue; }
      geom.setAttribute(channel ? `uv${channel}` : "uv", expandPrimvar(prim, prop, 2, corners, vertexOf, "vertex"));
    }
    if (prim.props.has("primvars:UVMap")) warn("primvars:UVMap はプレビューでは使われない");

    const dc = prim.props.get("primvars:displayColor");
    if (dc?.value) geom.setAttribute("color", expandPrimvar(prim, dc, 3, corners, vertexOf, "constant"));

    const material = buildBoundMaterial(prim, !!dc?.value);
    if (get("doubleSided")) material.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(geom, material);
    return mesh;
  }

  function expandPrimvar(prim, prop, size, corners, vertexOf, defaultInterp) {
    const interp = prop.metadata.interpolation ?? defaultInterp;
    let values = prop.value;
    const idx = prim.props.get(`${prop.name}:indices`)?.value;
    if (idx) {
      values = idx.map((i) => values[i]);
    }
    return expand(values, size, corners, interp, vertexOf);
  }

  function expand(values, size, corners, interp, vertexOf) {
    const out = new Float32Array(corners.length * size);
    corners.forEach((corner, i) => {
      let src;
      switch (interp) {
        case "constant": src = values[0]; break;
        case "uniform": src = values[corner[0]]; break;
        case "faceVarying": src = values[corner[1]]; break;
        default: src = values[vertexOf(corner)]; // vertex / varying
      }
      for (let c = 0; c < size; c++) out[i * size + c] = src?.[c] ?? 0;
    });
    return new THREE.BufferAttribute(out, size);
  }

  // ---------- Material ----------

  function buildBoundMaterial(meshPrim, hasDisplayColor) {
    const binding = meshPrim.props.get("material:binding")?.value?.[0];
    if (!binding) {
      return new THREE.MeshStandardMaterial({ vertexColors: hasDisplayColor, color: hasDisplayColor ? 0xffffff : 0x888888, roughness: 0.6 });
    }
    if (materialCache.has(binding)) return materialCache.get(binding);
    const mat = buildMaterial(prims.get(binding));
    materialCache.set(binding, mat);
    return mat;
  }

  function buildMaterial(matPrim) {
    const mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff });
    if (!matPrim) { warn("material:binding の参照先がない"); return mat; }
    mat.name = matPrim.name;
    const surfPath = matPrim.props.get("outputs:surface")?.connect?.[0];
    const surf = surfPath && prims.get(surfPath.split(".")[0]);
    if (!surf) { warn(`${matPrim.path}: outputs:surface が未接続`); return mat; }
    const id = surf.props.get("info:id")?.value;
    if (id !== "UsdPreviewSurface") { warn(`未対応のサーフェスシェーダ ${id}`); return mat; }

    const input = (name) => resolveInput(surf, `inputs:${name}`);

    const diffuse = input("diffuseColor");
    if (diffuse?.texture) {
      mat.map = diffuse.texture;
      mat.color.fromArray(diffuse.scale);
      setSrgb(diffuse);
    } else if (diffuse?.value) {
      mat.color.fromArray(diffuse.value);
    } else {
      mat.color.setScalar(0.18); // UsdPreviewSurface default
    }

    const opacity = input("opacity");
    const threshold = input("opacityThreshold")?.value ?? 0;
    if (opacity?.texture) {
      if (opacity.texture !== mat.map) warn("diffuse と別テクスチャの opacity は未対応");
      if (opacity.channel !== "a") warn(`opacity がチャンネル ${opacity.channel} に接続されている（a 以外は未対応）`);
      mat.opacity = opacity.scale[3];
    } else if (typeof opacity?.value === "number") {
      mat.opacity = opacity.value;
    }
    if (threshold > 0) {
      mat.alphaTest = threshold;
    } else if (opacity && (opacity.texture || mat.opacity < 1)) {
      mat.transparent = true;
      mat.depthWrite = false;
    }

    const metallic = input("metallic");
    const roughness = input("roughness");
    if (input("useSpecularWorkflow")?.value === 1) warn("useSpecularWorkflow = 1 は未対応（metallic として表示）");
    if (metallic?.texture) {
      if (metallic.channel !== "b") warn(`metallic がチャンネル ${metallic.channel} に接続（three.js は B を使う）`);
      mat.metalnessMap = metallic.texture;
      mat.metalness = metallic.scale[channelIndex(metallic.channel)];
    } else {
      mat.metalness = metallic?.value ?? 0;
    }
    if (roughness?.texture) {
      if (roughness.channel !== "g") warn(`roughness がチャンネル ${roughness.channel} に接続（three.js は G を使う）`);
      mat.roughnessMap = roughness.texture;
      mat.roughness = roughness.scale[channelIndex(roughness.channel)];
    } else {
      mat.roughness = roughness?.value ?? 0.5;
    }

    const normal = input("normal");
    if (normal?.texture) {
      mat.normalMap = normal.texture;
      const s = normal.scale, b = normal.bias;
      if (!(s[0] === 2 && b[0] === -1)) warn("法線マップの scale / bias が (2, -1) 以外");
    }

    const occlusion = input("occlusion");
    if (occlusion?.texture) {
      if (occlusion.channel !== "r") warn(`occlusion がチャンネル ${occlusion.channel} に接続（three.js は R を使う）`);
      mat.aoMap = occlusion.texture;
    }

    const emissive = input("emissiveColor");
    if (emissive?.texture) {
      mat.emissiveMap = emissive.texture;
      mat.emissive.fromArray(emissive.scale);
      setSrgb(emissive);
    } else if (emissive?.value) {
      mat.emissive.fromArray(emissive.value);
    }

    // three.js reads clearcoat from R and clearcoatRoughness from G, like glTF.
    const clearcoat = input("clearcoat");
    if (clearcoat?.texture) {
      if (clearcoat.channel !== "r") warn(`clearcoat がチャンネル ${clearcoat.channel} に接続（three.js は R を使う）`);
      mat.clearcoatMap = clearcoat.texture;
      mat.clearcoat = clearcoat.scale[channelIndex(clearcoat.channel)];
    } else if (typeof clearcoat?.value === "number") {
      mat.clearcoat = clearcoat.value;
    }
    const ccr = input("clearcoatRoughness");
    if (ccr?.texture) {
      if (ccr.channel !== "g") warn(`clearcoatRoughness がチャンネル ${ccr.channel} に接続（three.js は G を使う）`);
      mat.clearcoatRoughnessMap = ccr.texture;
      mat.clearcoatRoughness = ccr.scale[channelIndex(ccr.channel)];
    } else if (typeof ccr?.value === "number") {
      mat.clearcoatRoughness = ccr.value;
    }
    const ior = input("ior");
    if (typeof ior?.value === "number") mat.ior = ior.value;

    for (const name of surf.props.keys()) {
      if (/^inputs:(displacement|specularColor)$/.test(name)) warn(`UsdPreviewSurface ${name} は未対応`);
    }
    return mat;
  }

  function setSrgb(input) {
    if (input.texture && input.colorSpace !== "raw") input.texture.colorSpace = THREE.SRGBColorSpace;
  }

  /**
   * Resolve a shader input: either a constant { value } or a texture
   * { texture, channel, scale, bias, colorSpace } when connected to UsdUVTexture.
   */
  function resolveInput(shader, name) {
    const prop = shader.props.get(name);
    if (!prop) return null;
    if (!prop.connect) return { value: prop.value };
    const [path, output] = splitPropPath(prop.connect[0]);
    const src = prims.get(path);
    if (!src) { warn(`接続先がない: ${prop.connect[0]}`); return null; }
    const srcId = src.props.get("info:id")?.value;
    if (srcId !== "UsdUVTexture") {
      warn(`${name} が ${srcId ?? src.type} に接続されている（UsdUVTexture 以外は未対応）`);
      return null;
    }
    const channel = output.replace(/^outputs:/, "");
    const scale = src.props.get("inputs:scale")?.value ?? [1, 1, 1, 1];
    const bias = src.props.get("inputs:bias")?.value ?? [0, 0, 0, 0];
    const colorSpace = src.props.get("inputs:sourceColorSpace")?.value ?? "auto";
    const texture = loadTexture(src);
    return { texture, channel, scale: Array.from(scale), bias: Array.from(bias), colorSpace };
  }

  function loadTexture(texPrim) {
    if (textureCache.has(texPrim.path)) return textureCache.get(texPrim.path);
    const file = texPrim.props.get("inputs:file")?.value?.asset?.replace(/^\.\//, "");
    const entry = file && files.get(file);
    if (!entry) { warn(`テクスチャ ${file} がパッケージにない`); textureCache.set(texPrim.path, null); return null; }

    const mime = /\.jpe?g$/i.test(file) ? "image/jpeg" : /\.png$/i.test(file) ? "image/png" : "application/octet-stream";
    const url = URL.createObjectURL(new Blob([entry.data], { type: mime }));
    objectUrls.push(url);
    const tex = new THREE.TextureLoader().load(url);
    tex.name = file;
    tex.flipY = true; // USD st has its origin bottom-left, like three.js with flipY
    const wrap = { repeat: THREE.RepeatWrapping, mirror: THREE.MirroredRepeatWrapping, clamp: THREE.ClampToEdgeWrapping, black: THREE.ClampToEdgeWrapping };
    tex.wrapS = wrap[texPrim.props.get("inputs:wrapS")?.value] ?? THREE.RepeatWrapping;
    tex.wrapT = wrap[texPrim.props.get("inputs:wrapT")?.value] ?? THREE.RepeatWrapping;

    // st reader (optionally through UsdTransform2d)
    const stConn = texPrim.props.get("inputs:st")?.connect?.[0];
    let node = stConn && prims.get(splitPropPath(stConn)[0]);
    if (node?.props.get("info:id")?.value === "UsdTransform2d") {
      const g = (n, d) => node.props.get(`inputs:${n}`)?.value ?? d;
      const [sx, sy] = g("scale", [1, 1]);
      const [tx, ty] = g("translation", [0, 0]);
      const r = (g("rotation", 0) * Math.PI) / 180;
      const c = Math.cos(r), s = Math.sin(r);
      // UsdTransform2d: st' = Rccw(r) · diag(scale) · st + translation.
      // With flipY, three.js uv space is USD st space, so this is the uv matrix as-is.
      tex.matrixAutoUpdate = false;
      tex.matrix.set(c * sx, -s * sy, tx, s * sx, c * sy, ty, 0, 0, 1);
      const inConn = node.props.get("inputs:in")?.connect?.[0];
      node = inConn && prims.get(splitPropPath(inConn)[0]);
    }
    const varname = node?.props.get("inputs:varname")?.value;
    const m = /^st(\d*)$/.exec(varname ?? "st");
    if (m && Number(m[1] || 0) <= 3) {
      tex.channel = Number(m[1] || 0);
    } else {
      warn(`varname "${varname}" の UV セットはプレビューでは st として表示`);
    }

    textureCache.set(texPrim.path, tex);
    return tex;
  }
}

function xformOpMatrix(op, v) {
  const type = op.split(":")[1];
  const m = new THREE.Matrix4();
  switch (type) {
    case "transform":
      return m.fromArray(v.flat()); // USD row-vector rows == three.js column-major elements
    case "translate":
      return m.makeTranslation(v[0], v[1], v[2]);
    case "scale":
      return m.makeScale(v[0], v[1], v[2]);
    case "orient": {
      const [w, x, y, z] = v; // USD quaternions are (real, i, j, k)
      return m.makeRotationFromQuaternion(new THREE.Quaternion(x, y, z, w));
    }
    case "rotateX": return m.makeRotationX(THREE.MathUtils.degToRad(v));
    case "rotateY": return m.makeRotationY(THREE.MathUtils.degToRad(v));
    case "rotateZ": return m.makeRotationZ(THREE.MathUtils.degToRad(v));
    default: {
      const r = /^rotate([XYZ]{3})$/.exec(type);
      if (!r) return null;
      // rotateXYZ applies X first, then Y, then Z: M = Rz * Ry * Rx (column vectors).
      const axes = r[1].split("");
      const out = new THREE.Matrix4();
      axes.forEach((axis, i) => {
        const rot = new THREE.Matrix4()[`makeRotation${axis}`](THREE.MathUtils.degToRad(v[i]));
        out.premultiply(rot);
      });
      return out;
    }
  }
}

function channelIndex(ch) {
  return { r: 0, g: 1, b: 2, a: 3 }[ch] ?? 0;
}

function splitPropPath(p) {
  const dot = p.lastIndexOf(".");
  return [p.slice(0, dot), p.slice(dot + 1)];
}
