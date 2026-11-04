# gltf2usd.js

依存ゼロの GLB → USDA / USDZ 変換ライブラリ。ブラウザと Node の両方で動きます（ESM）。

## 使い方

```js
import { glbToUsdz, glbToUsda } from "./src/index.js";

// Node
import { readFileSync, writeFileSync } from "node:fs";
writeFileSync("out.usdz", glbToUsdz(readFileSync("in.glb")));

// ブラウザ
const buf = await file.arrayBuffer();           // <input type="file"> など
const usdz = glbToUsdz(buf);                     // Uint8Array
const url = URL.createObjectURL(new Blob([usdz], { type: "model/vnd.usdz+zip" }));

// USDA テキストだけ欲しい場合
const { usda, files } = glbToUsda(buf);          // files = テクスチャ等 {name, bytes}[]

// .gltf + 外部ファイル（.bin / 画像）。resources は Map / オブジェクト / (uri) => bytes のどれでもよい
const usdz2 = glbToUsdz(gltfText, { resources: { "scene.bin": binBytes, "textures/base.png": pngBytes } });

// 変換で捨てた情報（未対応の拡張・プリミティブ・アニメーション等）を受け取る
glbToUsdz(buf, { onWarning: (msg) => console.warn(msg) });
```

CLI: `node cli.js in.glb out.usdz`（`.usda` を指定すればテキスト出力。`in.gltf` なら同じフォルダの外部ファイルを読む）

テスト: `npm test`（テスト用 GLB の生成も含む）

## Web デモ（テストアプリ）

```bash
npm run demo        # http://localhost:8080/demo/ を開く
```

GLB を選ぶかドロップすると（またはサンプルボタンで）、ブラウザ内で USDZ に変換し、次を表示します。

- 元の glTF（three.js GLTFLoader）と変換結果の USD を並べた 3D 表示（カメラは連動）
- 出力の構造チェック: zip が無圧縮・64 バイト境界・CRC 一致、defaultPrim / upAxis、Mesh のトポロジと primvar の要素数、
  `material:binding` と `MaterialBindingAPI`、シェーダ接続とテクスチャ参照、`inputs:varname` の型
- USDA 本文、Prim ツリー、USDZ のエントリ一覧、入力 glTF の概要（未対応の拡張・アニメーションの有無）
- USDZ / USDA のダウンロード、iPhone / iPad では AR Quick Look

右側の USD 表示は `demo/usda-parser.js` で USDA を読み直し、`demo/usd-preview.js` で three.js に組み立てる簡易プレビューです。
`src/usda.js` とは独立に書いてあるので、出力を実際に読み戻した結果になります（OpenUSD のレンダラではありません）。
デモだけ three.js を CDN（jsDelivr）から読み込みます。`src/` は引き続き依存ゼロです。
静的ファイルだけで動くので、リポジトリのルートをそのまま公開すれば `/demo/` で使えます。

- **Vercel**: リポジトリをインポートするだけ（Framework Preset は "Other"、ビルド不要）。`vercel.json` で `/` → `/demo/` に転送します。
- **GitHub Pages**: ルートを公開ディレクトリにして `/demo/` を開きます。

## 構成

| ファイル | 役割 |
|---|---|
| `src/glb.js`  | GLB コンテナ解析、accessor デコード（stride / normalized / sparse 対応）、画像抽出 |
| `src/usda.js` | glTF → USDA。ノード階層 (Xform)、メッシュ (Mesh)、マテリアル (UsdPreviewSurface) |
| `src/usdz.js` | USDZ パッケージャ（stored-only zip、64 バイトアライン、CRC32 自前実装） |
| `src/index.js`| 公開 API |
| `demo/`       | ブラウザ用テストアプリ（`npm run demo`） |

## 現在対応しているもの（段階 1〜4）

