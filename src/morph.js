// glTF morph targets → UsdSkel BlendShape prims.
//
// Each glTF primitive target becomes a BlendShape child of the Mesh prim
// (offsets = POSITION deltas, normalOffsets = NORMAL deltas). Sparse targets
// (fewer than half the points move) also get pointIndices. Blend shapes are
// driven by a SkelAnimation's blendShapeWeights, so the mesh needs a Skeleton
// binding even without joints (UsdSkel accepts a joint-less Skeleton; verified
// with OpenUSD). The mesh lists its shapes in skel:blendShapes; those tokens are
// `<meshPrim>_<target>` so that several meshes can share one SkelAnimation.

import { Prim } from "./ir.js";
import { sanitize, uniqueName } from "./names.js";

/** Whether a glTF mesh has morph targets on any primitive. */
export function meshHasTargets(mesh) {
  return (mesh?.primitives || []).some((p) => p.targets?.length);
}

/** Target names: mesh.extras.targetNames (common exporter convention) or target_<i>. */
function targetNames(mesh, count) {
  const names = mesh.extras?.targetNames;
  const used = new Set();
  return Array.from({ length: count }, (_, i) => uniqueName(sanitize(Array.isArray(names) ? names[i] : undefined, `target_${i}`), used));
}

/**
 * Add BlendShape children and skel:blendShapes / skel:blendShapeTargets to a Mesh prim.
 * @param {Prim} meshPrim
 * @param {string} meshPath   path of meshPrim
 * @param {object} gltfMesh   the glTF mesh (for target names)
 * @param {object} prim       the glTF primitive
 * @param {number} vertexCount
 * @returns {{ token: string, weightIndex: number }[]}  shapes to drive from the animation
 */
export function addBlendShapes(ctx, meshPrim, meshPath, gltfMesh, prim, vertexCount) {
  const targets = prim.targets || [];
  if (!targets.length) return [];
  const names = targetNames(gltfMesh, targets.length);
  const shapes = [];
  const paths = [];
  targets.forEach((target, i) => {
    const pos = target.POSITION !== undefined ? ctx.asset.accessor(target.POSITION).data : null;
    const nrm = target.NORMAL !== undefined ? ctx.asset.accessor(target.NORMAL).data : null;
    if (target.TANGENT !== undefined) ctx.warn(`Mesh "${meshPrim.name}": morph target TANGENT deltas have no BlendShape equivalent; ignored`);

    const moves = (v) => [pos, nrm].some((d) => d && (d[v * 3] || d[v * 3 + 1] || d[v * 3 + 2]));
    const moving = [];
    for (let v = 0; v < vertexCount; v++) if (moves(v)) moving.push(v);
    const sparse = moving.length < vertexCount / 2;
    const pick = (d) => {
      const out = [];
      for (const v of sparse ? moving : Array.from({ length: vertexCount }, (_, k) => k)) {
        out.push(d ? d[v * 3] : 0, d ? d[v * 3 + 1] : 0, d ? d[v * 3 + 2] : 0);
      }
      return out;
    };

    const shape = meshPrim.child(new Prim("BlendShape", names[i]));
    shape.attr("vector3f[]", "offsets", pick(pos), { uniform: true });
    if (nrm) shape.attr("vector3f[]", "normalOffsets", pick(nrm), { uniform: true });
    if (sparse) shape.attr("int[]", "pointIndices", moving, { uniform: true });
    shapes.push({ token: `${meshPrim.name}_${names[i]}`, weightIndex: i });
    paths.push(`${meshPath}/${names[i]}`);
  });
  meshPrim.attr("token[]", "skel:blendShapes", shapes.map((s) => s.token), { uniform: true });
  meshPrim.rel("skel:blendShapeTargets", paths);
  return shapes;
}

/** A node's morph weights at rest: node.weights, else mesh.weights, else zeros. */
export function restWeights(ctx, nodeIndex) {
  const node = ctx.json.nodes[nodeIndex];
  const mesh = ctx.json.meshes?.[node.mesh];
  const count = Math.max(0, ...(mesh?.primitives || []).map((p) => p.targets?.length ?? 0));
  const w = node.weights ?? mesh?.weights ?? [];
  return Array.from({ length: count }, (_, i) => w[i] ?? 0);
}
