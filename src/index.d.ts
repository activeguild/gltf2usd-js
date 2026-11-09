// Type declarations for gltf2usd-js (hand-written; keep in sync with src/index.js).

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A parsed glTF 2.0 JSON document. Only `asset` is required to recognise it. */
export interface GltfJson {
  asset: { version: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** GLB or .gltf bytes, .gltf JSON text, or an already parsed glTF JSON object. */
export type GltfInput = ArrayBuffer | Uint8Array | string | GltfJson;

/** Bytes of an external file referenced by a uri. */
export type ResourceBytes = ArrayBuffer | Uint8Array;

/**
 * Files referenced by non-`data:` uris (external .bin / images): a Map or object keyed by
 * uri, or a function. Lookup tries the uri as written, percent-decoded, and its bare file name.
 */
export type ResourceSource =
  | Map<string, ResourceBytes>
  | Record<string, ResourceBytes>
  | ((uri: string) => ResourceBytes | null | undefined);

// ---------------------------------------------------------------------------
// Limits and errors
// ---------------------------------------------------------------------------

export interface Limits {
  /** GLB / glTF bytes, JSON text (UTF-8 size) and each external buffer. Default 2^31. */
  maxInputBytes: number;
  /** Values decoded from one accessor (count × components). Default 2^26. */
  maxAccessorValues: number;
  maxBuffers: number;
  maxBufferViews: number;
  maxAccessors: number;
  maxMeshes: number;
  maxNodes: number;
  /** Scene graph depth. Default 1024. */
  maxNodeDepth: number;
}

/** Default resource limits (frozen). `Infinity` in `options.limits` disables one. */
export const DEFAULT_LIMITS: Readonly<Limits>;

/** The input is not valid glTF 2.0, or it exceeds `limits`. */
export class GltfValidationError extends Error {
  constructor(message: string);
  name: "GltfValidationError";
}

/** The output does not fit a classic (non-ZIP64) zip. */
export class UsdzLimitError extends Error {
  constructor(message: string);
  name: "UsdzLimitError";
}

/**
 * An accessor's bytes are not in the file in readable form (e.g. a meshopt fallback buffer, or
 * Draco data that cannot be decoded and has no uncompressed fallback). The converters skip the
 * affected data and warn instead of throwing it.
 */
export class DataUnavailableError extends Error {
  constructor(message: string);
  name: "DataUnavailableError";
}

// ---------------------------------------------------------------------------
// Options and results
// ---------------------------------------------------------------------------

/** A texture image that USDZ can hold. */
export interface UsdzImage {
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
}

/**
 * Converts an image USDZ cannot hold (e.g. WebP). Return `null` (or anything that is not a
 * PNG / JPEG `UsdzImage`) to drop the image with a warning.
 */
export type ImageConverter = (
  bytes: Uint8Array,
  mimeType: string,
) => UsdzImage | null | undefined | Promise<UsdzImage | null | undefined>;

/** Options of `gltfToStage` (and of every conversion function). */
export interface StageOptions {
  /** Called once for each kind of glTF data that could not be converted. */
  onWarning?: (message: string) => void;
  /** Index or name of the glTF animation to convert. Default `0`. */
  animation?: number | string;
  /** `"skeleton"` (default): node animation as a rigid UsdSkel skeleton. `"xform"`: time-sampled xformOps. */
  animationMode?: "skeleton" | "xform";
  /**
   * Double-sided materials. `"attribute"` (default): USD `doubleSided`, which Quick Look ignores.
   * `"faces"`: a reversed copy of each triangle, so Quick Look draws the back side too.
   */
  doubleSided?: "attribute" | "faces";
  /** Meshes used by several nodes become instanceable references. Default `true`. */
  instancing?: boolean;
  /** Folder of the packaged textures. Default `"textures/"`. */
  texturePrefix?: string;
}

/** Options of `glbToUsda` / `glbToUsdz`. */
export interface ConvertOptions extends StageOptions {
  /** External files of a .gltf. */
  resources?: ResourceSource;
  /** Resource limits; unspecified ones keep their `DEFAULT_LIMITS` value. */
  limits?: Partial<Limits>;
  /** File name of the root layer inside the USDZ. Default `"model.usda"`. */
  layerName?: string;
}

/** Options of `glbToUsdaAsync` / `glbToUsdzAsync`. */
export interface AsyncConvertOptions extends ConvertOptions {
  /** Converts WebP and other images USDZ cannot hold. Default `browserImageConverter`. */
  convertImage?: ImageConverter;
}

/** A file to package next to the root layer (a texture). */
export interface PackagedFile {
  /** Path inside the USDZ, e.g. `"textures/base.png"`. */
  name: string;
  bytes: Uint8Array;
}

export interface UsdaResult {
  /** The root layer as USDA text. */
  usda: string;
  /** Textures the layer references, by the relative paths it uses. */
  files: PackagedFile[];
}

export interface StageResult {
  layer: Layer;
  files: PackagedFile[];
}

// ---------------------------------------------------------------------------
// Conversion functions
// ---------------------------------------------------------------------------

/** glTF → USDA text plus the textures it references. Accepts GLB and .gltf. */
export function toUsda(input: GltfInput, options?: ConvertOptions): UsdaResult;

/** glTF → USDZ bytes. Accepts GLB and .gltf. */
export function toUsdz(input: GltfInput, options?: ConvertOptions): Uint8Array;

/** Like `toUsda`, but first converts images USDZ cannot hold (e.g. WebP) with `convertImage`. */
export function toUsdaAsync(input: GltfInput, options?: AsyncConvertOptions): Promise<UsdaResult>;

/** Like `toUsdz`, but first converts images USDZ cannot hold (e.g. WebP) with `convertImage`. */
export function toUsdzAsync(input: GltfInput, options?: AsyncConvertOptions): Promise<Uint8Array>;

// The original names (same functions as above, still supported). Despite "glb", they accept .gltf too.

/** Same as `toUsda`. */
export function glbToUsda(input: GltfInput, options?: ConvertOptions): UsdaResult;

/** Same as `toUsdz`. */
export function glbToUsdz(input: GltfInput, options?: ConvertOptions): Uint8Array;

/** Same as `toUsdaAsync`. */
export function glbToUsdaAsync(input: GltfInput, options?: AsyncConvertOptions): Promise<UsdaResult>;

/** Same as `toUsdzAsync`. */
export function glbToUsdzAsync(input: GltfInput, options?: AsyncConvertOptions): Promise<Uint8Array>;

/** A `GltfAsset` → USDA text plus textures (`gltfToStage` followed by `writeUsda`). */
export function gltfToUsda(asset: GltfAsset, options?: StageOptions): UsdaResult;

// ---------------------------------------------------------------------------
// Lower-level API
// ---------------------------------------------------------------------------

/** Result of `parseGltf` / `parseGLB`: the JSON and the GLB BIN chunk (null for .gltf). */
export interface ParsedGltf {
  json: GltfJson;
  bin: Uint8Array | null;
}

/** Parse GLB or .gltf JSON bytes. Throws `GltfValidationError`. */
export function parseGltf(arrayBuffer: ArrayBuffer, options?: { limits?: Partial<Limits> }): ParsedGltf;

/** Parse GLB bytes, checking the header and chunk layout. Throws `GltfValidationError`. */
export function parseGLB(arrayBuffer: ArrayBuffer, options?: { limits?: Partial<Limits> }): ParsedGltf;

/** A decoded accessor: `count × numComponents` values, normalized if the accessor asks for it. */
export interface AccessorData {
  data: number[];
  count: number;
  numComponents: number;
}

/** Validated glTF document with typed access to buffers, accessors and images. */
export class GltfAsset {
  /** Validates the document; throws `GltfValidationError` if it is not valid glTF 2.0. */
  constructor(parsed: ParsedGltf, options?: { resources?: ResourceSource; limits?: Partial<Limits> });
  readonly json: GltfJson;
  readonly bin: Uint8Array | null;
  readonly limits: Readonly<Limits>;
  /** Raw bytes of a bufferView (decompressed if it uses EXT_ / KHR_meshopt_compression). */
  bufferViewBytes(index: number): Uint8Array;
  /** Decode an accessor. Throws `DataUnavailableError` if its bytes are not readable. */
  accessor(index: number): AccessorData;
  /** An image's bytes and MIME type, or null if it cannot be resolved. */
  imageBytes(index: number): { bytes: Uint8Array; mimeType: string | undefined } | null;
}

/** Look up an external uri in a `ResourceSource` (as written, percent-decoded, bare file name). */
export function resolveResource(resources: ResourceSource | null | undefined, uri: string): Uint8Array | null;

/** glTF → an in-memory USD layer and the files it references. */
export function gltfToStage(asset: GltfAsset, options?: StageOptions): StageResult;

/** USD layer → USDA text. */
export function writeUsda(layer: Layer): string;

/**
 * Files → USDZ bytes (stored, 64-byte aligned). The first entry must be the root layer
 * (.usda / .usdc / .usd). Throws `UsdzLimitError` when a classic zip cannot hold them.
 */
export function packUsdz(entries: PackagedFile[]): Uint8Array;

/**
 * Default `convertImage`: decodes with `createImageBitmap` and re-encodes with
 * `OffscreenCanvas` (PNG if any pixel is transparent, otherwise JPEG). Resolves to null
 * where those APIs are missing (Node) or cannot decode the format.
 */
export function browserImageConverter(bytes: Uint8Array, mimeType: string): Promise<UsdzImage | null>;

// ---------------------------------------------------------------------------
// USD IR (src/ir.js)
// ---------------------------------------------------------------------------

/**
 * Prim / property metadata value: string → quoted, number, boolean,
 * string[] → token list, `{ path }` → `<path>`. A prim's `variants` metadata is
 * `{ <variantSet>: <selected variant> }`.
 */
export type MetadataValue = string | number | boolean | string[] | { path: string } | Record<string, string>;

/**
 * Attribute value by typeName: scalars are numbers / strings, tuples (float3, quatf (w, x, y, z), …)
 * and arrays are flat number arrays (tuples flattened), matrix4d is 16 numbers row-major.
 */
export type AttributeValue = number | string | boolean | ArrayLike<number> | string[];

export interface Attribute {
  kind: "attr";
  typeName: string;
  name: string;
  value: AttributeValue | undefined;
  uniform: boolean;
  connect: string | undefined;
  timeSamples: [number, AttributeValue][] | undefined;
  metadata: Record<string, MetadataValue>;
}

export interface Relationship {
  kind: "rel";
  name: string;
  targets: string[];
}

export interface AttributeOptions {
  uniform?: boolean;
  /** Connection source path (`/Prim/Path.outputs:rgb`). */
  connect?: string;
  /** `[timeCode, value]` pairs. */
  timeSamples?: [number, AttributeValue][];
  /** e.g. `{ interpolation: "vertex" }`. */
  metadata?: Record<string, MetadataValue>;
}

/** A USD layer: ordered layer metadata and root prims. */
export class Layer {
  constructor(metadata?: Record<string, MetadataValue>);
  /** Ordered layer metadata, e.g. `{ defaultPrim: "Root", metersPerUnit: 1 }`. */
  metadata: Record<string, MetadataValue>;
  prims: Prim[];
  add(prim: Prim): Prim;
}

/** A USD prim with attributes, relationships, children and variant sets. */
export class Prim {
  /**
   * @param type schema type name ("Xform", "Mesh", …) or "" for typeless
   * @param name valid USD identifier
   */
  constructor(
    type: string,
    name: string,
    options?: {
      specifier?: "def" | "over" | "class";
      /** Ordered prim metadata ("prepend apiSchemas", "instanceable", …). */
      metadata?: Record<string, MetadataValue>;
      /** Text writer: blank line between children (cosmetic only). */
      spaced?: boolean;
    },
  );
  specifier: "def" | "over" | "class";
  type: string;
  name: string;
  metadata: Record<string, MetadataValue>;
  spaced: boolean;
  props: (Attribute | Relationship)[];
  children: Prim[];
  /** variantSet → variant → opinion container. */
  variantSets: Map<string, Map<string, Prim>>;
  /** Opinion container for one variant (created on first use). */
  variant(setName: string, variantName: string): Prim;
  /** Add an attribute; `value` undefined declares it only. Returns this prim. */
  attr(typeName: string, name: string, value?: AttributeValue, options?: AttributeOptions): this;
  /** Add a relationship with zero or more target paths. Returns this prim. */
  rel(name: string, targets?: string | string[]): this;
  /** Append a child prim and return it. */
  child<P extends Prim>(prim: P): P;
}
