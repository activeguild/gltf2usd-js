// glTF skins → UsdSkel (SkelRoot / Skeleton / SkelAnimation + SkelBindingAPI on meshes).
//
// glTF skins a vertex in world space:  v' = Σ w · jointWorld · inverseBindMatrix · v
// (the skinned mesh node's own transform is ignored). UsdSkel computes
//   v' = Σ w · jointSkelSpace · inverse(bindTransform) · geomBindTransform · v
// in the space of the Skeleton prim. Each skin becomes a SkelRoot under /Root/Skins
// with an identity transform, so skeleton space is glTF world space and
//   bindTransforms = inverse(inverseBindMatrices), geomBindTransform = identity.
//
// Joint hierarchy: a joint's parent is its nearest ancestor that is a joint of the
// same skin. restTransforms (and animated local transforms) are relative to that
// parent joint and include any non-joint nodes in between (for root joints: all
// their ancestors, e.g. an "Armature" node). Animation of those non-joint nodes is
// not followed (warning).

import { IDENTITY, decompose, invert, isIdentity, isSingular, multiply, nodeLocalMatrix, composeTRS } from "./math.js";
import { sampleAt } from "./animation.js";
import { Prim } from "./ir.js";
import { sanitize, uniqueName } from "./names.js";
import { DataUnavailableError, GltfValidationError } from "./glb.js";

/**
 * @returns {Map<number, SkinPlan>} skin index → plan, for skins used by nodes in the scene
 * @typedef {object} SkinPlan
 * @property {number} index
 * @property {number[]} joints      glTF node indices in skeleton (parent-first) order
 * @property {string[]} tokens      UsdSkel joint paths, same order
 * @property {Int32Array} remap     skin joint index → skeleton joint index
 * @property {number[][]} bind      bindTransforms (world), skeleton order
 * @property {number[][]} prefix    static matrix in front of each joint's local transform
 * @property {number[]} users       scene nodes that use the skin (mesh goes into the SkelRoot)
 */
/** Parent map and cached rest-pose world matrices for all nodes. */
function nodeGraph(json) {
  const parent = new Map();
  (json.nodes || []).forEach((n, i) => (n.children || []).forEach((c) => parent.set(c, i)));
  const worldCache = new Map();
  const world = (i) => {
    if (i === undefined) return IDENTITY;
    if (!worldCache.has(i)) worldCache.set(i, multiply(world(parent.get(i)), nodeLocalMatrix(json.nodes[i])));
    return worldCache.get(i);
  };
  return { parent, world };
}

export function planSkins(ctx, sceneNodes) {
  const { json } = ctx;
  const plans = new Map();
  if (!json.skins?.length) return plans;
  const { parent, world } = nodeGraph(json);

  for (const nodeIndex of sceneNodes) {
    const node = json.nodes[nodeIndex];
    if (node.skin === undefined || node.mesh === undefined) continue;
    const skin = json.skins[node.skin];
    if (!skin) continue;
    if (!plans.has(node.skin)) {
      try {
        plans.set(node.skin, buildPlan(ctx, node.skin, skin, parent, world));
      } catch (e) {
        if (!(e instanceof DataUnavailableError)) throw e;
        ctx.warn(`Skin ${node.skin} skipped (meshes written unskinned): ${e.message}`);
        plans.set(node.skin, null);
      }
    }
    plans.get(node.skin)?.users.push(nodeIndex);
  }
  for (const [k, v] of plans) if (!v) plans.delete(k);
  return plans;
}

/**
 * Joint hierarchy for a set of nodes: parent-first order (UsdSkel requires parents
 * before children; siblings keep `jointList` order), path tokens, and for each joint
 * the static matrix between its parent joint (or the skeleton origin) and its own
 * local transform: prefix_k = inverse(world(parentJoint)) · world(direct parent).
 */
