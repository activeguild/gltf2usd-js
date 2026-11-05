# gltf2usd-js

**English** | [日本語](README.ja.md)

Convert glTF 2.0 (`.glb` / `.gltf`) to USDZ or USDA, in the browser or in Node.js, with **zero dependencies**.

- One ES module that runs the same everywhere: it only uses `ArrayBuffer`, `DataView` and `TextEncoder`.
- The output is aimed at **Apple AR Quick Look**: iOS AR Quick Look and macOS Finder Quick Look were checked on device, including skeletal animation, node animation and vertex alpha.
- Each output is checked with the OpenUSD 26.11 validators (0 errors). Before converting, the input is validated against the glTF 2.0 specification, and invalid files fail with a clear error.

```js
import { glbToUsdz } from "gltf2usd-js";

const usdz = glbToUsdz(glbBytes); // Uint8Array, ready to save or to open in AR Quick Look
```

## Contents

- [Install](#install)
- [Usage](#usage) — [Node.js](#nodejs), [Browser](#browser), [CLI](#cli)
- [API](#api)
- [Supported glTF features](#supported-gltf-features)
- [Limitations](#limitations)
- [Viewer notes](#viewer-notes)
- [Input validation](#input-validation)
- [Demo](#demo)
- [Development](#development)
- [License](#license)

## Install

```bash
npm install gltf2usd-js
```

Node.js 18 or later. In browsers, any modern browser that supports ES modules works.

TypeScript type definitions are included (`src/index.d.ts`); no `@types` package is needed.

## Usage

### Node.js

```js
import { readFileSync, writeFileSync } from "node:fs";
import { glbToUsdz } from "gltf2usd-js";

writeFileSync("model.usdz", glbToUsdz(readFileSync("model.glb")));
```

A `.gltf` file with external `.bin` and image files: pass the files in `resources`.

```js
import { glbToUsdz } from "gltf2usd-js";

const usdz = glbToUsdz(readFileSync("scene.gltf", "utf8"), {
  resources: {
    "scene.bin": readFileSync("scene.bin"),
    "textures/base.png": readFileSync("textures/base.png"),
  },
});
```

`resources` can be a `Map`, a plain object, or a function `(uri) => bytes`. Each uri is looked up as written, then percent-decoded, then by its bare file name.

### Browser

```js
import { glbToUsdzAsync } from "gltf2usd-js";

const file = input.files[0];                        // <input type="file">
const usdz = await glbToUsdzAsync(await file.arrayBuffer());
const url = URL.createObjectURL(new Blob([usdz], { type: "model/vnd.usdz+zip" }));

// AR Quick Look on iOS: <a rel="ar" href={url}><img ...></a>
```

The async functions also convert WebP textures (`EXT_texture_webp`) to PNG or JPEG with the browser's own image decoder, because USDZ only holds PNG and JPEG. The synchronous functions (`glbToUsdz`, `glbToUsda`) work the same everywhere, but they drop WebP textures with a warning.

### CLI

```bash
npx gltf2usd-js model.glb model.usdz
```

Write `model.usda` as the output to get USDA text instead. For `.gltf` input, the external files are read from the input's folder (and below it only). Warnings go to stderr. Once the package is installed, the command is called `glb2usd`.

## API

### Conversion functions

| Function | Returns | |
|---|---|---|
| `glbToUsdz(input, options?)` | `Uint8Array` | USDZ package |
| `glbToUsda(input, options?)` | `{ usda: string, files: { name, bytes }[] }` | USDA text plus the textures it references |
| `glbToUsdzAsync(input, options?)` | `Promise<Uint8Array>` | Like `glbToUsdz`, but converts WebP textures first |
| `glbToUsdaAsync(input, options?)` | `Promise<{ usda, files }>` | Like `glbToUsda`, but converts WebP textures first |

`input` can be any of these: GLB or `.gltf` bytes (`ArrayBuffer` / `Uint8Array`), `.gltf` JSON text, or an already parsed glTF object.

### Options

| Option | Default | |
|---|---|---|
| `resources` | — | External files of a `.gltf` (see [Usage](#nodejs)) |
| `onWarning(message)` | — | Called once for each kind of glTF data that could not be converted (unsupported extensions, primitive modes, extra animations, …) |
| `animation` | `0` | Index or name of the glTF animation to convert. A USD stage has one timeline, so only one animation is written. |
| `animationMode` | `"skeleton"` | `"skeleton"` writes node animation as a rigid UsdSkel skeleton, which AR Quick Look plays. `"xform"` writes time-sampled `xformOp`s instead, which AR Quick Look does not play. |
| `instancing` | `true` | A mesh used by several nodes is written once and referenced as an instanceable prim. `false` duplicates it. |
| `texturePrefix` | `"textures/"` | Folder of the packaged textures |
| `layerName` | `"model.usda"` | File name of the root layer inside the USDZ |
| `limits` | `DEFAULT_LIMITS` | Resource limits (see [Input validation](#input-validation)) |
| `convertImage(bytes, mimeType)` | browser decoder | Async functions only. Returns `{ bytes, mimeType: "image/png" \| "image/jpeg" }` or `null`. In Node, pass your own (e.g. built on an image library). |

### Errors

| Error | When |
|---|---|
| `GltfValidationError` | The input is not valid glTF 2.0, or it exceeds `limits`. The message names the offending part, e.g. `mesh 0 primitive 1: NORMAL (accessor 4) has 3 elements, POSITION (accessor 2) has 4`. |
| `UsdzLimitError` | The output does not fit a classic (non-ZIP64) zip: a file or the archive is 4 GiB or larger, there are more than 65535 entries, or an entry name is longer than 65535 bytes. |

```js
import { glbToUsdz, GltfValidationError } from "gltf2usd-js";

try {
  glbToUsdz(bytes, { onWarning: (m) => console.warn(m) });
} catch (e) {
  if (e instanceof GltfValidationError) console.error("Invalid glTF:", e.message);
  else throw e;
}
```

### Lower-level exports

`parseGltf`, `parseGLB`, `GltfAsset` (parsing and accessor decoding), `gltfToStage` (glTF → an in-memory USD layer), `writeUsda` (layer → text), `packUsdz` (files → USDZ), `browserImageConverter`, `DEFAULT_LIMITS`, `DataUnavailableError`.

The type definitions also export the option and result types: `ConvertOptions`, `AsyncConvertOptions`, `StageOptions`, `GltfInput`, `ResourceSource`, `ImageConverter`, `Limits`, `UsdaResult`, `PackagedFile`, and others.

```ts
import { glbToUsdz, type ConvertOptions } from "gltf2usd-js";

const options: ConvertOptions = { animationMode: "skeleton", onWarning: console.warn };
const usdz: Uint8Array = glbToUsdz(bytes, options);
```

## Supported glTF features

**Geometry**
- Node hierarchy with TRS or `matrix` transforms
- TRIANGLES, TRIANGLE_STRIP and TRIANGLE_FAN, with or without indices
- POSITION, NORMAL (flat normals when missing), TEXCOORD_n, COLOR_0
- Sparse accessors, and normalized / matrix accessors (including the column padding of MAT2 / MAT3)
- A mesh shared by several nodes becomes an instanceable reference to a single prototype

**Materials** (UsdPreviewSurface)
- Base color, metallic-roughness, normal, occlusion and emissive (factor and texture each), alphaMode BLEND / MASK, double-sided
- PNG and JPEG textures, sampler wrap modes, multiple UV sets
- Vertex alpha (`COLOR_0` VEC4) with BLEND / MASK materials. Quick Look cannot read per-vertex opacity directly, so it is written as an alpha ramp texture with a dedicated UV set.

**Animation, skinning, morph targets** (UsdSkel)
- Skins become Skeleton, SkelAnimation and joint influences (any number of JOINTS_n / WEIGHTS_n sets)
- Morph targets become BlendShapes, with their weights as fixed values or animated
- Node animation becomes a rigid skeleton (default) or xformOp time samples
- LINEAR and STEP interpolation are exact; CUBICSPLINE is baked at 24 fps

**Extensions**

| Extension | Support |
|---|---|
| `KHR_texture_transform` | ✅ `UsdTransform2d` |
| `KHR_materials_emissive_strength`, `KHR_materials_ior`, `KHR_materials_clearcoat` | ✅ |
| `KHR_materials_unlit` | ✅ approximated (black diffuse + emission) |
| `KHR_materials_variants` | ✅ a `materialVariant` variantSet |
| `KHR_lights_punctual` | ✅ UsdLux (intensities copied as-is; AR Quick Look ignores lights) |
| `KHR_mesh_quantization` | ✅ |
| `EXT_meshopt_compression` | ✅ built-in decoder |
| `KHR_draco_mesh_compression` | ✅ built-in decoder (Draco bitstream 2.2; output identical to Google's decoder) |
| `EXT_mesh_gpu_instancing` | ✅ one instanceable reference per instance (custom `_` attributes are ignored, with a warning) |
| `EXT_texture_webp` | ✅ async API only (converted to PNG / JPEG) |
| `KHR_meshopt_compression` | ❌ compressed data is skipped with a warning |

## Limitations

- **Vertex color RGB and materials:** On a mesh that has a material, the vertex color RGB is written as `displayColor` but is not multiplied into the material.
- **Vertex alpha and base color textures:** Vertex alpha is not combined with a base color texture's alpha; the texture alpha is used. UsdPreviewSurface cannot multiply two inputs.
- **Primitive modes:** POINTS and LINES primitives are skipped with a warning.
- **Animations:** Only one animation is converted, chosen with `options.animation`.
- **Not supported:** cameras, KHR_materials_transmission / volume / specular / sheen, KTX2 textures, USDC (binary) output, ZIP64.

Everything that is dropped is reported through `onWarning`.

## Viewer notes

- **Tested viewers:** iOS AR Quick Look and macOS Finder Quick Look play the output, including skins, node animation and vertex alpha. The layout follows Apple's own samples: the default prim is the `SkelRoot`, and each `SkelAnimation` sits under its `Skeleton`.
- **xformOp animation:** AR Quick Look does not play time-sampled xformOps. That is why node animation is written as a skeleton by default.
- **Reality Converter:** It accepts only packages whose root layer is USDC. USDC output is not implemented yet.

## Input validation

Before converting, the input is checked against the glTF 2.0 specification. An invalid file throws `GltfValidationError`; nothing is silently zero-filled or truncated. The checks cover:

- **GLB container:** the header, chunk layout and alignment, and that the length matches the input
- **Buffers, buffer views and accessors:** byte ranges, strides and alignment; accessor counts and types; sparse accessors
- **Meshes:** attribute types and counts, set numbering (`TEXCOORD_0`, `TEXCOORD_1`, …), JOINTS / WEIGHTS pairs, the element count required by each primitive mode, and reserved index values
- **References:** between nodes, meshes, skins and animations; the node hierarchy must not contain cycles
- **EXT_mesh_gpu_instancing attributes**

Problems in purely visual data (a missing texture, light or variant) are reported as warnings instead, and the model still converts.

`DEFAULT_LIMITS` protects memory and the stack, and can be raised or lowered with `options.limits`; `Infinity` disables a limit.

| Limit | Default |
|---|---|
| `maxInputBytes` | 2 GiB |
| `maxAccessorValues` | 2^26 values per accessor |
| `maxNodeDepth` | 1024 |
| `maxBuffers` / `maxBufferViews` / `maxAccessors` / `maxMeshes` / `maxNodes` | counts of these arrays |

## Demo

```bash
git clone https://github.com/activeguild/gltf2usd-js.git
cd gltf2usd-js
npm run demo          # http://localhost:8080/demo/
```

Drop a GLB onto the page to see the original glTF (three.js) and the converted USD side by side, together with structural checks, the USDA text and the prim tree. On iPhone and iPad, the result opens in AR Quick Look. The demo is static files only and deploys as-is, for example to Vercel or GitHub Pages. three.js is used by the demo only; the library itself has no dependencies.

## Development

```bash
npm test                        # unit tests, no network
npm run test:types              # type-checks test/types.ts against src/index.d.ts (fetches TypeScript with npx)
npm run test:integration        # 22 Khronos glTF-Sample-Assets models (downloaded once, pinned by commit and SHA-256)
pip install usd-core            # optional: lets the integration test and test/validate.py run the OpenUSD validators
python3 test/validate.py model.usdz
```

### Releasing

Push a version tag and GitHub Actions publishes that version to npm (`.github/workflows/publish.yml`):

```bash
git tag v0.2.0
git push origin v0.2.0
```

The version comes from the tag, so `package.json` does not have to be bumped first. A prerelease tag such as `v0.2.0-beta.1` is published under the npm dist-tag `next`. Nothing is published unless the unit tests, the type check, the integration test and the OpenUSD validators pass, or if that version is already on npm. The workflow needs an npm automation token in the repository secret `NPM_TOKEN`, and it publishes with provenance.

Design notes and the reasons behind the output layout are in [CLAUDE.md](CLAUDE.md) (in Japanese).

## License

[MIT](LICENSE) © activeguild

Parts of the Draco decoder (`src/draco.js`) are a translation of Google's reference decoder and are licensed under the Apache License 2.0; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The output is plain USD. "OpenUSD" and "Pixar" are used here only to name the format and its reference validator; this project is not affiliated with them.
