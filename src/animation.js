// glTF animations → per-node TRS timeSamples for the USD IR.
//
// USD has a single timeline per stage and no authored interpolation mode
// (held vs. linear is a runtime setting), so:
//   - LINEAR       → the keys as-is. USD interpolates vectors linearly and
//                    quaternions with shortest-path slerp, like glTF.
//   - STEP         → each key is repeated just before the next key
//                    (STEP_EPSILON time codes), so linear interpolation holds it.
//   - CUBICSPLINE  → baked: sampled at every frame and at every key
//                    (rotations are normalized after evaluation).
// glTF times are seconds; time codes are seconds × TIME_CODES_PER_SECOND.

import { slerp } from "./math.js";

export const TIME_CODES_PER_SECOND = 24;
const STEP_EPSILON = 1e-3; // time codes
const PATH_SIZE = { translation: 3, rotation: 4, scale: 3, weights: 0 }; // weights: one per morph target

/**
 * Pick one glTF animation and evaluate it into node channels.
 *
 * @param {object} ctx      converter context (json, asset, warn)
 * @param {number|string} [which]  animation index or name (default: the first)
 * @returns {null | {
 *   name: string,
 *   startTimeCode: number,
 *   endTimeCode: number,
 *   nodes: Map<number, { translation?: [number, number[]][], rotation?: ..., scale?: ... }>
 * }}  sample values are glTF-ordered (rotation is x, y, z, w)
 */
export function evaluateAnimation(ctx, which = 0) {
  const animations = ctx.json.animations || [];
  if (!animations.length) return null;

  let index = typeof which === "string" ? animations.findIndex((a) => a.name === which) : which;
  if (!(index >= 0 && index < animations.length)) {
    ctx.warn(`Animation ${JSON.stringify(which)} not found; using animation 0`);
    index = 0;
  }
  const anim = animations[index];
  const name = anim.name ?? `animation_${index}`;
  if (animations.length > 1) {
    const others = animations.map((a, i) => (i === index ? null : a.name ?? `animation_${i}`)).filter(Boolean);
    ctx.warn(`USD has one timeline; only animation "${name}" is converted (skipped: ${others.join(", ")})`);
  }

  const nodes = new Map();
  let start = Infinity;
  let end = -Infinity;
  for (const channel of anim.channels || []) {
    const target = channel.target || {};
    if (target.node === undefined) {
      ctx.warn(`Animation "${name}": a channel without target.node was skipped`);
      continue;
    }
    if (!(target.path in PATH_SIZE)) {
      ctx.warn(`Animation "${name}": unknown target path "${target.path}"; skipped`);
      continue;
    }
    const node = ctx.json.nodes?.[target.node];
    if (!node) continue;
    if (target.path === "weights" && !(ctx.json.meshes?.[node.mesh]?.primitives || []).some((p) => p.targets?.length)) {
      ctx.warn(`Animation "${name}": weights channel on node ${target.node}, whose mesh has no morph targets; skipped`);
      continue;
    }
    if (node.matrix) {
      ctx.warn(`Animation "${name}": node ${target.node} uses a matrix, which glTF does not allow to animate; skipped`);
      continue;
    }
    const sampler = anim.samplers?.[channel.sampler];
    if (!sampler) continue;

    const samples = evaluateSampler(ctx, sampler, target.path, name);
    if (!samples.length) continue;
    start = Math.min(start, samples[0][0]);
    end = Math.max(end, samples[samples.length - 1][0]);
    if (!nodes.has(target.node)) nodes.set(target.node, {});
    nodes.get(target.node)[target.path] = samples;
  }
  if (!nodes.size) return null;
  return { name, startTimeCode: start, endTimeCode: end, nodes };
}

/**
 * glTF seconds → time code. Key times are float32, so 1/24 s comes out as 0.999999...
 * frames; values within 1e-4 of a whole frame snap to it (STEP_EPSILON is 1e-3).
 */