function jointHierarchy(ctx, jointList, parent, world, label) {
  const { json } = ctx;
  const jointSet = new Set(jointList);
  const parentJoint = (j) => {
    let p = parent.get(j);
    while (p !== undefined && !jointSet.has(p)) p = parent.get(p);
    return p;
  };
  const children = new Map();
  const roots = [];
  for (const j of jointList) {
    const p = parentJoint(j);
    if (p === undefined) roots.push(j);
    else (children.get(p) ?? children.set(p, []).get(p)).push(j);
  }
  const joints = [];
  const tokens = [];
  const visit = (j, parentToken, siblingNames) => {
    const name = uniqueName(sanitize(json.nodes[j].name, `joint_${j}`), siblingNames);
    const token = parentToken ? `${parentToken}/${name}` : name;
    joints.push(j);
    tokens.push(token);
    const names = new Set();
    for (const c of children.get(j) ?? []) visit(c, token, names);
  };
  const rootNames = new Set();
  roots.forEach((r) => visit(r, "", rootNames));

  const animatedNodes = ctx.animation?.nodes;
  const prefix = joints.map((j) => {
    const pj = parentJoint(j);
    const direct = parent.get(j);
    for (let a = direct; a !== undefined && a !== pj; a = parent.get(a)) {
      if (animatedNodes?.has(a)) {
        ctx.warn(`${label}: node ${a} between joints is animated; its animation is not applied to the skeleton`);
      }
    }
    return pj === direct ? [...IDENTITY] : multiply(invert(world(pj)), world(direct));
  });
  return { joints, tokens, prefix };
}

function buildPlan(ctx, skinIndex, skin, parent, world) {
  const { joints, tokens, prefix } = jointHierarchy(ctx, skin.joints, parent, world, `Skin ${skinIndex}`);
  const skelIndex = new Map(joints.map((j, k) => [j, k]));
  const remap = Int32Array.from(skin.joints, (j) => skelIndex.get(j));

  // bindTransforms = inverse(inverseBindMatrices); missing IBMs are identity.
  const ibm = skin.inverseBindMatrices !== undefined ? ctx.asset.accessor(skin.inverseBindMatrices).data : null;
  const bind = joints.map((j) => {
    const i = skin.joints.indexOf(j);
    return ibm ? invert(Array.from(ibm.slice(i * 16, i * 16 + 16))) : [...IDENTITY];
  });

  // Always prefixed: Mac Quick Look did not play a skin whose SkelRoot-side container was
  // named "Rig" (renaming only that prim made it play), so glTF names are not used bare here.
  const name = uniqueName(skin.name ? `Skin_${sanitize(skin.name, "")}` : `Skin_${skinIndex}`, ctx.skinNames);
  return { index: skinIndex, name, joints, tokens, remap, bind, prefix, users: [] };
}

/**
 * Node (transform) animation as skeletal animation. Some viewers (verified with AR
 * Quick Look-style playback) do not play time-sampled xformOps but do play UsdSkel,
 * so every animated node and its whole subtree become joints of one Skeleton, and
 * the meshes in those subtrees are bound rigidly (one joint, weight 1) to their node's
 * joint — the same approach as Apple's usdzconvert `bindRigidDeformation`.
 *
 * bindTransforms are the joints' rest world matrices; each mesh gets its node's rest
 * world matrix as geomBindTransform, so  jointSkel(t) · inverse(bind) · geomBind = jointSkel(t).
 * A singular rest world matrix (a node hidden with scale 0 at rest, as in scale "flipbook"
 * animations) cannot be inverted, so that joint binds at identity instead: bind = geomBind
 * = identity gives the same jointSkel(t) · v.
 *
 * @param {Set<number>} exclude  nodes that are already handled (skin joints)
 * @returns {null | SkinPlan & { rigid: true, roots: Set<number> }}
 */
export function planRigidAnimation(ctx, sceneNodes, exclude) {
  const animated = ctx.animation?.nodes;
  if (!animated?.size) return null;
  const { json } = ctx;
  const { parent, world } = nodeGraph(json);
  const inScene = new Set(sceneNodes);
  const isAnimated = (i) => inScene.has(i) && !exclude.has(i) &&
    ["translation", "rotation", "scale"].some((p) => animated.get(i)?.[p]);
  const roots = sceneNodes.filter((i) => {
    if (!isAnimated(i)) return false;
    for (let a = parent.get(i); a !== undefined; a = parent.get(a)) if (isAnimated(a)) return false;
    return true;
  });
  if (!roots.length) return null;

  const jointList = [];
  const collect = (i) => {
    if (jointList.includes(i)) return;
    jointList.push(i);
    for (const c of json.nodes[i].children || []) collect(c);
  };
  roots.forEach(collect);
  const { joints, tokens, prefix } = jointHierarchy(ctx, jointList, parent, world, "Animation");
  const bind = joints.map((j) => (isSingular(world(j)) ? [...IDENTITY] : world(j)));
  const users = joints.filter((j) => json.nodes[j].mesh !== undefined);
  const name = uniqueName("Animated", ctx.skinNames);
  return { index: -1, name, joints, tokens, remap: null, bind, prefix, users, rigid: true, roots: new Set(roots) };
}

