// Type check of src/index.d.ts: `npm run test:types` (tsc --noEmit, never executed).
// Imports the package by name so the "exports" / "types" entries in package.json are checked too.
import {
  glbToUsda, glbToUsdz, glbToUsdaAsync, glbToUsdzAsync, gltfToUsda,
  parseGltf, parseGLB, GltfAsset, resolveResource, gltfToStage, writeUsda, packUsdz, Layer, Prim,
  GltfValidationError, UsdzLimitError, DataUnavailableError, DEFAULT_LIMITS, browserImageConverter,
} from "gltf2usd-js";
import type {
  GltfInput, GltfJson, ConvertOptions, AsyncConvertOptions, ImageConverter, Limits, UsdaResult,
  PackagedFile, ResourceSource,
} from "gltf2usd-js";

declare const bytes: Uint8Array;
declare const buffer: ArrayBuffer;

// Inputs: bytes, JSON text, parsed JSON.
const json: GltfJson = { asset: { version: "2.0" }, meshes: [] };
const inputs: GltfInput[] = [bytes, buffer, "{}", json];

// Options.
const resources: ResourceSource[] = [
  new Map([["scene.bin", bytes]]),
  { "scene.bin": buffer },
  (uri: string) => (uri === "scene.bin" ? bytes : null),
];
const options: ConvertOptions = {
  resources: resources[0],
  onWarning: (message: string) => console.warn(message),
  animation: "Walk",
  animationMode: "xform",
  instancing: false,
  texturePrefix: "tex/",
  layerName: "scene.usda",
  limits: { maxInputBytes: 1 << 20, maxNodeDepth: Infinity },
};

// Sync conversion.
const usdz: Uint8Array = glbToUsdz(inputs[0], options);
const { usda, files }: UsdaResult = glbToUsda(json, { animation: 1 });
const s: string = usda;
const f: PackagedFile[] = files;

// Async conversion with a custom image converter (sync or async result).
const convertImage: ImageConverter = async (data, mimeType) =>
  mimeType === "image/webp" ? { bytes: data, mimeType: "image/png" } : null;
const asyncOptions: AsyncConvertOptions = { ...options, convertImage };
async function run(): Promise<void> {
  const z: Uint8Array = await glbToUsdzAsync(bytes, asyncOptions);
  const a: UsdaResult = await glbToUsdaAsync("{}", { convertImage: () => null });
  const b = await browserImageConverter(bytes, "image/webp");
  if (b) {
    const m: "image/png" | "image/jpeg" = b.mimeType;
  }
}

// Errors.
try {
  glbToUsdz(bytes);
} catch (e) {
  if (e instanceof GltfValidationError) { const m: string = e.message; }
  else if (e instanceof UsdzLimitError) { const n: "UsdzLimitError" = e.name; }
  else if (e instanceof DataUnavailableError) { const m: string = e.message; }
}

// Limits.
const limits: Readonly<Limits> = DEFAULT_LIMITS;
const depth: number = DEFAULT_LIMITS.maxNodeDepth;

// Lower-level pipeline.
const parsed = parseGltf(buffer, { limits: { maxInputBytes: 100 } });
const glb = parseGLB(buffer);
const bin: Uint8Array | null = glb.bin;
const asset = new GltfAsset(parsed, { resources: resources[1], limits: { maxNodes: 10 } });
const acc = asset.accessor(0);
const values: number[] = acc.data;
const view: Uint8Array = asset.bufferViewBytes(0);
const image = asset.imageBytes(0);
const found: Uint8Array | null = resolveResource(resources[2], "scene.bin");
const stage = gltfToStage(asset, { instancing: true });
const layer: Layer = stage.layer;
const text: string = writeUsda(layer);
const packed: Uint8Array = packUsdz([{ name: "model.usda", bytes: new TextEncoder().encode(text) }, ...stage.files]);
const viaAsset = gltfToUsda(asset, { onWarning: () => {} });

// USD IR.
const myLayer = new Layer({ defaultPrim: "Root", metersPerUnit: 1 });
const root = myLayer.add(new Prim("Xform", "Root", { metadata: { kind: "component" } }));
const mesh = root.child(new Prim("Mesh", "Mesh", { specifier: "def" }));
mesh
  .attr("point3f[]", "points", [0, 0, 0, 1, 0, 0, 0, 1, 0])
  .attr("int[]", "faceVertexCounts", [3])
  .attr("normal3f[]", "normals", [0, 0, 1], { metadata: { interpolation: "constant" } })
  .attr("float3", "xformOp:translate", undefined, { timeSamples: [[0, [0, 0, 0]], [24, [1, 0, 0]]] })
  .attr("color3f", "inputs:diffuseColor", undefined, { connect: "/Root/Materials/M/Texture.outputs:rgb" })
  .rel("material:binding", "/Root/Materials/M");
const variantContainer: Prim = root.variant("materialVariant", "default");

// Misuse must not type-check.
// @ts-expect-error animationMode is "skeleton" | "xform"
glbToUsdz(bytes, { animationMode: "matrix" });
// @ts-expect-error unknown limit
glbToUsdz(bytes, { limits: { maxTriangles: 1 } });
// @ts-expect-error numbers are not glTF input
glbToUsdz(42);
// @ts-expect-error the sync functions do not take convertImage
glbToUsdz(bytes, { convertImage });
// @ts-expect-error convertImage must return PNG or JPEG
const badConverter: ImageConverter = () => ({ bytes, mimeType: "image/webp" });