function toTimeCode(seconds) {
  const tc = seconds * TIME_CODES_PER_SECOND;
  const frame = Math.round(tc);
  return Math.abs(tc - frame) < 1e-4 ? frame : Math.round(tc * 1e6) / 1e6;
}

/** @returns {[number, number[]][]} [timeCode, value] pairs */
function evaluateSampler(ctx, sampler, path, animName) {
  const times = ctx.asset.accessor(sampler.input).data;
  const out = ctx.asset.accessor(sampler.output).data;
  const interpolation = sampler.interpolation ?? "LINEAR";
  // Morph weights have one value per target; derive the count from the accessors.
  const perKey = interpolation === "CUBICSPLINE" ? 3 : 1;
  const size = PATH_SIZE[path] || Math.round(out.length / (times.length * perKey)) || 1;
  const n = times.length;
  if (!n) return [];
  const tc = toTimeCode;
  const value = (i, stride = size, offset = 0) => Array.from(out.slice(i * stride + offset, i * stride + offset + size));

  if (interpolation === "LINEAR" || interpolation === "STEP") {
    const samples = [];
    for (let i = 0; i < n; i++) {
      const v = value(i);
      samples.push([tc(times[i]), v]);
      if (interpolation === "STEP" && i + 1 < n) {
        const next = tc(times[i + 1]);
        if (next - STEP_EPSILON > tc(times[i])) samples.push([next - STEP_EPSILON, v]);
      }
    }
    return samples;
  }

  if (interpolation === "CUBICSPLINE") {
    // Each key stores (in-tangent, value, out-tangent).
    const inTan = (i) => value(i, size * 3, 0);
    const val = (i) => value(i, size * 3, size);
    const outTan = (i) => value(i, size * 3, size * 2);
    const evalAt = (k, s, dt) => {
      const s2 = s * s, s3 = s2 * s;
      const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
      const v0 = val(k), m0 = outTan(k), v1 = val(k + 1), m1 = inTan(k + 1);
      const r = v0.map((_, c) => h00 * v0[c] + h10 * dt * m0[c] + h01 * v1[c] + h11 * dt * m1[c]);
      return path === "rotation" ? normalize(r) : r;
    };
    const samples = [[tc(times[0]), path === "rotation" ? normalize(val(0)) : val(0)]];
    for (let k = 0; k + 1 < n; k++) {
      const t0 = times[k], t1 = times[k + 1], dt = t1 - t0;
      // Frames strictly inside (t0, t1), then the next key itself.
      const firstFrame = Math.floor(t0 * TIME_CODES_PER_SECOND) + 1;
      for (let f = firstFrame; f / TIME_CODES_PER_SECOND < t1 - 1e-9; f++) {
        const t = f / TIME_CODES_PER_SECOND;
        if (dt > 0) samples.push([tc(t), evalAt(k, (t - t0) / dt, dt)]);
      }
      samples.push([tc(t1), path === "rotation" ? normalize(val(k + 1)) : val(k + 1)]);
    }
    return samples;
  }

  ctx.warn(`Animation "${animName}": unknown interpolation ${interpolation}; skipped`);
  return [];
}

/**
 * Value of a channel's [timeCode, value] samples at `time`: linear between
 * samples (shortest-path slerp for rotations), clamped at the ends. STEP and
 * CUBICSPLINE samples are already expanded, so this matches USD's evaluation.
 */
export function sampleAt(samples, time, path) {
  if (time <= samples[0][0]) return samples[0][1];
  const last = samples[samples.length - 1];
  if (time >= last[0]) return last[1];
  let lo = 0, hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid][0] <= time) lo = mid; else hi = mid;
  }
  const [t0, a] = samples[lo];
  const [t1, b] = samples[hi];
  const u = (time - t0) / (t1 - t0);
  if (path === "rotation") return slerp(a, b, u);
  return a.map((v, c) => v + (b[c] - v) * u);
}

function normalize(q) {
  const len = Math.hypot(...q) || 1;
  return q.map((v) => v / len);
}