/** Rigid binding of a mesh to joint `k`: every point on joint k with weight 1, geomBind = rest world. */
export function rigidPrimvars(plan, k, vertexCount) {
  // Written per point (interpolation "vertex"), as in the layout Quick Look played.
  return { indices: new Array(vertexCount).fill(k), weights: new Array(vertexCount).fill(1), elementSize: 1, geomBind: plan.bind[k] };
}

/** Joint-local (relative to parent joint) T / R / S at a time code (undefined = rest pose). */
function jointLocal(ctx, plan, k, time) {
  const node = ctx.json.nodes[plan.joints[k]];
  const ch = time === undefined ? null : ctx.animation?.nodes.get(plan.joints[k]);
  const rest = node.matrix ? decompose(node.matrix) : null;
  const t = ch?.translation ? sampleAt(ch.translation, time, "translation") : rest?.t ?? node.translation ?? [0, 0, 0];
  const r = ch?.rotation ? sampleAt(ch.rotation, time, "rotation") : rest?.r ?? node.rotation ?? [0, 0, 0, 1];
  const s = ch?.scale ? sampleAt(ch.scale, time, "scale") : rest?.s ?? node.scale ?? [1, 1, 1];
  const prefix = plan.prefix[k];
  if (isIdentity(prefix)) return { t, r, s };
  return decompose(multiply(prefix, composeTRS(t, r, s)));
}

/** A joint-less plan, for meshes that only have blend shapes. */
export const NO_JOINTS = Object.freeze({ joints: [], tokens: [], bind: [], prefix: [] });

/**
 * Add the Skeleton (and a SkelAnimation when joints or blend shape weights
 * need one) to a SkelRoot.
 * @param {import("./ir.js").Prim} skelRoot
 * @param {string} skelRootPath
 * @param {{ token: string, weightIndex: number, node: number }[]} shapes  blend shapes of the meshes in this SkelRoot
 * @param {(node: number) => number[]} restWeights
 */
export function buildSkeleton(ctx, plan, skelRoot, skelRootPath, shapes = [], restWeights = () => []) {
  ctx.hasSkeleton = true;
  const n = plan.joints.length;
  const rest = [];
  for (let k = 0; k < n; k++) {
    const { t, r, s } = jointLocal(ctx, plan, k, undefined);
    rest.push(composeTRS(t, r, s));
  }

  const jointsAnimated = plan.joints.some((j) => ctx.animation?.nodes.has(j));
  const weightNodes = [...new Set(shapes.map((sh) => sh.node))];
  const weightsAnimated = weightNodes.some((nd) => ctx.animation?.nodes.get(nd)?.weights);
  const weightsNonZero = shapes.some((sh) => restWeights(sh.node)[sh.weightIndex]);
  const needsAnim = jointsAnimated || weightsAnimated || weightsNonZero;

  const skeleton = skelRoot.child(new Prim("Skeleton", "Skeleton", {
    metadata: needsAnim ? { "prepend apiSchemas": ["SkelBindingAPI"] } : {},
  }));
  skeleton.attr("token[]", "joints", plan.tokens, { uniform: true });
  if (n) {
    skeleton.attr("matrix4d[]", "bindTransforms", plan.bind.flat(), { uniform: true });
    skeleton.attr("matrix4d[]", "restTransforms", rest.flat(), { uniform: true });
  }
  if (!needsAnim) return;
  // The SkelAnimation is a child of its Skeleton, as in Apple's samples.
  skeleton.rel("skel:animationSource", `${skelRootPath}/Skeleton/Animation`);
  const anim = skeleton.child(new Prim("SkelAnimation", "Animation"));

  if (jointsAnimated) {
    // Every joint is sampled at the union of all joint key times.
    const times = new Set();
    for (const j of plan.joints) {
      const ch = ctx.animation.nodes.get(j);
      for (const path of ["translation", "rotation", "scale"]) for (const [t] of ch?.[path] ?? []) times.add(t);
    }
    const samples = { t: [], r: [], s: [] };
    for (const time of [...times].sort((a, b) => a - b)) {
      const T = [], R = [], S = [];
      for (let k = 0; k < n; k++) {
        const { t, r, s } = jointLocal(ctx, plan, k, time);
        T.push(...t);
        R.push(r[3], r[0], r[1], r[2]); // USD quatf is (w, x, y, z)
        S.push(...s);
      }
      samples.t.push([time, T]);
      samples.r.push([time, R]);
      samples.s.push([time, S]);
    }
    anim.attr("token[]", "joints", plan.tokens, { uniform: true });
    anim.attr("float3[]", "translations", undefined, { timeSamples: samples.t });
    anim.attr("quatf[]", "rotations", undefined, { timeSamples: samples.r });
    anim.attr("half3[]", "scales", undefined, { timeSamples: samples.s });
  }

  if (shapes.length) {
    anim.attr("token[]", "blendShapes", shapes.map((sh) => sh.token), { uniform: true });
    const at = (time) => shapes.map((sh) => {
      const ch = ctx.animation?.nodes.get(sh.node)?.weights;
      return (ch ? sampleAt(ch, time, "weights") : restWeights(sh.node))[sh.weightIndex] ?? 0;
    });
    if (weightsAnimated) {
      const times = new Set();
      for (const nd of weightNodes) for (const [t] of ctx.animation.nodes.get(nd)?.weights ?? []) times.add(t);
      anim.attr("float[]", "blendShapeWeights", undefined, {
        timeSamples: [...times].sort((a, b) => a - b).map((t) => [t, at(t)]),
      });
    } else {
      anim.attr("float[]", "blendShapeWeights", at(undefined));
    }
  }
}