- GLB ヘッダ / JSON / BIN チャンク、data URI バッファ
- `.gltf` と外部 `.bin` / 画像（`options.resources`）
- ノード階層、TRS または matrix（`xformOp:transform`）
- TRIANGLES / TRIANGLE_STRIP / TRIANGLE_FAN、インデックス有無どちらも可
- POSITION / NORMAL / TEXCOORD_0（V 反転済み）/ COLOR_0（displayColor）
- `extent`、`MaterialBindingAPI`、`doubleSided`
- マテリアル: baseColor (factor/texture)、metallicRoughness、normal、occlusion、emissive、alphaMode (BLEND/MASK)
- テクスチャの USDZ 同梱（PNG / JPEG）。同名画像は `name_1.png` のように重複回避
- sampler の wrapS / wrapT（REPEAT / CLAMP_TO_EDGE / MIRRORED_REPEAT → `repeat` / `clamp` / `mirror`）
- TEXCOORD_1 以降（`primvars:st1` …）、テクスチャごとの `texCoord`
- KHR_texture_transform（`UsdTransform2d`）
- KHR_materials_emissive_strength / ior / clearcoat（transmission などは未対応で警告）
- KHR_mesh_quantization、KHR_materials_unlit（黒 diffuse + 発光で近似）
- EXT_mesh_gpu_instancing（インスタンスごとの instanceable reference に展開）
- KHR_materials_variants → variantSet（`default` + 各バリアント）
- KHR_lights_punctual → UsdLux（DistantLight / SphereLight / ShapingAPI。強さは近似）
- EXT_meshopt_compression（依存ゼロの自前デコーダ）
- Draco（KHR_draco_mesh_compression）は非圧縮 fallback があれば使用、なければスキップして警告
- アニメーション（1 本）: 既定ではノードのアニメーションもスケルトン（UsdSkel）に変換（AR Quick Look などは xformOp の
  アニメーションを再生しないため）。`{ animationMode: "xform" }` で TRS を `xformOp:translate` / `orient` / `scale` の timeSamples に。LINEAR / STEP / CUBICSPLINE
  （STEP は保持サンプル、CUBICSPLINE は 24fps でベイク）。`{ animation: index | name }` で選択
- スキン → UsdSkel（SkelRoot / Skeleton / SkelAnimation、jointIndices / jointWeights）。スキンの入れ物は `/Root/Skins/Skin_<名前>`
  （Mac の Quick Look は入れ物の名前が `Rig` だと再生しなかったため、glTF の名前をそのまま使わない）
- モーフターゲット → BlendShape（ウェイトの固定値とアニメーション。スキンなしでも可）
- 複数ノードで共有されるメッシュの instancing（`/Root/Meshes` のプロトタイプを `instanceable` で参照。`{ instancing: false }` で複製）
- `options.onWarning` で、変換で捨てた情報を通知（CLI は標準エラーに出力）
- OpenUSD 26.x の全バリデータで error 0 を確認済み

## 設計メモ

- glTF と USD はどちらも Y-up・右手系・メートル単位なので座標変換は不要。UV の V だけ反転。
- glTF の column-major 行列は、USD の row-vector 規約で 4 行ずつ書くとそのまま一致する（平行移動が最終行）。
- glTF の metallicRoughness テクスチャは G=roughness, B=metallic なので `outputs:g` / `outputs:b` をそれぞれ接続し、factor は `inputs:scale` で乗算。
- 法線マップは `scale=(2,2,2,1)`, `bias=(-1,-1,-1,0)` で [0,1] → [-1,1] に展開。
- KHR_texture_transform は V 反転後の st 空間に書き直すと `UsdTransform2d` と同じ形（scale → 回転 → 平行移動）になる。
  平行移動だけ `(offset.x + sin·scale.y, 1 - offset.y - cos·scale.y)` に変換する。
- USDZ は圧縮禁止・各ファイルのデータ先頭が 64 バイト境界必須。zip の extra field でパディングしている。

## ロードマップ

1. ~~GLB パーサ + USDA + USDZ~~ ✅
2. ~~共有メッシュの instancing~~ ✅、~~TEXCOORD_1~~ ✅、KHR_materials_* 拡張（~~emissive_strength / ior / clearcoat~~ ✅）、~~KHR_texture_transform~~ ✅
3. ~~アニメーション → `timeSamples`~~ ✅（1 本のみ。複数クリップの扱いは検討中）
4. ~~スキン → UsdSkel、モーフターゲット → BlendShape~~ ✅
5. USDC (Crate) バイナリ書き出し（`pxr/usd/usd/crateFile.cpp` を参照）
