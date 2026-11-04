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

// WebP テクスチャ（EXT_texture_webp）を PNG / JPEG に変換して入れる（非同期版。ブラウザでは標準機能で変換）
const usdz3 = await glbToUsdzAsync(buf);
// Node では変換関数を渡す（例: 画像ライブラリで WebP → PNG）。渡さなければ同期版と同じく警告してテクスチャなし
await glbToUsdzAsync(buf, { convertImage: async (bytes, mimeType) => ({ bytes: await toPng(bytes), mimeType: "image/png" }) });

// 変換で捨てた情報（未対応の拡張・プリミティブ・アニメーション等）を受け取る
glbToUsdz(buf, { onWarning: (msg) => console.warn(msg) });

// 不正な入力は GltfValidationError、ZIP（非 ZIP64）に収まらない出力は UsdzLimitError
import { GltfValidationError, UsdzLimitError, DEFAULT_LIMITS } from "./src/index.js";
try {
  glbToUsdz(buf, { limits: { maxInputBytes: 200 * 2 ** 20 } }); // 上限は DEFAULT_LIMITS を上書き（Infinity で無効）
} catch (e) {
  if (e instanceof GltfValidationError) console.error("glTF として不正:", e.message);
  else throw e;
}
```

CLI: `node cli.js in.glb out.usdz`（`.usda` を指定すればテキスト出力。`in.gltf` なら同じフォルダの外部ファイルを読む）

テスト: `npm test`（テスト用 GLB の生成も含む。ネットワーク不要）

結合テスト: `npm run test:integration`。Khronos glTF-Sample-Assets の 19 モデル（コミット固定、ファイルごとに SHA-256 を照合）を
取得して `test/.cache/` に保存し、USDA / USDZ への変換、zip の読み戻し、主要な情報（メッシュ・マテリアル・テクスチャ・スケルトン・
BlendShape・アニメーション・バリアント）が残っているかを確認します。`pip install usd-core` があれば OpenUSD のバリデータも実行します。
`-- --offline` でキャッシュだけを使い、`-- Fox Box` でモデルを絞れます。

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
- POSITION / NORMAL / TEXCOORD_0（V 反転済み）/ COLOR_0（displayColor。VEC4 のアルファは BLEND / MASK のマテリアルで
  `primvars:displayOpacity`。下の設計メモ）
- 行列 accessor（MAT2 / MAT3 / MAT4）は列ごとの 4 バイト境界（パディング）を考慮して読む
- `extent`、`MaterialBindingAPI`、`doubleSided`
- マテリアル: baseColor (factor/texture)、metallicRoughness、normal、occlusion、emissive、alphaMode (BLEND/MASK)
- テクスチャの USDZ 同梱（PNG / JPEG）。同名画像は `name_1.png` のように重複回避
- EXT_texture_webp: `glbToUsdzAsync` / `glbToUsdaAsync` が WebP を PNG（透明あり）/ JPEG（不透明、品質 0.95）に変換して同梱。
  ブラウザでは `createImageBitmap` + `OffscreenCanvas` を使い、Node では `options.convertImage` を渡したときだけ変換する
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
- 入力の検証（GLB のヘッダ / チャンク、buffer / bufferView / accessor の範囲、参照、ノード階層、スキン、アニメーション）と
  リソース上限（`options.limits`）。不正な入力は `GltfValidationError`
- USDZ の ZIP 上限（4 GiB・65535 エントリ・名前 65535 バイト）とエントリ名の検査。超える場合は `UsdzLimitError`（ZIP64 は未対応）
- OpenUSD 26.x の全バリデータで error 0 を確認済み

## 未対応（既知）

- マテリアルがあるメッシュの頂点カラー RGB（glTF は baseColor に掛けるが、`displayColor` を書くだけでマテリアルには反映しない）
- 頂点アルファとベースカラーテクスチャのアルファの掛け合わせ（テクスチャのアルファを使い、警告）
- KHR_meshopt_compression（EXT_ 版のみ対応。KHR_ 版は未対応の拡張として警告）、Draco のデコード
- KHR_materials_transmission / volume / specular / sheen など、カメラ、2 本目以降のアニメーション、USDC 出力、ZIP64

## 設計メモ

- glTF と USD はどちらも Y-up・右手系・メートル単位なので座標変換は不要。UV の V だけ反転。
- glTF の column-major 行列は、USD の row-vector 規約で 4 行ずつ書くとそのまま一致する（平行移動が最終行）。
- glTF の metallicRoughness テクスチャは G=roughness, B=metallic なので `outputs:g` / `outputs:b` をそれぞれ接続し、factor は `inputs:scale` で乗算。
- 法線マップは `scale=(2,2,2,1)`, `bias=(-1,-1,-1,0)` で [0,1] → [-1,1] に展開。
- KHR_texture_transform は V 反転後の st 空間に書き直すと `UsdTransform2d` と同じ形（scale → 回転 → 平行移動）になる。
  平行移動だけ `(offset.x + sin·scale.y, 1 - offset.y - cos·scale.y)` に変換する。
- USDZ は圧縮禁止・各ファイルのデータ先頭が 64 バイト境界必須。zip の extra field でパディングしている。
  書き出す前に全エントリの位置を長さだけから計算し、32 ビット / 16 ビットのフィールドに収まらなければ書かずにエラーにする
  （壊れた zip を作らないため。ZIP64 は Quick Look などの対応が不確かなので実装していない）。
- **入力の検証**: データを読む・シーンをたどるのに使う参照とバイト範囲（buffer / bufferView / accessor / mesh / node / skin /
  animation）、頂点属性の要素数・type・componentType（KHR_mesh_quantization の整数型は宣言されているときだけ）、JOINTS_n / WEIGHTS_n の対、
  POSITION の有無、EXT_mesh_gpu_instancing の属性（型・count の一致・構造）、インデックス（型・値の範囲・TRIANGLES は 3 の倍数）、sparse の構造と昇順、accessor / sparse のアライメントと byteStride の使い方、
  JSON の型（配列・オブジェクト）は変換前にすべて検査し、不正なら `GltfValidationError`（何番の何が不正かをメッセージに入れる）。0 埋めや切り詰めで
  変換を続けることはしない。マテリアル / テクスチャ / 画像 / ライト / バリアントの不正な参照は、従来どおりその参照を無視して警告する
  （見た目のデータで、無くても形は正しく出せるため）。アニメーションのキーが壊れている（時刻が減る、NaN、個数が合わない）チャンネルは
  警告してスキップ、同じ時刻のキーは最後のものを残す（USD は 1 時刻に 1 値）。リソース上限の既定値（`DEFAULT_LIMITS`）は
  メモリとスタックを守るためだけのもので、Khronos のサンプルや一般的な AR 用モデルよりずっと大きい。
- **頂点アルファ**: glTF ではアルファ = baseColorFactor.a × テクスチャ.a × COLOR_0.a で、使われるのは alphaMode が BLEND / MASK の
  ときだけ（OPAQUE と既定マテリアルでは無視）。Quick Look / AR Quick Look は、`inputs:opacity` を `UsdPrimvarReader_float`
  （`displayOpacity` など）から取るマテリアルを完全に透明に描く（実機で確認）一方、UV の primvar で読むテクスチャは描ける。
  そこで、頂点アルファ付きで使われる BLEND / MASK マテリアル（ベースカラーテクスチャなし）は、opacity を 256 × 1 のアルファの
  ランプ画像（`textures/vertex_alpha_ramp.png`、× factor.a）から取り、メッシュには u = COLOR_0.a の UV（`primvars:vertexAlphaUV`）を書く。
  UV は頂点カラーと同じく面内で線形補間されるので、見た目は頂点アルファと同じになる。そのマテリアルを使う頂点アルファなしのメッシュにも
  u = 1 の UV を書く（primvar がないときの扱いに頼らない）。MASK は、Quick Look がしきい値を超えた部分も中途半端な不透明度で描くため、
  cutoff / factor.a の位置で 0 から 1 に切り替わる階段のランプにして、残る部分を完全に不透明にする。UsdUVTexture では Nearest を指定できず
  階段の境目に線形補間の中間値が出るので、階段は 4096 テクセルにして境目の帯を狭くし、帯の中央（しきい値 0.5）で切る。`primvars:displayOpacity`（COLOR_0.a × factor.a）も記録として書く。
  UsdPreviewSurface は 2 つのテクスチャを掛け合わせられないので、ベースカラーテクスチャがあるときはそのアルファを使い、
  頂点アルファは反映しない（警告）。頂点カラーの RGB は従来どおりマテリアルには反映しない（上の「未対応」）。
## ロードマップ

1. ~~GLB パーサ + USDA + USDZ~~ ✅
2. ~~共有メッシュの instancing~~ ✅、~~TEXCOORD_1~~ ✅、KHR_materials_* 拡張（~~emissive_strength / ior / clearcoat~~ ✅）、~~KHR_texture_transform~~ ✅
3. ~~アニメーション → `timeSamples`~~ ✅（1 本のみ。複数クリップの扱いは検討中）
4. ~~スキン → UsdSkel、モーフターゲット → BlendShape~~ ✅
5. USDC (Crate) バイナリ書き出し（`pxr/usd/usd/crateFile.cpp` を参照）