/**
 * Skinning primvars for one glTF primitive: jointIndices remapped to skeleton
 * order, jointWeights, elementSize = 4 per JOINTS_n / WEIGHTS_n set.
 * Returns null (with a warning) if the primitive has no JOINTS_0 / WEIGHTS_0.
 */
export function skinningPrimvars(ctx, plan, prim, vertexCount, meshName) {
  const attrs = prim.attributes || {};
  const sets = [];
  for (let n = 0; attrs[`JOINTS_${n}`] !== undefined && attrs[`WEIGHTS_${n}`] !== undefined; n++) {
    sets.push([ctx.asset.accessor(attrs[`JOINTS_${n}`]).data, ctx.asset.accessor(attrs[`WEIGHTS_${n}`]).data]);
  }
  if (!sets.length) {
    ctx.warn(`Mesh "${meshName}" uses skin ${plan.index} but has no JOINTS_0 / WEIGHTS_0; written unskinned`);
    return null;
  }
  const elementSize = sets.length * 4;
  const indices = new Array(vertexCount * elementSize);
  const weights = new Array(vertexCount * elementSize);
  const jointCount = plan.remap.length;
  const fail = (msg) => { throw new GltfValidationError(`Mesh "${meshName}" (skin ${plan.index}): ${msg}`); };
  let unweighted = 0;
  let unnormalized = 0;
  const slots = [];
  for (let v = 0; v < vertexCount; v++) {
    slots.length = 0;
    let sum = 0;
    sets.forEach(([J, W], s) => {
      for (let c = 0; c < 4; c++) {
        const w = W[v * 4 + c];
        const j = J[v * 4 + c];
        if (!Number.isFinite(w) || w < 0) fail(`WEIGHTS_${s} of vertex ${v} is ${w} (weights must be finite and >= 0)`);
        if (!Number.isInteger(j) || j < 0) fail(`JOINTS_${s} of vertex ${v} is ${j}`);
        // Zero-weight slots may hold any index; point them at joint 0.
        if (w && j >= jointCount) fail(`JOINTS_${s} of vertex ${v} is ${j}, but the skin has ${jointCount} joints`);
        sum += w;
        slots.push([w ? plan.remap[j] : 0, w]);
      }
    });
    if (sum === 0) unweighted++;
    else if (Math.abs(sum - 1) > 1e-3) unnormalized++;
    // Heaviest influence first (stable). glTF allows any order; the deformation is unchanged.
    slots.sort((a, b) => b[1] - a[1]);
    slots.forEach(([j, w], i) => {
      indices[v * elementSize + i] = j;
      weights[v * elementSize + i] = w;
    });
  }
  // glTF requires weights summing to 1; both cases are written as-is (not renormalized).
  if (unweighted) ctx.warn(`Mesh "${meshName}": ${unweighted} vertices have no joint weight (glTF requires weights summing to 1)`);
  if (unnormalized) ctx.warn(`Mesh "${meshName}": ${unnormalized} vertices have joint weights not summing to 1; written as-is`);
  return { indices, weights, elementSize };
}
