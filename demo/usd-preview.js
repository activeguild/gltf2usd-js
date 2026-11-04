// Builds a three.js scene from a parsed USDA layer (see usda-parser.js) and the
// files of its USDZ package. Covers what gltf2usd.js writes: Xform hierarchy,
// xformOps, Mesh (normals / st / displayColor with any interpolation; displayOpacity read by a material),
// UsdPreviewSurface with UsdUVTexture inputs, and UsdSkel (Skeleton +
// SkelAnimation joints, BlendShapes and their weights). Anything else is reported in
// `warnings` so it is obvious when the preview, not the converter, is the limit.

import * as THREE from "three";
import { indexPrims, primReferences, traverse } from "./usda-parser.js";

/**
 * @param {object} [options]
 * @param {Record<string, string>} [options.variantSelections]  variantSet name → variant
 *   (overrides the authored selection; "" means no selection)
 * Returns { object, warnings, timeline, setTime, variantSets, dispose };
 * variantSets lists [{ path, set, variants, selection }] for UI.
 */
export function buildUsdScene(layer, entries, options = {}) {
  const warnings = [];
  const warnOnce = new Set();
  const warn = (msg) => { if (!warnOnce.has(msg)) { warnOnce.add(msg); warnings.push(msg); } };
  const prims = indexPrims(layer);
  const files = new Map(entries.map((e) => [e.name, e]));
  const textureCache = new Map();
  const materialCache = new Map();
  const geometryCache = new Map(); // Mesh prim path → BufferGeometry (shared by instances)
  const objectUrls = [];
  const animated = []; // { prim, obj } with time-sampled xformOps
  const updaters = []; // (timeCode | undefined) => void, for skeletons and blend shape weights
  const skeletons = new Map(); // Skeleton prim path → { skeleton: THREE.Skeleton, group, update }
  const objects = new Map(); // prim path → Object3D
  const { overrides, variantSets } = collectVariantOverrides(layer, options.variantSelections ?? {});

  const root = new THREE.Group();
  root.name = "USD";
  if (layer.metadata.upAxis === "Z") root.rotation.x = -Math.PI / 2;
  const mpu = layer.metadata.metersPerUnit;
  if (typeof mpu === "number" && mpu !== 1) root.scale.setScalar(mpu);

  for (const prim of layer.prims) {
    const obj = buildPrim(prim);
    if (obj) root.add(obj);
  }
  // Bones live under the Skeleton prim's parent (its SkelRoot), so skeleton space follows the scene.
  for (const [path, sk] of skeletons) {
    const parentObj = objects.get(path.slice(0, path.lastIndexOf("/")));
    (parentObj ?? root).add(sk.group);
  }
  // Timeline: objects whose xformOps have timeSamples are re-evaluated by setTime().
  const md = layer.metadata;
  const timeline = animated.length || updaters.some((u) => u.timed)
    ? {
        start: md.startTimeCode ?? Math.min(0, ...animated.flatMap((a) => sampleTimes(a.prim))),
        end: md.endTimeCode ?? Math.max(0, ...animated.flatMap((a) => sampleTimes(a.prim))),
        timeCodesPerSecond: md.timeCodesPerSecond ?? 24,
      }
    : null;
  const setTime = (timeCode) => {
    for (const { prim, obj } of animated) applyXformOps(prim, obj, timeCode);
    for (const u of updaters) u(timeCode);
  };
  setTime(timeline ? timeline.start : undefined);

  return { object: root, warnings, timeline, setTime, variantSets, dispose: () => objectUrls.forEach((u) => URL.revokeObjectURL(u)) };

  // ---------- Prims ----------

  function buildPrim(prim) {
    if (prim.specifier === "class") return null;
    prim = composeReferences(prim, 0);
    // Selected variants' opinions (the converter only authors material:binding there).
    const over = overrides.get(prim.path);
    if (over) prim = { ...prim, props: new Map([...prim.props, ...over]) };
    if (prim.type === "Material" || prim.type === "Shader") return null;
    // UsdSkel prims are read through the meshes bound to them.
    if (prim.type === "Skeleton" || prim.type === "SkelAnimation" || prim.type === "BlendShape") return null;

    let obj;
    if (prim.type === "Mesh") {
      obj = buildMesh(prim);
    } else if (prim.type === "DistantLight" || prim.type === "SphereLight") {
      obj = buildLight(prim);
    } else {
      if (prim.type && !["Xform", "Scope", "SkelRoot"].includes(prim.type)) warn(`未対応の prim 型 ${prim.type}（Xform として扱う）`);
      obj = new THREE.Group();
    }
    obj.name = prim.name;
    obj.userData.usdPath = prim.path;
    objects.set(prim.path, obj);
    applyXformOps(prim, obj, undefined);
    if (hasTimeSamples(prim)) animated.push({ prim, obj });
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

  function applyXformOps(prim, obj, time) {
    const order = prim.props.get("xformOpOrder")?.value;
    if (!order || !order.length) return;
    const m = new THREE.Matrix4();
    for (let op of order) {
      let inverse = false;
      if (op.startsWith("!invert!")) { inverse = true; op = op.slice(8); }
      if (op === "!resetXformStack!") { warn("!resetXformStack! は未対応"); continue; }
      const prop = prim.props.get(op);
      if (!prop) { warn(`${prim.path}: xformOpOrder の ${op} が定義されていない`); continue; }
      const v = valueAt(prop, time);
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
    // Skinned / blend-shaped meshes are bound per prim and never shared.
    if (obj.isMesh && !obj.isSkinnedMesh && !obj.morphTargetInfluences) geometryCache.set(prim.path, obj);
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

    let material = buildBoundMaterial(prim, !!dc?.value);
    // A material whose opacity reads a primvar (displayOpacity): per-vertex alpha.
    // USD's material ignores displayColor, so the RGB of the vertex color is white.
    const opacityPrimvar = material.userData.opacityPrimvar;
    const op = opacityPrimvar && prim.props.get(`primvars:${opacityPrimvar}`);
    if (op?.value) {
      const scalar = { ...op, value: op.value.map((v) => [v]) }; // float[] values are plain numbers
      const a = expandPrimvar(prim, scalar, 1, corners, vertexOf, "constant").array;
      const rgba = new Float32Array(a.length * 4).fill(1);
      for (let i = 0; i < a.length; i++) rgba[i * 4 + 3] = a[i];
      geom.setAttribute("color", new THREE.BufferAttribute(rgba, 4));
      material = material.clone();
      material.vertexColors = true;
      material.opacity = 1; // the fallback applies only to meshes without the primvar
    }
    if (get("doubleSided")) material.side = THREE.DoubleSide;
    if (prim.props.has("skel:skeleton")) return bindSkel(prim, geom, material, corners, vertexOf, points.length);
    const mesh = new THREE.Mesh(geom, material);
    return mesh;
  }

  // ---------- UsdLux ----------

  /**
   * DistantLight → DirectionalLight, SphereLight → PointLight, + ShapingAPI → SpotLight.
   * All shine along local -Z (target at (0, 0, -1)), like GLTFLoader's punctual lights.
   * Intensities are used as-is (the converter copies glTF lux / candela).
   */
  function buildLight(prim) {
    const get = (n, d) => prim.props.get(n)?.value ?? d;
    const color = new THREE.Color().fromArray(get("inputs:color", [1, 1, 1]));
    const intensity = get("inputs:intensity", 1) * 2 ** get("inputs:exposure", 0);
    const group = new THREE.Group();
    let light;
    if (prim.type === "DistantLight") {
      light = new THREE.DirectionalLight(color, intensity);
    } else if (prim.props.has("inputs:shaping:cone:angle")) {
      const angle = THREE.MathUtils.degToRad(get("inputs:shaping:cone:angle", 90));
      light = new THREE.SpotLight(color, intensity, 0, Math.min(angle, Math.PI / 2), get("inputs:shaping:cone:softness", 0), 2);
    } else {
      light = new THREE.PointLight(color, intensity, 0, 2);
      if (!get("treatAsPoint", false) && get("inputs:radius", 0.5) > 0) warn("SphereLight の半径は点光源として表示");
    }
    group.add(light);
    if (light.target) {
      light.target.position.set(0, 0, -1);
      group.add(light.target);
    }
    return group;
  }

  // ---------- UsdSkel ----------

  /**
   * Blend shapes → morph attributes; joint influences → SkinnedMesh. three.js skins a
   * vertex (in "attached" mode) to  Σ w · boneWorld · boneInverse · bindMatrix · v,
   * which is UsdSkel's  skelWorld · Σ w · jointSkel · inverse(bindTransform) · geomBindTransform · v
   * when the bones hang under the Skeleton's parent, boneInverse = inverse(bindTransform)
   * and bindMatrix = geomBindTransform.
   */
  function bindSkel(prim, geom, material, corners, vertexOf, pointCount) {
    const skelPath = prim.props.get("skel:skeleton").value[0];
    const skelPrim = prims.get(skelPath);
    if (!skelPrim) { warn(`${prim.path}: skel:skeleton ${skelPath} がない`); return new THREE.Mesh(geom, material); }
    const animPrim = prims.get(skelPrim.props.get("skel:animationSource")?.value?.[0]);

    // Blend shapes (relative morph targets, sparse pointIndices expanded to all points).
    const tokens = prim.props.get("skel:blendShapes")?.value ?? [];
    const targets = prim.props.get("skel:blendShapeTargets")?.value ?? [];
    if (targets.length) {
      const pos = [], nrm = [];
      for (const t of targets) {
        const bs = prims.get(t);
        const full = (attr) => {
          const v = bs?.props.get(attr)?.value;
          if (!v) return null;
          const pi = bs.props.get("pointIndices")?.value;
          const out = Array.from({ length: pointCount }, () => [0, 0, 0]);
          v.forEach((o, k) => { out[pi ? pi[k] : k] = o; });
          return expand(out, 3, corners, "vertex", vertexOf);
        };
        pos.push(full("offsets") ?? expand([], 3, corners, "vertex", vertexOf));
        nrm.push(full("normalOffsets"));
      }
      geom.morphAttributes.position = pos;
      if (nrm.every(Boolean)) geom.morphAttributes.normal = nrm;
      geom.morphTargetsRelative = true;
    }

    let obj;
    const ji = prim.props.get("primvars:skel:jointIndices");
    const jw = prim.props.get("primvars:skel:jointWeights");
    const sk = ji && jw ? getSkeleton(skelPrim, animPrim) : null;
    if (sk) {
      const es = ji.metadata.elementSize ?? 1;
      if (es > 4) warn(`${prim.path}: ジョイント影響 ${es} 個のうち、重い順に 4 つだけ表示（three.js の上限）`);
      // "constant" influences (rigid binding) apply one set to every point.
      const constant = ji.metadata.interpolation === "constant";
      const perPoint = [];
      for (let p = 0; p < pointCount; p++) {
        const inf = [];
        const base = constant ? 0 : p * es;
        for (let c = 0; c < es; c++) inf.push([ji.value[base + c], jw.value[base + c]]);
        inf.sort((a, b) => b[1] - a[1]);
        const top = inf.slice(0, 4);
        while (top.length < 4) top.push([0, 0]);
        const sum = top.reduce((a, [, w]) => a + w, 0) || 1;
        perPoint.push(top.map(([j, w]) => [j, w / sum]));
      }
      const idx = new Uint16Array(corners.length * 4);
      const wts = new Float32Array(corners.length * 4);
      corners.forEach((corner, i) => {
        perPoint[vertexOf(corner)].forEach(([j, w], c) => { idx[i * 4 + c] = j; wts[i * 4 + c] = w; });
      });
      geom.setAttribute("skinIndex", new THREE.BufferAttribute(idx, 4));
      geom.setAttribute("skinWeight", new THREE.BufferAttribute(wts, 4));
      obj = new THREE.SkinnedMesh(geom, material);
      const gb = prim.props.get("primvars:skel:geomBindTransform")?.value;
      obj.bind(sk.skeleton, gb ? new THREE.Matrix4().fromArray(gb.flat()) : new THREE.Matrix4());
      obj.frustumCulled = false; // bounds of the rest pose don't follow the animation
    } else {
      obj = new THREE.Mesh(geom, material);
    }

    // Blend shape weights from the skeleton's animation, matched by token.
    if (targets.length) {
      const order = animPrim?.props.get("blendShapes")?.value ?? [];
      const weights = animPrim?.props.get("blendShapeWeights");
      const map = tokens.map((t) => order.indexOf(t));
      const update = (time) => {
        const w = weights ? valueAt(weights, time) : null;
        map.forEach((k, i) => { obj.morphTargetInfluences[i] = k >= 0 && w ? w[k] ?? 0 : 0; });
      };
      update.timed = !!weights?.timeSamples;
      updaters.push(update);
    }
    return obj;
  }

  /** One THREE.Skeleton per Skeleton prim; bones posed from restTransforms or the SkelAnimation. */
  function getSkeleton(skelPrim, animPrim) {
    if (skeletons.has(skelPrim.path)) return skeletons.get(skelPrim.path);
    const tokens = skelPrim.props.get("joints")?.value ?? [];
    const mat = (rows) => new THREE.Matrix4().fromArray(rows.flat());
    const bind = skelPrim.props.get("bindTransforms")?.value ?? [];
    const rest = skelPrim.props.get("restTransforms")?.value ?? [];
    const group = new THREE.Group();
    group.name = `${skelPrim.name} (bones)`;
    applyXformOps(skelPrim, group, undefined);
    const byToken = new Map();
    const bones = tokens.map((token, k) => {
      const bone = new THREE.Bone();
      bone.name = token.split("/").pop();
      if (rest[k]) mat(rest[k]).decompose(bone.position, bone.quaternion, bone.scale);
      const parentToken = token.includes("/") ? token.slice(0, token.lastIndexOf("/")) : null;
      (byToken.get(parentToken) ?? group).add(bone);
      byToken.set(token, bone);
      return bone;
    });
    const inverses = tokens.map((_, k) => (bind[k] ? mat(bind[k]).invert() : new THREE.Matrix4()));
    const skeleton = new THREE.Skeleton(bones, inverses);

    // Joint animation: joints missing from the animation keep their rest transform.
    const animJoints = animPrim?.props.get("joints")?.value ?? [];
    const T = animPrim?.props.get("translations"), R = animPrim?.props.get("rotations"), S = animPrim?.props.get("scales");
    if (animJoints.length && (T || R || S)) {
      const slot = tokens.map((t) => animJoints.indexOf(t));
      const update = (time) => {
        const t = T && valueAt(T, time), r = R && valueAt(R, time), s = S && valueAt(S, time);
        slot.forEach((k, j) => {
          if (k < 0) return;
          const bone = bones[j];
          if (t) bone.position.fromArray(t[k]);
          if (r) bone.quaternion.set(r[k][1], r[k][2], r[k][3], r[k][0]); // USD quat is (w, x, y, z)
          if (s) bone.scale.fromArray(s[k]);
        });
      };
      update.timed = [T, R, S].some((p) => p?.timeSamples);
      updaters.push(update);
    }
    const entry = { skeleton, group };
    skeletons.set(skelPrim.path, entry);
    return entry;
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
    if (opacity?.primvar) mat.userData.opacityPrimvar = opacity.primvar;
    if (threshold > 0) {
      mat.alphaTest = threshold;
    } else if (opacity && (opacity.texture || opacity.primvar || mat.opacity < 1)) {
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
    if (srcId === "UsdPrimvarReader_float") {
      // Vertex opacity (primvars:displayOpacity); meshes without it use the fallback.
      return { primvar: src.props.get("inputs:varname")?.value, value: src.props.get("inputs:fallback")?.value ?? 0 };
    }
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

// ---------- Variants ----------

/**
 * Opinions of the selected variants, as Map<prim path, Map<prop name, Prop>>.
 * Variant contents are parsed with plain paths, so a body's props apply to the
 * owning prim and its child prims to owner/child/... Variant opinions are weaker
 * than local ones in USD; the converter never authors both for the same property.
 */
function collectVariantOverrides(layer, selections) {
  const overrides = new Map();
  const variantSets = [];
  const add = (path, props) => {
    if (!props.size) return;
    const m = overrides.get(path) ?? new Map();
    for (const [k, v] of props) if (!m.has(k)) m.set(k, v);
    overrides.set(path, m);
  };
  const walk = (body, path) => {
    add(path, body.props);
    for (const child of body.children) walk(child, `${path}/${child.name}`);
  };
  for (const prim of traverse(layer.prims)) {
    for (const [set, variants] of prim.variantSets ?? []) {
      const selection = set in selections ? selections[set] : prim.metadata.variants?.[set] ?? "";
      variantSets.push({ path: prim.path, set, variants: [...variants.keys()], selection });
      const body = variants.get(selection);
      if (body) walk(body, prim.path);
    }
  }
  return { overrides, variantSets };
}

// ---------- Time samples (evaluated like USD: linear, slerp for quaternions, held at the ends) ----------

function hasTimeSamples(prim) {
  return (prim.props.get("xformOpOrder")?.value ?? []).some((op) => prim.props.get(op.replace(/^!invert!/, ""))?.timeSamples?.length);
}

function sampleTimes(prim) {
  return (prim.props.get("xformOpOrder")?.value ?? []).flatMap((op) => (prim.props.get(op)?.timeSamples ?? []).map(([t]) => t));
}

function valueAt(prop, time) {
  const ts = prop.timeSamples;
  if (!ts?.length) return prop.value;
  if (time === undefined || time <= ts[0][0]) return ts[0][1];
  if (time >= ts[ts.length - 1][0]) return ts[ts.length - 1][1];
  let lo = 0, hi = ts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid][0] <= time) lo = mid; else hi = mid;
  }
  const [t0, a] = ts[lo];
  const [t1, b] = ts[hi];
  const u = (time - t0) / (t1 - t0);
  const quat = /^quat/.test(prop.type);
  // Arrays (quatf[], float3[], float[]) interpolate element-wise, like USD.
  if (prop.isArray) return a.map((v, k) => lerpValue(v, b[k], u, quat));
  return lerpValue(a, b, u, quat);
}

function lerpValue(a, b, u, quat) {
  if (quat) {
    const qa = new THREE.Quaternion(a[1], a[2], a[3], a[0]);
    const qb = new THREE.Quaternion(b[1], b[2], b[3], b[0]);
    qa.slerp(qb, u); // three.js slerp takes the shortest path, like GfSlerp
    return [qa.w, qa.x, qa.y, qa.z];
  }
  if (Array.isArray(a)) return a.map((v, c) => v + (b[c] - v) * u);
  return a + (b - a) * u;
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
