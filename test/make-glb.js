// Builds a tiny GLB: a textured cube plus a translated child node, for testing.
import { writeFileSync } from "node:fs";

// 1x1 red PNG
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

const P = [];
const N = [];
const UV = [];
const I = [];
const faces = [
  [[0,0,1],[1,0,0],[0,1,0]], [[0,0,-1],[-1,0,0],[0,1,0]],
  [[1,0,0],[0,0,-1],[0,1,0]], [[-1,0,0],[0,0,1],[0,1,0]],
  [[0,1,0],[1,0,0],[0,0,-1]], [[0,-1,0],[1,0,0],[0,0,1]],
];
for (const [n,u,v] of faces) {
  const base = P.length/3;
  for (const [a,b] of [[-1,-1],[1,-1],[1,1],[-1,1]]) {
    P.push(n[0]*0.5+u[0]*a*0.5+v[0]*b*0.5, n[1]*0.5+u[1]*a*0.5+v[1]*b*0.5, n[2]*0.5+u[2]*a*0.5+v[2]*b*0.5);
    N.push(...n); UV.push((a+1)/2, (b+1)/2);
  }
  I.push(base,base+1,base+2, base,base+2,base+3);
}
const posBuf = Buffer.from(new Float32Array(P).buffer);
const nrmBuf = Buffer.from(new Float32Array(N).buffer);
const uvBuf  = Buffer.from(new Float32Array(UV).buffer);
const idxBuf = Buffer.from(new Uint16Array(I).buffer);
const pad4 = (b) => Buffer.concat([b, Buffer.alloc((4 - b.length % 4) % 4)]);
const parts = [posBuf, nrmBuf, uvBuf, pad4(idxBuf), pad4(png)];
let off = 0; const views = [];
for (const p of parts) { views.push({ buffer: 0, byteOffset: off, byteLength: p.length }); off += p.length; }
const bin = Buffer.concat(parts);

const json = {
  asset: { version: "2.0", generator: "test" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [
    { name: "Cube Root", mesh: 0, children: [1] },
    { name: "child-1", mesh: 0, translation: [2, 0, 0], rotation: [0, 0.7071068, 0, 0.7071068], scale: [0.5, 0.5, 0.5] },
  ],
  meshes: [{ name: "Cube", primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: 24, type: "VEC3", min: [-0.5,-0.5,-0.5], max: [0.5,0.5,0.5] },
    { bufferView: 1, componentType: 5126, count: 24, type: "VEC3" },
    { bufferView: 2, componentType: 5126, count: 24, type: "VEC2" },
    { bufferView: 3, componentType: 5123, count: 36, type: "SCALAR" },
  ],
  bufferViews: views.slice(0, 4).concat([views[4]]),
  buffers: [{ byteLength: bin.length }],
  images: [{ bufferView: 4, mimeType: "image/png", name: "red" }],
  textures: [{ source: 0 }],
  materials: [{ name: "Red Mat", pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.8 } }],
};
let jsonBuf = Buffer.from(JSON.stringify(json));
jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - jsonBuf.length % 4) % 4, 0x20)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
writeFileSync("test/cube.glb", Buffer.concat([header, ch(jsonBuf.length, 0x4e4f534a), jsonBuf, ch(bin.length, 0x004e4942), bin]));
console.log("wrote test/cube.glb");
